/**
 * RectPacker — упаковщик прямоугольников в больший прямоугольник.
 *
 * Контракт (см. дизайн-раунд «Use case B: Runtime packing»):
 *  - Чисто алгоритмическая задача. Не знает про GPU, текстуры, ImageBitmap.
 *  - Юзер пакует слоты, потом сам копирует биты в регион через
 *    Texture.uploadSubImage(x, y, bitmap).
 *  - Алгоритмы: 'shelf' (быстрый, для одинаковых размеров — тайлы) и
 *    'maxrects' (классический для пестрых размеров).
 *
 * Типичный flow:
 *   const packer = createRectPacker(2048, 2048, { algorithm: 'maxrects' })
 *   const slots = packer.pack([
 *     { id: 'grass', w: 64, h: 64 },
 *     { id: 'stone', w: 64, h: 64 },
 *   ])
 *   if (!slots) throw new Error('Не влезло — нужен больший атлас')
 *   // slots: [{ id: 'grass', x: 0, y: 0, w: 64, h: 64 }, ...]
 */

export interface RectInput {
  /** Идентификатор слота — пользовательский, чтобы потом сопоставить. */
  readonly id: string
  readonly w: number
  readonly h: number
}

export interface RectSlot extends RectInput {
  /** Позиция в атласе (top-left). */
  readonly x: number
  readonly y: number
}

export interface RectPackerOptions {
  /** Алгоритм упаковки. Default 'shelf'.
   *  - 'shelf': раскладывает по строкам высотой = max height в строке.
   *    O(n log n), хорошо для тайловых атласов.
   *  - 'maxrects': классический MAXRECTS-BSSF. O(n^2) в худшем случае,
   *    но хорошо упаковывает пёстрые размеры. */
  readonly algorithm?: 'shelf' | 'maxrects'
  /** Отступ между слотами (для mip-крови). Default 0. */
  readonly padding?: number
}

/** Состояние упаковщика. */
export interface RectPacker {
  /** Запаковать набор прямоугольников. Вернёт null, если не влезло. */
  pack(items: readonly RectInput[]): RectSlot[] | null
  /** Текущая заполненность (по площади). */
  readonly usedArea: number
  /** Ширина/высота атласа. */
  readonly width: number
  readonly height: number
}

export function createRectPacker(width: number, height: number, options: RectPackerOptions = {}): RectPacker {
  const algorithm = options.algorithm ?? 'shelf'
  const padding = options.padding ?? 0

  let usedArea = 0

  function pack(items: readonly RectInput[]): RectSlot[] | null {
    if (algorithm === 'shelf') return packShelf(items)
    return packMaxRects(items)
  }

  // ─── Shelf packer ──────────────────────────────────────────────────────────
  //
  // Раскладывает по строкам. Каждая строка имеет высоту = max height в строке.
  // Хорошо работает для однотипных тайлов (всё 64x64 — идеально).

  function packShelf(items: readonly RectInput[]): RectSlot[] | null {
    // Сортируем по убыванию высоты — это эвристика First-Fit Decreasing.
    const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w)
    const slots: RectSlot[] = []
    let x = padding
    let y = padding
    let rowHeight = 0

    for (const item of sorted) {
      const w = item.w + padding * 2
      const h = item.h + padding * 2
      // Не влезает в текущую строку — переносим на новую
      if (x + w > width + padding) {
        y += rowHeight
        x = padding
        rowHeight = 0
      }
      // Не влезает по высоте — атлас слишком мал
      if (y + h > height + padding) return null
      slots.push({ id: item.id, x, y, w: item.w, h: item.h })
      usedArea += item.w * item.h
      x += w
      rowHeight = Math.max(rowHeight, h)
    }
    return slots
  }

  // ─── MaxRects packer (BSSF variant) ───────────────────────────────────────
  //
  // Классический алгоритм MAXRECTS-BSSF (Best Short Side Fit). Поддерживает
  // свободные прямоугольники; при упаковке нового слота разбивает пересечённые.
  // Хорош для пёстрых размеров.

  interface FreeRect { x: number; y: number; w: number; h: number }

  function packMaxRects(items: readonly RectInput[]): RectSlot[] | null {
    // Свободные прямоугольники. Изначально — весь атлас.
    const free: FreeRect[] = [{ x: padding, y: padding, w: width - padding * 2, h: height - padding * 2 }]
    const slots: RectSlot[] = []
    const sorted = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h))

    for (const item of sorted) {
      const w = item.w + padding * 2
      const h = item.h + padding * 2
      // Best Short Side Fit: ищем свободный rect, куда влезает, минимизируя
      // короткую оставшуюся сторону.
      let best: { rect: FreeRect; score: number } | null = null
      for (const rect of free) {
        if (rect.w >= w && rect.h >= h) {
          const shortSide = Math.min(rect.w - w, rect.h - h)
          const longSide = Math.max(rect.w - w, rect.h - h)
          const score = shortSide * 1000 + longSide // short side доминирует
          if (best === null || score < best.score) {
            best = { rect, score }
          }
        }
      }
      if (best === null) return null // не влезло
      const chosen = best.rect
      slots.push({ id: item.id, x: chosen.x + padding, y: chosen.y + padding, w: item.w, h: item.h })
      usedArea += item.w * item.h
      // Разбиваем пересечённые свободные прямоугольники
      const newFree: FreeRect[] = []
      for (const rect of free) {
        if (!intersects(rect, chosen, w, h)) {
          newFree.push(rect)
          continue
        }
        // Делим на части
        for (const part of splitRect(rect, { x: chosen.x, y: chosen.y, w, h })) {
          if (part.w > 0 && part.h > 0) newFree.push(part)
        }
      }
      // Промежуточная чистка: убираем free, целиком содержащиеся в других
      free.length = 0
      outer: for (let i = 0; i < newFree.length; i++) {
        for (let j = 0; j < newFree.length; j++) {
          if (i === j) continue
          if (contains(newFree[j], newFree[i])) continue outer
        }
        free.push(newFree[i])
      }
    }
    return slots
  }

  function intersects(a: FreeRect, b: FreeRect, bw: number, bh: number): boolean {
    return !(b.x >= a.x + a.w || b.x + bw <= a.x || b.y >= a.y + a.h || b.y + bh <= a.y)
  }

  function splitRect(free: FreeRect, used: FreeRect): FreeRect[] {
    const result: FreeRect[] = []
    // Левый кусок
    if (used.x > free.x) result.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h })
    // Правый кусок
    if (used.x + used.w < free.x + free.w) result.push({ x: used.x + used.w, y: free.y, w: free.x + free.w - (used.x + used.w), h: free.h })
    // Верхний кусок
    if (used.y > free.y) result.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y })
    // Нижний кусок
    if (used.y + used.h < free.y + free.h) result.push({ x: free.x, y: used.y + used.h, w: free.w, h: free.y + free.h - (used.y + used.h) })
    return result
  }

  function contains(outer: FreeRect, inner: FreeRect): boolean {
    return outer.x <= inner.x && outer.y <= inner.y &&
      outer.x + outer.w >= inner.x + inner.w &&
      outer.y + outer.h >= inner.y + inner.h
  }

  return {
    pack,
    get usedArea() { return usedArea },
    get width() { return width },
    get height() { return height },
  }
}
