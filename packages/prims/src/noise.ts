/**
 * Deterministic 2D value noise for @rune/prims terrains.
 *
 * WHY NOT Math.random(): geometry must be reproducible — the same seed →
 * byte-identical vertices (tests, golden screenshots, revisiting the demo
 * without "a different landscape every time").
 *
 * Scheme: integer lattice hash (Wang-like mix) → smoothed bilinear
 * interpolation with a quintic fade (C²-smooth derivatives —
 * central-difference normals without steps).
 */

/** Integer hash of a pair + seed → [0, 1). Deterministic (no Math.random). */
export function hash2i(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647
  h = (h ^ (h >>> 13)) | 0
  h = Math.imul(h, 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** Quintic fade (as in Perlin): 6t⁵ − 15t⁴ + 10t³. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 2D value noise on a 1×1 lattice: hash values at the cell corners, inside —
 * quintic-bilinear interpolation. Output ∈ [0, 1); continuous; at lattice
 * nodes equals hash2i.
 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const tx = fade(x - xi)
  const ty = fade(y - yi)
  const v00 = hash2i(xi, yi, seed)
  const v10 = hash2i(xi + 1, yi, seed)
  const v01 = hash2i(xi, yi + 1, seed)
  const v11 = hash2i(xi + 1, yi + 1, seed)
  const a = v00 + (v10 - v00) * tx
  const b = v01 + (v11 - v01) * tx
  return a + (b - a) * ty
}

/**
 * Fractal Brownian motion (fBm): a sum of value-noise octaves with frequency
 * doubling and amplitude decay (gain). Output normalized to [0, 1] — hills.
 */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0
  let amplitude = 1
  let norm = 0
  let fx = x
  let fy = y
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2D(fx, fy, seed + o * 101) * amplitude
    norm += amplitude
    amplitude *= gain
    fx *= lacunarity
    fy *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Ridged multifractal: 1 − |2·noise − 1| — sharp ridges instead of hills;
 * raising to the ridgePower power sharpens the peaks.
 * Output ∈ [0, 1], normalized by the sum of amplitudes.
 */
export function ridged2D(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  ridgePower = 1.3,
): number {
  let sum = 0
  let amplitude = 1
  let norm = 0
  let fx = x
  let fy = y
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(2 * valueNoise2D(fx, fy, seed + o * 131) - 1)
    sum += Math.pow(n, ridgePower) * amplitude
    norm += amplitude
    amplitude *= 0.5
    fx *= 2
    fy *= 2
  }
  return norm > 0 ? sum / norm : 0
}
