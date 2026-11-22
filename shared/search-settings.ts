/**
 * search-settings.ts — the default search settings, and the constants
 * every part of retrieval agrees on.
 *
 * The tool server applies these when a search_docs call leaves a setting
 * out, the app shows them in the retrieval panel, and the scorecard
 * records them next to every number it publishes. One copy, here, so the
 * three can't drift apart.
 *
 * Each value says where it came from. A value marked "estimate" hasn't
 * been measured on this corpus yet; the build step named beside it
 * replaces it with a measured one (PLAN conventions).
 */

import type { ChunkStrategy, SearchSettings } from "./types.js";

/**
 * Reciprocal rank fusion's k (PLAN §4.2): a chunk at rank r in a list
 * scores 1 / (k + r) from that list. 60 is the value from the paper that
 * introduced RRF and the common default; a larger k flattens the gap
 * between first place and tenth.
 */
export const RRF_K = 60;

/**
 * The search defaults.
 *
 * `floor` was set at step 5 from the vector scores of nine probe questions
 * against all three indexes (docs/verified-facts.md). It's a noise cut,
 * not a relevance test, and the measurements say why it can't be one:
 * the chunk holding the answer scored as low as 0.587, while the median
 * chunk for another question scored 0.613, and a question the corpus
 * can't answer at all still had a best match of 0.749. 0.50 sits below
 * every answer chunk seen there and removes the bottom third or so of
 * the corpus for a typical question. Step 7 checks it against all 30
 * questions.
 */
export const DEFAULT_SEARCH: SearchSettings = {
  mode: "hybrid",
  topK: 4,
  floor: 0.5,
  rerank: false,
  budgetCheck: true,
};

/** The index searched when nothing says otherwise (PLAN §4.1). */
export const DEFAULT_STRATEGY: ChunkStrategy = "heading";
