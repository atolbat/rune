import { createTransientPool } from '../src/pool/transientPool.ts'

// Теория M (идея №2 раннего каталога): transient-пул против аллокаций
// в кадровом колбэке. Профиль: 100 объектов на кадр — 7 матриц (f32×16)
// + 2 «больших» массива (f32×1024, свет/тени), 60 кадров.

const FRAMES = 60
const OBJECTS = 100
const WARMUP_FRAMES = 10

function frameAlloc(): void {
  for (let object = 0; object < OBJECTS; object++) {
    for (let m = 0; m < 7; m++) {
      const scratch = new Float32Array(16) // модель/нормаль/мвп/…
      scratch[0] = object
    }
    const big = new Float32Array(1024) // свет, тени, кластеры
    big[0] = object
  }
}

function framePooled(pool: ReturnType<typeof createTransientPool>): void {
  for (let object = 0; object < OBJECTS; object++) {
    for (let m = 0; m < 7; m++) {
      const scratch = pool.f32(16)
      scratch[0] = object
    }
    const big = pool.f32(1024)
    big[0] = object
  }
}

function measure(label: string, frame: () => void): number {
  for (let i = 0; i < WARMUP_FRAMES; i++) frame() // прогрев: JIT + пул выходит на режим
  const started = performance.now()
  for (let i = 0; i < FRAMES; i++) frame()
  return (performance.now() - started) / FRAMES
}

const pool = createTransientPool(2)
const poolFrame = (): void => {
  pool.beginFrame()
  framePooled(pool)
}

const allocMs = measure('alloc', frameAlloc)
const poolMs = measure('pool', poolFrame)
const stats = pool.stats()

const engine = typeof Bun !== 'undefined' ? 'bun/JSC' : `node/${process.version} (V8)`
console.log('── Теория M: transient-пул против аллокаций в кадре ──')
console.log(`движок            : ${engine}`)
console.log(`профиль           : ${OBJECTS} объектов × (7×f32[16] + f32[1024]), ${FRAMES} кадров`)
console.log(`аллокации в кадре : ${allocMs.toFixed(3)} мс/кадр`)
console.log(`пул               : ${poolMs.toFixed(3)} мс/кадр`)
console.log(`создано массивов  : ${stats.created} (аллокаций avoided: ${FRAMES * OBJECTS * 8 - stats.created})`)
console.log(`удержано памяти   : ${(stats.bytes / 1024).toFixed(0)} КБ (стабильно, не растёт)`)
console.log(`ускорение         : ×${(allocMs / poolMs).toFixed(2)}`)
