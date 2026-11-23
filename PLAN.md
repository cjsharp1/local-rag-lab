# local-rag-lab — build plan

A local teaching lab that shows what retrieval-augmented generation does
to the requests a model receives: the same question answered three ways,
side by side in the activity log, with every retrieved chunk, score and
token visible.

Status: **built: all eleven steps done (2026-11-23).** The corpus, the
chunker, the indexes, the MCP search tools, the question set, the three
answer modes, the rerank stage, the full scorecard (`npm run eval`,
docs/scorecard.md, results in §8), the browser UI (`npm run dev`,
http://127.0.0.1:3400) and the docs (README.md, docs/how-it-works.html,
index.html, CLAUDE.md) are in place. Defaults: `heading+context`,
`default` preset, hybrid mode, top-k 4, floor 0.50. This plan is now the
build's record: every section was corrected where a step proved it
wrong, and each correction says which step and why.

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
   exists for that reason. *Measured at step 5: on this small corpus,
   vector search found the codes too, within its top two every time
   (docs/verified-facts.md). The lesson stands as the reason hybrid search
   exists; whether this corpus demonstrates it is for the step 7
   scorecard to show.*
6. **A similarity score can't tell you the answer isn't there.** *(Added
   at step 5.)* A question the corpus can't answer still gets a best match
   around 0.75, higher than some real answers score. No floor separates
   them; deciding "the documents don't say" is the answer step's job.

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
│   ├── corpus.ts              reads corpus/*.md (skipping README.md) into normalized documents
│   ├── db.ts
│   ├── embed.ts               one function: text → vector, via Ollama (task prefixes, no silent truncation)
│   ├── pca.ts                 fits the 2D map at index time, projects the query at question time
│   ├── search/
│   │   ├── vector.ts          cosine similarity over every chunk
│   │   ├── keyword.ts         FTS5 BM25
│   │   ├── fuse.ts            reciprocal rank fusion
│   │   └── search.ts          one entry point, returns every candidate with every score
│   ├── tools/                 search_docs (search-docs.ts), get_document and list_documents (documents.ts)
│   ├── indexes.ts             loads all three indexes at startup; search_docs picks one by `strategy`
│   ├── mcp-server.ts
│   ├── stdio.ts
│   └── http.ts
├── server/
│   ├── index.ts               routes, SSE, Host/Origin guard
│   ├── logger.ts              log rows to a sink; one method per level, `retrieval` included
│   ├── log-format.ts          a log row as a terminal line
│   ├── turn.ts                runTurn(): one question through one mode; the routes, scripts and scorecard all call it
│   ├── model/ollama.ts        chat over fetch, streamed and joined; think, num_ctx, num_predict, temperature 0
│   ├── mcp/client.ts          spawns the tool server, calls search_docs
│   ├── modes/
│   │   ├── common.ts          Turn: model calls with the drop detector, search + selection logging, citations
│   │   ├── none.ts            question → model
│   │   ├── pre-retrieved.ts   question → search_docs (actor: app) → assemble → model
│   │   └── search-tool.ts     the tool loop, with search_docs offered (actor: model)
│   ├── context/
│   │   ├── budget.ts          fits chunks into the token budget, decides what's dropped and why
│   │   ├── assemble.ts        builds the prompt, marks the chunk spans for the UI, reads citations
│   │   └── rerank.ts          optional rerank stage (§4.4), step 9
│   ├── questions.ts           loads questions/*.json and checks them against the corpus
│   └── system-prompt.ts
├── shared/
│   ├── types.ts
│   ├── chunk.ts               chunker, shared by the index script and the tests
│   ├── local-only.ts          the no-remote-host, no-cloud-model rules
│   ├── scoring.ts             span and fact matching, the frozen phrase lists, answer outcomes
│   └── search-settings.ts     search defaults (mode, top-k, floor) and RRF's k
├── public/
│   ├── index.html, styles.css
│   ├── app.ts                 wiring: meta, settings, Ask, Compare, rebuild, tabs
│   ├── api.ts                 JSON GETs, and SSE read from a POST response
│   ├── dom.ts                 el()/append(): text nodes only, never innerHTML
│   ├── log.ts                 the activity log; "View request" on model requests
│   ├── retrieval.ts           the panel's settings and the candidate table (also the map's table view)
│   ├── compare.ts             the three-column view and its summary table
│   ├── map.ts                 the embedding map (canvas), legend, hover labels
│   └── request-view.ts        full request with chunk spans highlighted
├── scripts/
│   ├── audit-comments.ts      copied first, at step 1
│   ├── check-env.ts
│   ├── chunk-report.ts        chunk counts and the longest and shortest chunks per strategy
│   ├── index.ts               chunk + embed + store → data/index-<strategy>.db (all three by default)
│   ├── try-tools.ts
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
| `heading` | whole consecutive sections packed up to N tokens; a section is cut only when it alone exceeds N, preferring a paragraph break, then a line break (table rows stay whole), then a sentence end | structure-aware chunking: a chunk never cuts a section that fits |
| `heading+context` | `heading`, plus the document title and heading path prepended to each chunk before embedding | the cheap version of "contextual retrieval": a chunk that says "this fee" now also says which fee |

Size presets, the same for every strategy (decision #6), in estimated
tokens: **small** 150/25 overlap, **default** 300/50, **large** 600/100.

**Defaults: `heading+context`, `default`** (chosen once at step 7, then
frozen). The retrieval pass (`npm run eval -- --retrieval`, results in
docs/scorecard.md) measured hit@4 for 27 answerable questions in all 27
configurations. The selection rule was written into
`scripts/eval-retrieval.ts` before the first run: highest hybrid hit@4,
then hybrid MRR, then the preset nearest `default`. Hybrid hit@4:

| Strategy | small | default | large |
|---|---|---|---|
| `heading` | 17 | 19 | 20 |
| `heading+context` | 19 | **21** (MRR 0.724) | 21 (MRR 0.681) |
| `fixed` | 17 | 16 | 20 |

The plan's prior was `heading`. The rule chose `heading+context` because
of the split-context questions (3/3 with the heading path embedded, 2/3
without, 0/3 for `heading` in vector mode). `small` is worst in every
strategy: chunks of ~100 tokens carry too little to match. This choice
was made on the same questions the scorecard reports; with 30 questions
there is no held-out set (§8).

**Changed at step 3: heading packs whole sections.** The draft split at
every heading. Measured on this corpus, that made 307 chunks averaging
116 tokens at the default size, against 148 averaging 279 for `fixed`:
thirteen short regulations and two dozen FAQ answers each became a
chunk, and top-4 would have handed the model a third as much text as
`fixed` does, which would make the strategies incomparable. Packing
whole consecutive sections up to the size limit gives 164 chunks
averaging 215 tokens. Empty headings ("## Day by day" followed straight
by "### Day 1") merge into the next section. The three split-context
sections are each longer than one chunk at every preset, so they're
still cut, and in every case the chunk holding the answer doesn't name
its subject (checked at step 3).

Measured chunk counts (`npm run chunk-report`):

| Strategy | small | default | large |
|---|---|---|---|
| `fixed` | 288 | 148 | 79 |
| `heading`, `heading+context` | 354 | 164 | 81 |

Overlap rules: `fixed` starts the next chunk at the first word that
begins within the overlap. The heading strategies prefer the first line
that begins within it, and skip the overlap when a cut falls on a line
break and no line begins inside it. So an overlap never starts halfway
along a table row.

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
  `topK` (default 4), `floor` (minimum vector similarity, **0.50**, set
  at step 5 from the score distribution of nine probe questions over all
  three indexes; docs/verified-facts.md has the table). It's a noise cut,
  not a relevance test: score levels vary by question so much that the
  lowest answer chunk seen (0.587) scored below another question's median
  chunk (0.613), and a question with no answer in the corpus still had a
  best match of 0.748. Defaults live in `shared/search-settings.ts`;
  hybrid is the default mode.
- **The floor applies only to candidates found by vector search alone.**
  In vector mode, a chunk below the floor is dropped. In keyword mode the
  floor doesn't apply. In hybrid mode, a chunk is dropped only if it is
  below the vector floor *and* has no BM25 match. Otherwise a chunk that
  BM25 finds by `EP-14` but that scores 0.2 on vector similarity would be
  cut before the app ever saw it, and the exact-term lesson would vanish.
  Every candidate's vector score is still reported, so the log shows when
  keyword search rescued a chunk the floor would have dropped.
- **Below-floor chunks come back as a summary** (changed at step 5): a
  count, and the best of them with its score. Listing every one would be
  most of the corpus on every search. The app logs the summary as one
  `below-floor` row; every other dropped chunk gets a row of its own.
- **The keyword query is built, not passed through.** Common words and
  stray letters are dropped (a short fixed list, labeled as a heuristic),
  and each remaining word is quoted. Without the stopword list, "the"
  matches nearly every chunk and keyword search returns the corpus. The
  built query and the dropped words travel with every result.

**Measured at step 7: hybrid can bury vector search's best hit.** On
paraphrase questions, hybrid scored 3/5 against vector's 4/5
(`heading+context`). For "Can our pup come along on the trip?", vector
search ranks the dog answer #1, keyword search #89 and hybrid #13. The
keyword query ORs every remaining word, and "trip" matches most of the
corpus, so nearly every chunk appears in both lists. RRF rewards
appearing in both over being first in one, and dozens of mediocre
double-matches outrank vector's best. Hybrid still wins where it was
meant to: exact terms (5/5 against vector's 4/5) and split context (3/3
against 2/3). **Decided: kept as is and taught as a finding** rather than
tuned away after seeing the numbers (fusing only each list's top N is the
usual fix, and the README names it).

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

Changed at step 8:

- **Past-top-k is one row**, listing every chunk in its detail. A
  hybrid search returns 130–160 candidates (§4.2), so a row per chunk
  would bury the log. Over-budget chunks still get a row each, since
  there are only ever a few. Below-floor arrives as a summary (§4.2).
- **Once a chunk doesn't fit, the rest of the top k are over-budget**,
  even if a later one is smaller. What's sent is always a prefix of the
  ranking.
- **Reaching the drop detector needs the `large` preset** (16 × ~600
  tokens) or a smaller `NUM_CTX`: at the default preset, 16 chunks are
  about 3,500 tokens and fit the 8,192-token window with room to spare.

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

### 4.5 The embedding map (`tool-server/pca.ts`, `public/map.ts`)

PCA to two dimensions, written in TypeScript (power iteration, about 60
lines), computed at index time and stored with the chunks. The query is
projected with the same components at question time, which is why the
math lives in the tool server rather than in a script (changed at step 4;
the draft had `scripts/project.ts`). Measured at step 4: the two axes
keep about 20% of the variance (fixed 12.3% + 7.9%, heading 10.7% +
7.6%, heading+context 11.9% + 9.2%), and the UI prints that share under
the map. The map shows chunks
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
tokens by the chars ÷ 4 heuristic. Counted at step 3: **164 chunks**
with `heading` at the default size, 148 with `fixed` (§4.1). The corpus is
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

Each file holds: the question, its category, **hops** of gold spans,
required answer facts, forbidden facts (for stale questions and the two
multi-hop questions that touch the rate sheets, the 2025 figure) and a
note on which trap it tests. Changed at step 6:

- **Hops with alternatives.** `hops` is a list of hops; each hop is a
  list of alternative spans (`{ doc, text }`), any one of which counts.
  A question is a hit when every hop is found. Many facts appear in two
  places (a table row and a paragraph, a policy and the FAQ), and a chunk
  holding either is a legitimate hit.
- **Facts with wordings.** Each required fact is a string or a list of
  acceptable wordings ("6 p.m.", "6 pm", "6:00 pm"…).
- **One multi-hop question replaced.** The draft's "quota at the Granite
  River Run's entry point" turned out answerable from one chunk:
  entry-points.md's EP-22 paragraph names the route *and* gives the
  quota. It became "How much does it cost per day to rent your lightest
  canoe?": the catalog says which canoe is lightest but has no prices,
  and the rate sheet has prices but no weights.

`npm run eval -- --check` validates every file and checks it against the
corpus: every gold span is in its document (ignoring case and
whitespace, never digits), every required fact is in the question's own
gold text, every forbidden fact is in the corpus but not in the gold
text, no span is longer than 100 characters, and the category counts
match the table above. It passes with 30 questions and 48 gold spans, and
`npm test` runs the same check.

**Changed at step 7: spans are at most 100 characters.** The first
retrieval run showed `fixed` missing split-context-2 entirely, because
its 336-character span straddled a chunk boundary: a span longer than the
chunk overlap can be cut in two, and a cut span counts as a miss. That
measured the span's length, not the strategy. Four spans were shortened
to the clause holding the fact (with a second short span as an
alternative where a question requires two facts), and `--check` now
rejects any span longer than the `small` preset's overlap (100
characters). Only retrieval measurement changed; no answer had been
generated. The chunking choice above came out the same before and after.

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
tagged by mode), `GET /api/meta` (models, defaults, presets, index status
with staleness, documents, the question set), `GET /api/map?strategy=`
(the embedding map's points), `POST /api/index/rebuild` (SSE progress),
`GET /api/documents/:id`.

Changed at step 10:

- **No `/api/index/select`.** The tool server loads all three indexes
  (step 5), so the strategy travels with each request instead of being
  switched on the server.
- **A fourth MCP tool, `index_map`**, gives the map its points through the
  tool server, since the app never opens an index file. The model is
  never offered it.
- **Rebuild runs `npm run index` as a child process** and streams its
  output. It stops the tool server first, because the tool server holds
  every index file open and Windows won't let the build rename a new file
  over an open one; questions are refused (409) until the build ends, and
  the next one starts a fresh tool server with the new index.

At startup the tool server compares each index file's stored corpus hash
with a hash of `corpus/`; a mismatch is a banner in the UI (from
`GET /api/meta`) naming the stale index, and `indexStale: true` on every
search result from it, which the log shows as a `warn` row.

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

*Rewritten at step 10 from the step 9 scorecard and the browser. Every
outcome below is measured (qwen3.5:4b, defaults); the draft's version
predicted an invented fee for the plain late-fee question and a `fixed`
index that broke it, and neither happened (no-retrieval declined; under
`fixed` the answer was still $35, citing `[rental-agreement#2]`).*

Pick each of these from "Question from the set" and press **Compare
all three**:

1. **"We might not make it back until dinnertime on our final
   evening. Will that cost us?"** No retrieval: *"a late fee of $15 per
   person [rental-agreement#late-returns]"*, a fluent, invented answer
   citing a chunk that was never sent; the log flags the citation.
   Pre-retrieved: a search row with `app` as the actor, four chunks
   kept, about 1,000 prompt tokens, and **$35 per boat**. Click "View
   request" to see the fee paragraph highlighted inside the prompt.
   (Lessons 1 and 2.)
2. **"Can our pup come along on the trip?"** Pre-retrieved declines:
   hybrid search buried the dog answer at #13, past top-4 (the candidate
   table shows it). Search tool: the model searched for "pup dog pet
   allowed on trip", found it, and answered with the leash rule. Two
   requests and 1.7× the tokens for the right answer. (Lesson 3.)
3. **"How much does it cost to rent a Northline 17 Kevlar canoe for one
   day?"** Pre-retrieved answers **$58**, from the 2025 rate sheet,
   citing it. Search tool gives $58 (2025) and $64 (2026). Nothing in
   the corpus says 2025 is obsolete, and nothing in the retrieval knows.
4. **"Do day-use permits cost anything?"** Switch the index to `heading`
   and ask in pre-retrieved mode: the answer chunk says only "They cost
   nothing" and ranks #15. Switch to `heading+context`, where the heading
   path is embedded with it: it ranks #3, and the answer is right.
5. **"What's the longest portage on the route that starts at EP-14?"**
   All three decline. Search tool searched once, got the Heron Chain
   Loop's portages without learning that EP-14 is Heron Lake, and didn't
   search again. A 4B model's agentic RAG, measured.

The map tab shows each question land among the chunks, with lines to
the four that were sent; the caption gives the share of variance the
two axes keep (about 21%), so nobody mistakes it for the real distances.

**Verified in a browser at step 10** (headless Edge over the DevTools
protocol, light and dark, 1440 px and 390 px wide): the page loads with
the defaults; Ask streams the log row by row; "View request" shows every
chunk highlighted; the map draws, with the query and lines to the sent
chunks; Compare fills three columns and the summary table; rebuilding an
index through the panel works; no console errors; no sideways scrolling
at phone width.

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

`declined` and `conflict-flagged` are detected by phrase matching
(`DECLINE_PHRASES` and `CONFLICT_PHRASES` in `shared/scoring.ts`, written
at step 6 before any answer run and frozen since). Naming both 2025 and
2026 also counts as flagging the conflict. Outcomes are checked in a
fixed order: correct, then conflict-flagged (stale only), then declined
(only with no forbidden fact), then invented. Correct comes first, so
"the documents don't say why, but the fee is $35" scores as correct.
**This is a heuristic**, labeled as one in `scorecard.md`, which lists
every answer the phrases classified so a reader can check them. `citation-valid` is scored on top of the
outcome. Plus requests, prompt tokens (estimated and actual) and time per
question.

The headline table puts both together, so a reader can see retrieval
misses turning into invented answers. Results go to `docs/scorecard.md`,
and every answer's full text to `docs/scorecard.json`. Nothing is tuned
after the final run.

### Measured at step 9 (`npm run eval`, qwen3.5:4b, Ollama 0.40.17)

**Run time: 9.8 minutes in all** (retrieval ~0.5, answers **7.5**,
rerank **1.8**), against the draft's 20–30 minute estimate for the answer
pass alone: the default chunks are small, so prompts average 1,229 tokens
(pre-retrieved) and 2,091 (search-tool).

| Mode | correct | declined | conflict-flagged | invented | citations valid / not sent |
|---|---|---|---|---|---|
| none | 1 → **0** | 26 → **28** | 0 | 3 → **2** | 0 / 2 |
| pre-retrieved | 20 | 7 | 1 | 2 | 29 / 0 |
| search-tool | 21 | 6 | 2 | 1 | 28 / 1 |

(Arrows: the hand audit below. The scorecard shows the scorer's counts.)

What it says, against the lessons in §1:

- **Retrieval caps answer quality (lesson 2), cleanly.** When every gold
  hop was in the prompt, pre-retrieved was correct 20 of 21 times and
  search-tool 20 of 22, with no invented answers; the rest flagged the
  stale conflict. When the gold wasn't there, the model mostly declined
  (pre-retrieved 4 of 6, search-tool 3 of 5). Every invented answer from
  a retrieval mode came from a prompt missing a hop, or holding the 2025
  sheet instead of the 2026 one.
- **No-retrieval declines more than it invents.** With "answer only from
  the documents" and no documents, qwen declined 28 of 30. The two
  inventions are the lesson in miniature: a 5 p.m. return deadline (it's
  6 p.m.) and a "$15 per person" late fee (it's $35 per boat), each with
  a citation to a chunk that was never sent. The draft expected
  invention to be the norm; it's the exception, and more dangerous for it.
- **The stale sheet is the hardest trap: 0 of 2 correct in every mode.**
  Given both rate sheets, the model gives both years (3 conflict-flagged);
  given only the 2025 sheet, it answers from it ($58 for the Kevlar
  canoe). multi-hop-3 shows the same behavior and scores **invented**,
  because conflict-flagged exists only for the stale category (§8 rules).
- **Multi-hop: 0 of 3 in every mode.** Search-tool mode was meant to
  have a chance here. It didn't take it: **qwen searched exactly once on
  28 of 30 questions and never twice**, and answered 2 without searching.
  On the EP-14 question it saw the Heron Chain Loop's portage table,
  didn't know EP-14 was Heron Lake, and declined instead of searching
  again.
- **Search-tool's edge is query rewriting.** 21 correct to pre-retrieved's
  20, the difference in paraphrase questions (4 to 3): "Can our pup come
  along?" became a search for "pup dog pet allowed on trip". It costs
  1.7× the prompt tokens and 1.6× the time.
- **Citations are mostly honest.** 57 valid labels in the two retrieval
  modes against one not sent (a plausible-looking id the model made up).

**Rerank pass:** hit@4 21 → **23** of 27, two gained (paraphrase-5 and
stale-1, which moved the 2026 rate row into the top 4), none lost, no
unreadable replies; **3.9 s per search** added.

### Repeatability (step 11)

A second run of the answer and rerank passes, same settings, matched the
scorecard on **89 of 90 answers** and every rerank result. The one change:
search-tool mode on the pup question went from a search and a correct
answer to no search and a decline, and stayed that way on five more
runs, with an identical request. Temperature 0 and a fixed seed make runs
close to repeatable, not exactly (docs/verified-facts.md). The scorecard
stays the first run; the docs say how much a rerun moved.

### Scorer audit (step 9, by hand)

The scorecard lists every answer the phrase heuristics classified (42),
and every answer was read against its outcome. **Two are wrong**, both in
no-retrieval mode and both the scorer's fault, not the model's:

| Answer | Scored | Should be | Why |
|---|---|---|---|
| multi-hop-2, none: "The documents do not **state** the cost of the shuttle…" | invented | declined | "do not state" isn't in the frozen `DECLINE_PHRASES` list |
| paraphrase-2, none: "The documents do not specify which life vest… for a **child**…" | correct | declined | the only required fact, "child", is echoed from the question; correct is checked before declined |

The phrase lists stay frozen and the scorer isn't changed after the
final run (§8): the scorecard keeps the scorer's numbers, and the audit
lives here. The second error points at a rule worth having in a future
version: a required fact that appears in the question itself shouldn't
count as evidence.

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
| 4 🦙 | **Index.** schema, `scripts/index.ts`, `tool-server/pca.ts`, corpus hash stored in each index | `npm run index` builds the three `data/index-<strategy>.db` files, printing chunk count, time and settings for each; editing a corpus file makes `npm run check-env` report the indexes as stale |
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
| **The small model never calls `search_docs`** | search-tool mode looks like no-retrieval | that's a result, counted per question; the system prompt isn't reworded to force it after measurement. *Measured at step 9: it skipped searching on 2 of 30, but never searched twice, which is the bigger loss (§8)* |
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
| 3 | Default chat model | **Decided: qwen3.5:4b**, llama3.2:3b selectable. Revisited after step 9: kept. qwen answered 20–21 of 27 answerable questions correctly with retrieval, declined rather than invented when it lacked the facts, and produced no unreadable rerank replies. llama3.2:3b isn't scored (one model × 30 questions × 3 modes per run); scoring it is future work |
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
