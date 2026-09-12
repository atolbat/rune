// task189-gpu-probes.mjs — Task 189: the GPU side of the "other theories".
//
// PROBE A — GL BASE-INSTANCE (the P3 pool-slicing primitive on WebGL2):
//   The instance-matrix pool bound as ONE divisor-1 attribute; a group draws
//   with the attribute slice at its pool offset. The slice needs baseInstance
//   in the FIXED-FUNCTION attribute fetch. WebGL2 core has NO baseInstance;
//   the WEBGL_multi_draw_instanced_base_vertex_base_instance extension adds
//   multiDrawArraysInstancedBaseInstanceWEBGL. Probed, not believed:
//   (1) is the extension present in THIS container (ANGLE/SwiftShader)?
//   (2) pixel A/B: 8 groups — CLASSIC (per-group vertexAttribPointer rebind +
//       drawArraysInstanced) vs ONE binding + ONE multi-draw with
//       baseInstances — byte-identical readback required;
//   (3) the GL gotcha documented: gl_InstanceID is 0-based per sub-draw (it
//       does NOT include baseInstance) — the attribute fetch MUST be the one
//       that offsets (the probe proves it: R encodes the GLOBAL index from
//       the attribute, G encodes gl_InstanceID — R advances across the
//       baseInstance boundary, G sawtooths).
//
// PROBE B — WGSL BIT-DISCARD (GPU-side visibility filtering):
//   Theory: skip the CPU collect ENTIRELY — draw ALL n instances, the vertex
//   shader reads the visibility bit (a storage buffer of words) for
//   instance_index and collapses invisible instances to a degenerate (clipped)
//   position. A/B pixel parity against the CPU-collected path (draw only the
//   k visible) — the painted set must be identical. The CPU cost of the
//   collect is measured in-page (the filter loop that stands for
//   collectGroupMatrices); the GPU cost honest note: n vs k vertex invocations
//   (55% wasted at 45% visibility) — a device-side question, SwiftShader
//   timings are not representative; the probe proves SEMANTICS.
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const PORT = 8913

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
  const out = { errors: [], ua: navigator.userAgent }
  const W = 2048 // instances × 1 pixel each
  const hash = (i) => (Math.imul(i + 1, 2654435761) >>> 0) % 100
  const visible = (i) => hash(i) < 45 // ~45% — the demo band
  const instData = new Float32Array(W)
  for (let i = 0; i < W; i++) instData[i] = i

  // ───────────────────────────────────────────────────────── PROBE A (GL) ──
  try {
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = 1
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })
    if (!gl) { out.gl = { present: false, reason: 'no webgl2' } }
    else {
      const ext = gl.getExtension('WEBGL_multi_draw_instanced_base_vertex_base_instance')
      const extMD = gl.getExtension('WEBGL_multi_draw')
      out.gl = {
        webgl2: true,
        baseInstanceExt: ext !== null,
        multiDrawExt: extMD !== null,
        renderer: gl.getParameter(gl.RENDERER),
      }
      if (ext) {
        const VS = `#version 300 es
        precision highp float;
        in float a_xoff;
        out vec2 v_enc;
        void main() {
          float u = (gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : 0.0;
          float v = (gl_VertexID == 2 || gl_VertexID == 3) ? 1.0 : 0.0;
          float x = -1.0 + (a_xoff + u) * (2.0 / ${W}.0);
          gl_Position = vec4(x, v * 2.0 - 1.0, 0.0, 1.0);
          v_enc = vec2(a_xoff, float(gl_InstanceID));
        }`
        const FS = `#version 300 es
        precision highp float;
        in vec2 v_enc;
        out vec4 o;
        void main() {
          o = vec4(floor(v_enc.x * 255.0 / 2047.0 + 0.5) / 255.0, floor(v_enc.y * 255.0 / 255.0 + 0.5) / 255.0, 0.0, 1.0);
        }`
        const mk = (type, src) => {
          const s = gl.createShader(type)
          gl.shaderSource(s, src); gl.compileShader(s)
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s))
          return s
        }
        const prog = gl.createProgram()
        gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS))
        gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS))
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog))
        gl.useProgram(prog)

        const inst = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, inst)
        gl.bufferData(gl.ARRAY_BUFFER, instData, gl.STATIC_DRAW)
        const loc = gl.getAttribLocation(prog, 'a_xoff')
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribDivisor(loc, 1)

        const G = 8, PER = W / G
        const render = (mode) => {
          gl.viewport(0, 0, W, 1)
          gl.clearColor(0, 0, 1, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          if (mode === 'classic') {
            for (let g = 0; g < G; g++) {
              gl.bindBuffer(gl.ARRAY_BUFFER, inst)
              gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 4, g * PER * 4) // the REBIND
              gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, PER)
            }
          } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, inst)
            gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 4, 0) // ONE binding
            const firsts = new Int32Array(G).fill(0)
            const counts = new Int32Array(G).fill(4)
            const instanceCounts = new Int32Array(G).fill(PER)
            const baseInstances = new Int32Array(G)
            for (let g = 0; g < G; g++) baseInstances[g] = g * PER
            ext.multiDrawArraysInstancedBaseInstanceWEBGL(gl.TRIANGLE_STRIP, firsts, counts, instanceCounts, baseInstances, G)
          }
          const px = new Uint8Array(W * 4)
          gl.readPixels(0, 0, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
          return px
        }
        const a = render('classic')
        const b = render('pool')
        let identical = true
        let rAdvances = true
        let gSawtooth = true
        for (let x = 0; x < W; x++) {
          const p = x * 4
          if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]) identical = false
          // R must encode the GLOBAL index (the attribute fetch included the base)
          const expectR = Math.round(x * 255 / 2047)
          if (Math.abs(b[p] - expectR) > 1) rAdvances = false
          // G sawtooths per sub-draw (gl_InstanceID excludes baseInstance — the gotcha)
          if (b[p + 1] !== Math.round((x % 256) * 255 / 255)) gSawtooth = false
        }
        out.gl.abIdentical = identical
        out.gl.attrIncludesBase = rAdvances
        out.gl.instanceIdExcludesBase = gSawtooth
      }
    }
  } catch (e) {
    out.errors.push('GL probe: ' + String(e?.message ?? e).slice(0, 300))
  }

  // ──────────────────────────────────────────────────────── PROBE B (WGSL) ──
  try {
    const adapter = await navigator.gpu?.requestAdapter?.()
    if (!adapter) { out.wgpu = { present: false, reason: 'no adapter' } }
    else {
      const device = await adapter.requestDevice()
      device.addEventListener?.('uncapturederror', e => out.errors.push('device error: ' + String(e.error?.message ?? e).slice(0, 200)))
      const SIZE = W
      const format = 'rgba8unorm'
      const words = (W + 31) >>> 5
      const bitsData = new Uint32Array(words)
      let visibleCount = 0
      for (let i = 0; i < W; i++) {
        if (visible(i)) { bitsData[i >>> 5] |= 1 << (i & 31); visibleCount++ }
      }

      // shader A: CPU-collected (attr = the compacted xoff of VISIBLE instances)
      const shaderA = device.createShaderModule({ code: `
        struct VOut { @builtin(position) pos: vec4f, @location(0) enc: f32 }
        @vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) xoff: f32) -> VOut {
          var u = 0.0; var v = 0.0;
          if (vi == 1u || vi == 3u) { u = 1.0; }
          if (vi == 2u || vi == 3u) { v = 1.0; }
          var o: VOut;
          o.pos = vec4f(-1.0 + (xoff + u) * (2.0 / ${W}.0), v * 2.0 - 1.0, 0.0, 1.0);
          o.enc = xoff;
          return o;
        }
        @fragment fn fs(i: VOut) -> @location(0) vec4f {
          return vec4f(floor(i.enc * 255.0 / 2047.0 + 0.5) / 255.0, 0.0, 0.0, 1.0);
        }
      ` })
      // shader B: draw ALL, read the bit, collapse the invisible (degenerate → clipped)
      const shaderB = device.createShaderModule({ code: `
        struct VOut { @builtin(position) pos: vec4f, @location(0) enc: f32 }
        @group(0) @binding(0) var<storage, read> bits: array<u32>;
        @vertex fn vs(@builtin(instance_index) ii: u32, @builtin(vertex_index) vi: u32, @location(0) xoff: f32) -> VOut {
          var u = 0.0; var v = 0.0;
          if (vi == 1u || vi == 3u) { u = 1.0; }
          if (vi == 2u || vi == 3u) { v = 1.0; }
          let word = bits[ii >> 5u];
          let vis = (word & (1u << (ii & 31u))) != 0u;
          var o: VOut;
          if (vis) {
            o.pos = vec4f(-1.0 + (xoff + u) * (2.0 / ${W}.0), v * 2.0 - 1.0, 0.0, 1.0);
          } else {
            o.pos = vec4f(2.0, 2.0, 2.0, 1.0); // outside NDC — clipped, nothing painted
          }
          o.enc = xoff;
          return o;
        }
        @fragment fn fs(i: VOut) -> @location(0) vec4f {
          return vec4f(floor(i.enc * 255.0 / 2047.0 + 0.5) / 255.0, 0.0, 0.0, 1.0);
        }
      ` })
      for (const m of [shaderA, shaderB]) {
        const info = await m.getCompilationInfo().catch(() => null)
        if (info) for (const msg of info.messages) if (msg.type === 'error') out.errors.push(`WGSL (line ${msg.lineNum}): ${msg.message.slice(0, 200)}`)
      }
      const mkPipeline = (module) => device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module, entryPoint: 'vs',
          buffers: [{ arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32' }] }],
        },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-strip' },
      })
      const pipeA = mkPipeline(shaderA)
      const pipeB = mkPipeline(shaderB)

      const full = device.createBuffer({ size: W * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(full, 0, instData)
      const bits = device.createBuffer({ size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(bits, 0, bitsData)

      // the CPU-collect stand-in: the compaction filter, timed (the cost the
      // bit-discard theory removes from the frame)
      const scratch = new Float32Array(W)
      const collect = () => {
        let k = 0
        for (let i = 0; i < W; i++) if (visible(i)) scratch[k++] = instData[i]
        return k
      }
      collect()
      for (let i = 0; i < 200; i++) collect() // warm
      const t0 = performance.now()
      for (let i = 0; i < 1000; i++) collect()
      out.wgpu = {
        present: true,
        visibleCount,
        collectUsPerCall: (performance.now() - t0) / 1000 * 1000,
      }
      const compact = device.createBuffer({ size: W * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(compact, 0, scratch)

      const readback = async (pipe, bindBits, drawFn, vertBuf) => {
        const target = device.createTexture({ size: [SIZE, 1], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
        const staging = device.createBuffer({ size: SIZE * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        device.pushErrorScope('validation')
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        })
        pass.setPipeline(pipe)
        pass.setVertexBuffer(0, vertBuf)
        if (bindBits) {
          const bg = device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: bits } }],
          })
          pass.setBindGroup(0, bg)
        }
        drawFn(pass)
        pass.end()
        encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: SIZE * 4 }, [SIZE, 1])
        device.queue.submit([encoder.finish()])
        const err = await device.popErrorScope()
        if (err) out.errors.push('validation: ' + String(err.message).slice(0, 200))
        await staging.mapAsync(GPUMapMode.READ)
        const px = new Uint8Array(staging.getMappedRange().slice(0))
        staging.unmap()
        return px
      }
      const k = visibleCount
      const pxA = await readback(pipeA, false, (p) => { p.draw(4, k, 0, 0) }, compact)
      const pxB = await readback(pipeB, true, (p) => { p.draw(4, W, 0, 0) }, full)
      let paintedA = 0, paintedB = 0, mismatch = 0, missed = 0, extra = 0
      for (let x = 0; x < W; x++) {
        const pa = pxA[x * 4 + 3] !== 255 || pxA[x * 4 + 2] > 0
        const pb = pxB[x * 4 + 3] !== 255 || pxB[x * 4 + 2] > 0
        const aPainted = !(pxA[x * 4 + 2] > 200) // blue bg → not painted
        const bPainted = !(pxB[x * 4 + 2] > 200)
        if (aPainted) paintedA++
        if (bPainted) paintedB++
        if (aPainted !== bPainted) { if (aPainted) missed++; else extra++ }
        if (aPainted && bPainted && pxA[x * 4] !== pxB[x * 4]) mismatch++
      }
      out.wgpu.paintedA = paintedA
      out.wgpu.paintedB = paintedB
      out.wgpu.parity = paintedA === paintedB && mismatch === 0 && paintedA === visibleCount
      out.wgpu.diagnostics = { mismatch, missed, extra }
    }
  } catch (e) {
    out.errors.push('WGPU probe: ' + String(e?.message ?? e).slice(0, 300))
  }
  return out
}).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))

