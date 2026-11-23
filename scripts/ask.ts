/**
 * ask.ts — one question, one answer mode, every log row in the terminal.
 *
 * Run it with:  npm run ask -- "What's the late fee?"
 *               npm run ask -- --mode search-tool "Can our pup come along?"
 *               npm run ask -- --mode none --verbose "Do you rent paddleboards?"
 *
 * The same code the browser runs (server/turn.ts), with the log printed
 * as it happens instead of streamed to a page: the search the app or the
 * model made, what the floor removed, what fell past top-k or over the
 * budget, each model request with its estimated and real token counts,
 * and the answer with its citations checked.
 *
 * --mode picks the answer mode: none, pre-retrieved (the default) or
 * search-tool. The retrieval-panel flags are listed in cli-options.ts.
 * --verbose prints every row's detail too: the full request body, with
 * the chunks inside it, is the most instructive thing in the lab.
 */

import "dotenv/config";

import type { AnswerMode } from "../shared/types.js";
import { formatRow } from "../server/log-format.js";
import { ToolServerClient } from "../server/mcp/client.js";
import { runTurn } from "../server/turn.js";
import { parseOptions } from "./cli-options.js";

const MODES: readonly AnswerMode[] = ["none", "pre-retrieved", "search-tool"];

const options = parseOptions(process.argv.slice(2), ["--mode"]);
const mode = (options.extra.get("--mode") ?? "pre-retrieved") as AnswerMode;
if (!MODES.includes(mode)) {
  console.error(`\n--mode must be one of: ${MODES.join(", ")}\n`);
  process.exit(1);
}
if (!options.question) {
  console.error('\nUsage:  npm run ask -- [--mode none|pre-retrieved|search-tool] [options] "your question"\n');
  process.exit(1);
}

const tools = new ToolServerClient((line) => {
  if (options.verbose) console.error(`  [tool server] ${line}`);
});

console.log(`\n${options.question}\n`);
const summary = await runTurn(
  { question: options.question, mode, model: options.model, strategy: options.strategy, settings: options.settings, think: options.think },
  (event) => console.log(formatRow(event, options.verbose)),
  tools,
);
await tools.close();

console.log(summary.error ? `\nNo answer: ${summary.error}\n` : `\nAnswer:\n\n${summary.answer.trim()}\n`);
if (summary.citations.invalid.length > 0) console.log(`Citations not in any request: ${summary.citations.invalid.join(", ")}\n`);
process.exitCode = summary.error ? 1 : 0;
