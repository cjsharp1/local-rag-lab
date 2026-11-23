/**
 * try-tools.ts — calls every tool over MCP, with no model involved.
 *
 * Run it with:  npm run try-tools      (needs Ollama: queries are embedded)
 *
 * Starts the tool server as a child process, connects to it over stdio,
 * exactly as the app will, and checks each promise the search tools make:
 * the three tools are there, documents can be listed and read, raw text
 * with codes and punctuation can be searched, the floor rule works the
 * way PLAN §4.2 says in each mode, and the late-fee question finds the
 * late-fee chunk.
 *
 * Then it prints a finding rather than a test: for queries that hinge on
 * an exact code (EP-14, KB-7, a product name), where the chunk holding
 * that code ranks under keyword search and under vector search. PLAN §1
 * predicts keyword search finds codes and vector search misses them.
 * Whatever this prints is recorded as measured, including where the
 * prediction is wrong; nothing is tuned to make it come true.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { SearchResult } from "../shared/types.js";

const STDIO_ENTRY = fileURLToPath(new URL("../tool-server/stdio.ts", import.meta.url));

const client = new Client({ name: "try-tools", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });

/** One call's outcome, unpacked. */
interface Outcome {
  text: string;
  isError: boolean;
  data: Record<string, unknown> | undefined;
  /** Set when the call threw instead of returning (a protocol-level error). */
  thrown?: string;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    return { text, isError: result.isError === true, data: result.structuredContent as Record<string, unknown> | undefined };
  } catch (error: unknown) {
    return { text: "", isError: true, data: undefined, thrown: error instanceof Error ? error.message : String(error) };
  }
}

const searchDocs = async (args: Record<string, unknown>) => {
  const o = await call("search_docs", args);
  return { o, r: o.data as unknown as SearchResult | undefined };
};

/** null on success, otherwise what went wrong. */
type Check = () => Promise<string | null>;
const expect = (ok: boolean, detail: string): string | null => (ok ? null : detail);

