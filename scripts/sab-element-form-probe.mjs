// element-form diagnostic: does the 5-arg element form (data, dataOffset,
// size in ELEMENTS) with a SAB-backed view actually land bytes on this
// Chrome/Dawn? The 3-arg form was proven by sab-write-probe; the live gate
// saw zeros through the 5-arg form. Also isolates SAB-vs-form: a plain
// ArrayBuffer view rides the same 5-arg shape.
import { chromium } from 'playwright'

const PORT = 8908
Bun.serve({
  port: PORT,
  fetch: () => new Response('<html></html>', { headers: {
    'content-type': 'text/html',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  } }),
})

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })

const result = await page.evaluate(async () => {
  const out = { cases: [] }
  const adapter = await navigator.gpu.requestAdapter()
  const device = await adapter.requestDevice()

  async function roundtrip(label, makeView, dataOffset, size) {
    const view = makeView()
    const target = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
    device.pushErrorScope('validation')
    let threw = null
    try {
      if (dataOffset === undefined) device.queue.writeBuffer(target, 0, view)
      else device.queue.writeBuffer(target, 0, view, dataOffset, size)
    } catch (error) { threw = String(error) }
    const scope = await device.popErrorScope()
    const staging = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyBufferToBuffer(target, 0, staging, 0, 64)
    device.queue.submit([enc.finish()])
    const bytes = await staging.mapAsync(GPUMapMode.READ).then(() => {
      const arr = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      return Array.from(arr)
    })
    staging.destroy()
    target.destroy()
    out.cases.push({ label, threw, validation: scope ? scope.message : null, bytes: bytes.join(',') })
  }

  await roundtrip('SAB 3-arg (whole view)', () => {
    const v = new Float32Array(new SharedArrayBuffer(16 * 4))
    for (let i = 0; i < 16; i++) v[i] = i + 1
    return v
  })
  await roundtrip('SAB 5-arg (dataOffset=0, size=16 elements)', () => {
    const v = new Float32Array(new SharedArrayBuffer(16 * 4))
    for (let i = 0; i < 16; i++) v[i] = i + 1
    return v
  }, 0, 16)
  await roundtrip('SAB 5-arg (dataOffset=4, size=12)', () => {
    const v = new Float32Array(new SharedArrayBuffer(16 * 4))
    for (let i = 0; i < 16; i++) v[i] = i + 1
    return v
  }, 4, 12)
  await roundtrip('plain AB 5-arg (dataOffset=0, size=16)', () => {
    const v = new Float32Array(16)
    for (let i = 0; i < 16; i++) v[i] = (i + 1) * 10
    return v
  }, 0, 16)
  await roundtrip('SAB Uint8 5-arg elements (bytes as elements)', () => {
    const v = new Uint8Array(new SharedArrayBuffer(64))
    for (let i = 0; i < 64; i++) v[i] = i
    return v
  }, 0, 64)
  device.destroy()
  return out
})

console.log(JSON.stringify(result, null, 2))
await browser.close()
process.exit(0)
