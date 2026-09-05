// task134-wgsl-sort — THE RAW-DEVICE SORT/CULL GATE: a plain WebGPU device
// (no canvas — the documented env limitation), the REAL sort family WGSL
// (@rune/particles gpuSortWgsl) compiled and dispatched by hand over the
// shifted five-binding layout (1 = the pairs (rw), 2 = the state (ro),
// 3 = the records (rw), 4 = the ramp (ro)). Eight synthetic particles at
// mixed depths along the look axis, two of them outside the frustum:
//   · sortKeys + the canonical (k, j) bitonic sequence + the sorted pack;
//   · the READBACK records must land far-to-near (the −depth ascending
//     order), the two culled slots packing the ZERO record at the tail.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8904
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

    const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=134`)
    const CAP = 8
    const STRIDE = P.GPU_STATE_STRIDE

    // ── the synthetic world: the camera at (0, 0, 10) looking −Z; the
    //    slots at MIXED depths (z: 7,0,6,1,5,2,4,3), slots 2 and 5 pushed
    //    off-screen (x = ±1000 — outside the side planes, culled).
    const Z = [7, 0, 6, 1, 5, 2, 4, 3]
    const PX = [0, 0, 1000, 0, 0, -1000, 0, 0]
    const state = device.createBuffer({ size: STRIDE * CAP * 4, usage: 0x80 | 0x8 | 0x4 })
    const stateF = new Float32Array(STRIDE * CAP)
    for (let i = 0; i < CAP; i++) {
      const b = i * STRIDE
      stateF[b] = PX[i]; stateF[b + 1] = 0; stateF[b + 2] = Z[i]   // px, py, pz
      stateF[b + 3] = 0; stateF[b + 4] = 0; stateF[b + 5] = 0       // vx, vy, vz
      stateF[b + 6] = 0.5; stateF[b + 7] = 2                        // age, life (t = 0.25)
      stateF[b + 8] = 1                                             // size (half = 1·1·0.5)
      stateF[b + 9] = 1; stateF[b + 10] = 1; stateF[b + 11] = 1; stateF[b + 12] = 1
      stateF[b + 13] = i / 8                                        // seed
      stateF[b + 14] = 0; stateF[b + 15] = 0; stateF[b + 16] = 0    // tx, ty, tz
    }
    device.queue.writeBuffer(state, 0, stateF)

    // ── the buffers: the pairs, the records, the ramp LUT ──
    const padN = P.gpuSortPadCount(CAP)
    const pairs = device.createBuffer({ size: padN * 8, usage: 0x80 })
    const records = device.createBuffer({ size: 16 * CAP * 4, usage: 0x80 | 0x20 | 0x4 })
    const lut = P.gpuRampLUT([{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }])
    const ramp = device.createBuffer({ size: lut.byteLength, usage: 0x80 | 0x8 })
    device.queue.writeBuffer(ramp, 0, lut)

    // ── the sort family module + the SHIFTED layout ──
    const module = device.createShaderModule({ code: P.gpuSortWgsl() })
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
    const uniform = device.createBuffer({ size: 160, usage: 0x40 | 0x8 })
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: pairs } },     // the pairs (rw)
        { binding: 2, resource: { buffer: state } },     // the state (ro)
        { binding: 3, resource: { buffer: records } },   // the records (rw)
        { binding: 4, resource: { buffer: ramp } },      // the ramp (ro)
      ],
    })
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const mkPipe = entry => device.createComputePipeline({ layout: pipeLayout, compute: { module, entryPoint: entry } })
    const pipeKeys = mkPipe('sortKeys')
    const pipeBitonic = mkPipe('bitonic')
    const pipeStep = mkPipe('sortStep')
    const pipePack = mkPipe('pack')

    // ── the uniform: count/padN/cull, the forward, the six planes (the
    //    same camera as the unit test — perspective(60°) × translate(−10)).
    //    PASS-INVARIANT: the network's (k, j) rides the records head (the
    //    self-driving form — one writeBuffer, one encoder, one submit).
    const uniBuf = new ArrayBuffer(144)
    const uni = new Float32Array(uniBuf)
    const u32 = new Uint32Array(uniBuf)
    const S = P.GPU_SORT_U32_FIELDS
    const F = P.GPU_SORT_F32_FIELDS
    u32[S.count] = CAP
    u32[S.padN] = padN
    u32[S.renderMask] = 1 // the cull gate ON
    uni[F.forward] = 0; uni[F.forward + 1] = 0; uni[F.forward + 2] = -1 // looking −Z
    const persp = [Math.tan(Math.PI / 6), 0, 0, 0, 0, Math.tan(Math.PI / 6), 0, 0, 0, 0, (100 + 1) / (1 - 100), -1, 0, 0, (2 * 100 * 1) / (1 - 100), 0]
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]
    const vp = new Array(16).fill(0)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += persp[k * 4 + r] * view[c * 4 + k]
      vp[c * 4 + r] = s
    }
    uni.set(P.gpuRenderFrustum(vp), F.planes)
    uni[F.tileU] = 1; uni[F.tileV] = 1; uni[F.frameJitter] = 0; uni[F.rampMaxSize] = 1

    device.queue.writeBuffer(uniform, 0, uniBuf)
    const enc = device.createCommandEncoder()
    const wg = Math.ceil(padN / 64)
    const cp0 = enc.beginComputePass()
    cp0.setPipeline(pipeKeys); cp0.setBindGroup(0, group); cp0.dispatchWorkgroups(wg); cp0.end()
    // the network: [bitonic, sortStep] × the canonical pass count — the
    // (k, j) seeded by sortKeys into records[0..1], advanced by sortStep
    let passes = 0
    P.gpuSortPassSequence(padN, () => { passes++ })
    for (let p = 0; p < passes; p++) {
      const cp = enc.beginComputePass()
      cp.setPipeline(pipeBitonic); cp.setBindGroup(0, group); cp.dispatchWorkgroups(wg); cp.end()
      const cs = enc.beginComputePass()
      cs.setPipeline(pipeStep); cs.setBindGroup(0, group); cs.dispatchWorkgroups(1); cs.end()
    }
    const cp2 = enc.beginComputePass()
    cp2.setPipeline(pipePack); cp2.setBindGroup(0, group); cp2.dispatchWorkgroups(Math.ceil(CAP / 64)); cp2.end()
    device.queue.submit([enc.finish()])
    await device.queue.onSubmittedWorkDone()

    // ── the readback: the 8 records ──
    const staging = device.createBuffer({ size: 512, usage: 0x8 | 0x1 })
    const enc2 = device.createCommandEncoder()
    enc2.copyBufferToBuffer(records, 0, staging, 0, 512)
    device.queue.submit([enc2.finish()])
    const mapped = await staging.mapAsync(1)
    const recs = new Float32Array(staging.getMappedRange().slice(0))
    staging.unmap(); staging.destroy()

    // ── THE VERDICT: the visible prefix far-to-near (the z ASCENDING — the
    //    camera at +10 looking −Z: the smaller z, the farther), the two
    //    CULLED slots (2 and 5 — off-screen) the ZERO record at the tail.
    const order = []
    for (let i = 0; i < CAP; i++) {
      const r = i * 16
      const isZero = recs[r] === 0 && recs[r + 1] === 0 && recs[r + 2] === 0 && recs[r + 10] === 0
      order.push(isZero ? 'ZERO' : `z=${recs[r + 2].toFixed(3)}@x=${recs[r].toFixed(0)}`)
    }
    out.order = order
    // slots 2, 5 culled → the last TWO records zero; the visible z's:
    // [0, 1, 3, 4, 5, 7] (far-to-near), all at x=0
    const expectedZ = [0, 1, 3, 4, 5, 7]
    let sortedOk = true
    for (let i = 0; i < 6; i++) {
      if (Math.abs(recs[i * 16 + 2] - expectedZ[i]) > 1e-4 || Math.abs(recs[i * 16]) > 1e-4) sortedOk = false
    }
    let zerosOk = true
    for (let i = 6; i < 8; i++) for (let k = 0; k < 16; k++) if (recs[i * 16 + k] !== 0) zerosOk = false
    // the visible half extent = size 1 × ramp 1 × 0.5
    out.half = recs[10]
    out.sortedOk = sortedOk
    out.zerosOk = zerosOk
    out.halfOk = Math.abs(recs[10] - 0.5) < 1e-5
  } catch (e) {
    errors.push('exception: ' + String(e?.message ?? e).slice(0, 250))
  }
  return out
}, PORT).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))
const ok = result.errors.length === 0 && result.sortedOk === true && result.zerosOk === true && result.halfOk === true
console.log(ok ? 'GPU SORT/CULL GATE: PASS' : 'GPU SORT/CULL GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
