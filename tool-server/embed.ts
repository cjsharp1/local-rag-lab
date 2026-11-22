/**
 * embed.ts — turns text into vectors, by asking the embeddings model in Ollama.
 *
 * An embedding is a list of numbers (768 of them for nomic-embed-text)
 * that places a piece of text in a space where similar meanings sit close
 * together. Retrieval compares the query's vector with every chunk's
 * vector, so this one function sits under both halves of vector search:
 * the index script calls it once per chunk, and search_docs calls it once
 * per query.
 *
 * Three details, each one a lesson about embeddings in practice:
 *
 *   - **Task prefixes.** nomic-embed-text was trained to see
 *     "search_document: " before a passage and "search_query: " before a
 *     question, and its model card says the prefix is required. Step 0
 *     measured the late-fee pair at 0.873 cosine without prefixes and
 *     0.911 with them. `kind` picks the prefix; callers never write it.
 *   - **No silent truncation.** By default Ollama cuts an input longer
 *     than the model's context and returns a vector of the part that fit,
 *     with HTTP 200 and no warning (step 0 confirmed it). This sends
 *     `truncate: false`, so an over-long chunk is an error, not a vector
 *     that quietly describes half of it.
 *   - **Load time is reported.** Ollama returns how long it spent loading
 *     the model. Non-zero means the model wasn't in memory: a cold start,
 *     or a swap with the chat model. It goes in the log as its own stage
 *     rather than vanishing into "embedding took 4 seconds".
 *
 * It lives in tool-server/ because the tool server embeds queries itself
 * (PLAN §3.1); the index script imports it from here so both use one path.
 */

import { isLocalUrl, isRemoteModel } from "../shared/local-only.js";

/** nomic-embed-text's task prefixes (see the header). */
export const PREFIXES = {
  document: "search_document: ",
  query: "search_query: ",
} as const;

/** Inputs per request. Ollama embeds a batch in one call. */
const BATCH_SIZE = 32;

/** Something went wrong talking to the embeddings model; the message says what to do. */
export class EmbedError extends Error {
  override name = "EmbedError";
}

/** What one embed() call produced. */
export interface EmbedResult {
  model: string;
  vectors: Float32Array[];
  /** Tokens the model counted across all inputs, prefixes included. */
  promptTokens: number;
  /** Wall-clock time for all requests, in milliseconds. */
  totalMs: number;
  /** Ollama's model load time, summed over requests, in milliseconds. */
  loadMs: number;
}

/** Where Ollama is and which model to use, checked against the local-only rules. */
export function embedConfig(): { url: string; model: string } {
  const url = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = process.env.EMBED_MODEL || "nomic-embed-text";
  if (!isLocalUrl(url)) throw new EmbedError(`OLLAMA_URL (${url}) is not this machine. The lab only embeds locally.`);
  if (isRemoteModel(model)) throw new EmbedError(`EMBED_MODEL "${model}" is a cloud model. The lab only embeds locally.`);
  return { url: new URL(url).origin, model };
}

/**
 * Embeds texts as documents (chunks) or as a query, in batches.
 * `onBatch` reports progress for the index script's progress line.
 */
export async function embed(
  texts: readonly string[],
  kind: keyof typeof PREFIXES,
  onBatch?: (done: number, total: number) => void,
): Promise<EmbedResult> {
  const { url, model } = embedConfig();
  const result: EmbedResult = { model, vectors: [], promptTokens: 0, totalMs: 0, loadMs: 0 };
  const started = performance.now();

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => PREFIXES[kind] + t);

    let response: Response;
    try {
      response = await fetch(`${url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: batch, truncate: false }),
      });
    } catch (error: unknown) {
      // Node's fetch throws TypeError("fetch failed") with the socket error
      // as its cause. Matched on the code, never on the message text.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (error instanceof TypeError && (code === "ECONNREFUSED" || code === "ECONNRESET")) {
        throw new EmbedError(`Ollama is not running at ${url}. Start it, then try again.`);
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404) throw new EmbedError(`The embeddings model "${model}" is not installed. Run:  ollama pull ${model}`);
      throw new EmbedError(`Ollama answered ${response.status} to an embed request: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as { embeddings?: number[][]; prompt_eval_count?: number; load_duration?: number };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== batch.length) {
      throw new EmbedError(`Asked for ${batch.length} embeddings and got ${data.embeddings?.length ?? "none"}.`);
    }
    for (const vector of data.embeddings) result.vectors.push(Float32Array.from(vector));
    result.promptTokens += data.prompt_eval_count ?? 0;
    result.loadMs += (data.load_duration ?? 0) / 1e6; // Ollama reports nanoseconds
    onBatch?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }

  const dims = new Set(result.vectors.map((v) => v.length));
  if (dims.size > 1) throw new EmbedError(`The model returned vectors of different lengths: ${[...dims].join(", ")}.`);

  result.totalMs = performance.now() - started;
  return result;
}
