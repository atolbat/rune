// task199-glcanvas — the GL live canvas CONTENT check (the screenshot
// staleness workaround from probe180's dossier: read the drawing buffer
// directly). The checksum must be a real scene (not clear-color).
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 8911)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
await page.goto(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0, null, { timeout: 60_000 })

const out = await page.evaluate(() => {
  const c = document.querySelector('#hiz-canvas')
  if (c === null) return { error: 'no canvas' }
  const gl = c.getContext('webgl2')
  if (gl === null) return { error: 'no webgl2 context (the renderer owns it)' }
  return { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight }
})
console.log('canvas:', JSON.stringify(out))

// the renderer owns the context — instrument readPixels through the
// prototype (the probe180 pattern): checksum right after the instanced
// draw (the facade's instanced path — drawElementsInstanced)
const sums = await page.evaluate(() => {
  const proto = WebGL2RenderingContext.prototype
  const seen = []
  const wrap = (name) => {
    const orig = proto[name]
    proto[name] = function () {
      const r = orig.apply(this, arguments)
      const gl = this
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
      const px = new Uint8Array(4 * w * h)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      let sum = 0, lit = 0
      for (let i = 0; i < px.length; i += 4) { sum += px[i] + px[i + 1] + px[i + 2]; if (px[i + 3] > 0) lit++ }
      seen.push({ call: name, sum, lit, w, h })
      return r
    }
    return () => { proto[name] = orig }
  }
  const undo = ['drawElements', 'drawElementsInstanced', 'multiDrawElementsInstancedWEBGL'].map(wrap)
  return new Promise(res => setTimeout(() => { undo.forEach(u => u()); res(seen.slice(0, 4)) }, 1200))
})
console.log('post-draw canvas checksums:', JSON.stringify(sums))
// the zero rows are the z-PREPASS draws (readPixels then reads the bound
// r32f FBO, not the canvas); the nonzero rows are the COLOR PASS — the
// canvas itself. LIVE = any color row with REAL content — and "content"
// means ABOVE THE CLEAR FLOOR (Task 200's lesson: the 199 form of this
// gate accepted a bare clear — sum > 0 and alpha > 0 are vacuously true
// for the sky color; the phone's empty canvas sailed through it). The
// floor: the clear color's own sum (r+g+b ≈ 48/px) × 1.2 — a rendered
// city averages ~90/px; a cleared canvas cannot pass.
const CLEAR_SUM = 255 * (0.045 + 0.055 + 0.09) // the sky clear, per pixel
const colorRows = sums.filter(s => s.sum > 0)
const floorSum = CLEAR_SUM * 1.2 * sums.reduce((acc, s) => acc + (s.sum > 0 ? s.w * s.h : 0), 0)
const ok = colorRows.length > 0 && colorRows.every(s => s.lit === s.w * s.h) && colorRows.length !== sums.length
  && colorRows.reduce((acc, s) => acc + s.sum, 0) > floorSum
console.log(ok ? 'GL CANVAS CONTENT: LIVE (the color pass fills the canvas ABOVE the clear floor)' : 'GL CANVAS CONTENT: EMPTY/BROKEN (at or below the clear floor — a wiped canvas)')
await browser.close()
