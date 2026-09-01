/**
 * webgpuScope — скоуп доступности WebGPU ДО всякой инициализации (Task 78).
 *
 * Проблема (репорт пользователя, Task 77): «navigator.gpu отсутствует» —
 * вердикт РЕНДЕР-ВОРКЕРА ложно экстраполировался на браузер. На Chrome/Android
 * WebGPU есть в главном потоке, но воркерам navigator.gpu не выдаётся. Приложению
 * нужен ответ на вопрос «где есть WebGPU» — СРАЗУ, до спавна воркеров, до
 * создания рендереров, до requestAdapter.
 *
 * Три состояния, которые хочет юзер:
 *   'main-only'  — WebGPU API есть только в главном потоке (Chrome/Android,
 *                  Safari, Firefox: воркерам navigator.gpu не выдают);
 *   'everywhere' — и в главном потоке, и в воркерах (Chrome/Edge desktop);
 *   'nowhere'    — нет нигде (браузер без WebGPU);
 *   'worker-only'— есть только в воркерах (редкая конфигурация; для полноты).
 *
 * Два яруса API:
 *   1. webgpuAvailability() — СИНХРОННЫЙ снимок фактов: main-факт мгновенно
 *      ('gpu' in navigator текущего потока), worker-факт — null, пока не
 *      выяснен. Никакой GPU-работы, безопасно на самом старте страницы.
 *   2. probeWebgpuScope() — микро-проба воркера: крошечный blob-Worker
 *      проверяет navigator.gpu и постит факт (~миллисекунды). НИКАКОЙ
 *      GPU-инициализации: ни requestAdapter, ни канвасов, ни контекстов.
 *      Результат кэшируется навсегда (окружение внутри жизни страницы не меняется).
 *
 * Скоуп — про НАЛИЧИЕ API (navigator.gpu), не про адаптер: requestAdapter →
 * null возможен и при наличии API (блок-лист GPU/драйвера, софт-рендер).
 * Проверка адаптера — отдельная история (probeWebGpu() из showOn.ts, после
 * решения о скоупе): она асинхронная и может занять секунды на SwiftShader.
 *
 * Инъекция внешних фактов: reportWebgpuWorkerFact() — когда НАСТОЯЩИЙ рендер-
 * воркер отчитался о себе (например, сообщение webgpuEnv); reportWebgpuMainFact()
 * — когда факт главного потока известен вызывающему коду (вызов из воркера/теста).
 * Факты — не догадки: скоуп никогда не додумывается за окружение.
 */

/** Где WebGPU API (navigator.gpu) фактически выдан. */
export type WebgpuScope = 'nowhere' | 'main-only' | 'worker-only' | 'everywhere'

/** Состояние микро-пробы воркера. */
export type WebgpuWorkerProbeState =
  | 'idle'        // ещё не вызывали
  | 'pending'     // воркер-проба в полёте
  | 'done'        // проба завершилась фактом
  | 'external'    // факт сообщил внешний код (reportWebgpuWorkerFact)
  | 'unsupported' // воркер не поднялся (нет Worker / Blob / CSP)
  | 'timeout'     // воркер не ответил вовремя

/** Снимок фактов о WebGPU API. Все поля — факты или null («неизвестно»). */
export interface WebgpuAvailability {
  /** navigator.gpu в главном потоке браузера; null — факт не известен
   *  (снапшот взят не в main и факт не сообщали через reportWebgpuMainFact). */
  readonly main: boolean | null
  /** navigator.gpu в DedicatedWorker'е; null — ещё не выяснен. */
  readonly worker: boolean | null
  /** Итоговый скоуп; null — недостаточно фактов (worker или main неизвестен). */
  readonly scope: WebgpuScope | null
  /** Состояние микро-пробы воркера (диагностика честности). */
  readonly workerProbe: WebgpuWorkerProbeState
  /** Снапшот взят в главном потоке браузера? (document есть только в main.) */
  readonly mainThread: boolean
  /** navigator.gpu в потоке ВЫЗОВА — мгновенный факт этого контекста. */
  readonly here: boolean
}

