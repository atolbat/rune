/**
 * task191.test.ts — the N4 GROUP-SPHERE PRE-REJECT (the Task-189 dossier,
 * production) + the setGroup composition-stamp contract fix.
 *
 * The pinned invariants:
 *   • THE ENCLOSING ARGUMENT: the pre-reject fires (returns 0 without a
 *     scan) ONLY when the group's sphere is entirely outside a frustum
 *     plane — under cull-produced bits that is EXACTLY when the scan would
 *     return 0. Parity with the kill-switch is asserted on the win path,
 *     the neutral path and across randomized cameras;
 *   • INVALIDATION: a member moving (updateWorld) or a member joining /
 *     leaving (setGroup) rebuilds the group's sphere — the pre-reject
 *     state follows the members;
 *   • THE setGroup FIX: a composition change now stamps BOTH groups (the
 *     Task-85 family) — the pool memo (Task 190) and the upload skip no
 *     longer serve stale counts after a member moves between groups;
 *   • the refit stamps a grouped internal node's group when its auto-bound
 *     is rewritten (the sphere-version discipline);
 *   • the kill-switch restores the pure scan; out-of-domain ids never
 *     touch the sphere machinery.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import {
  collectGroupMatrices,
  collectInstancesViews,
  createCamera,
  createScene,
  cullViewsBrute,
  groupSphereCounters,
  setGroupSphereReject,
  writeCameraPlanes,
} from '../src/index.ts'

afterEach(() => {
  setGroupSphereReject(true)
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Two clusters: group 0 near the origin (in view), group 7 far away. */
function buildClusters() {
  const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 8, maxInstances: 64 })
  for (let i = 0; i < 12; i++) {
    scene.create({ position: [(i % 4) * 3 - 5, ((i / 4) | 0) * 3, 20], sphere: [0, 0, 0, 1], group: 0 })
  }
  for (let i = 0; i < 12; i++) {
    scene.create({ position: [9000 + (i % 4) * 3, ((i / 4) | 0) * 3, 20], sphere: [0, 0, 0, 1], group: 7 })
  }
  scene.updateWorld()
  scene.refitGroupBounds()
  return scene
}

