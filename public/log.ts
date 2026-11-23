/**
 * log.ts — the activity log: one row per event, as it streams in.
 *
 * Each row shows the event's level (color-coded; `retrieval` rows get a
 * green edge, because they're what this lab is about), whose decision it
 * was (the actor: `app` searched in pre-retrieved mode, `model` in
 * search-tool mode), the label, and why it happened. The full detail
 * behind a row (a request body, a candidate list) sits in a collapsed
 * section and is only turned into text when opened: a search result with
 * 150 candidates is a lot of JSON to build for a row nobody expands.
 *
 * A model request row gets a "View request" button, which opens the
 * request view with every retrieved chunk highlighted (request-view.ts).
 *
 * The lab's rule (PLAN §1): if something happens and the UI doesn't show
 * it, that's a bug. This list is where it shows.
 */

import type { ChunkSpan, LogEvent } from "../shared/types.js";
import { clear, el } from "./dom.js";

/** The detail a model-request row carries. */
export interface RequestDetail {
  request: { model: string; messages: Array<{ role: string; content: string; tool_name?: string }>; tools?: unknown[]; options?: unknown; think?: boolean };
  chunkSpans: ChunkSpan[];
}

/** One row as an element. `compact` drops the grid layout, for the compare columns. */
export function renderRow(event: LogEvent, onViewRequest: (detail: RequestDetail, label: string) => void): HTMLElement {
  const label = el("span", { class: "label" }, event.label);
  const isRequest = event.level === "model" && event.direction === "out" && typeof event.detail === "object" && event.detail !== null && "request" in event.detail;
  if (isRequest) {
    const button = el("button", { class: "view", type: "button" }, "View request");
    button.addEventListener("click", () => onViewRequest(event.detail as RequestDetail, event.label));
    label.append(button);
  }

  const body = el("div", {}, label, event.because ? el("span", { class: "because" }, `because ${event.because}`) : null);
  if (event.detail !== undefined) {
    const pre = el("pre", { class: "small" });
    const details = el("details", {}, el("summary", {}, "detail"), pre);
    details.addEventListener("toggle", () => {
      // Built on first open only. textContent: details hold corpus and model text.
      if (details.open && pre.textContent === "") pre.textContent = JSON.stringify(event.detail, null, 2);
    });
    body.append(details);
  }

  return el("div", { class: `row lv-row-${event.level}` },
    el("span", { class: `lv lv-${event.level}` }, event.level),
    el("span", { class: "actor" }, event.actor ?? ""),
    body,
  );
}

/** A scrolling list of rows. */
export class LogView {
  constructor(private readonly container: HTMLElement, private readonly onViewRequest: (detail: RequestDetail, label: string) => void) {}

  clear(): void {
    clear(this.container);
  }

  add(event: LogEvent): void {
    // Follow the stream only if the reader is already at the bottom.
    const atBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 40;
    this.container.append(renderRow(event, this.onViewRequest));
    if (atBottom) this.container.scrollTop = this.container.scrollHeight;
  }

  note(text: string, kind: "error" | "muted" = "muted"): void {
    this.container.append(el("p", { class: kind === "error" ? "lv-error" : "muted" }, text));
  }
}
