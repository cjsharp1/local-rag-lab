# local-rag-lab — build plan

A local teaching lab that shows what retrieval-augmented generation does
to the requests a model receives: the same question answered three ways,
side by side in the activity log, with every retrieved chunk, score and
token visible.

Status: **all decisions made (§13); steps 0–2 done; the corpus awaits
your review before step 3.** No lab code yet. Sections below will be
corrected wherever a build step proves them wrong.

Conventions in this document:

- "Measured earlier" marks a fact carried over from the other local labs
  on this machine, to be re-confirmed in step 0 where it matters.
- A number marked **estimate** has not been measured on this machine. It
  is re-measured at the build step named beside it, and the plan is
  corrected where it was wrong.

---

## 1. Goals and non-goals

### What the lab is for

RAG is usually taught as a box diagram: documents, embeddings, vector
database, LLM. The diagram hides the part that matters to a developer,
which is what actually lands in the model's request, and what that costs.

A small help assistant for an invented paddling outfitter answers
customer questions from a corpus of unstructured documents: rental terms,
permit rules, route guides, gear care and policies. The reader picks how
the answer is grounded:

| Mode | Who retrieves | What the log shows |
|---|---|---|
| **No retrieval** | nobody | one small request; a fluent, invented answer |
| **Pre-retrieved** (classic RAG) | the app, before the model runs | an app-side search row with chunks and scores, then one large request with the chunks inside it |
| **Search tool** (agentic RAG) | the model, by calling `search_docs` | a request, a tool call (maybe several, with rewritten queries), tool results, a final request |

What a reader should come away able to say, with the log in front of them:

1. **RAG is prompt construction.** The model doesn't "know" the documents.
   The app pasted text into the request, and the reader can point at
   exactly where.
2. **Retrieval quality caps answer quality.** When the right chunk doesn't
   come back, the model either declines or invents, and an invented
   answer looks just as grounded. The retrieval scorecard measures
   retrieval separately from answers, so the two failures can be told
   apart.
3. **The modes trade differently.** Pre-retrieval always pays for context,
   even when the question needs none. The search tool pays in round trips
   and depends on a small model choosing to search, and searching well.
   The lab measures both on the reader's machine instead of asserting it.
4. **Context is a budget.** Raising top-k on a 4B model with an 8k window
   pushes history out. The lab's drop detector catches it on purpose.
5. **Embeddings capture meaning, not identifiers.** Vector search finds
   "how do I bring the canoe back late" from "late return fee," and misses
   an exact permit code that keyword search finds instantly. Hybrid search
   exists for that reason.

### Seeing behind the scenes

For any question, a reader can see:

- the query that was embedded (and, in tool mode, each query the model wrote);
- every candidate chunk, with its vector score, keyword score, fused rank
  and, when reranking is on, its rerank score;
- which chunks were kept, and why the rest were dropped (below threshold,
  past top-k, over the token budget);
- where in the request the chunks were placed, highlighted inside the
  full request body;
- prompt tokens, response tokens, time per stage (embed, search, rerank,
  generate) and the share of the context window used;
- where the query landed on the embedding map, next to the chunks it
  retrieved.

**If something happens and the UI doesn't show it, that is a bug in the
lab.**

### Audience

Developers who have called an LLM and heard of RAG, but have never looked
at what a RAG request contains. They will read the code to learn from it,
so the explanation is part of the deliverable. Every file opens with a
comment saying what it does, why it exists and what it teaches.

### Non-goals (first version)

- **No API key and no hosted model, ever.** Cloud models are refused by name.
- **No vector database.** A few hundred chunks fit in memory; similarity is
  a loop over arrays in plain TypeScript that a reader can step through.
  The README says when a real vector database becomes worth it.
- **No document upload.** The corpus is fixed and reviewed, so the
  question set's expected answers stay correct.
- **No PDFs or images.** The corpus is Markdown. Parsing is a separate
  problem.
- **No LLM judge.** Code scores retrieval and answers (§8).
- **Prompt injection through retrieved text is not explored.** Retrieved
  chunks are untrusted input, and the README says so in one paragraph.
  Nothing in the corpus is adversarial.
- **Not a production RAG framework.** No LangChain, LlamaIndex or similar.
  The lab exists to show what those frameworks hide.

---

## 2. Design choices worth knowing

The architecture is the same as the other local labs: a two-halves
TypeScript project (`shared/types.ts` is the wire contract), an MCP tool
server spawned over stdio, Host and Origin guards on every server, a
`Logger` with a sink instead of an HTTP response, and the comment
convention enforced by `scripts/audit-comments.ts`. The choices below are
specific to this lab.

