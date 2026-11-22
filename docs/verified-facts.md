# Verified facts (step 0)

Checked on 2026-11-20 against installed packages, live runs and the
running Ollama server, not memory. Probe scripts were throwaway and
lived outside this repository. Every fact below is marked:

- **confirmed**: matches what PLAN.md assumed;
- **changed**: differs from the plan, which has been corrected;
- **pending**: can only be checked at a later step.

Machine: Windows 11, Node 24.4.1, npm 11.4.2, NVIDIA RTX A1000 laptop
GPU (4 GB VRAM). Ollama 0.40.16.

---

## Packages (npm, today)

| Package | Version | Status |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | confirmed, same as the other labs |
| `@modelcontextprotocol/client` | 2.4.0 | confirmed, same as the other labs |
| `@modelcontextprotocol/node` | 2.1.2 | confirmed, same as the other labs |
| `express` | 5.3.0 | confirmed |
| `zod` | 4.6.7 | confirmed |
| `dotenv` | 18.0.10 | confirmed |
| `tsx` | 4.23.15 | confirmed |
| `typescript` | 7.0.2 | confirmed |
| `@types/node` | 24.19.2 (the 24 line; latest is 26.6.6) | confirmed. Pin `^24` to match the Node target, not the latest major |
| `@types/express` | 5.0.6 | confirmed |

The MCP SDK hasn't changed since the other labs were built, so their
MCP patterns carry over unchanged.

---

## SQLite and FTS5 (PLAN §2, §4.2)

| Fact | Finding | Status |
|---|---|---|
| `node:sqlite` version | SQLite 3.50.2, compiled with `ENABLE_FTS5` | **confirmed, run** |
| BM25 | `bm25(table)` works; lower (more negative) is better, so sort ascending | confirmed, run |
| Raw query text | **Throws.** `MATCH 'EP-14'` fails with "no such column: 14" (the hyphen reads as a column filter); `MATCH 'what about EP-14?'` fails with a syntax error | **changed** |
| Quoted terms | `MATCH '"EP-14"'` finds the chunk | confirmed, run |
| Experimental warning | Node prints `ExperimentalWarning: SQLite is an experimental feature` on first use | noted. The README says why it's there; scripts don't hide it |

**Plan change (§4.2):** `keyword.ts` turns the query into FTS5 syntax
itself. It splits on whitespace, strips FTS5 operators and punctuation
other than inner hyphens, wraps each term in double quotes, and joins
them with `OR`. The built FTS5 query is logged next to the original,
because the conversion is part of what keyword search does.

---

## Ollama embeddings (PLAN §6.1, §12)

| Fact | Finding | Status |
|---|---|---|
| Endpoint | `POST /api/embed` with `{ model, input }` returns `{ embeddings: number[][], prompt_eval_count, total_duration, load_duration }` | **confirmed, run** |
| Batch input | `input` takes an array; one vector per item, in order | confirmed, run |
| Legacy endpoint | `/api/embeddings` (singular `prompt`) still answers. The lab uses `/api/embed` | noted |
| Dimensions | **768** | confirmed, run |
| Normalization | Returned vectors have length 1.0000, so cosine similarity equals the dot product. The lab still computes full cosine, since that's the formula being taught, and a comment says why the two match here | noted |
| Download size | 274 MB (the plan estimated about 270) | confirmed |
| Context | `model_info` reports a trained context of 2048 tokens; Ollama's default `num_ctx` for the model is 8192. The model card says it scales past 2048. Chunks are about 300–600 tokens, far below either | confirmed, not a constraint |
| Tokens per chunk | A test chunk the chars ÷ 4 heuristic put at about 311 tokens came out at 317 nomic tokens. This is nomic's tokenizer, not qwen's, so it doesn't validate the chat budget (§4.3) | noted |

### Task prefixes

The nomic-embed-text v1.5 model card says "the text prompt must include
a task instruction prefix." Use `search_document: ` for chunks at index
time and `search_query: ` for queries. **Confirmed.**

One measured pair: the late-fee question against the late-fee passage
scored 0.873 cosine without prefixes and 0.911 with them. `embed.ts`
applies the prefixes, and a comment explains them.

### Silent truncation (checked at step 4)

| Request | Result | Status |
|---|---|---|
| `/api/embed`, 12,000-word input, default settings | **HTTP 200** with a vector. The input was cut to the context length without a warning | **changed**: a silent default the plan didn't know about |
| The same with `truncate: false` | HTTP 400, `{"error":"the input length exceeds the context length"}` | confirmed, run |

