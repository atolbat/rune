// Interleaved A/B for the ADVANCE walk + the EMISSION walk (Task 174's
// Part B — the "эдванс" pass). Two etalons, median of 5 rounds:
//   ADVANCE — 100k long-lived, gravity + drag (the etalon's force set;
//     the aging/integration/swap walk alone).
//   EMISSION — 100k one-shot burst through the sphere spawner (the spawn
//     closure + the emit walk's validation + the SoA stores).
// Run me per A/B round; git stash -- packages/particles/src/system.ts is
// the switch.
import { createParticles, createRamp } from '../src/index.ts'

const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 1 },
  { t: 0.5, size: 1, r: 1, g: 0.95, b: 0.85, a: 0.8 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])
const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [30, 30] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}
const FORCES = { gravity: [0, -4, 0], drag: 0.6 }

const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// ── ADVANCE: 100k long-lived, gravity+drag, steady (no deaths) ──
const adv = createParticles({ capacity: 100_000, spawner: SPAWNER, ramp: RAMP, forces: FORCES, spin: 1 })
adv.burst(100_000)
for (let i = 0; i < 30; i++) adv.advance(1 / 60) // settle past first-touch
{
  const R = 5, FRAMES = 60
  const times: number[] = []
  let checksum = 0
  for (let r = 0; r < R; r++) {
    const t0 = performance.now()
    for (let f = 0; f < FRAMES; f++) { adv.advance(1 / 60); checksum += adv.count }
    times.push((performance.now() - t0) / FRAMES)
  }
  console.log(`advance frame (100k live, gravity+drag): ${med(times).toFixed(3)} ms/frame (${(med(times) * 1e6 / 100_000).toFixed(1)} ns/particle) [c=${checksum % 97}]`)
}

// ── ADVANCE (forces-heavy leg): the worst-case per-particle walk ──
const heavy = createParticles({
  capacity: 100_000, spawner: SPAWNER, ramp: RAMP, spin: 1,
  forces: {
    gravity: [0, -4, 0], drag: 0.6,
    turbulence: 1.1,
    noise: { strength: 1.4, scale: 0.3, speed: 0.25 },
    seek: { strength: 4, damping: 1.8, targets: [[0, 1.5, 0], [2, 0.5, -1]] },
    collide: { planes: [{ normal: [0, 1, 0], point: [0, -0.5, 0], restitution: 0.45, friction: 0.04 }] },
    limitSpeed: { limit: 9, dampen: 0.5 },
  },
})
heavy.burst(100_000)
for (let i = 0; i < 30; i++) heavy.advance(1 / 60)
{
  const R = 5, FRAMES = 30
  const times: number[] = []
  let checksum = 0
  for (let r = 0; r < R; r++) {
    const t0 = performance.now()
    for (let f = 0; f < FRAMES; f++) { heavy.advance(1 / 60); checksum += heavy.count }
    times.push((performance.now() - t0) / FRAMES)
  }
  console.log(`advance frame (100k live, forces-heavy): ${med(times).toFixed(3)} ms/frame (${(med(times) * 1e6 / 100_000).toFixed(1)} ns/particle) [c=${checksum % 97}]`)
}

// ── EMISSION: 100k one-shot burst (fresh SoA each round — the etalon) ──
{
  const R = 5
  const times: number[] = []
  let checksum = 0
  for (let r = 0; r < R; r++) {
    const ps = createParticles({ capacity: 100_000, spawner: SPAWNER, ramp: RAMP, spin: 1 })
    const t0 = performance.now()
    checksum += ps.burst(100_000)
    times.push(performance.now() - t0)
  }
  console.log(`emission burst (100k): ${med(times).toFixed(2)} ms (${(med(times) * 1000).toFixed(0)} ns/spawn) [c=${checksum % 97}]`)
}
