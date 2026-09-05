import { test, expect, describe, it } from 'bun:test'
import {
  createParticles,
  gpuSortPadCount, gpuSortPassSequence, gpuRenderFrustum, gpuRampMaxSize,
  gpuSortWgsl, GPU_SORT_SENTINEL, GPU_SORT_PAD_KEY, GPU_SORT_UNIFORM_FLOATS,
  GPU_SORT_U32_FIELDS, GPU_SORT_F32_FIELDS, GPU_SIM_ENTRIES, GPU_SORT_ENTRIES,
  gpuSimWgsl,
  gpuSimGlSortKeysGlsl, gpuSimGlBitonicGlsl, gpuSimGlPackSortedGlsl,
  GPU_GL_SORTKEYS_UNIFORMS, GPU_GL_SORTKEYS_F, GPU_GL_BITONIC_UNIFORMS,
  GPU_GL_SORT_SENTINEL, GPU_GL_SORT_PAD_KEY, gpuGlPairsTextureH,
} from '../src/index.ts'

/**
 * Task 134 — THE GPU RENDER TIER: the bitonic sort + the frustum cull.
 *
 * The contract under test:
 *   1. THE NETWORK MODEL — the (k, j) sequence gpuSortPassSequence walks is
 *      THE sequence both orchestrators dispatch (the WGSL entry and the
 *      GLSL pass evaluate the same (k, j) against the same pair layout).
 *      A JS twin of the compare-exchange over that sequence is validated
 *      against Array.sort: the sequence's semantics ARE a sort.
 *   2. THE PAIR SEMANTICS — the negated-depth key (ascending = far first,
 *      the painter's order), the sentinel index (pads + culled sort to the
 *      END — the draw range [0, count) is the visible prefix far-to-near
 *      plus the zero-record tail).
 *   3. THE FRUSTUM — gpuRenderFrustum's six normalized planes: visible
 *      points pass, off-screen/behind fail, the sphere radius is honored.
 *   4. THE SOURCES — the WGSL/GLSL twins: the entries, the bindings, the
 *      constants, no reserved words.
 *   5. THE FACADE — render.cull's validation (billboard-kind, GPU tier
 *      only); render.sort + sim:'gpu' now CREATES (the Task 132 reject is
 *      retired — the GPU render tier owns the order).
 */

/** A deterministic LCG (the golden tests' reproducible keys). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** THE JS TWIN of the WGSL bitonic entry / the GLSL bitonic pass over the
 *  SAME (k, j) sequence: the low thread of (i, i^j) swaps when the pair
 *  violates the block's direction ((i & k) === 0 → ascending). */
function bitonicModel<T>(entries: T[], keyOf: (e: T) => number): T[] {
  const N = entries.length
  const a = entries.slice()
  gpuSortPassSequence(N, (k, j) => {
    for (let i = 0; i < N; i++) {
      const p = i ^ j
      if (p > i) {
        const asc = (i & k) === 0
        if ((keyOf(a[i]) > keyOf(a[p])) === asc) {
          const t = a[i]; a[i] = a[p]; a[p] = t
        }
      }
    }
  })
  return a
}

