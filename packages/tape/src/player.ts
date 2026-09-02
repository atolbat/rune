import type { UniformArena } from '@rune/core'
import { parseTape } from '@rune/core'
import { createExecutor } from '@rune/webgl2'
import type { CompiledCommand, GLFacade, GLExecutor, UniformStrategy } from '@rune/webgl2'
import type { RemoteFrame } from './stub.ts'

/** Clear-descriptor struct — aligned with GLExecutorOptions.clears
 *  (the legacy name ClearDesc is kept in the tape public API). */
export type ClearDesc = { readonly color: readonly [number, number, number, number]; readonly depth: number | null }

/** Remote frame player: arena merge + a run through the executor. */
export interface TapePlayer {
  play(frame: RemoteFrame): void
  readonly executor: GLExecutor
}

/** Player dependencies: the same as the executor's, minus segments. */
export interface TapePlayerDeps {
  readonly gl: GLFacade
  readonly arena: UniformArena
  readonly commands: readonly CompiledCommand[]
  readonly clears?: readonly ClearDesc[]
  readonly uniformStrategy?: UniformStrategy
}

/** Creates a player on the GPU owner's side. */
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

/** Merges the delivered bytes: importBytes marks the intersected slots. */
function mergeArena(arena: UniformArena, frame: RemoteFrame): void {
  if (frame.arena.byteLength === 0) return
  arena.importBytes(frame.arenaFrom, new Uint8Array(frame.arena))
}
