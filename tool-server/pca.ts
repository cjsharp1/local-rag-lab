/**
 * pca.ts — flattens 768-dimensional embeddings onto a 2D map.
 *
 * Nobody can picture 768 dimensions, so the lab draws the chunks on a
 * flat map (PLAN §4.5) using principal component analysis: find the two
 * directions in which the chunk vectors spread out the most, and plot
 * each chunk by how far it lies along each one. At question time the
 * query vector is projected onto the same two directions, so it lands on
 * the same map as the chunks it retrieved.
 *
 * Why PCA, written out here, rather than a library (decision #5):
 *
 *   - It's deterministic. The same index always draws the same map, which
 *     matters when a reader compares two runs.
 *   - A new point projects exactly: one subtraction and two dot products.
 *     Methods like UMAP place new points only approximately.
 *   - It's short enough to read. Power iteration is the whole algorithm:
 *     multiply a vector by the data's covariance over and over, and it
 *     turns toward the direction of greatest spread.
 *
 * ---------------------------------------------------------------------------
 * The honest caveat
 * ---------------------------------------------------------------------------
 *
 * Two directions keep only a small share of the spread of 768-dimensional
 * vectors. fitPca() reports that share for each axis, and the UI prints
 * it under the map. Two chunks that look close on the map may be far
 * apart in the real space; retrieval uses the real space, never the map.
 */

/** A fitted 2D projection. */
export interface Projection {
  /** The mean vector, subtracted before projecting. */
  mean: Float32Array;
  /** The two unit-length directions of greatest spread. */
  axes: [Float32Array, Float32Array];
  /** Share of the total variance along each axis, 0–1. */
  variance: [number, number];
}

/** Iterations allowed for each axis. Converges far sooner on real data. */
const MAX_ITERATIONS = 1000;

/** Stop when an iteration turns the direction by less than this. */
const TOLERANCE = 1e-10;

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * A fixed, spread-out starting vector. Power iteration needs a start that
 * isn't perpendicular to the answer; a fixed one keeps the result the same
 * on every run, where a random one would only usually be the same.
 */
function startVector(dims: number): Float64Array {
  const v = new Float64Array(dims);
  for (let i = 0; i < dims; i++) v[i] = ((i * 7919) % 101) / 101 - 0.5;
  // Unit length, like every later iterate. The convergence test compares
  // directions by dot product, which only works between unit vectors: an
  // unnormalized start made the first comparison look converged at once.
  const length = Math.sqrt(dot(v, v));
  for (let i = 0; i < dims; i++) v[i]! /= length;
  return v;
}

/** Fits the two-axis projection to a set of vectors of equal length. */
export function fitPca(vectors: readonly Float32Array[]): Projection {
  const n = vectors.length;
  const dims = vectors[0]?.length ?? 0;
  if (n < 3 || dims < 2) throw new RangeError(`PCA needs at least 3 vectors of 2+ dimensions; got ${n} of ${dims}`);

  // Center the data: PCA measures spread around the mean.
  const mean = new Float64Array(dims);
  for (const v of vectors) for (let i = 0; i < dims; i++) mean[i]! += v[i]! / n;
  const centered = vectors.map((v) => Float64Array.from(v, (x, i) => x - mean[i]!));
  const totalVariance = centered.reduce((sum, row) => sum + dot(row, row), 0) / n;

  const axes: Float64Array[] = [];
  const variance: number[] = [];

  for (let k = 0; k < 2; k++) {
    let v = startVector(dims);
    let eigenvalue = 0;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // w = Xᵀ X v, the covariance times v, without building the 768×768 matrix.
      const w = new Float64Array(dims);
      for (const row of centered) {
        const along = dot(row, v);
        for (let i = 0; i < dims; i++) w[i]! += along * row[i]!;
      }
      // Remove what the earlier axes already explain, so this one finds the
      // next direction instead of the first one again.
      for (const axis of axes) {
        const overlap = dot(w, axis);
        for (let i = 0; i < dims; i++) w[i]! -= overlap * axis[i]!;
      }

      eigenvalue = Math.sqrt(dot(w, w));
      if (eigenvalue === 0) break; // the data has no spread left
      for (let i = 0; i < dims; i++) w[i]! /= eigenvalue;

      const turned = 1 - Math.abs(dot(w, v));
      v = w;
      if (turned < TOLERANCE) break;
    }

    // An axis and its negative are equally valid. Point it so its largest
    // component is positive, so the map never flips between builds.
    let largest = 0;
    for (let i = 1; i < dims; i++) if (Math.abs(v[i]!) > Math.abs(v[largest]!)) largest = i;
    if (v[largest]! < 0) for (let i = 0; i < dims; i++) v[i] = -v[i]!;

    axes.push(v);
    variance.push(totalVariance > 0 ? eigenvalue / n / totalVariance : 0);
  }

  return {
    mean: Float32Array.from(mean),
    axes: [Float32Array.from(axes[0]!), Float32Array.from(axes[1]!)],
    variance: [variance[0]!, variance[1]!],
  };
}

/** Where a vector lands on the map. */
export function project(projection: Projection, vector: Float32Array): { x: number; y: number } {
  const centered = Float64Array.from(vector, (value, i) => value - projection.mean[i]!);
  return { x: dot(centered, projection.axes[0]), y: dot(centered, projection.axes[1]) };
}
