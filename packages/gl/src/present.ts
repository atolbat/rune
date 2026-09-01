// Task 102 (§8-5/§8-6, DESIGN §5.5 + §9.7): present.ts — рантайм present-путей.
//
// РОДОСЛОВНАЯ. Бенч-раунд 4 (demo/bench-present.html + dist/bench-present.json)
// измерил 12 GL + 2 WebGPU пути показа кадра; DESIGN §5.5 требовал перенести их
// из бенч-артефакта в рантайм как PathRegistry — PathState (healthy/degraded/
// disabled) был «единственным действительно новым» в плане. Срез Task 97
// (fanout.ts) закрыл только фан-аут; этот модуль — полная машина:
//
//   Decay          — окно frame-time с перцентилями p50/p95 и ratio = p95/p50
//                    (§7-уточнение 1: адаптивный порог деградации Контракта 1;
//                    абсолютный maxMs остаётся потолком на стороне приложения);
//   PathRegistry   — реестр путей {requires, run, rank, pressureMax} +
//                    select(caps, pressure, filter): лучший healthy-путь;
//   PathState      — healthy → degraded (ratio ≥ 1.2) → disabled (ratio ≥ 1.5)
//                    по Decay-статистике; unavailable — по caps на select;
//                    disabled — не приговор: испытательный срок (Task 105) —
//                    прошедшее ожидание (5 с → ×2 за каждый рецидив, потолок
//                    60 с) возвращает пути свежее окно и healthy (флаппер
//                    гасится лестницей; ручной disable — навсегда; сэмплы
//                    пишутся и отключённому — статистика последнего рубежа
//                    живая, не замороженная).
//
// Task 106 (третий раунд полевого журнала Mali):
//   • ГИСТЕРЕЗИС ДАВЛЕНИЯ: ползунок, дрожащий вокруг pressureMax 0.6, метал
//     селекцию multibmp4 ↔ draw2d и пересоздавал зрителей 5 раз за 4 с
//     (смена режима канвасов 2d ↔ bitmaprenderer). Теперь путь отсекается
//     при pressure > pressureMax, а возвращается только при
//     pressure ≤ pressureMax − pressureHysteresis (0.15) — полоса
//     «придержать решение» гасит дребезг границы; applyPressure() —
//     авторитетный источник событий «отсечён/возвращён» для журнала;
//   • АБСОЛЮТНАЯ МЕДЛЕННОСТЬ: ratio слеп к равномерно-медленному пути
//     (полевой кадр: multi4 p50 70.2 / p95 70.2 · ratio 1.00 — «healthy» при
//     16 fps, потому что путь ЗАРОДИЛСЯ в джанке и чистой базы в окне нет).
//     Теперь p50 ≥ absoluteMaxMs (50 мс) на minSamples кадрах — отключение с
//     причиной «абсолютная медленность»: путь стабильно не проходит бюджет
//     кадра, даже если «ровный». Смешанные окна (p50 чистый) абсолют не
//     трогает — их ловит ratio; испытательный срок лечит и этот вердикт.
//
// КАНОНИЧЕСКИЕ РЕГИСТРАЦИИ (createPresentRegistry, §9.7): ранги откалиброваны
// bench-present.json (SwiftShader): blit 0.026 мс submit / 59.8 wall fps,
// quadcopy 0.032/56.3, direct 0.061/22.5, bitmap 0.239/22.9 (≈ direct!),
// quadpass 0.074/17.4, draw2d 0.146/13.4, multi4 0.179/12. Пример §9.7:
// «на Mali preserve p95/p50 = 3.0 ≫ 1.5 → preserve disabled, выбор уходит в
// quadpass или direct» — ровно это исполняет report() + select().
//
// ГИГИЕНА (Контракт 5): путь без run НЕ выбирается (это «знание реестра» —
// рендерер/приложение подставляет реализацию через add(), §9.8: 2 обязательных
// поля requires+run); requires-строки сверяются с caps.path() === 'supported'
// (ключи сред зондит probeEnvironmentPaths(), Task 102).

import type { Caps } from '@rune/core'
import type { AnyCanvas } from './canvasHelpers.ts'

// ─── Константы деградации (Контракт 1, §7-уточнение 1) ───────────────────────

/** Порог отключения: degradationRatio = p95/p50 ≥ 1.5 → disabled. */
export const DEGRADATION_RATIO = 1.5
/** Порог предупреждения: ratio ≥ 1.2 → degraded (путь ещё выбираем последним). */
export const DEGRADE_WARN_RATIO = 1.2
/** Окно статистики, кадров (≈2 с при 60 fps). */
export const DEGRADATION_WINDOW = 120
/** Минимум сэмплов до переходов состояния (ранняя статистика шумная). */
export const DEGRADATION_MIN_SAMPLES = 30
/**
 * Испытательный срок (Task 105, полевой фидбек Mali): через столько мс в
 * disabled путь получает повторную пробу — Decay сбрасывается, статус →
 * healthy, селекция может вернуться к нему. Причина «отсеклись при тех же
 * настройках» (ждал до ручного reset()): временный джанк/термал убивал путь
 * НАВСЕГДА, хотя среда давно нормализовалась. Ручной disable() — исключение:
 * решение оператора авто-восстановлением не оспаривается.
 */
