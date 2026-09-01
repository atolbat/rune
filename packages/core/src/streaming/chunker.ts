// Чанкер: построчная нарезка текстуры на тайлы (крупный чанк — теория K).

export interface TileRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Тайлы полной ширины (ряды высотой tileH, крайний обрезается). */
export function chunkRect(width: number, height: number, tileH: number): TileRect[] {
  if (tileH < 1) throw new Error('rune: chunkRect требует tileH >= 1')
  const tiles: TileRect[] = []
  for (let y = 0; y < height; y += tileH) {
    const rows = Math.min(tileH, height - y)
    tiles.push({ x: 0, y, width, height: rows })
  }
  return tiles
}

/** Число тайлов без построения массива — ровно chunkRect(...).length.
 *  (Баг-запах прошлой версии: chunkRect.length — арность функции (3),
 *  а не длина массива; результат «случайно сходился».) */
export function countTiles(width: number, height: number, tileH: number): number {
  if (tileH < 1) throw new Error('rune: countTiles требует tileH >= 1')
  if (height <= 0) return 0
  return Math.ceil(height / tileH)
}

/** Высота тайла под байтовый бюджет (потолок 256 строк, минимум 1). */
export function tileForBudget(width: number, budgetBytes: number): number {
  const rowBytes = width * 4
  if (rowBytes <= 0) return 1
  return Math.max(1, Math.min(256, Math.floor(budgetBytes / rowBytes)))
}

/**
 * Байты тайла: полный ряд — subarray без копии; горизонтальный срез —
 * плотная копия (GPU-строки обязаны быть подряд).
 */
export function tileBytes(tile: TileRect, source: Uint8Array, sourceWidth: number): Uint8Array {
  if (tile.width === sourceWidth) {
    return source.subarray(tile.y * sourceWidth * 4, (tile.y + tile.height) * sourceWidth * 4)
  }
  const out = new Uint8Array(tile.width * tile.height * 4)
  for (let row = 0; row < tile.height; row++) {
    const from = ((tile.y + row) * sourceWidth + tile.x) * 4
    out.set(source.subarray(from, from + tile.width * 4), row * tile.width * 4)
  }
  return out
}
