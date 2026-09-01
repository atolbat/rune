/**
 * Планировщик стриминга: двоичная куча по приоритету (теория J) +
 * AIMD-окно байтов на кадр (анти-лаг: большая загрузка растягивается
 * по кадрам, не выбивая рендер). Окно растёт с спросом (+1/8), в покое
 * мягко распускается (×7/8) — additive increase, multiplicative decay.
 *
 * Теория N (мгновенная текстура): demand-бёрст — стример поднимает окно
 * под размер текстуры (до maxBurstBytes): текстура размером до капа
 * грузится ЦЕЛИКОМ в первый idle-слот, без видимого заполнения по кадрам.
 * Инцидент-урок: разгон окна с 256 КиБ растягивал 1024² на ~10 кадров —
 * заказчик буквально видел, как текстура заполняется.
 */

export interface UploadJob {
  /** Цена задачи в байтах (окно считает байты). */
  readonly bytes: number
  /** Выше — раньше; превью обгоняет чанки на +1. */
  readonly priority: number
  run(): void
}

export interface UploadSchedulerOptions {
  readonly initialBytes?: number
  readonly minBytes?: number
  readonly maxBytes?: number
  /** Потолок demand-бёрста в байтах (default 4 МиБ). */
  readonly maxBurstBytes?: number
}

export interface UploadScheduler {
  push(job: UploadJob): void
  /** Поднять окно под разовый спрос (теория N): маленькая текстура
   * не должна стримиться по кадрам — пользователь видит заполнение. */
  burst(bytes: number): void
  /** Исполнить задачи в рамках окна; выбывающая задача закрывает кадр. */
  drain(): void
  readonly pending: number
  /** Текущее окно в байтах (диагностика). */
  readonly window: number
}

export function createUploadScheduler(options: UploadSchedulerOptions = {}): UploadScheduler {
  // Константы восстановления инцидента: initial 2 МиБ и max 16 МиБ —
  // старые значения до сброса окружения (было 256 КиБ / 8 МиБ).
  const min = options.minBytes ?? 64 * 1024
  const max = options.maxBytes ?? 16 * 1024 * 1024
  const maxBurst = options.maxBurstBytes ?? 4 * 1024 * 1024
  let window = Math.min(max, Math.max(min, options.initialBytes ?? 2 * 1024 * 1024))
  const heap: UploadJob[] = []

  /** Теория N: окно под спрос, не выше бёрст-капа и max, не ниже текущего. */
  function burst(bytes: number): void {
    window = Math.min(max, Math.max(window, Math.min(bytes, maxBurst)))
  }

  function push(job: UploadJob): void {
    heap.push(job)
    siftUp(heap.length - 1)
  }

  function drain(): void {
    let budget = window
    let executed = 0
    let closingJob = false
    while (heap.length > 0) {
      const job = heap[0]
      if (job.bytes <= budget) {
        pop()
        job.run()
        budget -= job.bytes
        executed++
      } else {
        // Не влезает в остаток окна: исполняется как выбывающая и
        // ЗАКРЫВАЕТ кадр (урок M6: continue вместо break не ограничивал байты)
        pop()
        job.run()
        executed++
        closingJob = true
        break
      }
    }
    adaptWindow(executed, closingJob)
  }

  /** AIMD: спрос двигает окно вверх, простой мягко вниз. */
  function adaptWindow(executed: number, closingJob: boolean): void {
    if (closingJob || (executed > 0 && heap.length === 0)) {
      window = Math.min(max, window + Math.max(1, Math.floor(window / 8)))
    } else if (executed === 0 && heap.length === 0) {
      window = Math.max(min, Math.floor(window * 7 / 8))
    }
  }

  function pop(): void {
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      siftDown(0)
    }
  }

  function siftUp(at: number): void {
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (heap[parent].priority >= heap[at].priority) break
      swap(parent, at)
      at = parent
    }
  }

  function siftDown(at: number): void {
    for (;;) {
      const left = at * 2 + 1
      const right = left + 1
      let best = at
      if (left < heap.length && heap[left].priority > heap[best].priority) best = left
      if (right < heap.length && heap[right].priority > heap[best].priority) best = right
      if (best === at) return
      swap(best, at)
      at = best
    }
  }

  function swap(a: number, b: number): void {
    const tmp = heap[a]
    heap[a] = heap[b]
    heap[b] = tmp
  }

  return {
    push,
    burst,
    drain,
    get pending() { return heap.length },
    get window() { return window },
  }
}
