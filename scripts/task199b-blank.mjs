// task199b-blank — THE FIELD REPORT TRIAGE: «На вебгл вообще пусто, в статах
// будто окклюдеры считаются». Three independent channels, one page:
//   (1) window.__hizStats — is the loop alive (drawn/occluded updating)?
//   (2) canvas.toDataURL() — the DRAWING BUFFER content (preserve:true
//       makes it readable any time) — did the color pass fill the canvas?
//   (3) page.screenshot() — the COMPOSITOR output — what the user SEES.
// The phone report says (1) alive + (3) empty. The split (2)-vs-(3) names
// the guilty half: a blank (2) = the draw path; a full (2) with a blank (3)
// = the present/compositor path.
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 8911)
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'],
})
// THE PHONE SHAPE: portrait 360x764 css, deviceScaleFactor 3 (the field
// report's viewport), so the dprCap:2 path and the portrait aspect ride too.
const page = await browser.newPage({ viewport: { width: 360, height: 764 }, deviceScaleFactor: 3 })

async function probe(url, tag) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.validation !== null && window.__hizStats.drawn > 0, null, { timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const s1 = await page.evaluate(() => {
    const c = document.querySelector('#hiz-canvas')
    const st = window.__hizStats
    let ctxAttr = null
    let buf = 'n/a'
    let dataLen = -1, sample = ''
    try {
      const gl = c.getContext('webgl2')
      ctxAttr = gl ? gl.getContextAttributes() : null
      buf = gl ? `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}` : 'n/a'
      const url2 = c.toDataURL('image/png')
      dataLen = url2.length
      sample = url2.slice(-64)
    } catch (e) { sample = `err:${e.message}` }
    const r = c.getBoundingClientRect()
    return {
      mode: st?.mode, drawn: st?.drawn, occluded: st?.occlusionCulled,
      cssW: r.width, cssH: r.height, cw: c.width, ch: c.height,
      buf, ctxAttr, dataLen, sample,
      tierLine: st?.tierLine,
    }
  })
  await page.screenshot({ path: `scripts/task199b-${tag}-1.png` })
  const statsA = await page.evaluate(() => ({ drawn: window.__hizStats.drawn, occluded: window.__hizStats.occlusionCulled }))
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `scripts/task199b-${tag}-2.png` })
  const statsB = await page.evaluate(() => ({ drawn: window.__hizStats.drawn, occluded: window.__hizStats.occlusionCulled }))
  // is the compositor updating? two shots 1.5s apart on an auto-orbiting
  // camera must differ.
  console.log(`[${tag}] stats:`, JSON.stringify(s1))
  console.log(`[${tag}] statsA:`, JSON.stringify(statsA), 'statsB:', JSON.stringify(statsB), '(moving = the loop is alive)')
}

await probe(`http://localhost:${port}/demo/occlusion/?mode=webgl2`, 'gl')
await probe(`http://localhost:${port}/demo/occlusion/`, 'wg')
await browser.close()
console.log('done')
