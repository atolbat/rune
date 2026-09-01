/**
 * Динамическая геометрия (Task 109): фиды, пересобирающие геометрию по
 * внешнему состоянию (камера/дистанция) — «CLOD на уровне переделывания
 * геометрии». ОБЩИЙ КОНТРАКТ фида:
 *   • geometry  — текущая геометрия (ссылка стабильна между пересборками);
 *   • update(…) — проверить состояние; true = геометрия пересобрана
 *     (ссылка НОВАЯ — перепушьте атрибуты в команду рендера);
 *   • rebuilds  — счётчик пересборок (диагностика/лог).
 *
 * Точка интеграции с рендером — горячая подмена атрибутов команды
 * (CompiledCommand.updateAttributes в @rune/gl): фид вернул true →
 * updateAttributes({a_pos, a_normal, a_uv}) + динамический count.
 *
 * SSBO-перспектива: фид, чья геометрия считается НА GPU (кернел пишет
 * позиции в storage-буфер, вершины тянутся из SSBO в шейдере), держит
 * тот же контракт update(), но не пересоздаёт атрибуты — он перезапускает
 * dispatch (см. DESIGN.md §5.5, «GPU-дисплейс» — следующий срез).
 */

import type { Geometry } from './types.ts'

export interface PrimitiveFeedParams {
  /** Генератор геометрии уровня: множитель детализации k → Geometry. */
  readonly make: (detailK: number) => Geometry
  /**
   * Множители детализации уровней, БЛИЖНИЙ → ДАЛЬНИЙ
   * (default [2, 1, 0.5, 0.25]).
   */
  readonly levels?: readonly number[]
  /**
   * Пороги дистанции между уровнями, по возрастанию; length = levels−1
   * (default [3, 6, 12]).
   */
  readonly thresholds?: readonly number[]
  /**
   * Гистерезис против дребезга: уровень меняется «дальше» при
   * dist > порог·(1+h), «ближе» при dist < порог·(1−h)
   * (default 0.15 — как PRESSURE_HYSTERESIS в present).
   */
  readonly hysteresis?: number
}

export interface PrimitiveFeed {
  /** Текущая геометрия уровня (ссылка меняется после update() = true). */
  readonly geometry: Geometry
  /** Индекс текущего уровня (0 — самый детальный). */
  readonly level: number
  /** Проверить дистанцию; true = уровень сменился, geometry новая. */
  update(dist: number): boolean
  /** Счётчик пересборок геометрии. */
  readonly rebuilds: number
}

/**
 * LOD-фид ОДНОГО примитива: приближение камеры → выше разрешение,
 * отдаление → ниже (пересборка ТОЛЬКО при смене уровня — не каждый кадр).
 *
 * Гистерезис: в полосе порог·(1±h) решение придерживается — орбита
 * камеры с длиной около порога не устраивает пилу пересборок.
 */
export function createPrimitiveFeed(params: PrimitiveFeedParams): PrimitiveFeed {
  const levels = params.levels ?? [2, 1, 0.5, 0.25]
  const thresholds = params.thresholds ?? [3, 6, 12]
  const hysteresis = params.hysteresis ?? 0.15
  if (levels.length < 1) throw new Error('rune: prims — LOD-фид требует хотя бы один уровень')
  if (thresholds.length !== levels.length - 1) {
    throw new Error(`rune: prims — LOD-фид: порогов ${thresholds.length}, уровней ${levels.length} (нужно levels−1 = ${levels.length - 1})`)
  }
  let level = 0
  let geometry = params.make(levels[0]!)
  let rebuilds = 1
  return {
    get geometry(): Geometry {
      return geometry
    },
    get level(): number {
      return level
    },
    get rebuilds(): number {
      return rebuilds
    },
    update(dist: number): boolean {
      let next = level
      // Отдаление: порог проходится ВВЕРХ только с запасом (1+h)
      for (let i = level; i < thresholds.length; i++) {
        if (dist > thresholds[i]! * (1 + hysteresis)) next = i + 1
      }
      // Приближение: порог проходится ВНИЗ только с запасом (1−h)
      for (let i = level - 1; i >= 0; i--) {
        if (dist < thresholds[i]! * (1 - hysteresis)) next = i
      }
      if (next === level) return false
      level = next
      geometry = params.make(levels[level]!)
      rebuilds++
      return true
    },
  }
}
