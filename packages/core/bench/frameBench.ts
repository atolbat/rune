import {
  signal,
  OpCode,
  createSegmentStore,
  createLiveCommand,
  buildFrame,
  buildFrameReRecording,
  createTapeWriter,
} from '../src/index.ts'
import type { SignalCell, ReadableSignal, TapeWriter, LiveCommand, SegmentStore } from '../src/index.ts'

/** Результат бенчмарка кадра: полная перезапись против сегментного кэша. */
export interface FrameBenchResult {
  readonly commands: number
  readonly opsPerCommand: number
  readonly dirtyPerFrame: number
  readonly fullMs: number
  readonly cachedMs: number
  readonly speedup: number
}

interface World {
  readonly store: SegmentStore
  readonly frame: TapeWriter
  readonly lives: readonly LiveCommand[]
  readonly deps: readonly SignalCell<number>[]
}

/** Сравнивает два пути сборки кадра при заданном числе команд и грязных. */
export function measureFrameBuilders(
  commands: number,
  opsPerCommand: number,
  dirtyPerFrame: number,
  repeats: number,
): FrameBenchResult {
  const world = makeWorld(commands, opsPerCommand)
  warmUp(world)

  const fullMs = bestOf(repeats, () => runFullFrame(world))
  const cachedMs = bestOf(repeats, () => runCachedFrame(world, dirtyPerFrame))

  return { commands, opsPerCommand, dirtyPerFrame, fullMs, cachedMs, speedup: fullMs / cachedMs }
}

function makeWorld(commands: number, opsPerCommand: number): World {
  const store = createSegmentStore(commands)
  const lives: LiveCommand[] = []
  const deps: SignalCell<number>[] = []

  for (let i = 0; i < commands; i++) {
    const dep = signal(i)
    deps.push(dep)
    lives.push(createLiveCommand(store, recorderFor(opsPerCommand, dep), [dep]))
  }

  return { store, frame: createTapeWriter(commands * 2), lives, deps }
}

/** Репрезентативный recorder: как реальная live-команда — читает зависимость
 *  и на каждый опс резолвит «uniform-значение» (сигнал + математика +
 *  fround-compare против прошлого значения — ровно та работа, которую
 *  сегментный кэш пропускает: арена.write делает value-compare на каждый
 *  элемент, компилятор — resolve на каждый uniform). */
function recorderFor(ops: number, dep: SignalCell<number>): (writer: TapeWriter) => void {
  let previous = new Float32Array(ops)
  return writer => {
    const base = dep.value
    for (let i = 0; i < ops; i++) {
      const value = Math.sin(base + i * 0.25) * Math.cos(i * 0.125) * 0.5 + 0.5
      const quantized = value * 1024 | 0
      if (Math.fround(value) !== previous[i]) previous[i] = value
      writer.emit(OpCode.Draw, i, 0, 0, quantized)
    }
  }
}

function warmUp(world: World): void {
  buildFrame(world.lives, world.frame)
  for (let i = 0; i < 64; i++) runCachedFrame(world, 4)
  for (let i = 0; i < 4; i++) runFullFrame(world) // разгон TurboFan/FTL для полного пути
}

function runFullFrame(world: World): void {
  world.frame.reset()
  buildFrameReRecording(world.lives, world.frame)
}

function runCachedFrame(world: World, dirty: number): void {
  world.frame.reset()
  markDirty(world.deps, dirty)
  buildFrame(world.lives, world.frame)
}

function markDirty(deps: readonly SignalCell<number>[], count: number): void {
  const step = Math.max(1, (deps.length / count) | 0)
  for (let i = 0; i < count; i++) {
    const dep = deps[(i * step) % deps.length]
    dep.value = dep.value + 1
  }
}

function bestOf(repeats: number, run: () => void): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now()
    run()
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}
