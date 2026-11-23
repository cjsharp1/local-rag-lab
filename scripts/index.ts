/**
 * index.ts — builds the search indexes: chunk, embed, project, store.
 *
 * Run it with:  npm run index                          all three strategies
 *               npm run index -- --strategy fixed      just one
 *               npm run index -- --preset small        a different size preset
 *
 * This is the "ingestion" half of RAG, the half that happens before
 * anyone asks a question. For each chunking strategy it reads the corpus
 * and fingerprints it, then builds the index (tool-server/build.ts: cut
 * into chunks, embed every chunk, fit the 2D map) and writes it, with an
 * FTS5 keyword index, to data/index-<strategy>.db (tool-server/db.ts).
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

import { PRESETS } from "../shared/chunk.js";
import { DEFAULT_PRESET } from "../shared/search-settings.js";
import type { ChunkPreset, ChunkStrategy } from "../shared/types.js";
import { buildIndex } from "../tool-server/build.js";
import { corpusHash, loadCorpus } from "../tool-server/corpus.js";
import { indexPath, writeIndex } from "../tool-server/db.js";
import { EmbedError } from "../tool-server/embed.js";

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
const preset: ChunkPreset = option("--preset", Object.keys(PRESETS) as ChunkPreset[]) ?? DEFAULT_PRESET;
const size = PRESETS[preset];

const docs = loadCorpus();
const hash = corpusHash(docs);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

console.log(`\nIndexing ${docs.length} documents (corpus ${hash.slice(0, 12)}…), ` +
  `preset "${preset}" (${size.chunkTokens} tokens, ${size.overlapTokens} overlap, estimated).\n`);

const started = performance.now();
for (const strategy of strategies) {
  let built;
  try {
    built = await buildIndex(docs, hash, strategy, preset, (done, total) => {
      process.stdout.write(`\r  ${strategy.padEnd(16)} embedding ${done}/${total}`);
    });
  } catch (error: unknown) {
    if (error instanceof EmbedError) {
      console.error(`\n\n${error.message}\nNo index was changed.\n`);
      process.exit(1);
    }
    throw error;
  }
  const { index, timings } = built;

  const t = performance.now();
  const path = indexPath(strategy);
  writeIndex(path, index);
  const writeMs = performance.now() - t;

  const n = index.chunks.length;
  process.stdout.write(`\r  ${strategy.padEnd(16)} ${String(n).padStart(4)} chunks → ${path.replace(/\\/g, "/").split("/").slice(-2).join("/")}\n`);
  console.log(`  ${"".padEnd(16)} chunk ${seconds(timings.chunkMs)} · embed ${seconds(timings.embedMs)} ` +
    `(${(timings.embedMs / n).toFixed(0)} ms/chunk, ${timings.modelTokens.toLocaleString("en-US")} model tokens, load ${seconds(timings.embedLoadMs)}) · ` +
    `map ${seconds(timings.mapMs)} · write ${seconds(writeMs)}`);
  console.log(`  ${"".padEnd(16)} ${index.settings.embedModel}, ${index.settings.dimensions} dimensions; ` +
    `the map's two axes keep ${percent(index.projection.variance[0])} + ${percent(index.projection.variance[1])} of the variance\n`);
}

console.log(`Done in ${seconds(performance.now() - started)}.\n`);