| Choice | Why |
|---|---|
| **Retrieval lives in the tool server, and pre-retrieval mode calls the same `search_docs` tool from the app** | The only difference between classic and agentic RAG is *who makes the call*. Using one code path for both makes that the visible difference, not an implementation detail. The log's `actor` column (`app` vs `model`) carries the lesson |
| **The index is built by a script and stored as files, one per chunking strategy** (`data/index-fixed.db`, `data/index-heading.db`, `data/index-heading-context.db`) | Embedding the corpus takes time. Building once with `npm run index` and loading at startup keeps the app's first answer fast, and the index files can be inspected. One file per strategy lets the scorecard compare strategies without rebuilding, and lets the UI switch strategies instantly |
| **Index settings are part of the index** | Chunk size and overlap change the chunks, so changing them means rebuilding that strategy's file. The UI shows the settings of the loaded index, switches between the built strategies, and offers a rebuild when a size preset changes; settings that only affect search (mode, top-k, floor, rerank) change per question |
| **Brute-force cosine similarity in TypeScript** | About 20 lines, no dependency, fast enough for a few hundred chunks (**estimate**: under 5 ms). The point is that nothing is hidden |
| **Keyword search with SQLite FTS5 (BM25)** | Built into SQLite, so hybrid search costs no new dependency. Confirmed in step 0: `node:sqlite` ships SQLite 3.50.2 with FTS5 |
| **Hybrid results merged by reciprocal rank fusion (RRF)** | Vector and BM25 scores aren't on the same scale, so adding them is meaningless. RRF merges by rank, takes a few lines, and the log can show each rank |
| **A compare view that runs one question through all three modes** | The request/response logs are the subject of the lab. Reading three logs one after another loses the contrast; three columns with a summary row keeps it |
| **A new log level, `retrieval`** | A search, a chunk dropped by the budget, or a chunk placed into a prompt is the event the reader is watching for. As `info` rows, they'd be lost among the others |
| **Gold answers are labeled as text spans, not chunk ids** | Chunk ids change when chunking changes. A span ("$35 per day after 6 p.m.") survives any chunking, and a chunk is a hit if its original text contains the whole span (§8) |
| **Unit tests (`node:test`)** for chunking, fusion, budget and scoring | These decide every number the scorecard publishes |

---

## 3. Architecture

### 3.1 Processes

```
 browser (public/, compiled in place)
    │  HTTP + SSE, 127.0.0.1:3400, Host/Origin checked
    ▼
 app server (server/, Express 5)            scripts/ask.ts, eval.ts,
    │   modes, prompt assembly, loop         compare.ts run the SAME
    │                                         code with no HTTP at all
    ├── fetch ──► Ollama 127.0.0.1:11434
    │               chat model (qwen3.5:4b default) + embeddings model
    │
    └── MCP over stdio (child process) ──► tool server (tool-server/)
                                              │ the only code that reads
                                              ▼ the corpus and the index
                                           corpus/*.md (read-only)
                                           data/index-<strategy>.db (chunks, vectors, FTS5)

 Optional: npm run tool-server:http → the same tools over Streamable HTTP
 on 127.0.0.1:3401, for MCP Inspector. The app never uses it.
```

Ports **3400** (app) and **3401** (tool server over HTTP), clear of the
data lab (3200s) and the prompt injection lab (3300s), so all three can
run at once.

The tool server embeds the query itself (one call to Ollama's embeddings
endpoint), so it needs `OLLAMA_URL`. It still never calls the chat model.

### 3.2 Folder layout

