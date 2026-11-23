/**
 * search.ts — one entry point for every kind of search: embed, rank, fuse, filter.
 *
 * search_docs calls this, and it's the only search path in the lab: both
 * retrieval modes, pre-retrieved and search-tool, end up here (PLAN §10).
 * It returns EVERY candidate that passes the floor, each carrying every
 * score it was given, in the mode's rank order. It never applies top-k
 * or the context budget. Those are the app's decisions, made where they
 * can be logged one chunk at a time.
 *
 * The three modes (PLAN §4.2):
 *
 *   vector   Rank every chunk by cosine similarity; drop those below the
 *            floor.
 *   keyword  Rank the chunks FTS5 matches by BM25. The floor doesn't
 *            apply: a keyword match is a match.
 *   hybrid   Both, fused by reciprocal rank fusion. A chunk is dropped
 *            only if it's below the vector floor AND keyword search didn't
 *            match it. Otherwise a chunk that BM25 finds by "EP-14" but
 *            that scores low on vector similarity would vanish before
 *            anyone saw it, and the reason hybrid search exists with it.
 *
 * Vector scores are computed in every mode, even keyword, so the log can
 * show what vector search would have thought of a keyword hit.
 *
 * The floor and fusion rules live in combine(), a pure function with no
 * Ollama and no SQLite, so the tests can pin them down exactly.
 */

import type { Candidate, ChunkStrategy, SearchMode, SearchResult } from "../../shared/types.js";
import { embed } from "../embed.js";
import type { IndexEntry } from "../indexes.js";
import { project } from "../pca.js";
import { reciprocalRankFusion } from "./fuse.js";
import { buildKeywordQuery, rankByKeyword } from "./keyword.js";
import { rankByVector, type Ranked } from "./vector.js";

/** What combine() decided: the candidates, in order, and what the floor removed. */
export interface Combined {
  /** Chunk positions, best first, each with its rank in every list. */
  order: Array<{ index: number; vector: Ranked; keyword?: Ranked; fused?: Ranked }>;
  belowFloor: Ranked[];
}

/**
 * Applies a mode's floor and fusion rules to the two rankings.
 *
 * `vector` must rank every chunk (rankByVector does); `keyword` holds only
 * the chunks keyword search matched. In hybrid mode the vector list that
 * goes into fusion is the part above the floor: the floor removes a chunk
 * from the vector list, never from the keyword list.
 */
export function combine(mode: SearchMode, floor: number, vector: readonly Ranked[], keyword: readonly Ranked[]): Combined {
  const byIndex = new Map(vector.map((v) => [v.index, v]));
  const keywordByIndex = new Map(keyword.map((k) => [k.index, k]));
  const aboveFloor = vector.filter((v) => v.score >= floor);
  const belowFloor = vector.filter((v) => v.score < floor);
  const entry = (index: number, fused?: Ranked) => ({
    index,
    vector: byIndex.get(index)!,
    ...(keywordByIndex.has(index) ? { keyword: keywordByIndex.get(index)! } : {}),
    ...(fused ? { fused } : {}),
  });

  if (mode === "vector") {
    return { order: aboveFloor.map((v) => entry(v.index)), belowFloor };
  }
  if (mode === "keyword") {
    // No floor: below-floor is reported as empty, since nothing was removed.
    return { order: keyword.map((k) => entry(k.index)), belowFloor: [] };
  }
  const fused = reciprocalRankFusion([aboveFloor, keyword]);
  return {
    order: fused.map((f) => entry(f.index, f)),
    belowFloor: belowFloor.filter((v) => !keywordByIndex.has(v.index)),
  };
}

/** What a search needs from its caller. */
export interface SearchRequest {
  query: string;
  strategy: ChunkStrategy;
  mode: SearchMode;
  floor: number;
}

/** Runs one search against one loaded index: embed the query, then rank. */
export async function search(index: IndexEntry, request: SearchRequest): Promise<SearchResult> {
  const embedded = await embed([request.query], "query");
  return searchWithVector(index, request, embedded.vectors[0]!, { embed: embedded.totalMs, embedLoad: embedded.loadMs });
}

/**
 * The ranking half of a search, for a query that's already embedded. The
 * scorecard uses it to embed each question once and search nine indexes
 * with the same vector; search() above is this plus one embed call.
 */
export function searchWithVector(
  index: IndexEntry,
  request: SearchRequest,
  queryVector: Float32Array,
  embedTimings: { embed: number; embedLoad: number },
): SearchResult {
  const started = performance.now();
  const vector = rankByVector(queryVector, index.chunks.map((c) => c.vector));
  const keywordQuery = request.mode === "vector" ? null : buildKeywordQuery(request.query);
  const keyword = keywordQuery ? rankByKeyword(index.db, keywordQuery.match) : [];
  const { order, belowFloor } = combine(request.mode, request.floor, vector, keyword);
  const searchMs = performance.now() - started;

  const candidates: Candidate[] = order.map(({ index: i, vector: v, keyword: k, fused: f }) => {
    const chunk = index.chunks[i]!;
    return {
      chunkId: chunk.id,
      label: `[${chunk.id}]`,
      docId: chunk.docId,
      headingPath: chunk.headingPath,
      text: chunk.text,
      start: chunk.start,
      end: chunk.end,
      estimatedTokens: chunk.estimatedTokens,
      vectorScore: v.score,
      vectorRank: v.rank,
      ...(k ? { keywordScore: k.score, keywordRank: k.rank } : {}),
      ...(f ? { fusedScore: f.score, fusedRank: f.rank } : {}),
      map: chunk.map,
    };
  });

  const best = belowFloor[0];
  return {
    query: request.query,
    strategy: request.strategy,
    mode: request.mode,
    floor: request.floor,
    ...(keywordQuery ? { keywordQuery: keywordQuery.match, ignoredWords: keywordQuery.ignored } : {}),
    candidates,
    belowFloor: {
      count: belowFloor.length,
      ...(best ? { best: { chunkId: index.chunks[best.index]!.id, vectorScore: best.score } } : {}),
    },
    totalChunks: index.chunks.length,
    queryMap: project(index.projection, queryVector),
    timings: { ...embedTimings, search: searchMs },
    indexStale: index.stale,
  };
}
