/**
 * chunk.ts — cuts a document into the pieces that get embedded, searched
 * and pasted into a model's request.
 *
 * Chunking is the first decision in any RAG system, and the one people
 * think about least. A model only ever sees chunks, never documents, so a
 * fact that's split across two chunks, or a chunk that doesn't say what
 * it's about, is a fact retrieval can't hand over intact. This file holds
 * the three strategies the lab compares (PLAN §4.1):
 *
 *   fixed            Cut every N tokens, with M tokens of overlap, wherever
 *                    that lands. Never mid-word, but happily mid-sentence,
 *                    mid-table and mid-procedure. The baseline everyone
 *                    starts with.
 *   heading          Respect Markdown sections: whole consecutive sections
 *                    are packed into a chunk up to N tokens, and a chunk
 *                    never cuts through a section unless that section alone
 *                    is longer than N. A long section is cut preferring a
 *                    paragraph break, then a line break (which keeps table
 *                    rows whole), then a sentence end.
 *   heading+context  The same chunks as `heading`, but the text that gets
 *                    EMBEDDED starts with the document title and heading
 *                    path. A chunk that only says "this fee is waived" is
 *                    embedded as "Rental Agreement > Late returns … this fee
 *                    is waived". The chunk's own text, the part that's
 *                    scored and shown to the model, is unchanged.
 *
 * It lives in shared/ because two programs need the exact same cuts: the
 * index script, which embeds them, and the tests, which check them. It
 * has no Node imports, so it can't read files; callers pass text in.
 *
 * ---------------------------------------------------------------------------
 * Tokens are estimated, not counted
 * ---------------------------------------------------------------------------
 *
 * Sizes are in tokens, estimated as characters ÷ 4. That is a heuristic:
 * the embeddings model and the chat model each have their own tokenizer,
 * and neither is available here without a round trip to Ollama. In step 0,
 * a chunk this estimate put at 311 tokens was 317 nomic tokens, which is
 * close enough to size chunks by. Wherever a number derived from it is
 * shown, it is labeled as an estimate.
 *
 * ---------------------------------------------------------------------------
 * Offsets
 * ---------------------------------------------------------------------------
 *
 * Every chunk records where it came from as character offsets into the
 * document's normalized text: `text === docText.slice(start, end)`, always.
 * Normalized means a byte-order mark removed and line endings made "\n".
 * Git checks these files out with CRLF endings on Windows and LF elsewhere,
 * and offsets that depended on that would differ between machines.
 */

import type { ChunkPreset, ChunkStrategy } from "./types.js";

/** The characters-per-token heuristic. See the header. */
export const CHARS_PER_TOKEN = 4;

/** Estimated tokens in a piece of text. A heuristic, labeled as one. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Target chunk size and overlap, in estimated tokens. */
export interface ChunkSize {
  chunkTokens: number;
  overlapTokens: number;
}

/**
 * The three size presets each strategy offers (decision #6). Presets, not
 * free numbers, so a rebuild stays quick and the scorecard compares a
 * known set. `default` is the plan's starting point, about 300 tokens with
 * 50 of overlap; step 7 picks the defaults from the retrieval scorecard.
 */
export const PRESETS: Record<ChunkPreset, ChunkSize> = {
  small: { chunkTokens: 150, overlapTokens: 25 },
  default: { chunkTokens: 300, overlapTokens: 50 },
  large: { chunkTokens: 600, overlapTokens: 100 },
};

/** One document, as the chunker receives it. */
export interface SourceDoc {
  /** File name without ".md", e.g. "rental-agreement". Unique in the corpus. */
  id: string;
  /** The document's H1, or its id when it has none. */
  title: string;
  /** The whole document, normalized with normalizeText(). */
  text: string;
}

