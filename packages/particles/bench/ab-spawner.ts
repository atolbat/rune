// Interleaved A/B: current working tree vs HEAD (stashed), 3 rounds each,
// to control for container drift. Usage: bun bench/ab-spawner.ts
import { createSpawner } from '../src/spawn.ts'

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number],
  life: [1.2, 2.2] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]],
  seed: 991,
}
const N = 100_000
const R = 9
const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0, tx: 0, ty: 0, tz: 0 }
const spawner = createSpawner(SPAWNER)
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const results: number[] = []
for (let r = 0; r < R; r++) {
  const t0 = performance.now()
  for (let i = 0; i < N; i++) spawner(i, out)
  results.push(performance.now() - t0)
}
console.log(`spawner: ${med(results).toFixed(2)} ms  (${(med(results) / N * 1e6).toFixed(1)} ns/spawn, ${R} reps)`)
