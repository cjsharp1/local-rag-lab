/**
 * compare.ts — one question, all three answer modes, and a summary row.
 *
 * Run it with:  npm run compare -- "What's the fee if we bring the canoe back a day late?"
 *               npm run compare -- --id stale-1-kevlar-day-rate
 *
 * The ten-second version of the lab, in a terminal (PLAN §7): the same
 * question answered with no retrieval, with pre-retrieved chunks, and with
 * the model searching for itself, one after another, each log printed,
 * then a table of what each cost and produced:
 *
 *   requests      model requests made
 *   searches      search_docs calls, and by whom
 *   chunks        chunks placed into requests
 *   prompt tokens what Ollama counted, with the chars ÷ 4 estimate beside it
 *   peak window   the largest single request as a share of the window
 *   time          wall clock, all stages
 *   citations     cited labels that were sent / that weren't
 *   outcome       correct, declined, conflict-flagged or invented, when the
 *                 question is from the question set (by --id, or when its
 *                 text matches one exactly). Scored by code (shared/scoring.ts).
 *
 * The modes run one at a time, never in parallel: they share one GPU,
 * and timing them side by side would measure contention, not the mode.
 */

import "dotenv/config";

import { classifyAnswer } from "../shared/scoring.js";
import type { AnswerMode, Question, TurnSummary } from "../shared/types.js";
import { n } from "../server/logger.js";
import { formatRow } from "../server/log-format.js";
import { ToolServerClient } from "../server/mcp/client.js";
import { loadQuestions } from "../server/questions.js";
import { runTurn } from "../server/turn.js";
import { parseOptions } from "./cli-options.js";

const MODES: readonly AnswerMode[] = ["none", "pre-retrieved", "search-tool"];

const options = parseOptions(process.argv.slice(2), ["--id"]);
const questions = loadQuestions();
let fromSet: Question | undefined;
const id = options.extra.get("--id");
if (id) {
  fromSet = questions.find((q) => q.id === id);
  if (!fromSet) {
    console.error(`\nNo question with id "${id}". Ids are the file names in questions/.\n`);
    process.exit(1);
  }
} else {
  fromSet = questions.find((q) => q.question.trim().toLowerCase() === options.question.toLowerCase());
}
const question = fromSet?.question ?? options.question;
if (!question) {
  console.error('\nUsage:  npm run compare -- [options] "your question"   or   npm run compare -- --id <question-id>\n');
  process.exit(1);
}

const tools = new ToolServerClient();
const summaries: TurnSummary[] = [];

console.log(`\n${question}${fromSet ? `\n(question set: ${fromSet.id}, ${fromSet.category})` : ""}`);
for (const mode of MODES) {
  console.log(`\n── ${mode} ${"─".repeat(60 - mode.length)}\n`);
  const summary = await runTurn(
    { question, mode, model: options.model, strategy: options.strategy, settings: options.settings, think: options.think },
    (event) => console.log(formatRow(event, options.verbose)),
    tools,
  );
  summaries.push(summary);
  console.log(summary.error ? `\n  No answer: ${summary.error}` : `\n  Answer: ${summary.answer.trim().replace(/\n+/g, "\n          ")}`);
}
await tools.close();

// The summary row.
const rows = summaries.map((s) => {
  const outcome = fromSet && !s.error ? classifyAnswer(fromSet, s.answer).outcome : s.error ? "error" : "—";
  return [
    s.mode,
    String(s.requests),
    s.mode === "none" ? "—" : `${s.searches} (${s.mode === "pre-retrieved" ? "app" : "model"})`,
    String(s.chunksSent),
    `${n(s.promptTokens)} / ~${n(s.estimatedPromptTokens)}`,
    `${Math.round(s.peakWindowShare * 100)}%`,
    `${(s.timings.total / 1000).toFixed(1)} s`,
    `${s.citations.valid.length} / ${s.citations.invalid.length}`,
    outcome,
  ];
});
const header = ["mode", "requests", "searches", "chunks", "prompt tokens (real / est.)", "peak window", "time", "citations ok / not sent", "outcome"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

console.log(`\n── summary ${"─".repeat(54)}\n`);
console.log(`  ${line(header)}`);
for (const r of rows) console.log(`  ${line(r)}`);
if (!fromSet) console.log("\n  (outcome is scored only for questions from the question set: use --id, or its exact text)");
console.log("");
