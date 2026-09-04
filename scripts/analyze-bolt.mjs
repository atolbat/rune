/**
 * scripts/analyze-bolt.mjs — ASCII-luminance map of a screenshot: where are
 * the bright pixels, and is there a continuous vertical column or a broken
 * chain? Prints a downsampled grid of max-luminance per cell.
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const file = process.argv[2] ?? '.shots/fb-lightning-05.png'
const png = PNG.sync.read(readFileSync(file))
const { width: W, height: H, data } = png

const CW = 96, CH = 48 // cells
const cellW = Math.floor(W / CW), cellH = Math.floor(H / CH)
const grid = []
for (let cy = 0; cy < CH; cy++) {
  const row = []
  for (let cx = 0; cx < CW; cx++) {
    let max = 0
    for (let y = cy * cellH; y < (cy + 1) * cellH; y += 2) {
      for (let x = cx * cellW; x < (cx + 1) * cellW; x += 2) {
        const i = (y * W + x) * 4
        const lum = Math.max(data[i], data[i + 1], data[i + 2])
        if (lum > max) max = lum
      }
    }
    row.push(max)
  }
  grid.push(row)
}
// print: ' ' <16, '.' <48, ':' <96, '+' <160, '*' <255, '#' >=255
const CHARS = [' ', '.', ':', '+', '*', '#']
const THRESH = [16, 48, 96, 160, 255]
for (const row of grid) {
  let line = ''
  for (const v of row) {
    let c = ' '
    for (let k = 0; k < THRESH.length; k++) if (v >= THRESH[k]) c = CHARS[k + 1] ?? '#'
    if (v >= 255) c = '#'
    line += c
  }
  console.log(line)
}
