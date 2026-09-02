import { createUploadScheduler, streamTexture } from '../src/index.ts'

/**
 * Theory K: texture streaming chunk size.
 * Variant 1: large tiles (256 rows = ~128KB per 128px row... for 512px: 512KB)
 * Variant 2: small tiles (32 rows) — more jobs, finer granularity
 * Hypothesis: with an AIMD window large chunks idle less often (full window
 * usage → growth), but small ones give more even progress. We compare frames
 * until full completion at the same window.
 */

const WIDTH = 512
const HEIGHT = 2048
const SOURCE = new Uint8Array(WIDTH * HEIGHT * 4)

function measure(tileHeight: number, windowBytes: number): number {
  const scheduler = createUploadScheduler({ initialBytes: windowBytes })
  const upload = streamTexture(scheduler, SOURCE, WIDTH, HEIGHT, () => {}, { tileWidth: WIDTH, tileHeight })
  let frames = 0
  while (scheduler.pending > 0 && frames < 500) {
    scheduler.drain()
    frames++
  }
  void upload.done
  return frames
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const value = run()
    if (value < best) best = value
  }
  return best
}

const WINDOW = 256 << 10 // 256KB/frame
measure(256, WINDOW); measure(32, WINDOW) // warm-up

const bigTiles = bestOf(9, () => measure(256, WINDOW))
const smallTiles = bestOf(9, () => measure(32, WINDOW))
const mediumTiles = bestOf(9, () => measure(64, WINDOW))

console.log('── Theory K: texture 512×2048 chunk size (window 256KB/frame) ──')
console.log(`tile 256 rows (512KB): ${bigTiles} frames`)
console.log(`tile 64 rows (128KB): ${mediumTiles} frames`)
console.log(`tile 32 rows (64KB)  : ${smallTiles} frames`)
console.log('conclusion: a large chunk minimizes frames (full window usage); a small one — more even progress')
