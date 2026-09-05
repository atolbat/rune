import { test, expect, describe, it } from 'bun:test'
import {
  createParticles,
  createParticleSystem,
  sortDepthBackToFront,
  packInstances,
  fillBillboards,
  INSTANCE_STRIDE,
  SOUP_STRIDE,
  VERTS_PER_PARTICLE,
  type CameraBasis,
} from '../src/index.ts'
import type { SpawnRecord } from '../src/index.ts'

/**
 * Task 132 — THE PAINTER'S ORDER (render.sort) + the WebGL2 transform-
 * feedback GPU tier (gpuSimGl / particlesGpuGl — those live in
 * packages/gl, tested there; this suite pins the SORT).
 *
 * The contract under test (see sort.ts):
 *   1. sortDepthBackToFront — the FAR particle first (the depth key
 *      dot(forward, p) descending), ties resolved by the higher slot
 *      (a total order — engine-independent determinism).
 *   2. The facade: render.sort feeds the SAME sequence to both bakers —
 *      the instance records and the soup quads come out in the identical
 *      back-to-front order (the draw-format parity contract).
 *   3. Validation: trail/mesh reject sort; sim:'gpu' rejects sort; a
 *      basis without forward throws at view() time.
 */

/** The camera looks down −Z (the classic GL eye): dot(forward, p) = −z —
 *  a particle at z = −4 is the FARTHEST. */
const LOOK_DOWN_Z: CameraBasis = {
  right: [1, 0, 0],
  up: [0, 1, 0],
  forward: [0, 0, -1],
}

function fixed(): (index: number, out: SpawnRecord) => void {
  return (_index, out) => {
    out.x = 0; out.y = 0; out.z = 0
    out.vx = 0; out.vy = 0; out.vz = 0
    out.life = 10; out.size = 1
    out.r = 1; out.g = 1; out.b = 1; out.a = 1
    out.seed = 0
  }
}

/** A 5-particle store at controlled depths: slot i sits at z = −(i+1)
 *  (slot 0 at −1 … slot 4 at −5, the farthest; no zero → no −0 traps). */
function depthSystem(): ReturnType<typeof createParticleSystem> {
  const ps = createParticleSystem(8)
  ps.emit(5, fixed())
  for (let i = 0; i < 5; i++) ps.fields.pz[i] = -(i + 1)
  return ps
}

describe('Task 132 — sortDepthBackToFront', () => {
  it('orders back to front: the farthest (largest dot(forward, p)) first', () => {
    const ps = depthSystem()
    const indices = new Int32Array(8)
    const keys = new Float32Array(8)
    const n = sortDepthBackToFront(ps.fields, ps.count, LOOK_DOWN_Z.forward!, indices, keys)
    expect(n).toBe(5)
    // z = −5 is the farthest → slot 4 first; then 3, 2, 1, 0.
    expect(Array.from(indices.subarray(0, 5))).toEqual([4, 3, 2, 1, 0])
  })

  it('breaks ties by the higher slot (a total, engine-independent order)', () => {
    const ps = createParticleSystem(4)
    ps.emit(4, fixed())
    // all four at the same depth: the tie-break sends the HIGHER slot first
    const indices = new Int32Array(4)
    const keys = new Float32Array(4)
    sortDepthBackToFront(ps.fields, ps.count, [0, 0, -1], indices, keys)
    expect(Array.from(indices.subarray(0, 4))).toEqual([3, 2, 1, 0])
  })

  it('an arbitrary forward axis sorts by the true view depth', () => {
    const ps = createParticleSystem(3)
    ps.emit(3, fixed())
    ps.fields.px[0] = 2; ps.fields.py[0] = 0; ps.fields.pz[0] = 2   // depth 2
    ps.fields.px[1] = 10; ps.fields.py[1] = 0; ps.fields.pz[1] = -10 // depth 10 → farthest
    ps.fields.px[2] = -1; ps.fields.py[2] = 0; ps.fields.pz[2] = 0  // depth 1
    const indices = new Int32Array(3)
    const keys = new Float32Array(3)
    sortDepthBackToFront(ps.fields, 3, [0.7071, 0, -0.7071], indices, keys)
    expect(Array.from(indices.subarray(0, 3))).toEqual([1, 0, 2])
  })

  it('count 0 is a no-op', () => {
    const ps = createParticleSystem(2)
    const indices = new Int32Array(2)
    const keys = new Float32Array(2)
    expect(sortDepthBackToFront(ps.fields, 0, [0, 0, -1], indices, keys)).toBe(0)
  })
})

