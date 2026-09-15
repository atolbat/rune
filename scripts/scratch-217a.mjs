// scratch-217a — trace the diagonal stair climb
import { createCharacter } from '/home/z/my-project/rune/packages/core/src/character.ts'

const SPEC = {
  radius: 0.38, height: 1.7, walkSpeed: 7.5, accelGround: 55, accelAir: 16,
  gravity: 22, jumpSpeed: 8.2, stepHeight: 0.62, coyoteTime: 0.12,
  jumpBuffer: 0.15, maxFall: 55, snapDown: 0.2, fixedDt: 1 / 120,
}
const boxes = []
for (let s = 0; s < 10; s++) {
  const top = 0.55 + s * 0.55
  const depth = top + 2
  boxes.push({ cx: 0, cy: top - depth / 2, cz: -s * 1.1, hx: 2.2, hy: depth / 2, hz: 0.55 })
}
const stairTop = 6.05
boxes.push({ cx: 0, cy: stairTop - 0.25, cz: -13.2, hx: 2.2, hy: 0.25, hz: 2.6 })
const world = {
  groundBelow(x, z, fromY, out) {
    let best = -Infinity, found = false
    for (const b of boxes) {
      const top = b.cy + b.hy
      if (Math.abs(x - b.cx) > b.hx || Math.abs(z - b.cz) > b.hz) continue
      if (top > fromY + 1e-6 || top <= best) continue
      best = top; found = true
    }
    if (0 < fromY + 1e-6 && 0 > best) { out.top = 0; out.mover = -1; out.vx = 0; out.vy = 0; out.vz = 0; return true }
    if (!found) return false
    out.top = best; out.mover = 0; out.vx = 0; out.vy = 0; out.vz = 0
    return true
  },
  boxesIn(x0, y0, z0, x1, y1, z1, out) {
    let n = 0
    for (let k = 0; k < boxes.length && n < out.length; k++) {
      const b = boxes[k]
      if (x1 < b.cx - b.hx || x0 > b.cx + b.hx) continue
      if (y1 < b.cy - b.hy || y0 > b.cy + b.hy) continue
      if (z1 < b.cz - b.hz || z0 > b.cz + b.hz) continue
      out[n++] = k
    }
    return n
  },
  boxAt(id, out) {
    const b = boxes[id]
    if (b === undefined) return false
    out[0] = b.cx; out[1] = b.cy; out[2] = b.cz; out[3] = b.hx; out[4] = b.hy; out[5] = b.hz
    return true
  },
}
const ch = createCharacter(SPEC, world, -1.5, 0, 2.4)
for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, { dirX: 0, dirZ: 0, jumpHeld: false })
const a = (12 * Math.PI) / 180
const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
for (let k = 0; k < 1500 && ch.state.z > -10.8; k++) {
  ch.step(SPEC.fixedDt, dir)
  if (!ch.state.grounded) console.log("AIR", k, ch.state.x.toFixed(2), ch.state.y.toFixed(2), ch.state.z.toFixed(2));
  if (k % 24 === 0) console.log(`f${k}: x=${ch.state.x.toFixed(2)} y=${ch.state.y.toFixed(2)} z=${ch.state.z.toFixed(2)} grounded=${ch.state.grounded} vz=${ch.state.vz.toFixed(2)}`)
}
console.log('END', ch.state.x.toFixed(2), ch.state.y.toFixed(2), ch.state.z.toFixed(2), ch.state.grounded)
