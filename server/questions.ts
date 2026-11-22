/**
 * questions.ts — loads the question set from questions/ and checks it against the corpus.
 *
 * The question set (PLAN §5.3) is 30 JSON files, one question each, with
 * the spans of corpus text that hold each answer and the facts an answer
 * must (or must not) contain. Every retrieval and answer score in the lab
 * is computed against these files, so a typo in one is a wrong number in
 * the scorecard. This file makes that hard to get away with:
 *
 *   - loadQuestions() reads and validates every file: required fields,
 *     a known category, an id that matches the file name, the right
 *     number of hops for the category.
 *   - checkQuestions() checks them against the corpus: every gold span
 *     appears in its document (ignoring case and whitespace, never
 *     digits), every required fact appears in one of the question's own
 *     gold spans, every forbidden fact appears somewhere in the corpus
 *     but in none of the gold spans, and the category counts match the
 *     plan.
 *
 * `npm run eval -- --check` runs both and prints what's wrong, if anything.
 * It needs no model and no index, so it runs in a second, and it's the
 * first thing to run after editing a document or a question.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { containsAnyWording, containsFact, containsSpan } from "../shared/scoring.js";
import type { Question, QuestionCategory } from "../shared/types.js";
import type { CorpusDoc } from "../tool-server/corpus.js";

export const QUESTIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "questions");

/** How many questions each category holds (PLAN §5.3). */
export const CATEGORY_COUNTS: Readonly<Record<QuestionCategory, number>> = {
  direct: 6,
  paraphrase: 5,
  "exact-term": 5,
  "split-context": 3,
  table: 3,
  "multi-hop": 3,
  stale: 2,
  unanswerable: 3,
};

/** A question file that isn't shaped like a question. */
export class QuestionFileError extends Error {
  override name = "QuestionFileError";
}

const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isSpan = (v: unknown): boolean => typeof v === "object" && v !== null && isString((v as { doc?: unknown }).doc) && isString((v as { text?: unknown }).text);

/** Validates one parsed file. Throws QuestionFileError naming the file and the problem. */
function validate(file: string, raw: unknown): Question {
  const fail = (problem: string): never => {
    throw new QuestionFileError(`${file}: ${problem}`);
  };
  if (typeof raw !== "object" || raw === null) fail("not a JSON object");
  const q = raw as Record<string, unknown>;

  if (!isString(q.id) || q.id !== basename(file, ".json")) fail(`"id" must equal the file name (${basename(file, ".json")})`);
  if (!isString(q.category) || !(q.category in CATEGORY_COUNTS)) fail(`"category" must be one of: ${Object.keys(CATEGORY_COUNTS).join(", ")}`);
  if (!isString(q.question)) fail(`"question" must be a non-empty string`);
  if (!isString(q.notes)) fail(`"notes" must say why the question is in the set`);
  if (!Array.isArray(q.hops) || !q.hops.every((hop) => Array.isArray(hop) && hop.length > 0 && hop.every(isSpan))) {
    fail(`"hops" must be a list of hops, each a non-empty list of { doc, text } spans`);
  }
  const fact = (f: unknown) => isString(f) || (Array.isArray(f) && f.length > 0 && f.every(isString));
  if (!Array.isArray(q.required) || !q.required.every(fact)) fail(`"required" must be a list of facts (a string, or a list of wordings)`);
  if (!Array.isArray(q.forbidden) || !q.forbidden.every(isString)) fail(`"forbidden" must be a list of strings`);

  const question = q as unknown as Question;
  const hops = question.hops.length;
  if (question.category === "unanswerable") {
    if (hops !== 0 || question.required.length !== 0) fail("an unanswerable question has no hops and no required facts");
  } else {
    if (question.category === "multi-hop" ? hops < 2 : hops !== 1) fail(`a ${question.category} question has ${question.category === "multi-hop" ? "two or more hops" : "exactly one hop"}; this one has ${hops}`);
    if (question.required.length === 0) fail("an answerable question needs at least one required fact");
  }
  if (question.category === "stale" && question.forbidden.length === 0) fail("a stale question names the stale figure in \"forbidden\"");
  return question;
}

/** Reads and validates every question file, in file-name order. */
export function loadQuestions(dir: string = QUESTIONS_DIR): Question[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error: unknown) {
      throw new QuestionFileError(`${file}: not valid JSON (${(error as Error).message})`);
    }
    return validate(file, raw);
  });
}

/** Every problem found by checking the questions against the corpus. Empty means all good. */
export function checkQuestions(questions: readonly Question[], docs: readonly CorpusDoc[]): string[] {
  const problems: string[] = [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  const corpusText = docs.map((d) => d.text).join("\n");

  const counts = Object.fromEntries(Object.keys(CATEGORY_COUNTS).map((c) => [c, 0])) as Record<QuestionCategory, number>;
  const ids = new Set<string>();

  for (const q of questions) {
    counts[q.category] += 1;
    if (ids.has(q.id)) problems.push(`${q.id}: duplicate id`);
    ids.add(q.id);

    const spans = q.hops.flat();
    q.hops.forEach((hop, h) => {
      for (const span of hop) {
        const doc = byId.get(span.doc);
        if (!doc) problems.push(`${q.id}: hop ${h + 1} names document "${span.doc}", which isn't in the corpus`);
        else if (!containsSpan(doc.text, span.text)) problems.push(`${q.id}: hop ${h + 1} span not found in ${span.doc}: "${span.text}"`);
      }
    });

    // A required fact must be in the question's own gold text; otherwise
    // the facts and the spans describe different answers.
    const goldText = spans.map((s) => s.text).join("\n");
    for (const fact of q.required) {
      if (!containsAnyWording(goldText, fact)) problems.push(`${q.id}: required fact ${JSON.stringify(fact)} isn't in any of its gold spans`);
    }
    for (const fact of q.forbidden) {
      if (!containsFact(corpusText, fact)) problems.push(`${q.id}: forbidden fact "${fact}" appears nowhere in the corpus`);
      if (containsFact(goldText, fact)) problems.push(`${q.id}: forbidden fact "${fact}" appears in its own gold spans`);
    }
  }

  for (const [category, expected] of Object.entries(CATEGORY_COUNTS)) {
    const got = counts[category as QuestionCategory];
    if (got !== expected) problems.push(`category ${category}: ${got} questions, the plan says ${expected}`);
  }
  return problems;
}
