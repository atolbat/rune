// probe180.mjs — Task 180's draw-aliveness probe. TWO methods:
//  (1) the CONTENT check — full-canvas readPixels right after each draw call
//      (inside the frame): the drawing buffer's checksum must CHANGE frame
//      to frame. THE RELIABLE method on this container: page.screenshot of a
//      WebGL canvas serves a STALE compositor bitmap for a fully-overlayed
//      canvas (verified against the LIVE pre-180 site — the deployed,
//      user-verified build behaves identically), so the screenshot diff is
//      a false negative here.
//  (2) the vfx demos — screenshot diffing works for their layouts (sheet
//      closed); kept as a secondary cross-check.
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })

// ── (1) the particles demo: the indexed soup's DRAWN CONTENT ──
await page.goto('http://localhost:8911/demo/particles/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
const sums = await page.evaluate(() => {
  const proto = WebGL2RenderingContext.prototype
  const out = []
  const od = proto.drawElements
  proto.drawElements = function () {
    const r = od.apply(this, arguments)
    const gl = this
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const px = new Uint8Array(4 * w * h)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2]
    out.push(sum)
    return r
  }
  return new Promise(res => setTimeout(() => { proto.drawElements = od; res(out.slice(0, 10)) }, 900))
})
const changing = new Set(sums).size > 1
console.log(`particles: post-draw checksums [${sums.slice(0, 6).join(', ')}…] → ${changing ? 'DRAWS + ANIMATES' : 'STATIC CONTENT (broken draw)'}`)
console.log('pill:', await page.textContent('.pt-pill'))

// ── (2) the vfx soups: screenshot cross-check ──
const REGION = { x: 60, y: 140, width: 420, height: 420 }
async function vfxAnim(demoName) {
  await page.goto('http://localhost:8911/demo/vfx/', { waitUntil: 'networkidle' })
  await page.evaluate((n) => {
    const rows = [...document.querySelectorAll('.pt-row')]
    rows.find(r => r.textContent.includes(n))?.dispatchEvent(new Event('click', { bubbles: true }))
  }, demoName)
  await page.waitForFunction(
    (n) => (document.querySelector('.pt-pill')?.textContent ?? '').includes(n),
    demoName, { timeout: 20_000 },
  )
  await page.waitForTimeout(1800)
  const a = PNG.sync.read(await page.screenshot({ clip: REGION }))
  await page.waitForTimeout(600)
  const b = PNG.sync.read(await page.screenshot({ clip: REGION }))
  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) diff++
  }
  console.log(`vfx ${demoName}: screenshot diff ${diff} → ${diff > 200 ? 'ANIMATES' : 'STATIC?'}`)
}

await vfxAnim('Trails & Collision')
await vfxAnim('Mesh Particles')
await browser.close()
