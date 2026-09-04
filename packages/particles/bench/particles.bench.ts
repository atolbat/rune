import { createParticles, createRamp } from '../src/index.ts'

/**
 * @rune/particles bench — THE BASELINE HARNESS (the etalon set for the
 * optimization program; see docs/particles-optimization.md).
 *
 * Scenarios (each isolates ONE stage of the frame — the split is the
 * point: a GPU-compute port replaces exactly ONE of them at a time):
 *   1. STEADY STATE — the full facade frame (advance + the soup bake) at
 *      ~10k live: what a demo pays per frame.
 *   2. FULL LOAD — 100k live (burst-born, long-lived): the ceiling.
 *   3. ADVANCE-ONLY — the integration walk alone (gravity + drag + the
 *      ramp bookkeeping): the GPGPU-compute candidate.
 *   4. BAKE-ONLY — the soup expansion alone (billboard math + ramp
 *      sampling + the write): the instanced-draw candidate.
 *   5. FORCES-HEAVY — the full force stack (noise + seek + collision
 *      planes + limitSpeed): the worst-case CPU per-particle cost.
 *   6. EMISSION — 100k spawns through the sphere spawner (hash RNG +
 *      shape math) as a one-shot burst: the spawn-side cost.
 *   7. ALLOCATION IDENTITY — the soup buffer and view are the SAME
 *      references across 500 frames (the zero-allocation contract).
 *
 * Run: bun packages/particles/bench/particles.bench.ts [--json]
 * The JSON form (one line on stdout) is what baseline snapshots consume.
 */

const BASIS = { right: [1, 0, 0], up: [0, 1, 0] }
const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 0.15, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [1.2, 2.2] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}

// the forces-heavy stack: the GPGPU-compute candidate workload
const HEAVY_FORCES = {
  gravity: [0, -4, 0],
  drag: 0.6,
  noise: { strength: 1.4, scale: 0.3, speed: 0.25 },
  seek: { strength: 4, damping: 1.8, targets: [[0, 1.5, 0], [2, 0.5, -1]] },
  collide: { planes: [{ normal: [0, 1, 0], point: [0, -0.5, 0], restitution: 0.45, friction: 0.04 }] },
  limitSpeed: { limit: 9, dampen: 0.5 },
}

const R = 5 // repeats; the median is reported
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function timed(times: number, body: () => void): number {
  const t0 = performance.now()
  for (let k = 0; k < times; k++) body()
  return performance.now() - t0
}

function fullFrame(rate: number, forces: object): { ms: number; count: number } {
  const ps = createParticles({ capacity: 16_384, rate, spawner: SPAWNER, ramp: RAMP, forces, spin: 1.5 })
  for (let k = 0; k < 40; k++) ps.advance(1 / 60)
  const FRAMES = 300
  let checksum = 0
  const ms = timed(FRAMES, () => {
    ps.advance(1 / 60)
    checksum += ps.billboards(BASIS).vertexCount
  })
  return { ms, count: checksum / FRAMES / 6 }
}

function atCapacity(forces: object): { ms: number; count: number } {
  const ps = createParticles({ capacity: 100_000, spawner: SPAWNER, ramp: RAMP, spin: 1 })
  ps.burst(100_000, { ...SPAWNER, life: [30, 30] })
  const FRAMES = 60
  let checksum = 0
  const ms = timed(FRAMES, () => {
    ps.advance(1 / 60)
    checksum += ps.billboards(BASIS).vertexCount
  })
  return { ms, count: checksum / FRAMES / 6 }
}

function splitStages(): { advanceMs: number; bakeMs: number; count: number; soupBytes: number } {
  // 100k long-lived: alternate the two stages to isolate their costs
  const ps = createParticles({ capacity: 100_000, spawner: SPAWNER, ramp: RAMP, spin: 1 })
  ps.burst(100_000, { ...SPAWNER, life: [30, 30] })
  const FRAMES = 60
  ps.advance(1 / 60)
  let checksum = 0
  const advanceMs = timed(FRAMES, () => { ps.advance(1 / 60) })
  const bakeMs = timed(FRAMES, () => { checksum += ps.billboards(BASIS).vertexCount })
  const view = ps.billboards(BASIS)
  return { advanceMs, bakeMs, count: checksum / FRAMES / 6, soupBytes: view.vertexCount * view.stride * 4 }
}

