/**
 * eval.ts — the scorecard (PLAN §8). Code scores everything; no model judges.
 *
 * Run it with:  npm run eval                    every pass; writes docs/scorecard.md and .json
 *               npm run eval -- --check         check the question set against the corpus
 *               npm run eval -- --retrieval     the retrieval pass only, printed (no chat model)
 *               npm run eval -- --limit 2       the answer and rerank passes on 2 questions,
 *                                               printed, nothing written: a harness check
 *
 * The passes:
 *
 *   retrieval  (scripts/eval-retrieval.ts) for each question and each of
 *              27 search configurations, whether the gold spans came back
 *              (hit@k, partial, MRR). Embeddings only; about a minute.
 *   answers    (scripts/eval-answers.ts) every question through all three
 *              answer modes with the chat model, each answer put into
 *              exactly one outcome, joined with whether the gold spans were
 *              in the prompt. The long one.
 *   rerank     hybrid search on the default index, reranked by the chat
 *              model, hit@k before and after.
 *
 * A full run writes docs/scorecard.md (the tables) and docs/scorecard.json
 * (every number and every answer's full text, so a reader can check any
 * classification). PLAN §8: nothing is tuned after the final run.
 *
 * --check is the fast one, and the one to run after editing any document
 * or question. It needs no model and no index.
 */

import "dotenv/config";

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolServerClient } from "../server/mcp/client.js";
import { ollamaConfig } from "../server/model/ollama.js";
import { checkQuestions, loadQuestions, QuestionFileError } from "../server/questions.js";
import { DEFAULT_PRESET, DEFAULT_SEARCH, DEFAULT_STRATEGY } from "../shared/search-settings.js";
import type { Question } from "../shared/types.js";
import { corpusHash, loadCorpus } from "../tool-server/corpus.js";
import { EmbedError } from "../tool-server/embed.js";
import { renderAnswers, runAnswerPass, runRerankPass } from "./eval-answers.js";
import { printRetrieval, renderRetrieval, runRetrievalPass } from "./eval-retrieval.js";

const DOCS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "docs");
const shortPath = (p: string) => p.replace(/\\/g, "/").split("/").slice(-2).join("/");

/** Loads and checks the question set, or exits with the problems. */
function checkedQuestions(): Question[] {
  let questions: Question[];
  try {
    questions = loadQuestions();
  } catch (error: unknown) {
    if (error instanceof QuestionFileError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const problems = checkQuestions(questions, loadCorpus());
  if (problems.length > 0) {
    console.error(`\n${questions.length} questions, ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }
  return questions;
}

function check(): void {
  const questions = checkedQuestions();
  const spans = questions.reduce((n, q) => n + q.hops.flat().length, 0);
  console.log(`\n${questions.length} questions, all spans found (${spans} gold spans in ${loadCorpus().length} documents; ` +
    "every required fact is in its own gold text, every forbidden fact is in the corpus and not in its gold text).\n");
}

/** Exits with the message for an Ollama failure; rethrows anything else. */
function exitOnEmbedError(error: unknown): never {
  if (error instanceof EmbedError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

async function retrievalOnly(): Promise<void> {
  const questions = checkedQuestions();
  const docs = loadCorpus();
  console.log("\nRetrieval pass: building 9 indexes (3 strategies × 3 presets) and searching with each question.\n");
  const report = await runRetrievalPass(questions, docs, corpusHash(docs), (line) => console.log(line)).catch(exitOnEmbedError);
  printRetrieval(report);
  console.log("\n(Printed only. A full `npm run eval` writes docs/scorecard.md.)\n");
}

async function full(limit: number | undefined): Promise<void> {
  const all = checkedQuestions();
  const questions = limit === undefined ? all : all.slice(0, limit);
  const docs = loadCorpus();
  const model = ollamaConfig().model;
  const started = performance.now();

  let retrieval;
  if (limit === undefined) {
    console.log("\n1/3  Retrieval pass: 9 indexes × 27 answerable questions × 3 search modes.\n");
    retrieval = await runRetrievalPass(questions, docs, corpusHash(docs), (line) => console.log(line)).catch(exitOnEmbedError);
    printRetrieval(retrieval);
  }

  const tools = new ToolServerClient();
  console.log(`\n2/3  Answer pass: ${questions.length} questions × 3 modes with ${model}.\n`);
  const answers = await runAnswerPass(questions, tools, model, (line) => console.log(line));
  console.log(`\n3/3  Rerank pass: ${model} reranks the top 8 of each default search.\n`);
  const reranks = await runRerankPass(questions, tools, model, (line) => console.log(line));
  await tools.close();

  const minutes = (performance.now() - started) / 60000;
  console.log(`\nAll passes: ${minutes.toFixed(1)} minutes.`);
  if (limit !== undefined || !retrieval) {
    console.log(`(--limit ${limit}: printed only, nothing written.)\n`);
    return;
  }

  const header = [
    "# Scorecard",
    "",
    "Generated by `npm run eval` on " + new Date().toISOString().slice(0, 10) + ". Do not edit by hand; rerun it. " +
      "Every answer's full text is in `scorecard.json`.",
    "",
    `Corpus ${corpusHash(docs).slice(0, 12)}…, ${docs.length} documents, ${questions.length} questions. ` +
      `Embeddings: ${process.env.EMBED_MODEL || "nomic-embed-text"}; chat: ${model}. Defaults: ${DEFAULT_STRATEGY} index (${DEFAULT_PRESET} preset), ` +
      `${DEFAULT_SEARCH.mode} search, top-k ${DEFAULT_SEARCH.topK}, floor ${DEFAULT_SEARCH.floor}. Total run time ${minutes.toFixed(1)} minutes.`,
    "",
    "**The defaults were chosen on these same questions** (PLAN §4.1); with 30 questions there is no held-out set. " +
      "The full retrieval table shows how much the choice mattered.",
    "",
  ].join("\n");
  const md = join(DOCS, "scorecard.md");
  const json = join(DOCS, "scorecard.json");
  writeFileSync(md, `${header}\n${renderRetrieval(retrieval, questions)}\n${renderAnswers(answers, reranks, questions, model)}`);
  writeFileSync(json, JSON.stringify({
    generated: new Date().toISOString(),
    model,
    defaults: { strategy: DEFAULT_STRATEGY, preset: DEFAULT_PRESET, search: DEFAULT_SEARCH },
    retrieval,
    answers,
    reranks,
  }, null, 2) + "\n");
  console.log(`Wrote ${shortPath(md)} and ${shortPath(json)}.\n`);
}

const limitAt = process.argv.indexOf("--limit");
if (process.argv.includes("--check")) {
  check();
} else if (process.argv.includes("--retrieval")) {
  await retrievalOnly();
} else if (limitAt >= 0) {
  const limit = Number(process.argv[limitAt + 1]);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("\n--limit needs a whole number of questions\n");
    process.exit(1);
  }
  await full(limit);
} else {
  await full(undefined);
}