export const DEGRADATION_RECOVERY_MS = 5000
/** Каждое повторное отключение умножает ожидание (анти-флаппер): 5 → 10 → 20 → 40 с… */
export const DEGRADATION_RECOVERY_BACKOFF = 2
/** Потолок лестницы ожидания (60 с). */
export const DEGRADATION_RECOVERY_MAX_MS = 60000
/** Шумовой порог, мс — ДВЕ стороны: p95 ниже его не может джанкнуть кадр
 * ни на 120 Гц, и СПАЙК (p95 − p50) ниже его — тоже (Task 104: мобильный
 * замер Mali — живой путь p50 6 / p95 7.4 мс давал «ratio 1.23» на джиттере
 * планировщика, ничтожном по бюджету кадра). Оба случая — ratio 1. */
export const DEGRADATION_NOISE_FLOOR_MS = 2
/**
 * Гистерезис возврата из-под давления (Task 106, полевой журнал Mali):
 * отсечение — при pressure > pressureMax, возврат в выбор — только при
 * pressure ≤ pressureMax − ГИСТЕРЕЗИС. Ползунок, дрожащий вокруг границы
 * (0.6 ↔ 0.7), прежде метал селекцию и пересоздавал зрителей-канвасы
 * 5 раз за 4 секунды; теперь в полосе [max − hyst, max] путь держит
 * прежнее решение. 0 — прежняя мгновенная семантика.
 */
export const PRESSURE_HYSTERESIS = 0.15
/**
 * Абсолютный потолок p50, мс (Task 106): путь, у которого МЕДИАНА кадра
 * стабильно выше этого порога, отключается «абсолютной медленностью» —
 * ratio-детектор слеп к равномерно-медленному пути (p95/p50 = 1.00 при
 * p50 70 мс — полевой кадр multi4, 16 fps «healthy»). Смешанные окна
 * (чистый p50 + джанковый p95) абсолют не трогает — их ловит ratio.
 * Infinity — выключить вердикт.
 */
export const DEGRADATION_ABSOLUTE_MS = 50

// ─── Decay — окно frame-time с перцентилями ──────────────────────────────────

export interface DecayStats {
  readonly count: number
  readonly p50: number
  readonly p95: number
  /** p95/p50; p50=0 (квантование таймера) → знаменатель 1 мс; p95 или спайк
   * (p95 − p50) ниже шумового порога → 1 (джанк невозможен, ratio — шум
   * измерений, а не сигнал пути). */
  readonly ratio: number
}

export interface DecayWindow {
  push(ms: number): void
  reset(): void
  stats(): DecayStats
}

/**
 * Скользящее окно времени кадра (nearest-rank перцентили). ratio ловит
 * деградацию ОТНОСИТЕЛЬНО vsync-насыщения (§4 addendum): путь со стабильными
 * 12 мс не деградировал, путь с p50 0.2 / p95 0.6 — деградировал, хотя оба
 * далеки от абсолютного потолка. Три предохранителя от ложных срабатываний:
 *   1. p95 < noiseFloorMs (default 2 мс) → ratio 1: спайк ниже порога не
 *      съедает значимую долю кадрового бюджета ни на 60, ни на 120 Гц —
 *      такие «ratio» измеряют таймер, а не путь (опыт Task 102: SwiftShader
 *      draw2d p50 0.1/p95 0.5 мс → «ratio 5» без какого-либо джанка);
 *   2. p95 − p50 < noiseFloorMs → ratio 1 (Task 104): ДЕЛЬТА спайка важнее
 *      абсолюта — путь с p50 6 / p95 7.4 мс не джанкнет ни одного кадра,
 *      «ratio 1.23» на нём — джиттер планировщика/таймера, а не деградация
 *      (замер на Mali: каскад отключал живые пути именно по этому шуму);
 *   3. p50 = 0 (таймер среды квантован) → знаменатель 1 мс.
 * Приложения, ищущие деградацию на более высоких частотах, понижают порог
 * через createDecayWindow(size, noiseFloorMs) / PathRegistryOptions.
 */
export function createDecayWindow(size = DEGRADATION_WINDOW, noiseFloorMs = DEGRADATION_NOISE_FLOOR_MS): DecayWindow {
  const samples: number[] = []
  return {
    push(ms) {
      samples.push(ms)
      if (samples.length > size) samples.shift()
    },
    reset() {
      samples.length = 0
    },
    stats() {
      const n = samples.length
      if (n === 0) return { count: 0, p50: 0, p95: 0, ratio: 1 }
      const sorted = [...samples].sort((a, b) => a - b)
      const at = (q: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]!
      const p50 = at(0.5)
      const p95 = at(0.95)
      if (p95 < noiseFloorMs) return { count: n, p50, p95, ratio: 1 }
      if (p95 - p50 < noiseFloorMs) return { count: n, p50, p95, ratio: 1 } // дельта-спайка — шум
      const denominator = p50 > 0 ? p50 : 1
      const ratio = p95 > 0 ? p95 / denominator : 1
      return { count: n, p50, p95, ratio }
    },
  }
}

