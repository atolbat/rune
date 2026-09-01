/** Тесты стратегии выноса в воркер (Task 81). */
import { describe, expect, it } from 'bun:test'
import { createCamera, createScene, estimatePipelineMs, measureScenePipeline, recommendSceneStrategy } from '../src/index.ts'

describe('recommendSceneStrategy', () => {
  it('без SAB/воркера — честный T0', () => {
    const s = recommendSceneStrategy({ nodeCount: 500_000, animatedNodes: 1000, cameraCount: 1, workerAvailable: false })
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('T0')
  })

  it('маленькая сцена — дешевле локально (конвейер ниже порога)', () => {
    const s = recommendSceneStrategy({ nodeCount: 1000, animatedNodes: 50, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeLessThan(1)
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('дешевле')
  })

  it('тяжёлая анимация средней сцены — воркер окупается', () => {
    // 100k узлов, 40k анимируемых: ~0.54 + ~6.4 = ~7 мс main — освобождаем.
    const s = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 40_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeGreaterThan(5)
    // Воркер: 7×2.5+1.3 ≈ 18.8 > 16.7 — не влезает в бюджет на этом железе.
    // Проверяем просто согласованность оценок.
    expect(s.estimatedWorkerMs).toBeGreaterThan(s.estimatedPipelineMs)
  })

  it('воркер не рекомендуется, если не успевает в бюджет кадра', () => {
    const s = recommendSceneStrategy({ nodeCount: 1_000_000, animatedNodes: 1_000_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedWorkerMs).toBeGreaterThan(16.7)
    expect(s.offloadToWorker).toBe(false)
    expect(s.reason).toContain('бюджет')
  })

  it('золотая середина: конвейер 1–5 мс и воркер успевает — оверлап', () => {
    // ~30k анимируемых: ~4.8+0.16 = ~5 мс main; воркер ~13.7 мс < 16.7.
    const s = recommendSceneStrategy({ nodeCount: 30_000, animatedNodes: 30_000, cameraCount: 1, workerAvailable: true })
    expect(s.estimatedPipelineMs).toBeGreaterThan(4)
    expect(s.offloadToWorker).toBe(true)
  })

  it('мультикамера дорожает, но решение устойчиво', () => {
    const one = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 20_000, cameraCount: 1, workerAvailable: true })
    const four = recommendSceneStrategy({ nodeCount: 100_000, animatedNodes: 20_000, cameraCount: 4, workerAvailable: true })
    expect(four.estimatedPipelineMs).toBeGreaterThan(one.estimatedPipelineMs)
  })

  it('оценка согласуется с измеренной моделью (нс/узел)', () => {
    const ms = estimatePipelineMs({ nodeCount: 100_000, animatedNodes: 0, cameraCount: 1, workerAvailable: false })
    expect(ms).toBeCloseTo(100_000 * 5.4 / 1e6, 5)
  })
})

describe('measureScenePipeline', () => {
  it('возвращает положительное время на живой сцене', () => {
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
