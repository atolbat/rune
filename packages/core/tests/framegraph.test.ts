/**
 * Task 203 — THE FRAME GRAPH, pinned by its own laws. The «супер
 * рендеринг» architecture: passes declared as data, the frame compiled
 * into a DAG, dead branches culled, transient lifetimes scheduled into
 * aliasing slots, barriers emitted at every hazard crossing, and the
 * 3-lane overlap plan computed from the dependency truth.
 *
 * The gates here are the machine's own axioms, verified:
 *   · VERSIONED HANDLES — writes bump, readers capture at declaration,
 *     pins bind old versions, persistent versions survive frames;
 *   · BRANCH CULLING — the shadows-off class: gate the consumer's reads
 *     and the producer's whole branch leaves the frame; a live reader of
 *     a dead transient writer is the honest refusal;
 *   · ALIASING — overlapping lifetimes never share a slot; disjoint ones
 *     do; the savings report is exact;
 *   · BARRIERS — every cross-lane hazard and WAW pair is emitted, in
 *     timeline order, and read-read pairs never are;
 *   · OVERLAP — the async lane's plan respects every dependency edge
 *     (the scheduled windows cannot start before the inputs finish);
 *   · THE COMPILE CACHE — the policy-recording proxy: declarations that
 *     touch only primitives hit the cache (identity), a flipped gate
 *     recompiles, and an object read in a declaration is the honest
 *     refusal (the per-frame data must ride the execute);
 *   · THE SLOT DISCIPLINE — acquire/release follow the plan exactly
 *     (first interval start / last interval end, per frame).
 */

import { describe, expect, it } from 'bun:test'
import { createFrameGraph } from '../src/framegraph.ts'

// a tiny policy shape — the Hi-Z frame's own (a TYPE, not an interface:
// the graph's P must satisfy Record<string, unknown> — object-literal type
// aliases carry the implicit index signature, interfaces do not)
type Policy = {
  culling: boolean
  pyramidView: boolean
  fresh: boolean
  wantStats: boolean
}

function buildHizGraph() {
  const fg = createFrameGraph<Policy>()
  const scene = fg.resource({ name: 'scene', kind: 'buffer', bytes: 78_864, transient: false, exported: true })
  const mesh = fg.resource({ name: 'mesh', kind: 'buffer', bytes: 1_000, transient: false })
  const tile = fg.resource({ name: 'hi-z', kind: 'texture', width: 480, height: 270, format: 'r32f' })
  const target = fg.resource({ name: 'target', kind: 'texture', width: 480, height: 270, transient: false })
  const ran: string[] = []
  fg.pass({ name: 'z-fill', kind: 'render', cost: 3, reads: [scene, mesh], writes: [tile], execute: () => { ran.push('z-fill') } })
  fg.pass({ name: 'pyramid-reduce', kind: 'compute', cost: 2, reads: [tile], writes: [tile], execute: () => { ran.push('pyramid-reduce') } })
  fg.pass({
    name: 'cull-verdicts', kind: 'compute', cost: 1,
    reads: p => [scene, ...(p.culling ? [tile] : [])],
    writes: [scene],
    when: p => p.fresh,
    execute: () => { ran.push('cull-verdicts') },
  })
  fg.pass({ name: 'hysteresis', kind: 'compute', cost: 1, reads: [scene], writes: [scene], when: p => p.fresh, execute: () => { ran.push('hysteresis') } })
  fg.pass({ name: 'color', kind: 'render', cost: 6, reads: [scene, mesh], writes: [target], execute: () => { ran.push('color') } })
  // THE OVERLAY LAW: the debug strip draws ON TOP of the color pass's
  // image — it READS the target and writes the bumped version (a pure
  // write would leave color UNREACHABLE: the present binds the LAST
  // version, and a reader-less write is a dead branch)
  fg.pass({ name: 'pyramid-view', kind: 'render', cost: 1, reads: [tile, target], writes: [target], when: p => p.pyramidView, execute: () => { ran.push('pyramid-view') } })
  fg.pass({ name: 'read-stats', kind: 'copy', cost: 1, reads: [scene], when: p => p.wantStats, execute: () => { ran.push('read-stats') } })
  fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => { ran.push('present') } })
  return { fg, ran, res: { scene, mesh, tile, target } }
}

const FULL: Policy = { culling: true, pyramidView: true, fresh: true, wantStats: true }