// ─── Спецификация пути и контекст показа ─────────────────────────────────────

/** Чем исполняется показ; источник-канвас + зрители (+ инъекции для GL/WebGPU-путей). */
export interface PresentContext {
  /** Канвас-источник кадра (канвас рендерера / OffscreenCanvas). */
  readonly source: AnyCanvas
  /** Канвасы-зрители (для кросс-канвасных путей). */
  readonly targets: readonly AnyCanvas[]
  /** GL-контекст источника — для GL-внутренних путей (blit/quad…). */
  readonly gl?: WebGL2RenderingContext | null
  /** WebGPU-устройство + контекст webgpu-канваса — для wgpu-copy. */
  readonly gpu?: PresentGpu | null
  /** Время (с), если пути нужна анимация. */
  readonly time?: number
}

/** Минимальный WebGPU-хвост PresentContext (реальные device/context подходят). */
export interface PresentGpu {
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
}

/** Показ одного кадра. Асинхронные пути (createImageBitmap) возвращают Promise. */
export type PresentRun = (ctx: PresentContext) => void | Promise<void>

/** Требования пути: ключ caps.path (или список — все обязательны) либо предикат. */
export type PresentRequires = string | readonly string[] | ((caps: Caps) => boolean)

export interface PresentPathSpec {
  /** Требования среды/бэкенда; undefined — всегда доступен. */
  readonly requires?: PresentRequires
  /** Реализация показа; без run путь не выбирается (знание реестра, §9.8). */
  readonly run?: PresentRun
  /** Предпочтение: меньше ранг — выбирается раньше. Default — порядок add(). */
  readonly rank?: number
  /** Путь допустим только при pressure ≤ pressureMax (0..1; default 1). */
  readonly pressureMax?: number
  /** Семья путей для UI/отчётов: 'GL' | 'Canvas2D' | 'Bitmap' | 'WebGPU' | … */
  readonly group?: string
  /** Капризы пути (S1/S2/S3 из §9.7) + бенч-цифры — человекочитаемо. */
  readonly note?: string
}

// ─── PathState ────────────────────────────────────────────────────────────────

export type PresentPathStatus = 'healthy' | 'degraded' | 'disabled' | 'unavailable'

/** Снимок состояния пути (UI, debug, e2e). */
export interface PresentPathState {
  readonly name: string
  readonly status: PresentPathStatus
  /** Почему не healthy: 'requirements: …' | 'degradation: …' | 'manual' | … */
  readonly reason: string | null
  readonly rank: number
  readonly group: string
  readonly note: string | null
  readonly pressureMax: number
  /** Путь придержан гистерезисом давления (последний select/applyPressure
   * резал его по pressureMax и давление ещё не спало до возвратной границы) —
   * честный источник для UI-бейджа «отсечён давлением» (Task 106). */
  readonly pressureCut: boolean
  readonly hasRun: boolean
  readonly p50: number
  readonly p95: number
  readonly ratio: number
  readonly samples: number
}

/** Результат select(). */
export interface PathSelection {
  readonly name: string
  readonly run: PresentRun
  readonly state: PresentPathState
}

export interface SelectOptions {
  /** Структурный фильтр приложения: false → путь пропущен (сценарий не его). */
  readonly filter?: (name: string) => boolean
  /** Разрешить выбор путей без run (по умолчанию они пропускаются). */
  readonly includeRunless?: boolean
  /** Последний рубеж (Task 104): healthy/degraded исчерпаны → вернуть ЛУЧШИЙ
   * disabled-путь вместо null — показ важнее качества (карточка честно
   * показывает статус disabled; unavailable и pressure-гейт НЕ обходятся —
   * недоступное не заработает, а дорогое под давлением включать нельзя). */
  readonly lastResort?: boolean
  /** Операторское перекрытие (форс): гейт давления НЕ применяется к выбору
   * (явный выбор оператора важнее политики приложения — Task 105), но
   * гистерезисные флаги продолжают обновляться по реальному pressure,
   * чтобы после снятия форсажа состояние не было сюрпризом (Task 106). */
  readonly ignorePressure?: boolean
}

/** Событие гистерезисного гейта давления (applyPressure, Task 106). */
export interface PressureGateTransition {
  readonly name: string
  /** cut — путь придержан (pressure > pressureMax);
   *  returned — возвращён в выбор (давление спало до возвратной границы). */
  readonly to: 'cut' | 'returned'
}

