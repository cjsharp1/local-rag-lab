/**
 * context.test.ts — checks how chunks are chosen and written into a request.
 *
 * Run with:  npm test
 *
 * These two files decide what the model actually reads, so their rules
 * are pinned down here (PLAN §8, tests):
 *
 *   - the budget (server/context/budget.ts) keeps chunks in rank order,
 *     drops with the right reason (past-top-k, over-budget), never skips
 *     ahead to a smaller chunk, and ignores the budget when the check is
 *     off;
 *   - the remaining budget shrinks as a request grows, so several tool
 *     results can't each fit and together overflow the window;
 *   - the assembler (server/context/assemble.ts) records spans whose text
 *     is exactly each chunk's text, in the order sent;
 *   - cited labels are read out of an answer exactly once each;
 *   - the reranker (server/context/rerank.ts) accepts only a well-formed
 *     reply and reorders the scored top without touching the rest.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Candidate } from "../shared/types.js";
import { chunkCost, chunkHeader, citedLabels, preRetrievedMessage, toolResultMessage } from "../server/context/assemble.js";
import { chunkBudget, estimateMessages, selectChunks, TOKENS_PER_MESSAGE } from "../server/context/budget.js";
import { applyScores, parseScores, rerankRequest } from "../server/context/rerank.js";

/** A candidate whose text is `tokens` × 4 characters. */
function candidate(id: string, tokens: number): Candidate {
  return {
    chunkId: `doc#${id}`, label: `[doc#${id}]`, docId: "doc", headingPath: ["Doc", id], text: "x".repeat(tokens * 4),
    estimatedTokens: tokens, vectorScore: 0.7, start: 0, end: tokens * 4,
  };
}

describe("selecting chunks under top-k and the budget", () => {
  const cost = (c: Candidate) => c.estimatedTokens;
  const list = [candidate("a", 100), candidate("b", 300), candidate("c", 50), candidate("d", 100), candidate("e", 100)];

  test("keeps the top k in rank order; the rest are past-top-k", () => {
    const s = selectChunks(list, { topK: 3, budget: 10_000, budgetCheck: true }, cost);
    assert.deepEqual(s.kept.map((c) => c.chunkId), ["doc#a", "doc#b", "doc#c"]);
    assert.deepEqual(s.dropped.map((d) => [d.candidate.chunkId, d.reason]), [["doc#d", "past-top-k"], ["doc#e", "past-top-k"]]);
    assert.equal(s.keptTokens, 450);
  });

  test("once one doesn't fit, it and the rest of the top k are over-budget, even if a later one is small", () => {
    const s = selectChunks(list, { topK: 4, budget: 350, budgetCheck: true }, cost);
    assert.deepEqual(s.kept.map((c) => c.chunkId), ["doc#a"], "b (300) doesn't fit after a (100); c (50) would, but isn't skipped to");
    assert.deepEqual(s.dropped.map((d) => [d.candidate.chunkId, d.reason]), [
      ["doc#b", "over-budget"], ["doc#c", "over-budget"], ["doc#d", "over-budget"], ["doc#e", "past-top-k"],
    ]);
  });

  test("with the budget check off, top-k is the only limit", () => {
    const s = selectChunks(list, { topK: 4, budget: 10, budgetCheck: false }, cost);
    assert.equal(s.kept.length, 4);
    assert.ok(s.dropped.every((d) => d.reason === "past-top-k"));
  });

  test("a zero budget keeps nothing", () => {
    assert.equal(selectChunks(list, { topK: 4, budget: 0, budgetCheck: true }, cost).kept.length, 0);
  });
});

describe("the chunk budget", () => {
  test("is the window minus the reply reserve and everything else, never negative", () => {
    assert.equal(chunkBudget({ numCtx: 8192, replyReserve: 1024, otherTokens: 200 }), 6968);
    assert.equal(chunkBudget({ numCtx: 1000, replyReserve: 1024, otherTokens: 200 }), 0);
  });

  test("shrinks as tool results pile up in the request", () => {
    const base = ["system prompt", "question"];
    const first = toolResultMessage("q1", [candidate("a", 500)]).content;
    const second = toolResultMessage("q2", [candidate("b", 500)]).content;
    const budgets = [base, [...base, first], [...base, first, second]].map((messages) =>
      chunkBudget({ numCtx: 8192, replyReserve: 1024, otherTokens: estimateMessages(messages) }));
    assert.ok(budgets[0]! > budgets[1]! && budgets[1]! > budgets[2]!, budgets.join(" > "));
    assert.ok(budgets[0]! - budgets[2]! >= 1000, "two 500-token results cost at least 1,000 tokens of budget");
  });

  test("counts a per-message template overhead", () => {
    assert.equal(estimateMessages(["abcd", "abcd"]), 2 + 2 * TOKENS_PER_MESSAGE);
  });
});

