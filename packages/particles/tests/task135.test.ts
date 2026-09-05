import { test, expect, describe, it } from 'bun:test'
import {
  createParticles, createRamp, createSpawner, hash01, GPU_STATE_STRIDE,
  gpuSimWgsl, GPU_SIM_UNIFORM_BYTES, GPU_SIM_ENTRIES, GPU_SIM_UNIFORM_FLOATS,
  readGpuEmitConfig, gpuEmitLife, gpuEmitRowModel, gpuEmitPackStatic,
  GPU_EMIT_SHAPE, GPU_EMIT_VEL, GPU_EMIT_SALTS, GPU_EMIT_MASK,
  GPU_EMIT_BASE, GPU_EMIT_U32_FIELDS, GPU_EMIT_VEC4_FIELDS,
  gpuSimGlEmitGlsl, GPU_GL_EMIT_UNIFORMS, GPU_GL_EMIT_F,
  type SpawnerDesc, type SpawnRecord,
} from '../src/index.ts'
import { createGpuScratch } from '@rune/core'

/**
 * Task 135 — GPU-SIDE EMISSION (the hash-RNG append pass): the CPU-side
 * contract. The GPU half is pinned by the raw-device gate
 * (scripts/task135-wgsl-emit.mjs: the real WGSL entry vs the JS model,
 * f32 tolerance); HERE we pin:
 *   · the CONFIG interpretation (the flat spawner — the loud rejects of
 *     the non-closed-form constructs, the frame construction),
 *   · the JS REFERENCE TWIN (gpuEmitRowModel) — BIT-EXACT against the
 *     real CPU spawner (the model is the parity oracle the gate holds
 *     the shader to — the same role simplex3 plays for the forces),
 *   · the facade's emit:'gpu' contract (the life ledger, the window's
 *     hash domain, the catch-up, the runtime-replacement rejects),
 *   · the shader source contracts (the WGSL entry + the GLSL twin: the
 *     integer hash constants, the layout maps, the ES 3.00 reserved-word
 *     harvest).
 */

const RAMP = createRamp([
  { t: 0, size: 0.5, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 1, size: 0.2, r: 0.4, g: 0.6, b: 1, a: 0 },
])

// ── the parity model: the model IS the spawner (the strongest pin) ─────────