export interface PathRegistryOptions {
  readonly window?: number
  readonly minSamples?: number
  readonly warnRatio?: number
  readonly disableRatio?: number
  /** Шумовой порог Decay, мс (см. createDecayWindow). */
  readonly noiseFloorMs?: number
  /**
   * Испытательный срок отключённого пути, мс (default 5000). Срабатывает
   * в select() — селекция и есть сердце машины: пока её зовут каждый кадр,
   * отключённые пути ре-армятся сами. Infinity — прежняя семантика «отключён
   * навсегда до reset()»; 0 — мгновенная проба на каждом select (флаппер —
   * на совести вызвавшего).
   */
  readonly recoveryMs?: number
  /** Множитель ожидания на каждое повторное отключение (default 2). */
  readonly recoveryBackoff?: number
  /** Потолок лестницы ожидания, мс (default 60 000). */
  readonly recoveryMaxMs?: number
  /** Гистерезис возврата из-под давления (default 0.15; 0 — мгновенный
   * возврат, прежняя семантика). См. PRESSURE_HYSTERESIS. */
  readonly pressureHysteresis?: number
  /** Абсолютный потолок p50, мс (default 50; Infinity — выключить вердикт
   * «абсолютная медленность»). См. DEGRADATION_ABSOLUTE_MS. */
  readonly absoluteMaxMs?: number
  /** Часы для лестницы восстановления (тесты); default performance.now(). */
  readonly now?: () => number
  /** Телеметрия переходов статуса (лог/UI/метрика): вызывается ТОЛЬКО при
   * изменении статуса пути — с полным снимком статистики на момент перехода
   * (p50/p95/ratio/сэмплы/причина). Идеальная точка для журнала деградации. */
  readonly onTransition?: (transition: PathTransition) => void
}

/** Переход статуса пути (для onTransition-телеметрии). */
export interface PathTransition {
  readonly name: string
  readonly from: PresentPathStatus
  readonly to: PresentPathStatus
  /** Снимок на момент ПОСЛЕ перехода (reason объясняет «почему»). */
  readonly state: PresentPathState
}

export interface PathRegistry {
  /** Зарегистрировать/заменить путь (замена сбрасывает состояние). §9.8: ≤6 строк. */
  add(name: string, spec: PresentPathSpec): void
  remove(name: string): void
  /** Лучший healthy-путь (degraded — когда healthy нет; disabled/unavailable — никогда).
   *  Заодно — сердце восстановления: каждый вызов ре-армит отключённые пути,
   *  прошедших испытательный срок (recoveryMs), и обновляет гистерезисные
   *  флаги давления по переданному pressure. */
  select(caps: Caps, pressure?: number, options?: SelectOptions): PathSelection | null
  /** Авторитетный гейт давления (Task 106): обновить флаги давления всех
   *  путей с гистерезисом и вернуть переходы (кто отсечён/возвращён) —
   * для журнала/UI; select() с тем же pressure — idempotent. */
  applyPressure(pressure: number): readonly PressureGateTransition[]
  /** Покормить Decay пути реальным временем показа, мс (пишется и disabled —
   *  живая статистика последнего рубежа; вердикт — до срока/reset). */
  report(name: string, frameMs: number): void
  /** Ручное отключение (перекрытие решением оператора): без причины — навсегда,
   *  с причиной — подлежит испытательному сроку. */
  disable(name: string, reason?: string): void
  /** Ре-арм: сброс Decay + статуса + лестницы испытательных сроков (все пути или один). */
  reset(name?: string): void
  status(name: string): PresentPathState
  /** Все пути по рангу. */
  snapshot(): readonly PresentPathState[]
  readonly names: readonly string[]
}

interface Entry {
  name: string
  spec: PresentPathSpec
  rank: number
  status: PresentPathStatus
  reason: string | null
  decay: DecayWindow
  /** Момент (now()) перевода в disabled; null — ручное отключение навсегда. */
  disabledAt: number | null
  /** Текущее ожидание до испытательного срока (растёт с повторами). */
  cooldownMs: number
  /** Сколько испытательных сроков путь уже получал (лестница ожидания). */
  probations: number
  /** Путь придержан давлением с гистерезисом (Task 106): true, пока
   *  давление не спадёт до pressureMax − pressureHysteresis. */
  pressureCut: boolean
}

function requirementsCheck(spec: PresentPathSpec, caps: Caps): { ok: boolean; reason?: string } {
  const requires = spec.requires
  if (requires === undefined) return { ok: true }
  if (typeof requires === 'function') {
    return requires(caps) ? { ok: true } : { ok: false, reason: 'предикат requires вернул false' }
  }
  const keys = typeof requires === 'string' ? [requires] : requires
  const failed = keys.filter(key => caps.path(key) !== 'supported')
  return failed.length === 0
    ? { ok: true }
    : { ok: false, reason: `caps.path(${failed.join(', ')}) ≠ 'supported'` }
}

/** 2d-контекст цели (HTMLCanvasElement | OffscreenCanvas — оба умеют drawImage). */
function ctx2dOf(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
  if (ctx === null) {
    throw new Error("rune: present — getContext('2d') на цели вернул null (тип контекста цели уже занят). Используйте свежий канвас.")
  }
  return ctx
}

function bitmapCtxOf(canvas: AnyCanvas): ImageBitmapRenderingContext {
  const ctx = (canvas as HTMLCanvasElement).getContext('bitmaprenderer') as ImageBitmapRenderingContext | null
  if (ctx === null) {
    throw new Error("rune: present — getContext('bitmaprenderer') на цели вернул null (тип контекста цели уже занят). Используйте mode '2d'-пути.")
  }
  return ctx
}

function firstTarget(ctx: PresentContext): AnyCanvas {
  const target = ctx.targets[0]
  if (target === undefined) {
    throw new Error('rune: present — PresentContext.targets пуст (нужен хотя бы один зритель)')
  }
  return target
}

