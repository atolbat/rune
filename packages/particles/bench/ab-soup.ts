/**
 * ab-soup.ts — Task 180's A/B bench: THE INDEX TIER vs the pre-180
 * six-vertex expansion.
 *
 * THE PARITY GATE (before any timing): the new baker writes FOUR unique
 * corners per particle; the shared static index pattern [0,1,2,0,2,3]
 * reconstructs the legacy six-vertex stream EXACTLY — for every mode, ramp,
 * atlas and cull window, the expanded stream must equal the legacy baker's
 * bytes byte-for-byte (the drawn image cannot change; the gate runs the
 * full matrix first and throws on the first mismatch).
 *
 * THE TIMING: interleaved A/B rounds (legacy ↔ indexed) over the same
 * system state — the write count is the only variable (54 vs 36 floats per
 * particle; the corner math, the ramp walk, the cull gate are identical).
 * Run: bun bench/ab-soup.ts
 */
import { createParticles, createRamp, makeQuadIndices, fillBillboards } from '../src/index.ts'
import { fillBillboards as fillLegacy } from './billboardsLegacy.ts'

const RAMP = createRamp([
  { t: 0, size: 0.2, r: 1, g: 1, b: 1, a: 0 },
  { t: 0.15, size: 1, r: 1, g: 0.9, b: 0.6, a: 0.9 },
  { t: 0.7, size: 0.75, r: 1, g: 0.4, b: 0.15, a: 0.55 },
  { t: 1, size: 0.35, r: 0.5, g: 0.1, b: 0.05, a: 0 },
])

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [8, 12] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}

const BASIS = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0.3, -1] }

function systemOf(n: number, seed: number) {
  const ps = createParticles({ capacity: n, spawner: SPAWNER, ramp: RAMP, spin: 1, seed })
  ps.burst(n)
  ps.advance(1 / 60)
  return ps
}

/** THE PARITY GATE: expand(new soup) === legacy bytes, for a mode matrix. */
function parityGate(): void {
  const N = 4000
  const modes = ['camera', 'vertical', 'horizontal', 'stretched', 'oriented'] as const
  const cases: Array<{ name: string; opts: Record<string, unknown> }> = []
  for (const mode of modes) {
    cases.push({ name: `${mode}`, opts: { mode } })
    cases.push({ name: `${mode} + tiles`, opts: { mode, tiles: [4, 2], frameJitter: 3 } })
  }
  cases.push({ name: 'camera + cull (a third survives)', opts: { mode: 'camera', frustum: [1, 0, 0, 12, -1, 0, 0, 12, 0, 1, 0, 12, 0, -1, 0, 12, 0, 0, 1, 12, 0, 0, -1, 12], cullRadiusK: 0.5 } })
  cases.push({ name: 'stretched + speedFactor', opts: { mode: 'stretched', speedFactor: 0.4, lengthFactor: 0 } })

  let totalQuads = 0
  for (const c of cases) {
    const ps = systemOf(N, 31)
    const legacy = new Float32Array(N * 6 * 9)
    const fresh = new Float32Array(N * 6 * 9) // oversized on purpose
    const legacyVerts = fillLegacy(ps, BASIS, legacy, { ramp: RAMP, ...c.opts } as never)
    const freshVerts = fillBillboards(ps, BASIS, fresh, { ramp: RAMP, ...c.opts } as never)
    // the count contract: 4 corners per live quad, 6 legacy verts per quad
    const quads = freshVerts / 4
    if (legacyVerts !== quads * 6) {
      throw new Error(`parity: ${c.name} — count ${freshVerts} vs legacy ${legacyVerts}`)
    }
    // THE EXPANSION: the shared pattern over the four corners
    const idx = makeQuadIndices(quads)
    for (let j = 0; j < quads * 6; j++) {
      const src = idx[j] * 9
      const dst = j * 9
      for (let k = 0; k < 9; k++) {
        if (fresh[src + k] !== legacy[dst + k]) {
          throw new Error(`parity: ${c.name} — byte ${dst + k}: expanded ${fresh[src + k]} vs legacy ${legacy[dst + k]}`)
        }
      }
    }
    totalQuads += quads
  }
  console.log(`parity gate: ${cases.length} cases, ${totalQuads} quads — the expanded stream IS the legacy six-vert stream (byte-for-byte)`)
}

/** Interleaved A/B timing over the same state — MEDIAN per-round pair
 *  ratios (the container's scheduling noise is heavy-tailed; the median of
 *  per-round legacy→fresh pairs is the robust estimator). */
function timing(): void {
  for (const n of [25_000, 100_000, 200_000]) {
    const ps = systemOf(n, 97)
    const legacy = new Float32Array(n * 6 * 9)
    const fresh = new Float32Array(n * 4 * 9)
    const ROUNDS = 40
    // warm-up both branches (JIT + page faults)
    for (let k = 0; k < 5; k++) { fillLegacy(ps, BASIS, legacy, { ramp: RAMP }); fillBillboards(ps, BASIS, fresh, { ramp: RAMP }) }
    const legacyTimes: number[] = []
    const freshTimes: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      // interleaved with alternating order — the pair (A,B) then (B,A)
      // cancels any directional drift (cache state, thermal, GC cadence)
      if (r % 2 === 0) {
        const t0 = performance.now()
        fillLegacy(ps, BASIS, legacy, { ramp: RAMP })
        const t1 = performance.now()
        fillBillboards(ps, BASIS, fresh, { ramp: RAMP })
        const t2 = performance.now()
        legacyTimes.push(t1 - t0)
        freshTimes.push(t2 - t1)
      } else {
        const t0 = performance.now()
        fillBillboards(ps, BASIS, fresh, { ramp: RAMP })
        const t1 = performance.now()
        fillLegacy(ps, BASIS, legacy, { ramp: RAMP })
        const t2 = performance.now()
        freshTimes.push(t1 - t0)
        legacyTimes.push(t2 - t1)
      }
    }
    const med = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b)
      return s[Math.floor(s.length / 2)]
    }
    const legacyPer = med(legacyTimes)
    const freshPer = med(freshTimes)
    const legacyBytes = n * 6 * 9 * 4
    const freshBytes = n * 4 * 9 * 4
    console.log(
      `  ${String(n).padStart(7)}: legacy 6-vert ${legacyPer.toFixed(2)} ms (${(legacyBytes / 1024 / 1024).toFixed(1)} MiB/frame)`
      + ` → indexed 4-vert ${freshPer.toFixed(2)} ms (${(freshBytes / 1024 / 1024).toFixed(1)} MiB/frame)`
      + ` — bake ${((1 - freshPer / legacyPer) * 100).toFixed(0)}% faster (median of ${ROUNDS} interleaved pairs), bytes ${((1 - freshBytes / legacyBytes) * 100).toFixed(0)}% fewer`,
    )
  }
}

parityGate()
timing()
