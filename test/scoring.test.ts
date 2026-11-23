/**
 * scoring.test.ts — checks the string matching every score is built on (shared/scoring.ts).
 *
 * Run with:  npm test
 *
 * The scorecard says "correct" or "invented" by matching strings, so the
 * matching has to be right in exactly the places it's easy to get wrong:
 *
 *   - spans match across case, whitespace, curly quotes, long dashes and
 *     Markdown emphasis, but never across a different digit;
 *   - facts don't match near misses: "$35" isn't "$350", "$35.50" or
 *     "$1,350", and "6" isn't the 6 in "16";
 *   - every answer gets exactly one outcome, by the order PLAN §8 sets:
 *     correct, then conflict-flagged (stale only), then declined, then
 *     invented; and an unanswerable question is only ever declined or
 *     invented.
 *
 * The last test runs the real question set through the corpus check, so
 * `npm test` fails if a corpus edit breaks a gold span.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkQuestions, loadQuestions } from "../server/questions.js";
import { classifyAnswer, containsFact, containsSpan, normalizeForMatch, scoreRetrieval } from "../shared/scoring.js";
import type { AnswerOutcome, Question } from "../shared/types.js";
import { loadCorpus } from "../tool-server/corpus.js";

describe("normalizing and matching spans", () => {
  test("ignores case, whitespace, curly quotes, long dashes and Markdown emphasis", () => {
    assert.equal(normalizeForMatch("A group may have  at most **9 people**\n— it’s “firm”"), `a group may have at most 9 people - it's "firm"`);
    assert.ok(containsSpan("KB-4 — No cans or glass bottles", "kb-4 - no CANS or glass   bottles"));
  });

  test("never across a different digit", () => {
    assert.ok(!containsSpan("| Carbon paddle, lost or broken | $160 |", "| Carbon paddle, lost or broken | $170 |"));
  });
});

describe("matching facts in an answer", () => {
  test("finds a fact inside ordinary prose", () => {
    assert.ok(containsFact("The late fee is $35 per boat.", "$35"));
    assert.ok(containsFact("It's $35.", "$35"));
    assert.ok(containsFact("Be back by 6 PM.", "6 pm"));
  });

  test("rejects near misses on digits", () => {
    for (const answer of ["The fee is $350.", "It costs $35.50 a day.", "That's $1,350 total.", "Around $135."]) {
      assert.ok(!containsFact(answer, "$35"), answer);
    }
    assert.ok(!containsFact("Group limit is 16.", "6"));
    assert.ok(!containsFact("At most 19 people.", "9 people"));
  });

  test("allows a fact that ends in a digit to be followed by punctuation or words", () => {
    assert.ok(containsFact("Quota: 12, as of 2026.", "12"));
    assert.ok(containsFact("Portage length is 290 rods", "290"));
  });
});

describe("classifying an answer", () => {
  const answerable: Pick<Question, "category" | "required" | "forbidden"> = { category: "direct", required: ["$35"], forbidden: [] };
  const stale: Pick<Question, "category" | "required" | "forbidden"> = { category: "stale", required: ["$64"], forbidden: ["$58"] };
  const unanswerable: Pick<Question, "category" | "required" | "forbidden"> = { category: "unanswerable", required: [], forbidden: [] };
  const outcome = (q: typeof answerable, a: string): AnswerOutcome => classifyAnswer(q, a).outcome;

  test("correct needs every required fact and no forbidden one", () => {
    assert.equal(outcome(answerable, "It's $35 per boat per day."), "correct");
    assert.equal(outcome(stale, "A Northline 17 Kevlar is $64 a day."), "correct");
    const twoFacts = { category: "direct" as const, required: [["6 a.m", "6 am"], ["8 p.m", "8 pm"]], forbidden: [] };
    assert.equal(outcome(twoFacts, "Open 6 AM to 8 PM."), "correct");
    assert.equal(outcome(twoFacts, "Open from 6 AM."), "invented");
  });

  test("correct wins over a decline phrase when the answer is there", () => {
    assert.equal(outcome(answerable, "The documents don't say why, but the fee is $35."), "correct");
  });

  test("declined: a decline phrase and no forbidden fact", () => {
    assert.equal(outcome(answerable, "The documents don't mention a fee for that."), "declined");
    assert.equal(outcome(answerable, "I couldn’t find that in the provided documents."), "declined");
  });

  test("invented: a wrong figure, or a stale one, without flagging it", () => {
    assert.equal(outcome(answerable, "The fee is $25."), "invented");
    assert.equal(outcome(stale, "It's $58 a day."), "invented");
    assert.equal(outcome(stale, "The documents don't say, but I think $58."), "invented");
  });

  test("conflict-flagged: both figures, and the answer says they disagree", () => {
    assert.equal(outcome(stale, "The rate sheets disagree: $64 on one, $58 on the other."), "conflict-flagged");
    assert.equal(outcome(stale, "The 2026 rate is $64; the 2025 sheet said $58."), "conflict-flagged");
    assert.equal(outcome(stale, "It's $64, or maybe $58."), "invented", "both figures without flagging a conflict");
  });

  test("conflict-flagged only exists for stale questions", () => {
    const multiHop = { category: "multi-hop" as const, required: ["$95"], forbidden: ["$80"] };
    assert.equal(outcome(multiHop, "The sheets disagree: $95 or $80."), "invented");
  });

  test("unanswerable: declined or invented, never correct", () => {
    assert.equal(outcome(unanswerable, "The documents don't mention paddleboards."), "declined");
    assert.equal(outcome(unanswerable, "Yes, we rent paddleboards for $30 a day."), "invented");
    assert.equal(outcome(unanswerable, ""), "invented");
  });

  test("reports the evidence behind the outcome", () => {
    const c = classifyAnswer(stale, "The 2026 rate is $64; 2025 was $58.");
    assert.deepEqual(c.missing, []);
    assert.deepEqual(c.forbiddenFound, ["$58"]);
    assert.equal(c.conflictPhrase, true);
  });
});

describe("scoring retrieval (hit rules)", () => {
  const singleHop = {
    hops: [[{ doc: "rates-2026", text: "| Kestrel 15 solo canoe | $48 per day |" }, { doc: "faq", text: "the Kestrel is $48" }]],
  };
  const twoHops = {
    hops: [[{ doc: "entry-points", text: "| EP-14 | Heron Lake |" }], [{ doc: "heron", text: "at 290 rods" }]],
  };
  const chunk = (docId: string, text: string) => ({ docId, text });

  test("a hop is found when any alternative span is inside a top-k chunk", () => {
    const s = scoreRetrieval(singleHop, [chunk("x", "noise"), chunk("faq", "Yes, the Kestrel is $48 a day.")], 2);
    assert.equal(s.hit, true);
    assert.equal(s.firstGoldRank, 2);
  });

  test("past top-k is a miss, but still counts for the first gold rank", () => {
    const s = scoreRetrieval(singleHop, [chunk("x", "a"), chunk("x", "b"), chunk("rates-2026", "| Kestrel 15 solo canoe | $48 per day | $288 |")], 2);
    assert.equal(s.hit, false);
    assert.equal(s.firstGoldRank, 3);
  });

  test("the span must come from the document it names", () => {
    const s = scoreRetrieval(singleHop, [chunk("rates-2025", "| Kestrel 15 solo canoe | $48 per day |")], 4);
    assert.equal(s.hit, false);
    assert.equal(s.firstGoldRank, null);
  });

  test("a span straddling two chunks is in neither", () => {
    const s = scoreRetrieval(singleHop, [chunk("rates-2026", "| Kestrel 15 solo"), chunk("rates-2026", "canoe | $48 per day |")], 4);
    assert.equal(s.hit, false);
  });

  test("a multi-hop question needs every hop; some hops is partial", () => {
    const both = scoreRetrieval(twoHops, [chunk("heron", "The longest is at 290 rods."), chunk("entry-points", "| EP-14 | Heron Lake | tow boat |")], 4);
    assert.deepEqual([both.hit, both.partial, both.hopsFound], [true, false, 2]);
    const one = scoreRetrieval(twoHops, [chunk("heron", "The longest is at 290 rods.")], 4);
    assert.deepEqual([one.hit, one.partial, one.hopsFound], [false, true, 1]);
  });

  test("a question with no hops is never a hit", () => {
    assert.equal(scoreRetrieval({ hops: [] }, [chunk("x", "anything")], 4).hit, false);
  });
});

describe("the real question set", () => {
  test("loads 30 questions and passes the corpus check", () => {
    const questions = loadQuestions();
    assert.equal(questions.length, 30);
    assert.deepEqual(checkQuestions(questions, loadCorpus()), []);
  });
});