```
local-rag-lab/
├── CLAUDE.md                  conventions and invariants for Claude Code
├── PLAN.md                    this file
├── README.md
├── index.html                 GitHub Pages overview
├── .env.example
├── corpus/                    the outfitter's documents, Markdown, reviewed
│   ├── README.md              what each document is and which traps it holds
│   ├── policies/              rental agreement, cancellations, damage, deposits
│   ├── permits/               permit rules, entry points, quotas
│   ├── routes/                route guides with portage tables
│   ├── gear/                  care guides, packing lists, sizing
│   └── faq/
├── questions/                 the question set (§5.3), one JSON file each
├── data/
│   ├── schema.sql             chunks, vectors, FTS5 table, index settings, corpus hash
│   └── index-<strategy>.db    built by `npm run index`, one per chunking strategy, gitignored
├── tool-server/
│   ├── db.ts
│   ├── embed.ts               one function: text → vector, via Ollama
│   ├── search/
│   │   ├── vector.ts          cosine similarity over every chunk
│   │   ├── keyword.ts         FTS5 BM25
│   │   ├── fuse.ts            reciprocal rank fusion
│   │   └── search.ts          one entry point, returns every candidate with every score
│   ├── tools/                 search_docs, get_document, list_documents
│   ├── mcp-server.ts
│   ├── stdio.ts
│   └── http.ts
├── server/
│   ├── index.ts               routes, SSE, Host/Origin guard
│   ├── logger.ts
│   ├── model/ollama.ts
│   ├── mcp/client.ts
│   ├── modes/
│   │   ├── none.ts            question → model
│   │   ├── pre-retrieved.ts   question → search_docs (actor: app) → assemble → model
│   │   └── search-tool.ts     question → loop with search_docs offered (actor: model)
│   ├── context/
│   │   ├── budget.ts          fits chunks into the token budget, logs what it drops
│   │   ├── assemble.ts        builds the prompt, marks the chunk spans for the UI
│   │   └── rerank.ts          optional rerank stage (§4.4)
│   ├── agent/loop.ts          the tool loop, adapted from the data lab
│   └── system-prompt.ts
├── shared/
│   ├── types.ts
│   └── chunk.ts               chunker, shared by the index script and the tests
├── public/
│   ├── app.ts, chat.ts, log.ts, state.ts, dom.ts
│   ├── compare.ts             the three-column view
│   ├── map.ts                 the embedding map (canvas)
│   ├── request-view.ts        full request with chunk spans highlighted
│   └── styles.css
├── scripts/
│   ├── audit-comments.ts      copied first, at step 1
│   ├── check-env.ts
│   ├── index.ts               chunk + embed + store → data/index-<strategy>.db (all three by default)
│   ├── project.ts             PCA → 2D coordinates stored in the index
│   ├── try-tools.ts
│   ├── try-model.ts
│   ├── ask.ts                 one question, one mode, every row in the terminal
│   ├── compare.ts             one question, all three modes, summary table
│   └── eval.ts                the scorecard (§8)
├── test/                      node:test
└── docs/
    ├── how-it-works.html
    ├── verified-facts.md
    └── scorecard.md           generated by eval.ts
```

### 3.3 One question through pre-retrieved mode

1. **Log** the mode and the search settings for this turn.
2. **App calls `search_docs`** over MCP with the question as the query.
   Logged as `retrieval`, actor `app`.
3. **Tool server** embeds the query, scores every chunk by cosine
   similarity, runs BM25 if hybrid is on, fuses ranks, and returns every
   candidate that passes the floor (§4.2) with all of its scores, not only
   the top k. The app decides what to keep, so the log can show what was
   cut.
4. **Rerank** (optional) rescores the top N candidates (§4.4). Logged with
   before and after ranks.
5. **Budget** keeps the top k that fit the context budget (§4.3). Each
   dropped chunk gets its own row with the reason.
6. **Assemble** the request: system prompt, history, then a context block
   with each chunk labeled by document and heading, then the question. The
   assembler records the character span of every chunk, so the request
   view can highlight them.
7. **One model request**, no tools. Logged in full, with prompt tokens and
   context share.
8. **Reply**, with cited chunk labels checked against what was actually
   sent. A citation to a chunk that wasn't in the request is flagged.

Search-tool mode runs the data lab's loop with `search_docs` offered. The
model writes the query. The tool server's answer goes to the app first,
never straight to the model: the app applies the same floor, top-k,
rerank and budget steps (3–5) to it, logs what it cut, and hands the model
only the kept chunks as the tool result. The budget is the **remaining**
budget, recomputed before each tool result from everything already in the
request (earlier tool results included), so three searches that each fit
can't overflow the window together.
No-retrieval mode skips steps 2–6.

---

## 4. Retrieval

### 4.1 Chunking (`shared/chunk.ts`)

Three strategies, chosen at index time:

| Strategy | How | What it teaches |
|---|---|---|
| `fixed` | N tokens (estimated at chars ÷ 4) with M overlap, ignoring structure | the baseline everyone starts with, and how it splits tables and procedures |
| `heading` | split on Markdown headings, then by size inside long sections | structure-aware chunking; fewer orphaned chunks |
| `heading+context` | `heading`, plus the document title and heading path prepended to each chunk before embedding | the cheap version of "contextual retrieval": a chunk that says "this fee" now also says which fee |

Defaults: `heading`, about 300 tokens, 50 overlap (**estimate**, tuned
once in step 7 against the scorecard, then frozen and recorded).

### 4.2 Search (`tool-server/search/`)

- **Vector:** cosine similarity of the query vector against every chunk vector.
- **Keyword:** FTS5 BM25 over chunk text. Raw query text can't go to
  `MATCH`: step 0 found that `EP-14` throws "no such column: 14" and a
  trailing `?` is a syntax error. `keyword.ts` builds the FTS5 query
  itself: it splits on whitespace, strips FTS5 operators and punctuation
  other than inner hyphens, quotes each term, and joins the terms with
  `OR`. The log shows the built query next to the original.
