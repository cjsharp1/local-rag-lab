/**
 * doc-view.ts — the document view: a chunk shown in place, inside its whole source document.
 *
 * Search hands the model chunks, and a chunk is only as good as where the
 * chunker cut it. This view answers "where did this text come from, and
 * what's around it?": click a chunk anywhere on the page (its id in the
 * candidate table, its highlight in the request view, its dot on the
 * map) and its document opens here, scrolled to the chunk, with:
 *
 *   - the chunk you clicked in a strong highlight;
 *   - the other chunks from this document that the last search SENT to
 *     the model with a dotted underline, so you can see what the model got and
 *     what it didn't (a table's header in a different chunk, the
 *     sentence just past the cut);
 *   - overlaps visible as places where two chunks' ranges meet.
 *
 * The document comes from GET /api/documents/:id, which reads it from the
 * loaded index (the get_document tool), so it's exactly the text the
 * chunk offsets point into. Offsets come from search results and the
 * map: every chunk's `start` and `end` in its document's text.
 *
 * Text goes in as text nodes only, like everywhere in public/.
 */

import { getJson } from "./api.js";
import { clear, el, n } from "./dom.js";

/** Where a chunk sits: which document, which characters. */
export interface ChunkLocation {
  chunkId: string;
  docId: string;
  start: number;
  end: number;
}

interface DocumentText {
  id: string;
  path: string;
  title: string;
  text: string;
}

export class DocumentView {
  private readonly documents = new Map<string, DocumentText>();
  private readonly locations = new Map<string, ChunkLocation>();

  constructor(private readonly container: HTMLElement) {}

  /** Learns where chunks are, from a search result or the map. */
  remember(chunks: Iterable<ChunkLocation>): void {
    for (const c of chunks) this.locations.set(c.chunkId, { chunkId: c.chunkId, docId: c.docId, start: c.start, end: c.end });
  }

  /** The document a chunk id belongs to: the part before the "#". */
  private static docIdOf(chunkId: string): string {
    return chunkId.replace(/^\[/, "").split("#")[0]!;
  }

  /**
   * Opens the chunk's document, the chunk highlighted and scrolled to.
   * `sent` names the chunks the last search sent, for the light highlight.
   */
  async open(chunkId: string, sent: Iterable<string> = []): Promise<void> {
    const id = chunkId.replace(/^\[|\]$/g, "");
    const location = this.locations.get(id);
    const docId = location?.docId ?? DocumentView.docIdOf(id);
    clear(this.container);
    this.container.append(el("p", { class: "muted" }, `Loading ${docId}…`));

    let doc = this.documents.get(docId);
    if (!doc) {
      try {
        doc = await getJson<DocumentText>(`/api/documents/${encodeURIComponent(docId)}`);
        this.documents.set(docId, doc);
      } catch (error: unknown) {
        clear(this.container);
        this.container.append(el("p", { class: "lv-error" }, `The document couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }

    const others = [...sent]
      .filter((c) => c !== id)
      .map((c) => this.locations.get(c))
      .filter((c): c is ChunkLocation => c !== undefined && c.docId === docId);

    clear(this.container);
    this.container.append(
      el("h3", {}, doc.title),
      el("p", { class: "muted small" },
        `corpus/${doc.path} · ${n(doc.text.length)} characters. ` +
          (location
            ? `${id} is characters ${n(location.start)}–${n(location.end)}, in the strong highlight.`
            : `${id}'s position isn't known on this page yet (ask a question that retrieves it), so nothing is highlighted.`) +
          (others.length > 0 ? ` The dotted underlines are the ${others.length} other chunk${others.length === 1 ? "" : "s"} from this document the last search sent to the model.` : "")),
    );
    const body = DocumentView.render(doc.text, location, others);
    this.container.append(body);
    body.querySelector("mark.selected")?.scrollIntoView({ block: "center" });
  }

  /**
   * The document as text, cut at every chunk boundary, each piece wrapped
   * in a strong mark (inside the clicked chunk), a light one (inside a sent
   * chunk) or nothing. Cutting at every boundary handles overlapping chunks.
   */
  private static render(text: string, selected: ChunkLocation | undefined, others: ChunkLocation[]): HTMLElement {
    const pre = el("pre", { class: "content doc" });
    const ranges = [...(selected ? [selected] : []), ...others];
    const cuts = [...new Set([0, text.length, ...ranges.flatMap((r) => [r.start, r.end])])].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const [from, to] = [cuts[i]!, cuts[i + 1]!];
      const piece = text.slice(from, to);
      const inside = (r: ChunkLocation) => r.start <= from && to <= r.end;
      if (selected && inside(selected)) pre.append(el("mark", { class: "selected", title: selected.chunkId }, piece));
      else {
        const other = others.find(inside);
        pre.append(other ? el("mark", { class: "other", title: other.chunkId }, piece) : piece);
      }
    }
    return pre;
  }
}