describe('Task 132 — render.sort (the facade)', () => {
  function sortedFacade(draw: 'soup' | 'instance') {
    const facade = createParticles({
      capacity: 8,
      render: { kind: 'billboard', draw, sort: true },
    })
    facade.burst(5, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [10, 10], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    for (let i = 0; i < facade.count; i++) facade.fields.pz[i] = -(i + 1)
    return facade
  }

  it('instance mode: the records pack back to front', () => {
    const facade = sortedFacade('instance')
    const view = facade.view(LOOK_DOWN_Z)
    expect(view.draw).toBe('instance')
    expect(view.instanceCount).toBe(5)
    // record 0 = the FARTHEST particle (slot 4, z = −5)
    expect(view.vertices[2]).toBe(-5)
    // record 4 = the nearest (slot 0, z = −1)
    expect(view.vertices[4 * INSTANCE_STRIDE + 2]).toBe(-1)
  })

  it('soup mode: the quads bake in the SAME order (the draw-format parity)', () => {
    const facade = sortedFacade('soup')
    const view = facade.view(LOOK_DOWN_Z)
    expect(view.draw).toBe('soup')
    expect(view.vertexCount).toBe(30)
    // quad 0 (verts 0..5) = the farthest particle (z = −5); quad 4 = z = −1.
    // Corner offsets cancel pairwise even under the seed rotation (corner 2
    // = −corner 0 in the quad plane), so vert0 + vert2 = 2·p.
    const at = (quad: number) => quad * VERTS_PER_PARTICLE * SOUP_STRIDE
    const z02 = (quad: number) => (view.vertices[at(quad) + 2] + view.vertices[at(quad) + 2 * SOUP_STRIDE + 2]) / 2
    expect(z02(0)).toBe(-5)
    expect(z02(4)).toBe(-1)
    // And the exact ORDER matches the instance records' order.
    const inst = sortedFacade('instance')
    const iv = inst.view(LOOK_DOWN_Z)
    for (let q = 0; q < 5; q++) {
      expect(z02(q)).toBe(iv.vertices[q * INSTANCE_STRIDE + 2])
    }
  })

  it('the sequence is stable across frames (deterministic, the reused scratch)', () => {
    const facade = sortedFacade('instance')
    const view = facade.view(LOOK_DOWN_Z)
    const first = Array.from(view.vertices.subarray(0, view.instanceCount * INSTANCE_STRIDE), (v, i) => (i % 16 === 2 ? v : 0))
    facade.advance(0.016)
    facade.view(LOOK_DOWN_Z)
    const second = Array.from(view.vertices.subarray(0, view.instanceCount * INSTANCE_STRIDE), (v, i) => (i % 16 === 2 ? v : 0))
    // only the POSITION channel is order-stable (the age channel legitimately
    // advances every frame)
    expect(second).toEqual(first)
  })

  it('the direct bakers honor an explicit order (the composable core seam)', () => {
    const ps = depthSystem()
    const records = new Float32Array(8 * INSTANCE_STRIDE)
    const n = packInstances(ps, records, { order: [4, 3, 2, 1, 0] })
    expect(n).toBe(5)
    expect(records[2]).toBe(-5)
    const soup = new Float32Array(8 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const verts = fillBillboards(ps, LOOK_DOWN_Z, soup, { order: [4, 3, 2, 1, 0] })
    expect(verts).toBe(30)
    expect(soup[2]).toBeCloseTo(-5, 5)
  })

  it('validation: the trail kind rejects sort', () => {
    expect(() => createParticles({
      capacity: 4,
      render: { kind: 'trail' as never, points: 8, sort: true as never },
    })).toThrow('render.sort is a billboard-kind option')
  })

  it('validation: sim:"gpu" ACCEPTS sort (Task 134 — the GPU render tier owns the order now)', () => {
    // The Task 132 reject ("sim:\"gpu\" rejects render.sort") is RETIRED:
    // the sort family (gpuSim.ts's sortKeys/bitonic/pack) sorts the pairs
    // GPU-side — no CPU mirror needed. The orchestrators (gl) pin the pass
    // sequence; this pins the facade no longer blocks the combination.
    const facade = createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance', sort: true },
      sim: 'gpu',
    })
    expect(facade.gpuHandoff).not.toBeNull()
  })

  it('a basis without forward throws at view() time (the depth key needs it)', () => {
    const facade = createParticles({ capacity: 4, render: { kind: 'billboard', draw: 'instance', sort: true } })
    facade.burst(2, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [10, 10], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    expect(() => facade.view({ right: [1, 0, 0], up: [0, 1, 0] })).toThrow('render.sort needs the camera basis forward')
  })

  it('sort defaults to off (the slot order, backward compatible)', () => {
    const facade = createParticles({ capacity: 8, render: { kind: 'billboard', draw: 'instance' } })
    facade.burst(5, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [10, 10], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 })
    for (let i = 0; i < facade.count; i++) facade.fields.pz[i] = -(i + 1)
    const view = facade.view(LOOK_DOWN_Z)
    // the natural [0, count) walk: record 0 = slot 0 (z = −1), NOT the farthest
    expect(view.vertices[2]).toBe(-1)
  })
})
