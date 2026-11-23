/**
 * budget.ts — decides which retrieved chunks go into the model's request, and why the rest don't.
 *
 * The tool server returns every candidate that passed the floor, often a
 * hundred or more. Only a few can be sent, and this file picks them, in
 * rank order, under two limits (PLAN §4.3):
 *
 *   top-k    at most k chunks (the retrieval panel's slider);
 *   budget   only as many estimated tokens as the request has room for.
 *
 * Every chunk not sent gets a reason: `past-top-k` or `over-budget`. (The
 * third reason, `below-floor`, was decided by the tool server and arrives
 * as a summary.) The modes log these, so "why wasn't the fee table in
 * the prompt?" always has an answer in the log.
 *
 * ---------------------------------------------------------------------------
 * Window, chunk budget, and why the numbers are estimates
 * ---------------------------------------------------------------------------
 *
 *   window        NUM_CTX, the model's whole context (8192 tokens).
 *   chunk budget  the window minus everything else in the request (system
 *                 prompt, history, the question, tool definitions, earlier
 *                 tool results) and minus a reserve for the reply.
 *
 * All of it is estimated at characters ÷ 4 before the request is sent;
 * the real count (prompt_eval_count) only comes back afterwards. The
 * model-request log row shows both, so the estimate's error is visible.
 * The reply reserve absorbs ordinary error; the drop detector in
 * modes/common.ts catches the rest.
 *
 * With the budget check turned off (a toggle in the retrieval panel), top-k
 * is the only limit, and a reader can push chunks past the window on
 * purpose to watch Ollama drop messages.
 */

import { estimateTokens } from "../../shared/chunk.js";
import type { Candidate, DropReason } from "../../shared/types.js";

/**
 * Tokens a chat template adds around each message (role markers, separators).
 * A heuristic: templates differ, and a few tokens per message is typical.
 */
export const TOKENS_PER_MESSAGE = 8;

/** How much room is left for chunks, in estimated tokens. Never negative. */
export function chunkBudget(parts: { numCtx: number; replyReserve: number; otherTokens: number }): number {
  return Math.max(0, parts.numCtx - parts.replyReserve - parts.otherTokens);
}

/** What selectChunks decided. */
export interface Selection {
  kept: Candidate[];
  dropped: Array<{ candidate: Candidate; reason: Exclude<DropReason, "below-floor">; tokens: number }>;
  /** Estimated tokens the kept chunks will take in the prompt. */
  keptTokens: number;
  budget: number;
}

/**
 * Walks the candidates in rank order. The first k are considered; once
 * one doesn't fit the remaining budget, it and every later one in the top
 * k are `over-budget`. Stopping at the first that doesn't fit, rather than
 * skipping ahead to a smaller chunk further down, keeps what's sent a
 * strict prefix of the ranking, so "the top 3 of the 4 asked for" is
 * always what a reader sees. Everything after the top k is `past-top-k`.
 *
 * `cost` is the tokens a chunk takes in the prompt: its text plus the
 * label line the assembler writes above it.
 */
export function selectChunks(
  candidates: readonly Candidate[],
  limits: { topK: number; budget: number; budgetCheck: boolean },
  cost: (candidate: Candidate) => number,
): Selection {
  const kept: Candidate[] = [];
  const dropped: Selection["dropped"] = [];
  let used = 0;
  let full = false;

  candidates.forEach((candidate, i) => {
    const tokens = cost(candidate);
    if (i >= limits.topK) {
      dropped.push({ candidate, reason: "past-top-k", tokens });
    } else if (limits.budgetCheck && (full || used + tokens > limits.budget)) {
      full = true;
      dropped.push({ candidate, reason: "over-budget", tokens });
    } else {
      kept.push(candidate);
      used += tokens;
    }
  });
  return { kept, dropped, keptTokens: used, budget: limits.budget };
}

/** Estimated tokens of a list of message texts, with the per-message template overhead. */
export function estimateMessages(contents: readonly string[]): number {
  return contents.reduce((sum, text) => sum + estimateTokens(text) + TOKENS_PER_MESSAGE, 0);
}
