/**
 * build.ts — builds one index in memory: chunk, embed, project.
 *
 * This is the ingestion half of RAG, the part that happens before anyone
 * asks a question. Two programs need it: `npm run index`, which writes the
 * three index files the tool server loads, and the retrieval scorecard,
 * which builds all nine strategy × preset combinations to compare them.
 * Both call buildIndex() from here, so the scorecard measures exactly the
 * indexes the lab searches, not a lookalike.
 *
 * The steps, in order:
 *
 *   1. cut every document into chunks (shared/chunk.ts);
 *   2. embed every chunk's embed text with nomic's "search_document: "
 *      prefix (embed.ts); this is nearly all the time a build takes;
 *   3. fit the 2D map to the vectors and place each chunk on it (pca.ts).
 *
 * Writing the result to disk is db.ts's job, and a separate step, so the
 * scorecard can build into a temporary folder.
 */

import { chunkDocument, PRESETS } from "../shared/chunk.js";
import type { ChunkPreset, ChunkStrategy, IndexSettings } from "../shared/types.js";
import type { CorpusDoc } from "./corpus.js";
import type { IndexedChunk, LoadedIndex } from "./db.js";
import { embed } from "./embed.js";
import { fitPca, project } from "./pca.js";

/** How long each stage took, for the index script's report. */
export interface BuildTimings {
  chunkMs: number;
  embedMs: number;
  embedLoadMs: number;
  mapMs: number;
  /** Tokens the embeddings model counted, prefixes included. */
  modelTokens: number;
}

/** Builds one index from the corpus. Throws EmbedError if Ollama can't embed. */
export async function buildIndex(
  docs: readonly CorpusDoc[],
  corpusHash: string,
  strategy: ChunkStrategy,
  preset: ChunkPreset,
  onBatch?: (done: number, total: number) => void,
): Promise<{ index: LoadedIndex; timings: BuildTimings }> {
  const size = PRESETS[preset];

  const t0 = performance.now();
  const chunks = docs.flatMap((doc) => chunkDocument(doc, strategy, size));
  const chunkMs = performance.now() - t0;

  const embedded = await embed(chunks.map((c) => c.embedText), "document", onBatch);

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
    corpusHash,
    builtAt: Date.now(),
    chunkCount: indexed.length,
    mapVariance: projection.variance,
  };

  return {
    index: { settings, projection, documents: docs.map(({ id, path, title, text }) => ({ id, path, title, text })), chunks: indexed },
    timings: { chunkMs, embedMs: embedded.totalMs, embedLoadMs: embedded.loadMs, mapMs, modelTokens: embedded.promptTokens },
  };
}