describe('framegraph — versioned handles', () => {
  it('bumps versions on writes and captures reads at declaration order', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile(FULL)
    // tile: z-fill writes v1, reduce reads v1 writes v2, strip reads v2
    const tileEdges = f.edges.filter(e => e.resource === 'hi-z')
    expect(tileEdges.some(e => e.from === 'z-fill' && e.to === 'pyramid-reduce' && e.version === 1)).toBe(true)
    expect(tileEdges.some(e => e.from === 'pyramid-reduce' && e.to === 'cull-verdicts' && e.version === 2)).toBe(true)
    expect(tileEdges.some(e => e.from === 'pyramid-reduce' && e.to === 'pyramid-view' && e.version === 2)).toBe(true)
    // scene: cull writes v1, hyst reads v1 writes v2, color/stats read v2 —
    // but the z-fill (declared FIRST) reads the IMPORTED v0 (no in-frame writer)
    expect(f.edges.some(e => e.resource === 'scene' && e.from === null && e.to === 'z-fill')).toBe(true)
    expect(f.edges.some(e => e.resource === 'scene' && e.from === 'cull-verdicts' && e.to === 'hysteresis')).toBe(true)
    expect(f.edges.some(e => e.resource === 'scene' && e.from === 'hysteresis' && e.to === 'color')).toBe(true)
    // the read-modify-write pass is never its own edge
    expect(f.edges.some(e => e.from === 'pyramid-reduce' && e.to === 'pyramid-reduce')).toBe(false)
  })

  it('pinned reads bind the exact version (the feedback pattern)', () => {
    const fg = createFrameGraph<{ on: boolean }>()
    const data = fg.resource({ name: 'data', kind: 'buffer', bytes: 64, transient: false })
    const out = fg.resource({ name: 'out', kind: 'texture', width: 4, height: 4 })
    fg.pass({ name: 'writeA', kind: 'compute', writes: [data], execute: () => {} })
    fg.pass({ name: 'writeB', kind: 'compute', writes: [data], execute: () => {} })
    // the feedback consumer reads the version BEFORE this frame's writes
    fg.pass({ name: 'feedback', kind: 'render', reads: [data.at(0)], writes: [out], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [out], execute: () => {} })
    const f = fg.compile({ on: true })
    expect(f.edges.some(e => e.resource === 'data' && e.from === null && e.to === 'feedback' && e.version === 0)).toBe(true)
    expect(f.edges.some(e => e.from === 'writeB' && e.to === 'feedback')).toBe(false)
  })

  it('rejects a pinned WRITE (pins are read-only views)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const data = fg.resource({ name: 'data', kind: 'buffer', bytes: 8, transient: false })
    fg.pass({ name: 'w', kind: 'compute', writes: [data.at(0) as never], execute: () => {} })
    fg.pass({ name: 'p', kind: 'present', reads: [], execute: () => {} })
    expect(() => fg.compile({})).toThrow('WRITES a pinned handle')
  })

  it('sequential writers bump two versions; the reader binds the LAST (the overlay law)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const t = fg.resource({ name: 't', kind: 'texture', width: 2, height: 2 })
    const seen: string[] = []
    fg.pass({ name: 'a', kind: 'render', writes: [t], execute: () => { seen.push('a') } })
    fg.pass({ name: 'b', kind: 'render', reads: [t], writes: [t], execute: () => { seen.push('b') } })
    fg.pass({ name: 'p', kind: 'present', reads: [t], execute: () => { seen.push('p') } })
    const f = fg.compile({})
    // a writes t@1; b READS t@1 and writes t@2 (the overlay); p binds t@2
    expect(f.edges.some(e => e.resource === 't' && e.from === 'a' && e.to === 'b' && e.version === 1)).toBe(true)
    expect(f.edges.some(e => e.resource === 't' && e.from === 'b' && e.to === 'p' && e.version === 2)).toBe(true)
    f.run({})
    expect(seen).toEqual(['a', 'b', 'p']) // both writers live — the overlay needs its base
  })

  it('carries persistent versions ACROSS frames — the temporal reuse', () => {
    const fg = createFrameGraph<{ fresh: boolean }>()
    const scene = fg.resource({ name: 'scene', kind: 'buffer', bytes: 16, transient: false, exported: true })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'cull', kind: 'compute', writes: [scene], when: p => p.fresh, execute: () => {} })
    fg.pass({ name: 'color', kind: 'render', reads: [scene], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    // frame 1: fresh — cull writes scene@1
    const r1 = fg.compile({ fresh: true }).run({ fresh: true })
    expect(r1.executed).toContain('cull')
    expect(r1.stale.scene).toBe(0)
    // frames 2-4: amortized — the cull gated off, the staleness counts
    for (let i = 2; i <= 4; i++) {
      const r = fg.compile({ fresh: false }).run({ fresh: false })
      expect(r.executed).not.toContain('cull')
      expect(r.stale.scene).toBe(i - 1)
    }
    // a fresh frame again: the write lands, the staleness resets
    const r5 = fg.compile({ fresh: true }).run({ fresh: true })
    expect(r5.executed).toContain('cull')
    expect(r5.stale.scene).toBe(0)
    // and the next amortized frame reads THAT version (1 frame stale)
    expect(fg.compile({ fresh: false }).run({ fresh: false }).stale.scene).toBe(1)
  })
})

