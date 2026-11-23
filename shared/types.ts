/**
 * types.ts — the shapes that travel between the lab's server and the browser.
 *
 * This file is the contract for the whole app. The server builds these
 * objects, sends them as JSON over Server-Sent Events, and the browser
 * parses them back out. Nothing here has any behavior: it is types only,
 * and it compiles to nothing at all. Both halves import it, so they cannot
 * quietly disagree about what crosses the connection.
 *
 * DRAFT until the UI lands (build step 10). What's here now is the
 * vocabulary every later step builds on: the three answer modes, the
 * search settings, a candidate with all of its scores, the reasons a
 * chunk is not sent, the chunk spans the request view highlights, and the
 * log row. The stream events, the compare summary and the scorecard shapes
 * are added by the steps that produce them.
 *
 * ---------------------------------------------------------------------------
 * The promise this file serves
 * ---------------------------------------------------------------------------
 *
 * The lab's rule is that if something happens and the UI does not show
 * it, that is a bug. For RAG, "something happens" mostly means retrieval:
 * a search ran, a chunk scored, a chunk was kept or dropped, a chunk was
 * pasted into a request at a particular place. So a candidate carries
 * every score it was given, a dropped chunk carries its reason, and a
 * model request carries the span of every chunk inside it. None of it is
 * summarized away before it reaches the browser.
 */

// ---------------------------------------------------------------------------
// How an answer is grounded
// ---------------------------------------------------------------------------

/**
 * The three ways the lab answers a question (PLAN §1):
 *
 *   none           nobody retrieves; the model answers from what it knows
 *   pre-retrieved  the app calls search_docs first and pastes the chunks
 *                  into the request (classic RAG)
 *   search-tool    the model is offered search_docs and decides whether,
 *                  what and how often to search (agentic RAG)
 *
 * Both retrieval modes go through the same search_docs tool. The only
 * difference is who makes the call, which the log's `actor` shows.
 */
export type AnswerMode = "none" | "pre-retrieved" | "search-tool";

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

/**
 * How the corpus is cut into chunks, chosen at index time (PLAN §4.1).
 * One index file per strategy: data/index-<strategy>.db, where
 * "heading+context" is written "heading-context" in the file name.
 *
 *   fixed            N tokens with M overlap, ignoring structure
 *   heading          split on Markdown headings, then by size
 *   heading+context  heading, with the document title and heading path
 *                    prepended before embedding
 */
export type ChunkStrategy = "fixed" | "heading" | "heading+context";

/** The size presets offered per strategy (decision #6). */
export type ChunkPreset = "small" | "default" | "large";

