/**
 * LossPolicy — классификация потери GPU-контекста + решение «восстанавливать?».
 *
 * Задача (Task 62): не всякая потеря устройства стоит восстановления.
 * Task 65 (soft reset): решение стало ТРЁХзначным — не только «восстанавливать
 * или нет», но и «НАСКОЛЬКО восстанавливать»:
 *
 *   • strategy='full' — обычная потеря (webglcontextlost, device.lost
 *     'destroyed'/'unknown') → replay всего журнала: ресурсы + контент.
 *   • strategy='soft' — out-of-memory → SOFT RESET: полный replay повторил
 *     бы те же аллокации и упал снова, НО восстановление ≠ «всё или ничего».
 *     Восстанавливаем ТОЛЬКО рабочее множество сцены (restore(workingSet));
 *     остальные ресурсы остаются декларациями в журнале и возвращаются
 *     ЛЕНИВО по требованию (ensureResident). На экране одна текстура —
 *     в GPU-памяти после сброса одна текстура. Если OOM повторится даже
 *     на минимальном множестве — сработает бюджет шторма (abort).
 *   • strategy='abort' — восстановление бессмысленно:
 *     - сверхтяжёлый шейдер (watchdog убил контекст): replay/ленивый путь
 *       всё равно перекомпилирует тот же шейдер при первом draw;
 *     - шторм потерь (N за окно M мс): система деградировала.
 *
 * Решение принимает decideRecovery(event, history) — чистая функция без
 * состояния; окно шторма считает createLossBudget().
 *
 * Интеграция: приложение слушает реальные события (canvas 'webglcontextlost',
 * device.lost, uncapturederror с GPUOutOfMemoryError) → формирует LossEvent →
 * decideRecovery → recover ? replay-путь (full/soft по strategy) : fatal-путь.
 */

/** Класс потери. */
export type LossKind =
  | 'context-lost'      // WebGL2: webglcontextlost (обычная, восстановимая)
  | 'device-destroyed'  // WebGPU: device.lost reason='destroyed' (ожидаемая: сами уничтожили при switch)
  | 'device-unknown'    // WebGPU: device.lost reason='unknown' (драйвер/ОС/reset)
  | 'out-of-memory'     // GL_OUT_OF_MEMORY / GPUOutOfMemoryError — аллокации не выдержит
  | 'shader-compile'    // контекст убит компиляцией сверхтяжёлого шейдера (watchdog)
  | 'loss-storm'        // слишком много потерь за короткое окно
  | 'unknown'

export type LossBackend = 'webgl2' | 'webgpu'

/** Факт потери. at — epoch ms (Date.now()). */
export interface LossEvent {
  readonly kind: LossKind
  readonly backend: LossBackend
  readonly detail?: string
  readonly at: number
}

/** Стратегия восстановления (Task 65).
 *  full — replay всего журнала; soft — только рабочее множество сцены
 *  (остальное лениво через ensureResident); abort — не восстанавливать. */
export type RecoveryStrategy = 'full' | 'soft' | 'abort'

/** Вердикт: восстанавливать ли контекст/устройство и как именно. */
export interface LossDecision {
  /** false ТОЛЬКО для strategy='abort'. Эквивалент strategy !== 'abort'. */
  readonly recover: boolean
  /** Как восстанавливать (full/soft) или отказ (abort). */
  readonly strategy: RecoveryStrategy
  readonly kind: LossKind
  readonly message: string
}

/** Порог шторма: столько потерь за окно → loss-storm. */
export const LOSS_STORM_WINDOW_MS = 10_000
export const LOSS_STORM_MAX = 3

/**
 * Решить: восстанавливаться после потери или фаталиться.
 * history — предыдущие потери (включая текущую не передаётся сюда).
 */
