/**
 * eval-answers.ts — the answer pass and the rerank pass of the scorecard.
 *
 * Called by:  npm run eval     (with the retrieval pass; needs Ollama and the chat model)
 *
 * The answer pass runs every question through every answer mode, with
 * the lab's default settings, through the same runTurn() the browser and
 * `npm run compare` use. Each answer is put into exactly one outcome by
 * classifyAnswer() (shared/scoring.ts): correct, declined,
 * conflict-flagged or invented. No model judges anything.
 *
 * For the two retrieval modes it also records whether the gold spans were
 * actually IN the prompt: every hop found among the chunks sent (yes),
 * some hops (partial), or none (no). Joined with the outcome, that's the
 * table PLAN §8 calls the headline: it separates "retrieval missed, so the
 * model couldn't know" from "the model had it and still got it wrong",
 * two failures that look identical from outside (PLAN §1, lesson 2).
 *
 * The rerank pass is retrieval only: hybrid search on the default index,
 * then the chat model reranks the top 8, then hit@k is scored again and
 * compared with the same searches unreranked. It's separate from the
 * retrieval pass because it needs the chat model, and slow (a model
 * request per question).
 *
 * Questions and modes run one at a time: they share one GPU, and timing
 * them side by side would measure contention, not the mode.
 */

import { classifyAnswer, scoreRetrieval, type Classification } from "../shared/scoring.js";
import { DEFAULT_SEARCH, DEFAULT_STRATEGY, SCORECARD_K } from "../shared/search-settings.js";
import type { AnswerMode, AnswerOutcome, Candidate, Question, QuestionCategory, TurnSummary } from "../shared/types.js";
import { rerank } from "../server/context/rerank.js";
import type { ToolServerClient } from "../server/mcp/client.js";
import { runTurn } from "../server/turn.js";
import { indexPath, readIndex } from "../tool-server/db.js";

export const MODES: readonly AnswerMode[] = ["none", "pre-retrieved", "search-tool"];
export const OUTCOMES: readonly AnswerOutcome[] = ["correct", "declined", "conflict-flagged", "invented"];

/** Whether the gold spans were among the chunks sent to the model. */
export type GoldInPrompt = "yes" | "partial" | "no" | "n/a";

/** One question in one mode. */
export interface AnswerResult {
  questionId: string;
  category: QuestionCategory;
  mode: AnswerMode;
  /** "error" when the turn ended without an answer. */
  outcome: AnswerOutcome | "error";
  classification?: Classification;
  goldInPrompt: GoldInPrompt;
  summary: TurnSummary;
}

/** One question in the rerank pass. */
export interface RerankResult {
  questionId: string;
  category: QuestionCategory;
  hitBefore: boolean;
  hitAfter: boolean;
  /** null when the reranker's reply couldn't be read and the order was kept. */
  scores: number[] | null;
  moved: number;
  ms: number;
}

/** The ids of chunks sent, looked up in the default index for their text. */
function goldInPrompt(question: Question, summary: TurnSummary, chunkById: Map<string, { docId: string; text: string }>): GoldInPrompt {
  if (summary.mode === "none" || question.category === "unanswerable") return "n/a";
  const sent = summary.sentChunkIds.map((id) => chunkById.get(id)).filter((c): c is { docId: string; text: string } => c !== undefined);
  const score = scoreRetrieval(question, sent, Number.POSITIVE_INFINITY);
  return score.hit ? "yes" : score.partial ? "partial" : "no";
}

/** Runs every question through every mode. `log` receives one progress line per turn. */
export async function runAnswerPass(
  questions: readonly Question[],
  tools: ToolServerClient,
  model: string,
  log: (line: string) => void,
): Promise<{ results: AnswerResult[]; seconds: number }> {
  const index = readIndex(indexPath(DEFAULT_STRATEGY));
  const chunkById = new Map(index.chunks.map((c) => [c.id, c]));
  const results: AnswerResult[] = [];
  const started = performance.now();
  let done = 0;

  for (const question of questions) {
    for (const mode of MODES) {
      const summary = await runTurn(
        { question: question.question, mode, model, strategy: DEFAULT_STRATEGY, settings: { ...DEFAULT_SEARCH, rerank: false } },
        () => {}, // the scorecard keeps the summaries; the full logs are what `npm run ask` is for
        tools,
      );
      const classification = summary.error ? undefined : classifyAnswer(question, summary.answer);
      const result: AnswerResult = {
        questionId: question.id,
        category: question.category,
        mode,
        outcome: classification?.outcome ?? "error",
        ...(classification ? { classification } : {}),
        goldInPrompt: goldInPrompt(question, summary, chunkById),
        summary,
      };
      results.push(result);
      done += 1;
      log(`  ${String(done).padStart(3)}/${questions.length * MODES.length}  ${mode.padEnd(14)} ${question.id.padEnd(44)} ${result.outcome.padEnd(16)} ` +
        `${(summary.timings.total / 1000).toFixed(1)} s`);
    }
  }
  return { results, seconds: (performance.now() - started) / 1000 };
}

