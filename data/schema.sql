-- ---------------------------------------------------------------------------
-- schema.sql — the layout of one index file, data/index-<strategy>.db.
--
-- `npm run index` builds one of these per chunking strategy. Each file is
-- complete on its own: the settings it was built with, the documents, the
-- chunks with their vectors and map positions, and a keyword index. The
-- tool server loads one at startup and never writes to it.
--
-- This file is the readable copy. tool-server/db.ts runs it to create a
-- new index, so what you read here is exactly what gets built.
--
-- What it teaches: a "vector database" for a few hundred chunks can be one
-- column of bytes in an ordinary table. The similarity search is a loop
-- in tool-server/search/vector.ts, not a feature of the storage.
-- ---------------------------------------------------------------------------

-- How this index was built. Exactly one row.
--
-- Chunk sizes, the embeddings model and the corpus all decide what's in
-- the chunks table, so they're stored with it. The app compares them with
-- the current settings and corpus, and warns when the index is stale
-- rather than quietly searching chunks that no longer match the documents.
CREATE TABLE index_info (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  strategy       TEXT    NOT NULL,  -- fixed | heading | heading+context
  preset         TEXT    NOT NULL,  -- small | default | large
  chunk_tokens   INTEGER NOT NULL,  -- target size, estimated tokens (chars ÷ 4)
  overlap_tokens INTEGER NOT NULL,
  embed_model    TEXT    NOT NULL,  -- vectors from different models can't be compared
  dimensions     INTEGER NOT NULL,  -- vector length; 768 for nomic-embed-text
  corpus_hash    TEXT    NOT NULL,  -- SHA-256 of corpus/ at build time
  built_at       INTEGER NOT NULL,  -- milliseconds since the epoch

  -- The 2D map (tool-server/pca.ts): the mean and two axes every vector is
  -- projected with, stored as raw 32-bit floats, and the share of the total
  -- variance each axis keeps. The query is projected with these same values.
  map_mean       BLOB    NOT NULL,
  map_axis_x     BLOB    NOT NULL,
  map_axis_y     BLOB    NOT NULL,
  map_variance_x REAL    NOT NULL,
  map_variance_y REAL    NOT NULL
);

-- The documents, as they were when the index was built. get_document reads
-- from here rather than from corpus/, so a document and its chunks can
-- never disagree.
CREATE TABLE documents (
  id    TEXT PRIMARY KEY,  -- file name without .md: "rental-agreement"
  path  TEXT NOT NULL,     -- "policies/rental-agreement.md"
  title TEXT NOT NULL,     -- the document's H1
  text  TEXT NOT NULL      -- normalized: LF line endings, no byte-order mark
);

-- One row per chunk.
CREATE TABLE chunks (
  n                INTEGER PRIMARY KEY,  -- order in the corpus; also the keyword index's rowid
  id               TEXT    NOT NULL UNIQUE,  -- "rental-agreement#late-returns-and-the-late-fee-4"
  doc_id           TEXT    NOT NULL REFERENCES documents (id),
  heading_path     TEXT    NOT NULL,  -- JSON array, outermost heading first
  text             TEXT    NOT NULL,  -- exactly documents.text[start_offset, end_offset)
  embed_text       TEXT    NOT NULL,  -- what was embedded and keyword-indexed
  start_offset     INTEGER NOT NULL,
  end_offset       INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,  -- chars ÷ 4, a heuristic

  -- The embedding: `dimensions` 32-bit floats, little-endian, 3 KB each.
  -- The embedded text started with nomic's "search_document: " prefix.
  vector           BLOB    NOT NULL,

  map_x            REAL    NOT NULL,
  map_y            REAL    NOT NULL
);

-- Keyword search: SQLite's FTS5 full-text index, ranked by BM25.
--
-- It indexes embed_text, the same text the vector was made from, so for
-- heading+context both kinds of search see the heading path. It's an
-- "external content" table: it stores only the index, reading the text
-- itself from chunks (by rowid = chunks.n) instead of keeping a copy.
--
-- The default unicode61 tokenizer splits "EP-14" into "ep" and "14".
-- tool-server/search/keyword.ts quotes each query term, so "EP-14" is
-- searched as that two-token phrase, in that order.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  embed_text,
  content = 'chunks',
  content_rowid = 'n'
);
