/**
 * Авто-выбор бэкенда — ЧИСТАЯ функция над фактами (hardware + shader-покрытие).
 * Никаких enum'ов сценариев: порядок попыток × два предиката → решение.
 *
 * Принцип:
 *   candidates = order.filter(b => hardware[b] && shaderCovers(b, specs))
 *   chosen = candidates[0] ?? null
 *
 * BackendDecision — факты (per-backend вердикт, per-spec покрытие). Message
 * генерируется из фактов шаблоном, без отдельных «причин» как enum-тегов.
 */

import type { TextureHandle } from '@rune/webgl2'

/** Идентификатор бэкенда rune. */
export type BackendId = 'webgpu' | 'webgl2'

/** Unified DrawSpec: dual-source шейдеры (опциональный GLSL + опциональный WGSL).
 *  Pass-ы не входят — у них built-in квад, всегда dual-source. */
export interface AutoDrawSpec {
  /** Идентификатор спека — для покрытия/диагностики (не используется компилятором). */
  readonly id?: string
  readonly shader: {
    readonly glsl?: { readonly vertex: string; readonly fragment: string }
    readonly wgsl?: string
  }
  /** Атрибуты: tight-данные ИЛИ привязка фида (data/size + stride/offset/
   *  bufferId + step — Task 75: step='instance' читает запись один раз на
   *  инстанс — квады-звёзды из фида). */
  readonly attributes?: Record<string, { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly bufferId?: number; readonly instance?: boolean; readonly step?: 'vertex' | 'instance' }>
  readonly uniforms?: Record<string, unknown>
  readonly textures?: Record<string, TextureHandle>
  readonly pipeline?: {
    readonly depth?: { readonly test?: 'less' | 'lequal' | 'always'; readonly write?: boolean } | false
    /** Task 75: блендинг (аддитив/прозрачность; премультиплицированный вывод). */
    readonly blend?: { readonly src: string; readonly dst: string } | false
    readonly raster?: { readonly cull?: 'none' | 'back' | 'front' }
  }
  readonly count: number
  /** Task 75: инстансы (сигнал/число/функция) — draw(count, instances):
   *  count = вершины на инстанс (напр. 6 = квад из gl_VertexID/vertex_index),
   *  instances = число инстансов (напр. feed.count — звёзды). */
  readonly instances?: unknown
}

/** Покрытие одного спека: какие шейдерные варианты есть. */
export interface SpecCoverage {
  readonly id?: string
  readonly hasGlsl: boolean
  readonly hasWgsl: boolean
}

/** Вердикт по одному бэкенду. */
export interface BackendVerdict {
  /** Доступен ли hardware: navigator.gpu / canvas.getContext('webgl2'). */
  readonly available: boolean
  /** Покрывают ли спеки этот бэкенд (у каждого есть нужный вариант). */
  readonly covers: boolean
  /** Если не прошёл фильтр — причина одной строкой. */
  readonly rejected?: string
}

/** Полное решение: кто выбран, кто отсеян, почему. */
export interface BackendDecision {
  readonly chosen: BackendId | null
  /** Одна строка — для `#reason` / консоли. */
  readonly message: string
  readonly verdicts: Record<BackendId, BackendVerdict>
  readonly coverage: readonly SpecCoverage[]
  /** Порядок попыток, по которому фильтровали. */
  readonly order: readonly BackendId[]
}

/** Покрытие спека (чистая функция над шейдером). */
export function shaderCoverage(spec: AutoDrawSpec): SpecCoverage {
  const glsl = spec.shader.glsl
  const wgsl = spec.shader.wgsl
  return {
    id: spec.id,
    hasGlsl: !!glsl && !!glsl.vertex && !!glsl.fragment,
    hasWgsl: !!wgsl,
  }
}

/** Бэкенд покрывает спек, если у каждого есть соответствующий шейдер. */
function coversBackend(backend: BackendId, coverage: readonly SpecCoverage[]): boolean {
  if (backend === 'webgpu') return coverage.every(c => c.hasWgsl)
  return coverage.every(c => c.hasGlsl)
}

/** Имена спеков, у которых нет нужного варианта — для actionable-сообщения. */
function missingSpecs(backend: BackendId, coverage: readonly SpecCoverage[]): string[] {
  const field = backend === 'webgpu' ? 'hasWgsl' : 'hasGlsl'
  const want = backend === 'webgpu' ? 'WGSL' : 'GLSL'
  return coverage
    .filter(c => !c[field])
    .map(c => `"${c.id ?? '<без id>'}" (нет ${want})`)
}

interface ResolveInput {
  /** Порядок попыток. Default ['webgpu', 'webgl2']. Длина 1 = strict (no fallback). */
  readonly order?: readonly BackendId[]
  /** Pre-flight спеки для проверки покрытия. Нет = только hardware-фильтр. */
  readonly specs?: readonly AutoDrawSpec[]
  /** Hardware-факты: кто доступен. Чистая функция их не выясняет. */
  readonly hardware: { readonly webgpu: boolean; readonly webgl2: boolean }
}

