// task188-firstinstance.mjs — Task 188: the RAW WebGPU probe for PROPOSAL P3
// (firstInstance as the POOL-SLICE primitive for one-call multi-draw).
//
// The proposal: the instance-matrix pool is bound as ONE divisor-1 (instance
// step) attribute; every group draws as a member of ONE indirect multi-draw
// with firstInstance = the group's pool offset. THREE hard dependencies must
// be PROBED, not believed (the repo's rule — empiricism first):
//   (a) VALIDATION: the device accepts firstInstance > 0 in a DIRECT draw,
//       a drawIndirect record (4 words) and a drawIndexedIndirect record
//       (5 words) — early WebGPU drafts restricted firstInstance to 0;
//   (b) instance_index INCLUDES firstInstance (an old Chrome bug drew
//       instance_index from 0 — the pool slice would be silent garbage);
//   (c) the PER-INSTANCE ATTRIBUTE FETCH starts at firstInstance (the GL
//       baseInstance gotcha: gl_InstanceID is offset, but fixed-function
//       attribute fetching is NOT — WebGPU must not inherit that trap).
//
// Method: an instance buffer of 2048 records (value = index), a 4-vertex
// triangle-strip quad whose strip position encodes (instance_index - BASE),
// and a color whose R encodes (instance_index - BASE) and G encodes
// (attribute - BASE). BASE = 1000, instanceCount = 3. Readback 64×1 pixels:
//   strip k drawn at texels [16k, 16k+16)  ⇔ instance_index included the base;
//   G == R at the strip centers            ⇔ the attribute fetch followed it.
// A control draw with firstInstance = 0 validates the shader math itself.
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const PORT = 8912

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
    const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage()
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)

