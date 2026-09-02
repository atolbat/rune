import type { DrawSpec } from '@rune/webgl2'
import { createCompileContext, compileDrawSpec } from '@rune/webgl2'
import type { CompiledCommand, GLCompileContext } from '@rune/webgl2'
import type { TapeWriter, UniformArena } from '@rune/core'
import { createUniformArena, serializeTape } from '@rune/core'

/** Frame delivery mode: the whole used arena or only the dirty part. */
export type ShipMode = 'full' | 'dirty'

/** A frame ready for transfer between worlds (both buffers transferable). */
export interface RemoteFrame {
  readonly tape: ArrayBuffer
  readonly arena: ArrayBuffer
  readonly arenaFrom: number
  readonly mode: ShipMode
}

/** Stub renderer: the same compiler and slots, no GPU at all. */
export interface TapeStub {
  readonly arena: UniformArena
  readonly ctx: GLCompileContext
  /** Compiles a spec — the slot layout is identical to the main world. */
  command(spec: DrawSpec): CompiledCommand
  /** Captures a frame: the tape + arena bytes (the mode is chosen by theory G). */
  ship(writer: TapeWriter, mode?: ShipMode): RemoteFrame
}

/** Creates a stub for recording tapes in a worker (DOM-free, GPU-free). */
export function createStub(arenaBytes: number = 1 << 18): TapeStub {
  const arena = createUniformArena(arenaBytes)
  const ctx = createCompileContext(arena, 'codegen')
  return {
    arena,
    ctx,
    command: spec => compileDrawSpec(spec, ctx),
    ship: (writer, mode = 'dirty') => shipFrame(arena, writer, mode),
  }
}

function shipFrame(arena: UniformArena, writer: TapeWriter, mode: ShipMode): RemoteFrame {
  const tape = serializeTape(writer)
  const payload = mode === 'full'
    ? copyRange(arena.bytes, 0, arena.usedBytes)
    : copyDirtyRanges(arena)
  arena.clearDirty() // delivery = consumption: the frame is gone, the slots are clean
  return { tape, arena: payload.buffer, arenaFrom: payload.from, mode }
}

interface PayloadChunk {
  readonly buffer: ArrayBuffer
  readonly from: number
}

function copyRange(source: Uint8Array, from: number, to: number): PayloadChunk {
  const copy = source.slice(from, to)
  return { buffer: copy.buffer as ArrayBuffer, from }
}

function copyDirtyRanges(arena: UniformArena): PayloadChunk {
  const ranges = arena.dirtyRanges()
  if (ranges.length === 0) return { buffer: new ArrayBuffer(0), from: 0 }
  const from = ranges[0].from
  const to = ranges[ranges.length - 1].to
  return copyRange(arena.bytes, from, to)
}
