import type { DrawSpec } from '@rune/webgl2'
import { createCompileContext, compileDrawSpec } from '@rune/webgl2'
import type { CompiledCommand, GLCompileContext } from '@rune/webgl2'
import type { TapeWriter, UniformArena } from '@rune/core'
import { createUniformArena, serializeTape } from '@rune/core'

/** Режим доставки кадров: вся использованная арена или только грязное. */
export type ShipMode = 'full' | 'dirty'

/** Кадр, готовый к передаче между мирами (оба буфера transferable). */
export interface RemoteFrame {
  readonly tape: ArrayBuffer
  readonly arena: ArrayBuffer
  readonly arenaFrom: number
  readonly mode: ShipMode
}

/** Stub-рендерер: тот же компилятор и слоты, никакого GPU. */
export interface TapeStub {
  readonly arena: UniformArena
  readonly ctx: GLCompileContext
  /** Компилирует спек — layout слотов идентичен главному миру. */
  command(spec: DrawSpec): CompiledCommand
  /** Снимает кадр: лента + байты арены (режим выбирает теория G). */
  ship(writer: TapeWriter, mode?: ShipMode): RemoteFrame
}

/** Создаёт stub для записи лент в воркере (DOM-free, GPU-free). */
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
  arena.clearDirty() // доставка = потребление: кадр уехал, слоты чисты
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
