/**
 * turn.ts — runs one question through one answer mode, and returns what it cost.
 *
 * The single entry point for answering: the web server's routes (step 10),
 * ask.ts, compare.ts and the answer scorecard all call runTurn(), so the
 * terminal, the browser and the scorecard run exactly the same code. It
 * takes a log sink, not an HTTP response, for the same reason.
 *
 * It picks the mode, runs it inside a Turn (modes/common.ts), and turns
 * every failure into a logged error and a summary with `error` set, so a
 * caller always gets a TurnSummary back: Ollama not running, the tool
 * server failing to start, a search that errored. An error is part of the
 * record of what happened, not a reason for the record to stop.
 */

import type { LogEvent, TurnSummary } from "../shared/types.js";
import { Logger } from "./logger.js";
import { SearchFailedError, ToolServerUnavailableError, type ToolServerClient } from "./mcp/client.js";
import { ModelNotFoundError, NotLocalError, OllamaHttpError, OllamaUnreachableError } from "./model/ollama.js";
import { Turn, type TurnRequest } from "./modes/common.js";
import { runNone } from "./modes/none.js";
import { runPreRetrieved } from "./modes/pre-retrieved.js";
import { runSearchTool } from "./modes/search-tool.js";

export type { TurnRequest } from "./modes/common.js";

/** Failures with a message a reader can act on; anything else is a bug and is rethrown. */
const EXPECTED = [OllamaUnreachableError, ModelNotFoundError, NotLocalError, OllamaHttpError, ToolServerUnavailableError, SearchFailedError];

export async function runTurn(request: TurnRequest, sink: (event: LogEvent) => void, tools: ToolServerClient): Promise<TurnSummary> {
  const turn = new Turn(request, new Logger(sink, request.mode), tools);
  turn.start();
  try {
    switch (request.mode) {
      case "none":
        return await runNone(turn);
      case "pre-retrieved":
        return await runPreRetrieved(turn);
      case "search-tool":
        return await runSearchTool(turn);
    }
  } catch (error: unknown) {
    if (EXPECTED.some((kind) => error instanceof kind)) return turn.fail((error as Error).message);
    throw error;
  }
}
