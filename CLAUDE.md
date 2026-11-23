# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A teaching lab for retrieval-augmented generation that runs entirely on
the user's machine: an invented outfitter's 25 documents, three chunking
strategies, vector / keyword / hybrid search behind an MCP tool server,
three answer modes (no retrieval, pre-retrieved, search tool), and a UI
that shows every chunk, score and token. People read this code to learn
from it, so **the explanation is part of the deliverable**. A terse,
clever rewrite makes this codebase worse even when the code is better.

It is standalone. Don't mention or link other projects in code, comments
or docs.

## The comment convention

Every `.ts` file opens with a block comment that names the file and
explains what it does, why it exists and what it teaches. Enforced by
`npm run audit-comments` (it checks a header exists, names its file and
is long enough; it can't judge quality, which is on you).

Inline comments explain **why**, and especially the trap. Many record a
bug that was hit (the unnormalized PCA start vector, the table row cut by
an overlap, the 336-character gold span). Don't delete one because the
code looks obvious; the comment is why it looks obvious. When behavior
changes, update the comment in the same edit.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The lab on 3400 (compiles the browser half first) |
| `npm run typecheck` | **Both** halves |
| `npm run audit-comments` | Every file has a header |
| `npm test` | Unit tests (node:test), including the question-set check |
| `npm run try-tools` | Every MCP tool over stdio, no model; run after any tool change |
| `npm run eval -- --check` | The question set against the corpus, in a second |
| `npm run index` | Rebuild the indexes; needed after any corpus change |
| `npm run ask -- "…"` / `compare -- "…"` | One question through the real modes, in the terminal |
| `npm run eval` | The full scorecard (~10 min, needs Ollama); regenerates docs/scorecard.* |
| `npm run check-env` | Each dependency checked separately |

Before finishing any change: `npm run typecheck`, `npm run
audit-comments`, `npm test`, and `npm run try-tools` if a tool changed.

## Architecture

- `tool-server/`: the MCP server, a **separate process**, and the only
  code that reads `corpus/` and `data/index-*.db`. Loads all three indexes
  at startup. Four tools: `search_docs`, `get_document`,
  `list_documents`, `index_map`.
- `server/`: the app. `turn.ts`'s `runTurn()` is the single entry point
  for answering; the routes, `ask.ts`, `compare.ts` and the scorecard all
  call it. Modes take a `Logger`, never an HTTP response.
  `modes/common.ts`'s `Turn` does model calls, searches and citations.
- `shared/`: chunking, scoring, search defaults, local-only rules and
  types. No Node imports (it's compiled for the browser too).
- `public/`: the browser half, compiled in place. Client tsconfig keeps
  `"types": []`; the browser imports only types from `shared/`.
- `scripts/`: index, check-env, ask, compare, eval (+ eval-retrieval,
  eval-answers), try-tools, chunk-report.

## Invariants: changing one is a decision, not a refactor

- **No API key, no outbound calls.** Local models only; cloud models are
  refused by name (`shared/local-only.ts`) in the model client, the
  embedder, the web server and check-env. `OLLAMA_URL` must be local.
- **Both retrieval modes go through `search_docs`.** There's no second search path.
- **The tool server returns every candidate that passes the floor.**
  Top-k, rerank and the budget happen in the app, where they're logged.
  The model never sees an untrimmed tool result.
- **Every chunk that reaches a model request is recorded with its span.**
  A request with unrecorded context is a bug.
- **Every chat request sends `think`, `num_ctx`, `num_predict`,
  `temperature: 0` and `seed`** (`buildRequest` in `server/model/ollama.ts`),
  and streams. `format` and `tools` never go in the same request.
- **Every embed request sends `truncate: false`** and the nomic task prefix.
- **`textContent`, never `innerHTML`**, in `public/` (`dom.ts`'s `el()`/`append()`).
- **Every server binds 127.0.0.1 and checks Host and Origin.**
- **`stdio.ts` never writes to stdout**: stdout is the protocol there.
- **The scorer is frozen.** `DECLINE_PHRASES` and `CONFLICT_PHRASES` in
  `shared/scoring.ts` were written before any answer existed. Changing
  them, the question files' facts or the defaults after seeing results is
  tuning to the test set; record any change and its reason in PLAN.md.
- **A number in the docs is measured or marked as an estimate**, and
  heuristics are labeled as heuristics.

## Things that bite

Verified facts live in `docs/verified-facts.md`; read it before trusting
a remembered API shape.

- Ollama's `/api/embed` silently truncates long input unless `truncate: false`.
- FTS5 `MATCH` throws on raw text with hyphens or `?`; `keyword.ts` quotes terms.
- qwen3.5:4b thinks unless `think: false` is sent explicitly.
- Temperature 0 + seed is close to, not exactly, reproducible: two full
  answer passes agreed on 89 of 90 answers; the one that differed was
  whether the model chose to search. Don't build a claim on one turn.
- The chars ÷ 4 estimate undercounts by 150–450 tokens when a tool is offered.
- On Windows, a running tool server holds the index files open: stop it
  before `npm run index` (the rebuild route does), or the rename fails.
  Stopping a background `tsx` process can leave its Node child running;
  check the port.
- `node:sqlite` rows have a null prototype; copy them before `deepEqual`.
- Gold spans stay ≤ 100 characters (`--check` enforces it): longer ones
  can straddle a `fixed` chunk boundary and count as a miss.

## Documentation to keep in sync

Changing tools, routes, scripts or counts means updating, in the same
change: `README.md`, `index.html` (counts measured, not estimated),
`docs/how-it-works.html`, `PLAN.md`, and `scripts/try-tools.ts` cases.
Editing a corpus document means `npm run index` and `npm run eval -- --check`.
`docs/scorecard.md` and `.json` are generated; rerun `npm run eval`
rather than editing them.

## GitHub Pages

`index.html` at the repo root is the project overview, served by Pages
from `main`. It's a complete, self-contained HTML document: doctype,
`<html lang>`, `<meta charset="utf-8">`. Without the doctype Pages renders
in quirks mode; without the charset long dashes become mojibake.

Commits: plain imperative, descriptive, no prefixes.