/** One chunk, ready to embed. */
export interface Chunk {
  /**
   * "<doc-id>#<n>" for `fixed` (n counts from 1); "<doc-id>#<heading-slug>"
   * for the heading strategies, with "-2", "-3"… on the later parts of a
   * section that was cut again. Unique within a document.
   */
  id: string;
  docId: string;
  /**
   * Headings above this chunk, outermost (the H1) first. For a chunk packed
   * from several sections, the headings they share. Empty for `fixed`.
   */
  headingPath: string[];
  /** The chunk's own text, exactly as it appears in the document. */
  text: string;
  /**
   * What gets embedded. Equal to `text`, except for `heading+context`,
   * where the title and heading path come first.
   */
  embedText: string;
  /** Offsets into the document's normalized text, end exclusive. */
  start: number;
  end: number;
  /** Estimated tokens of `text`. */
  estimatedTokens: number;
}

/** Removes a byte-order mark and turns CRLF and lone CR into LF. */
export function normalizeText(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Cuts one document with the given strategy and size. */
export function chunkDocument(doc: SourceDoc, strategy: ChunkStrategy, size: ChunkSize): Chunk[] {
  if (size.chunkTokens <= 0 || size.overlapTokens < 0 || size.overlapTokens >= size.chunkTokens) {
    // An overlap as big as the chunk would never move forward.
    throw new RangeError(`Bad chunk size: ${size.chunkTokens} tokens with ${size.overlapTokens} overlap`);
  }
  return strategy === "fixed" ? fixedChunks(doc, size) : headingChunks(doc, size, strategy === "heading+context");
}

// ---------------------------------------------------------------------------
// Cutting a range of text into windows
// ---------------------------------------------------------------------------

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** First non-whitespace position at or after `pos`, or `to`. */
function skipSpace(text: string, pos: number, to: number): number {
  while (pos < to && isSpace(text[pos])) pos++;
  return pos;
}

/** `end` moved back past trailing whitespace, but not before `start`. */
function trimEnd(text: string, start: number, end: number): number {
  while (end > start && isSpace(text[end - 1])) end--;
  return end;
}

/**
 * The best place to end a window that starts at `start` and may not pass
 * `limit`, when the caller cares about structure. Tries, in order: the
 * last blank line, the last line break, the last sentence end. A break
 * only counts if it keeps the window at least half full; otherwise the
 * chunks would shrink to fit every short paragraph. Returns the position
 * of the whitespace character the window ends before, or -1.
 */
function structuralBreak(text: string, start: number, limit: number): number {
  const earliest = start + Math.floor((limit - start) / 2);
  const window = text.slice(earliest, limit + 1);

  const blank = window.lastIndexOf("\n\n");
  if (blank >= 0) return earliest + blank;

  const line = window.lastIndexOf("\n");
  if (line >= 0) return earliest + line;

  // A sentence ends at . ! or ? (optionally followed by a closing quote or
  // bracket) and then whitespace.
  let sentence = -1;
  for (const match of window.matchAll(/[.!?]["')\]]?(?=\s)/g)) sentence = match.index + match[0].length;
  return sentence >= 0 ? earliest + sentence : -1;
}

/**
 * Cuts text[from, to) into windows of at most `maxChars`, each starting
 * and ending on a word boundary, consecutive windows sharing up to
 * `overlapChars` of text. Returns [start, end) pairs with surrounding
 * whitespace trimmed off.
 *
 * Word boundaries: a window ends just before a whitespace character, and
 * the next one starts just after one, so no word is ever cut in two. The
 * only window that can exceed `maxChars` is one holding a single "word"
 * longer than that, which no real text in the corpus has.
 *
 * Overlap: the next window starts at the first word that begins within
 * `overlapChars` of the previous window's end. So the overlap is never
 * more than `overlapChars`, and less only by the part of a word that
 * straddled the cut. When `structural` is on and a line begins within
 * the overlap, the next window starts at that line instead, which keeps
 * table rows and list items whole at the cost of a shorter overlap. If
 * the cut fell on a line break and no line begins inside the overlap,
 * there's no overlap at all.
 */
function windows(
  text: string,
  from: number,
  to: number,
  maxChars: number,
  overlapChars: number,
  structural: boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = skipSpace(text, from, to);

  while (start < to) {
    if (to - start <= maxChars) {
      out.push([start, trimEnd(text, start, to)]);
      break;
    }

    const limit = start + maxChars;
    let cut = structural ? structuralBreak(text, start, limit) : -1;
    if (cut < 0) {
      // The last whitespace that keeps the window within the limit.
      cut = limit;
      while (cut > start && !isSpace(text[cut])) cut--;
    }
    if (cut <= start) {
      // One word longer than the window: take all of it.
      cut = limit;
      while (cut < to && !isSpace(text[cut])) cut++;
    }

    const end = trimEnd(text, start, cut);
    out.push([start, end]);

    // Where the next window starts: the first word beginning inside the
    // overlap, or simply the next word when there's no overlap. With
    // structure on, a LINE beginning inside the overlap wins over a word,
    // so an overlap that reaches into a table starts on a whole row
    // rather than on "| value 6 |", half of one.
    let next = skipSpace(text, cut, to);
    if (overlapChars > 0) {
      const from = Math.max(start + 1, end - overlapChars);
      let candidate = from;
      while (candidate < end && !(isSpace(text[candidate - 1]) && !isSpace(text[candidate]))) candidate++;
      if (structural) {
        const line = text.indexOf("\n", from - 1);
        const lineStart = line < 0 ? -1 : skipSpace(text, line + 1, end);
        if (lineStart > 0 && lineStart < end) candidate = lineStart;
        // The cut fell on a line break but no line begins inside the
        // overlap (a table row longer than the overlap): no overlap at all,
        // rather than one that starts halfway along a row.
        else if (text[cut] === "\n") candidate = end;
      }
      if (candidate < end) next = candidate;
    }
    start = next;
  }

  return out;
}

// ---------------------------------------------------------------------------
// fixed
// ---------------------------------------------------------------------------

function fixedChunks(doc: SourceDoc, size: ChunkSize): Chunk[] {
  const ranges = windows(
    doc.text,
    0,
    doc.text.length,
    size.chunkTokens * CHARS_PER_TOKEN,
    size.overlapTokens * CHARS_PER_TOKEN,
    false, // structure is exactly what this strategy ignores
  );
  return ranges.map(([start, end], i) => {
    const text = doc.text.slice(start, end);
    return { id: `${doc.id}#${i + 1}`, docId: doc.id, headingPath: [], text, embedText: text, start, end, estimatedTokens: estimateTokens(text) };
  });
}

// ---------------------------------------------------------------------------
// heading and heading+context
// ---------------------------------------------------------------------------

/** One Markdown section: a heading line and everything up to the next heading. */
interface Section {
  /** Headings from the H1 down to this one. Empty for text before any heading. */
  path: string[];
  start: number;
  end: number;
  /** Where the body starts, just after the heading line. */
  bodyStart: number;
}

/** "# Title" through "###### Title", with optional closing #s. */
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/**
 * Splits a document into sections at every heading, tracking the path of
 * headings above each one. A heading line inside a ``` fence isn't a
 * heading. (The corpus has no fences; the check costs one line.)
 */
function sections(text: string): Section[] {
  const found: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  let offset = 0;

  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;

    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (!match) continue;

    const level = match[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: match[2]! });
    found.push({ path: stack.map((h) => h.title), start: lineStart, end: text.length, bodyStart: Math.min(offset, text.length) });
  }

  // Each section ends where the next begins.
  for (let i = 0; i < found.length - 1; i++) found[i]!.end = found[i + 1]!.start;

  // Text before the first heading is a section with no path.
  const firstStart = found[0]?.start ?? text.length;
  if (text.slice(0, firstStart).trim() !== "") found.unshift({ path: [], start: 0, end: firstStart, bodyStart: 0 });

  return found;
}

/** "Late returns and the late fee" → "late-returns-and-the-late-fee". */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** The headings two paths share, from the top: [A, B, C] and [A, B, D] → [A, B]. */
function commonPath(a: string[], b: string[]): string[] {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/**
 * The heading strategies, in three passes:
 *
 *   1. Merge empty sections forward. A heading with nothing under it
 *      ("## Day by day" followed straight by "### Day 1") joins the next
 *      section, so no chunk is a lone heading line.
 *   2. Pack whole sections. Consecutive sections that fit in one chunk
 *      together are packed into it. Without this, a corpus of short
 *      sections (thirteen regulations, two dozen FAQ answers) becomes
 *      hundreds of tiny chunks: step 3 measured 307 chunks averaging 116
 *      tokens, against 148 averaging 279 for `fixed`, and top-4 would hand
 *      the model a third as much text. A packed chunk's heading path is
 *      the part its sections share.
 *   3. Cut oversized sections. A section bigger than one chunk on its own
 *      is cut with structural windows, and its parts are never packed with
 *      a neighbor. This is where a later part loses its heading: the part
 *      that says "this fee is waived" no longer says which fee.
 */
function headingChunks(doc: SourceDoc, size: ChunkSize, withContext: boolean): Chunk[] {
  const maxChars = size.chunkTokens * CHARS_PER_TOKEN;
  const all = sections(doc.text);
  const chunks: Chunk[] = [];
  const used = new Set<string>();

  /** A chunk id not yet used in this document. */
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const emit = (start: number, end: number, path: string[], id: string): void => {
    const text = doc.text.slice(start, end);
    // The H1 is the title; a path that doesn't start with it gets it added,
    // so every context line names the document.
    const context = path[0] === doc.title ? path : [doc.title, ...path];
    chunks.push({
      id,
      docId: doc.id,
      headingPath: path,
      text,
      embedText: withContext ? `${context.join(" > ")}\n\n${text}` : text,
      start,
      end,
      estimatedTokens: estimateTokens(text),
    });
  };

  const slugOf = (path: string[]): string => (path.length === 0 ? "intro" : slugify(path[path.length - 1]!));

  // Pass 1: empty sections merge forward.
  const units: Section[] = [];
  let carry: number | null = null;
  for (const section of all) {
    if (doc.text.slice(section.bodyStart, section.end).trim() === "" && section !== all[all.length - 1]) {
      carry ??= section.start;
      continue;
    }
    units.push({ ...section, start: carry ?? section.start });
    carry = null;
  }

  // Passes 2 and 3.
  let pack: { start: number; end: number; path: string[]; firstPath: string[] } | null = null;
  const flush = (): void => {
    if (!pack) return;
    const end = trimEnd(doc.text, pack.start, pack.end);
    emit(skipSpace(doc.text, pack.start, end), end, pack.path, unique(`${doc.id}#${slugOf(pack.firstPath)}`));
    pack = null;
  };

  for (const unit of units) {
    const length = trimEnd(doc.text, unit.start, unit.end) - unit.start;

    if (length > maxChars) {
      flush();
      const sectionId = unique(`${doc.id}#${slugOf(unit.path)}`);
      const ranges = windows(doc.text, unit.start, unit.end, maxChars, size.overlapTokens * CHARS_PER_TOKEN, true);
      ranges.forEach(([start, end], part) => emit(start, end, unit.path, part === 0 ? sectionId : unique(`${sectionId}-${part + 1}`)));
      continue;
    }

    if (pack && trimEnd(doc.text, pack.start, unit.end) - pack.start <= maxChars) {
      pack.end = unit.end;
      pack.path = commonPath(pack.path, unit.path);
    } else {
      flush();
      pack = { start: unit.start, end: unit.end, path: unit.path, firstPath: unit.path };
    }
  }
  flush();

  return chunks;
}
