/**
 * http.ts — runs the same tool server over Streamable HTTP, for MCP Inspector.
 *
 * Run it with:  npm run tool-server:http
 * Then point MCP Inspector (or any MCP client) at http://127.0.0.1:3401/mcp
 *
 * The app never uses this; it talks to the tool server over stdio. This
 * exists so a developer can call search_docs by hand, with any settings,
 * and see the raw result, which is the fastest way to understand what the
 * app is working with.
 *
 * It listens on 127.0.0.1 only, and checks the Host and Origin headers of
 * every request. Without those checks, a web page open in your browser
 * could send requests to a server on localhost (DNS rebinding) and read
 * the documents through it.
 */

import "dotenv/config"; // TOOL_SERVER_PORT, OLLAMA_URL, EMBED_MODEL

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express from "express";

import { loadIndexes } from "./indexes.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";

const PORT = Number(process.env.TOOL_SERVER_PORT || 3401);
const HOST = "127.0.0.1";

const report = loadIndexes();

const mcpHandler = createMcpHandler(createServer, {
  responseMode: "auto",
  onerror(error) {
    console.error(`[${SERVER_NAME}] handler error: ${error.message}`);
  },
});
const mcpNodeHandler = toNodeHandler(mcpHandler, {
  onerror(error) {
    console.error(`[${SERVER_NAME}] adapter error: ${error.message}`);
  },
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const app = express();

/**
 * The MCP endpoint. `app.all`, not `app.post`: Streamable HTTP also uses
 * GET (a standalone event stream) and DELETE (ending a session).
 */
app.all("/mcp", (req, res) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;
  const started = Date.now();
  res.on("finish", () => console.log(`${req.method} /mcp → ${res.statusCode} (${Date.now() - started} ms)`));
  void mcpNodeHandler(req, res);
});

/** A plain answer for anyone who opens the port in a browser. */
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `${SERVER_NAME} ${SERVER_VERSION}\n\nThis is an MCP server. Point an MCP client at http://${HOST}:${PORT}/mcp\n`,
  );
});

app.listen(PORT, HOST, (error?: Error) => {
  // Express 5 reports a failed listen (port in use, say) through this
  // callback rather than by throwing.
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Stop the other copy, or set TOOL_SERVER_PORT in .env.`
      : `Could not listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`${SERVER_NAME} ${SERVER_VERSION}: MCP over HTTP at http://${HOST}:${PORT}/mcp (localhost only)`);
  for (const line of report) console.log(`  index ${line}`);
});