- **Hybrid:** RRF with k = 60, the common default. Each candidate carries
  its vector rank, keyword rank and fused score.
- Search settings per question: `mode` (vector / keyword / hybrid),
  `topK` (default 4), `floor` (minimum vector similarity, **estimate**,
  set at step 5 from the similarity distribution over the real corpus.
  The draft's 0.3 is too low: in step 0, two unrelated query/passage
  pairs scored 0.43 and 0.54, so 0.3 would filter almost nothing).
- **The floor applies only to candidates found by vector search alone.**
  In vector mode, a chunk below the floor is dropped. In keyword mode the
  floor doesn't apply. In hybrid mode, a chunk is dropped only if it is
  below the vector floor *and* has no BM25 match. Otherwise a chunk that
  BM25 finds by `EP-14` but that scores 0.2 on vector similarity would be
  cut before the app ever saw it, and the exact-term lesson would vanish.
  Every candidate's vector score is still reported, so the log shows when
  keyword search rescued a chunk the floor would have dropped.

### 4.3 The context budget (`server/context/budget.ts`)

Two terms, used consistently in the log and the UI:

- **Window**: the model's whole context, `NUM_CTX` (8192 tokens).
- **Chunk budget**: the part of the window left for retrieved chunks:
  the window minus system prompt, history, the question, and a reserve
  for the reply.

Chunks are added in rank order until the next one doesn't fit the chunk
budget. Every chunk not sent is logged with one of: `below-floor`,
`past-top-k`, `over-budget`. The UI's top-k slider goes high enough (16)
that a reader can run past the budget and, with the budget check turned
off (a toggle in the retrieval panel, §7), past the window itself, where
the drop detector from the data lab fires.

**The budget is a heuristic.** Before the request, token counts are
estimated as characters ÷ 4; the real count (`prompt_eval_count`) only
comes back from Ollama after the request. The model-request row shows
both, estimate and actual, so a reader sees how far off the heuristic
was. The reply reserve absorbs the error in normal use; the drop detector
catches it when it doesn't.

### 4.4 Reranking (`server/context/rerank.ts`)

