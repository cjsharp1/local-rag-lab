/**
 * eval-retrieval.ts — the retrieval pass of the scorecard: did the right chunks come back?
 *
 * Called by:  npm run eval -- --retrieval     (needs Ollama: embeddings only, no chat model)
 *
 * Retrieval is measured separately from answers, because the two fail
 * differently and look the same from outside (PLAN §1, lesson 2): an
 * answer can be wrong because the right chunk never came back, or because
 * the model fumbled a chunk it had. This pass needs no chat model, so it
 * runs in about half a minute.
 *
 * For every answerable question (27 of the 30) and every configuration,
 * 3 chunking strategies × 3 size presets × 3 search modes = 27 of them:
 *
 *   hit@k     every hop of the question has a gold span inside one of the
 *             top k chunks (k = SCORECARD_K, the default top-k);
 *   partial   some hops found, not all (multi-hop only);
 *   MRR       the mean of 1/rank of the first chunk holding any gold span,
 *             counted only within the top MRR_CUTOFF;
 *   floor     hops whose best gold chunk scores below the vector floor,
 *             so vector search alone would never return it.
 *
 * The hit rules are scoreRetrieval() in shared/scoring.ts. Indexes are
 * built fresh into a temporary folder with the same buildIndex() that
 * `npm run index` uses, and searched with the same search code the tool
 * server runs. Each question is embedded once and that vector searches
 * all nine indexes.
 *
 * ---------------------------------------------------------------------------
 * Choosing the defaults (once)
 * ---------------------------------------------------------------------------
 *
 * PLAN §4.1 picks the default chunking strategy and preset once, from
 * this pass, then freezes them. The rule is written here, before the
 * first run, so the numbers can't choose the rule:
 *
 *   1. highest hit@k in hybrid mode (the default mode);
 *   2. then highest MRR in hybrid mode;
 *   3. then the preset nearest "default" (default before small or large);
 *   4. then the order heading, heading+context, fixed (the plan's prior).
 *
 * The pass prints the winner and whether it differs from the current
 * defaults in shared/search-settings.ts. Changing them is a deliberate
 * edit, recorded in PLAN §4.1, not something this script does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkHoldsSpan, scoreRetrieval } from "../shared/scoring.js";
import { DEFAULT_PRESET, DEFAULT_SEARCH, DEFAULT_STRATEGY, MRR_CUTOFF, SCORECARD_K } from "../shared/search-settings.js";
import type { ChunkPreset, ChunkStrategy, Question, QuestionCategory, SearchMode } from "../shared/types.js";
import { buildIndex } from "../tool-server/build.js";
import type { CorpusDoc } from "../tool-server/corpus.js";
import { writeIndex } from "../tool-server/db.js";
import { embed } from "../tool-server/embed.js";
import { openIndex, type IndexEntry } from "../tool-server/indexes.js";
import { searchWithVector } from "../tool-server/search/search.js";
import { cosineSimilarity } from "../tool-server/search/vector.js";

export const STRATEGIES: readonly ChunkStrategy[] = ["heading", "heading+context", "fixed"];
export const PRESET_ORDER: readonly ChunkPreset[] = ["default", "small", "large"];
export const MODES: readonly SearchMode[] = ["vector", "keyword", "hybrid"];

/** One question under one configuration. */
export interface QuestionResult {
  questionId: string;
  category: QuestionCategory;
  hit: boolean;
  partial: boolean;
  firstGoldRank: number | null;
  /** Hops whose best gold chunk scores below the floor (1-based hop numbers). */
  hopsBelowFloor: number[];
}

/** One configuration's results. */
export interface ConfigResult {
  strategy: ChunkStrategy;
  preset: ChunkPreset;
  mode: SearchMode;
  chunks: number;
  questions: QuestionResult[];
  hits: number;
  partials: number;
  mrr: number;
}

/** Everything the pass measured. */
export interface RetrievalReport {
  k: number;
  floor: number;
  answerable: number;
  configs: ConfigResult[];
  /** The defaults the rule picks. */
  chosen: { strategy: ChunkStrategy; preset: ChunkPreset };
  seconds: { build: number; search: number };
}

/** The selection rule from the header, as a comparator: negative means a is better. */
function compareForDefault(a: ConfigResult, b: ConfigResult): number {
  return (
    b.hits - a.hits ||
    b.mrr - a.mrr ||
    PRESET_ORDER.indexOf(a.preset) - PRESET_ORDER.indexOf(b.preset) ||
    STRATEGIES.indexOf(a.strategy) - STRATEGIES.indexOf(b.strategy)
  );
}

