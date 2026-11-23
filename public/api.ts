/**
 * api.ts — how the page talks to the server: JSON GETs, and streamed POSTs.
 *
 * Answers arrive as Server-Sent Events, one log row at a time, so the log
 * fills in while the model is still working. The browser's EventSource
 * only does GET, and an ask carries a JSON body, so postStream() reads the
 * event stream from a fetch() response itself: split on blank lines, take
 * each "data:" line, parse it as a StreamEvent.
 *
 * A refused request (a cloud model, a rebuild in progress, a bad body)
 * comes back as plain JSON with an error status, never as a stream, and
 * is turned into a single error event so callers handle one shape.
 */

import type { StreamEvent } from "../shared/types.js";

/** GETs JSON, or throws with the server's error message. */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** POSTs a JSON body and calls `onEvent` for every event in the streamed reply. */
export async function postStream(path: string, body: unknown, onEvent: (event: StreamEvent) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error: unknown) {
    onEvent({ type: "error", message: `The lab's server isn't answering: ${error instanceof Error ? error.message : String(error)}` });
    onEvent({ type: "finished" });
    return;
  }
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // not JSON: show the text as it is
    }
    onEvent({ type: "error", message });
    onEvent({ type: "finished" });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
