/** Instance-group and visible-matrix compaction tests (Task 81). */
import { describe, expect, it } from 'bun:test'
import { collectGroupMatrices, createCamera, createScene, cullViewsBrute, writeCameraPlanes } from '../src/index.ts'

describe('collectInstancesViews', () => {
  function build() {
    const scene = createScene({ capacity: 32, cameraMax: 1, groupMax: 4, maxInstances: 8 })
    // Group 0 — a row of cubes; group 1 — a second row; outside groups — junk.
    const g0: number[] = []
    const g1: number[] = []
    for (let i = 0; i < 6; i++) {
      g0.push(scene.create({ position: [i * 3, 0, 0], sphere: [0, 0, 0, 1], group: 0 }))
    }
    for (let i = 0; i < 4; i++) {
      g1.push(scene.create({ position: [100 + i * 3, 0, 0], sphere: [0, 0, 0, 1], group: 1 }))
    }
    scene.create({ position: [0, 50, 0], sphere: [0, 0, 0, 1] }) // without a group
    return { scene, g0, g1 }
  }

  it('matrices = worlds of visible members of the group, contiguous per group', () => {
    const { scene, g0, g1 } = build()
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    // The camera sees only the first row (group 0).
    cam.setViewLookAt(5, 0, 10, 5, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const total = scene.collectInstances(0)
    expect(total).toBe(6)
    const seg0 = scene.instances(0, { cameraIndex: 0 })
    expect(seg0.count).toBe(6)
    for (let k = 0; k < 6; k++) {
      expect(seg0.matrices[k * 16 + 12]).toBeCloseTo(k * 3, 5)
    }
    const seg1 = scene.instances(1, { cameraIndex: 0 })
    expect(seg1.count).toBe(0)
    expect(seg1.matrices.length).toBe(0)
    void g1
  })

  it('a hidden node does not get into instances', () => {
    const { scene, g0 } = build()
    scene.updateWorld()
    scene.setVisible(g0[2], false)
    const cam = createCamera().setPerspective(1.5, 1, 0.1, 100)
    cam.setViewLookAt(5, 0, 20, 5, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const total = scene.collectInstances(0)
    expect(total).toBe(5)
  })

  it('pool overflow is counted in droppedInstances', () => {
    const scene = createScene({ capacity: 16, cameraMax: 1, groupMax: 2, maxInstances: 2 })
    for (let i = 0; i < 5; i++) {
      scene.create({ position: [i, 0, 0], sphere: [0, 0, 0, 1], group: 0 })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(1.5, 1, 0.1, 100)
    cam.setViewLookAt(2, 0, 20, 2, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const before = scene.views.headerI[13] // H_DROPPED_INSTANCES
    const total = scene.collectInstances(0)
    expect(total).toBe(2)
    expect(scene.views.headerI[13]).toBe(before + 3)
  })

  it('per-camera pools do not conflict', () => {
    const scene = createScene({ capacity: 16, cameraMax: 2, groupMax: 2, maxInstances: 16 })
    for (let i = 0; i < 4; i++) {
      scene.create({ position: [i * 6, 0, 0], sphere: [0, 0, 0, 2], group: 0 })
    }
    scene.updateWorld()
    const camA = createCamera().setPerspective(0.4, 1, 0.1, 100) // narrow
    camA.setViewLookAt(0, 0, 20, 0, 0, 0, 0, 1, 0)
    const camB = createCamera().setPerspective(1.5, 1, 0.1, 100) // wide
    camB.setViewLookAt(0, 0, 20, 0, 0, 0, 0, 1, 0)
    scene.cull([camA, camB])
    scene.collectInstances(0)
    scene.collectInstances(1)
    const a = scene.instances(0, { cameraIndex: 0 })
    const b = scene.instances(0, { cameraIndex: 1 })
    expect(a.count).toBeLessThan(b.count)
    expect(a.count + b.count).toBeGreaterThan(0)
  })

  it('collectGroupMatrices — direct collection into a user array', () => {
    const { scene } = build()
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    cam.setViewLookAt(5, 0, 10, 5, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const out = new Float32Array(6 * 16)
    const k = collectGroupMatrices(scene.views, 0, 0, 0, out)
    expect(k).toBe(6)
    for (let i = 0; i < 6; i++) {
      expect(out[i * 16 + 12]).toBeCloseTo(i * 3, 5)
    }
  })
})

describe('task 186: word-blocked collectGroupMatrices', () => {
  function build6() {
    const scene = createScene({ capacity: 32, cameraMax: 1, groupMax: 4, maxInstances: 8 })
    for (let i = 0; i < 6; i++) {
      scene.create({ position: [i * 3, 0, 0], sphere: [0, 0, 0, 1], group: 0 })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 100)
    cam.setViewLookAt(5, 0, 10, 5, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    return scene
  }

  it('a truncated out stops at full-matrix capacity in rank order (no overflow)', () => {
    const scene = build6()
    const out = new Float32Array(4 * 16) // 6 visible, room for 4
    const k = collectGroupMatrices(scene.views, 0, 0, 0, out)
    expect(k).toBe(4)
    for (let i = 0; i < 4; i++) expect(out[i * 16 + 12]).toBeCloseTo(i * 3, 5)
    // the fifth member never leaks past the capacity
    expect(out[4 * 16 + 12] ?? 0).toBe(0)
  })

  it('an out not a multiple of 16 floors the capacity (a partial matrix never written)', () => {
    const scene = build6()
    const out = new Float32Array(4 * 16 + 5) // 5 spare floats — still 4 matrices
    const k = collectGroupMatrices(scene.views, 0, 0, 0, out)
    expect(k).toBe(4)
    expect(out[4 * 16 + 4]).toBe(0) // the last partial slot untouched
  })

  it('stale garbage bits beyond the node count are never collected', () => {
    // 33 live nodes → bitsWords = 2, the second word's ranks 33..63 are padding
    const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 4, maxInstances: 64 })
    for (let i = 0; i < 33; i++) {
      scene.create({ position: [i * 2, 0, 0], sphere: [0, 0, 0, 1], group: i % 3 })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(1.5, 1, 0.1, 500)
    cam.setViewLookAt(32, 0, 60, 32, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const out = new Float32Array(64 * 16)
    const kClean = collectGroupMatrices(scene.views, 0, 0, 0, out)
    // garbage: every padding bit of word 1 set (ranks 33..63)
    scene.views.bits[scene.views.bitsWords - 1] |= ~((1 << (33 - 32)) - 1) >>> 0
    const out2 = new Float32Array(64 * 16)
    const kDirty = collectGroupMatrices(scene.views, 0, 0, 0, out2)
    expect(kDirty).toBe(kClean)
    for (let i = 0; i < kClean * 16; i++) expect(out2[i]).toBe(out[i])
  })

  it('property parity with a brute reference over random bits, flags, buffers and cameras', () => {
    // reference: the OLD flat shape (rank loop, group first, bit+flag tests)
    function brute(views: ReturnType<typeof createScene>['views'], cam: number, buf: number, gid: number, o: Float32Array): number {
      const n = views.headerI[2] // H_NODE_COUNT
      const base = (buf * views.cameraMax + cam) * views.bitsWords
      let k = 0
      for (let r = 0; r < n; r++) {
        const slot = views.order[r]
        if (views.group[slot] !== gid) continue
        if ((views.bits[base + (r >>> 5)] & (1 << (r & 31))) === 0) continue
        if ((views.nodeFlags[slot] & 1) === 0) continue
        if (k * 16 + 16 > o.length) break
        for (let j = 0; j < 16; j++) o[k * 16 + j] = views.world[slot * 16 + j]
        k++
      }
      return k
    }

    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

    for (let iter = 0; iter < 6; iter++) {
      const scene = createScene({ capacity: 71, cameraMax: 2, groupMax: 5, maxInstances: 71 })
      for (let i = 0; i < 40 + ((rnd() * 30) | 0); i++) {
        scene.create({
          position: [rnd() * 10, 0, 0],
          sphere: [0, 0, 0, 0.5],
          group: rnd() < 0.15 ? -1 : ((rnd() * 5) | 0),
        })
      }
      scene.updateWorld()
      const views = scene.views
      // random visibility bits + node flags, per camera per buffer (incl. stale padding)
      for (let cam = 0; cam < 2; cam++) {
        for (let buf = 0; buf < 2; buf++) {
          const base = (buf * views.cameraMax + cam) * views.bitsWords
          for (let w = 0; w < views.bitsWords; w++) {
            views.bits[base + w] = (rnd() * 0xffffffff) >>> 0 // full words — padding too
          }
        }
      }
      for (let s = 0; s < views.capacity; s++) {
        views.nodeFlags[s] = (views.nodeFlags[s] & ~1) | (rnd() < 0.2 ? 0 : 1)
      }
      for (let buf = 0; buf < 2; buf++) {
        for (let cam = 0; cam < 2; cam++) {
          for (let g = -1; g < 5; g++) {
            const a = new Float32Array(71 * 16)
            const b = new Float32Array(71 * 16)
            const ka = collectGroupMatrices(views, cam, buf, g, a)
            const kb = brute(views, cam, buf, g, b)
            expect(ka).toBe(kb)
            for (let i = 0; i < ka * 16; i++) expect(a[i]).toBe(b[i])
          }
        }
      }
    }
  })
})
