/**
 * request-view.ts — exactly what the model received, with every retrieved chunk highlighted.
 *
 * This view is the lab's first lesson made visible (PLAN §1): RAG is
 * prompt construction. The model doesn't "know" the documents; the app
 * pasted text into the request, and here a reader can point at exactly
 * where. Each message of the request is shown in full, in order, and
 * every chunk inside it is highlighted from the spans the app recorded
 * when it assembled the prompt (server/context/assemble.ts). Hovering a
 * highlight shows the chunk's label.
 *
 * Above the messages: the settings that went with the request (context
 * window, reply cap, thinking) and the tools offered, if any. In
 * search-tool mode the tool definition is part of what the model reads,
 * and it costs tokens, so it's shown too.
 */

import { clear, el, n } from "./dom.js";
import type { RequestDetail } from "./log.js";

/** A message's text with its chunk spans wrapped in <mark>. */
function highlighted(content: string, spans: RequestDetail["chunkSpans"]): HTMLElement {
  const pre = el("pre", { class: "content" });
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue; // overlapping spans can't happen; skip rather than garble
    pre.append(content.slice(at, span.start), el("mark", { title: span.label }, content.slice(span.start, span.end)));
    at = span.end;
  }
  pre.append(content.slice(at));
  return pre;
}

/** Fills the request view with one request. */
export function showRequest(container: HTMLElement, detail: RequestDetail, label: string): void {
  clear(container);
  const { request, chunkSpans } = detail;
  const chars = request.messages.reduce((sum, m) => sum + m.content.length, 0);

  container.append(
    el("h3", {}, label),
    el("p", { class: "muted small" },
      `${request.messages.length} messages, ${n(chars)} characters, ${chunkSpans.length} retrieved chunk${chunkSpans.length === 1 ? "" : "s"} (highlighted). ` +
        `Options: ${JSON.stringify(request.options ?? {})}${request.think ? ", thinking on" : ", thinking off"}.`),
  );

  if (request.tools && request.tools.length > 0) {
    container.append(el("details", {}, el("summary", {}, `Tools offered to the model (${request.tools.length}) — part of the prompt, and part of its token count`),
      el("pre", { class: "small" }, JSON.stringify(request.tools, null, 2))));
  }

  request.messages.forEach((message, i) => {
    const spans = chunkSpans.filter((s) => s.messageIndex === i);
    container.append(el("div", { class: "message" },
      el("header", {},
        el("span", {}, `${i + 1}. ${message.role}${message.tool_name ? ` (${message.tool_name})` : ""}`),
        el("span", {}, `${n(message.content.length)} chars${spans.length > 0 ? ` · ${spans.length} chunk${spans.length === 1 ? "" : "s"}` : ""}`)),
      highlighted(message.content, spans),
    ));
  });
}