const result = await page.evaluate(async () => {
  const errors = []
  const out = { errors, ua: navigator.userAgent }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) { errors.push('no adapter'); return out }
    const device = await adapter.requestDevice()
    device.addEventListener?.('uncapturederror', e => errors.push('device error: ' + String(e.error?.message ?? e).slice(0, 200)))

    const SIZE = 64 // 64×1, bytesPerRow 256 — the copy rule
    const format = 'rgba8unorm'
    const BASE = 1000

    // TWO modules: the base-0 CONTROL (k = ii — validates the shader math
    // at firstInstance=0) and the base-BASE form (k = ii − 1000 — the probe).
    const mkShader = (base) => device.createShaderModule({ code: `
      struct VOut {
        @builtin(position) pos: vec4f,
        @location(0) enc: vec2f,
      }
      @vertex
      fn vs(@builtin(instance_index) ii: u32, @builtin(vertex_index) vi: u32, @location(0) inst: f32) -> VOut {
        var u = 0.0;
        var v = 0.0;
        if (vi == 1u || vi == 3u) { u = 1.0; }
        if (vi == 2u || vi == 3u) { v = 1.0; }
        let k = f32(ii) - ${base}.0;
        let x = -1.0 + (k + u) * 0.5;   // strip k: NDC [−1+0.5k, −1+0.5(k+1))
        let y = v * 2.0 - 1.0;
        var o: VOut;
        o.pos = vec4f(x, y, 0.0, 1.0);
        o.enc = vec2f(f32(ii) - ${base}.0, inst - ${base}.0);
        return o;
      }
      @fragment
      fn fs(i: VOut) -> @location(0) vec4f {
        return vec4f(i.enc.x / 16.0, i.enc.y / 16.0, 0.0, 1.0);
      }
    ` })
    const shader = mkShader(BASE)
    const shader0 = mkShader(0)
    for (const m of [shader, shader0]) {
      const compilation = await m.getCompilationInfo().catch(() => null)
      if (compilation !== null) {
        for (const msg of compilation.messages) {
          if (msg.type === 'error') errors.push(`WGSL compile (line ${msg.lineNum}): ${msg.message.slice(0, 200)}`)
        }
      }
    }

    // stripIndexFormat: a triangle-strip pipeline used for INDEXED draws
    // requires it (the probe's first run caught exactly that validation).
    const mkPipeline = (module) => device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: 4, stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32' }],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint16' },
    })
    const pipeline = mkPipeline(shader)
    const pipeline0 = mkPipeline(shader0)

    // THE DISCRIMINANT shader: a full-screen quad (position from vi ONLY) whose
    // color enc = (ii/64, attr/64). With firstInstance=1000, instanceCount=1:
    //   honored  → R=G=255 (1000/64 clamps to 1.0)
    //   ignored  → R=G=0   (ii=0)
    //   dropped  → blue    (nothing painted)
    // One readback pixel classifies the failure mode EXACTLY.
    const shaderDisc = device.createShaderModule({ code: `
      struct VOut {
        @builtin(position) pos: vec4f,
        @location(0) enc: vec2f,
      }
      @vertex
      fn vs(@builtin(instance_index) ii: u32, @builtin(vertex_index) vi: u32, @location(0) inst: f32) -> VOut {
        var u = 0.0;
        var v = 0.0;
        if (vi == 1u || vi == 3u) { u = 1.0; }
        if (vi == 2u || vi == 3u) { v = 1.0; }
        var o: VOut;
        o.pos = vec4f(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
        o.enc = vec2f(f32(ii) / 64.0, inst / 64.0);
        return o;
      }
      @fragment
      fn fs(i: VOut) -> @location(0) vec4f {
        return vec4f(i.enc.x, i.enc.y, 0.0, 1.0);
      }
    ` })
    const pipelineDisc = mkPipeline(shaderDisc)

    // the instance data: 2048 records, value = index (float)
    const instData = new Float32Array(2048)
    for (let i = 0; i < 2048; i++) instData[i] = i
    const inst = device.createBuffer({ size: 2048 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(inst, 0, instData)

    const indices = device.createBuffer({ size: 8, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 3]))

    const indirectArrays = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectArrays, 0, new Uint32Array([4, 3, 0, BASE])) // vertexCount, instanceCount, firstVertex, firstInstance
    const indirectIndexed = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectIndexed, 0, new Uint32Array([4, 3, 0, 0, BASE])) // indexCount, instanceCount, firstIndex, baseVertex, firstInstance

    // one case = one encoder/pass/texture/staging; strips sampled at centers.
    // The error scope is popped AFTER submit — submit-time validation counts.
    async function runCase(name, pipe, drawFn) {
      const target = device.createTexture({ size: [SIZE, 1], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      const staging = device.createBuffer({ size: SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      device.pushErrorScope('validation')
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      })
      pass.setPipeline(pipe)
      pass.setVertexBuffer(0, inst)
      drawFn(pass)
      pass.end()
      encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: SIZE * 4 }, [SIZE, 1])
      device.queue.submit([encoder.finish()])
      const validation = await device.popErrorScope()
      await staging.mapAsync(GPUMapMode.READ)
      const px = new Uint8Array(staging.getMappedRange().slice(0))
      staging.unmap()
      const at = (x) => { const p = x * 4; return [px[p], px[p + 1], px[p + 2]] }
      const strips = [0, 1, 2, 3].map(k => ({ k, center: at(k * 16 + 8), inner: at(k * 16 + 3) }))
      const res = {
        name,
        validationError: validation === null ? null : String(validation.message).slice(0, 200),
        strips: strips.map(s => ({ k: s.k, r: s.center[0], g: s.center[1], b: s.center[2], rInner: s.inner[0] })),
      }
      // the semantics: strip k drawn ⇔ instance_index included BASE (k ∈ 0..2);
      // R ≈ G ≈ 16k at the strip centers ⇔ the attribute fetch followed BASE.
      res.iiIncludesBase = strips.slice(0, 3).every(s => Math.abs(s.center[0] - 16 * s.k) <= 3 && s.center[2] < 60)
      res.attrIncludesBase = strips.slice(0, 3).every(s => Math.abs(s.center[1] - s.center[0]) <= 3 && Math.abs(s.center[1] - 16 * s.k) <= 3)
      res.strip3Empty = strips[3].center[2] > 200 // instanceCount=3 → strip 3 must stay BLUE
      res.innerOk = strips.slice(0, 3).every(s => Math.abs(s.inner[0] - 16 * s.k) <= 3)
      res.center = at(32) // the row's center pixel (the discriminant reads it)
      return res
    }

    const indirectArrays1 = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectArrays1, 0, new Uint32Array([4, 1, 0, BASE]))
    const indirectIndexed1 = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectIndexed1, 0, new Uint32Array([4, 1, 0, 0, BASE]))
    // base-0 records: the indirect plumbing sanity
    const indirectArrays0 = device.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectArrays0, 0, new Uint32Array([4, 3, 0, 0]))
    const indirectIndexed0 = device.createBuffer({ size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(indirectIndexed0, 0, new Uint32Array([4, 3, 0, 0, 0]))

    async function runDisc(name, drawFn) {
      const c = await runCase(name, pipelineDisc, drawFn)
      const px = c.center
      // classification: honored → R=G=255; ignored → R=G=0; dropped → blue
      if (px[2] > 200) c.mode = 'DROPPED (nothing painted)'
      else if (px[0] > 200 && px[1] > 200) c.mode = 'HONORED (instance_index AND attribute include firstInstance)'
      else if (px[0] < 60 && px[1] < 60 && px[2] < 60) c.mode = 'IGNORED (draw ran with instance_index=0 / attribute=0)'
      else if (px[0] > 200 && px[1] < 60) c.mode = 'SPLIT (instance_index honors base, ATTRIBUTE fetch does NOT — the GL gotcha)'
      else if (px[0] < 60 && px[1] > 200) c.mode = 'SPLIT-REVERSE (attribute honors base, instance_index does NOT)'
      else c.mode = 'UNCLASSIFIED r=' + px[0] + ' g=' + px[1] + ' b=' + px[2]
      return c
    }

    out.discArrays = await runDisc('DISCRIMINANT drawIndirect [4,1,0,1000]', p => { p.drawIndirect(indirectArrays1, 0) })
    out.discIndexed = await runDisc('DISCRIMINANT drawIndexedIndirect [4,1,0,0,1000]', p => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexedIndirect(indirectIndexed1, 0)
    })

    out.control = await runCase('control draw(4,3,0,0) @base0', pipeline0, p => { p.draw(4, 3, 0, 0) })
    out.direct = await runCase('direct draw(4,3,0,1000)', pipeline, p => { p.draw(4, 3, 0, 1000) })
    // diagnostics: drawIndirect/drawIndexedIndirect AT ALL (base 0, pipeline0)
    out.indirect0 = await runCase('drawIndirect [4,3,0,0] @base0', pipeline0, p => { p.drawIndirect(indirectArrays0, 0) })
    out.indexed0 = await runCase('drawIndexedIndirect [4,3,0,0,0] @base0', pipeline0, p => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexedIndirect(indirectIndexed0, 0)
    })
    out.indirect = await runCase('drawIndirect [4,3,0,1000]', pipeline, p => {
      p.drawIndirect(indirectArrays, 0)
    })
    out.indexed = await runCase('drawIndexedIndirect [4,3,0,0,1000]', pipeline, p => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexedIndirect(indirectIndexed, 0)
    })
  } catch (e) {
    errors.push('exception: ' + String(e?.message ?? e).slice(0, 300))
  }
  return out
}).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))

