/**
 * index.ts — the web server: the page, the API, and live log streams.
 *
 * Run it with:  npm run dev      then open http://127.0.0.1:3400
 *
 * It serves public/ (the browser half, compiled in place) and these routes:
 *
 *   GET  /api/meta              models, defaults, presets, index status, documents
 *                               and the question set: everything the page draws from
 *   POST /api/ask               one question, one mode, streamed (Server-Sent Events)
 *   POST /api/compare           one question through all three modes, one after another, streamed
 *   GET  /api/map?strategy=…    the embedding map's points (the index_map tool)
 *   GET  /api/documents/:id     one document's full text (the get_document tool)
 *   POST /api/index/rebuild     rebuild one strategy's index with a size preset, streamed
 *
 * The answer routes run runTurn() (server/turn.ts), the same code as
 * `npm run ask` and the scorecard, with a Logger whose sink writes each
 * row to the stream as it happens. The browser shows the log filling in
 * while the model is still thinking.
 *
 * ---------------------------------------------------------------------------
 * Local only, and checked
 * ---------------------------------------------------------------------------
 *
 * The server listens on 127.0.0.1 only, and every /api request must carry
 * a localhost Host and (when present) Origin header. Without those checks
 * a web page open in your browser could make requests to this server
 * (DNS rebinding) and read the documents through it. A cloud model name
 * is refused here, before any stream opens, as well as in the model client.
 *
 * ---------------------------------------------------------------------------
 * Rebuilding an index
 * ---------------------------------------------------------------------------
 *
 * The app never reads the corpus (PLAN §3.1), so a rebuild runs
 * `npm run index` as a child process and streams its output. The tool
 * server is stopped FIRST: it holds every index file open, and Windows
 * won't let the build rename a new file over an open one. While a build
 * runs, questions are refused; afterwards, the next question starts a
 * fresh tool server, which loads the new index.
 */

import "dotenv/config";

import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { PRESETS } from "../shared/chunk.js";
import { isRemoteModel } from "../shared/local-only.js";
import { classifyAnswer } from "../shared/scoring.js";
import { DEFAULT_PRESET, DEFAULT_SEARCH, DEFAULT_STRATEGY } from "../shared/search-settings.js";
import type { AnswerMode, AskBody, IndexStatus, MapResponse, MetaResponse, Question, StreamEvent } from "../shared/types.js";
import { ToolServerClient } from "./mcp/client.js";
import { listChatModels, ollamaConfig } from "./model/ollama.js";
import { loadQuestions } from "./questions.js";
import { runTurn } from "./turn.js";

const PORT = Number(process.env.PORT || 3400);
const HOST = "127.0.0.1";
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MODES: readonly AnswerMode[] = ["none", "pre-retrieved", "search-tool"];

const app = express();
let tools = new ToolServerClient((line) => console.error(`[tool server] ${line}`));
let rebuilding = false;

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

app.use("/api", (req, res, next) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;
  next();
});
app.use(express.json({ limit: "64kb" }));
app.use(express.static(PUBLIC_DIR));

/** The question set, read per request so an edited file shows without a restart. */
function questions(): Question[] {
  try {
    return loadQuestions();
  } catch {
    return []; // a broken file is `npm run eval -- --check`'s to report
  }
}

/** The question from the set whose text matches exactly (ignoring case), if any. */
function fromSet(text: string): Question | undefined {
  const wanted = text.trim().toLowerCase();
  return questions().find((q) => q.question.trim().toLowerCase() === wanted);
}

// --- Streams --------------------------------------------------------------------------

/** Opens a Server-Sent Events response and returns its send function. */
function openStream(res: express.Response): (event: StreamEvent) => void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

const settingsSchema = z.object({
  mode: z.enum(["vector", "keyword", "hybrid"]),
  topK: z.number().int().min(1).max(16),
  floor: z.number().min(-1).max(1),
  rerank: z.boolean(),
  budgetCheck: z.boolean(),
});
const askSchema: z.ZodType<AskBody> = z.object({
  question: z.string().trim().min(1).max(1000),
  mode: z.enum(["none", "pre-retrieved", "search-tool"]),
  model: z.string().min(1).max(200),
  strategy: z.enum(["fixed", "heading", "heading+context"]),
  settings: settingsSchema,
  think: z.boolean(),
});

/** Validates an ask body, refusing cloud models and requests during a rebuild. */
function parseAsk(req: express.Request, res: express.Response): AskBody | null {
  if (rebuilding) {
    res.status(409).json({ error: "An index is being rebuilt. Ask again when it finishes." });
    return null;
  }
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return null;
  }
  if (isRemoteModel(parsed.data.model)) {
    res.status(400).json({ error: `${parsed.data.model} is a cloud model. This lab only uses local models.` });
    return null;
  }
  return parsed.data;
}

