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

import type { ChunkPreset, ChunkStrategy, SearchSettings } from "./types.js";

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

/**
 * The index searched when nothing says otherwise, and the size preset
 * `npm run index` builds (PLAN §4.1). Chosen once at step 7 from the
 * retrieval scorecard, by the rule in scripts/eval-retrieval.ts, and frozen.
 *
 * The rule picked heading+context / default: 21 of 27 hybrid hits at top
 * 4, tied with heading+context / large and ahead on MRR (0.724 to 0.681).
 * The plan's prior was plain `heading` (19 of 27). The difference is the
 * split-context questions: 3 of 3 with the heading path embedded, 2 of 3
 * without (docs/scorecard.md).
 */
export const DEFAULT_STRATEGY: ChunkStrategy = "heading+context";
export const DEFAULT_PRESET: ChunkPreset = "default";

/** How many top candidates the retrieval scorecard counts as kept: the default top-k. */
export const SCORECARD_K = 4;

/** MRR only credits a first gold chunk ranked this high or better. */
export const MRR_CUTOFF = 10;
