// task135-glsl-emit — THE IN-PAGE GLSL EMISSION GATE (Task 135): the
// transform-feedback emit pass compiled + run on a REAL WebGL2 context (a
// raw harness — the varyings-before-link contract, the dedicated VAO, the
// POINTS draw, the INTERLEAVED 20-float rows), the rows read back via
// getBufferSubData(COPY_READ_BUFFER — the TRANSFORM_FEEDBACK target is
// forbidden for reads) and compared against the JS REFERENCE TWIN
// (gpuEmitRowModel — itself pinned bit-exact against the CPU spawner by
// task135.test.ts). The GLSL twin's hash fields must be exact to f32, the
// trig fields within the f32 class (the same split-tolerance contract as
// the WGSL raw-device gate; SwiftShader's trig runs ~1.5e-4 relative).
//
// The harness's own two lessons (pinned here for the next soul): a buffer
// left bound to the generic ARRAY_BUFFER while captured by the TF raises
// INVALID_OPERATION and silently drops the write; getBufferSubData must
// target a non-TF binding point.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8903
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('pageerror', e => console.log(`[pageerror] ${e.message.slice(0, 150)}`))
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const out = await page.evaluate(async (port) => {
  const errors = []
  const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=135`)
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { antialias: false })
  if (gl === null) return { errors: ['no webgl2'] }
  const N = 24
  // the mini tier (the TfComputeFacade contract, raw)
  const passes = new Map()
  const buffers = new Map()
  let nextId = 1
  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src); gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { errors.push('compile: ' + gl.getShaderInfoLog(sh)); return null }
    return sh
  }
  const createBuffer = (init) => {
    const b = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, init, gl.DYNAMIC_COPY)
    gl.bindBuffer(gl.ARRAY_BUFFER, null) // the TF-capture overlap rule
    const id = nextId++; buffers.set(id, b); return id
  }
  const createPass = (desc) => {
    const sh = compile(gl.VERTEX_SHADER, desc.vertex)
    if (sh === null) return -1
    const fh = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fh, '#version 300 es\nprecision lowp float;\nvoid main() {}\n')
    gl.compileShader(fh)
    const prog = gl.createProgram()
    gl.attachShader(prog, sh); gl.attachShader(prog, fh)
    gl.transformFeedbackVaryings(prog, desc.outputs, gl.INTERLEAVED_ATTRIBS) // BEFORE the link
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { errors.push('link: ' + gl.getProgramInfoLog(prog)); return -1 }
    const id = nextId++
    passes.set(id, { prog, tf: gl.createTransformFeedback(), vao: gl.createVertexArray(), desc })
    return id
  }
  const runPass = (id, vertexCount, output) => {
    const p = passes.get(id)
    gl.useProgram(p.prog)
    let at = 0
    for (const u of p.desc.uniforms) {
      const loc = gl.getUniformLocation(p.prog, u.name)
      if (u.size === 1) gl.uniform1f(loc, output.uniformData[at])
      else if (u.size === 2) gl.uniform2f(loc, output.uniformData[at], output.uniformData[at + 1])
      else if (u.size === 3) gl.uniform3f(loc, output.uniformData[at], output.uniformData[at + 1], output.uniformData[at + 2])
      else gl.uniform4f(loc, output.uniformData[at], output.uniformData[at + 1], output.uniformData[at + 2], output.uniformData[at + 3])
      at += u.size
    }
    gl.bindVertexArray(p.vao)
    gl.enable(gl.RASTERIZER_DISCARD)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, p.tf)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers.get(output.bufferId))
    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, vertexCount)
    gl.endTransformFeedback()
    const err = gl.getError()
    if (err !== 0) errors.push(`runPass GL error ${err} at ${vertexCount} verts`)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
    gl.disable(gl.RASTERIZER_DISCARD)
    gl.bindVertexArray(null)
  }
  const stateOut = createBuffer(new Float32Array(64 * 20))
  const emitPass = createPass({ vertex: P.gpuSimGlEmitGlsl(), outputs: P.GPU_GL_ADVANCE_OUTPUTS, uniforms: P.GPU_GL_EMIT_UNIFORMS })
  if (emitPass < 0) return { errors }

  // the demo's own spawner (disc + fixed) + a NON-ZERO window (the stream
  // halves' recombination path) and a second shape for the sweep
  const descs = [
    {
      shape: { kind: 'disc', origin: [0, -1.5, 0], axis: [0, 1, 0], radius: [2, 16] },
      velocity: { mode: 'fixed', dir: [0.06, 1, 0.04] },
      speed: [0.4, 1.4], life: [5, 11], size: [0.03, 0.1],
      color: [[1, 0.62, 0.22, 1], [1, 0.86, 0.4, 0.9]], seed: 417,
    },
    {
      shape: { kind: 'sphere', origin: [1, 2, 3], radius: [0.05, 0.5] },
      velocity: { mode: 'radial' },
      speed: [2.5, 5.5], life: [3, 5], size: [0.05, 0.12],
      color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]], seed: 991,
    },
  ]
  const model = new Float32Array(P.GPU_STATE_STRIDE)
  let worstHash = 0, worstTrig = 0, worstField = -1, compared = 0
  for (const desc of descs) {
    const cfg = P.readGpuEmitConfig(desc)
    const E = P.GPU_GL_EMIT_F
    const uni = new Float32Array(67)
    uni[E.emitBase] = 0; uni[E.emitCount] = N
    // a stream base ABOVE 2^16 (the halves must carry it: 76543)
    uni[E.streamLo] = 76543 & 0xffff
    uni[E.streamHi] = (76543 >>> 16) & 0xffff
    uni[E.shapeKind] = cfg.shapeKind; uni[E.velMode] = cfg.velMode
    const sd = cfg.seed >>> 0
    uni[E.seedLo] = sd & 0xffff; uni[E.seedHi] = (sd >>> 16) & 0xffff
    const p3 = (b, v) => { uni[b] = v[0]; uni[b + 1] = v[1]; uni[b + 2] = v[2] }
    const p4 = (b, v) => { uni[b] = v[0]; uni[b + 1] = v[1]; uni[b + 2] = v[2]; uni[b + 3] = v[3] }
    const at = [2.5, -1.0, 4.0]
    p3(E.shapeOrigin, cfg.shapeOrigin); p3(E.atOrigin, at)
    p3(E.axis, cfg.axis); p3(E.t1, cfg.t1); p3(E.t2, cfg.t2); p3(E.fixedDir, cfg.fixedDir)
    p3(E.lineTo, cfg.lineTo ?? [0, 0, 0])
    p4(E.radius, [cfg.rMin, cfg.rMax, cfg.hemArc, cfg.donR])
    p4(E.cone, [cfg.cosHalf, cfg.baseRadius, cfg.lenMin, cfg.lenMax])
    p4(E.donut, [cfg.tubeMin, cfg.tubeMax, cfg.donArc, cfg.arms])
    p4(E.misc, [cfg.armSpread, cfg.twist, cfg.rectW, cfg.rectH])
    p4(E.misc2, [cfg.gridW, cfg.gridH, cfg.gridRows, cfg.gridCols])
    p4(E.speed, [cfg.speedMin, cfg.speedMax, cfg.lifeMin, cfg.lifeMax])
    p3(E.sizeInherit, [cfg.sizeMin, cfg.sizeMax, 0.6])
    p4(E.color0, cfg.color0); p4(E.color1, cfg.color1)
    const ev = [0.5, 0.25, -0.75]
    p3(E.emitterV, ev)
    runPass(emitPass, N, { bufferId: stateOut, uniformData: uni })
    // the readback (COPY_READ — the TF target is forbidden for reads)
    const rows = new Float32Array(N * 20)
    gl.bindBuffer(gl.COPY_READ_BUFFER, buffers.get(stateOut))
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, rows)
    gl.bindBuffer(gl.COPY_READ_BUFFER, null)
    for (let i = 0; i < N; i++) {
      const gi = 76543 + i
      P.gpuEmitRowModel(cfg, gi, at, ev, 0.6, model)
      const b = i * 20
      for (let k = 0; k < 17; k++) {
        const d = Math.abs(rows[b + k] - model[k])
        // the trig class: the positions AND the velocities (a radial/lobe
        // direction carries the shape's trig — only the lerp fields
        // 6..13 (age/life/size/color/seed) are pure hash)
        const trig = k <= 5 || (k >= 14 && k <= 16)
        if (trig) { if (d > worstTrig) { worstTrig = d; worstField = k } }
        else if (d > worstHash) { worstHash = d; worstField = k }
        if (!Number.isFinite(rows[b + k])) errors.push(`NaN row ${i} field ${k} (${desc.shape.kind})`)
        compared++
      }
    }
  }
  return {
    errors,
    compared,
    worstHash: +worstHash.toFixed(7),
    worstTrig: +worstTrig.toFixed(6),
    worstField,
    ok: errors.length === 0 && worstHash < 1e-5 && worstTrig < 5e-3,
  }
}, PORT)

await browser.close()
console.log(JSON.stringify(out, null, 2))
const ok = out.ok === true
console.log(ok
  ? `TASK135-GLSL-EMIT: PASS — ${out.compared} floats over 2 shapes: the hash fields bit-exact (worst |Δ| ${out.worstHash}), the trig fields ${out.worstTrig} (the f32 class)`
  : `TASK135-GLSL-EMIT: FAIL — ${out.errors.join(' | ') || `hash=${out.worstHash} trig=${out.worstTrig} (field ${out.worstField})`}`)
process.exit(ok ? 0 : 1)
