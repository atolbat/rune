import type { UniformArena, UniformSlotBytes } from './arena.ts'
import { createUniformArena } from './arena.ts'
import type { ByteRange } from './arena.ts'

/**
 * FrequencyArena: two zones — 'frame' and 'draw'.
 * The frame zone (camera, time) is uploaded ONCE per frame.
 * The draw zone is re-uploaded on changes (value-compare).
 * Idea #3 from the design dossier: fewer uploads and a shorter tape.
 */
export interface FrequencyArena {
  /** Arena for per-frame data (u_view, u_time…). */
  readonly frame: UniformArena
  /** Arena for per-draw data (models, materials…). */
  readonly draw: UniformArena
  alloc(type: string, frequency: 'frame' | 'draw'): UniformSlotBytes
  /** Ranges of both zones (for uploads). */
  frameRanges(): readonly ByteRange[]
  drawRanges(): readonly ByteRange[]
  clearDirty(): void
}

/** Creates a frequency-separated arena. */
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
