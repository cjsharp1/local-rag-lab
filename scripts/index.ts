/**
 * index.ts — builds the search indexes: chunk, embed, project, store.
 *
 * Run it with:  npm run index                          all three strategies
 *               npm run index -- --strategy fixed      just one
 *               npm run index -- --preset small        a different size preset
 *
 * This is the "ingestion" half of RAG, the half that happens before
 * anyone asks a question. For each chunking strategy it:
 *
 *   1. reads the corpus (tool-server/corpus.ts) and fingerprints it;
 *   2. cuts every document into chunks (shared/chunk.ts);
 *   3. embeds every chunk with the embeddings model, in batches
 *      (tool-server/embed.ts), with nomic's "search_document: " prefix;
 *   4. fits the 2D map to the chunk vectors (tool-server/pca.ts);
 *   5. writes it all, plus an FTS5 keyword index, to
 *      data/index-<strategy>.db (tool-server/db.ts).
 *
 * It prints what it built and how long each stage took, so the cost of
 * ingestion is a number you've seen rather than an assumption. Embedding
 * is nearly all of it.
 *
 * Every index records the preset it was built with. Changing a preset
 * means rebuilding that strategy's file; nothing about chunking can be
 * changed per question, because the vectors belong to the chunks.
 */

import "dotenv/config";

import { chunkDocument, PRESETS } from "../shared/chunk.js";
import type { ChunkPreset, ChunkStrategy, IndexSettings } from "../shared/types.js";
import { corpusHash, loadCorpus } from "../tool-server/corpus.js";
import { indexPath, writeIndex, type IndexedChunk } from "../tool-server/db.js";
import { embed, EmbedError } from "../tool-server/embed.js";
import { fitPca, project } from "../tool-server/pca.js";

const STRATEGIES: readonly ChunkStrategy[] = ["fixed", "heading", "heading+context"];

/** The value after a flag, checked against the allowed values. */
function option<T extends string>(flag: string, allowed: readonly T[]): T | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!allowed.includes(value as T)) {
    console.error(`${flag} must be one of: ${allowed.join(", ")}`);
    process.exit(1);
  }
  return value as T;
}

const strategies = [option("--strategy", STRATEGIES) ?? STRATEGIES].flat();
const preset: ChunkPreset = option("--preset", Object.keys(PRESETS) as ChunkPreset[]) ?? "default";
const size = PRESETS[preset];

const docs = loadCorpus();
const hash = corpusHash(docs);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

console.log(`\nIndexing ${docs.length} documents (corpus ${hash.slice(0, 12)}…), ` +
  `preset "${preset}" (${size.chunkTokens} tokens, ${size.overlapTokens} overlap, estimated).\n`);

const started = performance.now();
for (const strategy of strategies) {
  const t0 = performance.now();
  const chunks = docs.flatMap((doc) => chunkDocument(doc, strategy, size));
  const chunkMs = performance.now() - t0;

  let embedded;
  try {
    embedded = await embed(chunks.map((c) => c.embedText), "document", (done, total) => {
      process.stdout.write(`\r  ${strategy.padEnd(16)} embedding ${done}/${total}`);
    });
  } catch (error: unknown) {
    if (error instanceof EmbedError) {
      console.error(`\n\n${error.message}\nNo index was changed.\n`);
      process.exit(1);
    }
    throw error;
  }

  const t1 = performance.now();
  const projection = fitPca(embedded.vectors);
  const indexed: IndexedChunk[] = chunks.map((c, i) => ({ ...c, vector: embedded.vectors[i]!, map: project(projection, embedded.vectors[i]!) }));
  const mapMs = performance.now() - t1;

  const settings: IndexSettings = {
    strategy,
    preset,
    chunkTokens: size.chunkTokens,
    overlapTokens: size.overlapTokens,
    embedModel: embedded.model,
    dimensions: embedded.vectors[0]!.length,
    corpusHash: hash,
    builtAt: Date.now(),
    chunkCount: indexed.length,
    mapVariance: projection.variance,
  };

  const t2 = performance.now();
  const path = indexPath(strategy);
  writeIndex(path, { settings, projection, documents: docs.map(({ id, path, title, text }) => ({ id, path, title, text })), chunks: indexed });
  const writeMs = performance.now() - t2;

  const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
  process.stdout.write(`\r  ${strategy.padEnd(16)} ${String(indexed.length).padStart(4)} chunks → ${path.replace(/\\/g, "/").split("/").slice(-2).join("/")}\n`);
  console.log(`  ${"".padEnd(16)} chunk ${seconds(chunkMs)} · embed ${seconds(embedded.totalMs)} ` +
    `(${(embedded.totalMs / indexed.length).toFixed(0)} ms/chunk, ${embedded.promptTokens.toLocaleString("en-US")} model tokens, load ${seconds(embedded.loadMs)}) · ` +
    `map ${seconds(mapMs)} · write ${seconds(writeMs)}`);
  console.log(`  ${"".padEnd(16)} ${settings.embedModel}, ${settings.dimensions} dimensions; ` +
    `the map's two axes keep ${percent(projection.variance[0])} + ${percent(projection.variance[1])} of the variance\n`);
}

console.log(`Done in ${seconds(performance.now() - started)}.\n`);
