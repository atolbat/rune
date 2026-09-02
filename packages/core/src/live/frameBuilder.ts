// Frame builder: tick all live commands, emit the active ones.

import type { LiveCommand } from './liveCommand.ts'
import type { TapeWriter } from '../tape/writer.ts'

export function buildFrame(lives: readonly LiveCommand[], writer: TapeWriter): void {
  for (const live of lives) {
    live.tickFrame()
    live.emit(writer)
  }
}

/** Re-record: live commands without a tick (segment rewrite into the same tape).
 *  The full path WITHOUT the cache: every segment is rewritten from scratch
 *  (the "full rewrite" benchmark vs the buildFrame cache replay). */
export function buildFrameReRecording(lives: readonly LiveCommand[], writer: TapeWriter): void {
  for (const live of lives) {
    live.emit(writer, true)
  }
}
