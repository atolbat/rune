// sab-write-probe — answers the Task-185 question empirically: does the
// container's Chrome/Dawn accept SharedArrayBuffer-backed views in
// queue.writeBuffer (WG) and gl.bufferSubData (GL)? The library comments
// claim "WebGPU forbids shared memory in writeBuffer" (the staging-copy
// rationale, Task 164). If direct SAB writes WORK, the zero-copy SAB
// upload front is real: the guard can probe once and skip the staging copy.
// Error-scope wrapped: a silent validation error (no throw) must ALSO
// count as "unsupported" — otherwise the write would be a silent no-op.
import { chromium } from 'playwright'

const PORT = 8907

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
  const out = { webgpu: null, webgl2: null }
  // ── WebGPU: writeBuffer with a SAB-backed Float32Array view ──
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) { out.webgpu = { error: 'no adapter' } } else {
      const device = await adapter.requestDevice()
      const sab = new SharedArrayBuffer(16)
      const view = new Float32Array(sab)
      view.set([1, 2, 3, 4])
      const gpuBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
      device.pushErrorScope('validation')
      let threw = null
      try {
        device.queue.writeBuffer(gpuBuffer, 0, view)
      } catch (error) {
        threw = String(error)
      }
      const scope = await device.popErrorScope()
      // readback to be REALLY sure the bytes landed
      const staging = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(gpuBuffer, 0, staging, 0, 16)
      device.queue.submit([enc.finish()])
      const bytes = await staging.mapAsync(GPUMapMode.READ).then(() => {
        const arr = new Float32Array(staging.getMappedRange().slice(0))
        staging.unmap()
        return Array.from(arr)
      })
      staging.destroy()
      gpuBuffer.destroy()
      out.webgpu = { threw, validationError: scope?.message ?? null, landed: JSON.stringify(bytes) }
      device.destroy()
    }
  } catch (error) { out.webgpu = { error: String(error) } }

  // ── WebGL2: bufferSubData with a SAB-backed Float32Array view ──
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (gl === null) { out.webgl2 = { error: 'no webgl2' } } else {
      const sab = new SharedArrayBuffer(16)
      const view = new Float32Array(sab)
      view.set([9, 8, 7, 6])
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW)
      let threw = null
      let glErrorBefore = gl.getError()
      try { gl.bufferSubData(gl.ARRAY_BUFFER, 0, view) } catch (error) { threw = String(error) }
      const glErrorAfter = gl.getError()
      const readBack = new Float32Array(4)
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, readBack)
      out.webgl2 = {
        threw,
        glErrorBefore,
        glErrorAfter,
        landed: JSON.stringify(Array.from(readBack)),
      }
    }
  } catch (error) { out.webgl2 = { error: String(error) } }
  return out
})

console.log(JSON.stringify(result, null, 2))
await browser.close()
process.exit(0)
