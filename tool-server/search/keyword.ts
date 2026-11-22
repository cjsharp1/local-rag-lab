/**
 * keyword.ts — keyword search: SQLite's FTS5 full-text index, ranked by BM25.
 *
 * Keyword search finds chunks that contain the query's words. It knows
 * nothing about meaning: "late return fee" won't find "bring the canoe
 * back after 6 p.m." But it finds exact identifiers instantly, and those
 * are where vector search is weakest: "EP-14" carries almost no meaning
 * for an embeddings model, and to keyword search it's just two tokens to
 * look up. Hybrid search exists because each one covers the other's
 * blind spot (PLAN §1, lesson 5).
 *
 * BM25 is the standard ranking formula for this. A chunk scores higher
 * when it contains a query word more often (with diminishing returns),
 * when that word is rare across the corpus, and when the chunk is short.
 * SQLite reports it negated: lower is better.
 *
 * ---------------------------------------------------------------------------
 * The query has to be rebuilt first
 * ---------------------------------------------------------------------------
 *
 * Raw user text can't go to FTS5's MATCH: step 0 found that "EP-14"
 * throws "no such column: 14" (the hyphen is read as a column filter)
 * and a trailing "?" is a syntax error. So buildKeywordQuery():
 *
 *   1. keeps only letters, digits and hyphens inside a word;
 *   2. drops common words ("what", "the", "how") and stray single letters
 *      (the "p" and "m" left over from "6 p.m."). This is a heuristic: a
 *      short fixed list, chosen by eye. Without it, nearly every chunk
 *      matches "the", and keyword search returns the whole corpus;
 *   3. quotes each remaining word, so FTS5 treats it as text, never as
 *      syntax, and "EP-14" becomes the two-token phrase "ep" "14";
 *   4. joins them with OR, so a chunk needs only some of the words.
 *
 * The built query and the dropped words are returned with every search,
 * and the log shows them: the conversion is part of what keyword search
 * did, not a detail to hide.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Ranked } from "./vector.js";

/**
 * Common words dropped before keyword search. Deliberately short: a word
 * left out of this list costs a little noise; a word wrongly put in it
 * makes keyword search blind to it.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "do", "does", "for", "from",
  "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "me", "much", "my", "of",
  "on", "or", "our", "should", "so", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "us", "was", "we", "were", "what", "whats", "when", "where", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

/** The FTS5 query built from a user's text, and what was left out. */
export interface KeywordQuery {
  /** The MATCH expression, or null when no searchable word is left. */
  match: string | null;
  /** The words searched for, in order, lowercased. */
  terms: string[];
  /** Words dropped as common words or stray letters. */
  ignored: string[];
}

/** Builds a safe FTS5 query from arbitrary text (see the header). */
export function buildKeywordQuery(text: string): KeywordQuery {
  const words = text
    .toLowerCase()
    .replace(/[’']/g, "") // "what's" → "whats", "renter's" → "renters"
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .split(" ")
    .map((w) => w.replace(/^-+|-+$/g, "")) // a hyphen only counts inside a word
    .filter((w) => w !== "");

  const terms: string[] = [];
  const ignored: string[] = [];
  for (const word of words) {
    const stray = word.length === 1 && !/\d/.test(word);
    if (STOPWORDS.has(word) || stray) {
      if (!ignored.includes(word)) ignored.push(word);
    } else if (!terms.includes(word)) {
      terms.push(word);
    }
  }

  // Quoting makes every term a string to FTS5: a double quote inside a term
  // is escaped by doubling, though the filtering above leaves none.
  const match = terms.length === 0 ? null : terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  return { match, terms, ignored };
}

/**
 * Every chunk the FTS5 index matches, best BM25 first. `index` is the
 * chunk's position in the index (chunks.n − 1). Ties keep corpus order.
 */
export function rankByKeyword(db: DatabaseSync, match: string | null): Ranked[] {
  if (match === null) return [];
  const rows = db
    .prepare("SELECT rowid AS n, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score, rowid")
    .all(match) as Array<{ n: number; score: number }>;
  return rows.map((row, i) => ({ index: row.n - 1, score: row.score, rank: i + 1 }));
}
