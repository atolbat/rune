// task136.test.ts — Task 136: THE CPU-TIER CULL (render.cull on sim:'cpu')
// + the WebGL2 TF sampler-units regression is pinned in
// webgl2/tests/transformFeedback.test.ts (the black-screen root cause).
//
// THE CONTRACT:
//   1. the facade CREATES with render.cull on the CPU tier now (the Task
//      134 reject is retired); view() demands the basis viewProj (loud,
//      the GPU tier's step()-camera contract mirrored);
//   2. both bakers skip the same particles — the GPU render tier's exact
//      sphere test (dot(n, p) + d <= −radius over the six normalized
//      planes, radius = spawnSize · rampMax · 0.5);
//   3. the SURVIVORS' bytes are IDENTICAL to the no-cull bake (the cull
//      removes quads, it never rewrites them);
//   4. the soup/instance parity holds under the gate (packInstances' count
//      === fillBillboards()/6 with the SAME frustum);
//   5. the order interplay: the sorted walk + the gate compose (both
//      bakers skip the same entries of the sequence).
import { test, expect, describe, it } from 'bun:test'
import {
  createParticleSystem, createParticles, createRamp,
  fillBillboards, packInstances, gpuRenderFrustum, gpuRampMaxSize,
  SOUP_STRIDE, INSTANCE_STRIDE, VERTS_PER_PARTICLE,
} from '../src/index.ts'
import type { SpawnRecord, SpawnerDesc } from '../src/index.ts'

/** A minimal point spawner (the facade's burst/rate path takes a DESC). */
const SP: SpawnerDesc = {
  shape: { kind: 'point', origin: [0, 0, 0] },
  velocity: { mode: 'radial' }, speed: [0, 0], life: [10, 10], size: [1, 1],
  color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1,
}

// ─── the camera (Task 134's own setup — eye (0,0,10) looking −Z, fov 90°,
// near 1, far 100; the frustum half-width is 10 at the origin's depth) ──────
function mul(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  }
  return o
}
function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2)
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
}
const VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
const VP = mul(perspective(Math.PI / 2, 1, 1, 100), VIEW)
const PLANES = gpuRenderFrustum(VP)

/** The GPU sortKeys test, mirrored in JS (the parity oracle). */
function gpuVisible(x: number, y: number, z: number, radius: number): boolean {
  for (let p = 0; p < 6; p++) {
    if (PLANES[p * 4] * x + PLANES[p * 4 + 1] * y + PLANES[p * 4 + 2] * z + PLANES[p * 4 + 3] <= -radius) return false
  }
  return true
}

/** A manual spawner: every particle identical, fully controlled. */
function fixedSpawner(over: Partial<SpawnRecord>): (index: number, out: SpawnRecord) => void {
  return (index, out) => {
    out.x = 0; out.y = 0; out.z = 0
    out.vx = 0; out.vy = 0; out.vz = 0
    out.life = 10; out.size = 1
    out.r = 1; out.g = 1; out.b = 1; out.a = 1
    out.seed = 0
    Object.assign(out, over)
  }
}

/** 6 particles: 4 well inside (around the origin), 2 well outside
 * (x = ±40 — far beyond the half-width 10 at that depth). */
function stockedSystem(): ReturnType<typeof createParticleSystem> {
  const ps = createParticleSystem(8)
  ps.emit(4, fixedSpawner({ x: -1, y: 0.5, z: 0, seed: 0.11 }))
  ps.emit(2, fixedSpawner({ x: 40, y: 0, z: 0, seed: 0.22 }))
  ps.emit(2, fixedSpawner({ x: -40, y: 2, z: 0, seed: 0.33 }))
  return ps
}

const BASIS = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }

