/**
 * search-tool.ts — agentic RAG: the model decides whether, what and how often to search.
 *
 * The model gets the question and one tool, search_docs, and runs a loop:
 *
 *   1. Ask the model, with search_docs offered.
 *   2. If it answers, that's the answer. If it calls search_docs, the app
 *      runs the search over MCP with the model's query (the log row's actor
 *      is `model`), picks the chunks that fit the REMAINING budget, and
 *      sends them back as the tool result.
 *   3. Repeat, up to MAX_REQUESTS model requests.
 *
 * It's the same search_docs tool, the same search code and the same
 * selection pre-retrieved mode uses. What changes is who writes the query
 * (the model may rewrite "can our pup come?" as "dogs allowed") and that
 * it can search again when the first results miss, which is the only
 * way a multi-hop question gets both of its documents.
 *
 * What it costs is in the log too: a round trip per search, and every
 * request re-sends all earlier results. And it depends on a 4B model
 * choosing to search and searching well; when it answers without
 * searching, the log says so, and that's a result, not a bug to hide
 * (PLAN §11).
 *
 * ---------------------------------------------------------------------------
 * The tool the model sees
 * ---------------------------------------------------------------------------
 *
 * The definition comes from the tool server (MCP tools/list), so it's
 * provably the same tool, with the app-only settings (strategy, mode,
 * floor) removed: the model writes the query; the reader's retrieval panel
 * sets the rest. The tool server returns every candidate; the model never
 * sees an untrimmed result (PLAN §10).
 *
 * The budget for each result is the window minus everything already in
 * the request, recomputed before every search, so three searches that
 * each fit on their own can't overflow the window together (PLAN §3.3).
 *
 * Known model behavior: llama3.2:3b's chat template drops the tool
 * definitions once a tool result is the last message, so it can search
 * only once. It's reported as a finding (PLAN §11), not worked around.
 */

import type { ChunkSpan, TurnSummary } from "../../shared/types.js";
import { toolResultMessage } from "../context/assemble.js";
import { truncate } from "../logger.js";
import { buildRequest, type OllamaMessage, type OllamaTool } from "../model/ollama.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { Turn } from "./common.js";

/** Model requests allowed in one turn: up to three searches, then an answer. */
export const MAX_REQUESTS = 4;

/** Settings the app sets; the model never sees them. */
const APP_ONLY = ["strategy", "mode", "floor"];

/** search_docs as the model sees it: the tool server's definition, with only `query`. */
async function modelFacingTool(turn: Turn): Promise<OllamaTool> {
  const def = await turn.tools.toolDefinition("search_docs");
  const schema = structuredClone(def.inputSchema) as { properties?: Record<string, unknown>; required?: string[] };
  for (const key of APP_ONLY) delete schema.properties?.[key];
  if (schema.required) schema.required = schema.required.filter((k) => !APP_ONLY.includes(k));
  return { type: "function", function: { name: def.name, description: def.description, parameters: schema as Record<string, unknown> } };
}

export async function runSearchTool(turn: Turn): Promise<TurnSummary> {
  const { request, logger } = turn;
  const tools = [await modelFacingTool(turn)];
  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt("search-tool") },
    { role: "user", content: request.question },
  ];
  const spans: ChunkSpan[] = [];
  let previousQuery: string | undefined;

  for (let i = 1; i <= MAX_REQUESTS; i++) {
    const response = await turn.callModel(
      buildRequest({ model: request.model, messages, tools, think: request.think === true }),
      [...spans],
      i === 1 ? "the question was asked, with search_docs offered" : "the search results are ready",
    );
    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      if (turn.summary.searches === 0) {
        logger.warn("The model answered without searching", undefined, { actor: "model", because: "search_docs was offered, and calling it was the model's choice" });
      }
      return turn.finish(response.message.content);
    }

    // Keep the model's tool-call message: it needs to see what it asked for next to the results.
    messages.push({ role: "assistant", content: response.message.content, tool_calls: calls });

    for (const call of calls) {
      const name = call.function.name;
      const query = typeof call.function.arguments?.query === "string" ? call.function.arguments.query.trim() : "";
      let content: string;

      if (name !== "search_docs") {
        logger.warn(`The model asked for a tool that doesn't exist: ${name}`, call, { actor: "model", because: "small models sometimes invent tool names" });
        content = `There is no tool called ${name}. The only tool is search_docs.`;
      } else if (query === "") {
        logger.warn("The model called search_docs without a query", call, { actor: "model" });
        content = "search_docs needs a query: what to search for, in plain words.";
      } else if (query.toLowerCase() === previousQuery?.toLowerCase()) {
        // The same search would return the same chunks; say so instead of re-running it.
        logger.warn(`The model repeated its last search: "${truncate(query, 70)}"`, call, { actor: "model", because: "an identical search returns identical results" });
        content = "You already searched for exactly that. Answer from the results you have, or search with different words.";
      } else {
        previousQuery = query;
        const budget = turn.budgetFor(messages, tools);
        const { selection } = await turn.search(query, "model", budget);
        const result = toolResultMessage(query, selection.kept);
        content = result.content;
        messages.push({ role: "tool", tool_name: name, content });
        spans.push(...Turn.spans(messages.length - 1, result.spans));
        continue;
      }
      messages.push({ role: "tool", tool_name: name, content });
    }
  }

  return turn.fail(`Stopped after ${MAX_REQUESTS} model requests without an answer`, { queries: turn.summary.queries });
}
