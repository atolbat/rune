// task131-wgsl-sim — THE RAW-DEVICE SIM PARITY GATE (the strongest local
// verification of the GPGPU tier): a plain WebGPU device (NO canvas — the
// live demo's device dies under the SwiftShader canvas+readback load, the
// documented env limitation), the REAL facade (sim:'gpu') + a hand-rolled
// mini-orchestrator (the same five-binding contract as @rune/gl's
// createGpuParticles) vs the CPU reference facade (sim:'cpu', the same
// desc). After 90 frames of gravity+drag (the deterministic forces):
//   · the GPU state (positions/velocities) must match the CPU reference
//     within f32 tolerance — the same particles, the same slots (the CPU
//     drives BOTH compactions identically);
//   · the GPU pack (the 16-float instance records) must match the CPU
//     packInstances output (the ramp/tint/tile math);
//   · a second pass with the noise field ON proves the flow moves the
//     particles (bounded, not exact — the transcendental f32 drift).
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

    const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=131`)
    const CAP = 8192
    const FRAMES = 90
    const DT = 1 / 60
    const RAMP = P.createRamp([
      { t: 0, size: 0.5, r: 1, g: 0.9, b: 0.7, a: 0 },
      { t: 0.2, size: 1, r: 1, g: 0.95, b: 0.85, a: 1 },
      { t: 1, size: 0.15, r: 0.4, g: 0.6, b: 1, a: 0 },
    ])
    const SPAWNER = {
      shape: { kind: 'sphere', origin: [0, 0.5, 0], radius: [0.05, 0.5] },
      velocity: { mode: 'radial' },
      speed: [2.5, 5.5], life: [3, 5], size: [0.05, 0.12],
      color: [[1, 1, 1, 1], [0.7, 0.85, 1, 0.8]], seed: 991,
    }
    const mkDesc = (sim) => ({
      capacity: CAP, rate: 1500, ramp: RAMP, spawner: SPAWNER,
      forces: { gravity: [0, -2.5, 0], drag: 0.4 },
      render: { kind: 'billboard', draw: 'instance', tiles: [2, 2], frameJitter: 4 },
      sim,
    })
    const gpuFacade = P.createParticles(mkDesc('gpu'))
    const cpuFacade = P.createParticles(mkDesc('cpu'))
    const handoff = gpuFacade.gpuHandoff
    handoff.attached = true

    // ── the mini-orchestrator (the createGpuParticles contract, raw) ──
    const STRIDE = P.GPU_STATE_STRIDE
    const stateBytes = STRIDE * CAP * 4
    const state = device.createBuffer({ size: stateBytes, usage: 0x80 | 0x8 | 0x4 }) // STORAGE|COPY_DST|COPY_SRC
    const swaps = device.createBuffer({ size: 2 * CAP * 4, usage: 0x80 | 0x8 })
    const records = device.createBuffer({ size: 16 * CAP * 4, usage: 0x80 | 0x20 | 0x4 }) // STORAGE|VERTEX|COPY_SRC
    const lut = P.gpuRampLUT(RAMP.points)
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
    const uniform = device.createBuffer({ size: P.GPU_SIM_UNIFORM_BYTES, usage: 0x40 | 0x8 }) // UNIFORM|COPY_DST (448 since Task 135's emit block)
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
    const pipeCompact = mkPipe('compact')
    const pipeAdvance = mkPipe('advance')
    const pipePack = mkPipe('pack')

    // the uniform (the gravity + drag mask — the deterministic parity run)
    const uniBuf = new ArrayBuffer(P.GPU_SIM_UNIFORM_BYTES)
    const uni = new Float32Array(uniBuf)
    const u32 = new Uint32Array(uniBuf)
    const F = P.GPU_SIM_F32_FIELDS
    const V = P.GPU_SIM_VEC4_FIELDS
    uni[V.gravity] = 0; uni[V.gravity + 1] = -2.5; uni[V.gravity + 2] = 0
    uni[F.drag] = 0.4
    uni[F.tileU] = 2; uni[F.tileV] = 2; uni[F.frameJitter] = 4
    u32[P.GPU_SIM_U32_FIELDS.forceMask] = P.GPU_FORCE_MASK.gravity | P.GPU_FORCE_MASK.drag

    const step = (dt) => {
      gpuFacade.advance(dt)
      cpuFacade.advance(dt)
      const ho = gpuFacade.gpuHandoff
      const count = gpuFacade.count
      u32[P.GPU_SIM_U32_FIELDS.count] = count
      u32[P.GPU_SIM_U32_FIELDS.swapCount] = ho.swapCount
      uni[F.dt] = dt
      if (ho.swapCount > 0) device.queue.writeBuffer(swaps, 0, ho.swaps.buffer, 0, ho.swapCount * 8)
      if (ho.emitCount > 0) device.queue.writeBuffer(state, ho.emitBase * STRIDE * 4, ho.emitRows.buffer, 0, ho.emitCount * STRIDE * 4)
      device.queue.writeBuffer(uniform, 0, uniBuf)
      const enc = device.createCommandEncoder()
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

    for (let f = 0; f < FRAMES; f++) step(DT)
    await device.queue.onSubmittedWorkDone()
    out.count = gpuFacade.count
    out.cpuCount = cpuFacade.count
    if (gpuFacade.count !== cpuFacade.count) {
      errors.push(`count drift: gpu ${gpuFacade.count} vs cpu ${cpuFacade.count}`)
      return out
    }

    // ── the readback: the state + the records of the live range ──
    const read = (buffer, bytes) => {
      const staging = device.createBuffer({ size: Math.ceil(bytes / 4) * 4, usage: 0x8 | 0x1 }) // COPY_DST|MAP_READ
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(buffer, 0, staging, 0, Math.ceil(bytes / 4) * 4)
      device.queue.submit([enc.finish()])
      return staging.mapAsync(1).then(() => {
        const copy = new Uint8Array(staging.getMappedRange().slice(0))
        staging.unmap(); staging.destroy()
        return new Float32Array(copy.buffer, 0, Math.floor(bytes / 4))
      })
    }
    const count = gpuFacade.count
    const gpuState = await read(state, count * STRIDE * 4)
    const gpuRecords = await read(records, count * 16 * 4)

    // ── THE PARITY: the same slots = the same particles (the CPU drove both
    // compactions through the identical aging walk). The tolerance: f32
    // accumulation over 90 frames vs the CPU's f64.
    const f = cpuFacade.fields
    let worstPos = 0, worstVel = 0, worstAge = 0
    let worstRecord = 0
    for (let i = 0; i < count; i++) {
      const b = i * STRIDE
      worstPos = Math.max(worstPos, Math.abs(gpuState[b] - f.px[i]), Math.abs(gpuState[b + 1] - f.py[i]), Math.abs(gpuState[b + 2] - f.pz[i]))
      worstVel = Math.max(worstVel, Math.abs(gpuState[b + 3] - f.vx[i]), Math.abs(gpuState[b + 4] - f.vy[i]), Math.abs(gpuState[b + 5] - f.vz[i]))
      worstAge = Math.max(worstAge, Math.abs(gpuState[b + 6] - f.age[i]))
    }
    // the records: the CPU pack of the SAME system (a fresh pack into a scratch)
    const cpuRecords = new Float32Array(16 * count)
    P.packInstances({ fields: f, count }, cpuRecords, { ramp: RAMP, tiles: [2, 2], frameJitter: 4 })
    let recCompared = 0
    for (let i = 0; i < count; i++) {
      const g = i * 16, c = i * 16
      // skip the zero-size records (the CPU pack compacts them out — the
      // GPU pack writes every slot; the counts can differ at the tail)
      if (cpuRecords[c + 10] <= 0) continue
      for (let k = 0; k < 16; k++) {
        const d = Math.abs(gpuRecords[g + k] - cpuRecords[c + k])
        if (d > worstRecord) worstRecord = d
      }
      recCompared++
    }
    out.worstPos = +worstPos.toFixed(5)
    out.worstVel = +worstVel.toFixed(5)
    out.worstAge = +worstAge.toFixed(5)
    out.worstRecord = +worstRecord.toFixed(5)
    out.recCompared = recCompared
    out.stateOk = worstPos < 0.02 && worstVel < 0.02
    out.recordsOk = worstRecord < 0.01 && recCompared > count * 0.9

    // ── THE NOISE RUN (the flow field moves the particles — not exact) ──
    const uni2mask = P.GPU_FORCE_MASK.gravity | P.GPU_FORCE_MASK.drag | P.GPU_FORCE_MASK.noise | P.GPU_FORCE_MASK.turbulence
    u32[P.GPU_SIM_U32_FIELDS.forceMask] = uni2mask
    uni[P.GPU_SIM_F32_FIELDS.noiseStrength] = 1.2
    uni[P.GPU_SIM_F32_FIELDS.noiseScale] = 0.3
    uni[P.GPU_SIM_F32_FIELDS.noiseSpeed] = 0.25
    uni[P.GPU_SIM_F32_FIELDS.turbulence] = 0.3
    for (let f = 0; f < 60; f++) {
      gpuFacade.advance(DT)
      cpuFacade.advance(DT)
      const ho = gpuFacade.gpuHandoff
      u32[P.GPU_SIM_U32_FIELDS.count] = gpuFacade.count
      u32[P.GPU_SIM_U32_FIELDS.swapCount] = ho.swapCount
      uni[P.GPU_SIM_F32_FIELDS.dt] = DT
      if (ho.swapCount > 0) device.queue.writeBuffer(swaps, 0, ho.swaps.buffer, 0, ho.swapCount * 8)
      if (ho.emitCount > 0) device.queue.writeBuffer(state, ho.emitBase * STRIDE * 4, ho.emitRows.buffer, 0, ho.emitCount * STRIDE * 4)
      device.queue.writeBuffer(uniform, 0, uniBuf)
      const enc = device.createCommandEncoder()
      if (ho.swapCount > 0) {
        const cp = enc.beginComputePass(); cp.setPipeline(pipeCompact); cp.setBindGroup(0, group); cp.dispatchWorkgroups(1); cp.end()
      }
      const wg = Math.ceil(gpuFacade.count / 64)
      const cp = enc.beginComputePass(); cp.setPipeline(pipeAdvance); cp.setBindGroup(0, group); cp.dispatchWorkgroups(wg); cp.end()
      device.queue.submit([enc.finish()])
    }
    await device.queue.onSubmittedWorkDone()
    const noiseState = await read(state, Math.min(count, 2048) * STRIDE * 4)
    let moved = 0, nan = 0
    const n = Math.min(count, 2048)
    for (let i = 0; i < n; i++) {
      const b = i * STRIDE
      const v = Math.abs(noiseState[b + 3]) + Math.abs(noiseState[b + 4]) + Math.abs(noiseState[b + 5])
      if (!Number.isFinite(v) || !Number.isFinite(noiseState[b] + noiseState[b + 1] + noiseState[b + 2])) { nan++; continue }
      if (v > 0.1) moved++
    }
    out.noiseMoved = moved
    out.noiseNan = nan
    out.noiseOk = nan === 0 && moved > n * 0.5
  } catch (e) {
    errors.push('exception: ' + String(e?.message ?? e).slice(0, 250))
  }
  return out
}, PORT).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))
const ok = result.errors.length === 0 && result.stateOk === true && result.recordsOk === true && result.noiseOk === true
console.log(ok ? 'GPU SIM PARITY GATE: PASS' : 'GPU SIM PARITY GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
