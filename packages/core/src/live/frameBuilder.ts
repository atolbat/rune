// Сборщик кадра: тик всем live-командам, эмит активных.

import type { LiveCommand } from './liveCommand.ts'
import type { TapeWriter } from '../tape/writer.ts'

export function buildFrame(lives: readonly LiveCommand[], writer: TapeWriter): void {
  for (const live of lives) {
    live.tickFrame()
    live.emit(writer)
  }
}

/** Дозапись: live-команды без тика (перезапись сегмента в ту же ленту).
 *  Полный путь БЕЗ кэша: каждый сегмент перезаписывается заново
 *  (бенчмарк «полная перезапись» против кэш-реплея buildFrame). */
export function buildFrameReRecording(lives: readonly LiveCommand[], writer: TapeWriter): void {
  for (const live of lives) {
    live.emit(writer, true)
  }
}
