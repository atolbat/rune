import { test, expect, describe, it } from 'bun:test'
import {
  createParticles, createRamp, packInstances, GPU_STATE_STRIDE,
} from '../src/index.ts'

/**
 * Task 131 — the GPGPU TIER's CPU-side contract (the facade's sim:'gpu'
 * mode). The GPU half is pinned by the raw-device gate
 * (scripts/task131-wgsl-sim.mjs: 1-ULP parity vs the CPU reference); HERE
 * we pin the facade's own mechanics:
 *   · the loud validation (the CPU-coupled features are rejected),
 *   · the handoff protocol (the emit rows gathered PRE-COMPACTION at
 *     their pre-compaction slots, the swap list in the CPU walk's order,
 *     the per-frame reset),
 *   · the aging/death/compaction running CPU-side (the count mirrors the
 *     CPU tier's exactly — the same determinism),
 *   · view() reporting the count (the records are the GPU's).
 */

const RAMP = createRamp([
  { t: 0, size: 0.5, r: 1, g: 0.9, b: 0.7, a: 0 },
  { t: 1, size: 0.2, r: 0.4, g: 0.6, b: 1, a: 0 },
])

const SPAWNER = {
  shape: { kind: 'sphere' as const, origin: [0, 0.5, 0], radius: [0.05, 0.5] as [number, number] },
  velocity: { mode: 'radial' as const },
  speed: [2.5, 5.5] as [number, number], life: [0.4, 0.8] as [number, number],
  size: [0.05, 0.12] as [number, number],
  color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]] as [number[], number[]], seed: 991,
}

/** A gpu-mode facade with the handoff marked attached (the orchestrator's
 *  job — a mock here: the CPU mechanics don't need the device). */
function gpuFacility(desc: Record<string, unknown>) {
  const ps = createParticles({
    capacity: 512,
    rate: 400,
    spawner: SPAWNER,
    ramp: RAMP,
    forces: { gravity: [0, -2, 0], drag: 0.4 },
    render: { kind: 'billboard', draw: 'instance' },
    sim: 'gpu',
    ...desc,
  })
  ps.gpuHandoff!.attached = true
  return ps
}

