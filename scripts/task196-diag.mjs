// task196-diag — quick probe of the occlusion page state (why no __hizGate?)
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = 8188
const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.endsWith('/')) pathname += 'index.html' // the demo folder URLs
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(await file.arrayBuffer(), {
      headers: { 'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' },
    })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 500, height: 420 } })
page.setDefaultTimeout(180_000)
page.on('console', m => console.log(`[console:${m.type()}] ${m.text().slice(0, 220)}`))
page.on('pageerror', e => console.log(`[pageerror] ${String(e).slice(0, 400)}`))
await page.goto(`http://localhost:${port}/demo/occlusion/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await new Promise(r => setTimeout(r, 9000))
console.log('page errors:', JSON.stringify(await page.evaluate(() => window.__hizStats.errors)))
await page.screenshot({ path: '/home/z/my-project/tool-results/hiz-live.png' })
for (let i = 0; i < 0; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const state = await page.evaluate(() => ({
    gate: window.__hizGate !== undefined ? Object.keys(window.__hizGate) : null,
    stats: window.__hizStats ? { mode: window.__hizStats.mode, errors: window.__hizStats.errors?.length, validation: !!window.__hizStats.validation } : null,
    logTail: (document.querySelector('#log-list')?.textContent ?? '').slice(-500),
  }))
  console.log(`[${(i + 1) * 5}s] gate=${state.gate ? 'SET' : 'unset'} stats=${JSON.stringify(state.stats)}`)
  if (state.gate) break
}
const logTail = await page.evaluate(() => (document.querySelector('#log-list')?.textContent ?? ''))
console.log('--- LOG ---')
console.log(logTail.slice(-1500))
await browser.close()
server.stop()