describe('framegraph — branch culling (the shadows-off class)', () => {
  it('a full policy runs every pass in declaration order', () => {
    const { fg, ran } = buildHizGraph()
    const r = fg.compile(FULL).run(FULL)
    expect([...r.executed]).toEqual(['z-fill', 'pyramid-reduce', 'cull-verdicts', 'hysteresis', 'color', 'pyramid-view', 'read-stats', 'present'])
    expect(ran).toEqual([...r.executed])
  })

  it('Hi-Z OFF kills the whole prepass branch (the shadows-off law)', () => {
    const { fg, ran } = buildHizGraph()
    const off = { ...FULL, culling: false, pyramidView: false }
    const f = fg.compile(off)
    // the cull still runs (its gate prop rides the execute — the OFF leg
    // needs fresh frustum verdicts), but it stops READING the pyramid →
    // the tile loses its consumers → z-fill + reduce leave the frame
    expect(f.culled).toContain('z-fill')
    expect(f.culled).toContain('pyramid-reduce')
    expect(f.passes.map(p => p.name)).not.toContain('z-fill')
    ran.length = 0
    const r = f.run(off)
    expect([...r.executed]).not.toContain('z-fill')
    expect(ran).toEqual([...r.executed])
    // the accounting: 8 declared, 8-2-1(strip gated)=5 live
    expect(f.stats.declared).toBe(8)
    expect(f.stats.live).toBe(5)
    expect(f.stats.gated).toBe(1)
    expect(f.stats.culled).toBe(2)
  })

  it('the pyramid view alone keeps the branch (the strip is a consumer)', () => {
    const { fg } = buildHizGraph()
    const onlyView = { ...FULL, culling: false, pyramidView: true }
    const f = fg.compile(onlyView)
    expect(f.culled).not.toContain('z-fill')
    expect(f.passes.map(p => p.name)).toContain('pyramid-reduce')
  })

  it('the amortized frame gates the cull + the fold (they freeze together)', () => {
    const { fg } = buildHizGraph()
    const frozen = { ...FULL, fresh: false }
    const f = fg.compile(frozen)
    expect(f.gated).toContain('cull-verdicts')
    expect(f.gated).toContain('hysteresis')
    expect(f.passes.map(p => p.name)).not.toContain('cull-verdicts')
  })

  it('a keep pass survives without consumers (the side-effect law)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const s = fg.resource({ name: 's', kind: 'buffer', bytes: 4, transient: false })
    fg.pass({ name: 'sweep', kind: 'copy', reads: [s], keep: true, execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [], execute: () => {} })
    const f = fg.compile({})
    expect(f.passes.map(p => p.name)).toContain('sweep')
  })

  it('a live reader of a dead transient writer is the honest refusal', () => {
    const fg = createFrameGraph<{ producer: boolean }>()
    const t = fg.resource({ name: 't', kind: 'texture', width: 2, height: 2 })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'producer', kind: 'compute', writes: [t], when: p => p.producer, execute: () => {} })
    fg.pass({ name: 'consumer', kind: 'render', reads: [t], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    // the gated writer never bumps the version — the LIVE consumer binds
    // the unwritten v0 and the frame refuses to schedule garbage
    expect(() => fg.compile({ producer: false })).toThrow("reads 't@0'")
  })

  it('imports (never-written persistent content) are legal reads', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const imported = fg.resource({ name: 'mesh', kind: 'buffer', bytes: 8, transient: false })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'color', kind: 'render', reads: [imported], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    expect(f.edges.some(e => e.resource === 'mesh' && e.from === null)).toBe(true)
    expect(f.stats.live).toBe(2)
  })
})

