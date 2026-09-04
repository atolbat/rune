// task131-wgsl-raw — the RAW WebGPU pixel gate for the BILLBOARD material:
// a plain device (NO canvas — the SwiftShader canvas readback is broken
// locally, pre-existing: white via the compositor, black via drawImage), an
// offscreen render target, ONE hand-crafted instance record through the
// assembled BB_SPRITE WGSL, the pixels read back through a staging buffer
// (mapAsync — the proven blend-probe-raw path). This verifies the whole
// WGSL half of the instance path: compilation, the pipeline layout (5
// instance-step slots, 64-byte stride), the uniform block, and the CAMERA
// mode's corner math against hand-computed expectations.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8904
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

    // the assembled BILLBOARD material (the exact WGSL the demos run)
    const mat = await import(`http://localhost:${port}/dist/rune-materials.esm.js?v=130`)
      .then(m => m.materialOf({ features: m.TEXTURE | m.VERTEX_COLOR | m.BILLBOARD }))
    out.attrs = mat.attributes.map(a => a.name)

    const SIZE = 64 // 256 bytes/row — the copy rule (bytesPerRow must be a 256 multiple)
    const format = 'rgba8unorm'
    const target = device.createTexture({
      size: [SIZE, SIZE], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })

    // THE PIPELINE — exactly as the executor builds it: 5 instance-step
    // slots, the 64-byte record stride, the field offsets.
    const module = device.createShaderModule({ code: mat.wgsl })
    const compilation = await module.getCompilationInfo().catch(() => null)
    if (compilation !== null) {
      for (const msg of compilation.messages) {
        if (msg.type === 'error') errors.push(`WGSL compile (line ${msg.lineNum}): ${msg.message.slice(0, 200)}`)
      }
    }
    const L = { pos: 0, vel: 3, color: 6, par: 10, uv0: 14 }
    const slot = (offset, size) => ({
      arrayStride: 64, stepMode: 'instance',
      attributes: [{ shaderLocation: 0, offset: offset * 4, format: size === 3 ? 'float32x3' : size === 4 ? 'float32x4' : 'float32x2' }],
    })
    // shaderLocation per NAME (the reflection order the executor uses)
    const locs = { i_pos: 0, i_vel: 1, i_color: 2, i_par: 3, i_uv0: 4 }
    const buffers = [
      slot(L.pos, 3), slot(L.vel, 3), slot(L.color, 4), slot(L.par, 4), slot(L.uv0, 2),
    ].map((b, i) => { b.attributes[0].shaderLocation = i; return b })

    // the uniform buffer: the Params struct the WGSL declares (mat4 + mat4
    // + six vec4 = 224 bytes, padded to the 256-byte slice granularity).
    const UNI_BYTES = 64 + 64 + 16 * 6
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

    // THE INSTANCE RECORD: a camera-mode quad at the origin, half = 0.25,
    // the identity basis (right=+X, up=+Y, forward=−Z), full-sprite uv, a
    // RED tint, spin 0, age 0 → the corners land at (±0.25, ±0.25, 0) in
    // clip space (the identity mvp).
    const rec = new Float32Array(16)
    rec.set([0, 0, 0], 0)          // i_pos
    rec.set([0, 0, 0], 3)          // i_vel
    rec.set([1, 0, 0, 1], 6)       // i_color — RED
    rec.set([0.25, 0, 0, 0.5], 10) // i_par: half, angle0(seed·τ=0), age, seed
    rec.set([0, 0], 14)            // i_uv0
    const inst = device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(inst, 0, rec)

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

    // THE PASS: clear to (0, 0, 1, 1) — BLUE — then draw 6 verts × 1 instance
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
    for (let s = 0; s < 5; s++) pass.setVertexBuffer(s, inst)
    pass.draw(6, 1)
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
console.log(ok ? 'WGSL RAW PIXEL GATE: PASS' : 'WGSL RAW PIXEL GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
