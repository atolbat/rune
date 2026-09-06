/** Task 143 — the word-wise collect walk's order contract (bit extraction
 *  must visit ranks in the SAME ascending order as the old rank loop). */
import { describe, expect, it } from 'bun:test'
import { createCamera, createScene, cullViewsBrute, writeCameraPlanes } from '../src/index.ts'

describe('task 143: word-wise collect walk', () => {
  it('a SPARSE visibility pattern (every other node hidden) keeps the pool in rank order', () => {
    const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 2, maxInstances: 64 })
    const slots: number[] = []
    for (let i = 0; i < 40; i++) {
      slots.push(scene.create({ position: [i * 2, 0, 0], sphere: [0, 0, 0, 0.5], group: 0 }))
    }
    scene.updateWorld()
    // Every OTHER node hidden → the bitset has single-bit gaps inside words
    // (the word-wise walk must skip them and keep the rank order).
    for (let i = 0; i < 40; i += 2) scene.setVisible(slots[i], false)
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 2000)
    cam.setViewLookAt(39, 0, 300, 39, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const total = scene.collectInstances(0)
    expect(total).toBe(20)
    const seg = scene.instances(0, { cameraIndex: 0 })
    expect(seg.count).toBe(20)
    // The ODD slots survive, in ascending rank order: world x = 2, 6, 10, ...
    for (let k = 0; k < 20; k++) {
      expect(seg.matrices[k * 16 + 12]).toBeCloseTo((2 * k + 1) * 2, 5)
    }
  })

  it('a dense-tail pattern (the last word partially filled) collects without phantom ranks', () => {
    const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 2, maxInstances: 64 })
    // 37 nodes — the last (second) word holds only 5 valid ranks; its padding
    // must never materialize as an instance (the r >= n break).
    for (let i = 0; i < 37; i++) {
      scene.create({ position: [i * 2, 0, 0], sphere: [0, 0, 0, 0.5], group: 0 })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 2000)
    cam.setViewLookAt(36, 0, 300, 36, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    expect(scene.collectInstances(0)).toBe(37)
    const seg = scene.instances(0, { cameraIndex: 0 })
    expect(seg.count).toBe(37)
    expect(seg.matrices.length).toBe(37 * 16)
  })

  it('repeated collect is idempotent (the diff epoch path does not corrupt the pool)', () => {
    const scene = createScene({ capacity: 64, cameraMax: 1, groupMax: 2, maxInstances: 64 })
    for (let i = 0; i < 24; i++) {
      scene.create({ position: [i * 2, 0, 0], sphere: [0, 0, 0, 0.5], group: 0 })
    }
    scene.updateWorld()
    const cam = createCamera().setPerspective(Math.PI / 2, 1, 0.1, 2000)
    cam.setViewLookAt(23, 0, 300, 23, 0, 0, 0, 1, 0)
    writeCameraPlanes(scene.views, 0, cam.planes)
    cullViewsBrute(scene.views, 0, 0)
    const first = scene.collectInstances(0)
    const seg1 = scene.instances(0, { cameraIndex: 0 })
    const snapshot = seg1.matrices.slice()
    const second = scene.collectInstances(0)
    const seg2 = scene.instances(0, { cameraIndex: 0 })
    expect(first).toBe(second)
    expect(seg2.count).toBe(seg1.count)
    // Pool contents identical call-to-call
    for (let i = 0; i < seg2.count * 16; i++) {
      expect(seg2.matrices[i]).toBe(snapshot[i])
    }
  })
})