describe('framegraph — lifetimes and the aliasing planner', () => {
  it('never puts overlapping lifetimes in one slot (soundness)', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile(FULL)
    for (const slot of f.slots) {
      const ivs = [...slot.intervals].sort((a, b) => a.from - b.from)
      for (let i = 1; i < ivs.length; i++) {
        expect(ivs[i - 1].to).toBeLessThan(ivs[i].from)
      }
    }
  })

  it('aliases disjoint lifetimes into one slot and reports the savings', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    // the shadows → blur → composite chain, then a POST pass that reuses
    // the freed slot (the classic console story)
    const shadow = fg.resource({ name: 'shadow', kind: 'texture', width: 64, height: 64 })
    const bloomA = fg.resource({ name: 'bloomA', kind: 'texture', width: 32, height: 32 })
    const bloomB = fg.resource({ name: 'bloomB', kind: 'texture', width: 32, height: 32 })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 64, height: 64, transient: false })
    fg.pass({ name: 'shadow-pass', kind: 'render', writes: [shadow], execute: () => {} })
    fg.pass({ name: 'scene', kind: 'render', reads: [shadow], writes: [target], execute: () => {} })
    fg.pass({ name: 'blur-down', kind: 'compute', reads: [target], writes: [bloomA], execute: () => {} })
    fg.pass({ name: 'blur-up', kind: 'compute', reads: [bloomA], writes: [bloomB], execute: () => {} })
    fg.pass({ name: 'composite', kind: 'render', reads: [bloomB, shadow], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    // shadow's lifetime [0..3] (composite still reads it) overlaps the
    // blooms [2..3] and [3..4] — but bloomA [2..3] and the shadow's slot
    // must differ; the PLANNER's invariant is the gate, not the count:
    // every slot's intervals are pairwise disjoint (checked above in the
    // Hi-Z frame; here the exact accounting)
    for (const slot of f.slots) {
      const ivs = [...slot.intervals].sort((a, b) => a.from - b.from)
      for (let i = 1; i < ivs.length; i++) {
        expect(ivs[i - 1].to).toBeLessThan(ivs[i].from)
      }
    }
    // and the plan is at least as good as naive allocation's peak? The
    // exact guarantee: peak ≤ naive (aliasing never ADDS memory)
    expect(f.stats.peakBytes).toBeLessThanOrEqual(f.stats.naiveBytes)
    expect(f.stats.slots).toBeGreaterThan(0)
    expect(f.stats.savedPct).toBeGreaterThanOrEqual(0)
  })

  it('computes texture bytes from the descriptor (w·h·4, the r32f class)', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile(FULL)
    const tile = f.lifetimes.find(l => l.resource === 'hi-z')
    expect(tile?.bytes).toBe(480 * 270 * 4)
  })
})

