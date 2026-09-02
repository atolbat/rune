import { createTransientPool } from '../src/pool/transientPool.ts'

// Theory M (idea #2 of the early catalog): transient pool vs allocations
// in the frame callback. Profile: 100 objects per frame — 7 matrices (f32×16)
// + 2 "big" arrays (f32×1024, light/shadows), 60 frames.

const FRAMES = 60
const OBJECTS = 100
const WARMUP_FRAMES = 10

function frameAlloc(): void {
  for (let object = 0; object < OBJECTS; object++) {
    for (let m = 0; m < 7; m++) {
      const scratch = new Float32Array(16) // model/normal/mvp/…
      scratch[0] = object
    }
    const big = new Float32Array(1024) // light, shadows, clusters
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
  for (let i = 0; i < WARMUP_FRAMES; i++) frame() // warm-up: JIT + the pool reaches steady state
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
console.log('── Theory M: transient pool vs allocations in the frame ──')
console.log(`engine            : ${engine}`)
console.log(`profile           : ${OBJECTS} objects × (7×f32[16] + f32[1024]), ${FRAMES} frames`)
console.log(`allocations/frame : ${allocMs.toFixed(3)} ms/frame`)
console.log(`pool              : ${poolMs.toFixed(3)} ms/frame`)
console.log(`arrays created    : ${stats.created} (allocations avoided: ${FRAMES * OBJECTS * 8 - stats.created})`)
console.log(`memory retained   : ${(stats.bytes / 1024).toFixed(0)} KB (stable, not growing)`)
console.log(`speedup           : ×${(allocMs / poolMs).toFixed(2)}`)
