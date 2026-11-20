/**
 * check-env.ts — checks that this machine can run the lab, one piece at a time.
 *
 * Run it with:  npm run check-env
 *
 * The lab depends on several separate things, and when it does not work
 * the useful question is WHICH one is missing. A single "something is
 * wrong" teaches nothing and fixes nothing. So each check prints its own
 * PASS / FAIL / note line, with what to do next.
 *
 * Checked so far:
 *
 *   1. Node version — the tool server reads the index with node:sqlite,
 *      which needs Node 24 or later.
 *   2. Settings — every value in .env (or its default) is usable: ports
 *      are ports and do not collide, the context window is a sensible
 *      number, the Ollama URL points at this machine, and neither model
 *      is a cloud model.
 *   3. Ollama — running; the chat model installed and able to call tools
 *      (search-tool mode is built on a tool call); the embeddings model
 *      installed and able to embed; llama3.2:3b present for comparison;
 *      no cloud models; and whether Ollama's own local-only switch is on.
 *      "Not running" and "running but the model is missing" need different
 *      fixes, so they are separate lines.
 *   4. The indexes — one file per chunking strategy. Until build step 4
 *      creates `npm run index`, a missing index is a note, not a failure:
 *      nothing can be done about it yet. Step 4 turns it into a failure
 *      and adds the corpus-hash check.
 *
 * This script talks to Ollama with plain fetch calls of its own. The
 * lab's shared model client arrives at build step 8; once it does, this
 * file uses it, so the cloud-model rule lives in one place.
 *
 * ---------------------------------------------------------------------------
 * Why settings are checked as well as read
 * ---------------------------------------------------------------------------
 *
 * Three settings carry the lab's promise that nothing leaves the machine.
 * OLLAMA_URL pointing at another host, or MODEL or EMBED_MODEL naming a
 * ":cloud" model, would each quietly send every question and every
 * retrieved chunk elsewhere — and the lab would still work, which is
 * exactly why each is worth a check that fails loudly.
 */

import "dotenv/config"; // reads .env, if there is one, onto process.env
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChunkStrategy } from "../shared/types.js";

/** The project root, derived from this file rather than from cwd. */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Defaults — kept in step with .env.example. */
const DEFAULTS = {
  PORT: "3400",
  TOOL_SERVER_PORT: "3401",
  OLLAMA_URL: "http://127.0.0.1:11434",
  MODEL: "qwen3.5:4b",
  EMBED_MODEL: "nomic-embed-text",
  NUM_CTX: "8192",
} as const;

/** The second chat model the lab compares against (PLAN §6.1). */
const COMPARED_MODEL = "llama3.2:3b";

/** The lowest Node major with node:sqlite usable unflagged. */
const MIN_NODE_MAJOR = 24;

/** Hostnames that mean "this machine". */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Ollama's own port: the lab's servers must not try to take it. */
const OLLAMA_PORT = 11434;

/**
 * The smallest context window worth running with. Below this, the system
 * prompt, history and four ~300-token chunks leave too little room for
 * the reply, and Ollama silently drops messages from the start of the turn.
 */
const MIN_NUM_CTX = 4096;

/** The index files, one per strategy (PLAN §2). */
const STRATEGIES: readonly ChunkStrategy[] = ["fixed", "heading", "heading+context"];

/** "heading+context" → "data/index-heading-context.db". */
function indexFile(strategy: ChunkStrategy): string {
  return join("data", `index-${strategy.replace("+", "-")}.db`);
}

/** A running tally, so the summary line can say whether anything failed. */
let failures = 0;

function pass(message: string): void {
  console.log(`PASS  ${message}`);
}

function fail(message: string, ...fix: string[]): void {
  failures += 1;
  console.error(`FAIL  ${message}`);
  for (const line of fix) console.error(`      ${line}`);
}

function note(message: string, ...more: string[]): void {
  console.log(`note  ${message}`);
  for (const line of more) console.log(`      ${line}`);
}

/**
 * A setting's value, or its default when unset.
 *
 * An empty string counts as unset: `PORT=` in a .env file is almost
 * always a line someone cleared, not a request for port "".
 */
function setting(name: keyof typeof DEFAULTS): string {
  const value = process.env[name];
  return value === undefined || value === "" ? DEFAULTS[name] : value;
}

/**
 * Parses a port, or returns null if it is not one.
 *
 * Number("") is 0 and Number("abc") is NaN, so both a blank and a typo
 * land in the null branch rather than becoming a port nothing can bind.
 */
function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

/**
 * Whether a model runs on ollama.com rather than this machine: a name
 * ending in ":cloud" or "-cloud", or a /api/tags entry with a remote_*
 * field set. The same rule the prompt injection lab's client enforces.
 */
function isRemoteModel(name: string, entry?: Record<string, unknown>): boolean {
  if (/[:-]cloud$/i.test(name)) return true;
  return entry !== undefined && Object.keys(entry).some((k) => k.startsWith("remote_") && entry[k]);
}