describe("assembling the request", () => {
  const chunks = [candidate("first", 10), { ...candidate("second", 5), headingPath: [] }];

  test("pre-retrieved: documents first, question last, and every span is the chunk's own text", () => {
    const { content, spans } = preRetrievedMessage("What is it?", chunks);
    assert.ok(content.startsWith("Documents:\n\n") && content.endsWith("Question: What is it?"));
    assert.deepEqual(spans.map((s) => s.chunkId), ["doc#first", "doc#second"]);
    spans.forEach((s, i) => assert.equal(content.slice(s.start, s.end), chunks[i]!.text));
  });

  test("each chunk is written under its label and heading path, or its document id when it has none", () => {
    const { content } = preRetrievedMessage("q", chunks);
    assert.ok(content.includes("[doc#first] (Doc > first)\n"));
    assert.ok(content.includes("[doc#second] (doc)\n"));
    assert.equal(chunkHeader(chunks[1]!), "[doc#second] (doc)");
  });

  test("no chunks: says so instead of an empty block", () => {
    assert.equal(preRetrievedMessage("q", []).content, "Documents: none were found for this question.\n\nQuestion: q");
    assert.equal(toolResultMessage("q", []).spans.length, 0);
  });

  test("tool results record spans the same way", () => {
    const { content, spans } = toolResultMessage("late fee", chunks);
    assert.ok(content.startsWith('Search results for "late fee":'));
    spans.forEach((s, i) => assert.equal(content.slice(s.start, s.end), chunks[i]!.text));
  });

  test("a chunk's cost covers its header as well as its text", () => {
    assert.ok(chunkCost(chunks[0]!) > chunks[0]!.estimatedTokens);
  });
});

describe("reranking", () => {
  const list = ["a", "b", "c", "d", "e"].map((id) => candidate(id, 10));

  test("reads exactly n integer scores from 0 to 3", () => {
    assert.deepEqual(parseScores('{"scores":[3,0,2]}', 3), [3, 0, 2]);
  });

  test("rejects a reply of the wrong length, out of range, not integers, or not JSON", () => {
    for (const bad of ['{"scores":[3,0]}', '{"scores":[3,0,4]}', '{"scores":[3,0,1.5]}', '{"scores":"3,0,1"}', "3, 0, 1", ""]) {
      assert.equal(parseScores(bad, 3), null, bad);
    }
  });

  test("reorders the scored top by score, ties in search order, and leaves the rest behind", () => {
    const out = applyScores(list, [1, 3, 1]);
    assert.deepEqual(out.map((c) => c.chunkId), ["doc#b", "doc#a", "doc#c", "doc#d", "doc#e"]);
    assert.deepEqual(out.slice(0, 3).map((c) => [c.rerankScore, c.rerankRank]), [[3, 1], [1, 2], [1, 3]]);
    assert.equal(out[3]!.rerankScore, undefined, "unscored candidates carry no rerank score");
  });

  test("the rerank request carries a format and no tools", () => {
    const request = rerankRequest("qwen3.5:4b", "q?", list.slice(0, 2));
    assert.ok(request.format !== undefined && request.tools === undefined);
    assert.ok(request.messages[1]!.content.includes("Passage 2:"));
  });
});

describe("reading citations", () => {
  test("finds each [doc#section] label once, in order, lowercased", () => {
    const answer = "It's $35 [Rental-Agreement#late-returns]. Waived in storms [rental-agreement#late-returns-4] [rental-agreement#late-returns].";
    assert.deepEqual(citedLabels(answer), ["[rental-agreement#late-returns]", "[rental-agreement#late-returns-4]"]);
  });

  test("ignores brackets that aren't labels", () => {
    assert.deepEqual(citedLabels("See [note] and [1] and [a#]"), []);
  });
});
