/**
 * search.test.ts — checks the search rules that need no model and no index.
 *
 * Run with:  npm test
 *
 * The retrieval scorecard measures how often the right chunk comes back.
 * If the ranking arithmetic or the floor rule were quietly wrong, those
 * numbers would measure the bug. So the parts of search that are pure
 * functions are pinned down here, on inputs small enough to check by hand:
 *
 *   - cosine similarity (tool-server/search/vector.ts);
 *   - reciprocal rank fusion's ordering and arithmetic (fuse.ts);
 *   - how raw text becomes a safe FTS5 query (keyword.ts);
 *   - the floor rule in each mode (search.ts, combine()): vector drops
 *     below-floor chunks, keyword ignores the floor, and hybrid drops a
 *     chunk only when it's below the floor AND keyword search missed it.
 *
 * Searching the real indexes over MCP is checked by npm run try-tools,
 * which needs Ollama to embed the queries.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import { reciprocalRankFusion } from "../tool-server/search/fuse.js";
import { buildKeywordQuery } from "../tool-server/search/keyword.js";
import { combine } from "../tool-server/search/search.js";
import { cosineSimilarity, rankByVector, type Ranked } from "../tool-server/search/vector.js";

const f32 = (...values: number[]) => Float32Array.from(values);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("cosine similarity", () => {
  test("is 1 for the same direction, 0 for perpendicular, -1 for opposite", () => {
    assert.ok(close(cosineSimilarity(f32(1, 2), f32(2, 4)), 1));
    assert.ok(close(cosineSimilarity(f32(1, 0), f32(0, 3)), 0));
    assert.ok(close(cosineSimilarity(f32(1, 1), f32(-1, -1)), -1));
  });

  test("ignores length, so unnormalized vectors work too", () => {
    assert.ok(close(cosineSimilarity(f32(3, 4), f32(6, 8)), 1));
  });

  test("is 0 for a zero vector instead of NaN", () => {
    assert.equal(cosineSimilarity(f32(0, 0), f32(1, 1)), 0);
  });

  test("rankByVector sorts best first with 1-based ranks, ties in corpus order", () => {
    const ranked = rankByVector(f32(1, 0), [f32(0, 1), f32(1, 0), f32(1, 1), f32(0, 1)]);
    assert.deepEqual(ranked.map((r) => [r.index, r.rank]), [[1, 1], [2, 2], [0, 3], [3, 4]]);
  });
});

describe("reciprocal rank fusion", () => {
  const list = (...indexes: number[]): Ranked[] => indexes.map((index, i) => ({ index, score: 0, rank: i + 1 }));

  test("scores 1/(k + rank), summed over the lists a chunk appears in", () => {
    const fused = reciprocalRankFusion([list(7, 8), list(8)], 60);
    const score = Object.fromEntries(fused.map((f) => [f.index, f.score]));
    assert.ok(close(score[8]!, 1 / 62 + 1 / 61));
    assert.ok(close(score[7]!, 1 / 61));
  });

  test("a chunk both lists like beats a chunk only one list puts first", () => {
    // 1 is first in A only; 2 is second in both.
    const fused = reciprocalRankFusion([list(1, 2, 3), list(4, 2, 5)]);
    assert.equal(fused[0]!.index, 2);
  });

  test("orders by fused score with 1-based ranks; ties keep corpus order", () => {
    const fused = reciprocalRankFusion([list(5, 3), list(3, 5)]);
    assert.deepEqual(fused.map((f) => [f.index, f.rank]), [[3, 1], [5, 2]]);
  });

  test("an empty list contributes nothing", () => {
    assert.deepEqual(reciprocalRankFusion([list(2, 1), []]).map((f) => f.index), [2, 1]);
  });
});

describe("building the keyword query", () => {
  test("quotes codes, so EP-14 is a phrase, never column syntax", () => {
    const q = buildKeywordQuery("What about EP-14?");
    assert.equal(q.match, '"about" OR "ep-14"');
    assert.deepEqual(q.ignored, ["what"]);
  });

  test("drops common words and stray letters, keeps digits", () => {
    const q = buildKeywordQuery("What's the fee after 6 p.m.?");
    assert.deepEqual(q.terms, ["fee", "after", "6"]);
    assert.deepEqual(q.ignored, ["whats", "the", "p", "m"]);
  });

  test("keeps a hyphen only inside a word, and drops duplicates", () => {
    assert.deepEqual(buildKeywordQuery("-canoe- day-use canoe").terms, ["canoe", "day-use"]);
  });

  test("returns no query when nothing searchable is left", () => {
    assert.equal(buildKeywordQuery("what is the?").match, null);
  });

  test("every query it builds is valid FTS5, whatever the input", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body); INSERT INTO t VALUES ('Entry point EP-14 needs a permit.')");
    for (const raw of ['EP-14', 'NOT "quoted" (AND) OR NEAR', 'col:value ^start * - +', "KB-7: what's allowed?", "émigré café 25 hp"]) {
      const { match } = buildKeywordQuery(raw);
      if (match) assert.doesNotThrow(() => db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(match), raw);
    }
    assert.equal((db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get(buildKeywordQuery("EP-14").match) as { n: number }).n, 1);
    db.close();
  });
});

describe("the floor rule (combine)", () => {
  // Four chunks. Vector scores: 0 → 0.9, 1 → 0.6, 2 → 0.4, 3 → 0.2.
  // Keyword search matched chunks 3 and 1, in that order.
  const vector: Ranked[] = [
    { index: 0, score: 0.9, rank: 1 },
    { index: 1, score: 0.6, rank: 2 },
    { index: 2, score: 0.4, rank: 3 },
    { index: 3, score: 0.2, rank: 4 },
  ];
  const keyword: Ranked[] = [
    { index: 3, score: -5, rank: 1 },
    { index: 1, score: -2, rank: 2 },
  ];

  test("vector mode drops chunks below the floor and reports them", () => {
    const { order, belowFloor } = combine("vector", 0.5, vector, keyword);
    assert.deepEqual(order.map((o) => o.index), [0, 1]);
    assert.deepEqual(belowFloor.map((b) => b.index), [2, 3]);
  });

  test("keyword mode ignores the floor and keeps BM25 order", () => {
    const { order, belowFloor } = combine("keyword", 0.99, vector, keyword);
    assert.deepEqual(order.map((o) => o.index), [3, 1]);
    assert.equal(belowFloor.length, 0);
    assert.equal(order[0]!.vector.score, 0.2, "vector scores still reported");
  });

  test("hybrid keeps a keyword match below the floor, and drops a vector-only one", () => {
    const { order, belowFloor } = combine("hybrid", 0.5, vector, keyword);
    assert.deepEqual(order.map((o) => o.index).sort(), [0, 1, 3], "chunk 3 (0.2, keyword #1) survives; chunk 2 doesn't");
    assert.deepEqual(belowFloor.map((b) => b.index), [2]);
  });

  test("hybrid fuses the above-floor vector list with the keyword list", () => {
    const { order } = combine("hybrid", 0.5, vector, keyword);
    // Chunk 1: vector #2 + keyword #2. Chunk 0: vector #1. Chunk 3: keyword #1 only
    // (its vector rank doesn't count, because the floor removed it from that list).
    assert.deepEqual(order.map((o) => o.index), [1, 0, 3]);
    assert.ok(close(order[0]!.fused!.score, 2 / 62));
    assert.equal(order[2]!.keyword?.rank, 1);
  });
});
