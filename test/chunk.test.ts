/**
 * chunk.test.ts — checks the chunker's promises (shared/chunk.ts).
 *
 * Run with:  npm test
 *
 * Every number the scorecard publishes starts here. If chunks cut words
 * in half, overlap by the wrong amount, drift from their recorded offsets
 * or cut through a section the heading strategy promised to keep whole,
 * then retrieval scores measure the chunker's bugs, not the strategies.
 * So these tests pin down the promises one at a time:
 *
 *   - a chunk's text is exactly docText.slice(start, end);
 *   - no chunk starts or ends mid-word;
 *   - fixed chunks overlap by exactly the declared amount, snapped to the
 *     first whole word inside it;
 *   - heading chunks never cut a section that fits, merge empty headings
 *     forward, pack short sections, and keep table rows whole;
 *   - heading+context makes the same cuts as heading and only changes
 *     what's embedded;
 *   - all of the above hold on the real corpus, at every preset.
 *
 * Small synthetic documents test each rule in isolation; the real corpus
 * test catches whatever the synthetic ones didn't imagine.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chunkDocument, estimateTokens, normalizeText, PRESETS, type Chunk, type SourceDoc } from "../shared/chunk.js";
import type { ChunkStrategy } from "../shared/types.js";
import { loadCorpus } from "../tool-server/corpus.js";

const STRATEGIES: readonly ChunkStrategy[] = ["fixed", "heading", "heading+context"];

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** The invariants every chunk of every strategy must satisfy. */
function assertWellFormed(doc: SourceDoc, chunks: Chunk[], maxChars: number): void {
  const ids = new Set<string>();
  for (const c of chunks) {
    assert.equal(c.text, doc.text.slice(c.start, c.end), `${c.id}: text matches its offsets`);
    assert.ok(c.text.length > 0, `${c.id}: not empty`);
    assert.ok(!isSpace(c.text[0]) && !isSpace(c.text[c.text.length - 1]), `${c.id}: trimmed`);
    assert.ok(c.start === 0 || isSpace(doc.text[c.start - 1]), `${c.id}: starts on a word boundary`);
    assert.ok(c.end === doc.text.length || isSpace(doc.text[c.end]), `${c.id}: ends on a word boundary`);
    assert.ok(c.text.length <= maxChars, `${c.id}: ${c.text.length} chars, over ${maxChars}`);
    assert.equal(c.estimatedTokens, estimateTokens(c.text));
    assert.equal(c.docId, doc.id);
    assert.ok(!ids.has(c.id), `${c.id}: unique`);
    ids.add(c.id);
  }
}

/** Every word in the document lies inside at least one chunk. */
function assertCovers(doc: SourceDoc, chunks: Chunk[]): void {
  for (const word of doc.text.matchAll(/\S+/g)) {
    const at = word.index;
    assert.ok(
      chunks.some((c) => c.start <= at && at + word[0].length <= c.end),
      `word "${word[0]}" at ${at} is in a chunk`,
    );
  }
}

/** A document of numbered words: "w001 w002 …", easy to reason about. */
function wordsDoc(count: number): SourceDoc {
  const text = Array.from({ length: count }, (_, i) => `w${String(i + 1).padStart(3, "0")}`).join(" ");
  return { id: "words", title: "words", text };
}

describe("normalizeText", () => {
  test("turns CRLF and lone CR into LF and drops a byte-order mark", () => {
    assert.equal(normalizeText("﻿a\r\nb\rc\n"), "a\nb\nc\n");
  });
});

describe("estimateTokens", () => {
  test("is characters ÷ 4, rounded up", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });
});

