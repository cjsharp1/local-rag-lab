/**
 * ollama.ts — talks to the local chat model, with plain fetch.
 *
 * One call does the work: chat() sends a conversation (optionally with
 * tools) to POST /api/chat and returns Ollama's response. No SDK: the
 * point of the activity log is to show the request exactly as it crosses
 * the wire, and a library's own types and defaults would sit in between.
 * The object logged is the object sent.
 *
 * ---------------------------------------------------------------------------
 * The settings every request carries, and why
 * ---------------------------------------------------------------------------
 *
 * buildRequest() sets these, so no call site can forget one:
 *
 *   think         false unless the reader turns thinking on. qwen3.5:4b
 *                 thinks by default, and in step 0 a one-sentence question
 *                 spent 1,500 tokens (2.5 minutes) thinking without reaching
 *                 an answer. Leaving `think` out lets the model think, so
 *                 it's always sent.
 *   stream: true  The response arrives as a stream of small JSON lines,
 *                 which chat() joins back into one response. Not for live
 *                 display: Node's fetch gives up if no response headers
 *                 arrive within 5 minutes, and a long non-streamed request
 *                 hit exactly that in step 0. A stream sends headers at once.
 *   num_ctx       The context window, explicit. Ollama's default is smaller,
 *                 and when a request outgrows the window Ollama SILENTLY
 *                 DROPS whole older messages. The modes watch
 *                 prompt_eval_count to catch it (modes/common.ts).
 *   num_predict   A cap on the reply's length, so a runaway answer stops,
 *                 and the context budget knows how much room to reserve.
 *   temperature 0, seed 1
 *                 The lab compares three modes on the same question. Fixed
 *                 sampling makes a rerun give the same answer, so a
 *                 difference between modes is the mode, not the dice.
 *
 * Local models only: chat() refuses a cloud model by name before anything
 * is sent (shared/local-only.ts), whatever Ollama's own settings say.
 */

import { isLocalUrl, isRemoteModel } from "../../shared/local-only.js";

// --- Wire types: what Ollama sends and receives ---------------------------------

/** A tool call the model asked for. */
export interface OllamaToolCall {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> };
}

/** One message in the conversation. */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** On a "tool" message: which tool produced this result. */
  tool_name?: string;
  /** The model's reasoning, present only when the request set think: true. */
  thinking?: string;
}

/** A tool, described the way Ollama wants it: a JSON Schema function. */
export interface OllamaTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Exactly what goes over the wire to POST /api/chat. */
export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /**
   * A JSON Schema the reply must match (structured output). Used only by
   * the reranker, in a request with no tools: the data lab measured that
   * `format` alongside `tools` stops tool calling entirely.
   */
  format?: Record<string, unknown>;
  think: boolean;
  stream: true;
  options: { num_ctx: number; num_predict: number; temperature: number; seed: number };
}

/** The joined-up response: the last stream line's counts, with the message assembled. Durations in nanoseconds. */
export interface ChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// --- Errors, each a class so callers match on type, not message text -------------

/** Nothing is listening at OLLAMA_URL. */
export class OllamaUnreachableError extends Error {
  override name = "OllamaUnreachableError";
  constructor(public readonly url: string) {
    super(`Cannot reach Ollama at ${url}. Is it running? Start the Ollama app, or run \`ollama serve\`.`);
  }
}

/** The named model is not installed. */
export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";
  constructor(public readonly model: string) {
    super(`The model "${model}" is not installed. Run:  ollama pull ${model}`);
  }
}

/** A cloud model, or a non-local Ollama, was asked for: refused before anything is sent. */
export class NotLocalError extends Error {
  override name = "NotLocalError";
}

/** Ollama answered with an HTTP error not covered above. */
export class OllamaHttpError extends Error {
  override name = "OllamaHttpError";
  constructor(public readonly status: number, public readonly body: string) {
    super(`Ollama returned HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

// --- Configuration ----------------------------------------------------------------

/** The longest reply allowed, in tokens. Also the reply reserve in the context budget. */
export const NUM_PREDICT = 1024;

/** Settings from .env, with the same defaults as .env.example. */
export function ollamaConfig(): { url: string; model: string; numCtx: number } {
  return {
    url: (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: process.env.MODEL || "qwen3.5:4b",
    numCtx: Number(process.env.NUM_CTX || 8192),
  };
}

/** Builds a request with every fixed setting. Callers supply only what varies. */
export function buildRequest(parts: {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  format?: Record<string, unknown>;
  think?: boolean;
}): ChatRequest {
  if (parts.tools && parts.format) throw new Error("A request can't carry both tools and a format: format stops tool calling.");
  return {
    model: parts.model,
    messages: parts.messages,
    ...(parts.tools ? { tools: parts.tools } : {}),
    ...(parts.format ? { format: parts.format } : {}),
    think: parts.think === true,
    stream: true,
    options: { num_ctx: ollamaConfig().numCtx, num_predict: NUM_PREDICT, temperature: 0, seed: 1 },
  };
}

// --- The call -----------------------------------------------------------------------

/**
 * Sends one chat request and joins the streamed reply into one response.
 * Content and thinking arrive in pieces and are concatenated; tool calls
 * arrive whole, in whichever line carries them; the counts come on the
 * last line (done: true).
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const { url } = ollamaConfig();
  if (!isLocalUrl(url)) throw new NotLocalError(`OLLAMA_URL (${url}) is not this machine. The lab only uses local models.`);
  if (isRemoteModel(request.model)) {
    throw new NotLocalError(`"${request.model}" is a cloud model: it runs on ollama.com, so every question and chunk would leave this machine.`);
  }

  let response: Response;
  try {
    response = await fetch(`${url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  } catch (error: unknown) {
    // Node's fetch throws TypeError("fetch failed") with the socket error as
    // its cause. Matched on the code, never on the message text.
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof TypeError && (code === "ECONNREFUSED" || code === "ECONNRESET")) throw new OllamaUnreachableError(url);
    throw error;
  }
  if (!response.ok || !response.body) {
    const body = await response.text();
    if (response.status === 404) throw new ModelNotFoundError(request.model);
    throw new OllamaHttpError(response.status, body);
  }

  const message: OllamaMessage = { role: "assistant", content: "" };
  let thinking = "";
  let last: Partial<ChatResponse> = {};
  let buffer = "";
  const decoder = new TextDecoder();

  const take = (line: string) => {
    if (!line.trim()) return;
    const part = JSON.parse(line) as Partial<ChatResponse> & { error?: string };
    if (part.error) throw new OllamaHttpError(200, part.error);
    message.content += part.message?.content ?? "";
    thinking += part.message?.thinking ?? "";
    if (part.message?.tool_calls?.length) message.tool_calls = [...(message.tool_calls ?? []), ...part.message.tool_calls];
    if (part.done) last = part;
  };

  for await (const piece of response.body) {
    buffer += decoder.decode(piece as Uint8Array, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  take(buffer);

  if (thinking) message.thinking = thinking;
  return { ...last, model: last.model ?? request.model, message, done: last.done ?? false };
}

// --- Reading a response -------------------------------------------------------------

/** Generation speed: the local stand-in for a cost column. Null if not reported. */
export function tokensPerSecond(response: ChatResponse): number | null {
  if (!response.eval_count || !response.eval_duration) return null;
  return Math.round((response.eval_count / response.eval_duration) * 1e9 * 10) / 10;
}

/** Nanoseconds to whole milliseconds. */
export function ms(nanoseconds: number | undefined): number {
  return Math.round((nanoseconds ?? 0) / 1e6);
}