/** /api/tags names a model "qwen3.5:4b"; a bare "nomic-embed-text" means ":latest". */
function tagged(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

// --- 1. Node -----------------------------------------------------------------

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    pass(`Node ${process.versions.node}`);
  } else {
    fail(
      `Node ${process.versions.node} is too old.`,
      "The tool server reads the index with node:sqlite, which needs",
      `Node ${MIN_NODE_MAJOR} or later. Install a current Node 24 release.`,
    );
  }
}

// --- 2. Settings -------------------------------------------------------------

function checkPorts(): void {
  const app = parsePort(setting("PORT"));
  const tools = parsePort(setting("TOOL_SERVER_PORT"));

  if (app === null) {
    fail(`PORT is "${setting("PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (tools === null) {
    fail(`TOOL_SERVER_PORT is "${setting("TOOL_SERVER_PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (app === null || tools === null) return;

  if (app === tools) {
    // Only breaks when both run at once — and the error you get then
    // (EADDRINUSE) does not say which setting caused it.
    fail(`PORT and TOOL_SERVER_PORT are both ${app}.`,
      "The lab and the HTTP tool server need different ports.");
    return;
  }
  if (app === OLLAMA_PORT || tools === OLLAMA_PORT) {
    fail(`A port is set to ${OLLAMA_PORT}, which is Ollama's.`,
      "Whichever starts second will fail to bind.");
    return;
  }
  pass(`PORT = ${app}, TOOL_SERVER_PORT = ${tools}`);
}

/** The Ollama origin if OLLAMA_URL is a local URL, otherwise null (and a FAIL). */
function checkOllamaUrl(): string | null {
  const raw = setting("OLLAMA_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    // new URL throws TypeError for anything unparseable; anything else is
    // a real bug and should surface.
    if (!(error instanceof TypeError)) throw error;
    fail(`OLLAMA_URL is "${raw}", which is not a URL.`,
      `Expected something like ${DEFAULTS.OLLAMA_URL}.`);
    return null;
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    // The lab would work — that is the danger. Every question and every
    // retrieved chunk would cross the network.
    fail(`OLLAMA_URL points at ${url.hostname}, not this machine.`,
      "Every question and every retrieved chunk would be sent there.",
      `Use ${DEFAULTS.OLLAMA_URL} to keep everything local.`);
    return null;
  }
  pass(`OLLAMA_URL = ${url.origin}`);
  return url.origin;
}

/**
 * The two model names, checked for the one thing that can be checked
 * without Ollama running: that neither names a cloud model.
 */
function checkModelNames(): void {
  for (const name of ["MODEL", "EMBED_MODEL"] as const) {
    const model = setting(name);
    if (isRemoteModel(model)) {
      fail(`${name} is "${model}", a cloud model.`,
        "It runs on ollama.com, so every question and chunk would leave this machine.",
        `Use a local model, such as ${DEFAULTS[name]}.`);
    } else {
      pass(`${name} = ${model}`);
    }
  }
}

function checkNumCtx(): void {
  const raw = setting("NUM_CTX");
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`NUM_CTX is "${raw}", which is not a whole number of tokens.`,
      `Expected something like ${DEFAULTS.NUM_CTX}.`);
    return;
  }
  if (value < MIN_NUM_CTX) {
    fail(`NUM_CTX is ${value}, below ${MIN_NUM_CTX}.`,
      "The system prompt, history and retrieved chunks will not fit, and",
      "Ollama drops whole messages silently when that happens.");
    return;
  }
  pass(`NUM_CTX = ${value}`);
}

// --- 3. Ollama -----------------------------------------------------------------

/**
 * Whether Ollama's own local-only mode looks switched on.
 *
 * This script cannot ask the running Ollama server, so it reports what it
 * can see: OLLAMA_NO_CLOUD in this environment, and the setting in
 * ~/.ollama/server.json. A note either way, not a failure — the lab
 * refuses cloud models regardless; this switch makes every OTHER program
 * on the machine refuse them too.
 */
function cloudSwitch(): string | null {
  if (process.env.OLLAMA_NO_CLOUD === "1" || process.env.OLLAMA_NO_CLOUD === "true") return "OLLAMA_NO_CLOUD=1";
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".ollama", "server.json"), "utf8")) as Record<string, unknown>;
    if (config.disable_ollama_cloud === true) return "disable_ollama_cloud in ~/.ollama/server.json";
  } catch {
    // No file, or not JSON: either way, no setting to report.
  }
  return null;
}

/** One /api/tags entry, reduced to the fields this script reads. */
interface TagEntry {
  name: string;
  capabilities: string[];
  parameterSize: string;
  raw: Record<string, unknown>;
}

/**
 * Asks Ollama for its version and installed models. Returns null when
 * nothing is listening, which is the one failure worth its own message.
 *
 * Node's fetch throws a TypeError ("fetch failed") whose `cause` carries
 * the socket error — ECONNREFUSED when Ollama is not running. Matched on
 * the error class and the cause's code, never on the message text.
 */