describe('Task 191: the N4 pre-reject', () => {
  it('an out-of-frustum group returns 0 without a scan; parity with the kill-switch', () => {
    const scene = buildClusters()
    const views = scene.views
    const cam = createCamera().setPerspective(1.0, 1, 0.1, 500).setViewLookAt(0, 0, 100, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const out = new Float32Array(64 * 16)
    const outKill = new Float32Array(64 * 16)

    const before = groupSphereCounters()
    const k = collectGroupMatrices(views, 0, 0, 7, out) // far cluster — REJECT
    const after = groupSphereCounters()
    expect(k).toBe(0)
    expect(after.rejects).toBe(before.rejects + 1) // the reject happened
    expect(after.builds).toBe(before.builds + 1) // the sphere was built lazily

    setGroupSphereReject(false)
    const kKill = collectGroupMatrices(views, 0, 0, 7, outKill) // the pure scan
    setGroupSphereReject(true)
    expect(kKill).toBe(0) // the scan agrees: all 12 members culled out
    // both wrote nothing to out
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0)
      expect(outKill[i]).toBe(0)
    }

    // the NEAR cluster: no reject, full parity of content
    const a = new Float32Array(64 * 16)
    const b = new Float32Array(64 * 16)
    const kNear = collectGroupMatrices(views, 0, 0, 0, a)
    setGroupSphereReject(false)
    const kNearKill = collectGroupMatrices(views, 0, 0, 0, b)
    setGroupSphereReject(true)
    expect(kNear).toBe(kNearKill)
    expect(kNear).toBeGreaterThan(0)
    for (let i = 0; i < kNear * 16; i++) expect(a[i]).toBe(b[i])
  })

  it('a member moving invalidates the sphere (the group crosses the frustum)', () => {
    const scene = createScene({ capacity: 16, cameraMax: 1, groupMax: 2, maxInstances: 16 })
    const members: number[] = []
    for (let i = 0; i < 6; i++) {
      members.push(scene.create({ position: [i * 3, 0, 30], sphere: [0, 0, 0, 1], group: 0 }))
    }
    scene.updateWorld()
    scene.refitGroupBounds()
    const views = scene.views
    const cam = createCamera().setPerspective(1.0, 1, 0.1, 300).setViewLookAt(0, 0, 120, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const out = new Float32Array(16 * 16)
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(6) // in view

    // the whole group leaves the frustum
    for (const s of members) scene.setLocalTR(s, 5000 + s * 3, 0, 30, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    scene.refitGroupBounds()
    cullViewsBrute(views, 0, 0)
    const before = groupSphereCounters()
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(0)
    expect(groupSphereCounters().builds).toBe(before.builds + 1) // rebuilt on the stamp

    // and back in
    for (const s of members) scene.setLocalTR(s, s * 3, 0, 30, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    scene.refitGroupBounds()
    cullViewsBrute(views, 0, 0)
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(6)
  })

  it('setGroup moving a member rebuilds BOTH groups\u2019 spheres and refreshes the pool memo', () => {
    const scene = createScene({ capacity: 32, cameraMax: 1, groupMax: 4, maxInstances: 32 })
    for (let i = 0; i < 8; i++) {
      scene.create({ position: [(i % 4) * 3, ((i / 4) | 0) * 3, 20], sphere: [0, 0, 0, 1], group: 0 })
    }
    for (let i = 0; i < 8; i++) {
      scene.create({ position: [20 + (i % 4) * 3, ((i / 4) | 0) * 3, 20], sphere: [0, 0, 0, 1], group: 1 })
    }
    scene.updateWorld()
    scene.refitGroupBounds()
    const views = scene.views
    const cam = createCamera().setPerspective(1.2, 1, 0.1, 300).setViewLookAt(10, 0, 120, 10, 0, 0, 0, 1, 0)
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    cullViewsBrute(views, 0, 1) // both buffers live (the flip-diff rhythm)
    const t0 = collectInstancesViews(views, 0, 0)
    expect(t0).toBe(16)

    // a member of group 1 joins the FAR cluster (group 2, placed out of view)
    const mover = 16 // a group-1 member slot (order may vary — find it)
    let moverSlot = -1
    for (let r = 0; r < 32; r++) {
      const s = views.order[r]
      if (s >= 0 && views.group[s] === 1) { moverSlot = s; break }
    }
    expect(moverSlot).toBeGreaterThanOrEqual(0)
    scene.setGroup(moverSlot, 0)
    scene.setLocalTR(moverSlot, 9000, 0, 20, 0, 0, 0, 1, 1, 1, 1)
    scene.updateWorld()
    scene.refitGroupBounds()
    cullViewsBrute(views, 0, 0)
    const t1 = collectInstancesViews(views, 0, 0)
    // the exact math: group 0 had 8 in view + 1 new member OUT of view = 8;
    // group 1 lost the member: 7. Total 15. The pool memo REFRESHED (the
    // Task-191 setGroup stamp) — before the fix this returned a stale 16.
    expect(t1).toBe(15)
    expect(views.instCounts[0]).toBe(8)
    expect(views.instCounts[1]).toBe(7)
    // the pre-reject state: group 0's sphere rebuilt (a member joined)
    const out = new Float32Array(32 * 16)
    expect(collectGroupMatrices(views, 0, 0, 0, out)).toBe(8)
  })

  it('the setGroup stamp: BOTH groups\u2019 groupTouch grow (the Task-85 family)', () => {
    const scene = createScene({ capacity: 8, cameraMax: 1, groupMax: 4 })
    const a = scene.create({ position: [0, 0, 0], group: 0 })
    scene.create({ position: [1, 0, 0], group: 1 })
    const before0 = scene.groupWorldStamp(0)
    const before1 = scene.groupWorldStamp(1)
    scene.setGroup(a, 2)
    expect(scene.groupWorldStamp(0)).toBeGreaterThan(before0) // the OLD group
    expect(scene.groupWorldStamp(1)).toBe(before1) // untouched group frozen
    expect(scene.groupWorldStamp(2)).toBeGreaterThan(0) // the NEW group
  })

  it('a grouped internal node\u2019s auto-bound rewrite stamps its group (the refit discipline)', () => {
    // A grouped internal node (unusual, allowed): its sphereW is an
    // auto-bound rewritten by the refit — the group's sphere must version.
    const scene = createScene({ capacity: 16, cameraMax: 1, groupMax: 2, maxInstances: 16 })
    const root = scene.create({ position: [0, 0, 40], sphere: [0, 0, 0, -1], group: 0 })
    for (let i = 0; i < 4; i++) {
      scene.create({ parent: root, position: [-30 + i * 20, 0, 0], sphere: [0, 0, 0, 2] })
    }
    scene.updateWorld()
    const stampBefore = scene.groupWorldStamp(0)
    expect(scene.refitGroupBounds()).toBe(1) // the root's bound was rebuilt
    expect(scene.groupWorldStamp(0)).toBeGreaterThan(stampBefore) // Task 191 stamp
  })

  it('randomized cameras: pre-reject parity with the kill-switch (the soundness property)', () => {
    const rng = mulberry32(202)
    for (let iter = 0; iter < 24; iter++) {
      const scene = createScene({ capacity: 96, cameraMax: 2, groupMax: 4, maxInstances: 96 })
      for (let i = 0; i < 90; i++) {
        const cluster = (rng() * 5) | 0
        const base = cluster === 4 ? 8000 : cluster * 40 - 40
        scene.create({
          position: [base + (rng() - 0.5) * 30, (rng() - 0.5) * 30, 30 + (rng() - 0.5) * 10],
          sphere: [0, 0, 0, 1 + rng() * 2],
          group: cluster === 4 ? 3 : cluster % 3,
        })
      }
      scene.updateWorld()
      scene.refitGroupBounds()
      const views = scene.views
      for (let cam = 0; cam < 2; cam++) {
        const fov = 0.4 + rng() * 1.2
        const yaw = (rng() - 0.5) * 2.4
        const camObj = createCamera().setPerspective(fov, 1, 0.1, 600)
        camObj.setViewLookAt(Math.sin(yaw) * 150, (rng() - 0.5) * 100, 180, 0, 0, 0, 0, 1, 0)
        writeCameraPlanes(views, cam, camObj.planes)
        cullViewsBrute(views, cam, 0)
        for (let g = -1; g < 4; g++) {
          const a = new Float32Array(96 * 16)
          const b = new Float32Array(96 * 16)
          const ka = collectGroupMatrices(views, cam, 0, g, a)
          setGroupSphereReject(false)
          const kb = collectGroupMatrices(views, cam, 0, g, b)
          setGroupSphereReject(true)
          expect(ka).toBe(kb) // the enclosing argument, property-checked
          for (let i = 0; i < ka * 16; i++) expect(a[i]).toBe(b[i])
        }
      }
    }
  })

  it('the kill-switch: no rejects, no builds; out-of-domain ids bypass the machinery', () => {
    const scene = buildClusters()
    const views = scene.views
    const cam = createCamera().setPerspective(1.0, 1, 0.1, 500).setViewLookAt(0, 0, 100, 0, 0, 0, 0, 1, 0)
    writeCameraPlanes(views, 0, cam.planes)
    cullViewsBrute(views, 0, 0)
    const out = new Float32Array(64 * 16)
    const before = groupSphereCounters()
    expect(collectGroupMatrices(views, 0, 0, -1, out)).toBe(0) // no group — domain bypass
    expect(collectGroupMatrices(views, 0, 0, 42, out)).toBe(0) // out of the dense ids
    expect(groupSphereCounters().checks).toBe(before.checks) // never even checked

    setGroupSphereReject(false)
    expect(collectGroupMatrices(views, 0, 0, 7, out)).toBe(0)
    expect(groupSphereCounters().rejects).toBe(before.rejects)
    expect(groupSphereCounters().builds).toBe(before.builds)
  })
})
