/**
 * corpus.ts — reads the outfitter's documents from corpus/ into memory.
 *
 * The corpus is a folder of Markdown files (see corpus/README.md for what
 * each one is and which traps it holds). This file turns it into a list
 * of SourceDoc objects: an id, a title and the normalized text. Chunking
 * happens elsewhere (shared/chunk.ts), because chunking must not depend
 * on the file system — the tests feed it text directly.
 *
 * It lives in tool-server/ because the tool server is the only part of
 * the lab that reads the corpus (PLAN §3.1). The index script imports it
 * from here rather than keeping a second reader that could drift.
 *
 * Three rules, each one a decision worth seeing:
 *
 *   - README.md files are skipped. corpus/README.md describes the traps;
 *     indexing it would let retrieval find the answer key.
 *   - A document's id is its file name without ".md". Ids must be unique
 *     across folders, so a duplicate name is an error, not a silent
 *     overwrite.
 *   - Files are read in sorted path order, so every machine builds the
 *     same chunks in the same order.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeText, type SourceDoc } from "../shared/chunk.js";

/** corpus/, found from this file rather than from the current directory. */
export const CORPUS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "corpus");

/** A corpus document, plus where it lives. */
export interface CorpusDoc extends SourceDoc {
  /** Path relative to corpus/, with forward slashes: "policies/rates-2026.md". */
  path: string;
}

/** Every .md file under a folder, recursively, except README.md. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") found.push(full);
  }
  return found;
}

/** Reads the whole corpus. Throws if two files share a name. */
export function loadCorpus(dir: string = CORPUS_DIR): CorpusDoc[] {
  const files = markdownFiles(dir)
    .map((full) => ({ full, path: relative(dir, full).replace(/\\/g, "/") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const seen = new Map<string, string>();
  return files.map(({ full, path }) => {
    const id = basename(path, ".md");
    const clash = seen.get(id);
    if (clash) throw new Error(`Two corpus documents share the id "${id}": ${clash} and ${path}`);
    seen.set(id, path);

    const text = normalizeText(readFileSync(full, "utf8"));
    const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1] ?? id;
    return { id, path, title, text };
  });
}
