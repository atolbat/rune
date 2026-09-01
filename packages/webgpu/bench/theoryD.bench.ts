import { createPipelineCache } from '../src/index.ts'
import type { GpuPipelineDesc } from '../src/index.ts'

/**
 * Теория D: стратегия ключей кэша пайплайнов.
 * Вариант 1 (строковый): каждый кадр пересобирает структурный ключ
 *   (join полей + конкатенации) и лезет в Map<string, id>.
 * Вариант 2 (целочисленный): команда хранит pipelineId; на кадре — чтение
 *   плоского массива + проверка dirty-флага версий пайплайн-сигналов.
 * Гипотеза: целочисленный путь дешевле на порядок; строковый нужен
 * только при реактивном изменении дескриптора.
 */

const COMMANDS = 1000
const FRAMES = 200

const DESCS: GpuPipelineDesc[] = Array.from({ length: COMMANDS }, (_, i) => ({
  depth: { test: 'less', write: i % 2 === 0 },
  blend: i % 3 === 0 ? { src: 'src-alpha', dst: 'one-minus-src-alpha' } : false,
  raster: { cull: i % 2 === 0 ? 'back' : 'front' },
}))

const cache = createPipelineCache()
const shaderIds = DESCS.map((_, i) => (i * 2654435761) >>> 0)
const cachedIds = DESCS.map((desc, i) => cache.idOf(desc, shaderIds[i])) // прегретый кэш
const versions = new Uint32Array(COMMANDS) // версии пайплайн-сигналов команд

function runStringKeys(): number {
  let sink = 0
  for (let i = 0; i < COMMANDS; i++) {
    const id = cache.idOf(DESCS[i], shaderIds[i])
    sink ^= id
  }
  return sink
}

function runIntegerRegistry(): number {
  let sink = 0
  for (let i = 0; i < COMMANDS; i++) {
    if (versions[i] !== 0) {
      versions[i] = 0 // сигнал менялся бы — редкий путь
      sink ^= cache.idOf(DESCS[i], shaderIds[i])
      continue
    }
    sink ^= cachedIds[i] // горячий путь: плоское чтение массива
  }
  return sink
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

// прогрев
for (let i = 0; i < 50; i++) { runStringKeys(); runIntegerRegistry() }

const stringMs = bestOf(FRAMES, runStringKeys)
const integerMs = bestOf(FRAMES, runIntegerRegistry)

console.log('── Теория D: ключи кэша пайплайнов, кадр из 1000 команд ──')
console.log(`строковые ключи      : ${stringMs.toFixed(4)} мс`)
console.log(`целочисленный реестр : ${integerMs.toFixed(4)} мс`)
console.log(`целочисленный быстрее в ${(stringMs / integerMs).toFixed(1)} раза`)
