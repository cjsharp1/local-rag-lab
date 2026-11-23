/**
 * map.ts — the embedding map: every chunk as a dot, the last query among them.
 *
 * Each chunk's 768-number embedding is flattened to two numbers by PCA at
 * index time (tool-server/pca.ts), and the query is flattened the same
 * way at question time, so it lands on the same map. Dots are colored by
 * the document's folder (policies, permits, routes, gear, faq); after a
 * search, the query is a ring, and lines run from it to the chunks that
 * were sent to the model.
 *
 * The honest caveat is printed under the map, with the measured number:
 * two axes keep only about a fifth of the spread of 768 dimensions, so
 * two dots that look close may not be. Retrieval never uses the map.
 * Hovering a dot names its chunk and, if the last search scored it, its
 * real similarity, which is the number to trust. Clicking a dot opens the
 * chunk inside its source document (doc-view.ts).
 *
 * Colors are the validated categorical slots 1–5 (styles.css, checked
 * with the dataviz validator for light and dark). In light mode three of
 * them sit under 3:1 contrast against the surface, so identity never
 * rests on color alone: there's a legend, a hover label on every dot, and
 * the candidate table in the retrieval panel lists the same chunks as text.
 */

import type { Candidate, MapResponse } from "../shared/types.js";
import { $, clear, el } from "./dom.js";

const FOLDERS = ["policies", "permits", "routes", "gear", "faq"] as const;

interface Point { chunkId: string; docId: string; folder: string; x: number; y: number }

export class MapView {
  private points: Point[] = [];
  private query: { x: number; y: number } | undefined;
  private sent = new Set<string>();
  private scores = new Map<string, number>();
  private folderOf = new Map<string, string>();
  private toScreen: (p: { x: number; y: number }) => [number, number] = () => [0, 0];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onOpen: (chunkId: string) => void) {
    canvas.addEventListener("mousemove", (e) => this.hover(e));
    canvas.addEventListener("click", (e) => {
      const hit = this.nearest(e);
      if (hit) this.onOpen(hit.chunkId);
    });
    canvas.addEventListener("mouseleave", () => ($("map-tip").hidden = true));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  /** Which folder each document is in, from its path ("policies/rates-2026.md"). */
  setDocuments(docs: Array<{ id: string; path: string }>): void {
    this.folderOf = new Map(docs.map((d) => [d.id, d.path.split("/")[0] ?? "other"]));
  }

  setMap(map: MapResponse): void {
    this.points = map.chunks.map((c) => ({ ...c, folder: this.folderOf.get(c.docId) ?? "other" }));
    this.query = undefined;
    this.sent.clear();
    this.scores.clear();
    const legend = $("map-legend");
    clear(legend);
    FOLDERS.forEach((folder, i) => legend.append(el("span", {}, el("i", { style: `background: var(--series-${i + 1})` }), folder)));
    legend.append(el("span", {}, el("i", { style: "background: transparent; border: 2px solid var(--map-query)" }), "query"));
    $("map-caption").textContent =
      `${map.chunks.length} chunks of the ${map.strategy} index (${map.preset} preset). The two axes keep ` +
      `${(map.variance[0] * 100).toFixed(1)}% + ${(map.variance[1] * 100).toFixed(1)}% of the variance of the 768-dimensional embeddings, ` +
      "so distances here are heavily distorted: dots that look close may not be. Retrieval uses the real similarity, shown on hover.";
    this.draw();
  }

  /** After a search: where the query landed, which chunks were sent, and every candidate's real score. */
  setSearch(queryMap: { x: number; y: number }, sentIds: Iterable<string>, candidates: readonly Candidate[]): void {
    this.query = queryMap;
    this.sent = new Set(sentIds);
    this.scores = new Map(candidates.map((c) => [c.chunkId, c.vectorScore]));
    this.draw();
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    if (this.points.length === 0) return;

    const all = this.query ? [...this.points, this.query] : this.points;
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 24;
    this.toScreen = (p) => [
      pad + ((p.x - minX) / (maxX - minX || 1)) * (width - 2 * pad),
      height - pad - ((p.y - minY) / (maxY - minY || 1)) * (height - 2 * pad),
    ];

    // Lines from the query to the chunks that were sent: drawn first, under the dots.
    if (this.query) {
      const [qx, qy] = this.toScreen(this.query);
      ctx.strokeStyle = color("--map-line");
      ctx.lineWidth = 1.5;
      for (const p of this.points.filter((p) => this.sent.has(p.chunkId))) {
        const [x, y] = this.toScreen(p);
        ctx.beginPath();
        ctx.moveTo(qx, qy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }

    const surface = color("--surface");
    for (const p of this.points) {
      const [x, y] = this.toScreen(p);
      const slot = FOLDERS.indexOf(p.folder as (typeof FOLDERS)[number]);
      const radius = this.sent.has(p.chunkId) ? 7 : 4;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = slot >= 0 ? color(`--series-${slot + 1}`) : color("--muted");
      ctx.fill();
      // A 2px surface ring keeps overlapping dots apart.
      ctx.lineWidth = 2;
      ctx.strokeStyle = surface;
      ctx.stroke();
    }

    if (this.query) {
      const [qx, qy] = this.toScreen(this.query);
      ctx.beginPath();
      ctx.arc(qx, qy, 9, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color("--map-query");
      ctx.stroke();
    }
  }

  /** The dot under the pointer, if any. The hit target is bigger than the dot. */
  private nearest(e: MouseEvent): Point | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const my = (e.clientY - rect.top) * scale;
    let best: Point | undefined;
    let bestDistance = 12 * scale;
    for (const p of this.points) {
      const [x, y] = this.toScreen(p);
      const d = Math.hypot(x - mx, y - my);
      if (d < bestDistance) [best, bestDistance] = [p, d];
    }
    return best;
  }

  private hover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const best = this.nearest(e);
    this.canvas.style.cursor = best ? "pointer" : "default";
    const tip = $("map-tip");
    if (!best) {
      tip.hidden = true;
      return;
    }
    const score = this.scores.get(best.chunkId);
    tip.textContent = `${best.chunkId} · ${best.folder}` + (score !== undefined ? ` · similarity ${score.toFixed(3)}` : "") +
      (this.sent.has(best.chunkId) ? " · sent to the model" : "") + " · click to open";
    tip.style.left = `${e.clientX - rect.left}px`;
    tip.style.top = `${e.clientY - rect.top}px`;
    tip.hidden = false;
  }
}