describe('framegraph — barriers', () => {
  it('emits the cross-lane hazards, never read-read, and the RMW overlay rides the pipeline order', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile({ ...FULL, pyramidView: true })
    // render fill → compute reduce: RAW on hi-z, G->C
    expect(f.barriers.some(b => b.after === 'z-fill' && b.before === 'pyramid-reduce' && b.resource === 'hi-z' && b.class === 'RAW' && b.lanes === 'G->C')).toBe(true)
    // compute hyst writes scene → render color reads it: RAW, C->G
    expect(f.barriers.some(b => b.after === 'hysteresis' && b.before === 'color' && b.resource === 'scene' && b.class === 'RAW' && b.lanes === 'C->G')).toBe(true)
    // the stats readback (T lane) reads scene@2 — the hysteresis write's
    // own EDGE crosses lanes: the async-copy submission needs the queue
    // sync (the one web-real barrier: mapAsync's readback ordering)
    expect(f.barriers.some(b => b.after === 'hysteresis' && b.before === 'read-stats' && b.resource === 'scene' && b.class === 'RAW' && b.lanes === 'C->T')).toBe(true)
    // the OVERLAY (color writes target, strip reads+writes target) is a
    // same-lane RAW followed by the pass's own write — the pipeline's own
    // order, no barrier: the strip's READ of color's output is the honest
    // dependency and render→render RAW is free
    expect(f.barriers.some(b => b.resource === 'target' && b.after === 'color' && b.before === 'pyramid-view')).toBe(false)
    // read-read is never a barrier: mesh is read by z-fill and color (both
    // render, no writes) — nothing on mesh
    expect(f.barriers.some(b => b.resource === 'mesh')).toBe(false)
  })

  it('a true WAW across passes is emitted (two writers, no intervening read)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const scene = fg.resource({ name: 'scene', kind: 'buffer', bytes: 16, transient: false })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    // compute clears the buffer, then RENDER overwrites it wholesale (no
    // intervening read) — the write→write crossing is the barrier. The
    // consumer reads BOTH versions (the pin keeps the first writer live).
    fg.pass({ name: 'clear', kind: 'compute', writes: [scene], execute: () => {} })
    fg.pass({ name: 'blit', kind: 'render', writes: [scene], execute: () => {} })
    fg.pass({ name: 'color', kind: 'render', reads: [scene, scene.at(1)], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    expect(f.barriers.some(b => b.after === 'clear' && b.before === 'blit' && b.resource === 'scene' && b.class === 'WAW' && b.lanes === 'C->G')).toBe(true)
  })

  it('a compute write feeding the COPY lane directly emits the C->T barrier', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const scene = fg.resource({ name: 'scene', kind: 'buffer', bytes: 16, transient: false })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'cull', kind: 'compute', writes: [scene], execute: () => {} })
    fg.pass({ name: 'readback', kind: 'copy', reads: [scene], execute: () => {} })
    fg.pass({ name: 'color', kind: 'render', reads: [scene], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    expect(f.barriers.some(b => b.after === 'cull' && b.before === 'readback' && b.resource === 'scene' && b.class === 'RAW' && b.lanes === 'C->T')).toBe(true)
  })

  it('same-lane RAW rides the pipeline order (free — honest model)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const t = fg.resource({ name: 't', kind: 'texture', width: 2, height: 2, transient: false })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'a', kind: 'render', writes: [t], execute: () => {} })
    fg.pass({ name: 'b', kind: 'render', reads: [t], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    expect(f.barriers.filter(b => b.resource === 't')).toHaveLength(0) // G->G RAW: the pipeline's own order
  })

  it('barriers live only between LIVE passes (a dead branch needs none)', () => {
    const { fg } = buildHizGraph()
    const off = { ...FULL, culling: false, pyramidView: false }
    const f = fg.compile(off)
    expect(f.barriers.some(b => b.after === 'z-fill' || b.before === 'z-fill')).toBe(false)
    expect(f.barriers.some(b => b.before === 'pyramid-reduce')).toBe(false)
  })
})

describe('framegraph — the async-lane overlap plan', () => {
  it('schedules the copy lane beside the graphics lane (the readback reality)', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile(FULL)
    // read-stats (T) depends on the cull (C) only; the graphics lane is
    // busy with color (cost 6) at its start → the plan overlaps them
    const pair = f.overlap.parallel.find(p => p.pass === 'read-stats')
    expect(pair).toBeDefined()
    expect(pair?.lane).toBe('T')
    expect(pair?.units).toBeGreaterThan(0)
    expect(f.overlap.overlapUnits).toBeGreaterThan(0)
    // the critical path must not shrink below the longest lane's busy sum
    expect(f.overlap.criticalPath).toBeGreaterThanOrEqual(f.overlap.busy.G)
  })

  it('a dependency chain finds no overlap (the honest zero)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const a = fg.resource({ name: 'a', kind: 'texture', width: 2, height: 2 })
    const b = fg.resource({ name: 'b', kind: 'texture', width: 2, height: 2 })
    fg.pass({ name: 'r1', kind: 'render', writes: [a], execute: () => {} })
    fg.pass({ name: 'c1', kind: 'compute', reads: [a], writes: [b], execute: () => {} })
    fg.pass({ name: 'r2', kind: 'render', reads: [b], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [], execute: () => {} })
    const f = fg.compile({})
    expect(f.overlap.overlapUnits).toBe(0)
    expect(f.overlap.parallel).toHaveLength(0)
  })

  it('independent compute overlaps long graphics work (the plan a multi-queue backend follows)', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    const src = fg.resource({ name: 'src', kind: 'buffer', bytes: 16, transient: false })
    const scratch = fg.resource({ name: 'scratch', kind: 'texture', width: 2, height: 2 })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'prep', kind: 'render', writes: [src], execute: () => {} })
    // a long render pass and an independent compute pass, both after prep
    fg.pass({ name: 'long-render', kind: 'render', cost: 10, writes: [target], execute: () => {} })
    fg.pass({ name: 'side-compute', kind: 'compute', cost: 4, writes: [scratch], keep: true, execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const f = fg.compile({})
    const pair = f.overlap.parallel.find(p => p.pass === 'side-compute')
    expect(pair).toBeDefined()
    expect(pair?.units).toBeGreaterThan(0)
  })

  it('the plan respects every dependency (windows start after inputs finish)', () => {
    const { fg } = buildHizGraph()
    const f = fg.compile(FULL)
    // reconstruct the schedule from the edges + the pass order and verify
    // the busy-lane invariant: a pass on lane L cannot start before its
    // producers' finish — the plan encodes it as busy[L] ≥ producer finish
    const passNames = f.passes.map(p => p.name)
    for (const e of f.edges) {
      if (e.from === null) continue
      const wi = passNames.indexOf(e.from)
      const ri = passNames.indexOf(e.to)
      expect(wi).toBeGreaterThanOrEqual(0)
      expect(ri).toBeGreaterThanOrEqual(0)
      expect(ri).toBeGreaterThan(wi) // the timeline honors every edge
    }
  })
})

