// Task 176 — THE RADIX TIER, the facade leg (@rune/particles): the
// painter's order at the 100k+ scale — @rune/core's four-pass LSD radix
// (caller-owned aux) replaces the JS-comparator sort, and the per-frame
// JS-array copy loop is GONE (the bakers take the typed prefix view
// directly: `order` is ArrayLike now).
//
// Pinned here:
//   1. THE END-TO-END PARITY — the facade's sorted stream (radix + the
//      typed view, both draws) is byte-identical to a MANUAL classic
//      bake: the expected order computed with the classic comparator in
//      the test, handed to the direct bakers as a plain array. The whole
//      new pipeline ≡ the old semantics, at the bytes.
//   2. THE ARRAYLIKE SEAM — the direct bakers accept an Int32Array order
//      (the facade's typed prefix view) with output identical to the
//      same order as a plain array.
//   3. THE PREFIX VIEW — the live count changes frame to frame: the
//      sorted view bakes EXACTLY the live prefix (no stale-tail quads),
//      and the parity holds at every count (the ping-pong reuse).
//   4. Determinism across frames — the reused aux/indices cannot drift.

import { describe, expect, it } from 'bun:test'
import {
  createParticles,
  createRamp,
  packInstances,
  fillBillboards,
  INSTANCE_STRIDE,
  SOUP_STRIDE,
  VERTS_PER_PARTICLE,
  type CameraBasis,
  type SpawnRecord,
} from '../src/index.ts'

const RAMP = createRamp([
  { t: 0, size: 0.4, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 0.5, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
  { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
])

const BASIS: CameraBasis = { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }

function hashRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) % 1000003) / 1000003
  }
}

function fixed(): (index: number, out: SpawnRecord) => void {
  return (_index, out) => {
    out.x = 0; out.y = 0; out.z = 0
    out.vx = 0; out.vy = 0; out.vz = 0
    out.life = 30; out.size = 1
    out.r = 1; out.g = 1; out.b = 1; out.a = 1
    out.seed = 0
  }
}

/** A facade of `n` live particles at deterministic depths (z ∈ [−60, 0),
 *  exact duplicates every 16th slot — tie coverage), the sorted layer on. */
function sortedFacade(n: number, draw: 'soup' | 'instance', seed = 5) {
  const facade = createParticles({
    capacity: 700,
    ramp: RAMP,
    render: { kind: 'billboard', draw, sort: true },
  })
  facade.burst(n, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [30, 30], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed })
  const rnd = hashRng(seed)
  for (let i = 0; i < n; i++) {
    facade.fields.px[i] = (rnd() * 2 - 1) * 20
    facade.fields.py[i] = (rnd() * 2 - 1) * 10
    facade.fields.pz[i] = -rnd() * 60
    if (i > 0 && (i & 15) === 0) facade.fields.pz[i] = facade.fields.pz[i - 1] // exact ties
  }
  return facade
}

/** The classic comparator oracle, in the test — the expected order. */
function classicOrder(facade: ReturnType<typeof sortedFacade>, n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  const keys = new Float32Array(n)
  for (let i = 0; i < n; i++) keys[i] = -facade.fields.pz[i] // forward = (0,0,−1)
  order.sort((a, b) => keys[b] - keys[a] || b - a)
  return order
}

