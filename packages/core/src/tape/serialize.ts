// Tape serialization: a portable snapshot of the writer's columns.
// Format (little-endian i32): [count][op×count][a×count][b×count][c×count][d×count].
// The buffer is transferable — the basis for delivering frames between
// worlds (tape packet: a worker writes the tape + arena, the owner parses
// and executes it with the same executor).

import type { TapeWriter } from './writer.ts'
import type { TapeView } from './layout.ts'

/** Parsed tape: the same SoA columns over the received buffer. */
export interface ParsedTape extends TapeView {
  /** Alias of count (compatible with old diagnostics). */
  readonly opCount: number
}

/** Snapshots the tape into a new ArrayBuffer (a dense copy of the used columns). */
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

/** Restores the tape from a buffer: column views without copies (the buffer belongs to the caller). */
export function parseTape(buffer: ArrayBuffer): ParsedTape {
  if (buffer.byteLength < 4 || buffer.byteLength % 4 !== 0) {
    throw new Error('rune: parseTape — corrupted tape buffer')
  }
  const words = new Int32Array(buffer)
  const count = words[0]
  if (count < 0 || (1 + count * 5) * 4 > buffer.byteLength) {
    throw new Error(`rune: parseTape — count ${count} is inconsistent with the buffer size`)
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
