/**
 * cli-options.ts — the command-line options ask.ts and compare.ts share.
 *
 * Both scripts take a question and the same retrieval-panel settings as
 * flags, defaulting to the lab's defaults (shared/search-settings.ts), so
 * a terminal run and a browser run with untouched settings are the same
 * run:
 *
 *   --model qwen3.5:4b       the chat model (default: MODEL from .env)
 *   --strategy heading       fixed | heading | heading+context
 *   --search hybrid          vector | keyword | hybrid
 *   --top-k 4                how many chunks to send at most
 *   --floor 0.5              minimum vector similarity for a vector-only match
 *   --no-budget              turn the budget check off (top-k is the only limit)
 *   --think                  let the model think first (slow by design)
 *   --verbose                print every row's full detail
 *
 * Everything that isn't a flag is the question.
 */

import { DEFAULT_SEARCH, DEFAULT_STRATEGY } from "../shared/search-settings.js";
import type { ChunkStrategy, SearchMode, SearchSettings } from "../shared/types.js";
import { ollamaConfig } from "../server/model/ollama.js";

export interface CliOptions {
  question: string;
  model: string;
  strategy: ChunkStrategy;
  settings: SearchSettings;
  think: boolean;
  verbose: boolean;
  /** Flags this script knows beyond the shared ones, with their values. */
  extra: Map<string, string>;
}

const VALUED = new Set(["--model", "--strategy", "--search", "--top-k", "--floor"]);

/** Parses argv. `extraValued` names script-specific flags that take a value. */
export function parseOptions(argv: readonly string[], extraValued: readonly string[] = [], extraSwitches: readonly string[] = []): CliOptions {
  const words: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUED.has(arg) || extraValued.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      values.set(arg, value);
    } else if (["--no-budget", "--think", "--verbose", ...extraSwitches].includes(arg)) {
      switches.add(arg);
    } else if (arg.startsWith("--")) {
      fail(`Unknown option ${arg}`);
    } else {
      words.push(arg);
    }
  }

  const strategy = (values.get("--strategy") ?? DEFAULT_STRATEGY) as ChunkStrategy;
  if (!["fixed", "heading", "heading+context"].includes(strategy)) fail("--strategy must be fixed, heading or heading+context");
  const mode = (values.get("--search") ?? DEFAULT_SEARCH.mode) as SearchMode;
  if (!["vector", "keyword", "hybrid"].includes(mode)) fail("--search must be vector, keyword or hybrid");
  const topK = Number(values.get("--top-k") ?? DEFAULT_SEARCH.topK);
  if (!Number.isInteger(topK) || topK < 1 || topK > 16) fail("--top-k must be a whole number from 1 to 16");
  const floor = Number(values.get("--floor") ?? DEFAULT_SEARCH.floor);
  if (!Number.isFinite(floor) || floor < -1 || floor > 1) fail("--floor must be between -1 and 1");

  const extra = new Map([...values].filter(([k]) => extraValued.includes(k)));
  for (const s of switches) if (extraSwitches.includes(s)) extra.set(s, "true");

  return {
    question: words.join(" ").trim(),
    model: values.get("--model") ?? ollamaConfig().model,
    strategy,
    settings: { ...DEFAULT_SEARCH, mode, topK, floor, budgetCheck: !switches.has("--no-budget") },
    think: switches.has("--think"),
    verbose: switches.has("--verbose"),
    extra,
  };
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}
