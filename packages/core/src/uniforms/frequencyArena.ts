import type { UniformArena, UniformSlotBytes } from './arena.ts'
import { createUniformArena } from './arena.ts'
import type { ByteRange } from './arena.ts'

/**
 * FrequencyArena: две зоны — 'frame' и 'draw'.
 * Frame-зона (камера, время) загружается ОДИН раз за кадр.
 * Draw-зона перезагружается при изменениях (value-compare).
 * Идея №3 из дизайн-досье: меньше загрузок и короче ленты.
 */
export interface FrequencyArena {
  /** Арена для пер-кадровых данных (u_view, u_time…). */
  readonly frame: UniformArena
  /** Арена для пер-draw данных (модели, материалы…). */
  readonly draw: UniformArena
  alloc(type: string, frequency: 'frame' | 'draw'): UniformSlotBytes
  /** Диапазоны обеих зон (для загрузок). */
  frameRanges(): readonly ByteRange[]
  drawRanges(): readonly ByteRange[]
  clearDirty(): void
}

/** Создаёт раздельную по частоте арену. */
export function createFrequencyArena(frameBytes = 4096, drawBytes = 1 << 16): FrequencyArena {
  const frame = createUniformArena(frameBytes)
  const draw = createUniformArena(drawBytes)
  return {
    frame,
    draw,
    alloc(type: string, frequency: 'frame' | 'draw'): UniformSlotBytes {
      return frequency === 'frame' ? frame.alloc(type) : draw.alloc(type)
    },
    frameRanges: () => frame.dirtyRanges(),
    drawRanges: () => draw.dirtyRanges(),
    clearDirty: () => { frame.clearDirty(); draw.clearDirty() },
  }
}
