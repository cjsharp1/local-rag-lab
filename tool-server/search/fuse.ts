/**
 * fuse.ts — merges rankings by reciprocal rank fusion (RRF).
 *
 * Hybrid search runs vector search and keyword search, then has to merge
 * two rankings into one. The obvious idea, adding the scores, doesn't
 * work: a cosine similarity of 0.71 and a BM25 of −4.2 aren't on the same
 * scale, and no weighting makes them so across every query.
 *
 * RRF ignores the scores and uses only the ranks. A chunk at rank r in a
 * list earns 1 / (k + r) from it, and its fused score is the sum over
 * the lists it appears in:
 *
 *   rank 1 in both lists:            1/61 + 1/61 ≈ 0.0328
 *   rank 1 in one, absent from other: 1/61         ≈ 0.0164
 *   rank 5 in both:                  1/65 + 1/65 ≈ 0.0308
 *
 * So a chunk both searches like beats a chunk only one search loves,
 * which is the point of hybrid search. With k = 60 (RRF_K), the gap
 * between neighboring ranks is small, and agreement matters more than
 * any single first place.
 *
 * It's a few lines, and the log shows each chunk's rank in each list
 * beside its fused score, so a reader can check the arithmetic.
 */

import { RRF_K } from "../../shared/search-settings.js";
import type { Ranked } from "./vector.js";

/**
 * Fuses rankings into one, best first. A chunk missing from a list just
 * earns nothing from it. Ties keep corpus order.
 */
export function reciprocalRankFusion(lists: readonly (readonly Ranked[])[], k: number = RRF_K): Ranked[] {
  const fused = new Map<number, number>();
  for (const list of lists) {
    for (const { index, rank } of list) fused.set(index, (fused.get(index) ?? 0) + 1 / (k + rank));
  }
  return [...fused]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}