/**
 * The rerank pass: for each answerable question, the default search's
 * candidates (via search_docs), hit@k as searched, then reranked by the
 * chat model, hit@k again.
 */
export async function runRerankPass(
  questions: readonly Question[],
  tools: ToolServerClient,
  model: string,
  log: (line: string) => void,
): Promise<{ results: RerankResult[]; seconds: number }> {
  const results: RerankResult[] = [];
  const started = performance.now();
  const answerable = questions.filter((q) => q.category !== "unanswerable");
  for (const [i, question] of answerable.entries()) {
    const { result } = await tools.searchDocs({ query: question.question, strategy: DEFAULT_STRATEGY, mode: DEFAULT_SEARCH.mode, floor: DEFAULT_SEARCH.floor });
    const before: Candidate[] = result.candidates;
    const outcome = await rerank(model, question.question, before);
    const r: RerankResult = {
      questionId: question.id,
      category: question.category,
      hitBefore: scoreRetrieval(question, before, SCORECARD_K).hit,
      hitAfter: scoreRetrieval(question, outcome.candidates, SCORECARD_K).hit,
      scores: outcome.scores,
      moved: outcome.moved,
      ms: outcome.ms,
    };
    results.push(r);
    log(`  ${String(i + 1).padStart(3)}/${answerable.length}  ${question.id.padEnd(44)} hit ${r.hitBefore ? "yes" : "no "} → ${r.hitAfter ? "yes" : "no "}` +
      `${r.scores ? "" : "  (reply unreadable, order kept)"}  ${(r.ms / 1000).toFixed(1)} s`);
  }
  return { results, seconds: (performance.now() - started) / 1000 };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const count = <T>(items: readonly T[], test: (item: T) => boolean) => items.filter(test).length;
const mean = (values: readonly number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/** The answer and rerank sections of docs/scorecard.md. */
export function renderAnswers(
  answers: { results: AnswerResult[]; seconds: number },
  reranks: { results: RerankResult[]; seconds: number },
  questions: readonly Question[],
  model: string,
): string {
  const out: string[] = [];
  const results = answers.results;
  const byMode = (mode: AnswerMode) => results.filter((r) => r.mode === mode);

  out.push(
    "## Answer pass",
    "",
    `${questions.length} questions × ${MODES.length} modes with ${model}, default settings (${DEFAULT_STRATEGY} index, ${DEFAULT_SEARCH.mode} search, ` +
      `top-k ${DEFAULT_SEARCH.topK}, floor ${DEFAULT_SEARCH.floor}, rerank off, thinking off, temperature 0). ` +
      `Run time: **${(answers.seconds / 60).toFixed(1)} minutes** on this machine. Each answer gets exactly one outcome (shared/scoring.ts): ` +
      "**correct** (every required fact, no forbidden one), **declined** (says the documents don't say), " +
      "**conflict-flagged** (stale questions: both figures, conflict noted), **invented** (anything else).",
    "",
    "### By mode",
    "",
    "| Mode | correct | declined | conflict-flagged | invented | error | citations valid / not sent | avg requests | avg prompt tokens | avg time |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const mode of MODES) {
    const rs = byMode(mode);
    const valid = rs.reduce((n, r) => n + r.summary.citations.valid.length, 0);
    const invalid = rs.reduce((n, r) => n + r.summary.citations.invalid.length, 0);
    out.push(`| ${mode} | ${OUTCOMES.map((o) => count(rs, (r) => r.outcome === o)).join(" | ")} | ${count(rs, (r) => r.outcome === "error")} | ${valid} / ${invalid} | ` +
      `${mean(rs.map((r) => r.summary.requests)).toFixed(1)} | ${Math.round(mean(rs.map((r) => r.summary.promptTokens))).toLocaleString("en-US")} | ` +
      `${(mean(rs.map((r) => r.summary.timings.total)) / 1000).toFixed(1)} s |`);
  }

  // The headline: retrieval joined with answers.
  out.push("", "### Retrieval joined with answers", "",
    "For the two retrieval modes: were the gold spans in the prompt (every hop among the chunks sent, some hops, or none), and what did the model do with it? " +
    "The 3 unanswerable questions have no gold spans and are left out.", "",
    "| Mode | Gold in prompt | questions | correct | declined | conflict-flagged | invented |", "|---|---|---|---|---|---|---|");
  for (const mode of ["pre-retrieved", "search-tool"] as const) {
    for (const gold of ["yes", "partial", "no"] as const) {
      const rs = byMode(mode).filter((r) => r.goldInPrompt === gold);
      if (rs.length === 0) continue;
      out.push(`| ${mode} | ${gold} | ${rs.length} | ${OUTCOMES.map((o) => count(rs, (r) => r.outcome === o)).join(" | ")} |`);
    }
  }

  const categories = [...new Set(questions.map((q) => q.category))];
  out.push("", "### Correct answers by category", "", `| Category | questions | ${MODES.join(" | ")} |`, `|---|---|${MODES.map(() => "---").join("|")}|`);
  for (const category of categories) {
    const total = count(questions, (q) => q.category === category);
    const good = (mode: AnswerMode) => count(byMode(mode), (r) => r.category === category && (category === "unanswerable" ? r.outcome === "declined" : r.outcome === "correct"));
    out.push(`| ${category}${category === "unanswerable" ? " (declined is right)" : ""} | ${total} | ${MODES.map((m) => good(m)).join(" | ")} |`);
  }

  const st = byMode("search-tool");
  out.push("", "### Search-tool mode: what the model chose", "",
    `- Answered without searching: **${count(st, (r) => r.summary.searches === 0)}** of ${st.length}.`,
    `- Searched once: ${count(st, (r) => r.summary.searches === 1)}; twice or more: ${count(st, (r) => r.summary.searches >= 2)}.`,
    `- Stopped at the request limit without answering: ${count(st, (r) => r.outcome === "error")}.`,
  );

  out.push("", "### Every answer, by question", "", `| Question | ${MODES.join(" | ")} |`, `|---|${MODES.map(() => "---").join("|")}|`);
  for (const q of questions) {
    const cells = MODES.map((mode) => {
      const r = results.find((x) => x.questionId === q.id && x.mode === mode)!;
      const gold = r.goldInPrompt === "n/a" ? "" : ` (gold ${r.goldInPrompt})`;
      const searches = mode === "search-tool" ? `, ${r.summary.searches} search${r.summary.searches === 1 ? "" : "es"}` : "";
      return `${r.outcome}${gold}${searches}`;
    });
    out.push(`| ${q.id} | ${cells.join(" | ")} |`);
  }

  // Every answer the phrase heuristics classified, so a reader can check them.
  const heuristic = results.filter((r) => r.outcome === "declined" || r.outcome === "conflict-flagged");
  out.push("", "### Answers classified by phrase matching (a heuristic)", "",
    `The decline and conflict phrase lists (shared/scoring.ts) were frozen at step 6, before any answer existed. ` +
    `These ${heuristic.length} answers were classified by them; check any you doubt.`, "");
  for (const r of heuristic) {
    out.push(`- **${r.questionId}**, ${r.mode} → ${r.outcome}: ${JSON.stringify(r.summary.answer.trim().replace(/\s+/g, " ").slice(0, 300))}`);
  }

  // Rerank.
  const rr = reranks.results;
  const unreadable = count(rr, (r) => r.scores === null);
  out.push("", "## Rerank pass", "",
    `${rr.length} answerable questions, ${DEFAULT_STRATEGY} index, ${DEFAULT_SEARCH.mode} search: hit@${SCORECARD_K} as searched, then after ${model} reranked the top 8 ` +
      `(server/context/rerank.ts). Run time: **${(reranks.seconds / 60).toFixed(1)} minutes**; the rerank request averaged ` +
      `**${(mean(rr.map((r) => r.ms)) / 1000).toFixed(1)} s** per search.`, "",
    `| | hit@${SCORECARD_K} |`, "|---|---|",
    `| as searched | ${count(rr, (r) => r.hitBefore)}/${rr.length} |`,
    `| after rerank | ${count(rr, (r) => r.hitAfter)}/${rr.length} |`,
    `| gained (miss → hit) | ${count(rr, (r) => !r.hitBefore && r.hitAfter)} |`,
    `| lost (hit → miss) | ${count(rr, (r) => r.hitBefore && !r.hitAfter)} |`,
    `| reply unreadable, order kept | ${unreadable} |`, "");
  const changed = rr.filter((r) => r.hitBefore !== r.hitAfter);
  if (changed.length > 0) {
    out.push("Questions whose hit changed:", "", ...changed.map((r) => `- ${r.questionId}: ${r.hitBefore ? "hit → miss" : "miss → hit"}`), "");
  }
  return out.join("\n");
}
