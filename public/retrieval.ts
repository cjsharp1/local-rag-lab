/**
 * retrieval.ts — the retrieval panel: search settings in, the candidate table out.
 *
 * The settings (index, search mode, top-k, floor, rerank, budget check)
 * are read fresh for every question, so changing one never needs a
 * reload. Chunking is the exception: it belongs to the index, so changing
 * a size preset means rebuilding that index (PLAN §2).
 *
 * The candidate table shows every chunk the last search returned, in the
 * order it was ranked, with every score: vector similarity and rank,
 * keyword (BM25) rank, the fused RRF score, and the rerank score when
 * rerank was on. Kept rows are bold; every other row says why it wasn't
 * sent (past top-k, over budget). It's built from the log rows the server
 * streams, not from a separate request, so it can only ever show what
 * actually happened. It's also the map's table view: the same chunks, as
 * text, for anyone who can't tell the map's colors apart. Each chunk id
 * is a link that opens the chunk inside its source document.
 */

import type { ChunkStrategy, LogEvent, SearchMode, SearchResult, SearchSettings } from "../shared/types.js";
import { $, clear, el, n } from "./dom.js";

/** The panel's current settings. */
export function readSettings(): { strategy: ChunkStrategy; settings: SearchSettings } {
  return {
    strategy: $<HTMLSelectElement>("strategy").value as ChunkStrategy,
    settings: {
      mode: $<HTMLSelectElement>("search-mode").value as SearchMode,
      topK: Number($<HTMLInputElement>("top-k").value),
      floor: Number($<HTMLInputElement>("floor").value),
      rerank: $<HTMLInputElement>("rerank").checked,
      budgetCheck: $<HTMLInputElement>("budget").checked,
    },
  };
}

/** What the log has said about the last search: the result, then what was kept and dropped. */
export interface LastSearch {
  result: SearchResult;
  kept: Set<string>;
  overBudget: Set<string>;
  /** The order after reranking, when rerank was on. */
  rerankedOrder?: string[];
  /** Each reranked chunk's 0–3 score. */
  rerankScores?: Map<string, number>;
}

/**
 * Follows the log stream and keeps the latest search's story. Returns true
 * when the table should be redrawn.
 */
export class SearchTracker {
  last: LastSearch | undefined;

  take(event: LogEvent): boolean {
    if (event.level !== "retrieval" && event.level !== "warn") return false;
    const detail = event.detail as Record<string, unknown> | undefined;
    if (event.label.startsWith("Search: ") && detail && "candidates" in detail) {
      this.last = { result: detail as unknown as SearchResult, kept: new Set(), overBudget: new Set() };
      return true;
    }
    if (!this.last || !detail) return false;
    if (event.label.startsWith("Reranked") && Array.isArray(detail.after)) {
      // Entries read "chunk-id (score)", as server/modes/common.ts logs them.
      const parsed = (detail.after as string[]).map((s) => /^(.*) \((\d)\)$/.exec(s)).filter((m): m is RegExpExecArray => m !== null);
      this.last.rerankedOrder = parsed.map((m) => m[1]!);
      this.last.rerankScores = new Map(parsed.map((m) => [m[1]!, Number(m[2])]));
      return true;
    }
    if (event.label.startsWith("Dropped ") && typeof (detail.candidate as { chunkId?: unknown } | undefined)?.chunkId === "string") {
      this.last.overBudget.add((detail.candidate as { chunkId: string }).chunkId);
      return true;
    }
    if (event.label.startsWith("Kept ") && Array.isArray(event.detail)) {
      this.last.kept = new Set(event.detail as string[]);
      return true;
    }
    return false;
  }
}

/** A chunk id that opens the chunk in its source document (doc-view.ts). */
function chunkLink(chunkId: string, onOpen: (chunkId: string) => void): HTMLButtonElement {
  const button = el("button", { type: "button", class: "chunk-link", title: "Show this chunk inside its source document" }, chunkId);
  button.addEventListener("click", () => onOpen(chunkId));
  return button;
}

/** Draws the candidate table for the last search. */
export function renderCandidates(table: HTMLTableElement, last: LastSearch | undefined, onOpen: (chunkId: string) => void): void {
  clear(table);
  if (!last) {
    table.append(el("tbody", {}, el("tr", {}, el("td", { class: "muted" }, "No search yet."))));
    return;
  }
  const { result } = last;
  // The order the app selected from: reranked first when rerank was on.
  const byId = new Map(result.candidates.map((c) => [c.chunkId, c]));
  const order = last.rerankedOrder
    ? [...last.rerankedOrder.map((id) => byId.get(id)!).filter(Boolean), ...result.candidates.filter((c) => !last.rerankedOrder!.includes(c.chunkId))]
    : result.candidates;

  table.append(el("caption", { class: "muted small" },
    `"${result.query}" · ${result.mode} · ${result.strategy} index · ${result.candidates.length} of ${result.totalChunks} chunks passed the floor (${result.belowFloor.count} below ${result.floor})` +
      (result.keywordQuery !== undefined ? ` · keyword query: ${result.keywordQuery ?? "(none)"}` : "")));
  table.append(el("thead", {}, el("tr", {},
    el("th", {}, "#"), el("th", {}, "Chunk"), el("th", {}, "Vector"), el("th", {}, "Keyword"),
    el("th", {}, "Fused"), el("th", {}, "Rerank"), el("th", {}, "Tokens"), el("th", {}, "Sent?"))));

  const body = el("tbody");
  order.slice(0, 40).forEach((c, i) => {
    const kept = last.kept.has(c.chunkId);
    const status = kept ? "kept" : last.overBudget.has(c.chunkId) ? "over budget" : "past top-k";
    body.append(el("tr", { class: kept ? "kept" : "dropped", title: c.text.slice(0, 300) },
      el("td", { class: "num" }, i + 1),
      el("td", {}, chunkLink(c.chunkId, onOpen)),
      el("td", { class: "num" }, `${c.vectorScore.toFixed(3)} (#${c.vectorRank ?? "?"})`),
      el("td", { class: "num" }, c.keywordRank !== undefined ? `#${c.keywordRank}` : "—"),
      el("td", { class: "num" }, c.fusedScore !== undefined ? c.fusedScore.toFixed(4) : "—"),
      el("td", { class: "num" }, last.rerankScores?.has(c.chunkId) ? String(last.rerankScores.get(c.chunkId)) : "—"),
      el("td", { class: "num" }, `~${n(c.estimatedTokens)}`),
      el("td", {}, status)));
  });
  if (order.length > 40) body.append(el("tr", {}, el("td", { colspan: "8", class: "muted" }, `…and ${order.length - 40} more, all past top-k. The full list is in the search row's detail in the log.`)));
  table.append(body);
}