describe('Task 134 — the bitonic network model (the (k, j) sequence)', () => {
  it('sorts ascending for every power-of-two size (the sequence IS a sort)', () => {
    for (let log = 0; log <= 8; log++) {
      const N = 1 << log
      const rnd = lcg(0x134 + log)
      // unique keys (i·100 + jitter < 100) — ties would be order-ambiguous
      const keys = Array.from({ length: N }, (_, i) => i * 100 + Math.floor(rnd() * 99))
      const sorted = bitonicModel(keys, k => k)
      expect(sorted).toEqual(keys.slice().sort((x, y) => x - y))
    }
  })

  it('handles duplicate keys (the network is not stable, but it partitions)', () => {
    const keys = [5, 5, 3, 3, 9, 9, 1, 1]
    const sorted = bitonicModel(keys, k => k)
    // duplicates may land in either order — the MULTISET is exact
    expect(sorted.slice().sort((x, y) => x - y)).toEqual([1, 1, 3, 3, 5, 5, 9, 9])
  })

  it('the negated-depth direction: ascending over −depth = the farthest first', () => {
    const depths = [10, 5, 0, -5, 7, -2, 3, 1]
    const sorted = bitonicModel(depths.map(d => -d), k => k)
    expect(sorted.map(k => -k)).toEqual(depths.slice().sort((x, y) => y - x))
  })

  it('the pair semantics: the visible prefix is far-to-near, the sentinels trail', () => {
    // 6 live slots (two CULLED — the sentinel pair), + 2 pads → N = 8
    const depths = [9, 3, 7, 1, 5, 2]
    const culled = new Set([0, 3])
    const entries = depths.map((d, slot) => culled.has(slot)
      ? { key: GPU_SORT_PAD_KEY, idx: GPU_SORT_SENTINEL }
      : { key: -d, idx: slot })
    entries.push({ key: GPU_SORT_PAD_KEY, idx: GPU_SORT_SENTINEL }, { key: GPU_SORT_PAD_KEY, idx: GPU_SORT_SENTINEL })
    const sorted = bitonicModel(entries, e => e.key)
    // the VISIBLE prefix [0, 4): the four finite keys, far-to-near
    // (slots 0 and 3 were CULLED — depths 9 and 1 are gone)
    const visible = sorted.filter(e => e.idx !== GPU_SORT_SENTINEL)
    expect(visible).toHaveLength(4)
    expect(visible.map(e => -e.key)).toEqual([7, 5, 3, 2])
    // every sentinel sits AFTER the last visible entry
    const firstSentinel = sorted.findIndex(e => e.idx === GPU_SORT_SENTINEL)
    expect(firstSentinel).toBe(4)
  })

  it('the pass count: log2(N)·(log2(N)+1)/2 — N=4 → 3, N=16384 → 105, N=262144 → 171', () => {
    for (const [n, passes] of [[4, 3], [16, 10], [16384, 105], [262144, 171]] as const) {
      let count = 0
      gpuSortPassSequence(n, () => { count++ })
      expect(count).toBe(passes)
    }
  })
})

describe('Task 134 — the padded network size (gpuSortPadCount)', () => {
  it('the next power of two ≥ count, ≥ 1', () => {
    expect(gpuSortPadCount(0)).toBe(1)
    expect(gpuSortPadCount(1)).toBe(1)
    expect(gpuSortPadCount(2)).toBe(2)
    expect(gpuSortPadCount(3)).toBe(4)
    expect(gpuSortPadCount(5)).toBe(8)
    expect(gpuSortPadCount(16)).toBe(16)
    expect(gpuSortPadCount(17)).toBe(32)
    expect(gpuSortPadCount(160_000)).toBe(262_144)
  })
  it('rejects the non-finite and the negative', () => {
    expect(() => gpuSortPadCount(-1)).toThrow('must be a finite number')
    expect(() => gpuSortPadCount(Number.NaN)).toThrow('must be a finite number')
  })
})

describe('Task 134 — the frustum (gpuRenderFrustum)', () => {
  /** Column-major 4×4 product a·b (the @rune/math convention). */
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
  /** gluPerspective, column-major. */
  function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
    const f = 1 / Math.tan(fovy / 2)
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
  }
  // eye (0, 0, 10) looking −Z at the origin, fov 90°, aspect 1, near 1, far 100
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
  const vp = mul(perspective(Math.PI / 2, 1, 1, 100), view)
  const planes = gpuRenderFrustum(vp)

  function inside(x: number, y: number, z: number, r = 0): boolean {
    for (let p = 0; p < 6; p++) {
      if (planes[p * 4] * x + planes[p * 4 + 1] * y + planes[p * 4 + 2] * z + planes[p * 4 + 3] <= -r) return false
    }
    return true
  }

  it('the planes are normalized (|n| = 1) and the layout is 24 floats', () => {
    expect(planes).toHaveLength(24)
    for (let p = 0; p < 6; p++) {
      const len = Math.hypot(planes[p * 4], planes[p * 4 + 1], planes[p * 4 + 2])
      expect(len).toBeCloseTo(1, 5)
    }
  })
  it('the visible pass, the off-screen and the behind fail', () => {
    expect(inside(0, 0, 0)).toBe(true)      // dead ahead, mid-volume
    expect(inside(2, 2, 2)).toBe(true)      // comfortably inside the fov
    expect(inside(9, 0, 0)).toBe(true)      // near the right edge (half-width 10 at dist 10)
    expect(inside(15, 0, 0)).toBe(false)    // well off the side
    expect(inside(0, 15, 0)).toBe(false)    // well above
    expect(inside(0, 0, 9.5)).toBe(false)   // inside the near slab (dist 0.5 < near 1)
    expect(inside(0, 0, -95)).toBe(false)   // beyond the far plane (dist 105)
  })
  it('the sphere radius: an off-center point passes with the margin, fails without', () => {
    expect(inside(10.5, 0, 0, 1.5)).toBe(true)   // the sphere pokes inside the frustum
    expect(inside(10.5, 0, 0, 0)).toBe(false)    // the bare center is outside
  })
  it('rejects a wrong-length view-projection', () => {
    expect(() => gpuRenderFrustum([1, 2, 3])).toThrow('16 numbers')
  })
  it('writes into the caller scratch (the zero-alloc hot path)', () => {
    const scratch = new Float32Array(24)
    const out = gpuRenderFrustum(vp, scratch)
    expect(out).toBe(scratch)
    expect(out).toEqual(planes)
  })
})