const SHAPE_DESCS: SpawnerDesc[] = [
  { shape: { kind: 'disc', origin: [0, -1.5, 0], axis: [0, 1, 0], radius: [2, 16] }, velocity: { mode: 'fixed', dir: [0.06, 1, 0.04] }, speed: [0.4, 1.4], life: [5, 11], size: [0.03, 0.1], color: [[1, 0.62, 0.22, 1], [1, 0.86, 0.4, 0.9]], seed: 417 },
  { shape: { kind: 'sphere', origin: [1, 2, 3], radius: [0.05, 0.5] }, velocity: { mode: 'radial' }, speed: [2.5, 5.5], life: [3, 5], size: [0.05, 0.12], color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]], seed: 991 },
  { shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 0] }, velocity: { mode: 'radial' }, speed: [1, 2], life: [1, 2], size: [0.1, 0.1], color: [[1, 1, 1, 1], [0, 0, 0, 1]], seed: 71 }, // the degenerate point → the scatter fallback
  { shape: { kind: 'cone', origin: [0, 0, 0], axis: [0.3, 1, -0.2], halfAngle: 0.35, baseRadius: 0.8, length: [0.2, 2.5] }, velocity: { mode: 'lobe' }, speed: [1, 3], life: [1, 4], size: [0.1, 0.3], color: [[1, 0, 0, 1], [0, 0, 1, 0.5]], seed: 77 },
  { shape: { kind: 'point', origin: [5, -2, 1] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0, 0], life: [100, 100], size: [1, 1], color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 1 },
  { shape: { kind: 'hemisphere', origin: [0, 0, 0], axis: [1, 0.2, 0], radius: [1, 4], arc: 2.0 }, velocity: { mode: 'tangential' }, speed: [1, 2], life: [2, 6], size: [0.2, 0.5], color: [[0.2, 1, 0.3, 1], [1, 1, 0, 0.2]], seed: 1234 },
  { shape: { kind: 'donut', origin: [0, 1, 0], axis: [0, 1, 0], radius: 5, tube: [0.1, 0.6], arc: 4.0 }, velocity: { mode: 'radial' }, speed: [0.5, 1.5], life: [2, 8], size: [0.1, 0.2], color: [[1, 0.5, 0, 1], [0.5, 0, 1, 1]], seed: 55 },
  { shape: { kind: 'rectangle', origin: [0, 0, 0], axis: [0, 0, 1], width: 4, height: 2 }, velocity: { mode: 'axis' }, speed: [1, 2], life: [1, 3], size: [0.1, 0.1], color: [[1, 1, 1, 1], [0, 0, 0, 1]], seed: 9 },
  { shape: { kind: 'grid', origin: [0, 0, 0], axis: [0, 1, 0], width: 10, height: 8, rows: 4, columns: 5 }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0.1, 0.9], life: [1, 5], size: [0.05, 0.15], color: [[0, 1, 1, 1], [1, 0, 0, 1]], seed: 31337 },
  { shape: { kind: 'line', from: [-3, 0, 0], to: [3, 1, 2] }, velocity: { mode: 'fixed', dir: [0, 1, 0] }, speed: [0.2, 2.2], life: [0.5, 3.5], size: [0.05, 0.25], color: [[1, 1, 1, 0.1], [1, 0.4, 0.1, 1]], seed: 606 },
  { shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 6], arms: 3, twist: 2.5, armSpread: 0.4 }, velocity: { mode: 'radial' }, speed: [0.5, 2], life: [2, 9], size: [0.1, 0.4], color: [[1, 1, 1, 1], [1, 0.8, 0.2, 0.6]], seed: 818 },
]

describe('Task 135 — the reference twin (gpuEmitRowModel vs the real spawner)', () => {
  const at = [10, -4, 2]
  const ev = [0.7, -0.3, 1.1]
  const k = 0.6
  const out: SpawnRecord = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0, tx: NaN, ty: NaN, tz: NaN }
  const row = new Float32Array(GPU_STATE_STRIDE)

  it('the model IS the spawner — bit-identical rows across every shape family (incl. the arms disc, the degenerate sphere scatter, the at()/inherit tail)', () => {
    for (const desc of SHAPE_DESCS) {
      const spawner = createSpawner(desc)
      const cfg = readGpuEmitConfig(desc)
      for (let i = 0; i < 300; i++) {
        const gi = 12345 + i
        spawner(gi, out)
        gpuEmitRowModel(cfg, gi, at, ev, k, row)
        // the emitWrap tail: the at() translation + the inherit velocity
        const px = out.x + at[0], py = out.y + at[1], pz = out.z + at[2]
        const vx = out.vx + ev[0] * k, vy = out.vy + ev[1] * k, vz = out.vz + ev[2] * k
        const exp = [px, py, pz, vx, vy, vz, 0, out.life, out.size, out.r, out.g, out.b, out.a, out.seed, px, py, pz]
        for (let f = 0; f < GPU_STATE_STRIDE; f++) {
          if (f >= 14 && f <= 16) continue // tx: the model writes the position (the store's NaN→position mapping)
          expect(Math.fround(row[f])).toBe(Math.fround(exp[f]))
        }
        // the life ledger twin: the same hash draw
        expect(gpuEmitLife(cfg, gi)).toBe(out.life)
      }
    }
  })

  it('the salt streams: the life hash matches hash01(seed, gi, 3) — the ledger and the kernel hash the SAME particle', () => {
    const cfg = readGpuEmitConfig(SHAPE_DESCS[0])
    for (let gi = 0; gi < 64; gi++) {
      expect(gpuEmitLife(cfg, gi)).toBe(5 + (11 - 5) * hash01(417, gi, GPU_EMIT_SALTS.life))
    }
  })
})

