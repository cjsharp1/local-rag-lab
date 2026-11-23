/**
 * app.ts — wires the page together: settings, Ask, Compare, the tabs, the map.
 *
 * On load it asks the server for everything the page draws from
 * (GET /api/meta: models, defaults, presets, index status, documents and
 * the question set) and fills the controls with the lab's defaults, so an
 * untouched page runs exactly what `npm run ask` and the scorecard run.
 *
 * Asking streams the answer's log into the activity log, row by row
 * (POST /api/ask); Compare streams all three modes into the compare view
 * (POST /api/compare). Every row also passes through the search tracker,
 * which keeps the candidate table and the map in step with the last
 * search. Nothing on the page is computed independently of the log: the
 * table, the map's query marker and the request view are all built from
 * the rows the server sent, so the page can only show what happened.
 *
 * A banner says so when an index is stale, or Ollama or the tool server
 * can't be reached, with the fix.
 */

import type { AnswerMode, AnswerOutcome, AskBody, ChunkStrategy, MapResponse, MetaResponse, StreamEvent, TurnSummary } from "../shared/types.js";
import { getJson, postStream } from "./api.js";
import { CompareView } from "./compare.js";
import { $, append, clear, el } from "./dom.js";
import { LogView, type RequestDetail } from "./log.js";
import { MapView } from "./map.js";
import { showRequest } from "./request-view.js";
import { readSettings, renderCandidates, SearchTracker } from "./retrieval.js";

let meta: MetaResponse | undefined;
let busy = false;
let mapStrategy: ChunkStrategy | undefined;

const tracker = new SearchTracker();
const mapView = new MapView($<HTMLCanvasElement>("map"));

function viewRequest(detail: RequestDetail, label: string): void {
  showRequest($("request-view"), detail, label);
  selectTab("request");
}

const logView = new LogView($("log"), viewRequest);
const compareView = new CompareView($("compare-view"), viewRequest);

// --- Tabs -------------------------------------------------------------------------------

function selectTab(name: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    const selected = button.dataset.tab === name;
    button.setAttribute("aria-selected", String(selected));
    $(`tab-${button.dataset.tab}`).hidden = !selected;
  }
  if (name === "map") void ensureMap(readSettings().strategy);
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  button.addEventListener("click", () => selectTab(button.dataset.tab ?? "log"));
}

// --- The map ------------------------------------------------------------------------------

