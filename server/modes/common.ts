/**
 * common.ts — what every answer mode does the same way: call the model, search, log, sum up.
 *
 * The three modes (none.ts, pre-retrieved.ts, search-tool.ts) differ only
 * in who searches and where the chunks go. Everything else lives here, in
 * a Turn object that one mode run owns:
 *
 *   callModel()  sends a request and logs it twice: going out, with the
 *                estimated prompt tokens and the span of every chunk inside
 *                it; coming back, with the real token count, the share of
 *                the window used, and the time. It also runs the DROP
 *                DETECTOR: when Ollama reports far fewer prompt tokens than
 *                the messages contain, it silently dropped some, and the
 *                log says so as an error.
 *   search()     calls search_docs over MCP, reranks the top candidates if
 *                rerank is on (context/rerank.ts), then picks what fits
 *                (context/budget.ts) and logs every step: the search, what
 *                the floor removed, the rerank's before and after, what fell
 *                past top-k, each chunk that didn't fit the budget, and what
 *                was kept.
 *   finish()     checks every cited label against the labels actually sent,
 *                logs the turn's stage timings, and returns a TurnSummary.
 *
 * The search row's `actor` is the lab's central contrast: `app` when the
 * app searched before the model ran (pre-retrieved), `model` when the
 * model asked for it (search-tool). Same tool, same code, different
 * decision-maker.
 */

import { estimateTokens } from "../../shared/chunk.js";
import type { AnswerMode, Candidate, ChunkSpan, ChunkStrategy, LogActor, SearchResult, SearchSettings, TurnSummary } from "../../shared/types.js";
import { chunkBudget, estimateMessages, selectChunks, type Selection } from "../context/budget.js";
import { chunkCost, citedLabels } from "../context/assemble.js";
import { rerank, RERANK_N } from "../context/rerank.js";
import { n, truncate, type Logger } from "../logger.js";
import type { ToolServerClient } from "../mcp/client.js";
import { chat, ms, NUM_PREDICT, ollamaConfig, tokensPerSecond, type ChatRequest, type ChatResponse, type OllamaMessage } from "../model/ollama.js";

/** What a reader asked for: one question, one mode, the panel's settings. */
export interface TurnRequest {
  question: string;
  mode: AnswerMode;
  model: string;
  strategy: ChunkStrategy;
  settings: SearchSettings;
  /** Let the model think before answering. Slow by design; off by default. */
  think?: boolean;
}

/**
 * Below this share of the estimated message tokens, Ollama dropped
 * messages. Generous because the estimate is rough, and a real drop
 * removes whole messages, so it's never subtle. It compares against the
 * message text only, never the tool definitions: chat templates move those
 * around (llama3.2:3b's drops them once a tool result is the last
 * message), so a prompt can shrink legitimately and still have lost nothing.
 */
const DROP_RATIO = 0.6;

/** At or above this share of the window, warn that it's nearly full. */
const WINDOW_WARN_RATIO = 0.9;

const percent = (share: number) => `${Math.round(share * 100)}%`;
const seconds = (millis: number) => `${(millis / 1000).toFixed(1)} s`;

export class Turn {
  readonly numCtx = ollamaConfig().numCtx;
  private readonly started = performance.now();
  private readonly sentLabels = new Set<string>();
  readonly summary: TurnSummary;

  constructor(readonly request: TurnRequest, readonly logger: Logger, readonly tools: ToolServerClient) {
    this.summary = {
      mode: request.mode,
      model: request.model,
      question: request.question,
      answer: "",
      requests: 0,
      searches: 0,
      queries: [],
      promptTokens: 0,
      estimatedPromptTokens: 0,
      responseTokens: 0,
      peakWindowShare: 0,
      chunksSent: 0,
      citations: { valid: [], invalid: [] },
      sentChunkIds: [],
      droppedMessages: false,
      timings: { total: 0 },
    };
  }

