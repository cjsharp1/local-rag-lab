/**
 * search-docs.ts — the search_docs tool: the one way anything in the lab searches.
 *
 * Both retrieval modes call this tool (PLAN §2). In pre-retrieved mode
 * the APP calls it, before the model runs, with the user's question as
 * the query. In search-tool mode the MODEL calls it, with a query it
 * wrote. Same tool, same code, same results; the only difference is who
 * made the call, and the activity log's `actor` column shows which. That
 * difference is the whole distinction between "classic" and "agentic"
 * RAG, and keeping one code path makes it impossible to blur.
 *
 * It returns every candidate that passes the floor, with every score
 * (search/search.ts), never just the top k. Picking the top k and fitting
 * them into the context budget happens in the app, which logs every chunk
 * it drops and why (PLAN §4.3).
 *
 * Only `query` is the model's to write. `strategy`, `mode` and `floor`
 * are search settings the app sets from the retrieval panel; in
 * search-tool mode the app offers the model a version of this tool with
 * `query` alone, and adds the rest itself.
 */

import { z } from "zod";

import { DEFAULT_SEARCH, DEFAULT_STRATEGY } from "../../shared/search-settings.js";
import type { SearchResult } from "../../shared/types.js";
import { getIndex, IndexMissingError } from "../indexes.js";
import { search } from "../search/search.js";
import { ToolError, type ToolDefinition } from "./types.js";

const strategySchema = z.enum(["fixed", "heading", "heading+context"]);
const modeSchema = z.enum(["vector", "keyword", "hybrid"]);

const inputSchema = z.object({
  query: z.string().trim().min(1).max(500).describe("What to search for, in plain words. Codes like EP-14 or KB-7 are matched exactly."),
  strategy: strategySchema.optional().describe(`Which index to search (set by the app). Default: ${DEFAULT_STRATEGY}.`),
  mode: modeSchema.optional().describe(`vector, keyword or hybrid (set by the app). Default: ${DEFAULT_SEARCH.mode}.`),
  floor: z.number().min(-1).max(1).optional().describe(`Minimum vector similarity for a vector-only match (set by the app). Default: ${DEFAULT_SEARCH.floor}.`),
});

const candidateSchema = z.object({
  chunkId: z.string(),
  label: z.string(),
  docId: z.string(),
  headingPath: z.array(z.string()),
  text: z.string(),
  estimatedTokens: z.number(),
  vectorScore: z.number(),
  vectorRank: z.number().optional(),
  keywordScore: z.number().optional(),
  keywordRank: z.number().optional(),
  fusedScore: z.number().optional(),
  fusedRank: z.number().optional(),
  rerankScore: z.number().optional(),
  rerankRank: z.number().optional(),
  map: z.object({ x: z.number(), y: z.number() }).optional(),
});

const outputSchema: z.ZodType<SearchResult> = z.object({
  query: z.string(),
  strategy: strategySchema,
  mode: modeSchema,
  floor: z.number(),
  keywordQuery: z.string().nullable().optional(),
  ignoredWords: z.array(z.string()).optional(),
  candidates: z.array(candidateSchema),
  belowFloor: z.object({ count: z.number(), best: z.object({ chunkId: z.string(), vectorScore: z.number() }).optional() }),
  totalChunks: z.number(),
  queryMap: z.object({ x: z.number(), y: z.number() }),
  timings: z.object({ embed: z.number(), embedLoad: z.number(), search: z.number() }),
  indexStale: z.boolean(),
});

/** The plain-text rendering: what MCP Inspector shows. The app builds its own for the model. */
function render(result: SearchResult): string {
  const lines = [
    `${result.candidates.length} of ${result.totalChunks} chunks matched "${result.query}" ` +
      `(${result.mode}, ${result.strategy} index, floor ${result.floor}; ${result.belowFloor.count} below the floor).`,
  ];
  if (result.keywordQuery !== undefined) lines.push(`Keyword query: ${result.keywordQuery ?? "(no searchable words)"}`);
  if (result.indexStale) lines.push("WARNING: this index was built from a different corpus. Run npm run index.");
  result.candidates.slice(0, 10).forEach((c, i) => {
    const scores = [
      `vector ${c.vectorScore.toFixed(3)} (#${c.vectorRank})`,
      c.keywordRank !== undefined ? `keyword #${c.keywordRank}` : null,
      c.fusedScore !== undefined ? `fused ${c.fusedScore.toFixed(4)}` : null,
    ].filter(Boolean).join(" · ");
    lines.push("", `${i + 1}. ${c.label}  ${scores}`, `   ${c.text.replace(/\s+/g, " ").slice(0, 200)}…`);
  });
  if (result.candidates.length > 10) lines.push("", `…and ${result.candidates.length - 10} more in the structured result.`);
  return lines.join("\n");
}

export const searchDocs: ToolDefinition<typeof inputSchema, SearchResult> = {
  name: "search_docs",
  title: "Search the outfitter's documents",
  description:
    "Search Paddle Section Supply's documents: rental policies and rates, permits and regulations, route guides, " +
    "gear guides and FAQs. Returns the passages that best match the query, each labeled like [rental-agreement#late-returns]. " +
    "Search again with different words if the first results don't contain the answer.",
  inputSchema,
  outputSchema,
  async run(args) {
    const strategy = args.strategy ?? DEFAULT_STRATEGY;
    let index;
    try {
      index = getIndex(strategy);
    } catch (error: unknown) {
      if (error instanceof IndexMissingError) throw new ToolError(error.message);
      throw error;
    }
    const result = await search(index, {
      query: args.query,
      strategy,
      mode: args.mode ?? DEFAULT_SEARCH.mode,
      floor: args.floor ?? DEFAULT_SEARCH.floor,
    });
    return { data: result, text: render(result) };
  },
};
