/**
 * strategy.ts — когда выносить сцену в воркер (Task 81).
 *
 * Никаких догм — только измеренные константы (bench.ts этого пакета,
 * bun 1.3.14, контейнер 4 ядра; на другом железе перекалибруйте
 * measureScenePipeline). Главные измеренные факты:
 *
 *   • грязевой конвейер почти бесплатен на покое: 100k узлов = 0.5 мс;
 *   • полный конвейер с анимацией: ~160 нс/анимируемый узел + ~5 нс/узел;
 *   • синхронизация моста (publish+take) ≈ 1 мкс — не аргумент;
 *   • НО латентность воркера (пробуждение+конвейер+опрос) 1.3–2 мс на
 *     ≤100k узлов и ~12 мс на 1M — воркер ДОРОЖЕ локального прогона по
 *     wall-clock (конвейер в потоке ~2.5× медленнее + пробуждение);
 *   • оверлап работает: при 3 мс main-работы воркер успевает в 90% кадров
 *     на ≤100k узлов, на 1M — не успевает (0%).
 *
 * Вывод (честный): воркер — НЕ про снижение латентности кадра, а про
 * освобождение main-времени, когда конвейер дороже ~1 мс И main занят
 * другой работой (рендер/GPU-сабмиты). Ниже порога — T0 локально.
 *
 * Правило честности: без SAB (изоляция не выдана) воркер сцены недоступен —
 * рекомендация T0, как в транспортной лестнице ядра (§7.2).
 */
import type { Camera } from './camera.ts'
import type { Scene } from './scene.ts'

/** Статичная часть конвейера на узел, нс (updateWorld-проверки+refit+cull). */
export const STATIC_NS_PER_NODE = 5.4

/** Анимационная часть: setLocalTR + пересчёт цепочки мира, нс/узел. */
export const ANIMATED_NS_PER_NODE = 160

/** Компакция инстанса, нс (при ~50% видимости). */
export const INSTANCE_NS = 20

/** Синхронизация моста (publish+take), мс — практически бесплатно. */
export const WORKER_SYNC_MS = 0.002

/** Конвейер в воркере медленнее локального (замерено на 100k–1M). */
export const WORKER_PIPELINE_INFLATION = 2.5

/** Минимальный выигрыш main-времени, при котором воркер «имеет смысл». */
export const MIN_GAIN_MS = 1.0

export interface SceneStrategyInputs {
  /** Живых узлов сцены. */
  readonly nodeCount: number
  /** Узлов, чей локальный TRS меняется каждый кадр. */
  readonly animatedNodes: number
  /** Видимых инстансов на кадр (все камеры). */
  readonly visibleInstances?: number
  readonly cameraCount: number
  /** Доступен ли SAB + воркер. */
  readonly workerAvailable: boolean
  /** Бюджет кадра, мс (default 16.7). */
  readonly frameBudgetMs?: number
}

export interface SceneStrategy {
  readonly offloadToWorker: boolean
  /** Честное объяснение решения (для логов/диагностики). */
  readonly reason: string
  /** Оценка main-стоимости конвейера, мс. */
  readonly estimatedPipelineMs: number
  /** Оценка времени воркера на тот же конвейер, мс. */
  readonly estimatedWorkerMs: number
}

/** Оценка стоимости конвейера (мс) по измеренной модели. */
export function estimatePipelineMs(inputs: SceneStrategyInputs): number {
  const cameras = Math.max(1, inputs.cameraCount)
  const visible = inputs.visibleInstances ?? 0
  const base =
    inputs.nodeCount * STATIC_NS_PER_NODE +
    inputs.animatedNodes * ANIMATED_NS_PER_NODE +
    visible * INSTANCE_NS
  // cull линеен по камерам, трансформы — нет.
  return (base * (1 + (cameras - 1) * 0.35)) / 1e6
}

/** Оценка: выносить ли конвейер сцены в воркер. */
export function recommendSceneStrategy(inputs: SceneStrategyInputs): SceneStrategy {
  const budget = inputs.frameBudgetMs ?? 16.7
  const pipelineMs = estimatePipelineMs(inputs)
  const workerMs = pipelineMs * WORKER_PIPELINE_INFLATION + 1.3 // + пробуждение/опрос

  if (!inputs.workerAvailable) {
    return {
      offloadToWorker: false,
      reason: 'SAB/воркер недоступны — T0-конвейер (лестница транспортов ядра)',
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  if (pipelineMs < WORKER_SYNC_MS + MIN_GAIN_MS) {
    return {
      offloadToWorker: false,
      reason: `конвейер ~${pipelineMs.toFixed(2)} мс < порога ${MIN_GAIN_MS} мс: синхронизация и латентность не окупаются, локально дешевле`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  if (workerMs > budget) {
    return {
      offloadToWorker: false,
      reason: `воркеру нужно ~${workerMs.toFixed(1)} мс > бюджет кадра ${budget} мс: поток не успевает, оверлап невозможен`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs,
    }
  }
  return {
    offloadToWorker: true,
    reason: `конвейер ~${pipelineMs.toFixed(2)} мс: воркер освобождает main (сам справляется за ~${workerMs.toFixed(1)} мс < ${budget} мс), оверлап с рендером`,
    estimatedPipelineMs: pipelineMs,
    estimatedWorkerMs: workerMs,
  }
}

/**
 * Калибровка на живой сцене: медианное время прогона конвейера (мс).
 * Используйте для авто-решения на железе пользователя.
 */
export function measureScenePipeline(
  scene: Scene,
  cameras: readonly Camera[],
  opts: { runs?: number } = {},
): number {
  const runs = opts.runs ?? 7
  scene.pack()
  // Прогрев JIT + грязи.
  for (let i = 0; i < runs; i++) {
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull(cameras)
    for (let k = 0; k < cameras.length; k++) scene.collectInstances(k)
  }
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    scene.updateWorld()
    scene.refitGroupBounds()
    scene.cull(cameras)
    for (let k = 0; k < cameras.length; k++) scene.collectInstances(k)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}
