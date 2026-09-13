/** dump2 — probe adapter.info availability + the software gate's inputs. */
import { chromium } from 'playwright'
const port = 8195
const server = Bun.serve({ port, async fetch() { return new Response(GATE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } })
const GATE = `<!doctype html><body><script type="module">
window.__probe = {}
try {
const adapter = await navigator.gpu.requestAdapter()
const info = (adapter && adapter.info) ?? null
window.__probe = {
  adapterNull: adapter === null,
  infoType: typeof adapter.info,
  info: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
  hasRequestAdapterInfo: adapter !== null && typeof adapter.requestAdapterInfo === 'function',
  preferred: navigator.gpu.getPreferredCanvasFormat(),
}
// the WebGL unmasked renderer (the fallback detector's input)
try {
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2')
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    window.__probe.glRenderer = ext !== null ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  }
} catch (e) { window.__probe.glRenderer = 'ERR ' + String(e).slice(0, 60) }
} catch (e) { window.__probe.bootError = String(e).slice(0, 200) }
</script></body></html>`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', m => console.log('[page]', m.text().slice(0, 200)))
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__probe !== undefined, null, { timeout: 30_000 })
console.log(JSON.stringify(await page.evaluate(() => window.__probe), null, 1))
await browser.close()
server.stop()