async function askOllama(origin: string): Promise<{ version: string; models: TagEntry[] } | null> {
  try {
    const version = ((await (await fetch(`${origin}/api/version`)).json()) as { version?: string }).version ?? "unknown";
    const tags = (await (await fetch(`${origin}/api/tags`)).json()) as { models?: Array<Record<string, unknown>> };
    const models = (tags.models ?? []).map((m) => ({
      name: String(m.name ?? ""),
      capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
      parameterSize: String((m.details as Record<string, unknown> | undefined)?.parameter_size ?? "?"),
      raw: m,
    }));
    return { version, models };
  } catch (error: unknown) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof TypeError && (code === "ECONNREFUSED" || code === "ECONNRESET")) return null;
    throw error;
  }
}

async function checkOllama(origin: string | null): Promise<void> {
  // Never contact a non-local Ollama from here: check 2 has already failed
  // it, and the point of that failure is not to send anything there.
  if (origin === null) return;

  const found = await askOllama(origin);
  if (found === null) {
    fail("Ollama is not running.", "Start the Ollama app (or run `ollama serve`), then check again.");
    return;
  }
  pass(`Ollama ${found.version} is running`);

  const local = found.models.filter((m) => !isRemoteModel(m.name, m.raw));
  const installed = (name: string) => local.find((m) => m.name === tagged(name));

  // The chat model must call tools: search-tool mode IS a tool call.
  const model = setting("MODEL");
  const chat = installed(model);
  if (!chat) {
    fail(`MODEL "${model}" is not installed.`, `Run:  ollama pull ${model}`);
  } else if (!chat.capabilities.includes("tools")) {
    fail(`"${model}" cannot call tools, and search-tool mode is built on a tool call.`,
      `Its capabilities: ${chat.capabilities.join(", ") || "unknown"}. Pick a model with "tools".`);
  } else {
    pass(`MODEL ${model} is installed and can call tools (${chat.parameterSize})`);
  }

  // The embeddings model must embed. A chat model in this slot would fail
  // at index time with an error that doesn't say why.
  const embedModel = setting("EMBED_MODEL");
  const embed = installed(embedModel);
  if (!embed) {
    fail(`EMBED_MODEL "${embedModel}" is not installed.`, `Run:  ollama pull ${embedModel}`);
  } else if (!embed.capabilities.includes("embedding")) {
    fail(`"${embedModel}" is not an embeddings model.`,
      `Its capabilities: ${embed.capabilities.join(", ") || "unknown"}. Use ${DEFAULTS.EMBED_MODEL}.`);
  } else {
    pass(`EMBED_MODEL ${embedModel} is installed and can embed`);
  }

  // The comparison model is optional: everything except the model
  // comparison works without it.
  if (tagged(model) !== COMPARED_MODEL) {
    if (installed(COMPARED_MODEL)) {
      pass(`${COMPARED_MODEL} is installed too, so the UI can switch chat models`);
    } else {
      note(`${COMPARED_MODEL} is not installed, so the UI cannot switch to it.`,
        `Run:  ollama pull ${COMPARED_MODEL}`);
    }
  }

  const remote = found.models.filter((m) => isRemoteModel(m.name, m.raw));
  if (remote.length > 0) {
    note(`Cloud models are installed: ${remote.map((m) => m.name).join(", ")}.`,
      "The lab hides and refuses them. Other programs on this machine will not.");
  }

  const cloud = cloudSwitch();
  if (cloud) {
    pass(`Ollama cloud features are off (${cloud})`);
  } else {
    // "Not seen" is not "off": a terminal opened before the variable was
    // set does not have it, even though Ollama (restarted since) does.
    note("Ollama's local-only switch is not visible from this terminal.",
      "If you set OLLAMA_NO_CLOUD=1 after opening this terminal, it is probably on.",
      "Either way the lab refuses cloud models; the switch makes every other",
      "program on the machine refuse them too.");
  }
}

// --- 4. The indexes --------------------------------------------------------------

function checkIndexes(): void {
  const missing = STRATEGIES.filter((s) => !existsSync(join(ROOT, indexFile(s))));
  if (missing.length === 0) {
    pass(`All ${STRATEGIES.length} indexes exist (${STRATEGIES.map(indexFile).join(", ")})`);
    return;
  }
  // A note until build step 4: `npm run index` doesn't exist yet, so a
  // FAIL here would name a fix nobody can apply.
  note(`No index for: ${missing.join(", ")}.`,
    "The indexes are built by `npm run index`, which arrives at build step 4.");
}

// --- Run -----------------------------------------------------------------------

console.log("\nChecking this machine for the RAG lab.\n");
checkNode();
checkPorts();
const origin = checkOllamaUrl();
checkModelNames();
checkNumCtx();
await checkOllama(origin);
checkIndexes();

// "No checks failed", not "everything is ready": while the notes above
// include a missing index, the lab is not ready to answer questions yet.
console.log(failures === 0
  ? "\nNo checks failed. Read any lines marked note above.\n"
  : `\n${failures} check${failures === 1 ? "" : "s"} failed — fix the lines marked FAIL above.\n`);
process.exitCode = failures === 0 ? 0 : 1;
