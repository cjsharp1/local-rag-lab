/**
 * pre-retrieved.ts — classic RAG: the app searches first, then pastes the chunks into one request.
 *
 * PLAN §3.3, step by step:
 *
 *   1. Work out the chunk budget: the window, minus the system prompt and
 *      the question, minus the reply reserve.
 *   2. The APP calls search_docs over MCP, with the question as the query.
 *      The log row's actor is `app`: nobody asked the model.
 *   3. Pick the top k that fit the budget (context/budget.ts), logging
 *      every chunk not sent and why.
 *   4. Write the kept chunks into the user message, each under its label,
 *      before the question (context/assemble.ts), recording the span of
 *      every chunk in the request.
 *   5. One model request, with no tools offered.
 *   6. Check the answer's citations against the labels actually sent.
 *
 * What this mode costs is visible in the log: it always pays for the
 * chunks, even when the question needs none, and it searches once, with
 * the user's exact words. If those words don't retrieve the right chunk,
 * nothing gives the model a second try; that's search-tool mode's trade.
 */

import type { TurnSummary } from "../../shared/types.js";
import { preRetrievedMessage } from "../context/assemble.js";
import { buildRequest, type OllamaMessage } from "../model/ollama.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { Turn } from "./common.js";

export async function runPreRetrieved(turn: Turn): Promise<TurnSummary> {
  const { request } = turn;
  const system: OllamaMessage = { role: "system", content: buildSystemPrompt("pre-retrieved") };

  // 1. The budget: everything in the request except the chunks themselves.
  const skeleton = preRetrievedMessage(request.question, []);
  const budget = turn.budgetFor([system, { role: "user", content: skeleton.content }]);

  // 2–3. Search, then select.
  const { selection } = await turn.search(request.question, "app", budget);

  // 4. Assemble.
  const user = preRetrievedMessage(request.question, selection.kept);
  const messages: OllamaMessage[] = [system, { role: "user", content: user.content }];

  // 5. One request, no tools.
  const response = await turn.callModel(
    buildRequest({ model: request.model, messages, think: request.think === true }),
    Turn.spans(1, user.spans),
    "the retrieved chunks are in the prompt",
  );

  // 6. Citations are checked in finish().
  return turn.finish(response.message.content);
}
