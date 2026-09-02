import { createParticles, createRamp } from '../src/index.ts'

/**
 * @rune/particles bench: the steady-state frame (advance + billboards) at
 * a full load, plus the emission path and the allocation identity probe.
 *
 * Scenarios:
 *   1. STEADY STATE — the facade frame at a sustained ~10k live particles
 *      (rate-limited, deaths balancing births): advance(dt) + the soup
 *      bake. This is what a demo pays per frame.
 *   2. FULL LOAD — 100k live particles (burst-born, long-lived): the pure
 *      integrate+bake cost at the ceiling.
 *   3. EMISSION — 100k spawns through the sphere spawner (the hash RNG,
 *      the shape math, the validation) as a one-shot burst.
 *   4. ALLOCATION IDENTITY — the soup buffer and the view object are the
 *      SAME references across 500 frames (rss before/after as a smoke
 *      number; Bun's heapUsed is a stub, rss after Bun.gc is the metric
 *      the materials bench uses).
 *
 * Run: bun packages/particles/bench/particles.bench.ts
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

function steadyState(): { ms: number; count: number } {
  // rate ≈ steady count / mean life: 6000/s × ~1.7 s ≈ 10k live
  const ps = createParticles({ capacity: 16_384, rate: 6000, spawner: SPAWNER, ramp: RAMP, forces: { gravity: [0, -4, 0], drag: 0.6 }, spin: 1.5 })
  const FRAMES = 300
  let checksum = 0
  for (let k = 0; k < 40; k++) ps.advance(1 / 60) // settle into the steady state
  const startedAt = performance.now()
  for (let k = 0; k < FRAMES; k++) {
    ps.advance(1 / 60)
    const view = ps.billboards(BASIS)
    checksum += view.vertexCount
  }
  return { ms: performance.now() - startedAt, count: checksum / FRAMES / 6 }
}

function fullLoad(): { ms: number; count: number } {
  const ps = createParticles({ capacity: 100_000, spawner: SPAWNER, ramp: RAMP, spin: 1 })
  // long-lived: nothing dies during the measurement
  ps.burst(100_000, { ...SPAWNER, life: [30, 30] })
  const FRAMES = 60
  let checksum = 0
  const startedAt = performance.now()
  for (let k = 0; k < FRAMES; k++) {
    ps.advance(1 / 60)
    const view = ps.billboards(BASIS)
    checksum += view.vertexCount
  }
  return { ms: performance.now() - startedAt, count: checksum / FRAMES / 6 }
}

function emission(): number {
  const ps = createParticles({ capacity: 100_000, spawner: SPAWNER })
  const startedAt = performance.now()
  const spawned = ps.burst(100_000)
  const ms = performance.now() - startedAt
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

// warm-up, then the runs
steadyState()
const steady: ReturnType<typeof steadyState>[] = []
for (let i = 0; i < 5; i++) steady.push(steadyState())
steady.sort((a, b) => a.ms - b.ms)
const steadyMedian = steady[Math.floor(steady.length / 2)]

fullLoad()
const load: ReturnType<typeof fullLoad>[] = []
for (let i = 0; i < 5; i++) load.push(fullLoad())
load.sort((a, b) => a.ms - b.ms)
const loadMedian = load[Math.floor(load.length / 2)]

emission()
const emitRuns: number[] = []
for (let i = 0; i < 5; i++) emitRuns.push(emission())
emitRuns.sort((a, b) => a - b)
const emitMedian = emitRuns[Math.floor(emitRuns.length / 2)]

const identity = allocationIdentity()

console.log('── @rune/particles: the frame cost ──────────────────────────────')
console.log(`steady state (~${Math.round(steadyMedian.count)} live) : ${steadyMedian.ms.toFixed(2)} ms / 300 frames → ${(steadyMedian.ms / 300).toFixed(3)} ms/frame`)
console.log(`full load (100k live)          : ${loadMedian.ms.toFixed(2)} ms / 60 frames → ${(loadMedian.ms / 60).toFixed(2)} ms/frame (${(loadMedian.ms / 60 / 100_000 * 1e6).toFixed(0)} ns/particle)`)
console.log(`emission (100k burst)          : ${emitMedian.toFixed(2)} ms (${(emitMedian / 100_000 * 1e6).toFixed(0)} ns/spawn)`)
console.log(`allocation identity (500 frames): ${identity.stable ? 'STABLE (the soup + the view are the same references)' : 'BROKEN'}`)
console.log(`rss before/after (Bun.gc)      : ${(identity.rssBefore / 1024).toFixed(0)} / ${(identity.rssAfter / 1024).toFixed(0)} KiB`)
