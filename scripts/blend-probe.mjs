/**
 * scripts/blend-probe.mjs — drives demo/particles/blend-probe.html through
 * Playwright on BOTH backends and each equation, printing the verdict.
 * (Task 127 — the custom-blending direction ground truth.)
 *
 * WebGPU needs the FULL chrome binary (not the headless shell — no WebGPU)
 * + the SwiftShader Vulkan flags. The page must be a real http origin
 * (about:blank is not a secure context — navigator.gpu is undefined there).
 */
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8129
const FULL_CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, {
      headers: { 'content-type': ext === '.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' },
    })
  },
})

const browser = await chromium.launch({
  executablePath: FULL_CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})

for (const backend of ['webgl2', 'webgpu']) {
  for (const equation of ['subtract', 'reverse-subtract', 'min', 'max']) {
    const page = await browser.newPage({ viewport: { width: 240, height: 200 } })
    page.on('console', (m) => m.type() === 'error' && console.log(`  [console:${backend}/${equation}]`, m.text().slice(0, 160)))
    try {
      await page.goto(`http://localhost:${port}/demo/particles/blend-probe.html?backend=${backend}&equation=${equation}`)
      await page.waitForFunction(() => window.__probe !== undefined, null, { timeout: 20000 })
      const { line } = await page.evaluate(() => window.__probe)
      console.log(line)
    } catch (error) {
      console.log(`${backend} equation=${equation} → PROBE ERROR: ${error instanceof Error ? error.message : String(error)}`)
    }
    await page.close()
  }
}
await browser.close()
server.stop()
