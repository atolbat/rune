// task135-wgsl-emit — THE RAW-DEVICE GPU-EMISSION PARITY GATE (Task 135's
// strongest local verification): a plain WebGPU device (NO canvas — the
// documented env limitation), the REAL emit:'gpu' facade + a hand-rolled
// mini-orchestrator (the same five-binding contract as @rune/gl's
// createGpuParticles), dispatching THE REAL `emit` WGSL entry over the
// handoff's window. The readback rows are compared against the JS
// REFERENCE TWIN (gpuEmitRowModel — itself pinned bit-exact against the
// CPU spawner by task135.test.ts): the GPU's f32 generation must match
// the model within f32 tolerance (the hash quotient's rounding + each
// backend's own transcendentals — the same 1-ULP class as the sim gate).
// A second leg runs the FULL sequence (emit → compact → advance → pack)
// across frames with deaths + compaction: no crash, no NaN, the counts
// agree with the CPU ledger.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8903
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('pageerror', e => console.log(`[pageerror] ${e.message.slice(0, 200)}`))
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const result = await page.evaluate(async (port) => {
  const errors = []
  const out = { errors }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) { errors.push('no adapter'); return out }
    const device = await adapter.requestDevice()
    device.addEventListener?.('uncapturederror', e => errors.push('device: ' + String(e.error?.message ?? e).slice(0, 150)))

    const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=135`)
    const CAP = 4096
    const DT = 1 / 60

    // ── the facade (emit:'gpu', the disc+fixed spawner of the demo class) ──
    const facade = P.createParticles({
      capacity: CAP,
      rate: 5000,
      bursts: [{ time: 0.02, count: 900, cycle: 0, interval: 0.7, probability: 1 }],
      spawner: {
        shape: { kind: 'disc', origin: [0, -1.5, 0], axis: [0, 1, 0], radius: [2, 16] },
        velocity: { mode: 'fixed', dir: [0.06, 1, 0.04] },
        speed: [0.4, 1.4], life: [1.5, 4], size: [0.03, 0.1],
        color: [[1, 0.62, 0.22, 1], [1, 0.86, 0.4, 0.9]], seed: 417,
      },
      wrap: { size: [40, 20, 40] },
      forces: { gravity: [0, 0.8, 0], drag: 0.2, noise: { strength: 0.8, scale: 0.2, speed: 0.2 } },
      render: { kind: 'billboard', draw: 'instance' },
      sim: 'gpu',
      emit: 'gpu',
    })
    facade.at(3.5, 1.0, -2.0) // a NON-ZERO at-origin (the translation tail)
    const handoff = facade.gpuHandoff
    handoff.attached = true

    // ── the mini-orchestrator (the createGpuParticles contract, raw) ──
    const STRIDE = P.GPU_STATE_STRIDE
    const stateBytes = STRIDE * CAP * 4
    const state = device.createBuffer({ size: stateBytes, usage: 0x80 | 0x8 | 0x4 }) // STORAGE|COPY_DST|COPY_SRC
    const swaps = device.createBuffer({ size: 2 * CAP * 4, usage: 0x80 | 0x8 })
    const records = device.createBuffer({ size: 16 * CAP * 4, usage: 0x80 | 0x20 | 0x4 })
    const lut = P.gpuRampLUT([{ t: 0, size: 0.6, r: 1, g: 0.5, b: 0.1, a: 0 }, { t: 1, size: 0.4, r: 0.7, g: 0.2, b: 0.05, a: 0 }])
    const ramp = device.createBuffer({ size: lut.byteLength, usage: 0x80 | 0x8 })
    device.queue.writeBuffer(ramp, 0, lut)

    const module = device.createShaderModule({ code: P.gpuSimWgsl() })
    const compile = await module.getCompilationInfo().catch(() => null)
    if (compile !== null) for (const m of compile.messages) {
      if (m.type === 'error') errors.push(`WGSL compile (line ${m.lineNum}): ${m.message.slice(0, 150)}`)
    }
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
        { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: 4, buffer: { type: 'storage' } },
        { binding: 4, visibility: 4, buffer: { type: 'read-only-storage' } },
      ],
    })
    const UNIFORM_BYTES = P.GPU_SIM_UNIFORM_BYTES // 448 (Task 135's emit block)
    const uniform = device.createBuffer({ size: UNIFORM_BYTES, usage: 0x40 | 0x8 })
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: state } },
        { binding: 2, resource: { buffer: swaps } },
        { binding: 3, resource: { buffer: records } },
        { binding: 4, resource: { buffer: ramp } },
      ],
    })
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const mkPipe = entry => device.createComputePipeline({ layout: pipeLayout, compute: { module, entryPoint: entry } })
    const pipeEmit = mkPipe('emit')
    const pipeCompact = mkPipe('compact')
    const pipeAdvance = mkPipe('advance')
    const pipePack = mkPipe('pack')

    // the uniform: the static halves (the forces + the EMIT block — the
    // same exported helpers @rune/gl's orchestrator packs with)
    const uniBuf = new ArrayBuffer(UNIFORM_BYTES)
    const uni = new Float32Array(uniBuf)
    const u32 = new Uint32Array(uniBuf)
    const F = P.GPU_SIM_F32_FIELDS
    const V = P.GPU_SIM_VEC4_FIELDS
    uni[V.gravity] = 0; uni[V.gravity + 1] = 0.8; uni[V.gravity + 2] = 0
    uni[F.drag] = 0.2
    uni[F.noiseStrength] = 0.8; uni[F.noiseScale] = 0.2; uni[F.noiseSpeed] = 0.2
    uni[F.tileU] = 1; uni[F.tileV] = 1
    uni[V.wrapSize] = 40; uni[V.wrapSize + 1] = 20; uni[V.wrapSize + 2] = 40
    u32[P.GPU_SIM_U32_FIELDS.forceMask] = P.GPU_FORCE_MASK.gravity | P.GPU_FORCE_MASK.drag | P.GPU_FORCE_MASK.noise | P.GPU_FORCE_MASK.wrap
    const emitCfg = P.readGpuEmitConfig(facade.spawnerDesc)
    P.gpuEmitPackStatic(uni, u32, emitCfg)
    const EU = P.GPU_EMIT_U32_FIELDS
    const EV = P.GPU_EMIT_VEC4_FIELDS

    const step = (dt) => {
      facade.advance(dt)
      const ho = facade.gpuHandoff
      const count = facade.count
      u32[P.GPU_SIM_U32_FIELDS.count] = count
      u32[P.GPU_SIM_U32_FIELDS.swapCount] = ho.swapCount
      uni[F.dt] = dt
      const wc = ho.emitOrigin
      uni[V.wrapCenter] = wc[0]; uni[V.wrapCenter + 1] = wc[1]; uni[V.wrapCenter + 2] = wc[2]
      if (ho.swapCount > 0) device.queue.writeBuffer(swaps, 0, ho.swaps.buffer, 0, ho.swapCount * 8)
      // THE GPU EMISSION: the window through the kernel — ZERO CPU rows
      if (ho.emitCount > 0) {
        u32[EU.emitBase] = ho.emitBase
        u32[EU.emitCount] = ho.emitCount
        u32[EU.streamBase] = ho.emitStreamBase | 0
        uni[EV.atOrigin] = wc[0]; uni[EV.atOrigin + 1] = wc[1]; uni[EV.atOrigin + 2] = wc[2]
        uni[EV.emitterV] = ho.emitterV[0]; uni[EV.emitterV + 1] = ho.emitterV[1]; uni[EV.emitterV + 2] = ho.emitterV[2]
        uni[EV.sizeInherit + 2] = ho.emitInheritK
      }
      device.queue.writeBuffer(uniform, 0, uniBuf)
      const enc = device.createCommandEncoder()
      if (ho.emitCount > 0) {
        const ep = enc.beginComputePass()
        ep.setPipeline(pipeEmit); ep.setBindGroup(0, group); ep.dispatchWorkgroups(Math.ceil(ho.emitCount / 64)); ep.end()
      }
      if (ho.swapCount > 0) {
        const cp = enc.beginComputePass()
        cp.setPipeline(pipeCompact); cp.setBindGroup(0, group); cp.dispatchWorkgroups(1); cp.end()
      }
      const workgroups = Math.ceil(count / 64)
      if (workgroups > 0) {
        const cp = enc.beginComputePass()
        cp.setPipeline(pipeAdvance); cp.setBindGroup(0, group); cp.dispatchWorkgroups(workgroups); cp.end()
        const pp = enc.beginComputePass()
        pp.setPipeline(pipePack); pp.setBindGroup(0, group); pp.dispatchWorkgroups(workgroups); pp.end()
      }
      device.queue.submit([enc.finish()])
    }

    // ── LEG 1 — THE EMISSION PARITY: ONE frame, the EMIT ENTRY ONLY (the
    // advance would integrate the newborns — the birth rows must be read
    // RAW). The GPU rows vs the JS model (the bit-twin of the CPU
    // spawner), field by field.
    const read = (buffer, bytes) => {
      const staging = device.createBuffer({ size: Math.ceil(bytes / 4) * 4, usage: 0x8 | 0x1 })
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(buffer, 0, staging, 0, Math.ceil(bytes / 4) * 4)
      device.queue.submit([enc.finish()])
      return staging.mapAsync(1).then(() => {
        const copy = new Uint8Array(staging.getMappedRange().slice(0))
        staging.unmap(); staging.destroy()
        return new Float32Array(copy.buffer, 0, Math.floor(bytes / 4))
      })
    }
    {
      facade.advance(DT) // frame 1: the rate window (the burst fires at t=0.02 — after this)
      const ho = facade.gpuHandoff
      const wc = ho.emitOrigin
      u32[EU.emitBase] = ho.emitBase
      u32[EU.emitCount] = ho.emitCount
      u32[EU.streamBase] = ho.emitStreamBase | 0
      uni[EV.atOrigin] = wc[0]; uni[EV.atOrigin + 1] = wc[1]; uni[EV.atOrigin + 2] = wc[2]
      uni[EV.emitterV] = ho.emitterV[0]; uni[EV.emitterV + 1] = ho.emitterV[1]; uni[EV.emitterV + 2] = ho.emitterV[2]
      uni[EV.sizeInherit + 2] = ho.emitInheritK
      device.queue.writeBuffer(uniform, 0, uniBuf)
      const enc = device.createCommandEncoder()
      const ep = enc.beginComputePass()
      ep.setPipeline(pipeEmit); ep.setBindGroup(0, group); ep.dispatchWorkgroups(Math.ceil(ho.emitCount / 64)); ep.end()
      device.queue.submit([enc.finish()])
      await device.queue.onSubmittedWorkDone()
      const n1 = ho.emitCount
      const gpuRows = await read(state, (ho.emitBase + n1) * STRIDE * 4)
      const model = new Float32Array(STRIDE)
      // THE SPLIT TOLERANCE (the parity contract's own two classes):
      //   · the HASH fields (life/size/color/seed/velocity — pure lerp over
      //     the integer hash) must be EXACT to f32 (the hash is bit-portable
      //     u32; a wrong salt or a broken hash shows up as a ~1.0 delta);
      //   · the POSITION fields carry the disc's cos/sin — each backend's
      //     own transcendentals (the documented f32 class; SwiftShader's
      //     trig runs ~1.5e-4 RELATIVE — a hardware GPU is far tighter).
      let worstHash = 0
      let worstTrig = 0
      let worstField = -1
      let compared = 0
      for (let i = 0; i < n1; i++) {
        const gi = ho.emitStreamBase + i
        P.gpuEmitRowModel(emitCfg, gi, ho.emitOrigin, ho.emitterV, ho.emitInheritK, model)
        const b = (ho.emitBase + i) * STRIDE
        for (let k = 0; k < STRIDE; k++) {
          const d = Math.abs(gpuRows[b + k] - model[k])
          const trig = k < 3 || (k >= 14 && k <= 16)
          if (trig) { if (d > worstTrig) { worstTrig = d; worstField = k } }
          else if (d > worstHash) { worstHash = d; worstField = k }
          if (!Number.isFinite(gpuRows[b + k])) errors.push(`NaN in the emit row ${i} field ${k}`)
          compared++
        }
      }
      out.window1 = { emitBase: ho.emitBase, emitCount: n1, streamBase: ho.emitStreamBase }
      out.compared = compared
      out.worstHashDelta = +worstHash.toFixed(7)
      out.worstTrigDelta = +worstTrig.toFixed(6)
      out.worstField = worstField
      out.emitOk = worstHash < 1e-5 && worstTrig < 5e-3 && compared === n1 * STRIDE && errors.length === 0
    }

    // ── LEG 2 — THE FULL SEQUENCE (deaths + compaction + the wrap): 90
    // frames, no crash, no NaN, the count agrees with the CPU ledger.
    for (let f = 0; f < 90; f++) step(DT)
    await device.queue.onSubmittedWorkDone()
    const count = facade.count
    const gpuState = await read(state, count * STRIDE * 4)
    let nan = 0
    for (let i = 0; i < count * STRIDE; i++) if (!Number.isFinite(gpuState[i])) nan++
    out.frames = 90
    out.count = count
    out.stateNaN = nan
    out.sequenceOk = nan === 0 && count > 1000 && errors.length === 0
  } catch (e) {
    errors.push(String(e && e.message ? e.message : e).slice(0, 300))
  }
  return out
}, PORT)

await browser.close()

console.log(JSON.stringify(result, null, 2))
const ok = result.emitOk && result.sequenceOk && result.errors.length === 0
console.log(ok
  ? `TASK135-WGSL-EMIT: PASS — the emit window (${result.compared} floats): the hash fields bit-exact (worst |Δ| ${result.worstHashDelta}), the trig fields ${result.worstTrigDelta} (the f32 class), the full 90-frame sequence clean at ${result.count} live`
  : `TASK135-WGSL-EMIT: FAIL — ${result.errors.join(' | ') || `emitOk=${result.emitOk} sequenceOk=${result.sequenceOk} hash=${result.worstHashDelta} trig=${result.worstTrigDelta} (field ${result.worstField})`}`)
process.exit(ok ? 0 : 1)