describe('Task 134 — the cull radius factor (gpuRampMaxSize)', () => {
  it('the largest size sample, ≥ 1 (a safe default for an empty table)', () => {
    expect(gpuRampMaxSize([{ size: 0.5 }, { size: 2 }, { size: 1 }])).toBe(2)
    expect(gpuRampMaxSize([{ size: 0.3 }])).toBe(1)
    expect(gpuRampMaxSize([])).toBe(1)
  })
})

describe('Task 134 — the WGSL sort family (gpuSortWgsl)', () => {
  const src = gpuSortWgsl()
  it('the three entries and the shifted bindings (pairs rw, state ro)', () => {
    expect(src).toContain('fn sortKeys(')
    expect(src).toContain('fn bitonic(')
    expect(src).toContain('fn sortStep(')
    expect(src).toContain('fn pack(')
    expect(src).toContain('var<storage, read_write> pairs : array<vec2<f32>>;')
    expect(src).toContain('var<storage, read> state : array<f32>;')
    expect(src).toContain('var<storage, read_write> records : array<f32>;')
    expect(src).toContain('var<storage, read> rampLUT : array<f32>;')
  })
  it('the constants and the compare-exchange (the model twin)', () => {
    expect(src).toContain(`const PAD_KEY : f32 = ${GPU_SORT_PAD_KEY};`)
    expect(src).toContain(`const SENTINEL : f32 = ${GPU_SORT_SENTINEL}.0;`)
    // the SELF-DRIVING (k, j): the state rides the records head
    expect(src).toContain('records[0] = 2.0;')
    expect(src).toContain('records[1] = 1.0;')
    expect(src).toContain('let k = u32(records[0]);')
    expect(src).toContain('let j = u32(records[1]);')
    expect(src).toContain('let p = i ^ j;')
    expect(src).toContain('let asc = (i & k) == 0u;')
    expect(src).toContain('if ((a.x > b.x) == asc)')
  })
  it('the sorted pack: the sentinel branch + the gather + the shared body', () => {
    expect(src).toContain('let m = pairs[i].y;')
    expect(src).toContain('if (m >= SENTINEL)')
    expect(src).toContain('let b = u32(m) * FSTRIDE;')
    // the pack body is SHARED with the sim family (the ramp walk appears in both)
    expect(src).toContain('arrayLength(&rampLUT) / 7u')
    expect(gpuSimWgsl()).toContain('arrayLength(&rampLUT) / 7u')
  })
  it('the cull: the six-plane sphere test, gated by the render mask', () => {
    expect(src).toContain('if ((P.renderMask & 1u) != 0u)')
    expect(src).toContain('for (var pl = 0u; pl < 6u; pl++)')
    expect(src).toContain('let radius = state[b + 8u] * P.rampMaxSize * 0.5;')
  })
  it('the uniform layout matches the field maps (36 floats, pass-invariant)', () => {
    expect(GPU_SORT_UNIFORM_FLOATS).toBe(36)
    expect(GPU_SORT_ENTRIES).toEqual(['sortKeys', 'bitonic', 'sortStep', 'pack'])
    expect(GPU_SORT_U32_FIELDS.count).toBe(0)
    expect(GPU_SORT_U32_FIELDS.padN).toBe(1)
    expect(GPU_SORT_U32_FIELDS.renderMask).toBe(2)
    expect(GPU_SORT_F32_FIELDS.forward).toBe(4)
    expect(GPU_SORT_F32_FIELDS.planes).toBe(8)
    expect(GPU_SORT_F32_FIELDS.rampMaxSize).toBe(35)
    expect(GPU_SIM_ENTRIES).toEqual(['emit', 'compact', 'advance', 'pack'])
  })
})

