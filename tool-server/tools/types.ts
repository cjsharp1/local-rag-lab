/**
 * types.ts — the shape every tool in this server follows.
 *
 * A tool is a name, a description the model reads, a Zod schema for its
 * arguments, a Zod schema for its result, and a function. The MCP server
 * (mcp-server.ts) registers each one the same way; nothing about a tool
 * lives anywhere but its own file.
 *
 * The output schema isn't decoration. The MCP SDK checks every result
 * against it before sending, so a tool can't quietly return a different
 * shape from the one the app and shared/types.ts expect.
 */

import type { z } from "zod";

/** What a tool's run() produces: structured data for the app, text for people. */
export interface ToolOutput<TData> {
  /** The structured result. The app reads this. */
  data: TData;
  /**
   * A plain-text rendering of the same result. MCP Inspector shows it, and
   * any MCP client without structured-content support reads it instead.
   */
  text: string;
}

/** One tool. */
export interface ToolDefinition<TInput extends z.ZodObject, TData> {
  name: string;
  title: string;
  description: string;
  inputSchema: TInput;
  outputSchema: z.ZodType<TData>;
  run(args: z.infer<TInput>): Promise<ToolOutput<TData>>;
}

/**
 * A mistake in the call (an unknown document id, an index not built),
 * as opposed to a bug. Its message goes back to the caller as the result,
 * with isError set, so the model or the app can read it and recover.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
