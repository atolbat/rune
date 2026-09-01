/**
 * residency — LRU-политика резидентности GPU-ресурсов (Task 66).
 *
 * Закрывает последний явный долг soft-reset архитектуры (Task 65):
 * «eviction LRU для resident-ресурсов — отдельная задача». Раньше
 * резидентность управлялась только рабочим множеством сцены при loss и
 * явным ensureResident — давление памяти МЕЖДУ потерями ничем не
 * ограничивалось: ensureResident в цикле возвращает текстуры в GPU-память,
 * и повторный OOM становился вопросом времени.
 *
 * Модель (каталог §12 #14 pressure→evict, паттерн P1 Probe→Gate→Degrade):
 *   • Probe — residencyStats(): сессия считает ОЦЕНКУ GPU-памяти резидентных
 *     текстур (браузер не даёт запросить фактическую видеопамять);
 *   • Gate — budgetBytes: порог, при превышении которого надо деградировать;
 *   • Degrade — selectLRUEvictions(): вытеснить НАИМЕНЕЕ ДАВНО
 *     ИСПОЛЬЗОВАННЫЕ (LRU) резидентные текстуры, пока оценка не уложится
 *     в бюджет. Вытеснение = обратная сторона ensureResident: raw-ресурс
 *     освобождается, но ДЕКЛАРАЦИЯ и КОНТЕНТ остаются в журнале — ресурс
 *     вернётся тем же код-путём по требованию. Ничего не теряется.
 *
 * Единица учёта — ТЕКСТУРА (views/targets — алиасы её хранилища, ~0 байт:
 * GL-«view» — запись о мип-диапазоне, WebGPU GPUTextureView освобождается
 * вместе с родителем). Вытеснение текстуры тянет за собой её резидентные
 * views/targets — это замыкание делает СЕССИЯ (residency.ts только считает).
 *
 * Чистые функции без состояния: политика тестируется отдельно от фасадов,
 * сессия поставляет entries (id/bytes/lastUse) и исполняет план.
 */

import { textureFormatBytesPerPixel, type TextureFormat } from './resourceJournal.ts'

export { textureFormatBytesPerPixel }

/** Байт на пиксель по формату (Task 67: HDR-текстуры весят 2×/4× больше).
 *  rgba8unorm/canvas → 4; rgba16float → 8; rgba32float → 16. */
function bytesPerPixel(format?: TextureFormat): number {
  return textureFormatBytesPerPixel(format)
}

/** Оценка GPU-памяти текстуры в байтах.
 *  mip-chain: полный ряд уровней = base × (1 + 1/4 + 1/16 + …) ≈ ×4/3. */
export function estimateTextureBytes(
  width: number,
  height: number,
  mipLevels = 1,
  format?: TextureFormat,
): number {
  const base = width * height * bytesPerPixel(format)
  if (mipLevels <= 1) return base
  const levels = Math.min(mipLevels, 1 + Math.floor(Math.log2(Math.max(width, height))))
  // Σ base/4^i, i=0..levels-1 = base × (1 - 4^-levels) / (1 - 1/4) ≤ base × 4/3
  const sum = base * (1 - Math.pow(4, -levels)) / 0.75
  return Math.ceil(sum)
}

/** Резидентная текстура в учёте LRU (поставляется сессией). */
export interface ResidencyEntry {
  /** Стабильный textureId (< VIEW_ID_BASE). */
  readonly id: number
  /** Оценка GPU-памяти (estimateTextureBytes). */
  readonly bytes: number
  /** Монотонный счётчик последнего использования (больше = свежее). */
  readonly lastUse: number
}

/** План вытеснения: кого освободить, чтобы уложиться в бюджет. */
export interface EvictionSelection {
  /** Стабильные textureIds к вытеснению (LRU-первыми). */
  readonly evictIds: readonly number[]
  /** Сколько байт оценка освободит (сумма bytes вытесняемых). */
  readonly freedBytes: number
  /** Оценка остатшейся резидентной памяти после применения плана. */
  readonly residentBytes: number
}

/** Выбрать жертвы LRU (чистая функция).
 *
 * Инварианты:
 *   • pinned НЕ вытесняются НИКОГДА — даже если бюджет не выполняется
 *     (рабочее множество сцены неприкосновенно; превышение бюджета
 *     запиненными — проблема вызывающего, не политики);
 *   • вытесняются только НЕзапиненные, начиная с наименьшего lastUse;
 *   • остановка — как только оценка уложилась в бюджет (включая «ровно
 *     в бюджет»: бюджет — это потолок, а не цель);
 *   • пустой бюджет = вытеснить всё незапиненное (полный soft reset
 *     вручную, без потери устройства);
 *   • entries с bytes=0 (неизвестный размер) считаются 0 — вытесняются
 *     по LRU как и остальные, но не двигают сумму.
 */
export function selectLRUEvictions(
  entries: readonly ResidencyEntry[],
  budgetBytes: number,
  pinned?: ReadonlySet<number>,
): EvictionSelection {
  const pin = pinned ?? new Set<number>()
  const unpinned = entries.filter(e => !pin.has(e.id))
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  if (totalBytes <= budgetBytes) {
    return { evictIds: [], freedBytes: 0, residentBytes: totalBytes }
  }
  // LRU-первыми: наименьший lastUse уходит раньше всех. Стабильная сортировка
  // по (lastUse, id) — детерминизм для тестов и логов.
  const byLru = [...unpinned].sort((a, b) => (a.lastUse - b.lastUse) || (a.id - b.id))
  const evictIds: number[] = []
  let freed = 0
  for (const e of byLru) {
    if (totalBytes - freed <= budgetBytes) break
    evictIds.push(e.id)
    freed += e.bytes
  }
  return { evictIds, freedBytes: freed, residentBytes: totalBytes - freed }
}

/** Статистика резидентности для диагностики/UI. */
export interface ResidencyStats {
  /** Резидентные текстуры (стабильные id), отсортированы по lastUse asc. */
  readonly textures: readonly {
    readonly id: number
    readonly bytes: number
    readonly lastUse: number
  }[]
  /** Суммарная оценка GPU-памяти резидентных текстур. */
  readonly totalBytes: number
  /** Резидентные views/targets (алиасы — в bytes не входят). */
  readonly views: readonly number[]
  readonly targets: readonly number[]
}

/** Результат вытеснения (исполняет сессия; raw-вызовы, БЕЗ журнальных
 *  опсов — декларации и контент остаются в журнале, ресурс вернётся через
 *  ensureResident тем же код-путём, что и живая работа). */
export interface EvictionReport {
  /** Вытесненные текстуры (стабильные id, LRU-первыми). */
  readonly textures: readonly number[]
  /** Вытесненные views (замыкание поверх вытесненных текстур). */
  readonly views: readonly number[]
  /** Вытесненные targets (то же). */
  readonly targets: readonly number[]
  /** Оценка освобождённой GPU-памяти. */
  readonly freedBytes: number
  /** Оценка остатшейся резидентной памяти. */
  readonly residentBytes: number
  /** Оставшиеся резидентными текстуры (стабильные id). */
  readonly residentTextures: readonly number[]
}