/** For each hop, the best vector score among chunks holding one of its spans (null if none does). */
function bestGoldScores(index: IndexEntry, question: Question, queryVector: Float32Array): Array<number | null> {
  return question.hops.map((hop) => {
    let best: number | null = null;
    for (const chunk of index.chunks) {
      if (hop.some((span) => chunkHoldsSpan(chunk, span))) {
        const score = cosineSimilarity(queryVector, chunk.vector);
        if (best === null || score > best) best = score;
      }
    }
    return best;
  });
}

/** Runs the whole pass. `log` receives progress lines. */
export async function runRetrievalPass(
  questions: readonly Question[],
  docs: readonly CorpusDoc[],
  corpusHash: string,
  log: (line: string) => void,
): Promise<RetrievalReport> {
  const answerable = questions.filter((q) => q.category !== "unanswerable");
  const floor = DEFAULT_SEARCH.floor;
  const dir = mkdtempSync(join(tmpdir(), "rag-scorecard-"));
  const indexes: IndexEntry[] = [];

  try {
    const buildStart = performance.now();
    for (const strategy of STRATEGIES) {
      for (const preset of PRESET_ORDER) {
        const { index } = await buildIndex(docs, corpusHash, strategy, preset);
        const path = join(dir, `index-${strategy.replace("+", "-")}-${preset}.db`);
        writeIndex(path, index);
        indexes.push(openIndex(path, corpusHash));
        log(`  built ${strategy} / ${preset}: ${index.chunks.length} chunks`);
      }
    }
    const buildSeconds = (performance.now() - buildStart) / 1000;

    const searchStart = performance.now();
    const embedded = await embed(answerable.map((q) => q.question), "query");
    const vectors = new Map(answerable.map((q, i) => [q.id, embedded.vectors[i]!]));

    const configs: ConfigResult[] = [];
    for (const index of indexes) {
      const { strategy, preset } = index.settings;
      for (const mode of MODES) {
        const results = answerable.map((q): QuestionResult => {
          const vector = vectors.get(q.id)!;
          const found = searchWithVector(index, { query: q.question, strategy, mode, floor }, vector, { embed: 0, embedLoad: 0 });
          const score = scoreRetrieval(q, found.candidates, SCORECARD_K);
          const below = bestGoldScores(index, q, vector)
            .map((s, h) => (s !== null && s < floor ? h + 1 : 0))
            .filter((h) => h > 0);
          return { questionId: q.id, category: q.category, hit: score.hit, partial: score.partial, firstGoldRank: score.firstGoldRank, hopsBelowFloor: below };
        });
        const rr = results.map((r) => (r.firstGoldRank !== null && r.firstGoldRank <= MRR_CUTOFF ? 1 / r.firstGoldRank : 0));
        configs.push({
          strategy,
          preset,
          mode,
          chunks: index.chunks.length,
          questions: results,
          hits: results.filter((r) => r.hit).length,
          partials: results.filter((r) => r.partial).length,
          mrr: rr.reduce((a, b) => a + b, 0) / rr.length,
        });
      }
    }
    const searchSeconds = (performance.now() - searchStart) / 1000;

    const best = configs.filter((c) => c.mode === "hybrid").sort(compareForDefault)[0]!;
    return {
      k: SCORECARD_K,
      floor,
      answerable: answerable.length,
      configs,
      chosen: { strategy: best.strategy, preset: best.preset },
      seconds: { build: buildSeconds, search: searchSeconds },
    };
  } finally {
    for (const index of indexes) index.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pct = (n: number, of: number) => `${n}/${of}`;
const find = (r: RetrievalReport, strategy: ChunkStrategy, preset: ChunkPreset, mode: SearchMode) =>
  r.configs.find((c) => c.strategy === strategy && c.preset === preset && c.mode === mode)!;

/** The retrieval section of docs/scorecard.md, as Markdown. */
export function renderRetrieval(r: RetrievalReport, questions: readonly Question[]): string {
  const n = r.answerable;
  const out: string[] = [];
  const defaults = `${DEFAULT_STRATEGY} / ${DEFAULT_PRESET}`;

  out.push(
    `## Retrieval pass`,
    "",
    `${n} answerable questions (the 3 unanswerable ones have no gold spans). ` +
      `**hit@${r.k}**: every hop has a gold span in the top ${r.k} chunks. **partial**: some hops, not all. ` +
      `**MRR**: mean of 1/rank of the first chunk holding any gold span, within the top ${MRR_CUTOFF}. ` +
      `**below floor**: questions with a hop whose best gold chunk scores under the vector floor (${r.floor}), ` +
      "so vector search alone can't return it. Code scores all of it; no model is involved.",
    "",
    `Built 9 indexes in ${r.seconds.build.toFixed(0)} s; searched ${r.configs.length} configurations in ${r.seconds.search.toFixed(1)} s.`,
    "",
  );

  out.push(`### Every configuration, hit@${r.k}`, "", "| Strategy | Preset | Chunks | vector | keyword | hybrid | hybrid MRR | below floor |", "|---|---|---|---|---|---|---|---|");
  for (const strategy of STRATEGIES) {
    for (const preset of PRESET_ORDER) {
      const v = find(r, strategy, preset, "vector");
      const k = find(r, strategy, preset, "keyword");
      const h = find(r, strategy, preset, "hybrid");
      const below = h.questions.filter((q) => q.hopsBelowFloor.length > 0).length;
      const mark = strategy === r.chosen.strategy && preset === r.chosen.preset ? " **←**" : "";
      out.push(`| ${strategy} | ${preset}${mark} | ${h.chunks} | ${pct(v.hits, n)} | ${pct(k.hits, n)} | ${pct(h.hits, n)} | ${h.mrr.toFixed(3)} | ${below} |`);
    }
  }
  out.push("", `**←** marks the configuration the selection rule picks (scripts/eval-retrieval.ts): highest hybrid hit@${r.k}, then hybrid MRR, then the preset nearest "default". Current defaults: ${defaults}.`, "");

  const categories = [...new Set(questions.filter((q) => q.category !== "unanswerable").map((q) => q.category))];
  const preset = r.chosen.preset;
  out.push(`### By category, ${preset} preset (hits out of the category's questions)`, "");
  const cols = STRATEGIES.flatMap((s) => MODES.map((m) => ({ s, m })));
  out.push(`| Category | ${cols.map((c) => `${c.s} ${c.m}`).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const category of categories) {
    const total = questions.filter((q) => q.category === category).length;
    out.push(`| ${category} | ${cols.map(({ s, m }) => pct(find(r, s, preset, m).questions.filter((q) => q.category === category && q.hit).length, total)).join(" | ")} |`);
  }

  out.push("", `### By question, ${preset} preset: rank of the first gold chunk (bold = hit@${r.k}; ½ = partial; — = not in the candidates)`, "");
  out.push(`| Question | ${cols.map((c) => `${c.s} ${c.m}`).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const q of questions.filter((q) => q.category !== "unanswerable")) {
    const cells = cols.map(({ s, m }) => {
      const res = find(r, s, preset, m).questions.find((x) => x.questionId === q.id)!;
      const rank = res.firstGoldRank === null ? "—" : String(res.firstGoldRank);
      return res.hit ? `**${rank}**` : res.partial ? `${rank} ½` : rank;
    });
    out.push(`| ${q.id} | ${cells.join(" | ")} |`);
  }

  const belowFloor = r.configs
    .filter((c) => c.mode === "vector")
    .flatMap((c) => c.questions.filter((q) => q.hopsBelowFloor.length > 0).map((q) => `${q.questionId} (${c.strategy} / ${c.preset}, hop ${q.hopsBelowFloor.join(", ")})`));
  out.push("", "### Gold chunks below the floor", "", belowFloor.length === 0
    ? `None: in every configuration, every hop's best gold chunk scores at or above the floor (${r.floor}).`
    : `${belowFloor.length} question-configurations have a hop whose best gold chunk scores under ${r.floor}:\n\n${belowFloor.map((b) => `- ${b}`).join("\n")}`);
  out.push("");
  return out.join("\n");
}

/** A short version of the main table for the terminal. */
export function printRetrieval(r: RetrievalReport): void {
  const n = r.answerable;
  console.log(`\nhit@${r.k} out of ${n} answerable questions (floor ${r.floor}):\n`);
  console.log(`${"Strategy".padEnd(17)}${"Preset".padEnd(9)}${"Chunks".padStart(6)}  ${"vector".padStart(7)} ${"keyword".padStart(7)} ${"hybrid".padStart(7)}  ${"MRR".padStart(5)}`);
  for (const strategy of STRATEGIES) {
    for (const preset of PRESET_ORDER) {
      const [v, k, h] = MODES.map((m) => find(r, strategy, preset, m));
      const mark = strategy === r.chosen.strategy && preset === r.chosen.preset ? "  ← rule's pick" : "";
      console.log(`${strategy.padEnd(17)}${preset.padEnd(9)}${String(h!.chunks).padStart(6)}  ${pct(v!.hits, n).padStart(7)} ${pct(k!.hits, n).padStart(7)} ${pct(h!.hits, n).padStart(7)}  ${h!.mrr.toFixed(3)}${mark}`);
    }
  }
  const same = r.chosen.strategy === DEFAULT_STRATEGY && r.chosen.preset === DEFAULT_PRESET;
  console.log(`\nThe selection rule picks ${r.chosen.strategy} / ${r.chosen.preset}` +
    (same ? ", the current defaults." : `; the current defaults are ${DEFAULT_STRATEGY} / ${DEFAULT_PRESET}.`));
}
