// scratch-217d — THE FRESH-VISITOR PROOF: what does the LIVE Pages site show RIGHT NOW?
// Mobile portrait (the user's case), default URL (what a bookmarked visitor loads), both backends.
// Decodes the compositor screenshot in-page (img → 2d canvas → stats) — the same method the
// gate used when it caught the original near-black sky (15/255). Saves PNGs as artifacts.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const LIVE = 'https://atolbat.github.io/rune/demo/walker/'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

async function brightness(page, shot) {
  return await page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const w = img.width, h = img.height
    const stat = (x0, y0, x1, y1) => {
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let sum = 0, dark = 0, n = 0
      for (let k = 0; k < d.length; k += 16) {
        const v = (d[k] + d[k + 1] + d[k + 2]) / 3
        sum += v; if (v < 32) dark++; n++
      }
      // sample a color too — proof the sky is BLUE, not just bright
      const px = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
      return { mean: +(sum / n).toFixed(1), dark: +(dark / n).toFixed(3), sky: px(w >> 1, h * 0.08 | 0), mid: px(w >> 1, h * 0.4 | 0), ground: px(w >> 1, h * 0.85 | 0) }
    }
    return { top: stat(0, 0, w, Math.floor(h * 0.3)), bottom: stat(0, Math.floor(h * 0.5), w, h) }
  }, shot.toString('base64'))
}

async function leg(tag, url, out) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })
  console.log(`[${tag}] goto ${url}`)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.waitForFunction(() => window.__walker && window.__walker.frame > 60 && window.__walker.drawn > 0, null, { timeout: 240_000 })
  await page.waitForTimeout(4000) // let the autopilot tour settle into the hills view
  const stats = await page.evaluate(() => {
    const w = window.__walker
    return { frame: w.frame, fps: w.fps, drawn: w.drawn, total: w.total, x: +w.x.toFixed(1), z: +w.z.toFixed(1), mode: w.mode ?? null, sw: typeof navigator.serviceWorker !== 'undefined' }
  })
  const shot = await page.screenshot()
  writeFileSync(out, shot)
  const br = await brightness(page, shot)
  console.log(`[${tag}] stats: ${JSON.stringify(stats)}`)
  console.log(`[${tag}] SKY   (top 30%):    mean ${br.top.mean}/255 · dark ${(br.top.dark * 100).toFixed(0)}% · sample rgb(${br.top.sky.join(',')})`)
  console.log(`[${tag}] MID   (0.3–0.5h):   sample rgb(${br.top.mid.join(',')})`)
  console.log(`[${tag}] GROUND(bottom 50%): mean ${br.bottom.mean}/255 · dark ${(br.bottom.dark * 100).toFixed(0)}% · sample rgb(${br.top.ground.join(',')})`)
  console.log(`[${tag}] errors: ${errors.length ? errors.join(' | ') : 'none'}`)
  console.log(`[${tag}] saved: ${out}`)
  await ctx.close()
  return { tag, stats, br, errors }
}

const wg = await leg('auto/WG', LIVE, '/home/z/my-project/download/walker-live-proof-wg.png')
const gl = await leg('webgl2', LIVE + '?mode=webgl2', '/home/z/my-project/download/walker-live-proof-gl.png')
await browser.close()

const verdict = (r) => (r.br.top.mean >= 40 && r.br.top.dark < 0.25 && r.br.bottom.mean >= 40 && r.br.bottom.dark < 0.5 ? 'BLUE SKY + VISIBLE TERRAIN' : 'STILL DARK — REAL BUG')
console.log(`\nVERDICT WG: ${verdict(wg)}\nVERDICT GL: ${verdict(gl)}`)
