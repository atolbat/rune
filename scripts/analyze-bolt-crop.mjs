/**
 * scripts/analyze-bolt-crop.mjs — a FINE crop analysis of the bolt region:
 * given a screenshot, finds the bounding box of the bolt column and prints
 * a 1-cell-per-4px ASCII luminance map of just that region — enough to see
 * per-segment continuity at pixel scale.
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const file = process.argv[2] ?? '.shots/strike-00.png'
const png = PNG.sync.read(readFileSync(file))
const { width: W, height: H, data } = png

// find bright pixels (lum > 120) in the upper 60% of the image (the sky —
// the bolt; the ground flash is the bottom band)
let minX = W, maxX = 0, minY = H, maxY = 0, n = 0
for (let y = 0; y < H * 0.6; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const lum = Math.max(data[i], data[i + 1], data[i + 2])
    if (lum > 120) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
}
console.log(`bright(>120) pixels: ${n}, bbox x [${minX},${maxX}] y [${minY},${maxY}]`)
if (n === 0) { console.log('(no bolt visible in this frame)'); process.exit(0) }

// pad the bbox and print a 4px-per-cell map
const px0 = Math.max(0, minX - 20), px1 = Math.min(W, maxX + 20)
const py0 = Math.max(0, minY - 10), py1 = Math.min(H, maxY + 10)
const CELL = 4
const cols = Math.floor((px1 - px0) / CELL), rows = Math.floor((py1 - py0) / CELL)
const TH = [8, 32, 80, 160, 220], CH = [' ', '.', ':', '+', '*', '#']
for (let r = 0; r < rows; r++) {
  let line = ''
  for (let c = 0; c < cols; c++) {
    let max = 0
    for (let y = py0 + r * CELL; y < py0 + (r + 1) * CELL; y++) {
      for (let x = px0 + c * CELL; x < px0 + (c + 1) * CELL; x++) {
        const i = (y * W + x) * 4
        const lum = Math.max(data[i], data[i + 1], data[i + 2])
        if (lum > max) max = lum
      }
    }
    let ch = ' '
    for (let k = 0; k < TH.length; k++) if (max >= TH[k]) ch = CH[k + 1]
    line += ch
  }
  console.log(line)
}

// connectivity check: for each row band of 8px, does any bright (>80)
// pixel exist? a connected bolt has every band covered.
let gaps = 0, covered = 0
for (let y = py0; y < py1; y += 8) {
  let hit = false
  for (let x = px0; x < px1; x++) {
    const i = (y * W + x) * 4
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 80) { hit = true; break }
  }
  if (hit) covered++; else gaps++
}
console.log(`row bands: ${covered} covered, ${gaps} GAPS (a continuous bolt has 0 gaps)`)