function oneTarget(ctx: PresentContext): AnyCanvas {
  if (ctx.targets.length > 1) {
    throw new Error(`rune: present — ровно один зритель (получено ${ctx.targets.length}): transferFromImageBitmap потребляет ImageBitmap. Для N зрителей — multibmp4/draw-пути.`)
  }
  return firstTarget(ctx)
}

function drawTo2d(source: CanvasImageSource & { readonly width: number; readonly height: number }, target: AnyCanvas): void {
  ctx2dOf(target).drawImage(source, 0, 0, target.width, target.height)
}

// ─── Реестр ───────────────────────────────────────────────────────────────────

export function createPathRegistry(options: PathRegistryOptions = {}): PathRegistry {
  const windowSize = options.window ?? DEGRADATION_WINDOW
  const minSamples = options.minSamples ?? DEGRADATION_MIN_SAMPLES
  const warnRatio = options.warnRatio ?? DEGRADE_WARN_RATIO
  const disableRatio = options.disableRatio ?? DEGRADATION_RATIO
  const noiseFloorMs = options.noiseFloorMs ?? DEGRADATION_NOISE_FLOOR_MS
  const onTransition = options.onTransition
  const recoveryMs = options.recoveryMs ?? DEGRADATION_RECOVERY_MS
  const recoveryBackoff = options.recoveryBackoff ?? DEGRADATION_RECOVERY_BACKOFF
  const recoveryMaxMs = options.recoveryMaxMs ?? DEGRADATION_RECOVERY_MAX_MS
  const pressureHysteresis = options.pressureHysteresis ?? PRESSURE_HYSTERESIS
  const absoluteMaxMs = options.absoluteMaxMs ?? DEGRADATION_ABSOLUTE_MS
  const now = options.now ?? (() => performance.now())

  const entries = new Map<string, Entry>()
  let nextDefaultRank = 1000

  /** Гистерезисный гейт давления (Task 106): состояние — часть пути
   * (sticky-флаг), решение меняется только за границей полосы.
   * Возвращает переход, если решение сменилось (null — нет). */
  const pressureGate = (entry: Entry, pressure: number): PressureGateTransition | null => {
    const max = entry.spec.pressureMax ?? 1
    const before = entry.pressureCut
    if (pressure > max) entry.pressureCut = true
    else if (pressure <= max - pressureHysteresis) entry.pressureCut = false
    // в полосе (max − hyst, max] решение держится прежним — дребезг границы
    // больше не переключает селекцию туда-обратно (полевой журнал Mali)
    return before === entry.pressureCut
      ? null
      : { name: entry.name, to: entry.pressureCut ? 'cut' : 'returned' }
  }

  /** Лестница ожидания: база × backoff^испытаний, с потолком. Infinity — навсегда. */
  const armCooldown = (entry: Entry): void => {
    if (!Number.isFinite(recoveryMs)) {
      entry.cooldownMs = Number.POSITIVE_INFINITY
      return
    }
    entry.cooldownMs = Math.min(recoveryMs * Math.pow(recoveryBackoff, entry.probations), recoveryMaxMs)
  }

  const asState = (entry: Entry): PresentPathState => {
    const stats = entry.decay.stats()
    return {
      name: entry.name,
      status: entry.status,
      reason: entry.reason,
      rank: entry.rank,
      group: entry.spec.group ?? '',
      note: entry.spec.note ?? null,
      pressureMax: entry.spec.pressureMax ?? 1,
      pressureCut: entry.pressureCut,
      hasRun: entry.spec.run !== undefined,
      p50: stats.p50,
      p95: stats.p95,
      ratio: stats.ratio,
      samples: stats.count,
    }
  }

  /** Смена статуса с телеметрией: повторная установка того же статуса только
   * обновляет reason (например, свежий ratio у degraded) — переход не событие. */
  const setStatus = (entry: Entry, to: PresentPathStatus, reason: string | null): void => {
    const from = entry.status
    entry.reason = reason
    if (from === to) return
    entry.status = to
    onTransition?.({ name: entry.name, from, to, state: asState(entry) })
  }

  const sorted = (): Entry[] => [...entries.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))

  return {
    add(name, spec) {
      if (name.length === 0) throw new Error('rune: present — имя пути пустое')
      const rank = spec.rank ?? nextDefaultRank
      if (spec.rank === undefined) nextDefaultRank++
      entries.set(name, {
        name,
        spec,
        rank,
        status: 'healthy',
        reason: null,
        decay: createDecayWindow(windowSize, noiseFloorMs),
        disabledAt: null,
        cooldownMs: recoveryMs,
        probations: 0,
        pressureCut: false,
      })
    },
    remove(name) {
      entries.delete(name)
    },
    select(caps, pressure = 0, options) {
      // −1) Испытательный срок (Task 105): degradation-отключение — не приговор.
      // Прошедшему ожидание пути — свежее окно и healthy: среда могла
      // нормализоваться (джанк ушёл, термал отпустил, вкладка одна). Ре-деградация
      // вернёт disabled с удвоенным ожиданием — флаппер гасится лестницей.
      // Ручное отключение (disabledAt === null) не оживает никогда.
      for (const entry of entries.values()) {
        if (entry.status !== 'disabled' || entry.disabledAt === null) continue
        if (now() - entry.disabledAt < entry.cooldownMs) continue
        const waitedMs = entry.cooldownMs
        entry.probations++
        entry.disabledAt = null
        entry.decay.reset()
        setStatus(entry, 'healthy', `испытательный срок №${entry.probations}: повторная проба после ${(waitedMs / 1000).toFixed(waitedMs % 1000 === 0 ? 0 : 1)} с отключения (авто-восстановление)`)
      }
      // 0) Доступность ВСЕХ путей перевычисляется по текущему caps: путь,
      // помеченный unavailable на прошлом select, оживает после
      // invalidate()/re-probe — и наоборот. Снимок snapshot() остаётся
      // честным для путей ниже точки выбора.
      for (const entry of entries.values()) {
        const check = requirementsCheck(entry.spec, caps)
        if (!check.ok) {
          setStatus(entry, 'unavailable', `requirements: ${check.reason}`)
        } else if (entry.status === 'unavailable') {
          setStatus(entry, 'healthy', null)
        }
      }
      const eligible = (entry: Entry): boolean =>
        entry.spec.run !== undefined || options?.includeRunless === true
      // Гейт давления — гистерезисный sticky-флаг (обновляется выше по
      // реальному pressure всегда, даже под ignorePressure); ignorePressure
      // (форс оператора) обходит только ПРИМЕНЕНИЕ гейта к выбору.
      for (const entry of entries.values()) pressureGate(entry, pressure)
      const passes = (entry: Entry): boolean =>
        options?.filter?.(entry.name) !== false && (options?.ignorePressure === true || !entry.pressureCut)
      // 1) Два прохода выбора: сначала healthy, затем degraded (последний
      // шанс). disabled/unavailable не выбираются никогда.
      for (const allowDegraded of [false, true]) {
        for (const entry of sorted()) {
          if (entry.status === 'disabled' || entry.status === 'unavailable') continue
          if (entry.status === 'degraded' && !allowDegraded) continue
          if (!eligible(entry) || !passes(entry)) continue
          return { name: entry.name, run: entry.spec.run!, state: asState(entry) }
        }
      }
      // 2) Последний рубеж (Task 104): живых нет — лучший disabled вместо null.
      // unavailable не оживает от повторного выбора, а pressure-гейт — политика
      // приложения, её не обходим. Статус в state честный: потребитель сам
      // решает, светить «последний рубеж» или останавливаться.
      if (options?.lastResort === true) {
        for (const entry of sorted()) {
          if (entry.status !== 'disabled') continue
          if (!eligible(entry) || !passes(entry)) continue
          return { name: entry.name, run: entry.spec.run!, state: asState(entry) }
        }
      }
      return null
    },
    applyPressure(pressure) {
      // Авторитетный источник событий давления для журнала/UI: та же машина,
      // что и в select() — повторный вызов с тем же pressure ничего не меняет.
      const transitions: PressureGateTransition[] = []
      for (const entry of entries.values()) {
        const transition = pressureGate(entry, pressure)
        if (transition !== null) transitions.push(transition)
      }
      return transitions
    },
    report(name, frameMs) {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.report — путь «${name}» не зарегистрирован`)
      // Сэмпл пишется ДАЖЕ отключённому: путь последнего рубежа исполняется
      // каждый кадр — его карточка обязана показывать ЖИВОЕ время, а не снимок
      // момента отключения (полевой фидбек: «p95 35 мс» у пути, идущего 0.2 мс).
      // Вердикт при этом sticky: статус меняют только испытательный срок/reset.
      entry.decay.push(frameMs)
      if (entry.status === 'disabled') return
      const stats = entry.decay.stats()
      if (stats.count >= minSamples && stats.ratio >= disableRatio) {
        armCooldown(entry)
        entry.disabledAt = now()
        setStatus(entry, 'disabled', `degradation: p95/p50 = ${stats.ratio.toFixed(2)} ≥ ${disableRatio} (${stats.count} кадров)`)
        return
      }
      // Абсолютная медленность (Task 106): ratio слеп к равномерно-медленному
      // пути (p95/p50 = 1.00 при p50 70 мс — путь родился в джанке, чистой
      // базы в окне нет). МЕДИАНА вне бюджета — вердикт независимо от ratio;
      // смешанные окна (чистый p50) сюда не попадают — их ловит ratio выше.
      if (stats.count >= minSamples && stats.p50 >= absoluteMaxMs) {
        armCooldown(entry)
        entry.disabledAt = now()
        setStatus(entry, 'disabled', `абсолютная медленность: p50 ${stats.p50.toFixed(1)} мс ≥ ${absoluteMaxMs} мс (${stats.count} кадров) — стабильно вне бюджета кадра`)
        return
      }
      if (stats.count >= minSamples && stats.ratio >= warnRatio) {
        setStatus(entry, 'degraded', `degradation: p95/p50 = ${stats.ratio.toFixed(2)} ≥ ${warnRatio} (предупреждение)`)
        return
      }
      // Полное чистое окно после испытательного срока — лестница ожидания
      // начинается заново: устойчивое здоровье = чистая репутация.
      if (entry.probations > 0 && stats.count >= windowSize) entry.probations = 0
      setStatus(entry, 'healthy', null)
    },
    disable(name, reason = 'manual') {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.disable — путь «${name}» не зарегистрирован`)
      // Ручное отключение (вызов без причины) — навсегда: оператор знает лучше.
      // Отключение С причиной (ошибка исполнения, решение рендерера) — временный
      // вердикт: путь получит испытательный срок по общей лестнице — ошибка
      // могла быть транзитной (давление памяти на мобильном прошло).
      entry.disabledAt = reason === 'manual' ? null : now()
      armCooldown(entry)
      setStatus(entry, 'disabled', reason)
    },
    reset(name) {
      for (const entry of entries.values()) {
        if (name !== undefined && entry.name !== name) continue
        entry.decay.reset()
        entry.disabledAt = null
        entry.cooldownMs = recoveryMs
        entry.probations = 0
        setStatus(entry, 'healthy', null)
      }
    },
    status(name) {
      const entry = entries.get(name)
      if (entry === undefined) throw new Error(`rune: present.status — путь «${name}» не зарегистрирован`)
      return asState(entry)
    },
    snapshot() {
      return sorted().map(asState)
    },
    get names() {
      return sorted().map(entry => entry.name)
    },
  }
}