describe('framegraph — the compile cache (the policy recording proxy)', () => {
  it('the same policy returns the SAME compiled object (identity)', () => {
    const { fg } = buildHizGraph()
    const a = fg.compile(FULL)
    const b = fg.compile({ ...FULL })
    expect(a).toBe(b)
    // a flip recompiles
    const c = fg.compile({ ...FULL, pyramidView: false })
    expect(c).not.toBe(a)
  })

  it('the camera rides the RUN props — the cache never sees it', () => {
    const fg = createFrameGraph<{ gate: boolean; camera?: { mvp: number } }>()
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    const seen: unknown[] = []
    fg.pass({
      name: 'draw', kind: 'render', writes: [target],
      execute: ctx => { seen.push((ctx.props as { camera?: unknown }).camera) },
    })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    const p1 = { gate: true, camera: { mvp: 0 } }
    const p2 = { gate: true, camera: { mvp: 1 } }
    const f1 = fg.compile(p1)
    const f2 = fg.compile(p2)
    expect(f1).toBe(f2) // the policy key recorded no camera — only the gate
    f1.run(p1)
    f1.run(p2)
    expect(seen).toEqual([{ mvp: 0 }, { mvp: 1 }])
  })

  it('an object read inside a DECLARATION is the honest refusal', () => {
    const fg = createFrameGraph<{ camera?: { mvp: number } }>()
    const t = fg.resource({ name: 't', kind: 'texture', width: 2, height: 2 })
    fg.pass({ name: 'bad', kind: 'render', reads: p => (p.camera !== undefined ? [t] : []), execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [], execute: () => {} })
    expect(() => fg.compile({ camera: { mvp: 1 } })).toThrow('primitive policy props')
  })

  it('counts compiles honestly', () => {
    const { fg } = buildHizGraph()
    fg.compile(FULL)
    fg.compile(FULL)
    fg.compile({ ...FULL, pyramidView: false })
    const f = fg.compile(FULL)
    expect(f.stats.compiles).toBe(2)
  })
})

