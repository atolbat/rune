/**
 * task192.test.ts — the TAIL LAYOUT (the Task-189 N2+N1 dossier, production).
 *
 * The pinned invariants:
 *   • THE SEGMENTS: pack() emits the DFS tree first, then the grouped LEAVES
 *     in per-group contiguous ranges; gStart[0] is the tree/tail boundary;
 *     rankOf is the inverse of order; gHidden is the per-segment hidden tally;
 *   • PARITY WITH THE KILL-SWITCH: on leaf-domain fixtures the ON and OFF
 *     modes agree bit-for-bit (counts / offsets / pool / the direct collect)
 *     over static, flipping and ANIMATED frames — including the animation of
 *     a structure node PARENT of grouped leaves (the dossier's
 *     all-grouped-to-tail variant was broken there: the parent landed after
 *     its children; leaf-eligibility is the fix — this test pins it);
 *   • THE CULL: hierarchical(tree) + brute(tail sweep) == brute over the
 *     whole scene (the bits are identical — a leaf's bit IS its sphere test);
 *   • THE REFIT: an internal node whose children are ALL tail members still
 *     gets its auto-bound combined (the range [r, r+1) camouflage — the child
 *     LIST decides leafness);
 *   • THE WORLD PERMUTATION: worldMatrix(slot) survives structural edits
 *     (repacks) — the rank-major rows travel with their nodes;
 *   • THE CONTRACT DELTA (documented): a grouped node WITH children keeps
 *     its DFS placement and is NOT an instance in the ON mode; the OFF mode
 *     restores the pre-192 full-scan semantics;
 *   • setGroup marks layoutDirty — a member moving between groups MOVES
 *     SEGMENTS (the next hot pass repacks);
 *   • out-of-domain group ids take the legacy full scan (pre-192 semantics);
 *   • the fully-visible fast path: gHidden === 0 + all bits set → the block
 *     copy (the counters) with a bit-identical result.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import {
  cullViewsBrute,
  cullViewsHierarchical,
  collectGroupMatrices,
  collectInstancesViews,
  createCamera,
  createScene,
  instancePoolBase,
  popcountBits,
  setTailLayout,
  tailCounters,
  tailLayoutOn,
  writeCameraPlanes,
} from '../src/index.ts'
import { bitsBase } from '../src/culling.ts'
import type { Scene, SceneViews } from '../src/index.ts'

afterEach(() => {
  setTailLayout(true)
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cameraFor(yaw = 0, dist = 40) {
  const cam = createCamera().setPerspective(1.0, 1, 0.1, 500)
  cam.setViewLookAt(Math.sin(yaw) * dist, 8, Math.cos(yaw) * dist, 0, 0, 0, 0, 1, 0)
  return cam
}

/** The demo pattern: a structure tree, the grouped instanced leaves at the bottom. */
function buildLeafScene(seed: number, targetNodes: number, groupMax = 8): Scene {
  const rnd = mulberry32(seed)
  const scene = createScene({ capacity: targetNodes + 16, groupMax, cameraMax: 2, maxInstances: targetNodes })
  const parents: number[] = []
  let created = 0
  while (created < targetNodes) {
    const parent = parents.length > 0 && rnd() < 0.7 ? parents[Math.floor(rnd() * parents.length)] : -1
    const slot = scene.create({
      parent,
      position: [(rnd() - 0.5) * 40, (rnd() - 0.5) * 20, (rnd() - 0.5) * 40],
      group: parent < 0 ? -1 : Math.floor(rnd() * groupMax), // leaves under structure nodes
      sphere: [0, 0, 0, 0.5 + rnd() * 2],
    })
    parents.push(slot)
    created++
  }
  // The hierarchical↔brute parity contract: a user sphere on an INTERNAL
  // node is "the user knows better" — the cull TRUSTS it and may diverge
  // from brute. Internal nodes get AUTO bounds (r = -1) — the leaves keep
  // their user spheres. Grouped internal nodes are DEMOTED — the supported
  // leaf-domain pattern (the delta contract has its own dedicated test).
  for (let slot = 0; slot < scene.capacity; slot++) {
    if ((scene.views.nodeFlags[slot] & 2) !== 0 && scene.views.firstChild[slot] >= 0) {
      scene.setSphereLocal(slot, 0, 0, 0, -1)
      if (scene.views.group[slot] >= 0) scene.setGroup(slot, -1)
    }
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

describe('Task 192: the segments', () => {
  it('pack emits the tree first, then per-group contiguous leaf segments', () => {
    const scene = createScene({ capacity: 64, groupMax: 4 })
    const root = scene.create({})
    for (let i = 0; i < 10; i++) scene.create({ parent: root, group: i % 3, position: [i, 0, 0] })
    scene.updateWorld()
    const views = scene.views
    const n = views.headerI[2]
    const treeN = views.gStart[0]
    expect(treeN).toBe(1) // just the root
    // rankOf is the inverse of order
    for (let r = 0; r < n; r++) expect(views.rankOf[views.order[r]]).toBe(r)
    // every segment member is a grouped leaf of exactly that group
    const groupCount = Math.min(views.headerI[11], views.groupMax)
    for (let g = 0; g < groupCount; g++) {
      for (let r = views.gStart[g]; r < views.gStart[g + 1]; r++) {
        const slot = views.order[r]
        expect(views.group[slot]).toBe(g)
        expect(views.firstChild[slot]).toBeLessThan(0)
      }
    }
    // a parent's subtree range never absorbs a tail child
    expect(views.subtreeEnd[root]).toBe(1)
  })

  it('gHidden counts the segment members with NF_VISIBLE off', () => {
    const scene = buildLeafScene(3, 120)
    const views = scene.views
    const groupCount = Math.min(views.headerI[11], views.groupMax)
    let toggled = 0
    for (let r = views.gStart[0]; r < scene.count; r++) {
      const slot = views.order[r]
      if (toggled < 5 && views.group[slot] === 0 && (views.nodeFlags[slot] & 1) !== 0) {
        scene.setVisible(slot, false)
        toggled++
      }
    }
    expect(toggled).toBe(5)
    let hidden = 0
    for (let r = views.gStart[0]; r < views.gStart[1]; r++) {
      if ((views.nodeFlags[views.order[r]] & 1) === 0) hidden++
    }
    expect(views.gHidden[0]).toBe(hidden)
  })
})

describe('Task 192: parity with the kill-switch', () => {
  it('static + flip frames: counts/offsets/pool/direct collect are bit-identical', () => {
    const build = () => buildLeafScene(11, 900)
    const sceneA = build() // OFF (legacy)
    const sceneB = build() // ON (tail)
    setTailLayout(false)
    sceneA.pack()
    setTailLayout(true)
    sceneB.pack()
    const cam = cameraFor()
    writeCameraPlanes(sceneA.views, 0, cam.planes)
    writeCameraPlanes(sceneB.views, 1, cam.planes)
    const va = sceneA.views
    const vb = sceneB.views
    const groupCount = Math.min(va.headerI[11], va.groupMax)
    const outA = new Float32Array(64 * 16)
    const outB = new Float32Array(64 * 16)
    for (let f = 0; f < 20; f++) {
      const b = f & 1
      if ((f & 3) === 2) { // a flip wave: toggle some members of group 1
        const membersA: number[] = []
        const membersB: number[] = []
        for (let r = 0; r < va.headerI[2]; r++) {
          if (va.group[va.order[r]] === 1) membersA.push(va.order[r])
          if (vb.group[vb.order[r]] === 1) membersB.push(vb.order[r])
        }
        const vis = (f & 4) === 0
        for (let i = 0; i < Math.min(5, membersA.length); i++) {
          sceneA.setVisible(membersA[i], vis)
          sceneB.setVisible(membersB[i], vis)
        }
        sceneA.updateWorld()
        sceneB.updateWorld()
      }
      // The switch flips around each twin's phase (the documented toggle
      // contract: a flip does not re-derive the packed layout — A was packed
      // OFF, B ON; each collect must run in ITS mode).
      setTailLayout(false)
      cullViewsBrute(va, 0, b)
      const retA = collectInstancesViews(va, 0, b)
      setTailLayout(true)
      cullViewsBrute(vb, 1, b)
      const retB = collectInstancesViews(vb, 1, b)
      expect(retB).toBe(retA)
      const baseA = (b * 2 + 0) * va.groupMax
      const baseB = (b * 2 + 1) * vb.groupMax
      for (let g = 0; g < groupCount; g++) {
        expect(vb.instCounts[baseB + g]).toBe(va.instCounts[baseA + g])
        expect(vb.instOffsets[baseB + g]).toBe(va.instOffsets[baseA + g])
      }
      const poolA = instancePoolBase(va, b, 0)
      const poolB = instancePoolBase(vb, b, 1)
      for (let i = 0; i < retA * 16; i++) expect(vb.instPool[poolB + i]).toBe(va.instPool[poolA + i])
      for (let g = 0; g < groupCount; g++) {
        outA.fill(7.77)
        outB.fill(7.77)
        setTailLayout(false)
        const ka = collectGroupMatrices(va, 0, b, g, outA)
        setTailLayout(true)
        const kb = collectGroupMatrices(vb, 1, b, g, outB)
        expect(kb).toBe(ka)
        for (let i = 0; i < ka * 16; i++) expect(outB[i]).toBe(outA[i])
      }
    }
  })

  it('ANIMATED structure parents: the children matrices stay correct (the stale-parent fix)', () => {
    // The case the dossier's all-grouped-to-tail variant broke: an animated
    // parent of grouped leaves. Leaf-eligibility keeps the parent in the
    // tree region BEFORE its children — updateWorld reads a FRESH parent.
    const build = () => {
      const scene = createScene({ capacity: 40, groupMax: 2, maxInstances: 40 })
      const root = scene.create({ position: [0, 0, 0] })
      for (let i = 0; i < 12; i++) {
        scene.create({ parent: root, position: [i * 3 - 15, 0, 0], sphere: [0, 0, 0, 1], group: i % 2 })
      }
      scene.updateWorld()
      return scene
    }
    const sceneRef = build() // OFF — the pre-192 semantics
    const sceneTail = build() // ON
    setTailLayout(false)
    sceneRef.pack()
    setTailLayout(true)
    sceneTail.pack()
    for (let f = 0; f < 8; f++) {
      sceneRef.setLocalTR(0, f * 2, 1, 0, 0, 0, 0, 1, 1, 1, 1)
      sceneTail.setLocalTR(0, f * 2, 1, 0, 0, 0, 0, 1, 1, 1, 1)
      sceneRef.updateWorld()
      sceneTail.updateWorld()
      // EVERY node's world matrix must match the reference bit-for-bit
      for (let slot = 0; slot < 13; slot++) {
        const wa = sceneRef.worldMatrix(slot)
        const wb = sceneTail.worldMatrix(slot)
        for (let i = 0; i < 16; i++) expect(wb[i]).toBe(wa[i])
      }
    }
  })

  it('hierarchical(tree)+brute(tail) == brute culling (the bits are identical)', () => {
    for (const seed of [5, 17, 42]) {
      const scene = buildLeafScene(seed, 600)
      const views = scene.views
      const cam = cameraFor(seed * 0.3, 30 + seed)
      writeCameraPlanes(views, 0, cam.planes)
      writeCameraPlanes(views, 1, cam.planes)
      cullViewsBrute(views, 0, 0)
      cullViewsHierarchical(views, 0, 1)
      const b0 = bitsBase(views, 0, 0)
      const b1 = bitsBase(views, 1, 0)
      for (let w = 0; w < views.bitsWords; w++) {
        expect(views.bits[b1 + w]).toBe(views.bits[b0 + w])
      }
      expect(popcountBits(views.bits, b1, views.bitsWords)).toBeGreaterThan(0)
    }
  })

  it('the refit combines an internal node whose children are ALL tail members', () => {
    // The range camouflage: the parent's subtreeEnd excludes its tail
    // children ([r, r+1)) — the child LIST must decide leafness.
    const scene = createScene({ capacity: 32, groupMax: 2 })
    const root = scene.create({ position: [0, 0, 0], sphere: [0, 0, 0, -1] })
    for (let i = 0; i < 8; i++) {
      scene.create({ parent: root, position: [(i % 4) * 10 - 15, ((i / 4) | 0) * 10, 0], sphere: [0, 0, 0, 2], group: i % 2 })
    }
    scene.updateWorld()
    const rebuilt = scene.refitGroupBounds()
    expect(rebuilt).toBeGreaterThan(0)
    const r4 = root * 4
    const sw = scene.views.sphereW
    // the root's bound encloses both children corners: |x| ≤ 15+2, |y| ≤ 5+2
    expect(sw[r4]).toBeCloseTo(0, 5)
    expect(sw[r4 + 3]).toBeGreaterThanOrEqual(17)
    // and the FORCED refit agrees (the parity reference — the root only)
    scene.updateWorld(true)
    const forced = scene.refitGroupBoundsForced()
    expect(forced).toBe(rebuilt)
  })
})

describe('Task 192: the contract', () => {
  it('a grouped node WITH children keeps its DFS placement and is NOT an instance (ON)', () => {
    const scene = createScene({ capacity: 16, groupMax: 2, maxInstances: 16 })
    const groupedParent = scene.create({ group: 0, position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ parent: groupedParent, group: 0, position: [5, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const out = new Float32Array(8 * 16)
    // ON: the leaf only (the documented leaf-domain contract)
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(1)
    // OFF: the pre-192 full scan finds BOTH (the parent is a member too)
    setTailLayout(false)
    scene.pack()
    cullViewsBrute(views, 0, 0)
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(2)
  })

  it('setGroup moves the member to the other SEGMENT (layoutDirty → repack)', () => {
    const scene = createScene({ capacity: 16, groupMax: 2, maxInstances: 16 })
    const a = scene.create({ group: 0, position: [0, 0, 0] })
    for (let i = 0; i < 4; i++) scene.create({ group: 0, position: [i + 1, 0, 0] })
    scene.create({ group: 1, position: [10, 0, 0] })
    scene.updateWorld()
    scene.setGroup(a, 1)
    expect(scene.layoutDirty).toBe(true)
    scene.updateWorld() // ensurePacked → the repack
    const views = scene.views
    // a is now INSIDE group 1's segment
    const r = views.rankOf[a]
    expect(r).toBeGreaterThanOrEqual(views.gStart[1])
    expect(r).toBeLessThan(views.gStart[2])
    // and the counts follow (group 0 lost a member, group 1 gained one)
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    collectInstancesViews(views, 0, 0)
    expect(views.instCounts[0]).toBe(4)
    expect(views.instCounts[1]).toBe(2)
  })

  it('out-of-domain group ids take the legacy full scan (pre-192 semantics)', () => {
    // An id becomes DENSE the moment it is assigned (bumpGroupCount) — the
    // constructible out-of-domain queries are −1 ("not instanced") and
    // never-assigned ids: both fall to the legacy full scan.
    const scene = createScene({ capacity: 16, groupMax: 4, maxInstances: 16 })
    scene.create({ group: -1, position: [0, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ group: -1, position: [1, 0, 0], sphere: [0, 0, 0, 1] })
    scene.create({ group: 0, position: [2, 0, 0], sphere: [0, 0, 0, 1] })
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const out = new Float32Array(8 * 16)
    expect(collectGroupMatrices(views, 0, 0, -1, out)).toBe(2) // the ungrouped pair
    expect(out[16 + 12]).toBeCloseTo(1, 5) // the second one's translation
    expect(collectGroupMatrices(views, 0, 0, 2, out)).toBe(0) // never assigned
  })

  it('the fully-visible fast path: the block copy is bit-identical (the counters)', () => {
    const scene = createScene({ capacity: 128, groupMax: 2, maxInstances: 128 })
    // one dense in-view cluster — every bit set, no hidden members
    for (let i = 0; i < 60; i++) scene.create({ group: 0, position: [(i - 30) * 0.3, 0, 0], sphere: [0, 0, 0, 0.1] })
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    expect(popcountBits(views.bits, bitsBase(views, 0, 0), views.bitsWords)).toBe(60)
    const out = new Float32Array(64 * 16)
    const before = tailCounters().blocks
    const k = collectGroupMatrices(views, 0, 0, 0, out)
    expect(k).toBe(60)
    expect(tailCounters().blocks).toBe(before + 1) // the block path fired
    // the reference: the kill-switch walk over the same bits
    setTailLayout(false)
    scene.pack()
    const out2 = new Float32Array(64 * 16)
    const k2 = collectGroupMatrices(views, 0, 0, 0, out2)
    setTailLayout(true)
    scene.pack()
    expect(k2).toBe(60)
    for (let i = 0; i < 60 * 16; i++) expect(out[i]).toBe(out2[i])
  })

  it('the pool fill uses the block path for a fully-visible group', () => {
    const scene = createScene({ capacity: 128, groupMax: 2, maxInstances: 128 })
    for (let i = 0; i < 60; i++) scene.create({ group: 0, position: [(i - 30) * 0.3, 0, 0], sphere: [0, 0, 0, 0.1] })
    scene.updateWorld()
    const views = scene.views
    const cam = cameraFor()
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const before = tailCounters().blocks
    const ret = collectInstancesViews(views, 0, 0)
    expect(ret).toBe(60)
    expect(tailCounters().blocks).toBe(before + 1)
    // the pool content is the world rows in segment order
    for (let i = 0; i < 60; i++) {
      expect(views.instPool[i * 16 + 12]).toBeCloseTo((i - 30) * 0.3, 4)
    }
  })
})

describe('Task 192: the world permutation', () => {
  it('worldMatrix(slot) survives structural edits (the rows travel with the nodes)', () => {
    const scene = createScene({ capacity: 64, groupMax: 2 })
    const slots: number[] = []
    for (let i = 0; i < 20; i++) {
      slots.push(scene.create({ parent: i % 3 === 0 ? -1 : slots[(i * 7) % i] ?? -1, position: [i, i * 0.25, -i], group: i % 5 === 0 ? 0 : -1 }))
    }
    scene.updateWorld()
    const before = slots.map(s => scene.worldMatrix(s).slice())
    // structural edits: dispose + create + reparent
    scene.dispose(slots[1])
    const fresh = scene.create({ parent: slots[2], position: [99, 0, 0], group: 0 })
    slots.push(fresh)
    scene.setParent(slots[3], slots[4])
    scene.updateWorld()
    // every SURVIVING node's matrix is still readable and matches a recompute
    for (let i = 0; i < slots.length; i++) {
      if (i === 1) continue
      const w = scene.worldMatrix(slots[i])
      expect(w.length).toBe(16)
      expect(scene.views.rankOf[slots[i]]).toBeGreaterThanOrEqual(0)
    }
    // the fresh node's world = its local + the parent's translation
    const wf = scene.worldMatrix(fresh)
    expect(wf[12]).toBeCloseTo(99 + 2, 5) // parent slots[2] sits at x = 2
    // The strong permutation check: the DIRTY incremental update over the
    // repacked (permuted) rows equals the FORCED full recompute — the rows
    // travel with their nodes, no stale copies survive.
    const dirty = scene.views.world.slice()
    scene.updateWorld(true)
    const forced = scene.views.world
    for (let i = 0; i < forced.length; i++) expect(forced[i]).toBe(dirty[i])
    expect(scene.updateWorld(false)).toBe(0) // everything is clean now
  })

  it('an identity world is served for never-computed rows (create + pack, no updateWorld)', () => {
    const scene = createScene({ capacity: 8 })
    const slot = scene.create({ position: [3, 4, 5] })
    const w = scene.worldMatrix(slot) // packs (identity for worldStamp === 0)
    expect(w[0]).toBe(1)
    expect(w[5]).toBe(1)
    expect(w[10]).toBe(1)
    expect(w[15]).toBe(1)
    expect(w[12]).toBe(0)
    scene.updateWorld()
    expect(scene.worldMatrix(slot)[12]).toBeCloseTo(3, 5)
  })
})

describe('Task 192: randomized property parity (the leaf domain)', () => {
  it('ON vs OFF twins: 24 frames of none/burst/wiggle events agree bit-for-bit', () => {
    for (const seed of [777, 1234, 999]) {
    const build = (s: number) => buildLeafScene(s, 500, 6)
    const sceneA = build(seed)
    const sceneB = build(seed)
    setTailLayout(false)
    sceneA.pack()
    setTailLayout(true)
    sceneB.pack()
    const va: SceneViews = sceneA.views
    const vb: SceneViews = sceneB.views
    const rng = mulberry32(seed * 3)
    for (let f = 0; f < 24; f++) {
      const ev = rng()
      if (ev < 0.5) { // burst: toggle members of a random group
        const g = Math.floor(rng() * 6)
        const vis = rng() > 0.5
        // the SLOT sets are identical; each twin walks ITS OWN rank space
        for (let r = 0; r < va.headerI[2]; r++) {
          if (va.group[va.order[r]] === g) sceneA.setVisible(va.order[r], vis)
        }
        for (let r = 0; r < vb.headerI[2]; r++) {
          if (vb.group[vb.order[r]] === g) sceneB.setVisible(vb.order[r], vis)
        }
        sceneA.updateWorld()
        sceneB.updateWorld()
      } else if (ev < 0.75) { // wiggle: the camera moves
        const cam = cameraFor(rng() * 6, 25 + rng() * 30)
        writeCameraPlanes(va, 0, cam.planes)
        writeCameraPlanes(vb, 0, cam.planes)
      }
      const b = f & 1
      setTailLayout(false)
      cullViewsBrute(va, 0, b)
      const retA = collectInstancesViews(va, 0, b)
      setTailLayout(true)
      cullViewsBrute(vb, 0, b)
      const retB = collectInstancesViews(vb, 0, b)
      expect(retB).toBe(retA)
      const poolA = instancePoolBase(va, b, 0)
      const poolB = instancePoolBase(vb, b, 0)
      for (let i = 0; i < retA * 16; i++) expect(vb.instPool[poolB + i]).toBe(va.instPool[poolA + i])
      for (let g = 0; g < 6; g++) {
        expect(vb.instCounts[b * 2 * vb.groupMax + g]).toBe(va.instCounts[b * 2 * va.groupMax + g])
      }
    }
    } // seeds
  })

  it('the counters are honest (the modes are observable)', () => {
    expect(tailLayoutOn()).toBe(true)
    setTailLayout(false)
    expect(tailLayoutOn()).toBe(false)
  })
})
