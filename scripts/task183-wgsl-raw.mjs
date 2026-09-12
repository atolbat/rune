// task183-wgsl-raw — the RAW WebGPU pixel gate for the PACKED record's
// BILLBOARD material (Task 183): a plain device (NO canvas — the
// SwiftShader canvas readback is broken locally, pre-existing: white via
// the compositor, black via drawImage), an offscreen render target, ONE
// hand-crafted 9-word record (the dist's own f32ToF16Bits/packHalfPair
// do the quantizing — the built bundle is part of the test), the
// INDEXED [0,1,2,0,2,3] draw over the 4-entry corner table, the pixels
// read back through a staging buffer (mapAsync — the proven
// blend-probe-raw path). This verifies the whole WGSL half of the
// packed instance path: compilation, the unpack preamble
// (bitcast + unpack2x16float + the derived par/uv), the pipeline layout
// (3 instance-step word-slots, 36-byte stride), and the CAMERA mode's
// corner math against hand-computed expectations.
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const PORT = 8904

// THE SERVER — in-process (the smoke's own pattern: the static files + the
// built dist; the browser and the server live and die with THIS script).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
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
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

const result = await page.evaluate(async (port) => {
  const errors = []
  const out = { errors }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) { errors.push('no adapter'); return out }
    const device = await adapter.requestDevice()
    device.addEventListener?.('uncapturederror', e => errors.push('device error: ' + String(e.error?.message ?? e).slice(0, 200)))

    // the assembled BILLBOARD material + the packed-record codec (the
    // EXACT modules the demos run — the built dist)
    const [matMod, parMod] = await Promise.all([
      import(`http://localhost:${port}/dist/rune-materials.esm.js?v=183`),
      import(`http://localhost:${port}/dist/rune-particles.esm.js?v=183`),
    ])
    const mat = matMod.materialOf({ features: matMod.TEXTURE | matMod.VERTEX_COLOR | matMod.BILLBOARD })
    out.attrs = mat.attributes.map(a => a.name)
    if (out.attrs.join(',') !== 'i_rec0,i_rec1,i_rec2') {
      errors.push('attr set mismatch: ' + out.attrs.join(','))
    }
    const { f32ToF16Bits, INSTANCE_STRIDE } = parMod
    if (INSTANCE_STRIDE !== 9) errors.push('INSTANCE_STRIDE !== 9: ' + INSTANCE_STRIDE)

    const SIZE = 64 // 256 bytes/row — the copy rule (bytesPerRow must be a 256 multiple)
    const format = 'rgba8unorm'
    const target = device.createTexture({
      size: [SIZE, SIZE], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })

    // THE PIPELINE — exactly as the executor builds it: 3 instance-step
    // WORD slots, the 36-byte record stride, the word offsets.
    const module = device.createShaderModule({ code: mat.wgsl })
    const compilation = await module.getCompilationInfo().catch(() => null)
    if (compilation !== null) {
      for (const msg of compilation.messages) {
        if (msg.type === 'error') errors.push(`WGSL compile (line ${msg.lineNum}): ${msg.message.slice(0, 200)}`)
      }
    }
    const fmt = (size) => (size >= 4 ? 'float32x4' : 'float32')
    const buffers = [
      { offset: 0, size: 4 }, { offset: 16, size: 4 }, { offset: 32, size: 1 },
    ].map((s, i) => ({
      arrayStride: 36, stepMode: 'instance',
      attributes: [{ shaderLocation: i, offset: s.offset, format: fmt(s.size) }],
    }))

    // the uniform buffer: the Params struct the WGSL declares (mat4 + mat4
    // + six vec4 = 224 bytes, padded to the 256-byte slice granularity).
    const uniforms = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

    // THE RENDER PIPELINE with the texture group (binding 1: sampler + tex)
    const tex = device.createTexture({ size: [8, 8], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    const texBytes = new Uint8Array(8 * 8 * 4).fill(255)
    device.queue.writeTexture({ texture: tex }, texBytes, { bytesPerRow: 32 }, [8, 8])
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain', buffers },
      fragment: {
        module, entryPoint: 'fsMain',
        targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' } } }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // THE PACKED RECORD (Task 183 — 9 words / 36 bytes): a camera-mode quad
    // at the origin, half = 0.25 (f16-quantized), the identity basis, the
    // full-sprite uv (frame 0), a RED tint, age 0, seed 0 → the corners
    // land at (±0.25, ±0.25, 0) in clip space (the identity mvp). The dist's
    // own quantizer packs the pairs — the record bytes are the ones the
    // CPU packer would emit.
    const word = (bits) => new Float32Array(new Uint32Array([bits >>> 0]).buffer)[0]
    const pair = (lo, hi) => (f32ToF16Bits(lo) | (f32ToF16Bits(hi) << 16)) >>> 0
    const rec = new Float32Array(9)
    rec.set([0, 0, 0, 0], 0)      // pos.xyz + age — NATIVE
    rec[4] = word(pair(0, 0))     // vel.xy
    rec[5] = word(pair(0, 0.25))  // vel.z (lo) | halfExtent (hi)
    rec[6] = word(pair(1, 0))     // color.rg — RED
    rec[7] = word(pair(0, 1))     // color.ba
    rec[8] = word(pair(0, 0))     // seed (lo) | frame (hi, u16)
    out.halfF16 = f32ToF16Bits(0.25)
    if (out.halfF16 !== 0x3400) errors.push('f16(0.25) bits: ' + out.halfF16.toString(16))
    const inst = device.createBuffer({ size: 36, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(inst, 0, rec)

    // THE INDEX BUFFER — the BILLBOARD draw contract (Task 181): the shared
    // [0,1,2,0,2,3] pattern over the 4-entry corner table.
    const indices = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0, 2, 3]))

    // THE UNIFORM DATA: u_mvp = identity, u_model = identity, u_bbA = (mode
    // 0 camera, spin 0, sf 0, lf 1), u_bbB = (0, 0, 1, 1) (no tiles), the
    // basis right/up/forward.
    const uni = new Float32Array(56)
    const mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    uni.set(mvp, 0)                 // u_mvp
    uni.set(mvp, 16)                // u_model
    uni.set([0, 0, 0, 1], 32)       // u_bbA: mode 0 (camera), spin 0, sf 0, lf 1
    uni.set([0, 0, 1, 1], 36)       // u_bbB: spin3d 0, axisRandom 0, uS 1, vS 1
    uni.set([1, 0, 0], 40)          // u_bbRight (float 40..42, 43 = the vec4 pad)
    uni.set([0, 1, 0], 44)          // u_bbUp
    uni.set([0, 0, -1], 48)         // u_bbForward
    uni.set([0, 0, 1], 52)          // u_bbAxis
    device.queue.writeBuffer(uniforms, 0, uni)

    // the bind groups from the auto layout
    const g0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    })
    const g1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: tex.createView() },
      ],
    })

    // THE PASS: clear to (0, 0, 1, 1) — BLUE — then the indexed draw
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 1, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, g0)
    pass.setBindGroup(1, g1)
    for (let s = 0; s < 3; s++) pass.setVertexBuffer(s, inst)
    pass.setIndexBuffer(indices, 'uint16')
    pass.drawIndexed(6, 1)
    pass.end()

    // THE READBACK (the proven raw path): copy to a staging buffer, mapAsync
    const staging = device.createBuffer({ size: SIZE * SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: SIZE * 4 }, [SIZE, SIZE])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const px = new Uint8Array(staging.getMappedRange().slice(0))
    staging.unmap()

    // THE EXPECTATIONS: the quad's half extent 0.25 → NDC ±0.25 → texels
    // [24..40) of 64 — RED (255, 0, 0, 255); everything else is the BLUE
    // clear. Sample the center, a mid-quad point, a far corner, and an
    // outside point.
    const at = (x, y) => { const p = (y * SIZE + x) * 4; return [px[p], px[p + 1], px[p + 2], px[p + 3]] }
    const center = at(32, 32)
    const inner = at(28, 28)
    const corner = at(2, 2)
    out.center = center
    out.inner = inner
    out.corner = corner
    out.centerRed = center[0] > 200 && center[1] < 60 && center[2] < 60
    out.innerRed = inner[0] > 200 && inner[1] < 60
    out.cornerBlue = corner[2] > 200 && corner[0] < 60
    // outside the quad (x=12 → NDC −0.625)
    const outside = at(12, 32)
    out.outsideBlue = outside[2] > 200 && outside[0] < 60
  } catch (e) {
    errors.push('exception: ' + String(e?.message ?? e).slice(0, 300))
  }
  return out
}, PORT).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))
const ok = result.errors.length === 0 && result.centerRed && result.innerRed && result.cornerBlue && result.outsideBlue
console.log(ok ? 'WGSL RAW PACKED-RECORD PIXEL GATE: PASS' : 'WGSL RAW PACKED-RECORD PIXEL GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
