/**
 * index.test.ts — checks the pieces the index script is built from.
 *
 * Run with:  npm test
 *
 * Three things an index file depends on, each tested without Ollama:
 *
 *   - PCA (tool-server/pca.ts) finds the right axes on data whose answer
 *     is known, in order of spread, with variance shares that add up.
 *     A map that's quietly wrong looks exactly like a map that's right,
 *     so this is checked against numbers, not by eye. (It caught a real
 *     bug: an unnormalized starting vector made power iteration stop
 *     after one step.)
 *   - An index file round-trips (tool-server/db.ts): vectors come back
 *     bit for bit, chunks keep their offsets, and the FTS5 keyword index
 *     finds an exact code like "EP-14" when it's quoted as a phrase.
 *   - The corpus hash (tool-server/corpus.ts) changes when any document
 *     changes, and doesn't change with line endings.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import { chunkDocument, normalizeText, PRESETS } from "../shared/chunk.js";
import { corpusHash, type CorpusDoc } from "../tool-server/corpus.js";
import { readIndex, readIndexSettings, writeIndex, type LoadedIndex } from "../tool-server/db.js";
import { fitPca, project } from "../tool-server/pca.js";

describe("PCA", () => {
  // Points whose principal axes are known exactly: ±10 along one direction,
  // ±3 along another, ±0.1 along a third, and nothing correlated, so the
  // variances are exactly 50, 4.5 and 0.005 (in units of the point count).
  // Then rotated 45° in a 4-dimensional space, so the axes to find are
  // (1, 1, 0, 0)/√2 and (1, -1, 0, 0)/√2, not the coordinate axes.
  const rotate = ([a, b, c]: number[]) =>
    Float32Array.from([(a! + b!) / Math.SQRT2, (a! - b!) / Math.SQRT2, c!, 0.5]);
  const points: Float32Array[] = [];
  for (let i = 0; i < 20; i++) {
    points.push(rotate([10, 0, 0]), rotate([-10, 0, 0]), rotate([0, 3, 0]), rotate([0, -3, 0]), rotate([0, 0, 0.1]), rotate([0, 0, -0.1]));
  }
  const fitted = fitPca(points);
  const close = (a: number, b: number, tolerance = 1e-5) => Math.abs(a - b) < tolerance;

  test("the first axis is the direction of greatest spread", () => {
    const [x] = fitted.axes;
    assert.ok(close(x[0]!, 1 / Math.SQRT2) && close(x[1]!, 1 / Math.SQRT2), `x = ${[...x]}`);
  });

  test("the second axis is the next direction, perpendicular to the first", () => {
    const [x, y] = fitted.axes;
    assert.ok(close(x.reduce((s, v, i) => s + v * y[i]!, 0), 0), "perpendicular");
    assert.ok(close(Math.abs(y[0]!), 1 / Math.SQRT2) && close(y[0]!, -y[1]!), `y = ${[...y]}`);
  });

  test("variance shares match the known variances", () => {
    // Total variance per point: (2·100 + 2·9 + 2·0.01) / 6.
    const total = (200 + 18 + 0.02) / 6;
    assert.ok(close(fitted.variance[0], 200 / 6 / total), `${fitted.variance[0]}`);
    assert.ok(close(fitted.variance[1], 18 / 6 / total), `${fitted.variance[1]}`);
  });

  test("projecting the mean lands at the origin", () => {
    const { x, y } = project(fitted, fitted.mean);
    assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
  });

  test("is deterministic", () => {
    assert.deepEqual(fitPca(points), fitted);
  });
});

describe("index file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-index-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const doc: CorpusDoc = {
    id: "entry-points",
    path: "permits/entry-points.md",
    title: "Entry Points",
    text: "# Entry Points\n\n## Heron Lake\n\nEP-14 is reached by tow boat.\n\n## Fern Creek\n\nEP-07 has a gravel road.\n",
  };
  // 80 characters: each section fits whole, but the two don't fit together.
  const chunks = chunkDocument(doc, "heading", { chunkTokens: 20, overlapTokens: 0 });
  const vectors = chunks.map((_, i) => Float32Array.from({ length: 6 }, (_, j) => Math.fround(Math.sin(i * 7 + j) / 3)));
  const index: LoadedIndex = {
    settings: {
      strategy: "heading", preset: "small", chunkTokens: 8, overlapTokens: 0, embedModel: "test-model", dimensions: 6,
      corpusHash: "abc", builtAt: 1, chunkCount: chunks.length, mapVariance: [0.5, 0.25],
    },
    projection: { mean: new Float32Array(6), axes: [Float32Array.from([1, 0, 0, 0, 0, 0]), Float32Array.from([0, 1, 0, 0, 0, 0])], variance: [0.5, 0.25] },
    documents: [doc],
    // Map positions avoid -0, which SQLite stores as 0.
    chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i]!, map: { x: i + 0.5, y: -(i + 1.25) } })),
  };
  const path = join(dir, "index-heading.db");
  writeIndex(path, index);

  test("round-trips settings, documents, chunks and vectors exactly", () => {
    const loaded = readIndex(path);
    assert.deepEqual(loaded.settings, index.settings);
    assert.deepEqual(loaded.documents, index.documents);
    assert.deepEqual(loaded.chunks, index.chunks);
    assert.deepEqual(loaded.projection, index.projection);
  });

  test("readIndexSettings is null for a missing file", () => {
    assert.equal(readIndexSettings(join(dir, "missing.db")), null);
    assert.equal(readIndexSettings(path)?.chunkCount, chunks.length);
  });

  test("the FTS5 index finds a quoted code, and the raw code is an error", () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const hits = db.prepare(`SELECT c.id FROM chunks_fts JOIN chunks c ON c.n = chunks_fts.rowid WHERE chunks_fts MATCH ?`).all('"EP-14"') as Array<{ id: string }>;
      assert.deepEqual(hits.map((h) => h.id), ["entry-points#heron-lake"]);
      assert.throws(() => db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all("EP-14"), /no such column/);
    } finally {
      db.close();
    }
  });

  test("leaves no temporary file behind", () => {
    assert.equal(readIndexSettings(path.replace(/\.db$/, ".tmp.db")), null);
  });
});

describe("corpus hash", () => {
  const docs: CorpusDoc[] = [
    { id: "a", path: "x/a.md", title: "A", text: "alpha\n" },
    { id: "b", path: "x/b.md", title: "B", text: "bravo\n" },
  ];

  test("is the same for the same documents in any order", () => {
    assert.equal(corpusHash(docs), corpusHash([...docs].reverse()));
  });

  test("changes when any document's text changes", () => {
    assert.notEqual(corpusHash(docs), corpusHash([docs[0]!, { ...docs[1]!, text: "bravo!\n" }]));
  });

  test("doesn't change with line endings, because text is normalized first", () => {
    const crlf = docs.map((d) => ({ ...d, text: normalizeText(d.text.replace(/\n/g, "\r\n")) }));
    assert.equal(corpusHash(docs), corpusHash(crlf));
  });

  test("uses the presets the index script builds with", () => {
    assert.equal(PRESETS.default.chunkTokens, 300);
  });
});