export function decideRecovery(event: LossEvent, history: readonly LossEvent[] = []): LossDecision {
  // Шторм: N потерь (включая текущую) за окно.
  const recent = [...history, event].filter(e => event.at - e.at <= LOSS_STORM_WINDOW_MS)
  if (recent.length >= LOSS_STORM_MAX) {
    return {
      recover: false,
      strategy: 'abort',
      kind: 'loss-storm',
      message: `Шторм потерь: ${recent.length} потерь за ${LOSS_STORM_WINDOW_MS / 1000} с — ` +
        `система деградировала (драйвер/GPU/память). Восстановление замаскирует проблему и уйдёт в цикл. ` +
        `Останавливаем рендер; перезапусти страницу или освободи память.`,
    }
  }
  switch (event.kind) {
    case 'out-of-memory':
      // Task 65 soft reset: полный replay повторил бы аллокации — но нам и не
      // нужен полный. Восстанавливаем ТОЛЬКО рабочее множество сцены; всё
      // остальное живёт в журнале декларациями и возвращается лениво
      // (ensureResident). Повторный OOM даже на минимальном множестве поймает
      // бюджет шторма выше.
      return {
        recover: true,
        strategy: 'soft',
        kind: event.kind,
        message: 'Контекст упал из-за нехватки GPU-памяти (out-of-memory). ' +
          'Полный replay повторил бы те же аллокации — вместо него SOFT RESET: ' +
          'восстанавливаю только рабочее множество сцены, остальные ресурсы ' +
          'остаются в журнале и вернутся в GPU-память лениво по требованию ' +
          '(ensureResident). Если памяти не хватает даже сцене — уменьши размер ' +
          'текстур/атласов, число целей рендера или разрешение канваса.',
      }
    case 'shader-compile':
      return {
        recover: false,
        strategy: 'abort',
        kind: event.kind,
        message: 'Контекст убит, по-видимому, компиляцией сверхтяжёлого шейдера ' +
          '(driver watchdog / переполнение). Ленивое восстановление не спасёт: ' +
          'первый же draw перекомпилирует тот же шейдер — потеря повторится. ' +
          'Упрости шейдер (меньше инструкций/циклов/семплов) и перезапусти.',
      }
    case 'context-lost':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'WebGL2-контекст потерян (обычная потеря). Восстанавливаем: replay журнала ' +
          'первичных ресурсов вернёт текстуры/цели/views и их контент.',
      }
    case 'device-destroyed':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'GPU-устройство уничтожено (ожидаемо при смене бэкенда/dispose). ' +
          'Восстанавливаем replay-ем журнала на новом устройстве.',
      }
    case 'device-unknown':
      return {
        recover: true,
        strategy: 'full',
        kind: event.kind,
        message: 'GPU-устройство потеряно по неизвестной причине (драйвер/ОС/reset). ' +
          'Пробуем восстановить replay-ем журнала; при повторе сработает бюджет шторма.',
      }
    case 'loss-storm':
      return {
        recover: false,
        strategy: 'abort',
        kind: event.kind,
        message: 'Шторм потерь устройства. Восстановление отменено.',
      }
    default:
      return {
        recover: true,
        strategy: 'full',
        kind: 'unknown',
        message: 'Потеря устройства неизвестного типа. Пробуем восстановить replay-ем журнала.',
      }
  }
}

/**
 * Бюджет шторма: скользящее окно потерь. note() фиксирует потерю,
 * storm() отвечает, достигнут ли порог. Проще, чем таскать history руками.
 */
export interface LossBudget {
  note(event: LossEvent): void
  storm(): boolean
  events(): readonly LossEvent[]
  /** Сбросить окно (например, после успешного восстановления вручную
   *  или когда симуляция кнопкой не должна считаться штормом). */
  reset(): void
}

export function createLossBudget(windowMs: number = LOSS_STORM_WINDOW_MS, maxLosses: number = LOSS_STORM_MAX): LossBudget {
  const events: LossEvent[] = []
  return {
    note(event) {
      events.push(event)
      // выкидываем всё за пределами окна (окно считаем от последнего события)
      while (events.length > 0 && event.at - events[0]!.at > windowMs) events.shift()
    },
    storm() {
      return events.length >= maxLosses
    },
    events() {
      return events.slice()
    },
    reset() {
      events.length = 0
    },
  }
}

/**
 * Классификация WebGPU uncapturederror (GPUUncapturedErrorEvent.error):
 * GPUOutOfMemoryError → 'out-of-memory'; GPUValidationError → 'unknown'
 * (валидация — баг кода, не фатальна для устройства; но если контекст уже
 * умер — классифицирует вызывающий по device.lost).
 */
export function classifyGpuError(error: unknown): LossKind {
  if (typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError) return 'out-of-memory'
  return 'unknown'
}

/** Классификация device.lost (GPUDeviceLostInfo.reason). */
export function classifyDeviceLost(reason: string | undefined): LossKind {
  if (reason === 'destroyed') return 'device-destroyed'
  return 'device-unknown'
}