/** Маркер сообщения микро-пробы (по нему e2e/диагностика отличает пробу). */
export const WEBUGPU_PROBE_MARKER = '__runeWebgpuProbe'

/** Исходник микро-пробы: только факт navigator.gpu, НИКАКОЙ GPU-инициализации. */
export const WEBUGPU_PROBE_SRC =
  `self.postMessage({ ${WEBUGPU_PROBE_MARKER}: typeof navigator !== 'undefined' && navigator.gpu !== undefined })`

// ─── Факты (мгновенно, синхронно) ──────────────────────────────────────────────

/** navigator.gpu в текущем потоке. Мгновенно; согласовано с m5-render/demos:
 *  проверяем ЗНАЧЕНИЕ (gpu !== undefined), а не только наличие свойства. */
function hasGpuApiHere(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { gpu?: unknown }).gpu !== undefined
}

/** Главный поток браузера? document есть только в main (воркеры — нет). */
function isMainThreadLike(): boolean {
  return typeof document !== 'undefined'
}

// ─── Модульный кэш фактов ─────────────────────────────────────────────────────

const facts = {
  main: null as boolean | null,
  worker: null as boolean | null,
  probe: 'idle' as WebgpuWorkerProbeState,
  pending: null as Promise<WebgpuAvailability> | null,
}

/** Чистая комбинация фактов → скоуп. null = фактов не хватает. */
export function combineWebgpuScope(main: boolean | null, worker: boolean | null): WebgpuScope | null {
  if (main === null || worker === null) return null
  if (main && worker) return 'everywhere'
  if (main && !worker) return 'main-only'
  if (!main && worker) return 'worker-only'
  return 'nowhere'
}

/**
 * Синхронный снимок фактов — свойство-геттер скоупа. Мгновенно, без побочных
 * эффектов, безопасно до/без всякой инициализации. В главном потоке браузера
 * main-факт известен сразу; worker-факт появляется после probeWebgpuScope()
 * или reportWebgpuWorkerFact().
 */
export function webgpuAvailability(): WebgpuAvailability {
  const here = hasGpuApiHere()
  const mainThread = isMainThreadLike()
  // В main факт main известен из первых рук; вне main — из кэша (null, если не сообщали).
  const main = mainThread ? here : facts.main
  return {
    main,
    worker: facts.worker,
    scope: combineWebgpuScope(main, facts.worker),
    workerProbe: facts.probe,
    mainThread,
    here,
  }
}

/** Сообщить факт ГЛАВНОГО потока (для вызовов вне main и для тестов). */
export function reportWebgpuMainFact(hasApi: boolean): void {
  facts.main = hasApi
}

/**
 * Сообщить факт ВОРКЕРА извне — например, когда настоящий рендер-воркер
 * отчитался о себе сообщением. Кэшируется; следующий webgpuAvailability()
 * сразу даст скоуп без пробы. Последний факт побеждает (все источники —
 * реальные воркеры, расходиться не должны).
 */
export function reportWebgpuWorkerFact(hasApi: boolean): void {
  facts.worker = hasApi
  facts.probe = 'external'
}

// ─── Микро-проба воркера ───────────────────────────────────────────────────────

/**
 * Полный вердикт скоупа: микро-проба воркера (blob-Worker ~миллисекунды,
 * БЕЗ GPU-инициализации — только navigator.gpu) + main-факт. Идемпотентна:
 * повторные вызовы отдают кэш; параллельные — дедупятся в один воркер.
 * Неудачная проба (unsupported/timeout) не кэшируется навсегда — повторный
 * вызов может подняться.
 */