const okChecks = []
const gl = result.gl ?? {}
if (gl.webgl2) {
  okChecks.push([`WebGL2 present (${String(gl.renderer).slice(0, 60)})`, true])
  okChecks.push([`WEBGL_multi_draw present (the Task-187 tier)`, !!gl.multiDrawExt])
  if (gl.baseInstanceExt) {
    okChecks.push(['WEBGL_..._base_vertex_base_instance present', true])
    okChecks.push([`A/B pixel parity: classic rebinds vs ONE multi-draw with baseInstances — ${gl.abIdentical ? 'IDENTICAL' : 'MISMATCH'}`, !!gl.abIdentical])
    okChecks.push([`the ATTRIBUTE fetch includes baseInstance (R encodes the global index) — ${gl.attrIncludesBase ? 'YES' : 'NO'}`, !!gl.attrIncludesBase])
    okChecks.push([`gl_InstanceID EXCLUDES baseInstance (the documented GL gotcha; G sawtooths) — ${gl.instanceIdExcludesBase ? 'confirmed' : 'unexpected'}`, !!gl.instanceIdExcludesBase])
  } else {
    okChecks.push(['base-instance extension: ABSENT in this container — the GL pool-slicing is capability-gated (runtime probe), documented', true])
  }
} else if (result.gl) {
  okChecks.push(['WebGL2 unavailable', false])
}
const wg = result.wgpu ?? {}
if (wg.present) {
  okChecks.push([`WGSL bit-discard: painted A=${wg.paintedA} B=${wg.paintedB} of ${W2()} (visible=${wg.visibleCount}) — ${wg.parity ? 'PARITY' : 'MISMATCH ' + JSON.stringify(wg.diagnostics)}`, !!wg.parity])
  okChecks.push([`the CPU collect it removes: ${wg.collectUsPerCall?.toFixed(1)}µs per call at 2048 instances (scales with n)`, true])
} else if (result.wgpu) {
  okChecks.push(['WebGPU unavailable', false])
}
function W2() { return 2048 }
for (const [label, pass] of okChecks) console.log(`${pass ? '✓' : '✗'} ${label}`)
if (result.errors?.length) for (const e of result.errors) console.log(`ℹ ${e}`)
const ok = okChecks.every(([, p]) => p) && (result.errors ?? []).length === 0
console.log(ok ? 'TASK 189 GPU PROBES: PASS' : 'TASK 189 GPU PROBES: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