`embed.ts` sends `truncate: false` on every request, so an over-long
chunk fails loudly instead of being embedded from its first part only.
No chunk in the corpus comes near the limit (the largest is about 600
estimated tokens at the `large` preset).

### Tokens: the estimate against nomic's count (step 4)

The 148 `fixed` chunks at the default preset are about 41,300 tokens by
chars ÷ 4 (prefixes included); nomic counted **41,713**. That's within
about 1%, so the heuristic is good enough for sizing chunks. It says
nothing yet about qwen's tokenizer (step 8).

### The vector floor looks too low (PLAN §4.2)

With prefixes, two **unrelated** query/passage pairs scored **0.541** and
**0.433** (late-fee query vs. hull-rinsing passage; group-size query vs.
late-fee passage). The plan's floor of 0.3 would let nearly every chunk
through and filter nothing. That's two pairs, not a distribution, so the
floor stays marked **estimate** and is **pending** step 5. `try-tools`
prints the similarity distribution over the real corpus there, and the
floor is set from it.

---

## Rerank endpoint (PLAN §4.4)

`POST /api/rerank`, `/api/v1/rerank` and `/v1/rerank` all return
**404**. Ollama has no rerank endpoint. **Confirmed.**

---

## Running both models (PLAN §6.1, §11)

The plan expected only one model to stay loaded on this 4 GB GPU, with
5–8 s swaps, and proposed embeddings on CPU (`num_gpu: 0`) to avoid
them. Measured:

| Fact | Finding | Status |
|---|---|---|
| qwen3.5:4b at `num_ctx` 8192 | Loads **partly** on the GPU: 1,880 MB of 3,887 MB in VRAM, the rest on CPU. First load 8.7 s | **changed**: not a full-GPU model at this window |
| nomic on GPU next to qwen | Loads in 0.56 s into 335 MB of VRAM, **alongside** qwen. Both stay loaded | **changed** |
| qwen after a GPU embed | Next chat call: load 10 ms. **No swap** | **changed** |
| `num_gpu: 0` | Works: nomic loads with 0 MB VRAM, and qwen stays loaded | confirmed, run |
| Changing `num_gpu` on a loaded model | Ignored: with nomic already loaded on CPU, a request without `num_gpu: 0` reused the CPU copy (load 12 ms, VRAM still 0) | noted. Placement is decided at load time, not per request |
| Index-time speed, GPU | 32 chunks of about 317 tokens in 678 ms: **21 ms per chunk** | measured |
| Index-time speed, CPU | The same batch in 6,356 ms: **199 ms per chunk**, about 9× slower | measured |
| Query embed | About 30 ms on either GPU or CPU | measured |

**Plan change (§6.1, §11):** embeddings run on the **GPU by default**,
with no `num_gpu` override. Both models fit together because qwen is
partly offloaded at this window size, so there's no swap to avoid, and
GPU indexing is 9× faster. The embed stage still logs Ollama's
`load_duration`, so if a swap ever happens (a bigger window, another
model), the log shows it as its own stage. A full rebuild of about 250
chunks estimates at about 5 s on GPU and about 50 s on CPU, which keeps
decision #6's "under a minute" for either.

---

## qwen3.5:4b thinking mode (PLAN §6.1, §12)

| Request | Thinking text | Tokens | Time | Answer |
|---|---|---|---|---|
| default (no `think`) | 6,134 chars | 1,500 (hit the `num_predict` cap) | 154 s | **empty**: still thinking at the cap |
| `think: true` | 5,881 chars | 1,500 (cap) | 155 s | empty |
| `think: false` | none | 33 | 3.6 s | one correct sentence |

The question was "In one short sentence: what is a portage?"

- qwen3.5:4b **thinks by default**. **Confirmed.**
- `think: false` turns it off completely. **Confirmed.**
- Generation runs at about **9.7 tokens/s** (1,500 tokens in 154 s) with
  the model partly on CPU.
- A first attempt without a token cap ran past Node's default 5-minute
  `fetch` header timeout with no response. The model client streams
  (`stream: true`), so headers arrive at once, and it sets `num_predict`
  on every request.

**Plan change (§6.1):** `think: false` stays the default. The thinking
toggle stays, labeled **slow by design**: on a trivial question it
didn't reach an answer in 1,500 tokens (2.5 minutes). The scorecard runs
with thinking off.

---

## Pending (checked at later steps)

| Fact | Step |
|---|---|
| Vector-similarity distribution on the real corpus, and the floor set from it | 5 |
| Whether vector search misses `EP-14` and keyword search finds it | 5 |
| Chars ÷ 4 against qwen's real `prompt_eval_count` | 8 |
| Answer-pass and rerank-pass run times | 9 |
