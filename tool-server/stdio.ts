/**
 * stdio.ts — runs the tool server over stdio, as the app's child process.
 *
 * The app starts this file as a separate process and speaks MCP to it
 * through its stdin and stdout. Keeping retrieval in its own process
 * makes the boundary real: the app can only learn about the corpus by
 * calling a tool, and every call is something the log can show.
 *
 * Over stdio, stdout IS the protocol. Anything printed to it that isn't
 * an MCP message corrupts the stream, so every diagnostic here, and in
 * every file this process loads, goes to stderr.
 *
 * At startup it loads the indexes and says, on stderr, which ones loaded
 * and whether any is stale. If none loaded, it still starts: list_documents
 * and search_docs then answer with the fix (npm run index) rather than the
 * process dying with an error the app would have to dig out of stderr.
 */

import "dotenv/config"; // OLLAMA_URL and EMBED_MODEL, for embedding queries

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadIndexes } from "./indexes.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";

const report = loadIndexes();

const handle = serveStdio(createServer, {
  // Failures that belong to no particular request, such as a malformed
  // frame. There's nowhere to return them to, so: stderr.
  onerror(error) {
    console.error(`[${SERVER_NAME}] ${error.message}`);
  },
});

console.error(`[${SERVER_NAME} ${SERVER_VERSION}] serving 4 tools over stdio. Indexes: ${report.join("; ")}.`);

// Close the transport cleanly when the parent stops us, so a response in
// flight isn't cut off halfway.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
