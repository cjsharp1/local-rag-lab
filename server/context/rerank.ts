/**
 * rerank.ts — the optional rerank stage: the chat model re-scores the top candidates.
 *
 * Search ranks chunks by how similar they are to the query, which isn't
 * the same as how well they answer it. A reranker reads the question and
 * each candidate together and scores the pair, which usually orders them
 * better, at a price: it's a model call per search. Production systems use
 * a small dedicated "cross-encoder" for this; Ollama has no rerank
 * endpoint (step 0), so the lab's v1 asks the chat model itself
 * (decision #4), in ONE structured request:
 *
 *   "Score how well each passage answers the question, 0–3."
 *   → { "scores": [3, 0, 1, 2, 0, 0, 1, 0] }
 *
 * The reply's shape is enforced with Ollama's `format` (a JSON Schema), so
 * a 4B model can't wander into prose. The top RERANK_N candidates are then
 * reordered by score; ties keep their search order; everything past
 * RERANK_N stays where it was, behind them.
 *
 * It's slow by design and labeled so in the UI: a whole model request,
 * about 2,000 prompt tokens, added to every search. The time it adds is
 * logged as its own stage, because that cost is part of the lesson.
 *
 * If the reply is malformed (wrong number of scores, a score out of
 * range), the original order is kept and the log says so. There's no
 * silent retry: a reranker that sometimes fails is a fact worth seeing.
 */

import type { Candidate } from "../../shared/types.js";
import { buildRequest, chat, ms, type ChatRequest, type ChatResponse } from "../model/ollama.js";

/** How many top candidates the reranker reads (PLAN §4.4). */
export const RERANK_N = 8;

const SYSTEM =
  "You judge search results. For each numbered passage, score how well it answers the question:\n" +
  "3 = answers it directly, 2 = partly answers it, 1 = on the topic but doesn't answer it, 0 = unrelated.\n" +
  "Reply with JSON only: {\"scores\": [one integer per passage, in passage order]}.";

/** The JSON Schema the reply must match, for `n` passages. */
function schema(n: number): Record<string, unknown> {
  return {
    type: "object",
    properties: { scores: { type: "array", items: { type: "integer", minimum: 0, maximum: 3 }, minItems: n, maxItems: n } },
    required: ["scores"],
  };
}

/** The rerank request for a question and its top candidates. */
export function rerankRequest(model: string, question: string, top: readonly Candidate[]): ChatRequest {
  const passages = top.map((c, i) => `Passage ${i + 1}:\n${c.text}`).join("\n\n");
  return buildRequest({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Question: ${question}\n\n${passages}` },
    ],
    format: schema(top.length),
  });
}

/**
 * Reads the scores out of a reply, or null if it isn't exactly `n`
 * integers from 0 to 3. Pure, so the tests can feed it bad replies.
 */
export function parseScores(content: string, n: number): number[] | null {
  try {
    const scores = (JSON.parse(content) as { scores?: unknown }).scores;
    if (!Array.isArray(scores) || scores.length !== n) return null;
    if (!scores.every((s) => Number.isInteger(s) && s >= 0 && s <= 3)) return null;
    return scores as number[];
  } catch {
    return null;
  }
}

/**
 * Reorders candidates by rerank score: the scored top n first, highest
 * score first, ties in search order; then the unscored rest, unchanged.
 * Each scored candidate gets rerankScore and rerankRank.
 */
export function applyScores(candidates: readonly Candidate[], scores: readonly number[]): Candidate[] {
  const scored = candidates.slice(0, scores.length).map((c, i) => ({ c, score: scores[i]!, i }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return [
    ...scored.map(({ c, score }, rank) => ({ ...c, rerankScore: score, rerankRank: rank + 1 })),
    ...candidates.slice(scores.length),
  ];
}

/** What one rerank did. */
export interface RerankOutcome {
  /** The candidates in their new order (the original order if the reply was malformed). */
  candidates: Candidate[];
  /** null when the reply couldn't be read. */
  scores: number[] | null;
  /** How many of the top n changed position. */
  moved: number;
  request: ChatRequest;
  response: ChatResponse;
  /** Generation time, and model load time, in milliseconds. */
  ms: number;
  loadMs: number;
}

/** Reranks the top RERANK_N candidates with the chat model. */
export async function rerank(model: string, question: string, candidates: readonly Candidate[]): Promise<RerankOutcome> {
  const top = candidates.slice(0, RERANK_N);
  const request = rerankRequest(model, question, top);
  const response = await chat(request);
  const loadMs = ms(response.load_duration);
  const scores = top.length === 0 ? [] : parseScores(response.message.content, top.length);
  const reordered = scores ? applyScores(candidates, scores) : [...candidates];
  const moved = reordered.slice(0, top.length).filter((c, i) => c.chunkId !== top[i]!.chunkId).length;
  return { candidates: reordered, scores, moved, request, response, ms: ms(response.total_duration) - loadMs, loadMs };
}
