import type { UniformArena } from '@rune/core'
import { parseTape } from '@rune/core'
import { createExecutor } from '@rune/webgl2'
import type { CompiledCommand, GLFacade, GLExecutor, UniformStrategy } from '@rune/webgl2'
import type { RemoteFrame } from './stub.ts'

/** Структура clear-дескриптора — приведена к GLExecutorOptions.clears
 *  (легаси-имя ClearDesc сохранено в публичном API tape). */
export type ClearDesc = { readonly color: readonly [number, number, number, number]; readonly depth: number | null }

/** Проигрыватель удалённых кадров: слияние арены + прогон через исполнитель. */
export interface TapePlayer {
  play(frame: RemoteFrame): void
  readonly executor: GLExecutor
}

/** Зависимости player: то же, что у executor, минус сегменты. */
export interface TapePlayerDeps {
  readonly gl: GLFacade
  readonly arena: UniformArena
  readonly commands: readonly CompiledCommand[]
  readonly clears?: readonly ClearDesc[]
  readonly uniformStrategy?: UniformStrategy
}

/** Создаёт player на стороне владельца GPU. */
export function createTapePlayer(deps: TapePlayerDeps): TapePlayer {
  const executor = createExecutor({
    gl: deps.gl,
    arena: deps.arena,
    commands: deps.commands,
    clears: deps.clears ?? [],
    uniformStrategy: deps.uniformStrategy ?? 'auto',
  })
  return { executor, play: frame => playFrame(deps.arena, executor, frame) }
}

function playFrame(arena: UniformArena, executor: GLExecutor, frame: RemoteFrame): void {
  mergeArena(arena, frame)
  executor.run(parseTape(frame.tape))
}

/** Сливает доставленные байты: importBytes маркАет пересечённые слоты. */
function mergeArena(arena: UniformArena, frame: RemoteFrame): void {
  if (frame.arena.byteLength === 0) return
  arena.importBytes(frame.arenaFrom, new Uint8Array(frame.arena))
}