/** What an index was built with. Stored inside the index file itself. */
export interface IndexSettings {
  strategy: ChunkStrategy;
  preset: ChunkPreset;
  /** Target chunk size, in estimated tokens (characters ÷ 4). */
  chunkTokens: number;
  /** Overlap between neighboring chunks, in estimated tokens. */
  overlapTokens: number;
  /** The embeddings model. Vectors from different models can't be compared. */
  embedModel: string;
  /** Vector length, as the model returned it (768 for nomic-embed-text). */
  dimensions: number;
  /** Hash of corpus/ at build time; a mismatch means the index is stale. */
  corpusHash: string;
  /** When it was built, as milliseconds since the epoch. */
  builtAt: number;
  /** How many chunks it holds. */
  chunkCount: number;
  /**
   * Share of the total variance each map axis keeps, 0–1. Printed under
   * the map, because two axes keep only a small part of 768 dimensions
   * and the map's distances are distorted accordingly (PLAN §4.5).
   */
  mapVariance: [number, number];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Which signal ranks the chunks (PLAN §4.2). */
export type SearchMode = "vector" | "keyword" | "hybrid";

/** Settings that change per question, with no rebuild. */
export interface SearchSettings {
  mode: SearchMode;
  /** How many chunks to keep, at most. */
  topK: number;
  /**
   * Minimum vector similarity. Applies only to candidates found by vector
   * search alone: a BM25 match survives in hybrid mode whatever its vector
   * score (PLAN §4.2).
   */
  floor: number;
  /** Whether the chat model rescores the top candidates. Slow by design. */
  rerank: boolean;
  /**
   * Whether chunks are held to the chunk budget. Off lets them run past
   * the window, so the drop detector fires (PLAN §4.3).
   */
  budgetCheck: boolean;
}

/**
 * One chunk as search saw it, with every score it was given.
 *
 * Ranks are 1-based; a rank or score is absent when that signal didn't
 * run (keyword scores in vector mode) or didn't find the chunk (no BM25
 * match). Nothing is collapsed into a single number before the browser
 * sees it, so the candidate table can show why a chunk ranked where it did.
 */
export interface Candidate {
  /** Stable within one index: "<doc-id>#<heading-slug>[-n]". */
  chunkId: string;
  /** The label the model is asked to cite, e.g. "[rental-agreement#late-returns]". */
  label: string;
  docId: string;
  /** Heading path, outermost first. Empty for `fixed` chunks. */
  headingPath: string[];
  /** The chunk's original text, without any prepended context. */
  text: string;
  /** Estimated tokens (characters ÷ 4). A heuristic, labeled as one. */
  estimatedTokens: number;
  /** Cosine similarity to the query vector. Always computed, for the log. */
  vectorScore: number;
  vectorRank?: number;
  /** FTS5 BM25. Lower (more negative) is better, as SQLite reports it. */
  keywordScore?: number;
  keywordRank?: number;
  /** Reciprocal rank fusion score, hybrid mode only. */
  fusedScore?: number;
  fusedRank?: number;
  /** The chat model's 0–3 relevance score, when rerank is on. */
  rerankScore?: number;
  rerankRank?: number;
  /** Position on the embedding map (PLAN §4.5). */
  map?: { x: number; y: number };
}

/**
 * What one search_docs call returns (PLAN §3.3 step 3): every candidate
 * that passed the floor, with every score, in the mode's rank order. The
 * tool server never applies top-k or the budget; the app does, where it's
 * logged.
 */
export interface SearchResult {
  /** The query as given. */
  query: string;
  strategy: ChunkStrategy;
  mode: SearchMode;
  floor: number;
  /**
   * The FTS5 query keyword search actually ran, built from the query
   * (PLAN §4.2), or null when no searchable words were left. Absent in
   * vector mode.
   */
  keywordQuery?: string | null;
  /** Words dropped before keyword search: common words and stray letters. */
  ignoredWords?: string[];
  candidates: Candidate[];
  /**
   * Chunks the floor removed, summarized: listing every one would be most
   * of the corpus. The best of them shows how close the floor came to
   * letting another chunk through.
   */
  belowFloor: { count: number; best?: { chunkId: string; vectorScore: number } };
  /** How many chunks the index holds. */
  totalChunks: number;
  /** Where the query lands on the embedding map. */
  queryMap: { x: number; y: number };
  /** Milliseconds. `embedLoad` non-zero means the embeddings model had to load. */
  timings: { embed: number; embedLoad: number; search: number };
  /** True when the index was built from a different corpus than the one on disk. */
  indexStale: boolean;
}

/**
 * Why a candidate didn't reach the model. Every chunk not sent gets one.
 * `below-floor` chunks arrive as SearchResult.belowFloor, a summary that
 * the app logs as one row; the others get a row each (PLAN §4.3).
 */
export type DropReason = "below-floor" | "past-top-k" | "over-budget";

/** A candidate's fate, after the app's selection steps. */
export type Selection =
  | { kept: true }
  | { kept: false; reason: DropReason };

// ---------------------------------------------------------------------------
// The request the model receives
// ---------------------------------------------------------------------------

/**
 * Where one chunk sits inside a model request's body, so the request view
 * can highlight it. Every chunk that reaches a request is recorded with
 * its span; a request with unrecorded context is a bug (PLAN §10).
 */
export interface ChunkSpan {
  chunkId: string;
  label: string;
  /** Index into the request's `messages` array. */
  messageIndex: number;
  /** Character offsets within that message's content, end exclusive. */
  start: number;
  end: number;
}

/**
 * What one answer cost and produced: the summary row of the compare view,
 * and one line of the answer scorecard.
 */
export interface TurnSummary {
  mode: AnswerMode;
  model: string;
  question: string;
  answer: string;
  /** Model requests made. */
  requests: number;
  /** search_docs calls made, by the app or the model. */
  searches: number;
  /** The queries searched, in order. */
  queries: string[];
  /** Prompt tokens Ollama counted, summed over requests. */
  promptTokens: number;
  /** Prompt tokens estimated (chars ÷ 4) before sending, summed. */
  estimatedPromptTokens: number;
  /** Reply tokens, summed. */
  responseTokens: number;
  /** The largest single request, as a share of the window, 0–1. */
  peakWindowShare: number;
  /** Chunks placed into requests (a chunk sent twice counts twice). */
  chunksSent: number;
  /** The ids of those chunks, in the order sent. The scorecard checks them for gold spans. */
  sentChunkIds: string[];
  /** Labels cited in the answer that were, and weren't, in a request. */
  citations: { valid: string[]; invalid: string[] };
  /** Ollama reported fewer prompt tokens than the messages hold: something was dropped. */
  droppedMessages: boolean;
  timings: StageTimings;
  /** Set when the turn ended without an answer. */
  error?: string;
}

/** Time spent per stage of one turn, in milliseconds. */
export interface StageTimings {
  /** Ollama's load_duration for the embeddings model; non-zero means a swap. */
  embedLoad?: number;
  embed?: number;
  search?: number;
  rerank?: number;
  /** Ollama's load_duration for the chat model. */
  generateLoad?: number;
  generate?: number;
  total: number;
}

// ---------------------------------------------------------------------------
// The question set and how answers are scored (PLAN §5.3, §8)
// ---------------------------------------------------------------------------

/** What a question tests. Counts per category are fixed by PLAN §5.3. */
export type QuestionCategory =
  | "direct"
  | "paraphrase"
  | "exact-term"
  | "split-context"
  | "table"
  | "multi-hop"
  | "stale"
  | "unanswerable";

/**
 * A piece of corpus text that holds (part of) the answer. Matched against
 * a chunk's own text, from the named document, ignoring case and
 * whitespace but not digits (shared/scoring.ts).
 */
export interface GoldSpan {
  /** Document id: "rental-agreement". */
  doc: string;
  text: string;
}

/** One question from questions/, as its JSON file holds it. */
export interface Question {
  /** Same as the file name without ".json": "direct-1-return-deadline". */
  id: string;
  category: QuestionCategory;
  question: string;
  /**
   * What retrieval must find. Each hop is a list of alternative spans, any
   * one of which counts; a question is a hit when every hop is found.
   * Single-hop questions have one hop; multi-hop questions have two or
   * more; unanswerable questions have none.
   */
  hops: GoldSpan[][];
  /**
   * Facts the answer must contain. Each entry is one fact; an array is a
   * list of acceptable wordings for it ("6 p.m.", "6 pm"…).
   */
  required: Array<string | string[]>;
  /** Facts that make an answer wrong, such as the stale 2025 figure. */
  forbidden: string[];
  /** Why the question is in the set and which trap it tests. */
  notes: string;
}

/**
 * Exactly one per answer (PLAN §8):
 *
 *   correct           every required fact, no forbidden fact
 *   declined          says the documents don't contain the answer
 *   conflict-flagged  stale questions: gives both figures and says the
 *                     documents disagree
 *   invented          anything else
 */
export type AnswerOutcome = "correct" | "declined" | "conflict-flagged" | "invented";

// ---------------------------------------------------------------------------
// What crosses the wire between the server and the browser
// ---------------------------------------------------------------------------

/** POST /api/ask (and /api/compare, which ignores `mode`). */
export interface AskBody {
  question: string;
  mode: AnswerMode;
  model: string;
  strategy: ChunkStrategy;
  settings: SearchSettings;
  think: boolean;
}

/**
 * One Server-Sent Event from /api/ask, /api/compare or /api/index/rebuild.
 *
 *   log       a log row, as it happens
 *   done      one mode finished; `outcome` is scored when the question is
 *             from the question set
 *   finished  the whole request finished (compare: all three modes)
 *   progress  a line of index-build output
 *   error     the request failed before or outside a turn
 */
export type StreamEvent =
  | { type: "log"; event: LogEvent }
  | { type: "done"; summary: TurnSummary; outcome?: AnswerOutcome; questionId?: string }
  | { type: "finished" }
  | { type: "progress"; line: string }
  | { type: "error"; message: string };

/** One index, as GET /api/meta reports it. */
export interface IndexStatus {
  strategy: ChunkStrategy;
  preset: string;
  chunks: number;
  /** Built from a different corpus than the one on disk. */
  stale: boolean;
}

/** GET /api/meta: everything the page needs to draw itself. */
export interface MetaResponse {
  models: Array<{ name: string; supportsThinking: boolean }>;
  defaultModel: string;
  numCtx: number;
  defaults: { strategy: ChunkStrategy; preset: ChunkPreset; search: SearchSettings };
  presets: Record<ChunkPreset, { chunkTokens: number; overlapTokens: number }>;
  indexes: IndexStatus[];
  documents: Array<{ id: string; path: string; title: string }>;
  questions: Array<{ id: string; category: QuestionCategory; question: string }>;
  /** Set when Ollama or the tool server couldn't be reached; the page shows it. */
  problem?: string;
}

/** GET /api/map: the embedding map's points for one index. */
export interface MapResponse {
  strategy: ChunkStrategy;
  preset: string;
  variance: [number, number];
  chunks: Array<{ chunkId: string; docId: string; x: number; y: number }>;
}

// ---------------------------------------------------------------------------
// The activity log
// ---------------------------------------------------------------------------

/**
 * What kind of event a log row is. Decides its color and tag.
 *
 * `retrieval` is this lab's addition (PLAN §2): a search, a chunk dropped
 * by the budget, a chunk placed into a prompt. Those are the events a
 * reader is watching for, and as `info` rows they'd be lost among the rest.
 */
export type LogLevel = "info" | "retrieval" | "model" | "tool" | "warn" | "error";

/** Which way the event traveled. Absent means "none". */
export type LogDirection = "out" | "in" | "call" | "back" | "none";

/**
 * Whose decision it was. For a search row this carries the lab's central
 * contrast: `app` in pre-retrieved mode, `model` in search-tool mode.
 */
export type LogActor = "user" | "app" | "model" | "tool";

/** One row in the activity log. */
export interface LogEvent {
  /** Which kind of event this is. Decides the color and the tag text. */
  level: LogLevel;

  /** Which way it traveled. Absent means "none". */
  direction?: LogDirection;

  /** Whose decision it was. */
  actor?: LogActor;

  /** Which answer mode produced it; tags the columns of the compare view. */
  mode?: AnswerMode;

  /**
   * Which model request this row belongs to, within the turn. Every row
   * produced while handling request N carries N, so the panel can group a
   * turn's rows under the exchange that caused them.
   */
  iteration?: number;

  /**
   * Why this happened, as a fragment that completes "because…":
   * "the model asked for it", "it didn't fit the chunk budget".
   */
  because?: string;

  /**
   * A short, human-readable summary — the whole of what the row shows by
   * default. A complete thought: "Search: \"late return fee\" · hybrid ·
   * 23 candidates", not "search_done".
   */
  label: string;

  /**
   * The full data behind the event: a request body, a candidate list, a
   * built FTS5 query. Rendered collapsed. `unknown`, not `any`, so the
   * rendering code has to handle it defensively.
   */
  detail?: unknown;

  /**
   * When it happened, as milliseconds since the epoch. A number because
   * JSON has no date type; a Date would arrive as a string.
   */
  at: number;
}