  /** The opening row: what this turn will do, so every transcript explains itself. */
  start(): void {
    const r = this.request;
    const search = r.mode === "none" ? "no retrieval" : `${r.settings.mode} search of the ${r.strategy} index, top-k ${r.settings.topK}, floor ${r.settings.floor}` +
      (r.settings.budgetCheck ? "" : ", budget check OFF");
    this.logger.info(`New turn · ${r.mode} · ${r.model} · ${search}${r.think ? " · thinking ON (slow)" : ""}`, { ...r, numCtx: this.numCtx }, {
      actor: "user", because: "a question was asked",
    });
  }

  /** Estimated prompt tokens of a request: messages plus tool definitions. */
  estimateRequest(messages: readonly OllamaMessage[], tools?: unknown): number {
    return estimateMessages(messages.map((m) => m.content)) + (tools ? estimateTokens(JSON.stringify(tools)) : 0);
  }

  /** Sends one request, logging it out and back, and runs the drop detector. */
  async callModel(request: ChatRequest, spans: ChunkSpan[], because: string): Promise<ChatResponse> {
    const i = ++this.summary.requests;
    this.logger.iteration = i;
    const estimate = this.estimateRequest(request.messages, request.tools);
    const messageEstimate = estimateMessages(request.messages.map((m) => m.content));
    for (const span of spans) this.sentLabels.add(span.label);

    this.logger.model(
      `Model request ${i} · ~${n(estimate)} prompt tokens (estimate) · ${spans.length} chunk${spans.length === 1 ? "" : "s"} · ` +
        (request.tools ? "search_docs offered" : "no tools"),
      { request, chunkSpans: spans },
      { direction: "out", actor: "app", because },
    );

    const response = await chat(request);
    const prompt = response.prompt_eval_count ?? 0;
    const share = prompt / this.numCtx;
    const load = ms(response.load_duration);
    const generate = ms(response.total_duration) - load;

    this.summary.promptTokens += prompt;
    this.summary.estimatedPromptTokens += estimate;
    this.summary.responseTokens += response.eval_count ?? 0;
    this.summary.peakWindowShare = Math.max(this.summary.peakWindowShare, share);
    this.summary.timings.generate = (this.summary.timings.generate ?? 0) + generate;
    this.summary.timings.generateLoad = (this.summary.timings.generateLoad ?? 0) + load;

    const asked = response.message.tool_calls?.length ? ` · asked for ${response.message.tool_calls.map((c) => c.function.name).join(", ")}` : "";
    this.logger.model(
      `Response ${i} · ${n(prompt)} prompt tokens (estimated ${n(estimate)}) · ${percent(share)} of window · ` +
        `${n(response.eval_count ?? 0)} reply tokens · ${tokensPerSecond(response) ?? "?"} tok/s · ${seconds(generate)}` +
        (load > 1000 ? ` · model load ${seconds(load)}` : "") + asked,
      response,
      { direction: "in", actor: "model" },
    );
    if (response.message.thinking) {
      this.logger.model(`The model thought for ${n(response.message.thinking.length)} characters before answering`, { thinking: response.message.thinking }, {
        actor: "model", because: "thinking is on",
      });
    }

    // The drop detector. Ollama never reports a dropped message; the only
    // trace is a prompt smaller than the text that was sent.
    if (messageEstimate > 500 && prompt < messageEstimate * DROP_RATIO) {
      this.summary.droppedMessages = true;
      this.logger.error(
        `Ollama dropped messages to fit the ${n(this.numCtx)}-token window: the model saw ${n(prompt)} tokens, the messages alone are about ${n(messageEstimate)}`,
        { promptTokens: prompt, estimatedMessageTokens: messageEstimate, numCtx: this.numCtx },
        { because: "the request outgrew num_ctx, so the model can no longer see part of it, possibly the retrieved chunks" },
      );
    } else if (share >= WINDOW_WARN_RATIO) {
      this.logger.warn(`Context window nearly full: ${n(prompt)} of ${n(this.numCtx)} tokens`, undefined, { because: "past the window, Ollama silently drops messages" });
    }
    if (response.done_reason === "length") {
      this.logger.warn(`The reply was cut off at ${n(NUM_PREDICT)} tokens`, undefined, { because: "num_predict caps every reply" });
    }
    return response;
  }

