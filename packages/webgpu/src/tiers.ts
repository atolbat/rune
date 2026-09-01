/**
 * §8-3 (M4, Контракт 4): requestTier — ЛЕСТНИЦА переговоров с адаптером.
 *
 * Было (до Task 101): createRealGPU звал adapter.requestDevice() почти без
 * параметров — единственная «переговорная» логика: timestamp-query /
 * float32-filterable / float32-blendable запрашивались ЕСЛИ адаптер их
 * имеет, при отказе — повтор без requiredFeatures (см. realGPU.ts).
 *
 * Стало: профили «desktop / mobile / fallback» (§5.3, профиль §9.2 —
 * ЗАПРАШИВАЕМЫЕ tiers, не захардкоженные по userAgent) прогоняются через
 * negotiateDevice():
 *
 *   шаг 1..k  requestDevice({ requiredFeatures, requiredLimits }) по
 *             лестнице лимитов ПО УБЫВАНИЮ (например maxTextureDimension2D
 *             16384 → 8192 → адаптерные дефолты, DESIGN §4: «спускается
 *             с 16384 → 8192 при отказе»);
 *   шаг k+1   requestDevice({ requiredFeatures }) — лимиты не запрашиваем;
 *   шаг k+2   bare requestDevice() — честный fallback (прошлое поведение
 *             createRealGPU как последний шаг — контракт сохранён).
 *
 * Каждый шаг пишется в steps[] (NegotiationStep) — трасса переговоров
 * видна вызывающему коду (демо requestTier показывает её вживую).
 *
 * probeContextEviction() — зонд вытеснения WebGL-контекстов (§7-уточнение 2:
 * «не хардкод 8, а измеряемый профиль»: на Mali даёт 9, на десктопе 16+,
 * замер на Raspberry Pi (Mali Valhall): 18 живых без вытеснения — потолок
 * задаётся maxProbes, среда может держать больше).
 * Измерение: создаём webgl2-контексты один за другим и смотрим, на каком
 * по счёту браузер убьёт СТАРЕЙШИЙ (kill-oldest). safeMax = evictedAt − 1
 * (safetyMargin(1)). Фабрика контекстов инъектится — юнит-тесты считают
 * логику без реального GPU.
 *
 * Гигиена (Контракт 5, Task 79): tier НЕ заявляет фичи, у которых нет пути
 * исполнения в движке — набор запрашиваемых фич остался прежним
 * (SOFT_FEATURES), меняются только лимиты и хинты профиля.
 */

/** Идентификатор тира. */
export type WebGpuTierId = 'desktop' | 'mobile' | 'fallback'

/** Запрос тира вызывающего кода: конкретный профиль или 'auto' (детект). */
export type WebGpuTierRequest = 'auto' | WebGpuTierId

/** Минимальный структурный тип адаптера — реальный GPUAdapter ему
 *  удовлетворяет, юнит-тесты подставляют фейк. limits — информационное
 *  поле (лестница НЕ индексирует адаптерные лимиты: переговоры идут
 *  только через requestDevice, Контракт 4). */
export interface TierAdapter {
  readonly features: { has(name: string): boolean }
  readonly limits?: object
  readonly info?: { vendor?: string; architecture?: string; description?: string }
  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<unknown>
}

/** Хинты профиля (§9.2): потребитель может НЕ следовать — это не лимиты
 *  устройства, а рекомендации движка/приложения для этого тира. */
export interface TierHints {
  /** Потолок DPR канваса (мобильный профиль: dpr ≤ 2). */
  readonly dprCap: number
  /** Ориентировочный бюджет GPU-памяти на текстуры, МБ (мобильный: 256). */
  readonly textureBudgetMb: number
  /** Человекочитаемое имя профиля. */
  readonly label: string
}

/** Лестница одного лимита: значения ПО УБЫВАНИЮ. */
export interface TierLimitLadder {
  readonly limit: string
  readonly values: readonly number[]
}

/** Спецификация тира: лестницы лимитов + хинты профиля. */
export interface TierSpec {
  readonly id: WebGpuTierId
  readonly limits: readonly TierLimitLadder[]
  readonly hints: TierHints
}