const CASES: Array<[string, Check]> = [
  ["the server offers exactly search_docs, get_document, list_documents and index_map", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
    return expect(names === "get_document,index_map,list_documents,search_docs", names);
  }],

  ["list_documents lists 25 documents and three fresh indexes", async () => {
    const o = await call("list_documents");
    const d = o.data as { documents: unknown[]; indexes: Array<{ strategy: string; stale: boolean }> } | undefined;
    return expect(d?.documents.length === 25 && d.indexes.length === 3 && d.indexes.every((i) => !i.stale), o.text.slice(0, 300));
  }],

  ["index_map returns a position for every chunk of the index asked for", async () => {
    const o = await call("index_map", { strategy: "fixed" });
    const d = o.data as { strategy: string; chunks: Array<{ x: number; y: number }>; variance: number[] } | undefined;
    return expect(d?.strategy === "fixed" && d.chunks.length === 148 && d.chunks.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)) && (d.variance[0] ?? 0) > 0,
      o.text.slice(0, 200));
  }],

  ["get_document reads a document by id, or by a whole chunk label", async () => {
    const a = await call("get_document", { id: "rental-agreement" });
    const b = await call("get_document", { id: "[rental-agreement#late-returns-and-the-late-fee]" });
    return expect(!a.isError && !b.isError && String(a.data?.text).includes("$35 per boat") && a.data?.text === b.data?.text, a.text.slice(0, 200));
  }],

  ["get_document with an unknown id is an error that says what to do", async () => {
    const o = await call("get_document", { id: "price-list" });
    return expect(o.isError && o.text.includes("list_documents"), o.text);
  }],

  ["raw text with a code and a question mark searches cleanly (FTS5 would throw on it)", async () => {
    const { o, r } = await searchDocs({ query: "What about EP-14?" });
    return expect(!o.isError && r?.keywordQuery === '"about" OR "ep-14"' && (r?.ignoredWords ?? []).includes("what"), o.thrown ?? o.text.slice(0, 300));
  }],

  ["a query of only common words has no keyword query, and hybrid still returns vector matches", async () => {
    const { o, r } = await searchDocs({ query: "what is the" });
    return expect(!o.isError && r?.keywordQuery === null && (r?.candidates.length ?? 0) > 0, o.text.slice(0, 300));
  }],

  ["vector mode: the floor removes chunks, and a floor of 0.99 removes everything", async () => {
    const { r } = await searchDocs({ query: "late return fee", mode: "vector", floor: 0.99 });
    return expect(r?.candidates.length === 0 && r.belowFloor.count === r.totalChunks, JSON.stringify(r?.belowFloor));
  }],

  ["keyword mode: the floor doesn't apply", async () => {
    const low = await searchDocs({ query: "late return fee", mode: "keyword", floor: -1 });
    const high = await searchDocs({ query: "late return fee", mode: "keyword", floor: 0.99 });
    return expect((low.r?.candidates.length ?? 0) > 0 && low.r?.candidates.length === high.r?.candidates.length && high.r?.belowFloor.count === 0,
      `${low.r?.candidates.length} vs ${high.r?.candidates.length}`);
  }],

  ["hybrid mode: a keyword match below the vector floor survives; vector-only chunks don't", async () => {
    const { r } = await searchDocs({ query: "late return fee", mode: "hybrid", floor: 0.99 });
    const keywordOnly = await searchDocs({ query: "late return fee", mode: "keyword" });
    const allKeyword = (r?.candidates ?? []).every((c) => c.keywordRank !== undefined && c.vectorScore < 0.99);
    return expect((r?.candidates.length ?? 0) > 0 && allKeyword && r?.candidates.length === keywordOnly.r?.candidates.length,
      `${r?.candidates.length} candidates`);
  }],

  ["hybrid at the default floor: the late-fee chunk is in the top 4 for the walkthrough question", async () => {
    const { r } = await searchDocs({ query: "What's the fee if we bring the canoe back a day late?" });
    const top = (r?.candidates ?? []).slice(0, 4);
    return expect(top.some((c) => c.text.includes("$35 per boat")), top.map((c) => c.chunkId).join(", "));
  }],

  ["candidates carry every score: vector, keyword and fused, with ranks", async () => {
    const { r } = await searchDocs({ query: "late return fee" });
    const c = r?.candidates[0];
    return expect(c !== undefined && c.vectorRank !== undefined && c.fusedRank === 1 && c.fusedScore !== undefined && r?.queryMap !== undefined,
      JSON.stringify(c && { ...c, text: undefined }));
  }],

  ["the strategy argument picks the index: fixed returns numbered chunks", async () => {
    const { r } = await searchDocs({ query: "late return fee", strategy: "fixed" });
    return expect(r?.strategy === "fixed" && (r?.candidates ?? []).every((c) => /#\d+$/.test(c.chunkId)), r?.candidates[0]?.chunkId ?? "none");
  }],

  ["an empty query is refused before the tool runs", async () => {
    const o = await call("search_docs", { query: "   " });
    return expect(o.isError || o.thrown !== undefined, o.text);
  }],
];

/** Where the first chunk containing `needle` ranks in each mode. */
async function codeRanks(query: string, needle: string): Promise<string> {
  const rank = async (mode: string) => {
    const { r } = await searchDocs({ query, mode, floor: -1 });
    const i = (r?.candidates ?? []).findIndex((c) => c.text.includes(needle));
    return i < 0 ? "—" : `#${i + 1}`;
  };
  const [keyword, vector, hybrid] = [await rank("keyword"), await rank("vector"), await rank("hybrid")];
  return `${query.padEnd(44)} ${needle.padEnd(22)} ${keyword.padStart(7)} ${vector.padStart(7)} ${hybrid.padStart(7)}`;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", STDIO_ENTRY], stderr: "pipe" });
  // The tool server's stderr, shown only when it says something unexpected.
  (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() && !/ExperimentalWarning|trace-warnings|serving 4 tools/.test(line)) console.error(`      [tool server] ${line.trim()}`);
    }
  });
  await client.connect(transport);

  console.log(`\nCalling the tools over MCP (stdio), no model. ${CASES.length} cases.\n`);
  let failed = 0;
  for (const [label, run] of CASES) {
    const problem = await run();
    if (problem === null) console.log(`PASS  ${label}`);
    else {
      failed += 1;
      console.log(`FAIL  ${label}\n      ${problem.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }

  console.log("\nFinding: where the chunk holding an exact code ranks (default index, no floor).\n");
  console.log(`${"Query".padEnd(44)} ${"Chunk contains".padEnd(22)} ${"keyword".padStart(7)} ${"vector".padStart(7)} ${"hybrid".padStart(7)}`);
  for (const [query, needle] of [
    ["EP-14", "| EP-14 |"],
    ["How much is the EP-14 shuttle?", "EP-14, tow boat"],
    ["Which entry point is EP-14?", "| EP-14 |"],
    ["KB-7", "KB-7"],
    ["What does KB-13 prohibit?", "KB-13"],
    ["How heavy is the Kestrel 15?", "32 lb"],
    ["StormCell 2", "StormCell 2"],
  ] as const) {
    console.log(await codeRanks(query, needle));
  }

  await client.close();
  console.log(failed === 0 ? `\nAll ${CASES.length} cases passed.\n` : `\n${failed} of ${CASES.length} cases failed.\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
