/**
 * scripts/bolt-max.mjs — the TEMPORAL MAX composite of the screencast
 * frames: per pixel, the max luminance over the whole captured window. If
 * the bolt is EVER continuous (any frame, any strobe phase), the composite
 * shows it; if the composite still has gaps in the channel, the geometry
 * itself is broken. Prints the crop map + writes cast-max.png.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('usage: bun scripts/bolt-max.mjs cast-00.png cast-01.png …')
  process.exit(1)
}

let acc = null, W = 0, H = 0
for (const f of files) {
  const png = PNG.sync.read(readFileSync(f))
  if (acc === null) {
    W = png.width; H = png.height
    acc = new Float32Array(W * H)
  }
  for (let p = 0; p < W * H; p++) {
    const i = p * 4
    const lum = Math.max(png.data[i], png.data[i + 1], png.data[i + 2])
    if (lum > acc[p]) acc[p] = lum
  }
}
console.log(`composited ${files.length} frames (${W}x${H})`)

// write the composite as a grayscale png
const out = new PNG({ width: W, height: H })
for (let p = 0; p < W * H; p++) {
  const v = Math.round(acc[p])
  out.data[p * 4] = v; out.data[p * 4 + 1] = v; out.data[p * 4 + 2] = v; out.data[p * 4 + 3] = 255
}
writeFileSync('.shots/cast-max.png', PNG.sync.write(out))

// the crop map: the sky region above the ground flash — the bolt's channel
// zone. Find the bright bbox first (ignore the header band y < 80).
let minX = W, maxX = 0, minY = H, maxY = 0, n = 0
for (let y = 80; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (acc[y * W + x] > 100) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
}
console.log(`bright(>100) pixels y>80: ${n}, bbox x [${minX},${maxX}] y [${minY},${maxY}]`)
const px0 = Math.max(0, minX - 30), px1 = Math.min(W, maxX + 30)
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
        if (acc[y * W + x] > max) max = acc[y * W + x]
      }
    }
    let ch = ' '
    for (let k = 0; k < TH.length; k++) if (max >= TH[k]) ch = CH[k + 1]
    line += ch
  }
  console.log(line)
}

// the connectivity check: 8px row bands in the bbox, covered = any pixel >60
let gaps = 0, covered = 0, gapRows = []
for (let y = py0; y < py1; y += 8) {
  let hit = false
  for (let x = px0; x < px1; x++) {
    if (acc[y * W + x] > 60) { hit = true; break }
  }
  if (hit) covered++; else { gaps++; gapRows.push(y) }
}
console.log(`row bands: ${covered} covered, ${gaps} GAPS${gapRows.length ? ' at y ' + gapRows.join(',') : ''}`)
