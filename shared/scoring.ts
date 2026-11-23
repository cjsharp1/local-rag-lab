/**
 * scoring.ts — how the lab decides whether text holds an answer, by code alone.
 *
 * No model judges anything in this lab (PLAN §8). Two questions get
 * answered by plain string matching, and this file is the whole of it:
 *
 *   1. Does a chunk hold a gold span? Retrieval is scored this way: a
 *      chunk is a hit if its text contains the span (scoreRetrieval).
 *   2. Does an answer contain a required fact, or a forbidden one, or a
 *      phrase that declines or flags a conflict? Answers are scored this
 *      way, into exactly one outcome.
 *
 * ---------------------------------------------------------------------------
 * What "contains" means
 * ---------------------------------------------------------------------------
 *
 * Both sides are normalized first: lowercase, whitespace collapsed, curly
 * quotes and long dashes made plain, and Markdown emphasis (* _ `) removed,
 * so "**9 people**" in a document matches "9 people" in a span, and an
 * answer's "6 PM" matches a fact written "6 pm". Digits are never
 * normalized: "$35" is not "$350", and a fact that starts or ends with a
 * digit must not continue into another digit in the answer. That's the
 * near miss that would otherwise score a wrong price as right.
 *
 * ---------------------------------------------------------------------------
 * Declining and flagging a conflict are heuristics
 * ---------------------------------------------------------------------------
 *
 * Whether an answer says "the documents don't say" is decided by matching
 * a fixed list of phrases (DECLINE_PHRASES), and whether it flags the
 * 2025/2026 conflict by another (CONFLICT_PHRASES, or naming both years).
 * The lists were written at build step 6, before any answer was
 * generated, and are frozen: changing them after seeing answers would be
 * tuning the scorer to the results. The scorecard lists every answer
 * these phrases classified, so a reader can check each call.
 */

import type { AnswerOutcome, Question } from "./types.js";

/** Lowercase, plain punctuation, no Markdown emphasis, single spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether `haystack` contains `span`, both normalized. */
export function containsSpan(haystack: string, span: string): boolean {
  return normalizeForMatch(haystack).includes(normalizeForMatch(span));
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * Whether an answer states a fact. Like containsSpan, plus the digit rule:
 * a fact that begins with a digit (or "$" and a digit) can't be preceded
 * by a digit, and a fact that ends with a digit can't be followed by one,
 * or by a comma or point and then a digit. "$35" matches "$35 per boat"
 * and "$35." but not "$350", "$35.50" or "$1,350".
 */
export function containsFact(answer: string, fact: string): boolean {
  const text = normalizeForMatch(answer);
  const needle = normalizeForMatch(fact);
  if (needle === "") return false;
  const checkStart = isDigit(needle.replace(/^\$/, "")[0]);
  const checkEnd = isDigit(needle[needle.length - 1]);

  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1];
    const after = text.slice(at + needle.length, at + needle.length + 2);
    if (checkStart && isDigit(before)) continue;
    if (checkEnd && (isDigit(after[0]) || (/[.,]/.test(after[0] ?? "") && isDigit(after[1])))) continue;
    return true;
  }
  return false;
}

/** A required entry: one wording, or a list of acceptable wordings. */
export function containsAnyWording(answer: string, fact: string | readonly string[]): boolean {
  return (typeof fact === "string" ? [fact] : fact).some((wording) => containsFact(answer, wording));
}

/**
 * Phrases that mean "the documents don't contain this". Frozen at step 6;
 * see the header. Matched after normalization, so straight apostrophes
 * here also match curly ones in an answer.
 */
export const DECLINE_PHRASES: readonly string[] = [
  "don't contain", "do not contain", "doesn't contain", "does not contain",
  "don't mention", "do not mention", "doesn't mention", "does not mention", "no mention",
  "don't say", "do not say", "doesn't say", "does not say",
  "don't specify", "do not specify", "doesn't specify", "does not specify", "not specified",
  "don't include", "do not include", "doesn't include", "does not include",
  "not in the documents", "isn't in the documents", "is not in the documents", "not in the provided",
  "not mentioned", "not provided", "no information", "don't have information", "do not have information",
  "couldn't find", "could not find", "can't find", "cannot find", "unable to find",
  "i don't know", "i do not know",
];

/**
 * Phrases that flag the 2025/2026 rate conflict. Naming both years also
 * counts (see classifyAnswer). Frozen at step 6.
 */
