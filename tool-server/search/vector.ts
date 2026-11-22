/**
 * vector.ts — vector search: score every chunk by cosine similarity to the query.
 *
 * This is the whole of "semantic search". The query and every chunk have
 * been turned into 768 numbers by the same embeddings model; texts with
 * similar meanings end up pointing in similar directions. Cosine
 * similarity measures the angle between two vectors: 1 means the same
 * direction, 0 means unrelated, and in practice (step 0) even unrelated
 * passages score 0.4 to 0.55 with nomic-embed-text, which is why the
 * floor isn't set at some round number like 0.3.
 *
 * There's no index structure and no approximation: every query is scored
 * against every chunk, in a plain loop. For 164 chunks that takes a
 * fraction of a millisecond. A vector database earns its place when this
 * loop gets too slow (hundreds of thousands of chunks, or many queries a
 * second), and what it trades for speed is that it may miss a few of the
 * true nearest chunks. Here, nothing is missed and nothing is hidden.
 *
 * nomic-embed-text returns vectors of length 1, so cosine similarity
 * equals the plain dot product. This computes the full formula anyway,
 * because it's the formula being taught and because another embeddings
 * model might not normalize.
 */

/** One chunk's place in a ranking. `index` is the chunk's position in the index. */
export interface Ranked {
  index: number;
  score: number;
  /** 1-based. */
  rank: number;
}

/** cos θ = a·b / (|a| |b|). Returns 0 for a zero vector rather than NaN. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new RangeError(`Vectors differ in length: ${a.length} and ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Every chunk, scored against the query and sorted best first. Ties keep
 * corpus order, so the same query always gives the same ranking.
 */
export function rankByVector(query: Float32Array, vectors: readonly Float32Array[]): Ranked[] {
  return vectors
    .map((vector, index) => ({ index, score: cosineSimilarity(query, vector) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry, i) => ({ ...entry, rank: i + 1 }));
}