Ollama has no rerank endpoint (confirmed in step 0: every candidate path
returns 404). The v1 reranker asks the
chat model to score each of the top N (default 8) candidates against the
question, 0–3, in one structured request. It is slow and labeled as such
in the UI, and the time it adds appears in the log. That cost is part of
the lesson. A dedicated cross-encoder is a decision (§13, #4).

### 4.5 The embedding map (`scripts/project.ts`, `public/map.ts`)

PCA to two dimensions, written in TypeScript (power iteration, about 60
lines), computed at index time and stored with the chunks. The query is
projected with the same components at question time. The map shows chunks
colored by document, the query as a marker, and lines to the retrieved
chunks. The UI says plainly that two dimensions distort distances, so a
chunk that looks close may not be.

---

## 5. The corpus and the question set

### 5.1 The business

An invented canoe and kayak outfitter that rents gear, sells permits and
publishes route guides for a fictional lake district: **Paddle Section
Supply**, `paddlesectionsupply.example` (decision #1). A rental outfitter produces exactly the documents RAG is
for: long policies with fee tables, rules with codes and numbers, route
guides that cross-reference each other, and rules that changed this
season.

### 5.2 Documents (25, 26,586 words, measured at step 2)

The draft estimated 30–40k words and about 250 chunks. Measured: 25
documents, 26,586 words, about 141k characters, which is about 35k
tokens by the chars ÷ 4 heuristic. That's roughly **120–150 chunks** at
the default chunk size (**estimate**; counted at step 3). The corpus is
smaller than planned, and the brute-force search gets correspondingly
cheaper. The traps, not the size, are what make retrieval differ between
configurations; step 7 measures whether they do.

| Group | Examples | Traps planted on purpose |
|---|---|---|
| policies | rental agreement, cancellation and weather policy, damage and loss schedule, deposits | a fee table that `fixed` chunking splits; "this fee" referring to a heading two paragraphs up |
| permits | permit rules, entry point list with codes (e.g. `EP-14`), group size limits | exact codes that vector search ranks poorly |
| routes | six route guides with portage tables (distance in rods, difficulty) | multi-hop: "longest portage on the route that starts at EP-14" |
| gear | canoe care, PFD sizing, packing lists, stove fuel rules | near-duplicate passages across documents |
| faq | general FAQ | near-duplicates of policy answers, worded loosely |

The stale-document trap lives in `policies/`: a **2025 rate sheet left
in the corpus next to the 2026 one**, where a real outfitter's old file
would end up. Stale documents are a real RAG failure.

Every document is written by hand (by Claude Code, reviewed by you) with
invented names and `*.example` domains. `corpus/README.md` lists each
planted trap, so readers can find them.

### 5.3 The question set (`questions/*.json`, 30 questions)

| Category | Count | What it tests |
|---|---|---|
| direct | 6 | the answer is stated plainly in one chunk |
| paraphrase | 5 | the question shares no keywords with the answer; vector search should win |
| exact term | 5 | codes, rule numbers, product names; keyword search should win |
| split context | 3 | the answer's subject is named in a different chunk; `heading+context` should win |
| table | 3 | the answer sits in a table row |
| multi-hop | 3 | needs two chunks; search-tool mode has a chance, pre-retrieval rarely |
| stale | 2 | 2025 and 2026 documents disagree; the right answer is the 2026 figure (an answer that gives both and flags the conflict is scored separately, §8) |
| unanswerable | 3 | not in the corpus; the right answer is "I don't know," and no-retrieval mode will invent one |

Each file holds: the question, its category, one or more gold spans
(`{ doc, text }`), required answer facts (strings that must appear,
normalized), and forbidden facts (for stale questions, the 2025 figure).
Multi-hop questions have one gold span per hop, and all of them are
required for a hit (§8).

---

## 6. The app

### 6.1 Models

- **Chat:** qwen3.5:4b by default, llama3.2:3b selectable (measured earlier:
  both installed; llama3.2:3b hides tool definitions after a tool result,
  which matters for search-tool mode; reported as a finding, as in the
  prompt injection lab).
- **Thinking mode.** qwen3.5:4b thinks by default (confirmed in step 0),
  and the thinking tokens would change every mode's token counts and
  timings. The lab sends `think: false` by default, so the three modes
  stay comparable, and says so in the README. A toggle turns thinking on,
  labeled **slow by design**: in step 0, a one-sentence question spent
  1,500 tokens (2.5 minutes) thinking without reaching an answer. When
  it's on, the thinking text is shown in the log as its own collapsible
  part of the response and counted separately, never hidden. The
  scorecard runs with thinking off.
- **Embeddings:** nomic-embed-text by default (274 MB, 768 dimensions,
  unit-length vectors). Pulled by the setup instructions; `check-env`
  fails clearly if it's missing. Chunks are embedded with the
  `search_document: ` prefix and queries with `search_query: `, as the
  model card requires.
- **Both models stay loaded, so there's no swap** (step 0 changed the
  plan here). At `num_ctx` 8192, qwen3.5:4b loads only partly on the GPU
  (1,880 MB of 3,887 MB), which leaves room for nomic on the GPU beside
  it (335 MB). Measured: no reload of either model between an embed and a
  chat call. Embeddings therefore run on the GPU with no `num_gpu`
  override: indexing at 21 ms per chunk, against 199 ms on CPU. The embed
  stage still logs Ollama's `load_duration`, so if a swap ever does happen
  (a larger window, another chat model), it shows up in the log as its
  own stage.
- **Generation speed:** about 9.7 tokens/s with qwen partly on CPU
  (measured in step 0). The model client streams and sets `num_predict`
  on every request; without a cap, one thinking request ran past Node's
  5-minute `fetch` header timeout.

### 6.2 System prompt

Short and fixed: answer only from the provided documents, cite the chunk
labels used, say so when the documents don't contain the answer, and stay
on the outfitter's topics. No guardrail layers like the data lab's. This
lab's subject is retrieval, and one prompt keeps the three modes
comparable. The no-retrieval mode uses the same prompt with no documents,
which is how a reader sees the model ignore "answer only from the
documents" when there are none.

### 6.3 Logging

Rows as in the data lab (level, direction, actor, because, label, detail),
plus:

| Row | Level | Actor | Detail |
|---|---|---|---|
| Search: "late return fee" · hybrid · 23 candidates | retrieval | app or model | every candidate with all scores |
| Reranked 8 → order changed for 3 | retrieval | app | before/after ranks, time |
| Kept 4 chunks · ~1,180 tokens (estimate) · 31% of chunk budget | retrieval | app | kept ids |
| Dropped `rental-agreement#fees-2` · over-budget | retrieval | app | chunk, estimated tokens, reason |
| Trimmed tool result · 23 candidates → 4 sent to model | retrieval | app | search-tool mode only; what was cut and why |
| Model request 1 · 2,904 prompt tokens (estimated 2,760) · 35% of window | model | app | full body, chunk spans |
| Citation `[permits#quotas]` not in this request | warn | app | the cited label |

Stage timings (embed, search, rerank, generate, swap) are attached to the
turn-complete row.

### 6.4 Routes

`POST /api/ask` (SSE), `POST /api/compare` (SSE, three runs in sequence,
tagged by mode), `GET /api/index` (loaded strategy, settings, counts, map
coordinates, corpus-hash status), `POST /api/index/select` (switch to
another built strategy), `POST /api/index/rebuild` (SSE progress),
`GET /api/documents/:id`.

At startup the app compares each index file's stored corpus hash with a
hash of `corpus/`. A mismatch is a `warn` row in the log and a banner in
the UI, naming the stale index and offering the rebuild.

---

## 7. The UI

One page, four areas:

- **Chat** with a mode switch (none / pre-retrieved / search tool) and a
  **Compare** button that sends the question through all three.
- **Retrieval panel:** search settings (mode, top-k, floor, rerank), a
  **budget check** toggle (on by default; off lets chunks run past the
  window so the drop detector fires), a thinking toggle (§6.1), the
  chunking strategy selector with the loaded index's settings and a
  rebuild button, and the candidate table for the last search (kept rows
  bold, dropped rows grayed out with their reason).
- **Activity log:** as in the data lab, with the `retrieval` level in its
  own color. Clicking a model request opens the request view with chunk
  spans highlighted.
- **Map:** the embedding map for the last question.

**Compare view:** three log columns, one per mode, and a summary row:
model requests, prompt tokens, total time, chunks sent, answer correct
(when the question is from the set), citations valid. The ten-second
version of the lab is one question in this view.

### How a reader follows one question

Pick "What's the fee if we bring the canoe back a day late?" and press
Compare. No-retrieval: one 400-token request and an invented fee.
Pre-retrieved: a search row, four chunks kept, a 2,900-token request with
the fee table highlighted, and the right fee. Search tool: the model
searches "late fee," then a second request, about the same answer, two
requests. Then switch the index to `fixed` chunking and ask again: the
fee table splits, and the pre-retrieved answer gets the number wrong
while citing a chunk that looks right.

### 7.1 GitHub Pages overview (`index.html`)

Same shape as the other labs: what it teaches, a screenshot of the compare
view, setup in three commands, and counts checked against the repo.

---

## 8. The scorecard (`npm run eval`)

Code scores everything. No model judges.

**Hit rules** (shared by every retrieval number):

- A chunk **contains** a gold span when the chunk's *original* text
  contains the whole span, after normalizing whitespace and case (not
  digits). For `heading+context`, the prepended title and heading path
  are not part of the match; they help the embedding, not the score.
- A span that **straddles two chunks** is in neither. That's a miss, on
  purpose: it is exactly what `fixed` chunking does to a fee table.
- A question is a **hit at k** when every one of its gold spans is
  contained in some kept chunk. For single-span questions that's the
  usual definition; for multi-hop questions it means *all* hops were
  retrieved. A partial multi-hop retrieval is reported as `partial`, not
  as a hit.
- `MRR` uses the rank of the first chunk containing any gold span.

**Retrieval pass** (no chat model, so it runs fast): for each question
and each configuration, `hit@k`, `partial` and `MRR`. Configurations:
vector / keyword / hybrid × the three chunking strategies, read from the
three index files. Run time **estimate**: under 1 min.

**Rerank pass** (needs the chat model, so it's separate and slow): the
same table with rerank on, for hybrid search on the default chunking
strategy only. 30 questions × one scoring request each; run time
**estimate** 5–10 min, measured at step 9. Running it across all nine
configurations is a flag, not the default.

**Answers** (needs the chat model): per mode, each answer gets exactly
one outcome:

| Outcome | Rule |
|---|---|
| `correct` | every required fact present, no forbidden fact |
| `declined` | the answer says the documents don't contain it. The right outcome on unanswerable questions; on answerable ones, a retrieval failure that didn't turn into an invention |
| `conflict-flagged` | stale questions only: both the 2025 and 2026 figures present, and the answer says the documents disagree. Reported on its own line: honest, but not the answer a customer needs |
| `invented` | anything else: a required fact missing, or a forbidden fact present, without declining |

`declined` and `conflict-flagged` are detected by phrase matching ("don't
contain," "not in the documents," "conflict," "differ," and a short list
written in step 6 before any answer run). **This is a heuristic**, labeled
as one in `scorecard.md`, which lists every answer the phrases classified
so a reader can check them. `citation-valid` is scored on top of the
outcome. Plus requests, prompt tokens (estimated and actual) and time per
question.

The headline table puts both together, so a reader can see retrieval
misses turning into invented answers. Answer pass run time **estimate**:
30 questions × 3 modes × 1 model ≈ 20–30 min on this machine, measured at
step 9. Results go to `docs/scorecard.md`. Nothing is tuned after the
final run.

**Tuning on the test set.** Chunking defaults are picked once, at step 7,
from the same 30 questions the scorecard reports. With 30 questions a
held-out split would be too small to mean anything, so the lab doesn't
pretend to have one. `scorecard.md` says plainly that the defaults were
chosen on these questions, and shows the full table for every strategy so
a reader can see how much the choice mattered.

Tests (`node:test`): chunk boundaries never split mid-word, and overlap is
exact; RRF ordering on fixed inputs; the floor rule per search mode
(a BM25 match below the vector floor survives in hybrid); the budget
drops in the right order with the right reasons, and the remaining budget
shrinks across several tool results; span matching ignores whitespace and
case but not digits, ignores prepended context, and treats a straddling
span as a miss; multi-hop hits need every span; scoring near misses (a
"$35" required fact doesn't match "$350"); each answer gets exactly one
outcome.

---

## 9. Build order

At the end of **every** step: `npm run typecheck` and
`npm run audit-comments` pass; from step 3 on, `npm test` passes; one
commit with a plain imperative message.

Steps marked 🦙 need Ollama running.

| Step | Build | Ends with something you can run and check |
|---|---|---|
| 0 🦙 | **Verify.** `docs/verified-facts.md`: package versions; FTS5 available in `node:sqlite`; Ollama's embeddings endpoint and nomic-embed-text's dimensions; whether a rerank endpoint exists; `num_gpu: 0` keeps the embeddings model on CPU, and whether the chat model then stays loaded; embedding time per chunk on CPU and GPU; whether qwen3.5:4b thinks by default and whether `think: false` turns it off | verified-facts.md with each fact marked confirmed / changed / pending |
| 1 | **Skeleton.** `git init`, remote `origin` set to the GitHub repo (§13, #8); no push without your go-ahead. audit-comments first, then tsconfigs, `.gitattributes`, `.gitignore`, LICENSE, `.env.example`, package.json with scripts stubbed, `shared/types.ts` draft, `check-env` | `npm run check-env` prints its lines |
| 2 | **Corpus.** All documents and `corpus/README.md` with the trap list. Reviewed by you before step 3, because every expected answer depends on it | a corpus you've read and approved |
| 3 | **Chunking.** `shared/chunk.ts`, three strategies, tests | `npm test` passes; a script prints chunk counts and the five longest and shortest chunks per strategy |
| 4 🦙 | **Index.** schema, `scripts/index.ts`, `project.ts`, corpus hash stored in each index | `npm run index` builds the three `data/index-<strategy>.db` files, printing chunk count, time and settings for each; editing a corpus file makes `npm run check-env` report the indexes as stale |
| 5 🦙 | **Search and tool server.** vector, keyword, fusion, `search_docs`, `get_document`, `list_documents`; `try-tools` | `npm run try-tools`: the exact-term query finds `EP-14` by keyword and misses by vector (if vector finds it too, that's recorded, not engineered away) |
| 6 | **Question set.** 30 files; a self-check that every gold span exists verbatim in the corpus; the decline and conflict phrase lists (§8), written before any answer run | `npm run eval -- --check` prints "30 questions, all spans found" |
| 7 | **Retrieval scorecard.** retrieval pass of `eval.ts`, with the hit rules; pick chunking defaults once from it | the retrieval table; defaults written into §4.1 with the measured reason |
| 8 🦙 | **Modes.** model client, `budget.ts`, `assemble.ts`, the three modes (search-tool mode with app-side trimming and the remaining budget), `ask.ts`, `compare.ts` | `npm run compare -- "late fee question"` prints three logs and the summary row, with estimated and actual prompt tokens |
| 9 🦙 | **Answer scorecard and rerank.** answer pass and rerank pass | `docs/scorecard.md` generated, including the list of phrase-classified answers; measured run times written into §8 |
| 10 | **UI.** routes, SSE, chat, retrieval panel (budget and thinking toggles, strategy selector), log, request view, compare view, map, stale-index banner | the §7 walkthrough works in a browser |
| 11 | **Docs.** README, how-it-works.html, index.html with measured counts, final CLAUDE.md | every count checked against the repo or the scorecard |

---

## 10. Conventions

Same as the other local labs, in CLAUDE.md: American English; every file
opens with what it does, why and what it teaches; `textContent`, never
`innerHTML` (corpus text is rendered in the page); no silent retries; a
heuristic is labeled as one; a number in the docs is measured or marked
as an estimate.

Invariants specific to this lab:

- Both retrieval modes go through `search_docs`. There's no second search path.
- The tool server returns every candidate that passes the floor (§4.2).
  Selection happens in the app, where it is logged, in both retrieval
  modes: in search-tool mode the model never sees an untrimmed tool result.
- Every chunk that reaches a model request is recorded with its span. A
  request with unrecorded context is a bug.

---

## 11. Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| **Model swapping** between the embeddings and chat models on 4 GB | every question pays 5–8 s twice | step 0 measured no swap at `num_ctx` 8192 (both models fit); `load_duration` is logged as its own stage, so a swap under other settings is visible |
| **llama3.2:3b hides tools after a tool result** (measured earlier) | search-tool mode can only search once | reported as a model finding, as in the prompt injection lab; qwen is the default |
| **The small model never calls `search_docs`** | search-tool mode looks like no-retrieval | that's a result, counted per question; the system prompt isn't reworded to force it after measurement |
| **The corpus is too easy** | every configuration hits, and nothing differs | the traps are planted and listed; if the step 7 table shows no differences, the corpus is fixed *before* the answer pass, and the change is recorded |
| **The corpus is tuned to make a point** | results stop being honest | traps are written in step 2, before any measurement; after step 7, only documented fixes; nothing changes after step 9 |
| **Silent history truncation** | big top-k drops history without saying so | the data lab's drop detector, plus the budget check |
| **The chars ÷ 4 token estimate is off** | the budget lets through more than fits | labeled a heuristic; estimate and actual shown side by side; the reply reserve absorbs normal error; the drop detector catches the rest |
| **Phrase matching misclassifies a decline or a conflict** | scorecard counts shift | phrase lists frozen before any answer run; every phrase-classified answer listed in `scorecard.md` for a reader to check |
| **Thinking tokens skew the comparison** | one mode looks slower or bigger for reasons unrelated to retrieval | `think: false` by default, confirmed in step 0; thinking shown and counted separately when on |
| **Reranking with the chat model is slow** | compare view feels broken; retrieval scorecard stops being fast | off by default; its time is shown; labeled "slow by design"; its own scorecard pass, separate from the fast retrieval pass |
| **PCA map misleads** | readers trust 2D distances | a caption saying so; similarity scores shown on hover |
| **Index out of date** after editing the corpus | wrong answers with no visible cause | index stores a hash of the corpus; the app warns at startup if they differ |

---

## 12. Facts to verify before building (step 0)

**Done 2026-11-20.** Results, with each fact marked confirmed, changed or
pending, are in `docs/verified-facts.md`; the changes are folded into
§4.2, §4.4, §6.1 and §11.

- `node:sqlite` in the current Node 24 has FTS5 enabled.
- Ollama's embeddings endpoint (`/api/embed`), batch input, and
  nomic-embed-text's output dimensions.
- Whether nomic-embed-text expects task prefixes (`search_query:`,
  `search_document:`). If it does, they're applied and explained in a comment.
- No native rerank endpoint in Ollama.
- `num_gpu: 0` per request keeps the embeddings model on CPU, and whether
  the chat model then stays loaded.
- MCP SDK versions match the other labs, or what changed.
- Whether qwen3.5:4b thinks by default, and whether `think: false` per
  request turns it off.

---

## 13. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Business name, domain and accent color | **Decided:** **Paddle Section Supply**, `paddlesectionsupply.example`; accent **deep green** |
| 2 | Link the other labs from the README? | **Decided: no.** Standalone like the others; one sentence on structured data vs. tools, with no link |
| 3 | Default chat model | **Decided: qwen3.5:4b**, llama3.2:3b selectable; revisit after step 9 |
| 4 | Reranker | **Decided: the chat model, off by default** in v1; a transformers.js cross-encoder (another ~100 MB download, CPU only) as future work |
| 5 | Map projection | **Decided: PCA from scratch** (stable, teachable); UMAP as future work |
| 6 | Chunk sizes exposed in the UI | **Decided: three presets per strategy**, not free text, so a rebuild stays under ~1 min (**estimate**) |
| 7 | Include the stale 2025 rate sheet? | **Decided: yes.** It's the most realistic failure in the set |
| 8 | GitHub repo | **Decided:** `https://github.com/cjsharp1/local-rag-lab.git`, added as `origin` at step 1. Pushing still waits for your go-ahead |

---

## Future work (out of scope for v1)

- A cross-encoder reranker, measured against the chat-model reranker.
- Query rewriting / HyDE as a fourth mode.
- Prompt injection through a poisoned document.
- PDF and HTML ingestion with a parsing stage.
- UMAP map.
- Metadata filters (document type, season) and their effect on stale answers.
