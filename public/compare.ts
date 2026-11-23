/**
 * compare.ts — the compare view: one question, three modes, three columns, one summary.
 *
 * The request and response logs are the subject of this lab, and reading
 * three of them one after another loses the contrast (PLAN §2). Here the
 * three runs sit side by side as they stream in, sorted into columns by
 * the `mode` every log row carries, each column ending in its answer.
 * When all three are done, a summary table goes on top: model requests,
 * searches and by whom, chunks sent, prompt tokens (Ollama's count and
 * the estimate), the largest request's share of the window, time,
 * citations, and, for a question from the question set, the outcome as
 * the scorecard would score it.
 *
 * The ten-second version of the lab is one question in this view.
 */

import type { AnswerMode, AnswerOutcome, LogEvent, TurnSummary } from "../shared/types.js";
import { append, clear, el, n } from "./dom.js";
import { renderRow, type RequestDetail } from "./log.js";

const MODES: readonly AnswerMode[] = ["none", "pre-retrieved", "search-tool"];
const TITLES: Record<AnswerMode, string> = { none: "No retrieval", "pre-retrieved": "Pre-retrieved", "search-tool": "Search tool" };

export class CompareView {
  private columns = new Map<AnswerMode, { log: HTMLElement; answer: HTMLElement }>();
  private results = new Map<AnswerMode, { summary: TurnSummary; outcome?: AnswerOutcome }>();
  private summary = el("div");

  constructor(private readonly container: HTMLElement, private readonly onViewRequest: (detail: RequestDetail, label: string) => void) {}

  start(question: string): void {
    clear(this.container);
    this.columns.clear();
    this.results.clear();
    this.summary = el("div", {}, el("p", { class: "muted small" }, "Running the three modes one after another…"));
    const grid = el("div", { class: "columns" });
    for (const mode of MODES) {
      const log = el("div", { class: "log" });
      const answer = el("div", { class: "answer", hidden: true });
      grid.append(el("div", { class: "column" }, el("h3", {}, TITLES[mode]), log, answer));
      this.columns.set(mode, { log, answer });
    }
    this.container.append(el("h3", {}, question), this.summary, grid);
  }

  add(event: LogEvent): void {
    const column = event.mode ? this.columns.get(event.mode) : undefined;
    column?.log.append(renderRow(event, this.onViewRequest));
  }

  done(summary: TurnSummary, outcome?: AnswerOutcome): void {
    this.results.set(summary.mode, { summary, ...(outcome ? { outcome } : {}) });
    const column = this.columns.get(summary.mode);
    if (!column) return;
    column.answer.hidden = false;
    clear(column.answer);
    append(column.answer,
      outcome ? el("span", { class: `badge ${outcome}` }, outcome) : null,
      summary.error ? `No answer: ${summary.error}` : summary.answer.trim(),
    );
  }

  finished(): void {
    clear(this.summary);
    if (this.results.size === 0) return;
    const header = ["", "Requests", "Searches", "Chunks", "Prompt tokens (real / est.)", "Peak window", "Time", "Cites ok / unsent", "Outcome"];
    const table = el("table", {}, el("thead", {}, el("tr", {}, ...header.map((h) => el("th", {}, h)))));
    const body = el("tbody");
    for (const mode of MODES) {
      const r = this.results.get(mode);
      if (!r) continue;
      const s = r.summary;
      body.append(el("tr", {},
        el("th", {}, TITLES[mode]),
        el("td", { class: "num" }, s.requests),
        el("td", { class: "num" }, mode === "none" ? "—" : `${s.searches} (${mode === "pre-retrieved" ? "app" : "model"})`),
        el("td", { class: "num" }, s.chunksSent),
        el("td", { class: "num" }, `${n(s.promptTokens)} / ~${n(s.estimatedPromptTokens)}`),
        el("td", { class: "num" }, `${Math.round(s.peakWindowShare * 100)}%`),
        el("td", { class: "num" }, `${(s.timings.total / 1000).toFixed(1)} s`),
        el("td", { class: "num" }, `${s.citations.valid.length} / ${s.citations.invalid.length}`),
        el("td", {}, r.outcome ? el("span", { class: `badge ${r.outcome}` }, r.outcome) : s.error ? "error" : "—")));
    }
    table.append(body);
    const scored = [...this.results.values()].some((r) => r.outcome);
    append(this.summary, el("div", { class: "table-wrap" }, table),
      scored ? null : el("p", { class: "muted small" }, "Outcomes are scored only for questions from the question set."));
  }
}
