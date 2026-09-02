import { createTransport } from '../src/index.ts'

/**
 * Task 114 bench: the T3 (postMessage) feed round-trip under a particle load.
 *
 * Scenario: 10 000 records/frame × 120 frames, 2 field writes per record
 * (setVec3 position + setFloat radius) — the m5Worker shape. The cycle:
 * writer push → field writes → host.flush() → client.apply() → recycle.
 *
 * The T3 feed is append-only with a logical window bounded by capacity (the
 * stream is sized at creation), so the bench feed covers the whole run; the
 * ping-pong return goes through view.recycle() — the next flush pours the
 * buffers back into the writer pool (the same-state shortcut of the
 * cross-world worker protocol).
 *
 * What it pins: the writer path (previously ~2 allocations PER FIELD WRITE —
 * a boxed [x,y,z,w] array + a fresh Float32Array view + a feeds.get Map
 * round-trip; now zero) and the apply path (previously D×N name re-hashes +
 * a per-element chunk copy; now one Map lookup per delta + one memcpy).
 *
 * Run: bun packages/core/bench/theoryN.bench.ts
 */

const RECORDS = 10_000
const FRAMES = 120
const LAYOUT = { position: 'float32x3', radius: 'float32' } as const

function particleRoundTrip(): number {
  const { host, client } = createTransport({ mode: 'msg', names: [] })
  const feed = host.createFeed({ layout: LAYOUT, capacity: RECORDS * FRAMES })
  const view = client.attachFeed(1, LAYOUT, RECORDS * FRAMES)
  let checksum = 0
  const startedAt = performance.now()
  for (let frame = 0; frame < FRAMES; frame++) {
    const batch = feed.push(RECORDS)
    const phase = frame * 0.05
    for (let i = 0; i < RECORDS; i++) {
      batch.setVec3('position', i, i * 1.5 + phase, i * 0.5, -i)
      batch.setFloat('radius', i, 0.25 + i * 0.00001)
    }
    feed.publish()
    const message = host.flush()
    if (message === null) throw new Error('bench: no message shipped')
    client.apply(message)
    checksum += view.count()
    // Ping-pong: the reader releases the buffers — the next flush pools them.
    view.recycle()
  }
  const ms = performance.now() - startedAt
  if (checksum !== FRAMES * (FRAMES + 1) * RECORDS / 2) throw new Error('bench: count drift')
  if (view.count() !== FRAMES * RECORDS) throw new Error('bench: mirror count')
  return ms
}

// JIT warm-up, then 5 runs (the repo's best/median convention for noise).
particleRoundTrip()
const runs: number[] = []
for (let at = 0; at < 5; at++) runs.push(particleRoundTrip())
runs.sort((a, b) => a - b)
const best = runs[0]
const median = runs[Math.floor(runs.length / 2)]
const perFrame = median / FRAMES
const perWrite = perFrame / (RECORDS * 2)
console.log(`── Task 114: T3 particle feed (${RECORDS} records × ${FRAMES} frames, 2 writes/record) ──`)
console.log(`round-trip best/median : ${best.toFixed(1)} / ${median.toFixed(1)} ms`)
console.log(`per frame              : ${perFrame.toFixed(3)} ms`)
console.log(`per field write (incl. flush+apply): ${(perWrite * 1e6).toFixed(0)} ns`)
console.log(`writes per second      : ${(FRAMES * RECORDS * 2 / (median / 1000) / 1e6).toFixed(2)} M/s`)
