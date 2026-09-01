import { createUniformArena } from '@rune/core'
import type { UniformArena, UniformSlot } from '@rune/core'
import { createCountingGL } from '../src/index.ts'

/**
 * Теория B: загрузка юниформов — per-call (gl.uniform* на каждый грязный слот)
 * против coalesced (слияние грязных диапазонов → bufferSubData + bindBufferRange).
 * Гипотеза: coalesced меньше вызовов при плотной арене, per-call дешевле при
 * редких грязных слотах. Порог Documentируется, победитель — дефолт.
 */

const TOTAL = 100      // vec4-юниформов в арене
const DIRTY = [4, 20, 50, 100] // сценариев грязных за кадр

function prepare(): { arena: UniformArena; slots: UniformSlot[] } {
  const arena = createUniformArena()
  const slots: UniformSlot[] = []
  for (let i = 0; i < TOTAL; i++) slots.push(arena.alloc('vec4'))
  for (const slot of slots) arena.writeVec4(slot, 1, 2, 3, 4) // стартовое заполнение
  arena.clearDirty()
  return { arena, slots }
}

function runPerCall(arena: UniformArena, slots: UniformSlot[], dirty: number, gl: { uniform4f(name: string, x: number, y: number, z: number, w: number): void }, f32: Float32Array): number {
  let calls = 0
  for (let i = 0; i < dirty; i++) {
    const slot = slots[i]
    if (!arena.isDirty(slot)) continue
    const at = slot.offset >> 2
    gl.uniform4f(`u${i}`, f32[at], f32[at + 1], f32[at + 2], f32[at + 3])
    calls++
  }
  return calls
}

function runCoalesced(arena: UniformArena, slots: UniformSlot[], dirty: number, gl: { bufferSubData(o: number, b: Uint8Array): void; bindBufferRange(o: number, s: number): void }): number {
  let calls = 0
  const ranges = arena.dirtyRanges()
  for (const range of ranges) {
    gl.bufferSubData(range.from, arena.bytes.subarray(range.from, range.to))
    gl.bindBufferRange(range.from, range.to - range.from)
    calls += 2
  }
  return calls
}

const gl = createCountingGL()
console.log('── Теория B: per-call против coalesced (100 vec4-юниформов) ──')
console.log('грязных | per-call вызовов | coalesced вызовов | per-call мс | coalesced мс')

for (const dirty of DIRTY) {
  const a = prepare()
  const b = prepare()
  const f32a = new Float32Array(a.arena.bytes.buffer)
  const f32b = new Float32Array(b.arena.bytes.buffer)

  for (let i = 0; i < dirty; i++) a.arena.writeVec4(a.slots[i], 9, 9, 9, 9)
  for (let i = 0; i < dirty; i++) b.arena.writeVec4(b.slots[i], 9, 9, 9, 9)

  const perCallMs = bestOf(2000, () => runPerCall(a.arena, a.slots, dirty, gl, f32a))
  const coalescedMs = bestOf(2000, () => runCoalesced(b.arena, b.slots, dirty, gl))
  const perCallCount = countCalls(() => runPerCall(a.arena, a.slots, dirty, gl, f32a))
  const coalescedCount = countCalls(() => runCoalesced(b.arena, b.slots, dirty, gl))

  console.log(
    `${String(dirty).padStart(7)} | ${String(perCallCount).padStart(17)} | ${String(coalescedCount).padStart(17)} | ${perCallMs.toFixed(6).padStart(12)} | ${coalescedMs.toFixed(6).padStart(12)}`,
  )
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now()
    run()
    const elapsed = performance.now() - startedAt
    if (elapsed < best) best = elapsed
  }
  return best
}

function countCalls(run: () => number): number {
  return run()
}