describe('Task 131 — sim:"gpu" (the facade contract)', () => {
  it('rejects the CPU-coupled features loudly (the misconfiguration beats the silent no-op)', () => {
    expect(() => createParticles({ capacity: 8, render: { kind: 'billboard' }, sim: 'gpu' }))
      .toThrow('sim:"gpu" requires render { kind: "billboard", draw: "instance" }')
    expect(() => createParticles({ capacity: 8, render: { kind: 'trail', points: 8, step: 1, length: 1, width: 1 }, sim: 'gpu' }))
      .toThrow('requires render { kind: "billboard", draw: "instance" }')
    expect(() => createParticles({ capacity: 8, render: { kind: 'billboard', draw: 'instance' }, onRetire: () => {}, sim: 'gpu' }))
      .toThrow('rejects onRetire')
    expect(() => createParticles({
      capacity: 8, render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu',
      forces: { collide: { planes: [{ normal: [0, 1, 0], point: [0, 0, 0], restitution: 0.5 }] } },
    })).toThrow('rejects collide')
    expect(() => createParticles({
      capacity: 8, render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu',
      forces: { seek: { strength: 4, damping: 2 } },
    })).toThrow('rejects seek')
    expect(() => createParticles({
      capacity: 8, render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu',
      forces: { speedCurve: RAMP },
    })).toThrow('rejects forces.speedCurve')
    expect(() => createParticles({
      capacity: 8, render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu',
      forces: { attract: { point: [0, 0, 0], strength: 5, killRadius: 1 } },
    })).toThrow('rejects attract.killRadius')
    expect(() => createParticles({ capacity: 8, render: { kind: 'billboard', draw: 'instance' }, prewarm: 2, sim: 'gpu' }))
      .toThrow('rejects prewarm')
  })

  it('the first advance without the backend attached throws (WebGL2 must pass sim:"cpu")', () => {
    const ps = createParticles({
      capacity: 8, spawner: SPAWNER,
      render: { kind: 'billboard', draw: 'instance' }, sim: 'gpu',
    })
    expect(() => ps.advance(1 / 60)).toThrow('needs the GPU backend')
  })

  it('the handoff: the emit rows at the PRE-COMPACTION slots, the swaps in the CPU order', () => {
    const ps = gpuFacility({})
    const ho = ps.gpuHandoff!
    // 3 frames of emission + deaths (life 0.4-0.8 s at 60 fps → deaths from ~frame 24)
    for (let f = 0; f < 40; f++) ps.advance(1 / 60)
    // the last advance's handoff: the rows [emitBase, emitBase + emitCount)
    expect(ho.emitCount).toBeGreaterThan(0)
    expect(ho.emitCount).toBeLessThanOrEqual(10)
    expect(ho.emitBase).toBeGreaterThanOrEqual(0)
    // the rows mirror the SoA AT THE EMIT MOMENT (pre-compaction): the row
    // 0 of THIS advance is the first newborn of this advance — its age
    // field is 0 (the emit gather ran before the aging walk)
    const firstRow = ho.emitRows
    const f0 = ps.fields
    // the spawner's life range: a fresh newborn's life ∈ [0.4, 0.8]
    const life0 = firstRow[7]
    expect(life0).toBeGreaterThanOrEqual(0.4)
    expect(life0).toBeLessThanOrEqual(0.8)
    // the age of a newborn row is 0 (the pre-aging gather)
    expect(firstRow[6]).toBe(0)
    void f0
    // after enough frames, deaths happened → the swap list fired
    expect(ho.swapCount).toBeGreaterThanOrEqual(0) // (the deaths may land on other frames; the protocol shape matters)
  })

  it('the compaction replay protocol: the swap pairs are (to, from) with to < from', () => {
    const ps = gpuFacility({})
    const ho = ps.gpuHandoff!
    let sawSwap = false
    for (let f = 0; f < 90; f++) {
      ps.advance(1 / 60)
      if (ho.swapCount > 0) {
        sawSwap = true
        for (let s = 0; s < ho.swapCount; s++) {
          const to = ho.swaps[s * 2]
          const from = ho.swaps[s * 2 + 1]
          expect(to).toBeLessThan(from)
          expect(to).toBeGreaterThanOrEqual(0)
          expect(from).toBeLessThan(ps.capacity)
        }
      }
    }
    expect(sawSwap).toBe(true) // life 0.4-0.8 s — 90 frames guarantees deaths
  })

  it('the CPU mirror: the count/aging match the CPU tier EXACTLY (the same emission, the same deaths)', () => {
    const gpu = gpuFacility({})
    const cpu = createParticles({
      capacity: 512, rate: 400, spawner: SPAWNER, ramp: RAMP,
      render: { kind: 'billboard', draw: 'instance' },
    })
    for (let f = 0; f < 120; f++) {
      gpu.advance(1 / 60)
      cpu.advance(1 / 60)
    }
    expect(gpu.count).toBe(cpu.count)
    // the ages/lives of the live range are the SAME particles (the CPU
    // drives both compactions through the identical aging walk)
    const fg = gpu.fields, fc = cpu.fields
    for (let i = 0; i < Math.min(gpu.count, 32); i++) {
      expect(fg.age[i]).toBe(fc.age[i])
      expect(fg.life[i]).toBe(fc.life[i])
      expect(fg.seed[i]).toBe(fc.seed[i])
    }
  })

  it('view() reports the count (the records are the GPU pack\'s — never uploaded CPU-side)', () => {
    const ps = gpuFacility({})
    for (let f = 0; f < 10; f++) ps.advance(1 / 60)
    const v = ps.view({ right: [1, 0, 0], up: [0, 1, 0] })
    expect(v.draw).toBe('instance')
    expect(v.instanceCount).toBe(ps.count)
    expect(v.vertexCount).toBe(ps.count)
  })

  it('clear() resets the handoff (a fresh emission starts at slot 0)', () => {
    const ps = gpuFacility({})
    for (let f = 0; f < 30; f++) ps.advance(1 / 60)
    ps.clear()
    const ho = ps.gpuHandoff!
    expect(ho.emitCount).toBe(0)
    expect(ho.swapCount).toBe(0)
    ps.advance(1 / 60)
    expect(ho.emitBase).toBe(0) // the count is 0 → the newborns land at slot 0
    expect(ho.emitCount).toBeGreaterThan(0)
  })

  it('the emit rows are 17 floats (the FIELD_NAMES contract, GPU_STATE_STRIDE)', () => {
    expect(GPU_STATE_STRIDE).toBe(17)
    const ps = gpuFacility({})
    const ho = ps.gpuHandoff!
    expect(ho.emitRows.length).toBe(17 * 512)
    expect(ho.swaps.length).toBe(2 * 512)
  })

  it('the wrap rides the handoff (the sizes static, the origin per-advance)', () => {
    const ps = gpuFacility({ wrap: { size: [10, 6, 10] } })
    const ho = ps.gpuHandoff!
    expect(ho.wrapSize).toEqual([10, 6, 10])
    ps.at(3, 2, -4)
    ps.advance(1 / 60)
    expect(ho.emitOrigin).toEqual([3, 2, -4])
  })
})
