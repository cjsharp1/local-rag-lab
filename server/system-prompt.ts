/**
 * system-prompt.ts — the one system prompt every answer mode uses.
 *
 * Short and fixed (PLAN §6.2): answer only from the documents provided,
 * cite the chunk labels used, say so when the documents don't contain the
 * answer, and stay on the outfitter's topics. The same words go to all
 * three modes, so the only thing that differs between them is how the
 * documents arrive, which is what the lab compares.
 *
 * In no-retrieval mode there are no documents at all, and the prompt
 * still says "answer only from the documents". That's deliberate: it's
 * how a reader sees a model ignore an instruction it can't follow, and
 * produce a fluent, invented answer anyway.
 *
 * The citation format is the chunk label exactly as the app writes it
 * before each chunk: [document-id#section]. The app checks every label in
 * the answer against the labels it actually sent (modes/common.ts), so a
 * citation to a chunk that wasn't in the request is caught.
 *
 * The search-tool sentence only appears when the tool is offered, so the
 * prompt never mentions a tool the model doesn't have.
 */

import type { AnswerMode } from "../shared/types.js";

export function buildSystemPrompt(mode: AnswerMode): string {
  const lines = [
    "You are the help assistant for Paddle Section Supply, a canoe and kayak outfitter in Ashby Landing, " +
      "next to the Kettle Basin Canoe Area.",
    "Answer only from the provided documents. Each document chunk starts with a label in square brackets, " +
      "like [rental-agreement#late-returns]. After each fact you use, cite the label of the chunk it came from, " +
      "copied exactly, in square brackets.",
    "If the documents don't contain the answer, say that the documents don't say, and don't guess.",
    "Keep answers short and specific. Only answer questions about Paddle Section Supply and trips in the Kettle Basin Canoe Area.",
  ];
  if (mode === "search-tool") {
    lines.splice(2, 0, "To get documents, call the search_docs tool. Search again with different words if the results don't contain the answer.");
  }
  return lines.join("\n");
}
