/**
 * mcp-server.ts — builds the MCP server that offers the lab's four tools.
 *
 * MCP (the Model Context Protocol) is how the app reaches the tools: it
 * starts this server as a child process and talks to it over stdio
 * (stdio.ts), or a developer points MCP Inspector at it over HTTP
 * (http.ts). Both transports build their server with createServer() from
 * here, so there's one definition of what the tools are and how errors
 * come back.
 *
 * The tool server is the only part of the lab that reads the corpus and
 * the indexes (PLAN §3.1). The app never opens an index file; everything
 * it knows about retrieval arrives as a search_docs result, which is what
 * makes the log a complete record of what retrieval did.
 *
 * Errors come back in two kinds, and the difference matters to whoever
 * reads them:
 *
 *   - A ToolError is a mistake in the call: an unknown document id, an
 *     index that isn't built. Its message is the result, with isError set,
 *     so the model (or the app) can read it and try something else.
 *   - Anything else is a bug, or Ollama not running. The message says
 *     which, and the details go to stderr (never stdout: over stdio,
 *     stdout is the protocol itself).
 *
 * The factory builds a new server per call because the HTTP transport
 * creates one per request; the loaded indexes live in indexes.ts, so a
 * new server costs nothing.
 */

import { McpServer } from "@modelcontextprotocol/server";

import { EmbedError } from "./embed.js";
import { getDocument, indexMap, listDocuments } from "./tools/documents.js";
import { searchDocs } from "./tools/search-docs.js";
import { ToolError, type ToolDefinition } from "./tools/types.js";

export const SERVER_NAME = "paddle-section-docs";
export const SERVER_VERSION = "0.1.0";

// Each tool file keeps its own precise types; this list only needs the
// shape they share, so their type parameters are widened here. The SDK has
// validated a call's arguments against the tool's own schema before run()
// sees them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type AnyTool = ToolDefinition<any, any>;

export const TOOLS: readonly AnyTool[] = [searchDocs, getDocument, listDocuments, indexMap];

function register(server: McpServer, tool: AnyTool): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const { data, text } = await tool.run(args);
        // Every tool's data is an object (its outputSchema says so), which is
        // the shape MCP requires of structuredContent.
        return { content: [{ type: "text" as const, text }], structuredContent: data as Record<string, unknown> };
      } catch (error: unknown) {
        if (error instanceof ToolError || error instanceof EmbedError) {
          // EmbedError: Ollama stopped or the model is missing. Not the
          // caller's mistake, but its message names the fix, so pass it on.
          return { content: [{ type: "text" as const, text: error.message }], isError: true };
        }
        console.error(`[${SERVER_NAME}] ${tool.name} failed:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Internal error in ${tool.name} (a bug in the tool server, not a mistake in the call): ${message}` }],
          isError: true,
        };
      }
    },
  );
}

/** A server with all three tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of TOOLS) register(server, tool);
  return server;
}