export const CONFLICT_PHRASES: readonly string[] = [
  "conflict", "disagree", "differ", "inconsistent", "contradict", "discrepan",
  "two different", "outdated", "out of date", "older rate", "older sheet", "previous season", "last season",
];

const hasPhrase = (answer: string, phrases: readonly string[]) => {
  const text = normalizeForMatch(answer);
  return phrases.some((p) => text.includes(normalizeForMatch(p)));
};

/** How one search did for one question (PLAN §8, hit rules). */
export interface RetrievalScore {
  /** Every hop has a gold span inside one of the top k chunks. */
  hit: boolean;
  /** Some hops found, not all. Only possible for multi-hop questions. */
  partial: boolean;
  hopsFound: number;
  hops: number;
  /**
   * 1-based rank of the first candidate that holds any gold span from any
   * hop, anywhere in the list (not only the top k), or null. MRR is built
   * from this.
   */
  firstGoldRank: number | null;
}

/** Whether a chunk holds a gold span: the right document, and the span inside its own text. */
export function chunkHoldsSpan(chunk: { docId: string; text: string }, span: { doc: string; text: string }): boolean {
  return chunk.docId === span.doc && containsSpan(chunk.text, span.text);
}

/**
 * Scores one ranked list of chunks against a question's gold hops.
 *
 * The rules (PLAN §8): a hop is found when any of its alternative spans is
 * inside one of the top k chunks, from the document the span names. A
 * span that straddles two chunks is in neither, which is a miss, on
 * purpose: that's what `fixed` chunking does to a table row. The text
 * matched is the chunk's own text, never the heading path heading+context
 * prepends for embedding.
 */
export function scoreRetrieval(
  question: Pick<Question, "hops">,
  candidates: ReadonlyArray<{ docId: string; text: string }>,
  k: number,
): RetrievalScore {
  const kept = candidates.slice(0, k);
  const hopsFound = question.hops.filter((hop) => kept.some((chunk) => hop.some((span) => chunkHoldsSpan(chunk, span)))).length;
  const allSpans = question.hops.flat();
  const first = candidates.findIndex((chunk) => allSpans.some((span) => chunkHoldsSpan(chunk, span)));
  const hops = question.hops.length;
  return {
    hit: hops > 0 && hopsFound === hops,
    partial: hopsFound > 0 && hopsFound < hops,
    hopsFound,
    hops,
    firstGoldRank: first < 0 ? null : first + 1,
  };
}

/** An answer's outcome, and the evidence for it. */
export interface Classification {
  outcome: AnswerOutcome;
  /** Required facts not found (as written in the question file). */
  missing: Array<string | string[]>;
  /** Forbidden facts found. */
  forbiddenFound: string[];
  /** Whether a decline phrase matched. A heuristic. */
  declinePhrase: boolean;
  /** Whether a conflict phrase matched, or both years were named. A heuristic. */
  conflictPhrase: boolean;
}

/**
 * Puts an answer into exactly one outcome (PLAN §8), in this order:
 *
 *   unanswerable questions: declined if a decline phrase matches, else invented.
 *   others:
 *     correct           all required facts, no forbidden fact
 *     conflict-flagged  (stale only) the 2026 and 2025 figures both
 *                       present, and a conflict phrase or both years named
 *     declined          a decline phrase, and no forbidden fact
 *     invented          anything else
 *
 * "Correct" is checked before "declined" on purpose: "The documents don't
 * say why, but the fee is $35" answers the question.
 */
export function classifyAnswer(question: Pick<Question, "category" | "required" | "forbidden">, answer: string): Classification {
  const missing = question.required.filter((fact) => !containsAnyWording(answer, fact));
  const forbiddenFound = question.forbidden.filter((fact) => containsFact(answer, fact));
  const declinePhrase = hasPhrase(answer, DECLINE_PHRASES);
  const conflictPhrase = hasPhrase(answer, CONFLICT_PHRASES) || (containsFact(answer, "2025") && containsFact(answer, "2026"));
  const evidence = { missing, forbiddenFound, declinePhrase, conflictPhrase };

  if (question.category === "unanswerable") {
    return { outcome: declinePhrase ? "declined" : "invented", ...evidence };
  }
  if (missing.length === 0 && forbiddenFound.length === 0) return { outcome: "correct", ...evidence };
  if (question.category === "stale" && missing.length === 0 && forbiddenFound.length > 0 && conflictPhrase) {
    return { outcome: "conflict-flagged", ...evidence };
  }
  if (declinePhrase && forbiddenFound.length === 0) return { outcome: "declined", ...evidence };
  return { outcome: "invented", ...evidence };
}
