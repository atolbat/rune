/**
 * scripts/bolt-probe.mjs — measures what the stretched-billboard path burst
 * actually bakes: per-quad head/tail positions along the polyline. Diagnoses
 * the "disconnected segments" report: are consecutive quads overlapping or
 * is there a coverage gap between them?
 */
import { createParticles, createRamp, createSpawner } from '../packages/particles/src/index.ts'

const SEGS = 11
function boltPath(x0, y0, z0, x1, y1, z1, seed, segs, jitter) {
  const pts = new Float64Array((segs + 1) * 3)
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    let x = x0 + (x1 - x0) * t
    let z = z0 + (z1 - z0) * t
    const y = y0 + (y1 - y0) * t
    if (i > 0 && i < segs) {
      const j = (n) => (Math.sin(seed * 127.1 + i * 311.7 + n * 74.7) * 43758.5453) % 1
      const k = jitter * (1 - t * 0.65)
      x += (j(1) - 0.5) * 2 * k
      z += (j(2) - 0.5) * 2 * k
    }
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z
  }
  return pts
}

const BOLT_BASE = {
  shape: { kind: 'path', points: [0, 13, 0, 0, 0, 0], mode: 'lattice', scatter: 0.05 },
  velocity: { mode: 'axis' },
  speed: [1.2, 1.2], life: [0.16, 0.16], size: [0.55, 0.55],
  color: [[1, 1, 1, 1], [0.8, 0.9, 1, 1]], seed: 5,
}

const facade = createParticles({
  capacity: 96,
  ramp: createRamp([
    { t: 0, size: 1, r: 1, g: 1, b: 1, a: 0 },
    { t: 0.07, size: 1, r: 1, g: 1, b: 1, a: 1 },
    { t: 0.3, size: 1, r: 0.9, g: 0.95, b: 1, a: 0.12 },
    { t: 0.45, size: 1, r: 1, g: 1, b: 1, a: 0.95 },
    { t: 0.75, size: 1, r: 0.9, g: 0.95, b: 1, a: 0.5 },
    { t: 1, size: 0.7, r: 0.85, g: 0.9, b: 1, a: 0 },
  ]),
  spawner: BOLT_BASE,
  render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.04, lengthFactor: 7 },
})

const seed = 937
const path = boltPath(-1.2, 14, -2.1, -3.5, 0, -6.5, seed, SEGS, 1.5)
const points = Array.from(path)
facade.burst(SEGS, { ...BOLT_BASE, shape: { ...BOLT_BASE.shape, points }, seed })
facade.advance(0.02) // mid-strobe

const view = facade.view({ right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] })
const verts = view.vertices
const n = view.vertexCount
console.log('vertexCount', n, 'particles', facade.stats().count)

// Reconstruct each quad (6 verts, stride? — read the first vert to learn the stride)
// The soup is pos3 uv2 color4 → 9 floats? Task says 36 B per vertex = 9 floats.
const STRIDE = 9
const quads = []
for (let i = 0; i < n; i += 6) {
  const p = []
  for (let k = 0; k < 6; k++) {
    const b = (i + k) * STRIDE
    p.push([verts[b], verts[b + 1], verts[b + 2]])
  }
  quads.push(p)
}
console.log('quads baked:', quads.length)

// For each quad: report head edge (verts 0 & 5) and tail edge (verts 1 & 2) y positions
for (let q = 0; q < quads.length; q++) {
  const [h0, t0, , , t3, h1] = [quads[q][0], quads[q][1], quads[q][2], quads[q][3], quads[q][4], quads[q][5]]
  const hy = (h0[1] + h1[1]) / 2, ty = (t0[1] + t3[1]) / 2
  const hx = (h0[0] + h1[0]) / 2, tx = (t0[0] + t3[0]) / 2
  const len = Math.hypot(hx - tx, hy - ty)
  console.log(`quad ${String(q).padStart(2)}: head (${hx.toFixed(2)}, ${hy.toFixed(2)}) tail (${tx.toFixed(2)}, ${ty.toFixed(2)}) length ${len.toFixed(2)}`)
}
