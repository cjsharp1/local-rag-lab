/**
 * documents.ts — the get_document, list_documents and index_map tools.
 *
 * search_docs returns chunks: pieces of documents, cut where the chunker
 * cut them. Sometimes the piece isn't enough (the answer runs past the
 * chunk's end, or a table's header is in another chunk) and a reader, or
 * a model in search-tool mode, wants the whole document. The two document
 * tools provide that, and a third gives the UI its map:
 *
 *   index_map       every chunk's position on the 2D embedding map, for
 *                   the UI (the model is never offered it).
 *   list_documents  every document's id, path and title, and which
 *                   indexes are loaded with how many chunks each.
 *   get_document    one document's full text, by id.
 *
 * Documents are read from a loaded index, not from corpus/, so a document
 * and the chunks search returns from it always come from the same build.
 * If the index is stale, list_documents says so.
 */

import { z } from "zod";

import { DEFAULT_STRATEGY } from "../../shared/search-settings.js";
import type { ChunkStrategy } from "../../shared/types.js";
import { getIndex, IndexMissingError, loadedIndexes } from "../indexes.js";
import { ToolError, type ToolDefinition } from "./types.js";

/** The documents of the default index, or of any index if that one isn't built. */
function documentsSource() {
  try {
    return getIndex(DEFAULT_STRATEGY);
  } catch (error: unknown) {
    if (!(error instanceof IndexMissingError)) throw error;
    const any = loadedIndexes()[0];
    if (!any) throw new ToolError("No index is loaded, so there are no documents to read. Build them with:  npm run index");
    return any;
  }
}

// --- list_documents -----------------------------------------------------------------

interface DocumentList {
  documents: Array<{ id: string; path: string; title: string }>;
  indexes: Array<{ strategy: ChunkStrategy; preset: string; chunks: number; stale: boolean }>;
}

const listInput = z.object({});

export const listDocuments: ToolDefinition<typeof listInput, DocumentList> = {
  name: "list_documents",
  title: "List the outfitter's documents",
  description: "List every Paddle Section Supply document with its id, folder and title. Use an id with get_document to read one in full.",
  inputSchema: listInput,
  outputSchema: z.object({
    documents: z.array(z.object({ id: z.string(), path: z.string(), title: z.string() })),
    indexes: z.array(z.object({ strategy: z.enum(["fixed", "heading", "heading+context"]), preset: z.string(), chunks: z.number(), stale: z.boolean() })),
  }),
  async run() {
    const source = documentsSource();
    const data: DocumentList = {
      documents: source.documents.map(({ id, path, title }) => ({ id, path, title })),
      indexes: loadedIndexes().map((i) => ({ strategy: i.settings.strategy, preset: i.settings.preset, chunks: i.chunks.length, stale: i.stale })),
    };
    const text = [
      `${data.documents.length} documents:`,
      ...data.documents.map((d) => `  ${d.id.padEnd(28)} ${d.path}  —  ${d.title}`),
      "",
      "Indexes loaded:",
      ...data.indexes.map((i) => `  ${i.strategy.padEnd(16)} ${i.chunks} chunks, preset ${i.preset}${i.stale ? "  (STALE: run npm run index)" : ""}`),
    ].join("\n");
    return { data, text };
  },
};

// --- index_map ----------------------------------------------------------------------

interface IndexMap {
  strategy: ChunkStrategy;
  preset: string;
  /** Share of the total variance each map axis keeps, 0–1. */
  variance: [number, number];
  chunks: Array<{ chunkId: string; docId: string; x: number; y: number }>;
}

const mapInput = z.object({
  strategy: z.enum(["fixed", "heading", "heading+context"]).optional().describe(`Which index (default ${DEFAULT_STRATEGY}).`),
});

/**
 * The embedding map's points (PLAN §4.5): every chunk's 2D position, for
 * the UI to draw. The app uses this; the model is never offered it
 * (search-tool mode offers search_docs alone), so it costs no prompt space.
 */
export const indexMap: ToolDefinition<typeof mapInput, IndexMap> = {
  name: "index_map",
  title: "Chunk positions on the embedding map",
  description: "Every chunk's position on the 2D embedding map of one index, and the share of variance the map keeps. For drawing the map, not for answering questions.",
  inputSchema: mapInput,
  outputSchema: z.object({
    strategy: z.enum(["fixed", "heading", "heading+context"]),
    preset: z.string(),
    variance: z.tuple([z.number(), z.number()]),
    chunks: z.array(z.object({ chunkId: z.string(), docId: z.string(), x: z.number(), y: z.number() })),
  }),
  async run({ strategy }) {
    let index;
    try {
      index = getIndex(strategy ?? DEFAULT_STRATEGY);
    } catch (error: unknown) {
      if (error instanceof IndexMissingError) throw new ToolError(error.message);
      throw error;
    }
    const data: IndexMap = {
      strategy: index.settings.strategy,
      preset: index.settings.preset,
      variance: index.settings.mapVariance,
      chunks: index.chunks.map((c) => ({ chunkId: c.id, docId: c.docId, x: c.map.x, y: c.map.y })),
    };
    return { data, text: `${data.chunks.length} chunks on the ${data.strategy} map; the axes keep ${(data.variance[0] * 100).toFixed(1)}% + ${(data.variance[1] * 100).toFixed(1)}% of the variance.` };
  },
};

// --- get_document -------------------------------------------------------------------

interface DocumentText {
  id: string;
  path: string;
  title: string;
  text: string;
}

const getInput = z.object({
  id: z.string().trim().min(1).max(100).describe('A document id from list_documents or from a chunk label, e.g. "rental-agreement".'),
});

export const getDocument: ToolDefinition<typeof getInput, DocumentText> = {
  name: "get_document",
  title: "Read one document in full",
  description: "Read the full text of one Paddle Section Supply document by its id (the part of a chunk label before the #).",
  inputSchema: getInput,
  outputSchema: z.object({ id: z.string(), path: z.string(), title: z.string(), text: z.string() }),
  async run({ id }) {
    // Accept a whole chunk label too: "[rental-agreement#late-returns]" → "rental-agreement".
    const docId = id.replace(/^\[/, "").replace(/\]$/, "").split("#")[0]!;
    const doc = documentsSource().documents.find((d) => d.id === docId);
    if (!doc) throw new ToolError(`There is no document "${docId}". Call list_documents to see the ids.`);
    return { data: { ...doc }, text: `${doc.title} (${doc.path})\n\n${doc.text}` };
  },
};