// ─── Канонические регистрации (§9.7: 12 GL + 2 WebGPU + деградационные ступени) ─

/**
 * Реестр канонических present-путей (§9.7). Ранги — бенч SwiftShader
 * (bench-present.json): меньше ранг — дешевле/предпочтительнее.
 *
 * GL-внутренние пути (blit/quadcopy/quadpass/uvremap) регистрируются БЕЗ run:
 * их исполнение живёт в рендерере (поверхность/цель) — приложение подставляет
 * свою реализацию через `paths.add(name, { requires, run })` (§9.8, ≤6 строк),
 * сохраняя ранги/состояния реестра. Кросс-канвасные пути исполняются здесь.
 */
export function createPresentRegistry(options?: PathRegistryOptions): PathRegistry {
  const registry = createPathRegistry(options)

  // Промежуточный ½-канвас для draw2d-half — ленивый, на замыкании реестра.
  let halfBuffer: { canvas: HTMLCanvasElement | OffscreenCanvas; w: number; h: number } | null = null
  const halfCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
    if (halfBuffer === null || halfBuffer.w !== w || halfBuffer.h !== h) {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      halfBuffer = { canvas, w, h }
    }
    return halfBuffer.canvas
  }

  registry.add('direct', {
    requires: 'canvas-direct',
    rank: 10,
    group: 'GL',
    run: () => { /* источник сам видимый канвас — рендер уже показан (S3: premultiplied) */ },
    note: 'рендер прямо в видимый канвас, ноль копий (бенч: 0.061 мс submit / 22.5 fps). S3: premultiplied-гигиена контекста',
  })
  registry.add('wgpu-direct', {
    requires: 'WebGPU',
    rank: 15,
    group: 'WebGPU',
    run: () => { /* пасс пишет прямо в текстуру webgpu-канваса */ },
    note: 'WebGPU: пасс прямо в текстуру канваса. S1: configure(alphaMode)',
  })
  registry.add('blit', {
    requires: 'blit',
    rank: 20,
    group: 'GL',
    note: 'gl.blitFramebuffer без шейдера — самый дешёвый (бенч: 0.026 мс / 59.8 fps). S1: ANGLE BGRA-mismatch. Исполнение — рендерер, подставьте run через add()',
  })
  registry.add('wgpu-copy', {
    requires: 'WebGPU.copyExternalImage',
    rank: 25,
    group: 'WebGPU',
    run: ctx => {
      const gpu = ctx.gpu
      if (gpu === null || gpu === undefined) {
        throw new Error('rune: present wgpu-copy — PresentContext.gpu не задан (WebGPU device + контекст webgpu-канваса)')
      }
      gpu.device.queue.copyExternalImageToTexture(
        { source: ctx.source },
        { texture: gpu.context.getCurrentTexture() },
        [ctx.source.width, ctx.source.height],
      )
    },
    note: 'queue.copyExternalImageToTexture: внешний кадр (GL-канвас) → текстура webgpu-канваса. S1: flipY/premultiplied',
  })
  registry.add('quadcopy', {
    requires: 'canvas-direct',
    rank: 30,
    group: 'GL',
    note: 'копия сэмпл-шейдером текстура→текстура (бенч: 0.032 мс / 56.3 fps). S2: copy-шейдер. Исполнение — рендерер, подставьте run через add()',
  })
  registry.add('quadpass', {
    requires: 'canvas-direct',
    rank: 40,
    group: 'GL',
    note: 'сцена в FBO-текстуру + квад-проход на канвас — путь rune (бенч: 0.074 мс / 17.4 fps). S2: pass vert-шейдер. Исполнение — рендерер, подставьте run через add()',
  })
  registry.add('uvremap', {
    requires: 'canvas-direct',
    rank: 45,
    group: 'GL',
    note: 'квад с UV-ремапом (атлас-вью). S2: UV-remap шейдер. Исполнение — рендерер, подставьте run через add()',
  })
  registry.add('bitmap', {
    requires: ['OffscreenCanvas', 'transferToImageBitmap', 'bitmaprenderer'],
    rank: 50,
    group: 'Bitmap',
    run: ctx => {
      const target = oneTarget(ctx)
      bitmapCtxOf(target).transferFromImageBitmap((ctx.source as OffscreenCanvas).transferToImageBitmap())
    },
    note: 'transferToImageBitmap → bitmaprenderer, ноль CPU-копии (бенч: 22.9 fps ≈ direct 22.5!). S1: источник OffscreenCanvas, ровно 1 зритель',
  })
  registry.add('asyncbmp', {
    requires: ['createImageBitmap', 'bitmaprenderer'],
    rank: 55,
    group: 'Bitmap',
    run: async ctx => {
      const target = oneTarget(ctx)
      const bitmap = await createImageBitmap(ctx.source as CanvasImageSource)
      try {
        bitmapCtxOf(target).transferFromImageBitmap(bitmap)
      } finally {
        bitmap.close() // перенесённый битмап уже закрыт (no-op); при сбое переноса — не течём
      }
    },
    note: 'await createImageBitmap → bitmaprenderer (бенч: 15.9 fps). S1: асинхронность, ровно 1 зритель',
  })
  registry.add('multibmp4', {
    requires: ['createImageBitmap', 'bitmaprenderer'],
    rank: 58,
    group: 'Bitmap',
    pressureMax: 0.6,
    run: async ctx => {
      const bitmaps = await Promise.all(ctx.targets.map(() => createImageBitmap(ctx.source as CanvasImageSource)))
      try {
        for (let i = 0; i < ctx.targets.length; i++) {
          bitmapCtxOf(ctx.targets[i]!).transferFromImageBitmap(bitmaps[i]!)
        }
      } finally {
        // перенесённые битмапы уже закрыты (close на закрытом — no-op);
        // НЕ перенесённые (сбой на середине) закрываем руками — без утечки
        for (const bitmap of bitmaps) bitmap.close()
      }
    },
    note: 'N × createImageBitmap параллельно → N bitmaprenderer (бенч multibmp4: 15.5 fps). S1: N битмапов; pressureMax 0.6 — дорогой при давлении',
  })
  registry.add('draw2d', {
    requires: 'Canvas2D',
    rank: 70,
    group: 'Canvas2D',
    run: ctx => {
      drawTo2d(ctx.source, firstTarget(ctx))
    },
    note: 'drawImage источник → первый зритель (бенч: 13.4 fps). S1+S3: Canvas2D-ветка, alpha-канал',
  })
  registry.add('multi4', {
    requires: 'Canvas2D',
    rank: 72,
    group: 'Canvas2D',
    pressureMax: 0.6,
    run: ctx => {
      for (const target of ctx.targets) drawTo2d(ctx.source, target)
    },
    note: 'drawImage × N зрителей (бенч multi4: 12 fps — −4 fps за 4 копии). S1: N 2d-контекстов; pressureMax 0.6',
  })
  registry.add('preserve', {
    requires: ['preserve', 'Canvas2D'],
    rank: 80,
    group: 'Canvas2D',
    run: ctx => {
      drawTo2d(ctx.source, firstTarget(ctx))
    },
    note: 'скрытый GL-канвас с preserveDrawingBuffer:true → drawImage (бенч: 13.6 fps; Mali: p95/p50 = 3.0 → disabled). S3: premultiplied-tax; источник обязан быть создан с preserve',
  })
  registry.add('draw2d-half', {
    requires: 'Canvas2D',
    rank: 90,
    group: 'Canvas2D',
    run: ctx => {
      // Деградационная ступень: полный кадр → промежуточный ½ → цель.
      // Первая копия пишет четверть пикселей, вторая читает четверть —
      // дешевле полного draw2d на гонимых мобильных композиторах.
      const target = firstTarget(ctx)
      const w = Math.max(1, ctx.source.width >> 1)
      const h = Math.max(1, ctx.source.height >> 1)
      const half = halfCanvas(w, h)
      ctx2dOf(half).drawImage(ctx.source as CanvasImageSource, 0, 0, w, h)
      drawTo2d(half, target)
    },
    note: 'деградационная ступень draw2d: кадр через промежуточный ½-канвас (четверть пикселей). S1: два drawImage',
  })
  registry.add('scaled-half', {
    requires: ['createImageBitmap', 'createImageBitmap.resize'],
    rank: 92,
    group: 'Bitmap',
    run: async ctx => {
      const target = firstTarget(ctx)
      const w = Math.max(1, ctx.source.width >> 1)
      const h = Math.max(1, ctx.source.height >> 1)
      const bitmap = await createImageBitmap(ctx.source as CanvasImageSource, { resizeWidth: w, resizeHeight: h })
      try {
        drawTo2d(bitmap, target)
      } finally {
        bitmap.close()
      }
    },
    note: 'деградационная ступень bitmap: createImageBitmap с resize ½ → drawImage. S1: resize-опции',
  })

  return registry
}
