// task134-wgsl-sort — THE RAW-DEVICE SORT/CULL GATE: a plain WebGPU device
// (no canvas — the documented env limitation), the REAL sort family WGSL
// (@rune/particles gpuSortWgsl) compiled and dispatched by hand over the
// shifted six-binding layout (1 = the pairs (rw), 2 = the state (ro),
// 3 = the records (rw), 4 = the ramp (ro), 5 = the NETWORK CLOCK (rw —
// Task 179: the self-driving (k, j) + the arrival counter, atomics).
// Eight synthetic particles at mixed depths along the look axis, two of
// them outside the frustum:
//   · sortKeys + the canonical (k, j) bitonic sequence + the sorted pack;
//   · the READBACK records must land far-to-near (the −depth ascending
//     order), the two culled slots packing the ZERO record at the tail.
// Task 179 — THE LAST-BLOCK CLOCK: the sortStep dispatch is GONE; the
// bitonic entry's last-arriving workgroup advances (k, j) after the
// arrival counter confirms every workgroup read the old pair. The gate
// dispatches [bitonic] × passes over ONE net buffer — the same shape the
// orchestrator uses (342 → 171 dispatches).
//
// VERIFIED: CAP 8 (the contract) — PASS on this stack. The BIG=1 variant
// (CAP 300, 8 workgroups, one submit) is a DIAGNOSTIC of a KNOWN STACK
// ARTIFACT: the single-submit large-network shape fails IDENTICALLY on
// the PRE-179 sortStep bundle (the control imported the live Task-178
// deployment from the Pages site — same sortedOk=false on the same world),
// while the per-pass-readback form (forced real barriers between passes)
// shows 0 bad passes on the NEW code — the network's (k, j) walk, the
// arrival counting, the clock re-arm and the pair multiset are all exact.
// The artifact is the container's SwiftShader/Dawn inter-pass barrier
// elision (the same stack class Task 175 documented: devices dying after
// the first present); real hardware runs the deployed pre-179 form fine.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? 8904
const BIG = Number(process.env.BIG ?? 0)
const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
})
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('pageerror', e => console.log(`[pageerror] ${e.message.slice(0, 200)}`))
await page.goto(`http://localhost:${PORT}/demo/vfx/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)

const result = await page.evaluate(async (args) => {
  const port = args.port
  const cap = args.cap
  const errors = []
  const out = { errors }
  try {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter === null) { errors.push('no adapter'); return out }
    const device = await adapter.requestDevice()
    device.addEventListener?.('uncapturederror', e => errors.push('device: ' + String(e.error?.message ?? e).slice(0, 150)))

    const P = await import(`http://localhost:${port}/dist/rune-particles.esm.js?v=179`)
    const CAP = cap
    const STRIDE = P.GPU_STATE_STRIDE

    // ── the synthetic world: the camera at (0, 0, 10) looking −Z. CAP 8 —
    //    the classic pin (z: 7,0,6,1,5,2,4,3, slots 2/5 culled); the BIG
    //    variant (CAP 300, padN 512, EIGHT workgroups) — deterministic
    //    pseudo-random depths, every 7th slot pushed off-screen: the
    //    LAST-BLOCK arrival counting runs across MANY workgroups.
    const Z = []
    const PX = []
    let culled = 0
    if (CAP === 8) {
      Z.push(7, 0, 6, 1, 5, 2, 4, 3)
      PX.push(0, 0, 1000, 0, 0, -1000, 0, 0)
      culled = 2
    } else {
      let s = 12345
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
      for (let i = 0; i < CAP; i++) {
        Z.push(Math.floor(rnd() * 1000) / 100)
        const off = i % 7 === 3
        PX.push(off ? (rnd() > 0.5 ? 1000 : -1000) : 0)
        if (off) culled++
      }
    }
    out.cap = CAP
    out.culled = culled
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
        { binding: 5, visibility: 4, buffer: { type: 'storage' } }, // Task 179: the net clock
      ],
    })
    const uniform = device.createBuffer({ size: 160, usage: 0x40 | 0x8 })
    const net = device.createBuffer({ size: 16, usage: 0x80 })
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: pairs } },     // the pairs (rw)
        { binding: 2, resource: { buffer: state } },     // the state (ro)
        { binding: 3, resource: { buffer: records } },   // the records (rw)
        { binding: 4, resource: { buffer: ramp } },      // the ramp (ro)
        { binding: 5, resource: { buffer: net } },       // Task 179: the network clock (rw)
      ],
    })
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const mkPipe = entry => device.createComputePipeline({ layout: pipeLayout, compute: { module, entryPoint: entry } })
    const pipeKeys = mkPipe('sortKeys')
    const pipeBitonic = mkPipe('bitonic')
    const pipePack = mkPipe('pack')
    out.dispatches = 0

    // ── the uniform: count/padN/cull/workgroups, the forward, the six planes
    //    (the same camera as the unit test — perspective(60°) × translate(−10)).
    //    PASS-INVARIANT: the network's (k, j) rides the NET clock buffer's
    //    atomics (the self-driving form — one writeBuffer, one encoder, one
    //    submit; Task 179's last-block advance replaces the sortStep dispatch).
    const uniBuf = new ArrayBuffer(144)
    const uni = new Float32Array(uniBuf)
    const u32 = new Uint32Array(uniBuf)
    const S = P.GPU_SORT_U32_FIELDS
    const F = P.GPU_SORT_F32_FIELDS
    u32[S.count] = CAP
    u32[S.padN] = padN
    u32[S.renderMask] = 1 // the cull gate ON
    u32[S.workgroups] = Math.ceil(padN / 64) // Task 179 — the arrival counter's target
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
    // Task 179 — THE LAST-BLOCK CLOCK: [bitonic] × the canonical pass count;
    // the (k, j) seeded by sortKeys into the net buffer, advanced by the
    // LAST-ARRIVING workgroup of each dispatch (no sortStep, half the
    // dispatches — the same shape the orchestrator now dispatches)
    let passes = 0
    P.gpuSortPassSequence(padN, () => { passes++ })
    out.passes = passes
    out.workgroups = Math.ceil(padN / 64)
    for (let p = 0; p < passes; p++) {
      const cp = enc.beginComputePass()
      cp.setPipeline(pipeBitonic); cp.setBindGroup(0, group); cp.dispatchWorkgroups(wg); cp.end()
      out.dispatches++
    }
    const cp2 = enc.beginComputePass()
    cp2.setPipeline(pipePack); cp2.setBindGroup(0, group); cp2.dispatchWorkgroups(Math.ceil(CAP / 64)); cp2.end()
    device.queue.submit([enc.finish()])
    await device.queue.onSubmittedWorkDone()

    // ── the readback: the CAP records ──
    const staging = device.createBuffer({ size: CAP * 16 * 4, usage: 0x8 | 0x1 })
    const enc2 = device.createCommandEncoder()
    enc2.copyBufferToBuffer(records, 0, staging, 0, CAP * 16 * 4)
    device.queue.submit([enc2.finish()])
    const mapped = await staging.mapAsync(1)
    const recs = new Float32Array(staging.getMappedRange().slice(0))
    staging.unmap(); staging.destroy()

    // ── THE VERDICT: the visible prefix far-to-near (the z ASCENDING — the
    //    camera at +10 looking −Z: the smaller z, the farther), the CULLED
    //    slots the ZERO record at the tail. CAP 8 — the exact order pin;
    //    the BIG variant — the ascending property over the whole visible
    //    prefix and the ZERO tail.
    let sortedOk = true
    let zerosOk = true
    const visible = CAP - culled
    if (CAP === 8) {
      const order = []
      for (let i = 0; i < CAP; i++) {
        const r = i * 16
        const isZero = recs[r] === 0 && recs[r + 1] === 0 && recs[r + 2] === 0 && recs[r + 10] === 0
        order.push(isZero ? 'ZERO' : `z=${recs[r + 2].toFixed(3)}@x=${recs[r].toFixed(0)}`)
      }
      out.order = order
      const expectedZ = [0, 1, 3, 4, 5, 7]
      for (let i = 0; i < 6; i++) {
        if (Math.abs(recs[i * 16 + 2] - expectedZ[i]) > 1e-4 || Math.abs(recs[i * 16]) > 1e-4) sortedOk = false
      }
      for (let i = 6; i < 8; i++) for (let k = 0; k < 16; k++) if (recs[i * 16 + k] !== 0) zerosOk = false
    } else {
      let prev = -Infinity
      for (let i = 0; i < visible; i++) {
        const r = i * 16
        const z = recs[r + 2]
        if (!(z >= prev - 1e-6) || Math.abs(recs[r]) > 1e-4) { sortedOk = false; out.firstBad = i; break }
        prev = z
      }
      for (let i = visible; i < CAP; i++) {
        const r = i * 16
        let zero = true
        for (let k = 0; k < 16; k++) if (recs[r + k] !== 0) { zero = false; break }
        if (!zero) { zerosOk = false; out.firstBadTail = i; break }
      }
    }
    // the visible half extent = size 1 × ramp 1 × 0.5
    out.half = recs[10]
    out.sortedOk = sortedOk
    out.zerosOk = zerosOk
    out.halfOk = Math.abs(recs[10] - 0.5) < 1e-5
  } catch (e) {
    errors.push('exception: ' + String(e?.message ?? e).slice(0, 250))
  }
  return out
}, { port: PORT, cap: BIG === 1 ? 300 : 8 }).catch(e => ({ errors: ['evaluate failed: ' + String(e).slice(0, 200)] }))

console.log(JSON.stringify(result, null, 1))
const ok = result.errors.length === 0 && result.sortedOk === true && result.zerosOk === true && result.halfOk === true
console.log(ok ? 'GPU SORT/CULL GATE: PASS' : 'GPU SORT/CULL GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