describe('Task 134 — the GLSL twins (the sort family)', () => {
  it('sortKeys: the uniforms, the planes, the sentinel pair, no reserved words', () => {
    const src = gpuSimGlSortKeysGlsl()
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    for (const u of GPU_GL_SORTKEYS_UNIFORMS) {
      expect(src).toContain(`uniform ${u.size === 3 ? 'vec3' : u.size === 4 ? 'vec4' : 'float'} ${u.name};`)
    }
    expect(src).toContain('out vec4 v_pair;')
    expect(src).toContain(`const float SENTINEL = ${GPU_GL_SORT_SENTINEL}.0;`)
    expect(src).toContain('key = -(u_forward.x * s0.x + u_forward.y * s0.y + u_forward.z * s0.z);')
    expect(src).toContain('float radius = s2.x * u_radiusK;')
    expect(/\bfloat half\b/.test(src)).toBe(false)
  })
  it('bitonic: the partner xor, the direction bit, the min/max selection', () => {
    const src = gpuSimGlBitonicGlsl()
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    for (const u of GPU_GL_BITONIC_UNIFORMS) {
      expect(src).toContain(`uniform float ${u.name};`)
    }
    expect(src).toContain('int p = i ^ int(u_j + 0.5);')
    expect(src).toContain('bool asc = (i & int(u_k + 0.5)) == 0;')
    expect(src).toContain('if (i < p) { v_pair = asc ? lo : hi; } else { v_pair = asc ? hi : lo; }')
    expect(src).toContain('out vec4 v_pair;')
  })
  it('packSorted: the pairs gather, the sentinel zero record, the shared body', () => {
    const src = gpuSimGlPackSortedGlsl()
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    expect(src).toContain('vec4 pr = texelFetch(u_pairs, texelOf(i), 0);')
    expect(src).toContain(`if (pr.y >= ${GPU_GL_SORT_SENTINEL}.0)`)
    expect(src).toContain('int slot = int(pr.y + 0.5);')
    expect(src).toContain('vec4 s0 = fetchState(slot, 0);')
    // the shared pack body (the ramp walk + the record rows)
    expect(src).toContain('seed * 6.283185307179586')
    expect(src).toContain('mod(fr, u_tileU) / u_tileU')
    expect(/\bfloat half\b/.test(src)).toBe(false)
  })
  it('the sentinel constants are the WGSL twins (the cross-backend contract)', () => {
    expect(GPU_GL_SORT_SENTINEL).toBe(GPU_SORT_SENTINEL)
    expect(GPU_GL_SORT_SENTINEL).toBe(33554432)
    expect(GPU_GL_SORT_PAD_KEY).toBe(GPU_SORT_PAD_KEY)
    expect(GPU_GL_SORTKEYS_F.radiusK).toBe(29)
    expect(GPU_GL_SORTKEYS_F.planes).toBe(5)
  })
  it('the pairs texture height: ceil(nextPow2(capacity) / 2048), at least 1', () => {
    expect(gpuGlPairsTextureH(4)).toBe(1)
    expect(gpuGlPairsTextureH(8192)).toBe(4)
    expect(gpuGlPairsTextureH(16_384)).toBe(8)
    expect(gpuGlPairsTextureH(160_000)).toBe(128)
  })
})

describe('Task 134 — the facade validation (render.cull; the sort flip)', () => {
  it('the trail kind rejects cull (a billboard-kind option)', () => {
    expect(() => createParticles({
      capacity: 4,
      render: { kind: 'trail' as never, points: 8, cull: true as never },
    })).toThrow('render.cull is a billboard-kind option')
  })
  it('the CPU tier rejects cull (the GPU render tier owns the frustum gate)', () => {
    expect(() => createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance', cull: true },
    })).toThrow('render.cull is the GPU tier')
  })
  it('sim:"gpu" ACCEPTS sort and cull now (the Task 132 reject is retired)', () => {
    const facade = createParticles({
      capacity: 4,
      render: { kind: 'billboard', draw: 'instance', sort: true, cull: true },
      sim: 'gpu',
    })
    expect(facade.gpuHandoff).not.toBeNull()
    expect(facade.gpuHandoff!.attached).toBe(false) // the orchestrator attaches
  })
})
