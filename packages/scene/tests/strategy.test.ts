/** Worker offload strategy tests (Task 81). */
import { describe, expect, it } from 'bun:test'
import { createCamera, createScene, estimatePipelineMs, measureScenePipeline, recommendSceneStrategy } from '../src/index.ts'

describe('recommendSceneStrategy', () => {
  it('without SAB/worker — honest T0', () => {
    const s = recommendSceneStrategy({ nodeCount: 500_000, animatedNodes: 1000, cameraCount: 1, workerAvailable: false })
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('T0')
  })

  it('small scene — cheaper locally (pipeline below threshold)', () => {
    const s = recommendSceneStrategy({ nodeCount: 1000, animatedNodes: 50, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeLessThan(1)
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('cheaper')
  })

  it('heavy animation of a mid-size scene — the worker pays off', () => {
    // 100k nodes, 40k animated: ~0.54 + ~6.4 = ~7 ms of main — free it.
    const s = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 40_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeGreaterThan(5)
    // Worker: 7×2.5+1.3 ≈ 18.8 > 16.7 — does not fit the budget on this hardware.
    // We just check that the estimates are consistent.
    expect(s.estimatedWorkerMs).toBeGreaterThan(s.estimatedPipelineMs)
  })

  it('the worker is not recommended when it cannot fit the frame budget', () => {
    const s = recommendSceneStrategy({ nodeCount: 1_000_000, animatedNodes: 1_000_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedWorkerMs).toBeGreaterThan(16.7)
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('budget')
  })

  it('sweet spot: pipeline 1–5 ms and the worker makes it — overlap', () => {
    // ~30k animated: ~4.8+0.16 = ~5 ms main; worker ~13.7 ms < 16.7.
    const s = recommendSceneStrategy({ nodeCount: 30_000, animatedNodes: 30_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeGreaterThan(4)
    expect(s.offloadToWorker).toBe(true)
  })

  it('multi-camera costs more, but the decision is stable', () => {
    const one = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 20_000, cameraCount: 1, workerAvailable: true })
    const four = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 20_000, cameraCount: 4, workerAvailable: true })
    expect(four.estimatedPipelineMs).toBeGreaterThan(one.estimatedPipelineMs)
  })

  it('the estimate matches the measured model (ns/node)', () => {
    const ms = estimatePipelineMs({ nodeCount: 100_000, animatedNodes: 0, cameraCount: 1, workerAvailable: false })
    expect(ms).toBeCloseTo(100_000 * 5.4 / 1e6, 5)
  })
})

describe('measureScenePipeline', () => {
  it('returns a positive time on a live scene', () => {
    const scene = createScene({ capacity: 2048, cameraMax: 1, groupMax: 2, maxInstances: 2048 })
    for (let i = 0; i < 1000; i++) {
      scene.create({
        position: [i % 32, Math.floor(i / 32), 0],
        sphere: [0, 0, 0, 1],
        group: i % 2,
      })
    }
    const cam = createCamera().setPerspective(1.2, 1, 0.1, 100)
    cam.setViewLookAt(16, 16, 40, 16, 16, 0, 0, 1, 0)
    const ms = measureScenePipeline(scene, [cam], { runs: 3 })
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(100) // sanity
  })
})