describe('Task 176 — THE RADIX TIER (the facade leg)', () => {
  it('THE END-TO-END PARITY, instance draw — radix + typed view ≡ manual classic bake (bytes)', () => {
    const n = 500
    const facade = sortedFacade(n, 'instance')
    const view = facade.view(BASIS)
    expect(view.instanceCount).toBe(n)

    // the manual classic bake: same system state, plain-array order
    const source = { count: n, fields: facade.fields }
    const expected = new Float32Array(700 * INSTANCE_STRIDE)
    const packed = packInstances(source, expected, { ramp: RAMP, order: classicOrder(facade, n) })
    expect(packed).toBe(n)

    const got = view.vertices.subarray(0, n * INSTANCE_STRIDE)
    const want = expected.subarray(0, n * INSTANCE_STRIDE)
    expect(got.length).toBe(want.length)
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== want[i]) throw new Error(`instance parity: float ${i} diverged (got ${got[i]}, want ${want[i]})`)
    }
  })

  it('THE END-TO-END PARITY, soup draw — the quads bake in the classic order (bytes)', () => {
    const n = 500
    const facade = sortedFacade(n, 'soup')
    const view = facade.view(BASIS)
    expect(view.vertexCount).toBe(n * VERTS_PER_PARTICLE)

    const source = { count: n, fields: facade.fields }
    const expected = new Float32Array(700 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    const baked = fillBillboards(source, BASIS, expected, { ramp: RAMP, order: classicOrder(facade, n) })
    expect(baked).toBe(n * VERTS_PER_PARTICLE)

    const floats = n * VERTS_PER_PARTICLE * SOUP_STRIDE
    const got = view.vertices.subarray(0, floats)
    const want = expected.subarray(0, floats)
    for (let i = 0; i < floats; i++) {
      if (got[i] !== want[i]) throw new Error(`soup parity: float ${i} diverged (got ${got[i]}, want ${want[i]})`)
    }
  })

  it('THE ARRAYLIKE SEAM — the bakers take an Int32Array order (identical to the plain array)', () => {
    const n = 300
    const facade = sortedFacade(n, 'instance')
    const source = { count: n, fields: facade.fields }
    const plain = classicOrder(facade, n)

    const viaPlain = new Float32Array(700 * INSTANCE_STRIDE)
    packInstances(source, viaPlain, { ramp: RAMP, order: plain })
    const viaTyped = new Float32Array(700 * INSTANCE_STRIDE)
    const typed = new Int32Array(700)
    for (let i = 0; i < n; i++) typed[i] = plain[i]
    packInstances(source, viaTyped, { ramp: RAMP, order: typed.subarray(0, n) })

    for (let i = 0; i < n * INSTANCE_STRIDE; i++) {
      if (viaPlain[i] !== viaTyped[i]) throw new Error(`ArrayLike seam: record float ${i} diverged`)
    }

    // the soup twin
    const soupA = new Float32Array(700 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    fillBillboards(source, BASIS, soupA, { ramp: RAMP, order: plain })
    const soupB = new Float32Array(700 * VERTS_PER_PARTICLE * SOUP_STRIDE)
    fillBillboards(source, BASIS, soupB, { ramp: RAMP, order: typed.subarray(0, n) })
    const floats = n * VERTS_PER_PARTICLE * SOUP_STRIDE
    for (let i = 0; i < floats; i++) {
      if (soupA[i] !== soupB[i]) throw new Error(`ArrayLike seam (soup): float ${i} diverged`)
    }
  })

  it('THE PREFIX VIEW — the live count changes; exactly the live prefix bakes (no stale tail)', () => {
    const facade = sortedFacade(500, 'instance')
    expect(facade.view(BASIS).instanceCount).toBe(500)

    // kill everything, re-burst a DIFFERENT count — the typed prefix view
    // must carry the new live length (the old JS-array copy truncated
    // explicitly; the subarray view must not bake the stale tail).
    facade.advance(31) // life 30 → all dead
    expect(facade.count).toBe(0)
    expect(facade.view(BASIS).instanceCount).toBe(0)

    const n = 120
    facade.burst(n, { shape: { kind: 'point', origin: [0, 0, 0] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [30, 30], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 6 })
    const rnd = hashRng(6)
    for (let i = 0; i < n; i++) {
      facade.fields.px[i] = (rnd() * 2 - 1) * 20
      facade.fields.py[i] = (rnd() * 2 - 1) * 10
      facade.fields.pz[i] = -rnd() * 60
      if (i > 0 && (i & 15) === 0) facade.fields.pz[i] = facade.fields.pz[i - 1]
    }
    const view = facade.view(BASIS)
    expect(view.instanceCount).toBe(n)

    // and the parity holds at the new count (the ping-pong reuse)
    const source = { count: n, fields: facade.fields }
    const expected = new Float32Array(700 * INSTANCE_STRIDE)
    packInstances(source, expected, { ramp: RAMP, order: classicOrder(facade, n) })
    const got = view.vertices.subarray(0, n * INSTANCE_STRIDE)
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== expected[i]) throw new Error(`prefix parity at n=${n}: float ${i} diverged`)
    }
  })

  it('determinism across frames — the reused scratch cannot drift', () => {
    const facade = sortedFacade(400, 'instance')
    const first = facade.view(BASIS).vertices.slice(0, 400 * INSTANCE_STRIDE)
    facade.view(BASIS) // a second frame over the identical state
    const second = facade.view(BASIS).vertices.slice(0, 400 * INSTANCE_STRIDE)
    expect(Array.from(second)).toEqual(Array.from(first))
  })
})