/**
 * Фичи, запрашиваемые ЕСЛИ адаптер их поддерживает (мягкие — refusal не
 * фатален, ladder спустится до bare requestDevice). Набор не расширяется
 * тиром: у всего здесь есть путь исполнения в движке (Контракт 5):
 *   timestamp-query     — GpuTimer (device.createQuerySet timestamp);
 *   float32-filterable  — LINEAR-фильтрация rgba32float (Task 69);
 *   float32-blendable   — блендинг 32F-целей (Task 81).
 */
export const SOFT_FEATURES: readonly GPUFeatureName[] = [
  'timestamp-query',
  'float32-filterable',
  'float32-blendable',
]

/**
 * Тиры (DESIGN §5.3: desktop / mobile / fallback; §4: спуск 16384 → 8192).
 * Лестницы указывают ЗАПРАШИВАЕМЫЕ значения: requestDevice поднимает лимит
 * до значения, если адаптер умеет; если нет — reject, и negotiation
 * спускается на ступень ниже. Последняя ступень любой лестницы — не
 * запрашивать лимит вовсе (адаптерные дефолты).
 */
export const TIERS: Readonly<Record<WebGpuTierId, TierSpec>> = {
  desktop: {
    id: 'desktop',
    limits: [
      { limit: 'maxTextureDimension2D', values: [16384, 8192] },
      { limit: 'maxBufferSize', values: [1073741824, 268435456] },
    ],
    hints: { dprCap: 3, textureBudgetMb: 1024, label: 'Desktop — полные лимиты' },
  },
  mobile: {
    id: 'mobile',
    limits: [
      { limit: 'maxTextureDimension2D', values: [8192] },
      { limit: 'maxBufferSize', values: [268435456] },
    ],
    hints: { dprCap: 2, textureBudgetMb: 256, label: 'Mobile (§9.2): dpr ≤ 2, бюджет 256 МБ' },
  },
  fallback: {
    id: 'fallback',
    limits: [],
    hints: { dprCap: 1, textureBudgetMb: 64, label: 'Fallback — адаптерные дефолты' },
  },
}

/** Мобильные семейства GPU (adapter.info.architecture) — сигнал «мобильный
 *  профиль». Поколения Mali Dawn называет по микроархитектуре («valhall»,
 *  «bifrost», «midgard», «immortalis» — репорт с Mali Valhall: vendor «arm»,
 *  architecture «valhall»), поэтому ВЕНДОР «arm» тоже сигналит mobile —
 *  GPU-линейка ARM это только Mali (мобильный класс). SwiftShader (софтверный
 *  рендер headless/слабых машин) тоже консервативен по лимитам — относим к
 *  mobile-тиру. UA НЕ используется (§5.3: «запрашиваемые tiers, а не
 *  захардкоженные по userAgent»). Apple-вендор НЕ добавляем: iPhone и Mac
 *  сообщают одинаковый info — неразличимо, остаётся консервативный desktop. */
const MOBILE_ARCH_RE = /mali|valhall|bifrost|midgard|immortalis|adreno|powervr|xclipse|videocore|swiftshader/i

/** Вендоры, вся GPU-линейка которых — мобильный класс (ARM = Mali). */
const MOBILE_VENDOR_RE = /^arm$/i

/**
 * Детект тира по adapter.info/limits. Это ТОЛЬКО дефолт для tier:'auto' —
 * приложение всегда может запросить профиль явно (главное требование §5.3).
 * Эвристика консервативна: неизвестный адаптер = desktop (лестница всё
 * равно спустится при отказе, потерь нет).
 */
export function detectTier(adapter: { readonly info?: { vendor?: string; architecture?: string; description?: string } }): WebGpuTierId {
  const info = adapter.info
  const arch = info?.architecture ?? ''
  if (MOBILE_ARCH_RE.test(arch)) return 'mobile'
  if (info?.vendor !== undefined && MOBILE_VENDOR_RE.test(info.vendor)) return 'mobile'
  return 'desktop'
}

/** Один шаг переговоров (трасса для приложения/демо). */
export interface NegotiationStep {
  /** Что пробовали на этом шаге (человекочитаемо). */
  readonly label: string
  readonly ok: boolean
  readonly error?: string
  /** Лимиты этого шага (для ок-шага — ГРАНТИРОВАННЫЕ требуемые лимиты). */
  readonly requiredLimits?: Readonly<Record<string, number>>
}