// ── the config interpretation (the flat spawner + the loud rejects) ────────

describe('Task 135 — readGpuEmitConfig (the flat spawner)', () => {
  it('rejects the non-closed-form constructs loudly (the honest v1 boundary)', () => {
    const base = {
      velocity: { mode: 'fixed' as const, dir: [0, 1, 0] },
      speed: [1, 2] as [number, number], life: [1, 2] as [number, number], size: [0.1, 0.2] as [number, number],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]], seed: 1,
    }
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'path', points: [0, 0, 0, 1, 1, 1], } } as never))
      .toThrow('rejects the path shape')
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'line' as const, from: [0, 0, 0], to: [1, 0, 0], mode: 'lattice' } }))
      .toThrow('rejects the line lattice')
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'grid' as const, origin: [0, 0, 0], axis: [0, 1, 0], width: 2, height: 2, rows: 2, columns: 2, mode: 'lattice' } }))
      .toThrow('rejects the grid lattice')
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] }, speedByRadius: { ref: 2, power: 1 } } as never))
      .toThrow('rejects speedByRadius')
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] }, colorByRadius: true } as never))
      .toThrow('rejects colorByRadius')
    expect(() => readGpuEmitConfig({ ...base, shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] }, target: { mode: 'point', point: [0, 0, 0] } } as never))
      .toThrow('rejects the seek target')
  })

  it('the discriminants: point=0 (the identity branch), the closed-form family 1..8; all five velocity modes', () => {
    const base = {
      velocity: { mode: 'fixed' as const, dir: [0, 1, 0] },
      speed: [1, 2] as [number, number], life: [1, 2] as [number, number], size: [0.1, 0.2] as [number, number],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]], seed: 1,
    }
    expect(readGpuEmitConfig({ ...base, shape: { kind: 'point' as const, origin: [1, 2, 3] } }).shapeKind).toBe(GPU_EMIT_SHAPE.point)
    expect(readGpuEmitConfig({ ...base, shape: { kind: 'point' as const, origin: [0, 0, 0] } }).shapeKind).toBe(0)
    expect(GPU_EMIT_SHAPE).toEqual({ point: 0, sphere: 1, cone: 2, disc: 3, hemisphere: 4, donut: 5, rectangle: 6, grid: 7, line: 8 })
    expect(GPU_EMIT_VEL).toEqual({ fixed: 1, radial: 2, axis: 3, tangential: 4, lobe: 5 })
    expect(readGpuEmitConfig({ ...base, shape: { kind: 'point' as const, origin: [0, 0, 0] }, velocity: { mode: 'radial' as const } }).velMode).toBe(GPU_EMIT_VEL.radial)
  })

  it('the orthonormal frame: the ±Y axis takes the (1,0,0) fallback, t2 = cross(axis, t1) — spawn.ts\'s own construction', () => {
    const base = { speed: [1, 2] as [number, number], life: [1, 2] as [number, number], size: [0.1, 0.2] as [number, number], color: [[1, 1, 1, 1], [1, 1, 1, 1]] as [number[], number[]], seed: 1 }
    const cfg = readGpuEmitConfig({ ...base, velocity: { mode: 'fixed' as const, dir: [0, 1, 0] }, shape: { kind: 'disc' as const, origin: [0, 0, 0], axis: [0, 1, 0], radius: [1, 2] as [number, number] } })
    expect(cfg.axis).toEqual([0, 1, 0])
    expect(cfg.t1).toEqual([1, 0, 0])
    expect(cfg.t2).toEqual([0, 0, -1])
    // a tilted axis: t1 = normalize(cross(axis, worldUp))
    const cfg2 = readGpuEmitConfig({ ...base, velocity: { mode: 'fixed' as const, dir: [0, 1, 0] }, shape: { kind: 'disc' as const, origin: [0, 0, 0], axis: [0.3, 1, -0.2], radius: [1, 2] as [number, number] } })
    const l = Math.hypot(0.3, 1, -0.2)
    const ax = 0.3 / l, ay = 1 / l, az = -0.2 / l
    const t1 = [-az, 0, ax]
    const tl = Math.hypot(...t1)
    expect(cfg2.t1).toEqual([t1[0] / tl, 0, t1[2] / tl])
    expect(cfg2.t2[0]).toBeCloseTo(ay * cfg2.t1[2] - az * cfg2.t1[1], 12)
    expect(cfg2.t2[1]).toBeCloseTo(az * cfg2.t1[0] - ax * cfg2.t1[2], 12)
    expect(cfg2.t2[2]).toBeCloseTo(ax * cfg2.t1[1] - ay * cfg2.t1[0], 12)
  })

  it('the uniform packer: the static half lands at the layout maps (the f32 + u32 views of one scratch)', () => {
    const cfg = readGpuEmitConfig(SHAPE_DESCS[0])
    const scratch = createGpuScratch(GPU_SIM_UNIFORM_FLOATS)
    const { f32, u32 } = scratch
    gpuEmitPackStatic(f32, u32, cfg)
    const U = GPU_EMIT_U32_FIELDS
    const V = GPU_EMIT_VEC4_FIELDS
    expect(GPU_EMIT_BASE).toBe(36) // after the force half (144 bytes — 16-aligned)
    expect(U.emitBase).toBe(36); expect(U.emitCount).toBe(37); expect(U.streamBase).toBe(38)
    expect(U.emitMask).toBe(39); expect(U.shapeKind).toBe(40); expect(U.velMode).toBe(41); expect(U.seed).toBe(42)
    expect(V.shapeOrigin).toBe(44); expect(V.atOrigin).toBe(48); expect(V.emitterV).toBe(108)
    expect(V.speed).toBe(92); expect(V.sizeInherit).toBe(96); expect(V.color0).toBe(100)
    // the packed values: the disc's frame + the ranges + the mask
    expect(u32[U.shapeKind]).toBe(GPU_EMIT_SHAPE.disc)
    expect(u32[U.velMode]).toBe(GPU_EMIT_VEL.fixed)
    expect(u32[U.seed]).toBe(417)
    expect(u32[U.emitMask]).toBe(GPU_EMIT_MASK.on)
    expect(f32[V.shapeOrigin]).toBe(0); expect(f32[V.shapeOrigin + 1]).toBe(-1.5)
    expect(f32[V.radius]).toBe(2); expect(f32[V.radius + 1]).toBe(16)
    expect(f32[V.speed]).toBe(Math.fround(0.4)); expect(f32[V.speed + 1]).toBe(Math.fround(1.4))
    expect(f32[V.speed + 2]).toBe(5); expect(f32[V.speed + 3]).toBe(11)
    expect(f32[V.sizeInherit]).toBe(Math.fround(0.03)); expect(f32[V.sizeInherit + 1]).toBe(Math.fround(0.1))
    expect(f32[V.color0]).toBe(1); expect(f32[V.color0 + 1]).toBe(Math.fround(0.62))
    expect(f32[V.cone]).toBe(0) // the disc does not use the cone block
    expect(V.emitterV + 4).toBe(GPU_SIM_UNIFORM_FLOATS) // the LAST field of the uniform
  })
})