const okChecks = []
const control = result.control
if (control && !control.validationError && control.iiIncludesBase && control.attrIncludesBase && control.strip3Empty && control.innerOk) {
  okChecks.push(['CONTROL (firstInstance=0): shader math + attribute alignment sane', true])
} else {
  okChecks.push(['CONTROL (firstInstance=0): shader math + attribute alignment sane', false])
}
// the DIRECT 4-arg draw is the PRIZE: pool slicing works without indirect
const direct = result.direct
if (direct && !direct.validationError && direct.iiIncludesBase && direct.attrIncludesBase && direct.strip3Empty && direct.innerOk) {
  okChecks.push(['DIRECT draw(v,i,fv,fi=1000): VALIDATION OK + instance_index includes base + ATTRIBUTE FETCH includes base', true])
} else {
  okChecks.push(['DIRECT draw(v,i,fv,fi=1000): VALIDATION OK + instance_index includes base + ATTRIBUTE FETCH includes base', false])
}
// the indirect plumbing must work at base 0 (else the tier itself is broken)
for (const key of ['indirect0', 'indexed0']) {
  const c = result[key]
  const pass = c && !c.validationError && c.iiIncludesBase && c.attrIncludesBase && c.strip3Empty && c.innerOk
  okChecks.push([`${key} (indirect record, firstInstance=0): the indirect plumbing draws correctly`, !!pass])
}
// the DISCRIMINANTS: whatever the browser does with firstInstance>0 in
// INDIRECT records, the probe must CLASSIFY it (dropped/honored/ignored/split)
for (const key of ['discArrays', 'discIndexed']) {
  const c = result[key]
  const classified = c && typeof c.mode === 'string' && !c.mode.startsWith('UNCLASSIFIED')
  okChecks.push([`${key}: classified → ${classified ? c.mode : (c ? c.mode : 'MISSING')}`, !!classified])
}
// informational: the strip-form indirect cases with firstInstance=1000
for (const key of ['indirect', 'indexed']) {
  const c = result[key]
  if (c) console.log(`   ℹ ${key} (strip form, firstInstance=1000): ${c.iiIncludesBase ? 'drew at base offsets' : 'no base-offset pixels'}${c.validationError ? ' + validation: ' + c.validationError : ''}`)
}
for (const [label, pass] of okChecks) console.log(`${pass ? '✓' : '✗'} ${label}`)
const ok = okChecks.every(([, p]) => p) && result.errors.length === 0
console.log(ok ? 'TASK 188 FIRST-INSTANCE PROBE: PASS' : 'TASK 188 FIRST-INSTANCE PROBE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
