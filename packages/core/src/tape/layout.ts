// View ленты: ноль копий — исполнитель читает те же колонки, что писатель.

import type { TapeWriter, WriterColumns } from './writer.ts'

export interface TapeView {
  readonly count: number
  readonly op: Int32Array
  readonly a: Int32Array
  readonly b: Int32Array
  readonly c: Int32Array
  readonly d: Int32Array
}

export function writerView(writer: TapeWriter): TapeView {
  const columns: WriterColumns = writer.columns
  return {
    count: writer.count,
    op: columns.op,
    a: columns.a,
    b: columns.b,
    c: columns.c,
    d: columns.d,
  }
}