  /** The chunk budget left, given the request so far (estimated tokens). */
  budgetFor(messages: readonly OllamaMessage[], tools?: unknown): number {
    return chunkBudget({ numCtx: this.numCtx, replyReserve: NUM_PREDICT, otherTokens: this.estimateRequest(messages, tools) });
  }

  /**
   * One search_docs call, then selection. Logs, in order: the search, the
   * floor's summary, the chunks past top-k (one row, listing them), each
   * chunk over the budget (a row each), and what was kept.
   */
  async search(query: string, actor: Extract<LogActor, "app" | "model">, budget: number): Promise<{ result: SearchResult; selection: Selection }> {
    const r = this.request;
    const { result } = await this.tools.searchDocs({ query, strategy: r.strategy, mode: r.settings.mode, floor: r.settings.floor });
    this.summary.searches += 1;
    this.summary.queries.push(query);
    const t = this.summary.timings;
    t.embed = (t.embed ?? 0) + result.timings.embed;
    t.embedLoad = (t.embedLoad ?? 0) + result.timings.embedLoad;
    t.search = (t.search ?? 0) + result.timings.search;

    this.logger.retrieval(
      `Search: "${truncate(query, 70)}" · ${result.mode} · ${result.strategy} · ${result.candidates.length} candidates`,
      result,
      { actor, direction: "call", because: actor === "app" ? "pre-retrieved mode searches before the model runs" : "the model called search_docs" },
    );
    if (result.indexStale) this.logger.warn(`The ${result.strategy} index is stale: it was built from a different corpus. Run npm run index.`);
    if (result.keywordQuery === null) this.logger.retrieval("Keyword search had nothing to search for: every word was a common word", result.ignoredWords);
    if (result.belowFloor.count > 0) {
      const best = result.belowFloor.best;
      this.logger.retrieval(
        `${result.belowFloor.count} chunks below the floor (${result.floor})` + (best ? ` · best of them ${best.vectorScore.toFixed(3)}, ${best.chunkId}` : ""),
        result.belowFloor,
        { because: result.mode === "hybrid" ? "vector similarity under the floor and no keyword match" : "vector similarity under the floor" },
      );
    }

    // The optional rerank stage (PLAN §4.4): the chat model re-scores the
    // top candidates against the reader's QUESTION (not the model's query in
    // search-tool mode: the question is what the answer has to serve).
    let ranked = result.candidates;
    if (r.settings.rerank && ranked.length > 0) {
      const outcome = await rerank(r.model, r.question, ranked);
      t.rerank = (t.rerank ?? 0) + outcome.ms;
      t.generateLoad = (t.generateLoad ?? 0) + outcome.loadMs;
      const top = Math.min(RERANK_N, ranked.length);
      if (outcome.scores) {
        ranked = outcome.candidates;
        this.logger.retrieval(
          `Reranked the top ${top} · order changed for ${outcome.moved} · ${seconds(outcome.ms)} (slow by design)`,
          { before: result.candidates.slice(0, top).map((c) => c.chunkId), after: ranked.slice(0, top).map((c) => `${c.chunkId} (${c.rerankScore})`), request: outcome.request, response: outcome.response },
          { because: "rerank is on" },
        );
      } else {
        this.logger.warn(`The reranker's reply couldn't be read, so the search order was kept · ${seconds(outcome.ms)}`,
          { reply: outcome.response.message.content, request: outcome.request }, { actor: "model", because: "it must be exactly one score from 0 to 3 per passage" });
      }
    }

    const selection = selectChunks(ranked, { topK: r.settings.topK, budget, budgetCheck: r.settings.budgetCheck }, chunkCost);
    const pastTopK = selection.dropped.filter((d) => d.reason === "past-top-k");
    if (pastTopK.length > 0) {
      this.logger.retrieval(`${pastTopK.length} more candidates past top-${r.settings.topK}, not sent`,
        pastTopK.map((d) => ({ chunkId: d.candidate.chunkId, reason: d.reason, tokens: d.tokens })), { because: "only the top k are sent" });
    }
    for (const d of selection.dropped.filter((x) => x.reason === "over-budget")) {
      this.logger.retrieval(`Dropped ${d.candidate.chunkId} · over-budget · ~${n(d.tokens)} tokens`, d, { because: "it didn't fit the chunk budget" });
    }
    const share = selection.budget > 0 ? selection.keptTokens / selection.budget : 0;
    this.logger.retrieval(
      `Kept ${selection.kept.length} chunk${selection.kept.length === 1 ? "" : "s"} · ~${n(selection.keptTokens)} tokens (estimate) · ` +
        `${percent(share)} of a ${n(selection.budget)}-token chunk budget` + (r.settings.budgetCheck ? "" : " (budget check off)"),
      selection.kept.map((c) => c.chunkId),
    );
    this.summary.chunksSent += selection.kept.length;
    this.summary.sentChunkIds.push(...selection.kept.map((c) => c.chunkId));
    return { result, selection };
  }

