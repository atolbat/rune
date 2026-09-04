/**
 * scripts/explosion-shots.mjs — the explosion demo's phase shots (dev tool):
 * catches a FRESH instance (its log line) and shoots three phases — the
 * flash cards (t≈0.1), the sparks + fireball (t≈0.4), the grey smoke
 * (t≈1.2) — on both backends. Prints the pixel stats + the live pill.
 */
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, '.shots')
mkdirSync(out, { recursive: true })
const port = 8126

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})

async function shoot(backend) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${backend} console.${m.type()}]`, m.text().slice(0, 200)) })
  await page.goto(`http://localhost:${port}/demo/vfx/`, { waitUntil: 'networkidle' })
  if (backend !== 'auto') {
    await page.click('#rd-fab')
    await page.click(`label[for="mode-${backend}"]`)
    await page.mouse.click(640, 60)
    await page.evaluate(() => document.querySelector('.pt-sheet [aria-label=Close]')?.click())
  }
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500)
    const badge = await page.textContent('#backend').catch(() => '…')
    const pill = await page.textContent('.pt-pill').catch(() => '')
    if (badge !== '…' && /[1-9][\d,]* particles/.test(pill)) break
  }
  await page.waitForFunction(() => /Muzzle Flash ×100 · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 20000 })
  const badge = await page.textContent('#backend')
  console.log(`\n[${backend}] backend badge: ${badge}`)

  // switch to the explosion demo (index 1)
  await page.click('.pt-arrow:last-child')
  await page.waitForFunction(() => /Explosion \(composed\) · [1-9][\d,]* particles/.test(document.querySelector('.pt-pill')?.textContent ?? ''), null, { timeout: 20000 })

  // catch a FRESH instance start via a MutationObserver on the log (zero
  // polling latency — the frame the line lands), then shoot the phase
  const waitFresh = () => page.evaluate(() => new Promise(resolve => {
    const list = document.querySelector('#log-list')
    const obs = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue
        const msg = n.querySelector?.('.rd-msg')?.textContent ?? ''
        if (/^explosion #/.test(msg)) { obs.disconnect(); resolve(true); return }
      }
    })
    obs.observe(list, { childList: true })
  }))
  const phase = async (ms, name) => {
    await Promise.race([waitFresh(), page.waitForTimeout(30000)])
    await page.waitForTimeout(ms)
    const path = join(out, `exp-${backend}-${name}.png`)
    await page.screenshot({ path })
    // pixel stats: bright fraction + the dominant hue of the bright pixels
    const { PNG } = await import('pngjs')
    const png = PNG.sync.read(readFileSync(path))
    let bright = 0, warm = 0, grey = 0, white = 0
    const n = png.width * png.height
    for (let p = 0; p < n; p++) {
      const r = png.data[p * 4], g = png.data[p * 4 + 1], b = png.data[p * 4 + 2]
      const avg = (r + g + b) / 3
      if (avg > 40) {
        bright++
        if (r > b + 30 && g > b) warm++
        else if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 90) grey++
        if (r > 235 && g > 235 && b > 225) white++
      }
    }
    const pill = await page.textContent('.pt-pill')
    console.log(`[${backend}] ${name} (t≈${(0.05 + ms / 1000).toFixed(2)}s): bright ${((bright / n) * 100).toFixed(2)}% (warm ${warm}, greyish ${grey}, white ${white}) — ${pill}`)
  }

  await phase(70, 'a-flash') // t≈0.07: the cards + lines
  await phase(200, 'b-early') // t≈0.2: cards fading, sparks out
  await phase(500, 'c-sparks') // t≈0.5: sparks out, smoke born fire-colored
  await phase(1200, 'd-smoke') // t≈1.25: the grey smoke
  if (errors.length > 0) console.log(`[${backend}] PAGE ERRORS:`, errors.slice(0, 3))
  else console.log(`[${backend}] page errors: none`)
  await page.close()
  return errors.length
}

let bad = 0
bad += await shoot('webgl2')
// WebGPU: the container's SwiftShader device may die — a boot failure is
// reported, not fatal for this tool (the live site is the real oracle)
try {
  bad += await shoot('webgpu')
} catch (e) {
  console.log('[webgpu] shot session failed:', String(e).slice(0, 300))
}

server.stop()
await browser.close()
process.exit(bad > 0 ? 1 : 0)