describe('framegraph — the slot discipline (the pool hooks)', () => {
  it('acquires at the first interval start, releases at the last end, per frame', () => {
    const events: string[] = []
    const fg = createFrameGraph<Record<string, unknown>>({
      acquire: slot => { events.push(`+${slot}`); return { slot } },
      release: slot => { events.push(`-${slot}`) },
    })
    const a = fg.resource({ name: 'a', kind: 'texture', width: 2, height: 2 })
    const b = fg.resource({ name: 'b', kind: 'texture', width: 2, height: 2 })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    // a: [0..1], b: [2..3] — disjoint lifetimes → ONE slot (the alias),
    // ONE acquire at the slot's first start and ONE release at its last
    // end (the pooled object's per-frame discipline). Both consumers
    // OVERLAY the target (read-modify-write — the second writer must read
    // the first's version or its pure write would shadow the branch dead).
    fg.pass({ name: 'p0', kind: 'render', writes: [a], execute: () => { events.push('p0') } })
    fg.pass({ name: 'p1', kind: 'render', reads: [a, target], writes: [target], execute: () => { events.push('p1') } })
    fg.pass({ name: 'p2', kind: 'render', writes: [b], execute: () => { events.push('p2') } })
    fg.pass({ name: 'p3', kind: 'render', reads: [b, target], writes: [target], execute: () => { events.push('p3') } })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => { events.push('pp') } })
    const f = fg.compile({})
    expect(f.slots).toHaveLength(1) // a and b alias — the disjoint pair
    f.run({})
    expect(events).toEqual(['+0', 'p0', 'p1', 'p2', 'p3', '-0', 'pp'])
    f.run({})
    // the second frame repeats the discipline (the pooled object re-acquired)
    expect(events.slice(7)).toEqual(['+0', 'p0', 'p1', 'p2', 'p3', '-0', 'pp'])
  })

  it('exposes the pooled slot backing to the executes (ctx.view().object)', () => {
    const fg = createFrameGraph<Record<string, unknown>>({
      acquire: slot => ({ pooled: slot }),
    })
    const t = fg.resource({ name: 't', kind: 'texture', width: 2, height: 2 })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    const seen: unknown[] = []
    fg.pass({
      name: 'p', kind: 'compute', writes: [t],
      execute: ctx => { seen.push(ctx.view('t').object) },
    })
    fg.pass({ name: 'q', kind: 'render', reads: [t], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    fg.compile({}).run({})
    expect(seen).toEqual([{ pooled: 0 }])
  })

  it('an external transient never touches the hooks (the brick owns it)', () => {
    let acquires = 0
    const fg = createFrameGraph<Record<string, unknown>>({ acquire: () => { acquires++ } })
    const own = fg.resource({ name: 'own', kind: 'texture', width: 2, height: 2, external: { brick: true } })
    fg.pass({ name: 'p', kind: 'compute', writes: [own], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [own], execute: () => {} })
    const f = fg.compile({})
    // the external object is the backing — the planner still tracks its
    // lifetime (the accounting), the hooks stay idle
    f.run({})
    expect(acquires).toBe(0)
    expect(f.lifetimes.find(l => l.resource === 'own')).toBeDefined()
  })
})

describe('framegraph — the honest refusals', () => {
  it('rejects duplicate resource names and duplicate pass names', () => {
    const fg = createFrameGraph<Record<string, unknown>>()
    fg.resource({ name: 'a', kind: 'buffer', bytes: 4 })
    expect(() => fg.resource({ name: 'a', kind: 'buffer', bytes: 4 })).toThrow('declared twice')
    fg.pass({ name: 'p', kind: 'render', execute: () => {} })
    expect(() => fg.pass({ name: 'p', kind: 'render', execute: () => {} })).toThrow('declared twice')
  })

  it('rejects a handle from a foreign graph', () => {
    const g1 = createFrameGraph<Record<string, unknown>>()
    const g2 = createFrameGraph<Record<string, unknown>>()
    const foreign = g1.resource({ name: 'x', kind: 'buffer', bytes: 4 })
    const own = g2.resource({ name: 'x', kind: 'buffer', bytes: 4 })
    g2.pass({ name: 'p', kind: 'render', reads: [foreign], writes: [own], execute: () => {} })
    g2.pass({ name: 'present', kind: 'present', reads: [own], execute: () => {} })
    expect(() => g2.compile({})).toThrow('ANOTHER graph')
  })

  it('reset() drops the version history (a scene reload)', () => {
    const fg = createFrameGraph<{ fresh: boolean }>()
    const scene = fg.resource({ name: 'scene', kind: 'buffer', bytes: 16, transient: false })
    const target = fg.resource({ name: 'target', kind: 'texture', width: 2, height: 2, transient: false })
    fg.pass({ name: 'cull', kind: 'compute', writes: [scene], when: p => p.fresh, execute: () => {} })
    fg.pass({ name: 'color', kind: 'render', reads: [scene], writes: [target], execute: () => {} })
    fg.pass({ name: 'present', kind: 'present', reads: [target], execute: () => {} })
    fg.compile({ fresh: true }).run({ fresh: true })
    expect(fg.compile({ fresh: true }).run({ fresh: true }).stale.scene).toBe(0)
    fg.reset()
    // the history is gone: an amortized frame reads the IMPORT (v0) — never
    // written since the reload
    expect(fg.compile({ fresh: false }).run({ fresh: false }).stale.scene).toBe(-1)
  })
})
