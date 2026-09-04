/**
 * Task 130 — the line LATTICE: the continuous-beam primitive. A hash-random
 * line burst at a sparse rate reads as a DASHED train of blobs (the laser
 * demo's "the beam is discrete — many projectiles flying in a row" report);
 * the lattice maps the call index → station (u = (i % count + 0.5) / count)
 * so one burst of `count` particles covers the WHOLE segment gap-free, and
 * a from/to that changes every burst keeps the coverage live.
 */

import { describe, expect, it } from 'bun:test'
import { createParticles } from '../src/index.ts'
import type { SpawnerDesc } from '../src/index.ts'

/** A lattice line spawner on the X axis (overridable shape bits). */
const lat = (over: Record<string, unknown> = {}, from: readonly number[] = [0, 0, 0], to: readonly number[] = [4, 0, 0]): SpawnerDesc => ({
  shape: { kind: 'line', from, to, mode: 'lattice', spacing: 0.25, ...over } as SpawnerDesc['shape'],
  velocity: { mode: 'fixed', dir: [0, 1, 0] },
  speed: [0, 0],
  life: [10, 10],
  size: [1, 1],
  color: [[1, 1, 1, 1], [1, 1, 1, 1]],
  seed: 7,
})

describe('Task 130: the line lattice — the continuous-beam primitive', () => {
  it('one burst of `count` particles covers the WHOLE line gap-free (every station exactly once)', () => {
    // from (0,0,0) to (4,0,0), spacing 0.25 → count = round(4/0.25) = 16
    const p = createParticles({ capacity: 32, rate: 0, spawner: lat() })
    p.burst(16)
    expect(p.count).toBe(16)
    const xs = [...p.fields.px.slice(0, 16)].sort((a, b) => a - b)
    // the stations: (i + 0.5)/16 × 4 — every one exactly once, max gap 0.25
    for (let i = 0; i < 16; i++) expect(xs[i]).toBeCloseTo(((i + 0.5) / 16) * 4, 6)
    for (let i = 1; i < 16; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(0.25, 6)
    for (let i = 0; i < 16; i++) {
      expect(p.fields.py[i]).toBe(0)
      expect(p.fields.pz[i]).toBe(0)
    }
  })

  it('a cyclic shift of the global stream still covers every station (bursts are phase-agnostic)', () => {
    // 7 particles first (the stream index lands mid-cycle), then the full 16 —
    // the second burst's indices are 7..22 → (i % 16) wraps, all stations hit.
    const p = createParticles({ capacity: 64, rate: 0, spawner: lat() })
    p.burst(7)
    p.burst(16)
    const xs = [...p.fields.px.slice(7, 23)].sort((a, b) => a - b)
    const seen = new Set(xs.map(x => Math.round(x * 1000)))
    expect(seen.size).toBe(16) // all 16 distinct stations, none missed
    for (let i = 0; i < 16; i++) expect(seen.has(Math.round(((i + 0.5) / 16) * 4 * 1000))).toBe(true)
  })

  it('a burst of 2×count covers the line TWICE (the wrap, not a drift past the end)', () => {
    const p = createParticles({ capacity: 64, rate: 0, spawner: lat({ count: 8 }) })
    p.burst(16)
    expect(p.count).toBe(16)
    // sorted, the pairs sit adjacent: [s0, s0, s1, s1, …]
    const xs = [...p.fields.px.slice(0, 16)].sort((a, b) => a - b)
    for (let i = 0; i < 8; i++) {
      expect(xs[2 * i]).toBeCloseTo(xs[2 * i + 1], 6) // each station exactly twice
      expect(xs[2 * i]).toBeCloseTo(((i + 0.5) / 8) * 4, 6)
    }
    expect(xs[15]).toBeLessThanOrEqual(4) // nothing drifted past the end
  })

  it('`count` overrides `spacing`; `spacing` derives count from the CURRENT length', () => {
    const a = createParticles({ capacity: 8, rate: 0, spawner: lat({ count: 5 }) })
    a.burst(5)
    const xs = [...a.fields.px.slice(0, 5)].sort((x, y) => x - y)
    for (let i = 0; i < 5; i++) expect(xs[i]).toBeCloseTo(((i + 0.5) / 5) * 4, 6)
    // a shorter live segment: from (0,0,0) to (1,0,0), spacing 0.2 → count 5
    const b = createParticles({ capacity: 8, rate: 0, spawner: lat({ spacing: 0.2 }, [0, 0, 0], [1, 0, 0]) })
    b.burst(5)
    const ys = [...b.fields.px.slice(0, 5)].sort((x, y) => x - y)
    for (let i = 0; i < 5; i++) expect(ys[i]).toBeCloseTo((i + 0.5) / 5, 6)
  })

  it('the LIVE from/to re-burst: the spawner override recomputes the stations for the NEW segment', () => {
    // the beam pattern: burst through a spawner override whose from/to moves
    // every call — the lattice re-derives count and covers the new segment.
    const S: SpawnerDesc = lat({ spacing: 0.5 }, [0, 0, 0], [4, 0, 0])
    const p = createParticles({ capacity: 64, rate: 0, spawner: S })
    // the live override: a segment twice as long → count doubles to 16
    p.burst(16, { ...S, shape: { kind: 'line', from: [2, 1, 0], to: [10, 1, 0], mode: 'lattice', spacing: 0.5 } })
    expect(p.count).toBe(16)
    const xs = [...p.fields.px.slice(0, 16)].sort((a, b) => a - b)
    for (let i = 0; i < 16; i++) {
      expect(xs[i]).toBeCloseTo(2 + ((i + 0.5) / 16) * 8, 6)
      expect(p.fields.py[i]).toBe(1)
      expect(p.fields.pz[i]).toBe(0)
    }
  })

  it('deterministic: the same desc → the same stations, burst after burst', () => {
    const a = createParticles({ capacity: 16, rate: 0, spawner: lat() })
    const b = createParticles({ capacity: 16, rate: 0, spawner: lat() })
    a.burst(16)
    b.burst(16)
    expect([...a.fields.px.slice(0, 16)]).toEqual([...b.fields.px.slice(0, 16)])
  })

  it("'random' (the default) is untouched: hash positions, not stations", () => {
    const S: SpawnerDesc = {
      shape: { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [10, 10], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 7,
    }
    const p = createParticles({ capacity: 16, rate: 0, spawner: S })
    p.burst(16)
    // NOT the station set (probability ~0), and all within [0, 4]
    const station = new Set([0.125, 0.375, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875,
      2.125, 2.375, 2.625, 2.875, 3.125, 3.375, 3.625, 3.875])
    let hits = 0
    for (let i = 0; i < 16; i++) {
      const x = p.fields.px[i]
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(4)
      if (station.has(Math.round(x * 1000) / 1000)) hits++
    }
    expect(hits).toBeLessThan(16) // a hash draw, not the lattice
  })

  it('validation: a bad spacing/count throws honest errors', () => {
    const mk = (over: Record<string, unknown>) => createParticles({
      capacity: 1, rate: 0, spawner: lat(over),
    })
    expect(() => mk({ spacing: 0 })).toThrow(/spacing must be a finite > 0/)
    expect(() => mk({ spacing: -1 })).toThrow(/spacing must be a finite > 0/)
    expect(() => mk({ spacing: NaN })).toThrow(/spacing must be a finite > 0/)
    expect(() => mk({ count: 0 })).toThrow(/count must be an integer >= 1/)
    expect(() => mk({ count: 2.5 })).toThrow(/count must be an integer >= 1/)
    // a degenerate line still throws (the axis validation path)
    expect(() => createParticles({
      capacity: 1, rate: 0,
      spawner: lat({}, [1, 1, 1], [1, 1, 1]),
    })).toThrow(/non-zero vector/)
  })
})
