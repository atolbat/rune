// Interleaved A/B for the trail bake: N trail particles, K history points,
// measure the view() bake (the ribbon soup expansion) per frame.
import { createParticles, createRamp } from '../src/index.ts'

const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 1 },
  { t: 0.5, size: 1, r: 1, g: 0.95, b: 0.85, a: 0.8 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])
const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [30, 30] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}
const BASIS = { right: [1, 0, 0], up: [0, 1, 0] }
const N = 8_000
const K = 24

const ps = createParticles({
  capacity: N, spawner: SPAWNER, ramp: RAMP,
  render: { kind: 'trail' as const, points: K, length: 1.4, width: 0.16 },
})
ps.burst(N)
// warm the history: advance past several step intervals so every ring
// buffer holds K recorded points (the bake walks them all)
for (let i = 0; i < K * 4; i++) ps.advance(1 / 30)

const FRAMES = 60
const R = 5
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const times: number[] = []
for (let r = 0; r < R; r++) {
  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    ps.advance(1 / 30)
    ps.view(BASIS)
  }
  times.push((performance.now() - t0) / FRAMES)
}
const count = ps.view(BASIS).vertexCount / 6
console.log(`trail frame (advance+bake, ~${Math.round(count)} live, K=${K}): ${med(times).toFixed(3)} ms/frame`)
