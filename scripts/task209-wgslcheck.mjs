/**
 * scripts/task209-wgslcheck.mjs — extract COMPACT_WGSL (+HYST) from
 * device.ts, compile it on a REAL WebGPU device in the headless page, and
 * print getCompilationInfo verbatim: the exact line + message Tint rejects.
 */
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const src = await Bun.file(root + '/packages/gl/src/device.ts').text()
const grab = name => {
  const i = src.indexOf(`const ${name} = \``)
  const j = src.indexOf('`', i + src.slice(i).indexOf('`') + 1)
  return src.slice(i, j + 1).replace(`const ${name} = \``, '').replace(/`$/, '')
}
const compact = grab('COMPACT_WGSL')
const hyst = grab('HYST_WGSL')
console.log('COMPACT_WGSL bytes:', compact.length, '· HYST bytes:', hyst.length)

const port = 8158
const server = Bun.serve({
  port,
  fetch: async req => new Response(JSON.stringify({ compact, hyst }), { headers: { 'content-type': 'application/json' } }),
})

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 800)))
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' })
const report = await page.evaluate(async () => {
  const { compact, hyst } = await (await fetch('/')).json()
  const out = {}
  if (!navigator.gpu) return { error: 'no navigator.gpu' }
  const adapter = await navigator.gpu.requestAdapter()
  const device = await adapter.requestDevice()
  for (const [name, code] of [['compact-module', compact], ['hyst-module', hyst]]) {
    const module = device.createShaderModule({ code })
    const info = await module.getCompilationInfo()
    out[name] = info.messages.map(m => `${m.type} line ${m.lineNum}:${m.linePos} — ${m.message}`)
    // also try the real pipelines (both entries)
    for (const entry of ['compact', 'order']) {
      try {
        const p = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
        await p.computePipeline
      } catch (e) { out[`${name}/${entry}`] = String(e).slice(0, 500) }
    }
  }
  device.destroy()
  return out
})
console.log(JSON.stringify(report, null, 1))
await browser.close(); server.stop(true)
