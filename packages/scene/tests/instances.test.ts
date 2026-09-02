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