describe("fixed", () => {
  const size = { chunkTokens: 10, overlapTokens: 3 }; // 40 chars, 12 chars of overlap
  const doc = wordsDoc(60); // each word is 4 chars plus a space

  test("chunks are well formed and cover the document", () => {
    const chunks = chunkDocument(doc, "fixed", size);
    assertWellFormed(doc, chunks, 40);
    assertCovers(doc, chunks);
  });

  test("overlap is exact: the next chunk starts at the first word beginning within the overlap", () => {
    const chunks = chunkDocument(doc, "fixed", size);
    const wordStarts = [...doc.text.matchAll(/\S+/g)].map((m) => m.index);
    for (let i = 0; i < chunks.length - 1; i++) {
      const cur = chunks[i]!;
      const next = chunks[i + 1]!;
      const expected = wordStarts.find((s) => s >= cur.end - 12 && s > cur.start);
      assert.equal(next.start, expected, `chunk ${i + 2} starts where the overlap rule says`);
      assert.ok(cur.end - next.start <= 12, "overlap never exceeds the declared amount");
    }
  });

  test("zero overlap means consecutive chunks share nothing", () => {
    const chunks = chunkDocument(doc, "fixed", { chunkTokens: 10, overlapTokens: 0 });
    for (let i = 0; i < chunks.length - 1; i++) assert.ok(chunks[i + 1]!.start > chunks[i]!.end);
  });

  test("ignores structure: it can cut a table row in two", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| Item number ${i + 1} | $${10 + i} per day |`).join("\n");
    const table: SourceDoc = { id: "t", title: "t", text: `| Item | Price |\n|---|---|\n${rows}` };
    const sourceLines = new Set(table.text.split("\n"));
    const chunks = chunkDocument(table, "fixed", { chunkTokens: 25, overlapTokens: 0 });
    const pieces = chunks.flatMap((c) => c.text.split("\n")).filter((line) => !sourceLines.has(line));
    assert.ok(pieces.length > 0, "at least one row is cut into pieces");
  });

  test("ids count from 1 and there is no heading path", () => {
    const chunks = chunkDocument(doc, "fixed", size);
    assert.deepEqual(chunks.slice(0, 2).map((c) => c.id), ["words#1", "words#2"]);
    assert.ok(chunks.every((c) => c.headingPath.length === 0 && c.embedText === c.text));
  });

  test("rejects an overlap as large as the chunk", () => {
    assert.throws(() => chunkDocument(doc, "fixed", { chunkTokens: 10, overlapTokens: 10 }), RangeError);
  });
});

describe("heading", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
  const rows = Array.from({ length: 10 }, (_, i) => `| Row ${i + 1} | value ${i + 1} |`).join("\n");
  const doc: SourceDoc = {
    id: "guide",
    title: "Guide",
    text: normalizeText(
      [
        "# Guide",
        "",
        "A short intro.",
        "",
        "## Alpha",
        "",
        "Alpha is short.",
        "",
        "## Bravo",
        "",
        "### Bravo One",
        "",
        "Bravo one is short too.",
        "",
        "## Charlie",
        "",
        long,
        "",
        "## Table",
        "",
        "| Name | Value |",
        "|---|---|",
        rows,
        "",
      ].join("\n"),
    ),
  };
  const size = { chunkTokens: 50, overlapTokens: 8 }; // 200 chars
  const chunks = chunkDocument(doc, "heading", size);

  test("chunks are well formed and cover the document", () => {
    assertWellFormed(doc, chunks, 200);
    assertCovers(doc, chunks);
  });

  test("an empty heading merges into the next section", () => {
    const bravo = chunks.find((c) => c.text.includes("## Bravo"));
    assert.ok(bravo?.text.includes("### Bravo One"), "## Bravo travels with ### Bravo One");
  });

  test("short sections are packed, and the path is what they share", () => {
    const first = chunks[0]!;
    assert.ok(first.text.includes("A short intro.") && first.text.includes("Alpha is short.") && first.text.includes("Bravo one"));
    assert.deepEqual(first.headingPath, ["Guide"]);
    assert.equal(first.id, "guide#guide");
  });

  test("a section that fits is never cut", () => {
    for (const marker of ["## Alpha", "### Bravo One"]) {
      const sectionText = doc.text.slice(doc.text.indexOf(marker)).split(/\n(?=#)/)[0]!.trim();
      assert.ok(chunks.some((c) => c.text.includes(sectionText)), `${marker} is whole inside one chunk`);
    }
  });

  test("an oversized section is cut into numbered parts that keep its path", () => {
    const parts = chunks.filter((c) => c.headingPath.at(-1) === "Charlie");
    assert.ok(parts.length >= 2);
    assert.deepEqual(parts.map((c) => c.id).slice(0, 2), ["guide#charlie", "guide#charlie-2"]);
    assert.ok(parts.every((c) => c.headingPath.join(">") === "Guide>Charlie"));
    assert.ok(!parts[1]!.text.includes("## Charlie"), "later parts lose the heading line");
  });

  test("table rows are never cut in two, at either end of a chunk", () => {
    const sourceLines = new Set(doc.text.split("\n"));
    const tableChunks = chunks.filter((c) => c.text.includes("|"));
    assert.ok(tableChunks.length >= 2, "the fixture's table really is split");
    for (const c of tableChunks) {
      for (const line of c.text.split("\n")) {
        if (line.includes("|")) assert.ok(sourceLines.has(line), `a whole source row, not a piece of one: "${line}"`);
      }
    }
  });

  test("text before the first heading becomes an intro chunk", () => {
    const preamble: SourceDoc = { id: "p", title: "p", text: "Before any heading.\n\n# Title\n\nBody." };
    const out = chunkDocument(preamble, "heading", { chunkTokens: 5, overlapTokens: 0 });
    assert.equal(out[0]!.id, "p#intro");
    assert.deepEqual(out[0]!.headingPath, []);
  });
});

describe("heading+context", () => {
  const doc = loadCorpus().find((d) => d.id === "rental-agreement")!;

  test("makes the same cuts as heading", () => {
    const plain = chunkDocument(doc, "heading", PRESETS.default);
    const withContext = chunkDocument(doc, "heading+context", PRESETS.default);
    assert.deepEqual(
      withContext.map(({ id, start, end, text }) => ({ id, start, end, text })),
      plain.map(({ id, start, end, text }) => ({ id, start, end, text })),
    );
  });

  test("embeds the title and heading path before the text", () => {
    for (const c of chunkDocument(doc, "heading+context", PRESETS.default)) {
      const context = c.headingPath[0] === doc.title ? c.headingPath : [doc.title, ...c.headingPath];
      assert.equal(c.embedText, `${context.join(" > ")}\n\n${c.text}`);
    }
  });
});

describe("the real corpus", () => {
  const docs = loadCorpus();

  test("loads 25 documents, skipping README.md", () => {
    assert.equal(docs.length, 25);
    assert.ok(!docs.some((d) => d.id.toLowerCase() === "readme"));
    assert.ok(docs.every((d) => !d.text.includes("\r")), "line endings are normalized");
  });

  for (const strategy of STRATEGIES) {
    for (const [preset, size] of Object.entries(PRESETS)) {
      test(`${strategy} / ${preset}: well formed and covering`, () => {
        for (const doc of docs) {
          const chunks = chunkDocument(doc, strategy, size);
          assertWellFormed(doc, chunks, size.chunkTokens * 4);
          assertCovers(doc, chunks);
          if (strategy !== "fixed") {
            // The rate and damage tables: every row stays whole.
            const sourceLines = new Set(doc.text.split("\n"));
            for (const c of chunks) {
              for (const line of c.text.split("\n")) {
                if (line.startsWith("|")) assert.ok(sourceLines.has(line), `${c.id}: whole row "${line}"`);
              }
            }
          }
        }
      });
    }
  }

  test("chunking is deterministic", () => {
    const a = docs.flatMap((d) => chunkDocument(d, "heading", PRESETS.default));
    const b = docs.flatMap((d) => chunkDocument(d, "heading", PRESETS.default));
    assert.deepEqual(a, b);
  });
});