  /** Spans for the chunks written into message `messageIndex`. */
  static spans(messageIndex: number, spans: ReadonlyArray<{ chunkId: string; label: string; start: number; end: number }>): ChunkSpan[] {
    return spans.map((s) => ({ ...s, messageIndex }));
  }

  /** Ends the turn with an answer: checks citations, logs timings, returns the summary. */
  finish(answer: string): TurnSummary {
    this.logger.iteration = undefined;
    this.summary.answer = answer;
    const cited = citedLabels(answer);
    for (const label of cited) {
      if (this.sentLabels.has(label)) this.summary.citations.valid.push(label);
      else {
        this.summary.citations.invalid.push(label);
        this.logger.warn(`Citation ${label} is not in any request`, { label, sent: [...this.sentLabels] }, {
          actor: "model", because: "the model cited a chunk it was never shown",
        });
      }
    }
    if (cited.length === 0 && this.request.mode !== "none") {
      this.logger.info("The answer cites no chunks", undefined, { actor: "model", because: "the system prompt asks for a citation after each fact" });
    }
    return this.complete();
  }

  /** Ends the turn without an answer. */
  fail(message: string, detail?: unknown): TurnSummary {
    this.logger.iteration = undefined;
    this.logger.error(message, detail);
    this.summary.error = message;
    return this.complete();
  }

  private complete(): TurnSummary {
    const t = this.summary.timings;
    t.total = performance.now() - this.started;
    const stages = [
      t.embed !== undefined ? `embed ${seconds(t.embed)}` : "",
      t.search !== undefined ? `search ${seconds(t.search)}` : "",
      t.generate !== undefined ? `generate ${seconds(t.generate)}` : "",
      (t.generateLoad ?? 0) + (t.embedLoad ?? 0) > 1000 ? `model load ${seconds((t.generateLoad ?? 0) + (t.embedLoad ?? 0))}` : "",
    ].filter(Boolean).join(", ");
    const s = this.summary;
    this.logger.info(
      `Turn complete · ${s.requests} model request${s.requests === 1 ? "" : "s"} · ${s.searches} search${s.searches === 1 ? "" : "es"} · ` +
        `${s.chunksSent} chunks sent · ${seconds(t.total)}${stages ? ` (${stages})` : ""}`,
      s,
    );
    return s;
  }
}

/** Candidates' ids, for log details. */
export function ids(chunks: readonly Candidate[]): string[] {
  return chunks.map((c) => c.chunkId);
}
