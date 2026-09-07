/**
 * scripts/task147-analyze.mjs — pixel forensics on the muzzle screenshots:
 *   · dim-blue pixels  → the target markers (b dominant)
 *   · warm/bright      → tracers, muzzle flash, impact sparks (r dominant)
 *   · cyan/bright      → bolts + bolt impacts (b+g high, bright)
 * Per frame: count + bbox of each class + center-of-mass of the warm class
 * (where the fire lands vs where the markers sit).
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'

const dir = resolve(import.meta.dirname, '..', '.shots', 'task147')
const W = 960, H = 720

for (let i = 0; i < 20; i++) {
  const name = `muzzle-${String(i).padStart(2, '0')}.png`
  const png = PNG.sync.read(readFileSync(join(dir, name)))
  const d = png.data
  const imgW = png.width, imgH = png.height
  if (imgW !== W || imgH !== H) console.log(`${name} size ${imgW}x${imgH}`)

  let markers = null, warm = null, cyan = null
  let nMark = 0, nWarm = 0, nCyan = 0
  let warmX = 0, warmY = 0
  const add = (b, x, y) => {
    if (!b) return { x0: x, y0: y, x1: x, y1: y }
    b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y)
    return b
  }
  for (let y = 150; y < H - 90; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const o = (y * imgW + x) * 4
      const r = d[o], g = d[o + 1], b = d[o + 2]
      const lum = 0.3 * r + 0.55 * g + 0.15 * b
      if (lum < 24) continue
      if (b > r * 1.25 && b > 60 && r < 130 && g < 170) { markers = add(markers, x, y); nMark++ }
      else if (r > 140 && r > b * 1.3 && g > 60) { warm = add(warm, x, y); nWarm++; warmX += x; warmY += y }
      else if (b > 150 && g > 150 && r < 120) { cyan = add(cyan, x, y); nCyan++ }
    }
  }
  const fmt = (b, n) => b ? `[${b.x0},${b.y0}..${b.x1},${b.y1}] n=${n}` : '—'
  const com = nWarm > 0 ? ` warmCOM=(${Math.round(warmX / nWarm)},${Math.round(warmY / nWarm)})` : ''
  console.log(`${name} mark:${fmt(markers, nMark)} warm:${fmt(warm, nWarm)}${com} cyan:${fmt(cyan, nCyan)}`)
}
