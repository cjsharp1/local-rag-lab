/**
 * logger.ts — builds activity-log rows and hands them to a sink.
 *
 * Everything the lab does that a reader might want to see becomes one
 * LogEvent (shared/types.ts): a search, a dropped chunk, a model request,
 * a citation that points nowhere. The Logger doesn't know where rows go.
 * The web server's sink sends them to the browser over Server-Sent Events;
 * ask.ts and compare.ts print them in the terminal; the scorecard keeps
 * them in memory. That's why the modes take a Logger and never an HTTP
 * response: the same code runs behind every one of those.
 *
 * One method per level, each with a sensible default actor:
 *
 *   info       the app did something on its own
 *   retrieval  a search, the floor, top-k, the budget, a chunk placed into
 *              a prompt: the events this lab is about (PLAN §2)
 *   model      a request to, or response from, the chat model
 *   tool       an MCP call or its result
 *   warn       nothing failed, but you should know
 *   error      something failed
 *
 * Every row also carries the answer mode it came from, so the compare
 * view can sort three runs into three columns.
 */

import type { AnswerMode, LogActor, LogDirection, LogEvent, LogLevel } from "../shared/types.js";

/** Where log rows go. */
export type LogSink = (event: LogEvent) => void;

/** The optional parts of a row. */
export interface LogExtras {
  direction?: LogDirection;
  actor?: LogActor;
  because?: string;
}

export class Logger {
  /** The model request this row belongs to, set by the modes as they go. */
  iteration: number | undefined;

  constructor(private readonly sink: LogSink, private readonly mode?: AnswerMode) {}

  private emit(level: LogLevel, label: string, detail: unknown, extras: LogExtras): void {
    this.sink({
      level,
      label,
      at: Date.now(),
      ...(detail !== undefined ? { detail } : {}),
      ...(this.iteration !== undefined ? { iteration: this.iteration } : {}),
      ...(this.mode ? { mode: this.mode } : {}),
      ...extras,
    });
  }

  info(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("info", label, detail, { actor: "app", ...extras });
  }

  retrieval(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("retrieval", label, detail, { actor: "app", ...extras });
  }

  model(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("model", label, detail, extras);
  }

  tool(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("tool", label, detail, extras);
  }

  warn(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("warn", label, detail, { actor: "app", ...extras });
  }

  error(label: string, detail?: unknown, extras: LogExtras = {}): void {
    this.emit("error", label, detail, { actor: "app", ...extras });
  }
}

/** Shortens text for a label, with an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 1234 → "1,234". */
export function n(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