function forcesHeavy(): number {
  const ps = createParticles({
    capacity: 100_000, spawner: SPAWNER, ramp: RAMP, forces: HEAVY_FORCES, spin: 1,
  })
  ps.burst(100_000, { ...SPAWNER, life: [30, 30] })
  return timed(60, () => { ps.advance(1 / 60) })
}

function emission(): number {
  const ps = createParticles({ capacity: 100_000, spawner: SPAWNER })
  const t0 = performance.now()
  const spawned = ps.burst(100_000)
  const ms = performance.now() - t0
  if (spawned !== 100_000) throw new Error('bench: burst clipped')
  return ms
}

function allocationIdentity(): { stable: boolean; rssBefore: number; rssAfter: number } {
  const ps = createParticles({ capacity: 16_384, rate: 6000, spawner: SPAWNER, ramp: RAMP })
  for (let k = 0; k < 20; k++) ps.advance(1 / 60)
  const view = ps.billboards(BASIS)
  const vertices = view.vertices
  Bun.gc(true)
  const rssBefore = process.memoryUsage.rss()
  for (let k = 0; k < 500; k++) {
    ps.advance(1 / 60)
    const v = ps.billboards(BASIS)
    if (v !== view || v.vertices !== vertices) return { stable: false, rssBefore, rssAfter: 0 }
  }
  Bun.gc(true)
  const rssAfter = process.memoryUsage.rss()
  return { stable: true, rssBefore, rssAfter }
}

// ── warm-up, then the medians ─────────────────────────────────────────────
fullFrame(6000, { gravity: [0, -4, 0], drag: 0.6 })
const steady = med(Array.from({ length: R }, () => fullFrame(6000, { gravity: [0, -4, 0], drag: 0.6 }).ms))
atCapacity({})
const load = med(Array.from({ length: R }, () => atCapacity({}).ms))
const split = splitStages()
forcesHeavy()
const heavy = med(Array.from({ length: R }, forcesHeavy))
emission()
const emit = med(Array.from({ length: R }, emission))
const identity = allocationIdentity()

const steadyCount = fullFrame(6000, { gravity: [0, -4, 0], drag: 0.6 }).count
const loadCount = split.count

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    steady: { count: Math.round(steadyCount), msPerFrame: +(steady / 300).toFixed(3) },
    load: { count: loadCount, msPerFrame: +(load / 60).toFixed(2), nsPerParticle: +(load / 60 / 100_000 * 1e6).toFixed(0) },
    advanceOnly: { msPerFrame: +(split.advanceMs / 60).toFixed(2) },
    bakeOnly: { msPerFrame: +(split.bakeMs / 60).toFixed(2), soupBytesPerFrame: split.soupBytes },
    forcesHeavy: { msPerFrame: +(heavy / 60).toFixed(2) },
    emission: { msPer100k: +emit.toFixed(2), nsPerSpawn: +(emit / 100_000 * 1e6).toFixed(0) },
    allocationStable: identity.stable,
  }))
} else {
  console.log('── @rune/particles: the baseline etalons ─────────────────────────')
  console.log(`steady state (~${Math.round(steadyCount)} live) : ${(steady / 300).toFixed(3)} ms/frame (advance + bake)`)
  console.log(`full load (100k live)          : ${(load / 60).toFixed(2)} ms/frame (${(load / 60 / 100_000 * 1e6).toFixed(0)} ns/particle)`)
  console.log(`  ├─ advance only              : ${(split.advanceMs / 60).toFixed(2)} ms/frame (the GPGPU candidate)`)
  console.log(`  └─ bake only                 : ${(split.bakeMs / 60).toFixed(2)} ms/frame, ${(split.soupBytes / 1024 / 1024).toFixed(1)} MiB soup/frame (the instanced-draw candidate)`)
  console.log(`forces-heavy (full stack)      : ${(heavy / 60).toFixed(2)} ms/frame (noise + seek + collide + limit)`)
  console.log(`emission (100k burst)          : ${emit.toFixed(2)} ms (${(emit / 100_000 * 1e6).toFixed(0)} ns/spawn)`)
  console.log(`allocation identity (500 frames): ${identity.stable ? 'STABLE (the soup + the view are the same references)' : 'BROKEN'}`)
  console.log(`rss before/after (Bun.gc)      : ${(identity.rssBefore / 1024).toFixed(0)} / ${(identity.rssAfter / 1024).toFixed(0)} KiB`)
}
