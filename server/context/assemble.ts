/**
 * assemble.ts — writes retrieved chunks into the text the model receives, and records where each one landed.
 *
 * This file is lesson 1 of the lab in code: RAG is prompt construction.
 * The model doesn't "know" the documents; the app pastes chunks into the
 * request, here, as plain text. Each chunk is written as:
 *
 *   [rental-agreement#late-returns-and-the-late-fee-4] (Rental Agreement > Late returns and the late fee)
 *   …the chunk's own text, exactly as it is in the document…
 *
 * The label in square brackets is what the system prompt tells the model
 * to cite. The part in parentheses is the heading path (or the document id
 * for `fixed` chunks, which have none), so even a chunk that says only
 * "this fee is waived" arrives saying which fee. Under heading+context the
 * heading path was embedded with the chunk; here it reaches the model too,
 * whatever the strategy.
 *
 * Every chunk's text is recorded with its character offsets inside the
 * message (PLAN §10: a request with unrecorded context is a bug). The
 * request view in the UI highlights exactly those spans, and the tests
 * check that each span's text is the chunk's text.
 *
 * The same writer serves both retrieval modes: pre-retrieved mode puts the
 * block in the user message before the question; search-tool mode puts it
 * in the tool result the model asked for.
 */

import { estimateTokens } from "../../shared/chunk.js";
import type { Candidate } from "../../shared/types.js";

/** Where a chunk's text sits inside one message's content. */
export interface TextSpan {
  chunkId: string;
  label: string;
  start: number;
  end: number;
}

/** The line written above a chunk. */
export function chunkHeader(c: Pick<Candidate, "label" | "headingPath" | "docId">): string {
  return `${c.label} (${c.headingPath.length > 0 ? c.headingPath.join(" > ") : c.docId})`;
}

/** Estimated prompt tokens one chunk costs: header, text and the blank line between chunks. */
export function chunkCost(c: Pick<Candidate, "label" | "headingPath" | "docId" | "text">): number {
  return estimateTokens(`${chunkHeader(c)}\n${c.text}\n\n`);
}

/** Text with spans, built up piece by piece so offsets can't drift. */
class Builder {
  text = "";
  spans: TextSpan[] = [];
  add(piece: string): void {
    this.text += piece;
  }
  addChunk(c: Candidate): void {
    this.add(`${chunkHeader(c)}\n`);
    const start = this.text.length;
    this.add(c.text);
    this.spans.push({ chunkId: c.chunkId, label: c.label, start, end: this.text.length });
  }
  addChunks(chunks: readonly Candidate[]): void {
    chunks.forEach((c, i) => {
      if (i > 0) this.add("\n\n");
      this.addChunk(c);
    });
  }
}

/** The final user message in pre-retrieved mode: the documents, then the question. */
export function preRetrievedMessage(question: string, chunks: readonly Candidate[]): { content: string; spans: TextSpan[] } {
  const b = new Builder();
  if (chunks.length === 0) {
    b.add("Documents: none were found for this question.\n\n");
  } else {
    b.add("Documents:\n\n");
    b.addChunks(chunks);
    b.add("\n\n");
  }
  b.add(`Question: ${question}`);
  return { content: b.text, spans: b.spans };
}

/** A search_docs tool result in search-tool mode: what the model reads back. */
export function toolResultMessage(query: string, chunks: readonly Candidate[]): { content: string; spans: TextSpan[] } {
  const b = new Builder();
  if (chunks.length === 0) {
    b.add(`No documents matched "${query}". Try different words.`);
  } else {
    b.add(`Search results for "${query}":\n\n`);
    b.addChunks(chunks);
  }
  return { content: b.text, spans: b.spans };
}

/**
 * Every chunk label cited in an answer: "[doc-id#section]" in square
 * brackets, as the system prompt asks. Each label once, in order of first
 * appearance.
 */
export function citedLabels(answer: string): string[] {
  const found: string[] = [];
  for (const match of answer.matchAll(/\[([a-z0-9][a-z0-9-]*#[a-z0-9][a-z0-9-]*)\]/gi)) {
    const label = `[${match[1]!.toLowerCase()}]`;
    if (!found.includes(label)) found.push(label);
  }
  return found;
}
