/**
 * db.ts — writes and reads the index files, data/index-<strategy>.db.
 *
 * An index file holds everything search needs: the settings it was built
 * with, the documents, every chunk with its vector and map position, and
 * an FTS5 keyword index (the layout, with comments, is data/schema.sql).
 * The index script writes one per chunking strategy; the tool server reads
 * one into memory at startup and searches it there.
 *
 * Why load everything into memory: 164 chunks × 768 floats is about half
 * a megabyte. Scoring every chunk against a query is a loop over arrays
 * that takes well under a millisecond. Nothing here needs a vector
 * database, and not having one means the search is code a reader can step
 * through (PLAN §2). The README says when that stops being true.
 *
 * Two details worth seeing:
 *
 *   - Vectors are stored as raw bytes (a BLOB of 32-bit floats). SQLite
 *     neither knows nor cares that they're vectors.
 *   - A build writes to a temporary file and renames it at the end. A build
 *     that fails halfway (Ollama stops, the disk fills) leaves the previous
 *     index untouched instead of a half-written one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { Chunk } from "../shared/chunk.js";
import type { ChunkStrategy, IndexSettings } from "../shared/types.js";
import type { CorpusDoc } from "./corpus.js";
import type { Projection } from "./pca.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCHEMA = join(ROOT, "data", "schema.sql");

/** Where a strategy's index lives: "heading+context" → data/index-heading-context.db. */
export function indexPath(strategy: ChunkStrategy): string {
  return join(ROOT, "data", `index-${strategy.replace("+", "-")}.db`);
}

/** A chunk as stored: the chunker's output plus its vector and map position. */
export interface IndexedChunk extends Chunk {
  vector: Float32Array;
  map: { x: number; y: number };
}

/** Everything an index file holds, loaded. */
export interface LoadedIndex {
  settings: IndexSettings;
  projection: Projection;
  documents: Array<Pick<CorpusDoc, "id" | "path" | "title" | "text">>;
  chunks: IndexedChunk[];
}

/** A Float32Array as bytes for a BLOB column. */
function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Bytes from a BLOB column as a Float32Array. Copied, because the bytes
 * SQLite hands back needn't start at a 4-byte boundary, and a
 * Float32Array view requires one.
 */
function fromBlob(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/** Writes a complete index file, replacing any previous one only on success. */
export function writeIndex(path: string, index: LoadedIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path.replace(/\.db$/, ".tmp.db");
  rmSync(temp, { force: true });

  const db = new DatabaseSync(temp);
  try {
    db.exec(readFileSync(SCHEMA, "utf8"));
    db.exec("BEGIN");

    const s = index.settings;
    db.prepare(
      `INSERT INTO index_info (id, strategy, preset, chunk_tokens, overlap_tokens, embed_model, dimensions,
         corpus_hash, built_at, map_mean, map_axis_x, map_axis_y, map_variance_x, map_variance_y)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.strategy, s.preset, s.chunkTokens, s.overlapTokens, s.embedModel, s.dimensions, s.corpusHash, s.builtAt,
      toBlob(index.projection.mean), toBlob(index.projection.axes[0]), toBlob(index.projection.axes[1]),
      index.projection.variance[0], index.projection.variance[1],
    );

    const insertDoc = db.prepare("INSERT INTO documents (id, path, title, text) VALUES (?, ?, ?, ?)");
    for (const d of index.documents) insertDoc.run(d.id, d.path, d.title, d.text);

    const insertChunk = db.prepare(
      `INSERT INTO chunks (n, id, doc_id, heading_path, text, embed_text, start_offset, end_offset,
         estimated_tokens, vector, map_x, map_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    index.chunks.forEach((c, n) =>
      insertChunk.run(n + 1, c.id, c.docId, JSON.stringify(c.headingPath), c.text, c.embedText, c.start, c.end,
        c.estimatedTokens, toBlob(c.vector), c.map.x, c.map.y),
    );

    // Build the keyword index from the chunks table in one pass.
    db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild')");
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    rmSync(temp, { force: true });
    throw error;
  }
  db.close();
  renameSync(temp, path);
}

/** One row of index_info, as SQLite returns it. */
interface InfoRow {
  strategy: string; preset: string; chunk_tokens: number; overlap_tokens: number; embed_model: string;
  dimensions: number; corpus_hash: string; built_at: number; map_mean: Uint8Array; map_axis_x: Uint8Array;
  map_axis_y: Uint8Array; map_variance_x: number; map_variance_y: number;
}

function settingsFrom(row: InfoRow, chunkCount: number): IndexSettings {
  return {
    strategy: row.strategy as IndexSettings["strategy"],
    preset: row.preset as IndexSettings["preset"],
    chunkTokens: row.chunk_tokens,
    overlapTokens: row.overlap_tokens,
    embedModel: row.embed_model,
    dimensions: row.dimensions,
    corpusHash: row.corpus_hash,
    builtAt: row.built_at,
    chunkCount,
    mapVariance: [row.map_variance_x, row.map_variance_y],
  };
}

/**
 * Just the settings of an index file, or null when there's no file.
 * Cheap: check-env and the app's startup check use it to spot a stale index.
 */
export function readIndexSettings(path: string): IndexSettings | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM index_info WHERE id = 1").get() as unknown as InfoRow | undefined;
    const count = (db.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
    return row ? settingsFrom(row, count) : null;
  } finally {
    db.close();
  }
}

/** Loads a whole index file into memory, read-only. */
export function readIndex(path: string): LoadedIndex {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const info = db.prepare("SELECT * FROM index_info WHERE id = 1").get() as unknown as InfoRow | undefined;
    if (!info) throw new Error(`${path} has no index_info row; rebuild it with npm run index.`);

    // node:sqlite returns rows as objects with a null prototype; copied into
    // plain objects so they behave like every other object in the program.
    const documents = (db.prepare("SELECT id, path, title, text FROM documents ORDER BY path").all() as unknown as LoadedIndex["documents"])
      .map(({ id, path, title, text }) => ({ id, path, title, text }));
    const rows = db.prepare("SELECT * FROM chunks ORDER BY n").all() as unknown as Array<{
      id: string; doc_id: string; heading_path: string; text: string; embed_text: string; start_offset: number;
      end_offset: number; estimated_tokens: number; vector: Uint8Array; map_x: number; map_y: number;
    }>;

    return {
      settings: settingsFrom(info, rows.length),
      projection: {
        mean: fromBlob(info.map_mean),
        axes: [fromBlob(info.map_axis_x), fromBlob(info.map_axis_y)],
        variance: [info.map_variance_x, info.map_variance_y],
      },
      documents,
      chunks: rows.map((r) => ({
        id: r.id,
        docId: r.doc_id,
        headingPath: JSON.parse(r.heading_path) as string[],
        text: r.text,
        embedText: r.embed_text,
        start: r.start_offset,
        end: r.end_offset,
        estimatedTokens: r.estimated_tokens,
        vector: fromBlob(r.vector),
        map: { x: r.map_x, y: r.map_y },
      })),
    };
  } finally {
    db.close();
  }
}
