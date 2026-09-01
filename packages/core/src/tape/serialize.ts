// Сериализация ленты: переносимый снимок колонок писателя.
// Формат (little-endian i32): [count][op×count][a×count][b×count][c×count][d×count].
// Буфер transferable — основа доставки кадров между мирами (tape-пакет:
// воркер пишет ленту + арену, владелец парсит и исполняет тем же executor'ом).

import type { TapeWriter } from './writer.ts'
import type { TapeView } from './layout.ts'

/** Распарсенная лента: те же SoA-колонки поверх полученного буфера. */
export interface ParsedTape extends TapeView {
  /** Алиас count (совместимо со старыми диагностиками). */
  readonly opCount: number
}

/** Снимает ленту в новый ArrayBuffer (плотная копия использованных колонок). */
export function serializeTape(writer: TapeWriter): ArrayBuffer {
  const count = writer.count
  const columns = writer.columns
  const buffer = new ArrayBuffer((1 + count * 5) * 4)
  const words = new Int32Array(buffer)
  words[0] = count
  words.set(columns.op.subarray(0, count), 1)
  words.set(columns.a.subarray(0, count), 1 + count)
  words.set(columns.b.subarray(0, count), 1 + count * 2)
  words.set(columns.c.subarray(0, count), 1 + count * 3)
  words.set(columns.d.subarray(0, count), 1 + count * 4)
  return buffer
}

/** Восстанавливает ленту из буфера: колонки-виды без копий (буфер принадлежит вызывающему). */
export function parseTape(buffer: ArrayBuffer): ParsedTape {
  if (buffer.byteLength < 4 || buffer.byteLength % 4 !== 0) {
    throw new Error('rune: parseTape — повреждённый буфер ленты')
  }
  const words = new Int32Array(buffer)
  const count = words[0]
  if (count < 0 || (1 + count * 5) * 4 > buffer.byteLength) {
    throw new Error(`rune: parseTape — count ${count} не согласуется с размером буфера`)
  }
  return {
    count,
    opCount: count,
    op: words.subarray(1, 1 + count),
    a: words.subarray(1 + count, 1 + count * 2),
    b: words.subarray(1 + count * 2, 1 + count * 3),
    c: words.subarray(1 + count * 3, 1 + count * 4),
    d: words.subarray(1 + count * 4, 1 + count * 5),
  }
}