/** Loads the map for a strategy if it isn't the one shown. */
async function ensureMap(strategy: ChunkStrategy): Promise<void> {
  if (mapStrategy === strategy) return;
  try {
    mapView.setMap(await getJson<MapResponse>(`/api/map?strategy=${encodeURIComponent(strategy)}`));
    mapStrategy = strategy;
  } catch (error: unknown) {
    $("map-caption").textContent = `The map couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Keeps the candidate table and the map in step with the last search. */
async function onSearchUpdate(): Promise<void> {
  renderCandidates($<HTMLTableElement>("candidates"), tracker.last);
  const last = tracker.last;
  if (!last) return;
  await ensureMap(last.result.strategy);
  mapView.setSearch(last.result.queryMap, last.kept, last.result.candidates);
}

// --- Asking -------------------------------------------------------------------------------

function body(mode: AnswerMode): AskBody | null {
  const question = $<HTMLTextAreaElement>("question").value.trim();
  if (!question) {
    $("question").focus();
    return null;
  }
  const { strategy, settings } = readSettings();
  return { question, mode, model: $<HTMLSelectElement>("model").value, strategy, settings, think: $<HTMLInputElement>("think").checked };
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ["ask", "compare", "rebuild"]) $<HTMLButtonElement>(id).disabled = value;
}

function showAnswer(summary: TurnSummary, outcome?: AnswerOutcome): void {
  const box = $("answer");
  clear(box);
  box.hidden = false;
  append(box,
    outcome ? el("span", { class: `badge ${outcome}` }, outcome) : null,
    summary.error ? `No answer: ${summary.error}` : summary.answer.trim(),
    el("span", { class: "meta" },
      `${summary.mode} · ${summary.requests} model request${summary.requests === 1 ? "" : "s"} · ${summary.searches} search${summary.searches === 1 ? "" : "es"} · ` +
        `${summary.chunksSent} chunks sent · ${(summary.timings.total / 1000).toFixed(1)} s` +
        (summary.citations.invalid.length > 0 ? ` · cited but never sent: ${summary.citations.invalid.join(", ")}` : "") +
        (outcome ? " · outcome scored by code, as the scorecard does" : "")),
  );
}

function handle(event: StreamEvent, into: "log" | "compare"): void {
  if (event.type === "log") {
    if (into === "log") logView.add(event.event);
    else compareView.add(event.event);
    if (tracker.take(event.event)) void onSearchUpdate();
  } else if (event.type === "done") {
    if (into === "log") showAnswer(event.summary, event.outcome);
    else compareView.done(event.summary, event.outcome);
  } else if (event.type === "error") {
    if (into === "log") logView.note(event.message, "error");
    else compareView.finished();
    showBanner(event.message);
  } else if (event.type === "finished" && into === "compare") {
    compareView.finished();
  }
}

$("ask").addEventListener("click", async () => {
  const mode = (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "pre-retrieved") as AnswerMode;
  const request = body(mode);
  if (!request || busy) return;
  setBusy(true);
  logView.clear();
  $("answer").hidden = true;
  selectTab("log");
  await postStream("/api/ask", request, (event) => handle(event, "log"));
  setBusy(false);
});

$("compare").addEventListener("click", async () => {
  const request = body("pre-retrieved");
  if (!request || busy) return;
  setBusy(true);
  compareView.start(request.question);
  selectTab("compare");
  await postStream("/api/compare", request, (event) => handle(event, "compare"));
  setBusy(false);
});

$<HTMLSelectElement>("preset-question").addEventListener("change", (e) => {
  const id = (e.target as HTMLSelectElement).value;
  const q = meta?.questions.find((x) => x.id === id);
  if (q) $<HTMLTextAreaElement>("question").value = q.question;
});

// --- Rebuilding an index -------------------------------------------------------------------

$("rebuild").addEventListener("click", async () => {
  if (busy) return;
  const strategy = readSettings().strategy;
  const preset = $<HTMLSelectElement>("preset").value;
  setBusy(true);
  const out = $("rebuild-log");
  out.hidden = false;
  out.textContent = `Rebuilding the ${strategy} index with the ${preset} preset…\n`;
  await postStream("/api/index/rebuild", { strategy, preset }, (event) => {
    if (event.type === "progress") {
      // The build redraws its progress line; show only the latest of those.
      const lines = (out.textContent ?? "").split("\n").filter(Boolean);
      if (/embedding \d+\/\d+/.test(event.line) && /embedding \d+\/\d+/.test(lines[lines.length - 1] ?? "")) lines.pop();
      out.textContent = [...lines, event.line].join("\n") + "\n";
    } else if (event.type === "error") {
      out.textContent += `\n${event.message}\n`;
    }
  });
  mapStrategy = undefined;
  await loadMeta();
  setBusy(false);
});

// --- Startup -----------------------------------------------------------------------------

function showBanner(text: string): void {
  const banner = $("banner");
  banner.textContent = text;
  banner.hidden = false;
}

function updateIndexInfo(): void {
  const strategy = readSettings().strategy;
  const index = meta?.indexes.find((i) => i.strategy === strategy);
  $("index-info").textContent = index
    ? `Loaded: ${index.chunks} chunks, preset "${index.preset}"${index.stale ? ". STALE: built from a different corpus; rebuild it." : "."}`
    : "This index isn't built. Rebuild it, or run npm run index.";
  if (index) $<HTMLSelectElement>("preset").value = index.preset;
}

function updateThink(): void {
  const model = meta?.models.find((m) => m.name === $<HTMLSelectElement>("model").value);
  const think = $<HTMLInputElement>("think");
  think.disabled = !model?.supportsThinking;
  if (think.disabled) think.checked = false;
}

async function loadMeta(): Promise<void> {
  meta = await getJson<MetaResponse>("/api/meta");
  $("banner").hidden = true;
  const problems: string[] = [];
  if (meta.problem) problems.push(meta.problem);
  const stale = meta.indexes.filter((i) => i.stale).map((i) => i.strategy);
  if (stale.length > 0) problems.push(`Stale index${stale.length > 1 ? "es" : ""}: ${stale.join(", ")}. A corpus document changed since ${stale.length > 1 ? "they were" : "it was"} built; rebuild, or run npm run index.`);
  if (problems.length > 0) showBanner(problems.join(" "));
  mapView.setDocuments(meta.documents);
  updateIndexInfo();
}

async function start(): Promise<void> {
  await loadMeta();
  if (!meta) return;

  const model = $<HTMLSelectElement>("model");
  for (const m of meta.models) model.append(el("option", { value: m.name }, m.name));
  if (!meta.models.some((m) => m.name === meta!.defaultModel)) model.append(el("option", { value: meta.defaultModel }, meta.defaultModel));
  model.value = meta.defaultModel;
  model.addEventListener("change", updateThink);
  updateThink();

  const picker = $<HTMLSelectElement>("preset-question");
  for (const category of [...new Set(meta.questions.map((q) => q.category))]) {
    const group = el("optgroup", { label: category });
    for (const q of meta.questions.filter((x) => x.category === category)) group.append(el("option", { value: q.id }, q.question));
    picker.append(group);
  }

  const presets = $<HTMLSelectElement>("preset");
  for (const [name, size] of Object.entries(meta.presets)) presets.append(el("option", { value: name }, `${name} (${size.chunkTokens} tokens, ${size.overlapTokens} overlap)`));

  const d = meta.defaults;
  $<HTMLSelectElement>("strategy").value = d.strategy;
  $<HTMLSelectElement>("search-mode").value = d.search.mode;
  $<HTMLInputElement>("top-k").value = String(d.search.topK);
  $<HTMLOutputElement>("top-k-value").value = String(d.search.topK);
  $<HTMLInputElement>("floor").value = String(d.search.floor);
  $<HTMLInputElement>("rerank").checked = d.search.rerank;
  $<HTMLInputElement>("budget").checked = d.search.budgetCheck;
  $<HTMLInputElement>("top-k").addEventListener("input", (e) => ($<HTMLOutputElement>("top-k-value").value = (e.target as HTMLInputElement).value));
  $<HTMLSelectElement>("strategy").addEventListener("change", updateIndexInfo);
  updateIndexInfo();
}

start().catch((error: unknown) => showBanner(`The page couldn't load: ${error instanceof Error ? error.message : String(error)}`));