export function probeWebgpuScope(options: { readonly timeoutMs?: number } = {}): Promise<WebgpuAvailability> {
  if (facts.worker !== null) return Promise.resolve(webgpuAvailability())
  if (facts.pending !== null) return facts.pending
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    facts.probe = 'unsupported'
    return Promise.resolve(webgpuAvailability())
  }

  facts.probe = 'pending'
  const promise = new Promise<WebgpuAvailability>((resolve) => {
    let worker: Worker | null = null
    let url: string | null = null
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { worker?.terminate() } catch { /* уже мёртв */ }
      if (url !== null) { try { URL.revokeObjectURL(url) } catch { /* best effort */ } }
    }

    const timer = setTimeout(() => {
      facts.probe = 'timeout'
      finish()
      resolve(webgpuAvailability())
    }, options.timeoutMs ?? 3000)

    try {
      url = URL.createObjectURL(new Blob([WEBUGPU_PROBE_SRC], { type: 'text/javascript' }))
      worker = new Worker(url)
    } catch {
      facts.probe = 'unsupported'
      finish()
      resolve(webgpuAvailability())
      return
    }

    worker.onmessage = (event: MessageEvent) => {
      const value = (event.data as Record<string, unknown> | null)?.[WEBUGPU_PROBE_MARKER]
      if (typeof value === 'boolean') {
        facts.worker = value
        facts.probe = 'done'
      } else {
        // Воркер ответил не тем сообщением — факт не получен, честно «unsupported».
        facts.probe = 'unsupported'
      }
      finish()
      resolve(webgpuAvailability())
    }
    worker.onerror = () => {
      // Ошибка воркера ≠ «нет API» (CSP, квота blob-URL…) — не выдумываем факт.
      facts.probe = 'unsupported'
      finish()
      resolve(webgpuAvailability())
    }
  })

  facts.pending = promise
  // Успешная проба остаётся фактом навсегда (worker !== null — ранний выход выше);
  // неудачная освобождает слот: следующий вызов попробует снова.
  void promise.then(() => {
    if (facts.worker === null) facts.pending = null
  })
  return promise
}

// ─── Честные формулировки ─────────────────────────────────────────────────────

/** Человекочитаемое объяснение скоупа/фактов — от имени фактов, без экстраполяций
 *  (урок Task 77: «воркеру не выдан» ≠ «в браузере нет»). */
export function describeWebgpuScope(a: WebgpuAvailability): string {
  switch (a.scope) {
    case 'everywhere':
      return 'WebGPU API выдан везде: navigator.gpu есть и в главном потоке, и в воркерах.'
    case 'main-only':
      return 'WebGPU API только в главном потоке: воркерам navigator.gpu не выдан (Chrome на Android, Safari, Firefox). Рендер в воркере на WebGPU невозможен — там только WebGL2.'
    case 'worker-only':
      return 'WebGPU API только в воркерах: в главном потоке navigator.gpu отсутствует (редкая конфигурация).'
    case 'nowhere':
      return 'WebGPU API отсутствует и в главном потоке, и в воркерах — WebGPU в этом окружении нет.'
  }
  if (a.workerProbe === 'unsupported') {
    return 'WebGPU-скоуп неизвестен: микро-проба воркера не поднялась (Worker/Blob недоступны или CSP).'
  }
  if (a.workerProbe === 'timeout') {
    return 'WebGPU-скоуп неизвестен: микро-проба воркера не ответила вовремя.'
  }
  if (a.workerProbe === 'pending') {
    return 'WebGPU-скоуп выясняется: микро-проба воркера в полёте (миллисекунды, без GPU-инициализации).'
  }
  if (a.main === null) {
    return `WebGPU-скоуп неизвестен: факт главного потока не сообщён (снапшот взят вне main; факт текущего потока: navigator.gpu ${a.here ? 'есть' : 'нет'}).`
  }
  return `WebGPU-скоуп выяснен частично: main=${a.main ? 'yes' : 'no'}, воркер неизвестен — вызовите probeWebgpuScope().`
}

/** Сброс кэша фактов. ТОЛЬКО для тестов: продакшн-код окружение не «передумывает». */
export function _resetWebgpuScopeForTests(): void {
  facts.main = null
  facts.worker = null
  facts.probe = 'idle'
  facts.pending = null
}
