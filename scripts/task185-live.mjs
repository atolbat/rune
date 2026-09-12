// task185-live — the RAW WebGPU live gate for the ZERO-COPY SAB upload
// (Task 185): a cross-origin-isolated page (COOP/COEP — SharedArrayBuffer
// exists), the BUILT dist's own facade (createWebGpuRenderer → renderer.gpu,
// imported over HTTP like every raw gate), a recording wrapper around
// device.queue.writeBuffer (installed by wrapping requestAdapter BEFORE
// the facade is built — the facade then drives OUR queue), and the ladder:
//   frame 1: the SAB feed upload STAGES (the async probe is pending —
//            Task-164's cached copy, an ArrayBuffer-backed Uint8Array);
//   after the probe resolves: the append window writes DIRECT — the
//            recorded call carries the SAB-backed Float32Array ITSELF
//            (the element form, zero copies on the JS side);
//   writeExternalBuffer: a SAB view rides the SAME verdict — and the bytes
//            are proven end-to-end through readExternalBuffer (mapAsync
//            readback: SAB → GPU → main, exact floats both directions);
//   the probe's own 16-byte write is the first recorded call (a SAB view —
//   the live verdict that THIS Chrome/Dawn accepts shared memory).
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const PORT = 8906

// THE SERVER — in-process, CROSS-ORIGIN ISOLATED (the SAB gate's own need:
// without COOP/COEP the page has no SharedArrayBuffer at all).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}
Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    } })
  },
})

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
await page.goto(`http://localhost:${PORT}/demo/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const result = await page.evaluate(async (port) => {
  const out = { errors: [], notes: [] }
  try {
    // 0. the isolation gate — no SAB, no test.
    if (typeof SharedArrayBuffer === 'undefined') {
      out.errors.push('SharedArrayBuffer undefined — the page is not cross-origin isolated')
      return out
    }
    out.notes.push(`crossOriginIsolated=${String(self.crossOriginIsolated)}`)

    // 1. the dist's own facade (the BUILT bundle is part of the test).
    const mod = await import(`http://localhost:${port}/dist/rune.esm.js?v=185`)
    if (typeof mod.createWebGpuRenderer !== 'function') {
      out.errors.push('createWebGpuRenderer not exported from the dist')
      return out
    }

    // 2. the recording queue — wrap requestAdapter BEFORE the facade.
    const records = []
    let testDevice = null
    const sabBacked = (d) =>
      d instanceof SharedArrayBuffer
      || (typeof d === 'object' && d !== null && 'buffer' in d
        && d.buffer instanceof SharedArrayBuffer)
    const rawRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async (options) => {
      const adapter = await rawRequestAdapter(options)
      if (adapter === null) return adapter
      const rawRequestDevice = adapter.requestDevice.bind(adapter)
      adapter.requestDevice = async (req) => {
        const device = await rawRequestDevice(req)
        testDevice = device
        const rawWrite = device.queue.writeBuffer.bind(device.queue)
        device.queue.writeBuffer = (target, offset, data, dataOffset, size) => {
          records.push({
            data,
            offset,
            dataOffset,
            size,
            sab: sabBacked(data),
            el: (data && data.length) ? data.length : -1,
          })
          return rawWrite(target, offset, data, dataOffset, size)
        }
        return device
      }
      return adapter
    }

    // 3. the facade through the renderer (a real OffscreenCanvas context).
    const canvas = new OffscreenCanvas(8, 8)
    const renderer = await mod.createWebGpuRenderer({ canvas })
    const gpu = renderer.gpu
    if (typeof gpu.syncVertexBuffer !== 'function' || typeof gpu.writeExternalBuffer !== 'function') {
      out.errors.push('the facade surface is wrong (syncVertexBuffer/writeExternalBuffer)')
      return out
    }

    // 4. THE LADDER — frame 1 stages, the append writes DIRECT.
    const sab = new SharedArrayBuffer(128 * 4)
    const view = new Float32Array(sab)
    for (let i = 0; i < 128; i++) view[i] = i + 0.5
    gpu.syncVertexBuffer(view, 256, 0) // [0, 256) — probe pending
    // the recorded calls so far: the probe (a 4-element SAB Float32Array)
    // and the STAGED upload (an ArrayBuffer-backed Uint8Array).
    const probeCall = records.find(r => r.el === 4 && r.sab)
    if (probeCall === undefined) out.errors.push('the probe write was not recorded (SAB Float32Array, 4 elements)')
    const stagedCall = records.find(r => r.data instanceof Uint8Array && !r.sab)
    if (stagedCall === undefined) out.errors.push('frame 1 did not STAGE (probe pending)')
    // the probe's write is the LIVE verdict: it went through the real queue
    // without a throw — this Chrome/Dawn accepts SAB-backed views.
    out.notes.push('probe write accepted (SAB view through the real queue)')

    // let the popErrorScope verdict settle (microtasks + a frame)
    await new Promise((r) => setTimeout(r, 50))

    // frame 2: the append window [256, 512) — DIRECT, zero-copy.
    gpu.syncVertexBuffer(view, 256, 256)
    const directCall = records.find(r => r.sab && r.data === view && r.dataOffset === 64 && r.size === 64 && r.offset === 256)
    if (directCall === undefined) {
      out.errors.push(`the append window did not write DIRECT (last records: ${JSON.stringify(records.map(r => ({ sab: r.sab, el: r.el, offset: r.offset, dataOffset: r.dataOffset, size: r.size })))}`)
    } else {
      out.notes.push('DIRECT SAB write: data === the SAB Float32Array itself (element form, zero copies)')
    }

    // 5. THE END-TO-END BYTES — writeExternalBuffer + readExternalBuffer.
    const EXT = 64
    const extSab = new SharedArrayBuffer(EXT * 4)
    const extView = new Float32Array(extSab)
    for (let i = 0; i < EXT; i++) extView[i] = i * 3
    const EXT_USAGE = GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
    const bufferId = gpu.createExternalBuffer(EXT * 4, EXT_USAGE)
    gpu.writeExternalBuffer(bufferId, extView)
    const extDirect = records.find(r => r.data === extView && r.sab && r.dataOffset === 0 && r.size === EXT)
    if (extDirect === undefined) out.errors.push('writeExternalBuffer did not go DIRECT with the SAB view')
    const readBack = await gpu.readExternalBuffer(bufferId, EXT * 4)
    let bytesOk = readBack.length === EXT
    for (let i = 0; i < EXT && bytesOk; i++) if (readBack[i] !== i * 3) bytesOk = false
    if (!bytesOk) out.errors.push(`readExternalBuffer bytes wrong (${readBack.length} floats, first=${readBack[0]}, last=${readBack[EXT - 1]})`)
    else out.notes.push(`writeExternalBuffer → readExternalBuffer roundtrip: ${EXT} floats EXACT (SAB → GPU → main)`)

    // 6. the staging fallback stays live (the reject path): simulate a
    // rejecting browser by throwing on SAB data in OUR wrapper — the facade
    // must fall back to staging and the bytes must still land. This pins
    // the "never a lost write" ladder on the REAL queue.
    if (testDevice !== null) {
      const rawWrite2 = testDevice.queue.writeBuffer
      testDevice.queue.writeBuffer = function (target, offset, data, dataOffset, size) {
        if (sabBacked(data)) throw new TypeError('simulated SAB rejection')
        return rawWrite2.call(this, target, offset, data, dataOffset, size)
      }
      const rejectSab = new SharedArrayBuffer(16 * 4)
      const rejectView = new Float32Array(rejectSab)
      for (let i = 0; i < 16; i++) rejectView[i] = 100 + i
      const rejectId = gpu.createExternalBuffer(16 * 4, EXT_USAGE)
      try {
        gpu.writeExternalBuffer(rejectId, rejectView)
        const rr = await gpu.readExternalBuffer(rejectId, 16 * 4)
        let ok = rr.length === 16
        for (let i = 0; i < 16 && ok; i++) if (rr[i] !== 100 + i) ok = false
        if (!ok) out.errors.push(`the rejecting-browser fallback lost bytes (staging did not land: ${rr.length} floats, [${rr[0]}, ${rr[15]}])`)
        else out.notes.push('simulated SAB rejection: staging fallback landed the bytes (never a lost write)')
      } catch (error) {
        out.errors.push(`the rejecting-browser fallback threw: ${String(error)}`)
      }
      // restore the honest writeBuffer
      testDevice.queue.writeBuffer = rawWrite2
    } else {
      out.notes.push('skip: simulated-rejection leg (device handle not captured) — covered by the mock-device unit gate')
    }

    // 7. the dist marker — the built bundle carries the Task-185 code.
    const distText = await (await fetch(`http://localhost:${port}/dist/rune.esm.js?v=185`)).text()
    if (!distText.includes('ensureSabDirectProbe')) out.errors.push('the dist lacks the ensureSabDirectProbe marker')
    else out.notes.push('dist marker: ensureSabDirectProbe present')
  } catch (error) {
    out.errors.push(String(error))
  }
  return out
}, PORT)

console.log(JSON.stringify(result, null, 2))
const ok = result.errors.length === 0
console.log(ok ? 'task185-live: PASS' : `task185-live: FAIL (${result.errors.length} errors)`)
await browser.close()
process.exit(ok ? 0 : 1)