/** Runs one mode, streaming its rows, and sends its summary (scored when the question is from the set). */
async function runOne(body: AskBody, mode: AnswerMode, send: (e: StreamEvent) => void): Promise<void> {
  const summary = await runTurn({ ...body, mode }, (event) => send({ type: "log", event }), tools);
  const question = fromSet(body.question);
  const outcome = question && !summary.error ? classifyAnswer(question, summary.answer).outcome : undefined;
  send({ type: "done", summary, ...(outcome ? { outcome } : {}), ...(question ? { questionId: question.id } : {}) });
}

// --- Routes ---------------------------------------------------------------------------

app.get("/api/meta", async (_req, res) => {
  const meta: MetaResponse = {
    models: [],
    defaultModel: ollamaConfig().model,
    numCtx: ollamaConfig().numCtx,
    defaults: { strategy: DEFAULT_STRATEGY, preset: DEFAULT_PRESET, search: DEFAULT_SEARCH },
    presets: PRESETS,
    indexes: [],
    documents: [],
    questions: questions().map(({ id, category, question }) => ({ id, category, question })),
  };
  const problems: string[] = [];
  try {
    meta.models = (await listChatModels()).map(({ name, supportsThinking }) => ({ name, supportsThinking }));
  } catch (error: unknown) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (!rebuilding) {
    try {
      const listed = await tools.call("list_documents", {});
      if (listed.isError) problems.push(listed.text);
      else {
        const data = listed.data as { documents: MetaResponse["documents"]; indexes: IndexStatus[] };
        meta.documents = data.documents;
        meta.indexes = data.indexes;
      }
    } catch (error: unknown) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) meta.problem = problems.join(" ");
  res.json(meta);
});

app.post("/api/ask", async (req, res) => {
  const body = parseAsk(req, res);
  if (!body) return;
  const send = openStream(res);
  try {
    await runOne(body, body.mode, send);
  } catch (error: unknown) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    send({ type: "finished" });
    res.end();
  }
});

app.post("/api/compare", async (req, res) => {
  const body = parseAsk(req, res);
  if (!body) return;
  const send = openStream(res);
  try {
    // One at a time: the modes share one GPU, and timing them side by side
    // would measure contention, not the mode.
    for (const mode of MODES) await runOne(body, mode, send);
  } catch (error: unknown) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    send({ type: "finished" });
    res.end();
  }
});

const strategySchema = z.enum(["fixed", "heading", "heading+context"]);

app.get("/api/map", async (req, res) => {
  const strategy = strategySchema.safeParse(req.query.strategy ?? DEFAULT_STRATEGY);
  if (!strategy.success) return void res.status(400).json({ error: "strategy must be fixed, heading or heading+context" });
  if (rebuilding) return void res.status(409).json({ error: "An index is being rebuilt." });
  try {
    const outcome = await tools.call("index_map", { strategy: strategy.data });
    if (outcome.isError) return void res.status(404).json({ error: outcome.text });
    res.json(outcome.data as MapResponse);
  } catch (error: unknown) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/documents/:id", async (req, res) => {
  if (rebuilding) return void res.status(409).json({ error: "An index is being rebuilt." });
  try {
    const outcome = await tools.call("get_document", { id: req.params.id });
    if (outcome.isError) return void res.status(404).json({ error: outcome.text });
    res.json(outcome.data);
  } catch (error: unknown) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const rebuildSchema = z.object({ strategy: strategySchema, preset: z.enum(["small", "default", "large"]) });

app.post("/api/index/rebuild", async (req, res) => {
  const parsed = rebuildSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.message });
  if (rebuilding) return void res.status(409).json({ error: "A rebuild is already running." });

  rebuilding = true;
  const send = openStream(res);
  try {
    // Stop the tool server first: it holds the index files open (see the header).
    await tools.close();
    tools = new ToolServerClient((line) => console.error(`[tool server] ${line}`));

    const built = import.meta.url.endsWith(".js");
    const script = fileURLToPath(new URL(`../scripts/index.${built ? "js" : "ts"}`, import.meta.url));
    const args = [...(built ? [] : ["--import", "tsx"]), script, "--strategy", parsed.data.strategy, "--preset", parsed.data.preset];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    // The index script redraws its progress line with \r; each redraw is a line here.
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/[\r\n]+/)) {
        if (line.trim() && !/ExperimentalWarning|trace-warnings/.test(line)) send({ type: "progress", line: line.trimEnd() });
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (code !== 0) send({ type: "error", message: `The index build exited with code ${code}. The previous index is unchanged.` });
  } catch (error: unknown) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    rebuilding = false;
    send({ type: "finished" });
    res.end();
  }
});

// --- Start ----------------------------------------------------------------------------

const server = app.listen(PORT, HOST, (error?: Error) => {
  // Express 5 reports a failed listen (port in use, say) through this
  // callback, not by throwing.
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Is the lab already running? Stop it, or set PORT in .env.`
      : `Could not listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Local RAG Lab: http://${HOST}:${PORT}  (localhost only)`);
});

// Stop the tool server with the app, so it doesn't outlive us holding the
// index files open.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void tools.close().finally(() => process.exit(0));
  });
}