/** Результат переговоров. */
export interface NegotiatedTier {
  /** Что просили ('auto' уже развёрнут в конкретный профиль). */
  readonly requested: WebGpuTierRequest
  /** Что получили: 'fallback' — выжил только bare requestDevice. */
  readonly granted: WebGpuTierId
  readonly device: unknown
  /** Фичи, реально запрошенные у адаптера (мягкие, отфильтрованы по has). */
  readonly requiredFeatures: readonly string[]
  /** Лимиты финального успешного шага (пусто — адаптерные дефолты). */
  readonly requiredLimits: Readonly<Record<string, number>>
  /** Полная трасса: каждая ступень + финальный ок-шаг. */
  readonly steps: readonly NegotiationStep[]
  readonly hints: TierHints
}

export interface NegotiateDeviceOptions {
  /** Живой колбэк шага (демо подсвечивает ступени по мере переговоров). */
  readonly onStep?: (step: NegotiationStep) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Лестница переговоров: лимиты по убыванию → только фичи → bare.
 * Возвращает ГРАНТИРОВАННЫЙ шаг; если падает даже bare — ретраунет
 * исходную ошибку (адаптер мёртв, тут уже не чем торговаться).
 *
 * ⚠ Dawn/Chrome: УСПЕШНЫЙ requestDevice «потребляет» адаптер (adapter is
 * "consumed") — один адаптер даёт одно устройство. Провальные попытки
 * лестницы адаптер НЕ потребляют, поэтому спуск внутри одного вызова
 * работает; для ПОВТОРНЫХ переговоров запрашивайте свежий адаптер
 * (navigator.gpu.requestAdapter() снова).
 */
export async function negotiateDevice(
  adapter: TierAdapter,
  tier: WebGpuTierRequest,
  options?: NegotiateDeviceOptions,
): Promise<NegotiatedTier> {
  const resolved: WebGpuTierId = tier === 'auto' ? detectTier(adapter) : tier
  const spec = TIERS[resolved]
  // Мягкие фичи: просим только то, что адаптер заявляет (прошлое поведение
  // realGPU — сохранено как первый шаг лестницы). Явный fallback-тир —
  // bare-семантика: никаких фич вовсе (gpuTimer честно не подключится).
  const requiredFeatures = resolved === 'fallback'
    ? []
    : SOFT_FEATURES.filter(name => adapter.features.has(name))
  const steps: NegotiationStep[] = []
  const emit = (step: NegotiationStep): void => { steps.push(step); options?.onStep?.(step) }

  // Ступени по лестницам лимитов: индекс k = «берём k-е значение каждой
  // лестницы» (короткая лестница отдаёт последнее значение). Первая
  // ступень — все максимумы, затем спуск. Хинты ступени: maxTextureDimension2D.
  const maxLen = Math.max(0, ...spec.limits.map(l => l.values.length))
  for (let k = 0; k < maxLen; k++) {
    const requiredLimits: Record<string, number> = {}
    for (const ladder of spec.limits) {
      requiredLimits[ladder.limit] = ladder.values[Math.min(k, ladder.values.length - 1)]!
    }
    const tex = requiredLimits['maxTextureDimension2D']
    const label = tex === undefined
      ? `${resolved} · лимиты (ступень ${k + 1})`
      : `${resolved} · текстуры ≤ ${tex}px`
    try {
      const device = await adapter.requestDevice({ requiredFeatures, requiredLimits })
      emit({ label, ok: true, requiredLimits })
      return { requested: tier, granted: resolved, device, requiredFeatures, requiredLimits, steps, hints: spec.hints }
    } catch (error) {
      emit({ label, ok: false, error: errorText(error) })
    }
  }

  // Ступень без лимитов (адаптерные дефолты) — но с мягкими фичами.
  try {
    const device = await adapter.requestDevice({ requiredFeatures })
    emit({ label: `${resolved} · без requiredLimits (дефолты адаптера)`, ok: true, requiredLimits: {} })
    return { requested: tier, granted: resolved, device, requiredFeatures, requiredLimits: {}, steps, hints: spec.hints }
  } catch (error) {
    emit({ label: `${resolved} · без requiredLimits (дефолты адаптера)`, ok: false, error: errorText(error) })
  }

  // Bare — прежний финальный fallback realGPU (без фич: gpuMs честно null).
  try {
    const device = await adapter.requestDevice()
    emit({ label: 'fallback · bare requestDevice()', ok: true, requiredLimits: {} })
    return { requested: tier, granted: 'fallback', device, requiredFeatures: [], requiredLimits: {}, steps, hints: TIERS.fallback.hints }
  } catch (error) {
    emit({ label: 'fallback · bare requestDevice()', ok: false, error: errorText(error) })
    throw error
  }
}

// ─── Зонд вытеснения WebGL-контекстов (§7-уточнение 2) ───────────────────────

/** Контекст-минимум для зонда (реальный WebGL2RenderingContext
 *  isContextLost() + WEBGL_lose_context ему удовлетворяет). */
export interface EvictionContext {
  readonly isLost: boolean
  lose?(): void
}

export interface EvictionProbeOptions {
  /** Хардкап создаваемых контекстов (браузеры держат ~16; default 24). */
  readonly maxProbes?: number
  /** Пауза после создания контекста до проверки isContextLost, мс
   *  (браузер убивает старейший асинхронно; default 60). */
  readonly settleMs?: number
  /** Фабрика контекстов — инъекция для юнит-тестов. null от фабрики =
   *  webgl2 недоступен. */
  readonly create?: () => EvictionContext | null
  /** Живой колбэк: создан i-й контекст (1-based), жив ли старейший. */
  readonly onProbe?: (info: { index: number; created: number; oldestLost: boolean }) => void
}

export interface EvictionProbeResult {
  /** На каком по счёту контексте умер старейший (1-based). null — за
   *  maxProbes вытеснения не случилось (capped=true). */
  readonly evictedAt: number | null
  /** evictedAt − safetyMargin(1): безопасное число одновременных контекстов. */
  readonly safeMax: number | null
  /** Сколько контекстов успели создать. */
  readonly probed: number
  /** true — дошли до maxProbes без вытеснения (нижняя граница меры). */
  readonly capped: boolean
  /** webgl2 недоступен в среде. */
  readonly unavailable?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Реальная фабрика: 4×4-канвас + webgl2-контекст. */
function createWebGL2Context(): EvictionContext | null {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 4
  const gl = canvas.getContext('webgl2')
  if (gl === null) return null
  return gl as unknown as EvictionContext
}

/**
 * Измерение порога вытеснения контекстов (kill-oldest). Создаёт контексты
 * по одному; после каждого ждёт settleMs и проверяет старейший. Как только
 * старейший потерян — evictedAt = номер последнего созданного, все
 * созданные контексты освобождаются через WEBGL_lose_context (если есть).
 */
export async function probeContextEviction(options?: EvictionProbeOptions): Promise<EvictionProbeResult> {
  const maxProbes = options?.maxProbes ?? 24
  const settleMs = options?.settleMs ?? 60
  const create = options?.create ?? createWebGL2Context
  const contexts: EvictionContext[] = []

  const cleanup = (): void => {
    for (const ctx of contexts) {
      try { ctx.lose?.() } catch { /* контекст уже мёртв */ }
    }
  }

  try {
    for (let index = 1; index <= maxProbes; index++) {
      const ctx = create()
      if (ctx === null) {
        // webgl2 нет вовсе: это честный результат «среда без GL» (не ошибка).
        if (index === 1) return { evictedAt: null, safeMax: null, probed: 0, capped: false, unavailable: true }
        break
      }
      contexts.push(ctx)
      if (settleMs > 0) await sleep(settleMs)
      const oldestLost = contexts[0]!.isLost
      options?.onProbe?.({ index, created: contexts.length, oldestLost })
      if (oldestLost) {
        // kill-oldest: старейший умер при появлении index-го контекста.
        return { evictedAt: index, safeMax: index - 1, probed: contexts.length, capped: false }
      }
    }
    return { evictedAt: null, safeMax: null, probed: contexts.length, capped: true }
  } finally {
    cleanup()
  }
}
