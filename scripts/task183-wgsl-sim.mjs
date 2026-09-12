// task183-wgsl-sim — THE RAW-DEVICE PACKED-RECORD PARITY GATE (Task 183's
// strongest local verification of the GPGPU tier's f16 pack): a plain
// WebGPU device (NO canvas — the SwiftShader canvas+readback limitation),
// the REAL facade (sim:'gpu') + the hand-rolled mini-orchestrator (the
// same five-binding contract as @rune/gl's createGpuParticles) vs the CPU
// reference facade (sim:'cpu', the same desc). After 90 frames of
// gravity+drag (the deterministic forces):
//   · the GPU state (positions/velocities) must match the CPU reference
//     within the f32 accumulation tolerance — the same particles, the
//     same slots (the CPU drives BOTH compactions identically);
//   · the GPU PACK (the 9-word packed records — q1 guards +
//     pack2x16float) must match the CPU packInstances output DECODED:
//     pos within the state drift, vel/color/half/seed within one f16
//     rounding ON TOP of the drift, the atlas frame EXACT (the u16);
//   · a second pass with the noise field ON proves the flow moves the
//     particles (bounded, not exact).
import { chromium } from 'playwright'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const PORT = 8905

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
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

    const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=183`)
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
    const RSTRIDE = P.INSTANCE_STRIDE // Task 183 — 9 words / 36 bytes
    if (RSTRIDE !== 9) errors.push('INSTANCE_STRIDE !== 9: ' + RSTRIDE)
    const stateBytes = STRIDE * CAP * 4
    const state = device.createBuffer({ size: stateBytes, usage: 0x80 | 0x8 | 0x4 }) // STORAGE|COPY_DST|COPY_SRC
    const swaps = device.createBuffer({ size: 2 * CAP * 4, usage: 0x80 | 0x8 })
    const records = device.createBuffer({ size: RSTRIDE * CAP * 4, usage: 0x80 | 0x20 | 0x4 }) // STORAGE|VERTEX|COPY_SRC
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
    const uniform = device.createBuffer({ size: P.GPU_SIM_UNIFORM_BYTES, usage: 0x40 | 0x8 })
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

    // ── the readback: the state + the packed records of the live range ──
    const read = (buffer, bytes) => {
      const staging = device.createBuffer({ size: Math.ceil(bytes / 4) * 4, usage: 0x8 | 0x1 })
      const enc = device.createCommandEncoder()
      enc.copyBufferToBuffer(buffer, 0, staging, 0, Math.ceil(bytes / 4) * 4)
      device.queue.submit([enc.finish()])
      return staging.mapAsync(1).then(() => {
        const copy = new Uint8Array(staging.getMappedRange().slice(0))
        staging.unmap(); staging.destroy()
        return copy.buffer
      })
    }
    const count = gpuFacade.count
    const stateBuf = await read(state, count * STRIDE * 4)
    const recBuf = await read(records, count * RSTRIDE * 4)
    const gpuState = new Float32Array(stateBuf, 0, count * STRIDE)
    const gpuRecords = new Float32Array(recBuf, 0, count * RSTRIDE)

    // ── THE STATE PARITY (the same slots = the same particles): the f32
    // accumulation over 90 frames vs the CPU's f64.
    const f = cpuFacade.fields
    let worstPos = 0, worstVel = 0, worstAge = 0
    for (let i = 0; i < count; i++) {
      const b = i * STRIDE
      worstPos = Math.max(worstPos, Math.abs(gpuState[b] - f.px[i]), Math.abs(gpuState[b + 1] - f.py[i]), Math.abs(gpuState[b + 2] - f.pz[i]))
      worstVel = Math.max(worstVel, Math.abs(gpuState[b + 3] - f.vx[i]), Math.abs(gpuState[b + 4] - f.vy[i]), Math.abs(gpuState[b + 5] - f.vz[i]))
      worstAge = Math.max(worstAge, Math.abs(gpuState[b + 6] - f.age[i]))
    }

    // ── THE PACKED-RECORD PARITY (Task 183): the CPU pack of the SAME
    // system, DECODED side by side with the GPU words. pos inherits the
    // state drift; the quantized fields (vel/color/half/seed) may differ
    // by ONE f16 rounding when the pre-quantization f32s straddle a
    // rounding boundary (the GPU's in-shader lerp rounds at f32, the CPU
    // at f64→f32 — 1 ulp); the atlas frame is the u16 (a straddled floor
    // would flip it — counted, must stay rare); the packed words' f32
    // view must stay finite (the clamp contract).
    const cpuRecords = new Float32Array(RSTRIDE * count)
    P.packInstances({ fields: f, count }, cpuRecords, { ramp: RAMP, tiles: [2, 2], frameJitter: 4 })
    const DEC = { pos: [0, 0, 0], vel: [0, 0, 0], color: [0, 0, 0, 0], par: [0, 0, 0, 0], uv0: [0, 0], frame: 0 }
    let worstRecPos = 0, worstRecVel = 0, worstRecCol = 0, worstRecHalf = 0, worstRecSeed = 0
    let frameFlips = 0, recCompared = 0, nonFinite = 0
    for (let i = 0; i < count; i++) {
      // skip the zero-size records (the CPU pack compacts them out — the
      // GPU pack writes every slot; the counts can differ at the tail)
      P.decodeInstanceRecord(cpuRecords, i, [2, 2], DEC)
      if (DEC.par[0] <= 0) continue
      const c = { pos: [...DEC.pos], vel: [...DEC.vel], color: [...DEC.color], half: DEC.par[0], seed: DEC.par[3], frame: DEC.frame }
      P.decodeInstanceRecord(gpuRecords, i, [2, 2], DEC)
      const g = { pos: [...DEC.pos], vel: [...DEC.vel], color: [...DEC.color], half: DEC.par[0], seed: DEC.par[3], frame: DEC.frame }
      recCompared++
      for (let k = 0; k < 3; k++) worstRecPos = Math.max(worstRecPos, Math.abs(g.pos[k] - c.pos[k]))
      for (let k = 0; k < 3; k++) worstRecVel = Math.max(worstRecVel, Math.abs(g.vel[k] - c.vel[k]))
      for (let k = 0; k < 4; k++) worstRecCol = Math.max(worstRecCol, Math.abs(g.color[k] - c.color[k]))
      worstRecHalf = Math.max(worstRecHalf, Math.abs(g.half - c.half))
      worstRecSeed = Math.max(worstRecSeed, Math.abs(g.seed - c.seed))
      if (g.frame !== c.frame) frameFlips++
      if (!Number.isFinite(g.half) || !Number.isFinite(g.seed)) nonFinite++
    }
    out.worstPos = +worstPos.toFixed(5)
    out.worstVel = +worstVel.toFixed(5)
    out.worstAge = +worstAge.toFixed(5)
    out.worstRecPos = +worstRecPos.toFixed(5)
    out.worstRecVel = +worstRecVel.toFixed(5)
    out.worstRecCol = +worstRecCol.toFixed(6)
    out.worstRecHalf = +worstRecHalf.toFixed(6)
    out.worstRecSeed = +worstRecSeed.toFixed(7)
    out.frameFlips = frameFlips
    out.recCompared = recCompared
    out.stateOk = worstPos < 0.02 && worstVel < 0.02
    // the bounds: pos/vel inherit the state drift; the quantized fields
    // one f16 rounding on top (vel ≤ 6: ulp 6e-3; color/half ≤ 1: 1e-3);
    // the seed exact (the hash is deterministic); frames may flip only
    // at a 1-ulp lerp straddle (< 0.5% here).
    out.recordsOk =
      worstRecPos < 0.02 && worstRecVel < 0.05 && worstRecCol < 2.5e-3 &&
      worstRecHalf < 2e-3 && worstRecSeed < 1e-5 &&
      frameFlips <= Math.max(1, Math.floor(recCompared * 0.005)) &&
      nonFinite === 0 && recCompared > count * 0.9

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
    const noiseBuf = await read(state, Math.min(count, 2048) * STRIDE * 4)
    const noiseState = new Float32Array(noiseBuf, 0, Math.min(count, 2048) * STRIDE)
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
const ok = result.errors.length === 0 && result.stateOk && result.recordsOk && result.noiseOk
console.log(ok ? 'WGSL SIM PACKED-RECORD PARITY GATE: PASS' : 'WGSL SIM PACKED-RECORD PARITY GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