// ── the facade's emit:'gpu' contract ───────────────────────────────────────

describe('Task 135 — the facade (emit:"gpu" — the life ledger + the window)', () => {
  function gpuEmitFacade(desc: Record<string, unknown> = {}) {
    const ps = createParticles({
      capacity: 512,
      rate: 400,
      spawner: SHAPE_DESCS[1],
      ramp: RAMP,
      forces: { gravity: [0, -2, 0], drag: 0.4 },
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
      emit: 'gpu',
      ...desc,
    })
    ps.gpuHandoff!.attached = true
    return ps
  }

  it('rejects emit:"gpu" without sim:"gpu" and the bad values', () => {
    expect(() => createParticles({ capacity: 8, render: { kind: 'billboard', draw: 'instance' }, emit: 'gpu' }))
      .toThrow('emit:"gpu" requires sim:"gpu"')
    expect(() => createParticles({ capacity: 8, render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu', emit: 'nonsense' } as never))
      .toThrow("emit must be 'cpu' or 'gpu'")
  })

  it('the handoff: the row scratch is NOT allocated (the GPU writes the rows); the window carries the hash domain', () => {
    const ps = gpuEmitFacade()
    expect(ps.emitGpu).toBe(true)
    expect(ps.spawnerDesc).toBe(SHAPE_DESCS[1])
    expect(ps.gpuHandoff!.emitRows.length).toBe(0)
    ps.advance(0.016)
    const ho = ps.gpuHandoff!
    expect(ho.emitCount).toBeGreaterThan(0)
    expect(ho.emitBase).toBe(0)
    expect(ho.emitStreamBase).toBe(0) // the first window starts at stream 0
    // the second frame: the window starts at the live count AND the stream base advanced by exactly the spawned
    const spawned1 = ps.stats().spawned
    ps.advance(0.016)
    expect(ho.emitBase).toBeGreaterThan(0)
    expect(ho.emitStreamBase).toBe(spawned1)
  })

  it('the life ledger: the mirror holds ONLY the death clock (hash-exact) — positions/velocities stay zero (GPU-authoritative)', () => {
    const ps = gpuEmitFacade()
    ps.advance(0.016)
    const cfg = readGpuEmitConfig(SHAPE_DESCS[1])
    const f = ps.fields
    const n = ps.count
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      expect(f.life[i]).toBe(Math.fround(gpuEmitLife(cfg, i))) // the SAME hash draw the kernel takes (the store f32-rounds the f64 lerp)
      expect(f.age[i]).toBe(Math.fround(0.016))
      expect(f.px[i]).toBe(0); expect(f.vx[i]).toBe(0) // the ledger, not the state
    }
  })

  it('the aging/retirement/compaction run EXACTLY (the ledger walk): the count mirrors the CPU tier, the swap list fires', () => {
    const ps = gpuEmitFacade({ rate: 0 })
    ps.burst(120)
    ps.advance(0.01)
    expect(ps.count).toBe(120)
    // life [3, 5] — after 3.2s of ledger aging, a slice of the 120 has died
    for (let i = 0; i < 320; i++) ps.advance(0.01)
    expect(ps.count).toBeLessThan(120)
    expect(ps.count).toBeGreaterThan(0)
    for (let i = 0; i < 400; i++) ps.advance(0.01) // past life[1]
    expect(ps.count).toBe(0)
  })

  it('the manual burst catch-up: a burst() between advances joins the NEXT window with the right hash domain', () => {
    const ps = gpuEmitFacade({ rate: 0 })
    ps.burst(50)
    ps.advance(0.016)
    expect(ps.gpuHandoff!.emitCount).toBe(50)
    const spawned = ps.stats().spawned
    ps.burst(30) // the manual burst AFTER the advance
    expect(ps.gpuHandoff!.emitCount).toBe(50) // the handoff is not stale — the NEXT advance re-gathers
    ps.advance(0.016)
    const ho = ps.gpuHandoff!
    expect(ho.emitBase).toBe(50) // the post-walk count
    expect(ho.emitCount).toBe(30)
    expect(ho.emitStreamBase).toBe(spawned) // the hash domain continues
  })

  it('rejects the runtime spawner replacement and orient() (the static interpretation is packed at attach)', () => {
    const ps = gpuEmitFacade()
    expect(() => ps.rate(300, SHAPE_DESCS[2])).toThrow('not supported with emit:"gpu"')
    expect(() => ps.burst(10, SHAPE_DESCS[2])).toThrow('not supported with emit:"gpu"')
    expect(() => ps.orient([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])).toThrow('not supported with emit:"gpu"')
    expect(() => ps.orient(null)).not.toThrow() // resetting to identity is always fine
    expect(() => ps.rate(300)).not.toThrow() // the RATE alone is free
    expect(() => ps.burst(10)).not.toThrow() // a burst through the CURRENT spawner is the normal path
  })

  it('the ledger survives a clear() (the window and the stream mark reset)', () => {
    const ps = gpuEmitFacade({ rate: 0 })
    ps.advance(0.016)
    ps.clear()
    const ho = ps.gpuHandoff!
    expect(ho.emitBase).toBe(0); expect(ho.emitCount).toBe(0); expect(ho.emitStreamBase).toBe(0)
    ps.burst(20)
    ps.advance(0.016)
    expect(ho.emitCount).toBe(20)
    expect(ho.emitStreamBase).toBe(0) // the stream index does NOT reset (the uniqueness contract) — the window's base is the CURRENT stream
  })
})

// ── the shader source contracts (the WGSL entry + the GLSL twin) ───────────

describe('Task 135 — the WGSL emit entry (gpuSimWgsl)', () => {
  it('the uniform grew to 448 bytes (112 floats — the emit block after the 36-float force half), four entries', () => {
    expect(GPU_SIM_UNIFORM_BYTES).toBe(448)
    expect(GPU_SIM_UNIFORM_FLOATS).toBe(112)
    expect(GPU_SIM_ENTRIES).toEqual(['emit', 'compact', 'advance', 'pack'])
  })

  it('the entry: the hash constants (the @rune/core hash01 twin), the window guard, the salt streams, the row writes', () => {
    const wgsl = gpuSimWgsl()
    expect(wgsl).toContain('fn emit(')
    expect(wgsl).toContain('fn hash01f(seed : u32, index : u32, salt : u32) -> f32')
    // the Wang hash constants — bit-portable Math.imul twins
    expect(wgsl).toContain('374761393u')
    expect(wgsl).toContain('668265263u')
    expect(wgsl).toContain('2246822519u')
    expect(wgsl).toContain('1274126177u')
    expect(wgsl).toContain('h ^ (h >> 13u)')
    expect(wgsl).toContain('h ^ (h >> 16u)')
    // the window + the hash domain
    expect(wgsl).toContain('let slot = P.emitBase + i;')
    expect(wgsl).toContain('let gi = P.streamBase + i;')
    expect(wgsl).toContain('if (i >= P.emitCount) { return; }')
    expect(wgsl).toContain('(P.emitMask & 1u) == 0u')
    // the emit block's struct fields
    expect(wgsl).toContain('emitBase : u32')
    expect(wgsl).toContain('streamBase : u32')
    expect(wgsl).toContain('shapeOrigin : vec4<f32>')
    expect(wgsl).toContain('emitterV : vec4<f32>')
    // the age-zero birth + the inherit tail
    expect(wgsl).toContain('state[b + 6u] = 0.0;')
    expect(wgsl).toContain('dx * spd + P.emitterV.x * k')
    // the salts (the decorrelated streams — spawn.ts's own)
    for (const salt of [GPU_EMIT_SALTS.dir, GPU_EMIT_SALTS.spd, GPU_EMIT_SALTS.life, GPU_EMIT_SALTS.size, GPU_EMIT_SALTS.col, GPU_EMIT_SALTS.seed, GPU_EMIT_SALTS.p0, GPU_EMIT_SALTS.p1, GPU_EMIT_SALTS.p2, GPU_EMIT_SALTS.scat0, GPU_EMIT_SALTS.scat1]) {
      expect(wgsl).toContain(`hash01f(sd, gi, ${salt}u)`)
    }
    expect(wgsl).toContain(`hash01f(sd, gi, ${GPU_EMIT_SALTS.dir + 100}u)`)
  })

  it('the shape discriminants: all eight closed-form branches + the velocity modes (the model\'s own structure)', () => {
    const wgsl = gpuSimWgsl()
    for (let k = 1; k <= 8; k++) expect(wgsl).toContain(`P.shapeKind == ${k}u`)
    for (let m = 2; m <= 4; m++) expect(wgsl).toContain(`P.velMode == ${m}u`) // radial/axis/tangential override; fixed/lobe keep
    // the degenerate radial scatter (Task 124's fix, ported)
    expect(wgsl).toContain('hash01f(sd, gi, 11u)')
    expect(wgsl).toContain('hash01f(sd, gi, 12u)')
  })
})

describe('Task 135 — the GLSL emit twin (gpuSimGlEmitGlsl)', () => {
  it('the uniforms: the packed layout matches GPU_GL_EMIT_F (the halves reconstruction of the 32-bit hash domain)', () => {
    const glsl = gpuSimGlEmitGlsl()
    expect(glsl).toContain('#version 300 es')
    // the hash — the same Wang constants in uint
    expect(glsl).toContain('uint h = sd * 374761393u + gi * 668265263u + salt * 2246822519u;')
    expect(glsl).toContain('(h ^ (h >> 13u)) * 1274126177u')
    // the halves: the stream index and the seed recombine in uint, PLUS the
    // window-local vertex index (gi = streamBase + i — the WGSL twin's own)
    expect(glsl).toContain('uint gi = uint(gl_VertexID) + ((uint(u_streamHi + 0.5) << 16u) | uint(u_streamLo + 0.5));')
    expect(glsl).toContain('uint sd = (uint(u_seedHi + 0.5) << 16u) | uint(u_seedLo + 0.5);')
    // the five TF outputs — the SAME 20-float state row the advance pass writes
    expect(glsl).toContain('out vec4 v_s0;')
    expect(glsl).toContain('out vec4 v_s4;')
    expect(glsl).toContain('vec3 w = p + u_atOrigin;')
    expect(glsl).toContain('vec3 vel = d * spd + u_emitterV * u_sizeInherit.z;')
    expect(glsl).toContain('v_s1 = vec4(vel.y, vel.z, 0.0, life);')
    // the ES 3.00 reserved-word harvest (Task 132's class: flat/half)
    expect(glsl).not.toMatch(/\bflat\b/)
    expect(glsl).not.toMatch(/\bhalf\b/)
    // the uniform declaration list matches the field map's arithmetic
    let floats = 0
    for (const u of GPU_GL_EMIT_UNIFORMS) floats += u.size
    expect(GPU_GL_EMIT_F.emitterV + 3).toBe(floats)
    expect(GPU_GL_EMIT_F.emitBase).toBe(0)
    expect(GPU_GL_EMIT_F.streamLo).toBe(2)
    expect(GPU_GL_EMIT_F.shapeOrigin).toBe(8)
    expect(GPU_GL_EMIT_F.radius).toBe(29)
    expect(GPU_GL_EMIT_F.color1).toBe(60)
  })

  it('the generation body: the same branches, the same salts, the same tail', () => {
    const glsl = gpuSimGlEmitGlsl()
    for (let k = 1; k <= 8; k++) expect(glsl).toContain(`shapeKind == ${k}`)
    expect(glsl).toContain('velMode == 2')
    expect(glsl).toContain('velMode == 4')
    expect(glsl).toContain('hash01f(sd, gi, 3u)') // the life salt
    expect(glsl).toContain('hash01f(sd, gi, 101u)') // the second direction draw
    expect(glsl).toContain('gl_Position = vec4(0.0, 0.0, 0.5, 1.0);') // never rasterized
  })
})
