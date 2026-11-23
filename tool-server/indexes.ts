/**
 * indexes.ts — the indexes the tool server searches, loaded once at startup.
 *
 * The tool server loads all three index files (one per chunking
 * strategy) into memory when it starts, and keeps each one's SQLite file
 * open, read-only, for keyword search. search_docs takes a `strategy`
 * argument and searches the matching one. Loading all three costs about
 * 1.5 MB and lets the scorecard compare strategies, and the UI switch
 * between them, without restarting anything.
 *
 * Two things are checked at load, and reported rather than hidden:
 *
 *   - A missing index file makes that strategy unavailable. A search
 *     with it is an error that names the fix (npm run index); the other
 *     strategies still work.
 *   - A stale index (built from a different corpus than the one on disk)
 *     still loads, because a reader may want to see what it returns, but
 *     every search result from it says `indexStale: true`, and the server
 *     says so on stderr at startup.
 */

import { DatabaseSync } from "node:sqlite";

import type { ChunkStrategy } from "../shared/types.js";
import { corpusHash, loadCorpus } from "./corpus.js";
import { indexPath, readIndex, type LoadedIndex } from "./db.js";

/** One loaded index, ready to search. */
export interface IndexEntry extends LoadedIndex {
  /** The index file, open read-only, for FTS5 keyword search. */
  db: DatabaseSync;
  /** Built from a different corpus than the one on disk now. */
  stale: boolean;
}

export const STRATEGIES: readonly ChunkStrategy[] = ["fixed", "heading", "heading+context"];

/** A search asked for a strategy whose index isn't there. */
export class IndexMissingError extends Error {
  override name = "IndexMissingError";
}

const loaded = new Map<ChunkStrategy, IndexEntry>();

/**
 * Opens one index file for searching: loaded into memory, with the file
 * kept open read-only for keyword search. `currentHash` is the corpus as
 * it is now, to decide staleness. Used here at startup and by the
 * scorecard, which opens indexes it built into a temporary folder.
 */
export function openIndex(path: string, currentHash: string): IndexEntry {
  const index = readIndex(path);
  return { ...index, db: new DatabaseSync(path, { readOnly: true }), stale: index.settings.corpusHash !== currentHash };
}

/**
 * Loads every index file that exists. Returns one line per strategy for
 * the startup message, so a missing or stale index is said out loud.
 */
export function loadIndexes(): string[] {
  const hash = corpusHash(loadCorpus());
  const report: string[] = [];
  for (const strategy of STRATEGIES) {
    loaded.get(strategy)?.db.close();
    loaded.delete(strategy);
    const path = indexPath(strategy);
    try {
      const entry = openIndex(path, hash);
      loaded.set(strategy, entry);
      report.push(`${strategy}: ${entry.chunks.length} chunks${entry.stale ? " — STALE, built from a different corpus; run npm run index" : ""}`);
    } catch (error: unknown) {
      // A missing file is "not built yet"; anything else is worth the details.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /unable to open/i.test(String((error as Error).message));
      report.push(`${strategy}: ${missing ? "no index file; run npm run index" : `could not load: ${(error as Error).message}`}`);
    }
  }
  return report;
}

/** The loaded index for a strategy, or an error naming the fix. */
export function getIndex(strategy: ChunkStrategy): IndexEntry {
  const entry = loaded.get(strategy);
  if (!entry) throw new IndexMissingError(`There is no ${strategy} index loaded. Build it with:  npm run index -- --strategy ${strategy}`);
  return entry;
}

/** Every loaded index, for list_documents. */
export function loadedIndexes(): IndexEntry[] {
  return STRATEGIES.flatMap((s) => loaded.get(s) ?? []);
}