/** Главное: выбрать бэкенд и собрать вердикты. Чистая функция — без side-effect. */
export function resolveBackend(input: ResolveInput): BackendDecision {
  const order = input.order ?? ['webgpu', 'webgl2']
  const specs = input.specs ?? []
  const coverage = specs.map(shaderCoverage)
  const hardware = input.hardware

  // Конфликт: спек без обоих вариантов шейдера — невалиден сам по себе
  const invalid = coverage.filter(c => !c.hasGlsl && !c.hasWgsl)
  if (invalid.length > 0) {
    const names = invalid.map(c => `"${c.id ?? '<без id>'}"`).join(', ')
    return decision(null, order, coverage, hardware, {
      webgpu: { available: hardware.webgpu, covers: false, rejected: `невалидный спек: ${names}` },
      webgl2: { available: hardware.webgl2, covers: false, rejected: `невалидный спек: ${names}` },
    }, `Невалидный спек (нет ни GLSL, ни WGSL): ${names}. Добавьте хотя бы один вариант шейдера.`)
  }

  // Вердикты по каждому бэкенду
  const verdicts = {
    webgpu: verdictFor('webgpu', hardware.webgpu, coversBackend('webgpu', coverage), coverage),
    webgl2: verdictFor('webgl2', hardware.webgl2, coversBackend('webgl2', coverage), coverage),
  }

  // Фильтр + первый
  const candidates = order.filter(b => verdicts[b].available && verdicts[b].covers)
  const chosen = candidates.length > 0 ? candidates[0] : null

  return decision(chosen, order, coverage, hardware, verdicts, messageFor(chosen, order, verdicts, coverage))
}

function verdictFor(
  backend: BackendId,
  available: boolean,
  covers: boolean,
  coverage: readonly SpecCoverage[],
): BackendVerdict {
  if (!available && !covers) {
    return { available: false, covers, rejected: `нет адаптера и покрытие не прошло: ${missingSpecs(backend, coverage).join(', ')}` }
  }
  if (!available) {
    return { available: false, covers, rejected: 'нет адаптера' }
  }
  if (!covers) {
    return { available, covers: false, rejected: `спек не имеет варианта для ${backend === 'webgpu' ? 'WGSL' : 'GLSL'}: ${missingSpecs(backend, coverage).join(', ')}` }
  }
  return { available: true, covers: true }
}

function decision(
  chosen: BackendId | null,
  order: readonly BackendId[],
  coverage: readonly SpecCoverage[],
  hardware: { readonly webgpu: boolean; readonly webgl2: boolean },
  verdicts: Record<BackendId, BackendVerdict>,
  message: string,
): BackendDecision {
  return { chosen, message, verdicts, coverage, order }
}

/** Человекочитаемое имя бэкенда — для message. */
function label(b: BackendId): string {
  return b === 'webgpu' ? 'WebGPU' : 'WebGL2'
}

/** Шаблон message из фактов. Не enum причин — генерируется из verdicts. */
function messageFor(
  chosen: BackendId | null,
  order: readonly BackendId[],
  verdicts: Record<BackendId, BackendVerdict>,
  coverage: readonly SpecCoverage[],
): string {
  // strict: order длины 1
  if (order.length === 1) {
    const only = order[0]
    if (chosen === null) {
      const v = verdicts[only]
      if (!v.available) {
        return `Принудительный ${label(only)} недоступен: ${v.rejected}. Смягчите order=${JSON.stringify(['webgpu', 'webgl2'])} для фолбэка.`
      }
      return `Принудительный ${label(only)} не покрывает спеки: ${v.rejected}. Добавьте ${only === 'webgpu' ? 'WGSL' : 'GLSL'} к спекам.`
    }
    return `Принудительный выбор (order=${JSON.stringify(order)})`
  }

  // auto: order длины ≥ 2
  if (chosen !== null) {
    const forcedBy = coverage.filter(c => (chosen === 'webgpu' ? !c.hasGlsl : !c.hasWgsl))
    if (forcedBy.length > 0) {
      const names = forcedBy.map(c => `"${c.id ?? '<без id>'}"`).join(', ')
      const other = order.filter(b => b !== chosen)[0]
      const otherRejected = verdicts[other]?.rejected ?? 'нет'
      const missingVariant = chosen === 'webgpu' ? 'GLSL' : 'WGSL'
      return `Выбран ${label(chosen)} — доступен; спекы без ${missingVariant}: ${names} — фолбэк-кандидат ${label(other)} отсеян (${otherRejected})`
    }
    return `Выбран ${label(chosen)} — доступен и покрывает все спеки`
  }

  // никто не прошёл
  const rejections = order.map(b => `${label(b)}: ${verdicts[b].rejected ?? 'неизвестно'}`).join('; ')
  return `Конфликт — ни один бэкенд из order=${JSON.stringify(order)} не прошёл. Вердикты: ${rejections}`
}
