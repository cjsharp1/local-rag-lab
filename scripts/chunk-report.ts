/**
 * chunk-report.ts — shows what each chunking strategy does to the corpus.
 *
 * Run it with:  npm run chunk-report
 *               npm run chunk-report -- --preset small
 *
 * Before any embedding or searching, the chunks themselves are worth
 * looking at, because every later number depends on them. This prints:
 *
 *   1. how many chunks each strategy and size preset makes, with their
 *      size range in estimated tokens;
 *   2. for one preset (default unless --preset says otherwise), the five
 *      longest and five shortest chunks per strategy, with their first
 *      words, so you can see what a strategy cuts badly.
 *
 * The shortest chunks are usually the interesting ones. A chunk of a few
 * dozen tokens, a one-line note or a lone table row, embeds as a vector
 * that's mostly noise, and it can still crowd a better chunk out of the
 * top k.
 *
 * Token counts are estimates (characters ÷ 4; see shared/chunk.ts).
 */

import { chunkDocument, PRESETS, type Chunk } from "../shared/chunk.js";
import type { ChunkPreset, ChunkStrategy } from "../shared/types.js";
import { loadCorpus } from "../tool-server/corpus.js";

const STRATEGIES: readonly ChunkStrategy[] = ["fixed", "heading", "heading+context"];
const PRESET_NAMES = Object.keys(PRESETS) as ChunkPreset[];

/** --preset <name>, defaulting to "default"; anything else is an error. */
function chosenPreset(): ChunkPreset {
  const i = process.argv.indexOf("--preset");
  if (i < 0) return "default";
  const name = process.argv[i + 1];
  if (!PRESET_NAMES.includes(name as ChunkPreset)) {
    console.error(`--preset must be one of: ${PRESET_NAMES.join(", ")}`);
    process.exit(1);
  }
  return name as ChunkPreset;
}

/** The first words of a chunk on one line, for a quick look. */
function preview(chunk: Chunk, width = 70): string {
  const flat = chunk.text.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

const docs = loadCorpus();
const preset = chosenPreset();

console.log(`\n${docs.length} documents. Sizes are estimated tokens (characters ÷ 4).\n`);
console.log("Strategy          Preset    Target/overlap   Chunks   Smallest   Largest   Mean");
for (const strategy of STRATEGIES) {
  for (const name of PRESET_NAMES) {
    const size = PRESETS[name];
    const chunks = docs.flatMap((doc) => chunkDocument(doc, strategy, size));
    const tokens = chunks.map((c) => c.estimatedTokens);
    const mean = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
    console.log(
      `${strategy.padEnd(18)}${name.padEnd(10)}${`${size.chunkTokens}/${size.overlapTokens}`.padEnd(17)}` +
        `${String(chunks.length).padStart(6)}${String(Math.min(...tokens)).padStart(11)}${String(Math.max(...tokens)).padStart(10)}${String(mean).padStart(7)}`,
    );
  }
}

for (const strategy of STRATEGIES) {
  const chunks = docs.flatMap((doc) => chunkDocument(doc, strategy, PRESETS[preset]));
  const bySize = [...chunks].sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id));
  console.log(`\n${strategy}, ${preset} preset: ${chunks.length} chunks`);
  console.log("  Longest:");
  for (const c of bySize.slice(0, 5)) console.log(`    ${String(c.estimatedTokens).padStart(4)}  ${c.id.padEnd(46)} ${preview(c)}`);
  console.log("  Shortest:");
  for (const c of bySize.slice(-5).reverse()) console.log(`    ${String(c.estimatedTokens).padStart(4)}  ${c.id.padEnd(46)} ${preview(c)}`);
}

// heading and heading+context make the same cuts; only what's embedded
// differs. Show one context line so the difference is visible.
const sample = loadCorpus()
  .flatMap((doc) => chunkDocument(doc, "heading+context", PRESETS[preset]))
  .find((c) => c.id.startsWith("rental-agreement#late-returns") && /waived/.test(c.text));
if (sample) {
  console.log(`\nheading+context embeds ${sample.id} as:\n`);
  console.log(sample.embedText.split("\n").slice(0, 3).map((l) => `    ${l}`).join("\n"));
  console.log("    …\n");
}