describe('Task 136 — the bakers\' frustum gate', () => {
  it('fillBillboards skips the off-screen particles (the soup shrinks)', () => {
    const ps = stockedSystem()
    const out = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const all = fillBillboards(ps, BASIS, out)
    const gated = fillBillboards(ps, BASIS, out, { frustum: PLANES, cullRadiusK: 0.5 })
    expect(all).toBe(8 * VERTS_PER_PARTICLE) // 8 live, 6 verts each
    expect(gated).toBe(4 * VERTS_PER_PARTICLE) // the 4 inside survive
  })

  it('the survivors\' bytes are IDENTICAL to the no-cull bake (the gate removes, never rewrites)', () => {
    const ps = stockedSystem()
    const a = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const b = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    fillBillboards(ps, BASIS, a)
    fillBillboards(ps, BASIS, b, { frustum: PLANES, cullRadiusK: 0.5 })
    // the first 4 quads of the ungated bake are the 4 inside particles
    // (slot order): the gated bake's 4 quads are byte-identical to them.
    expect(b.subarray(0, 4 * VERTS_PER_PARTICLE * SOUP_STRIDE)).toEqual(a.subarray(0, 4 * VERTS_PER_PARTICLE * SOUP_STRIDE))
  })

  it('packInstances skips the SAME particles (the soup/instance parity under the gate)', () => {
    const ps = stockedSystem()
    const soup = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const recs = new Float32Array(8 * INSTANCE_STRIDE)
    const soupN = fillBillboards(ps, BASIS, soup, { frustum: PLANES, cullRadiusK: 0.5 })
    const recN = packInstances(ps, recs, { frustum: PLANES, cullRadiusK: 0.5 })
    expect(recN).toBe(soupN / VERTS_PER_PARTICLE)
    // and the records match the surviving quads: record i's CENTER is the
    // particle's position — the soup's quads carry the corners around it.
    const f = ps.fields
    const survivors: number[] = []
    for (let i = 0; i < ps.count; i++) {
      if (gpuVisible(f.px[i], f.py[i], f.pz[i], f.size[i] * 0.5)) survivors.push(i)
    }
    for (let k = 0; k < recN; k++) {
      const i = survivors[k] // both bakers walk the slot order here
      expect(recs[k * INSTANCE_STRIDE]).toBeCloseTo(f.px[i], 6)
      expect(recs[k * INSTANCE_STRIDE + 1]).toBeCloseTo(f.py[i], 6)
      expect(recs[k * INSTANCE_STRIDE + 2]).toBeCloseTo(f.pz[i], 6)
    }
  })

  it('the gate matches the GPU sortKeys oracle exactly (the same sphere test)', () => {
    const ps = createParticleSystem(16)
    // a spread of positions, sizes and radii — the oracle decides
    ps.emit(16, fixedSpawner({ x: 0, y: 0, z: 0 }))
    const f = ps.fields
    const xs = [0, 9, 10.4, 40, -9, -10.6, 0, 0, 3, 3, 3, 12, 0, 0, -12, 6]
    const zs = [0, 0, 0, 0, 0, 0, 8, -8, 0, 0, 0, 0, 95, -90, 0, 0]
    const ys = [0, 0, 0, 0, 0, 0, 0, 0, 9, 10.5, -11, 0, 0, 0, 0, 0]
    const sizes = [1, 1, 1, 1, 2, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    for (let i = 0; i < 16; i++) {
      f.px[i] = xs[i]; f.py[i] = ys[i]; f.pz[i] = zs[i]; f.size[i] = sizes[i]
      f.age[i] = 0.5; f.life[i] = 10
    }
    const out = new Float32Array(16 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const n = fillBillboards(ps, BASIS, out, { frustum: PLANES, cullRadiusK: 0.5 })
    let oracle = 0
    for (let i = 0; i < 16; i++) if (gpuVisible(xs[i], ys[i], zs[i], sizes[i] * 0.5)) oracle++
    expect(n).toBe(oracle * VERTS_PER_PARTICLE)
  })

  it('the order interplay: the sorted walk + the gate compose (both bakers skip the same entries)', () => {
    const ps = stockedSystem()
    const order = [0, 2, 4, 5, 6, 7, 1, 3] // a shuffled live sequence
    const soup = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const recs = new Float32Array(8 * INSTANCE_STRIDE)
    const soupN = fillBillboards(ps, BASIS, soup, { frustum: PLANES, cullRadiusK: 0.5, order })
    const recN = packInstances(ps, recs, { frustum: PLANES, cullRadiusK: 0.5, order })
    expect(recN).toBe(soupN / VERTS_PER_PARTICLE)
    // the survivors in ORDER: both bakers walk `order` and skip the same
    // entries — record k's CENTER is the k-th surviving particle's
    // position (the order preserved).
    const survived: number[] = []
    for (const i of order) if (gpuVisible(ps.fields.px[i], ps.fields.py[i], ps.fields.pz[i], ps.fields.size[i] * 0.5)) survived.push(i)
    for (let k = 0; k < survived.length; k++) {
      const i = survived[k]
      expect(recs[k * INSTANCE_STRIDE]).toBeCloseTo(ps.fields.px[i], 6)
      expect(recs[k * INSTANCE_STRIDE + 1]).toBeCloseTo(ps.fields.py[i], 6)
    }
  })

  it('a null/omitted frustum bakes everything (the opt-out is a no-op)', () => {
    const ps = stockedSystem()
    const out = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    expect(fillBillboards(ps, BASIS, out, { frustum: null, cullRadiusK: 0.5 })).toBe(8 * VERTS_PER_PARTICLE)
    expect(fillBillboards(ps, BASIS, out)).toBe(8 * VERTS_PER_PARTICLE)
  })
})

describe('Task 136 — the facade: render.cull on the CPU tier', () => {
  it('CREATES with cull on the CPU tier (the Task 134 reject is retired)', () => {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', cull: true },
    })
    facade.burst(4, SP)
    facade.advance(0.016)
    expect(facade.count).toBe(4)
  })

  it('view() demands the basis viewProj (loud — the GPU tier\'s step() contract mirrored)', () => {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', cull: true },
    })
    facade.burst(4, SP)
    facade.advance(0.016)
    expect(() => facade.view({ right: [1, 0, 0], up: [0, 1, 0] })).toThrow('render.cull needs the camera basis viewProj')
    expect(() => facade.view({ right: [1, 0, 0], up: [0, 1, 0], viewProj: [1, 2, 3] })).toThrow('render.cull needs the camera basis viewProj')
  })

  it('view() with the full basis culls the off-screen (the soup shrinks; the survivors identical)', () => {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', cull: true },
    })
    facade.at(-1, 0.5, 0).burst(4, SP)
    facade.at(40, 0, 0).burst(2, SP)
    facade.advance(0.016)
    const basis = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], viewProj: VP }
    const gated = facade.view(basis)
    expect(gated.vertexCount).toBe(4 * VERTS_PER_PARTICLE)
    // the SAME facade without the gate (a second facade, same spawns) bakes 6
    const ungated = createParticles({ capacity: 8, render: { kind: 'billboard' } })
    ungated.at(-1, 0.5, 0).burst(4, SP)
    ungated.at(40, 0, 0).burst(2, SP)
    ungated.advance(0.016)
    const plain = ungated.view({ ...basis, viewProj: undefined })
    expect(plain.vertexCount).toBe(6 * VERTS_PER_PARTICLE)
  })

  it('the instance-draw CPU tier culls too (the record count drops)', () => {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', draw: 'instance', cull: true },
    })
    facade.at(-1, 0.5, 0).burst(4, SP)
    facade.at(40, 0, 0).burst(2, SP)
    facade.advance(0.016)
    const basis = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1], viewProj: VP }
    const view = facade.view(basis)
    expect(view.instanceCount).toBe(4)
    expect(view.vertexCount).toBe(4)
  })

  it('the GPU tier\'s cull path is unchanged (view() reports the count only; step() owns the gate)', () => {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', draw: 'instance', cull: true },
      sim: 'gpu',
    })
    expect(facade.gpuHandoff).not.toBeNull()
    facade.burst(6, SP)
    // the GPU-tier view() is count-only — no viewProj demand (the gate
    // lives in the orchestrator's step(), fed by the camera contract).
    const view = facade.view({ right: [1, 0, 0], up: [0, 1, 0] })
    expect(view.vertexCount).toBe(6)
  })

  it('the radius factor: rampMax · 0.5 feeds the conservative sphere (the facade\'s own)', () => {
    // a ramp whose max size sample is 2 → radiusK 1: a particle 1.5 beyond
    // the right plane survives with its size-scaled sphere (2 > 1.5) and
    // falls to the default factor's smaller sphere (1 < 1.5).
    const ramp = createRamp([{ t: 0, size: 2, r: 1, g: 1, b: 1, a: 1 }, { t: 1, size: 0.5, r: 1, g: 1, b: 1, a: 1 }])
    expect(gpuRampMaxSize(ramp.points)).toBe(2)
    const ps = createParticleSystem(4)
    ps.emit(4, fixedSpawner({ x: 11.5, y: 0, z: 0, size: 2 }))
    const out = new Float32Array(4 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    // radius = 2 · (2 · 0.5) = 2 → the center 1.5 beyond the plane, the
    // sphere pokes 0.5 in: SURVIVES with the ramp-scaled factor.
    expect(fillBillboards(ps, BASIS, out, { frustum: PLANES, cullRadiusK: gpuRampMaxSize(ramp.points) * 0.5 })).toBe(4 * VERTS_PER_PARTICLE)
    // the default factor 0.5 → radius 1 → 1.5 > 1 fully outside: CULLED.
    expect(fillBillboards(ps, BASIS, out, { frustum: PLANES, cullRadiusK: 0.5 })).toBe(0)
  })
})
