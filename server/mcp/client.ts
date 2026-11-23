/**
 * client.ts — the app's side of MCP: starts the tool server and calls its tools.
 *
 * The tool server (tool-server/) is the only code that reads the corpus
 * and the indexes. The app reaches it the way any MCP host reaches any
 * tool server: it spawns the process, speaks MCP over its stdin and
 * stdout, and calls tools by name. Every search in the lab, whoever
 * decided to make it, is one of these calls, which is what lets the log
 * show every one.
 *
 * Two details:
 *
 *   - The child is started with the same Node that runs the app, through
 *     tsx while developing and from dist/ after a build. Spawning "npx" or
 *     "tsx" by name would need a shell on Windows.
 *   - The child's stderr is passed to a callback. The tool server writes
 *     its startup report there (which indexes loaded, whether any is
 *     stale), and the last line it wrote is the likeliest explanation if
 *     it dies.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ChunkStrategy, SearchMode, SearchResult } from "../../shared/types.js";

/** What one tool call produced, unpacked from the MCP result. */
export interface ToolCallOutcome {
  /** The text content: what MCP Inspector would show. */
  text: string;
  isError: boolean;
  /** The structured result; null on error. */
  data: unknown;
  elapsedMs: number;
}

/** The tool server could not be started or reached. */
export class ToolServerUnavailableError extends Error {
  override name = "ToolServerUnavailableError";
}

/** search_docs answered with an error (an index not built, Ollama stopped). */
export class SearchFailedError extends Error {
  override name = "SearchFailedError";
}

/** The command that starts the tool server, matching how THIS file is running. */
function toolServerCommand(): { command: string; args: string[] } {
  const built = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(`../../tool-server/stdio.${built ? "js" : "ts"}`, import.meta.url));
  return { command: process.execPath, args: built ? [entry] : ["--import", "tsx", entry] };
}

/** The first text block of an MCP result. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const block = content.find((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
  return String(block?.text ?? "");
}

export class ToolServerClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private lastStderr = "";

  constructor(private readonly onStderr: (line: string) => void = () => {}) {}

  /** Connects if needed. Concurrent callers share one attempt. */
  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const { command, args } = toolServerCommand();
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
    (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim() || /ExperimentalWarning|trace-warnings/.test(line)) continue;
        this.lastStderr = line.trim();
        this.onStderr(line.trim());
      }
    });

    const client = new Client({ name: "local-rag-lab", version: "0.1.0" });
    client.onclose = () => {
      // The child exited or the pipe broke. The next call starts a fresh one.
      this.client = undefined;
    };
    try {
      await client.connect(transport);
    } catch (error: unknown) {
      throw new ToolServerUnavailableError(`The tool server did not start: ${this.lastStderr || (error instanceof Error ? error.message : String(error))}`);
    }
    this.client = client;
    return client;
  }

  /** Calls one tool and unpacks the result. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.connection();
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const isError = result.isError === true;
    return { text: textOf(result.content), isError, data: isError ? null : (result.structuredContent ?? null), elapsedMs: performance.now() - started };
  }

  /** One tool's definition, as the tool server advertises it. */
  async toolDefinition(name: string): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const client = await this.connection();
    const tool = (await client.listTools()).tools.find((t) => t.name === name);
    if (!tool) throw new ToolServerUnavailableError(`The tool server doesn't offer ${name}.`);
    return { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown> };
  }

  /** search_docs, typed. Throws SearchFailedError with the tool's own message when it fails. */
  async searchDocs(args: { query: string; strategy: ChunkStrategy; mode: SearchMode; floor: number }): Promise<{ result: SearchResult; elapsedMs: number }> {
    const outcome = await this.call("search_docs", args);
    if (outcome.isError) throw new SearchFailedError(outcome.text);
    return { result: outcome.data as SearchResult, elapsedMs: outcome.elapsedMs };
  }

  /** Stops the tool server. */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
