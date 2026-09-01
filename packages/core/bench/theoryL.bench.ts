import { createFrequencyArena, createUniformSet, signal } from '../src/index.ts'
import { createUniformArena } from '../src/index.ts'

/**
 * Теория L: единая арена против frequency-split.
 * Сценарий: 100 команд, каждая с 4 draw-юниформами; 2 пер-кадровых поля
 * (камера+время) на всех. Гипотеза: split не меняет число записей, но
 * frame-зона грузится ОДНИМ куском раз в кадр (меньше вызовов загрузки),
 * а при статичной камере — ноль загрузок frame-зоны вовсе.
 */

const COMMANDS = 100
const FRAMES = 60

interface Zone {
  alloc(type: string, frequency: 'frame' | 'draw'): { offset: number; size: number }
  writeFloat(offset: number, value: number): void
  ranges(): number
  clear(): void
}

function makeUnified(): Zone {
  const arena = createUniformArena(1 << 16)
  return {
    alloc: type => arena.alloc(type as never),
    writeFloat: (offset, value) => arena.writeFloat({ index: 0, offset, size: 4, kind: 'f32' } as never, value),
    ranges: () => arena.dirtyRanges().length,
    clear: () => arena.clearDirty(),
  }
}

function makeSplit(): Zone {
  const freq = createFrequencyArena()
  return {
    alloc: (type, frequency) => freq.alloc(type, frequency),
    writeFloat: (offset, value) => freq.draw.writeFloat({ index: 0, offset, size: 4, kind: 'f32' } as never, value),
    ranges: () => freq.drawRanges().length + freq.frameRanges().length,
    clear: () => freq.clearDirty(),
  }
}

function simulate(zone: Zone, staticCamera: boolean): { uploads: number; ms: number } {
  // Пер-кадровые: камера (статичная или вращающаяся) + время
  const camera = createUniformSet('camera', { u_viewProj: 'mat4' }, { frequency: 'frame' })
  camera.attach(t => zone.alloc(t, 'frame'))
  const time = signal(0)
  camera.link({ u_viewProj: signal([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) })

  // Draw-юниформы команд
  const commands = []
  for (let i = 0; i < COMMANDS; i++) {
    const mat = createUniformSet(`mat${i}`, { a: 'float', b: 'float', c: 'float', d: 'float' }, { frequency: 'draw' })
    mat.attach(t => zone.alloc(t, 'draw'))
    const alpha = signal(i / COMMANDS)
    mat.link({ a: alpha })
    commands.push({ mat, alpha })
  }

  let uploads = 0
  const startedAt = performance.now()
  for (let frame = 0; frame < FRAMES; frame++) {
    time.value = frame / FRAMES
    for (const command of commands) {
      command.alpha.value = (frame % 10 === 0) ? command.alpha.peek() + 0.01 : command.alpha.peek()
    }
    // Запись кадра: сначала frame-набор, потом draw-наборы
    camera.write((offset, value) => zone.writeFloat(offset, value))
    for (const command of commands) {
      command.mat.write((offset, value) => zone.writeFloat(offset, value))
    }
    uploads += zone.ranges()
    zone.clear()
  }
  return { uploads, ms: performance.now() - startedAt }
}

function bestOf(repeats: number, run: () => { uploads: number; ms: number }): { uploads: number; ms: number } {
  let best = { uploads: Infinity, ms: Infinity }
  for (let i = 0; i < repeats; i++) {
    const result = run()
    if (result.ms < best.ms) best = result
  }
  return best
}

// Прогрев
simulate(makeUnified(), true); simulate(makeSplit(), true)

const unifiedRotating = bestOf(5, () => simulate(makeUnified(), false))
const splitRotating = bestOf(5, () => simulate(makeSplit(), false))
const splitStatic = bestOf(5, () => simulate(makeSplit(), true))

console.log('── Теория L: frequency-split арена (100 команд × 60 кадров) ──')
console.log(`единая арена (камера вращается) : ${unifiedRotating.uploads} загрузок, ${unifiedRotating.ms.toFixed(2)} мс`)
console.log(`split арена (камера вращается)  : ${splitRotating.uploads} загрузок, ${splitRotating.ms.toFixed(2)} мс`)
console.log(`split арена (камера СТАТИЧНА)   : ${splitStatic.uploads} загрузок, ${splitStatic.ms.toFixed(2)} мс`)
console.log(`выигрыш split при статичной камере: ×${(unifiedRotating.uploads / splitStatic.uploads).toFixed(1)} загрузок`)
