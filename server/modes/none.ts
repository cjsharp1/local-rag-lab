/**
 * none.ts — no-retrieval mode: the question goes to the model, and nothing else does.
 *
 * The baseline the other two modes are measured against (PLAN §1). One
 * small request: the system prompt and the question. The system prompt
 * still says "answer only from the provided documents", and none are
 * provided. A small model usually answers anyway, fluently and with
 * numbers that sound right, and that invented answer is the lesson: it
 * looks exactly as confident as a grounded one.
 *
 * Compare the log of this mode with pre-retrieved mode's for the same
 * question: same system prompt, same question, one request each. The only
 * difference is the block of documents, and the prompt-token count shows
 * exactly what it costs.
 */

import type { TurnSummary } from "../../shared/types.js";
import { buildRequest, type OllamaMessage } from "../model/ollama.js";
import { buildSystemPrompt } from "../system-prompt.js";
import type { Turn } from "./common.js";

export async function runNone(turn: Turn): Promise<TurnSummary> {
  const { request } = turn;
  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt("none") },
    { role: "user", content: request.question },
  ];
  const response = await turn.callModel(buildRequest({ model: request.model, messages, think: request.think === true }), [], "the question was asked, with no documents");
  return turn.finish(response.message.content);
}
