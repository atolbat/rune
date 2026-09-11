// Task 178 — THE UPLOAD WIRE, bench first: the WebGPU feed's per-frame
// upload traffic. The shipped shape re-uploads the FULL PREFIX every frame
// ([0, published·stride) — one writeBuffer growing with the total record
// count); the GL twin already ships the dirty window ([synced, published)).
// Two legs, same SAB feed, same mock facade (the mock's syncVertexBuffer
// replicates realGPU's guardedWriteVertex SAB branch verbatim — the staging
// memcpy + the writeBuffer call are the mechanism under test):
//   LEGACY — the full-prefix shape (the pre-178 call, replicated inline);
//   DIRTY  — the windowed shape (offset + length, the 3-arg call).
import { createRendererFeedGPU } from '../src/rendererFeed.ts'
import type { GPUFacade } from '@rune/webgpu'

/** The mock GPU: the SAB branch of realGPU.guardedWriteVertex, verbatim
 *  (the staging copy + the queue op), with byte/call accounting. */
function makeMockGpu() {
  const sabStaging = new WeakMap<Float32Array, Uint8Array>()
  let bytesStaged = 0 // memcpy bytes (JS side)
  let bytesQueued = 0 // writeBuffer bytes (queue side)
  let calls = 0
  const gpu = {
    syncVertexBuffer(data: Float32Array, byteLength: number, byteOffset = 0): void {
      calls++
      const capped = Math.min(byteLength, data.byteLength - byteOffset)
      if (capped <= 0) return
      const isSabView = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer
      if (isSabView) {
        let staging = sabStaging.get(data)
        if (staging === undefined || staging.byteLength < capped) {
          staging = new Uint8Array(new ArrayBuffer(capped))
          sabStaging.set(data, staging)
        }
        // the verbatim copy shape: full-window source view → staging
        const src = byteOffset === 0 && capped === data.byteLength
          ? new Uint8Array(data.buffer, data.byteOffset, capped)
          : new Uint8Array(data.buffer, data.byteOffset + byteOffset, capped)
        staging.set(src)
        bytesStaged += capped
        bytesQueued += capped
        return
      }
      bytesQueued += capped
    },
  } as unknown as GPUFacade
  return { gpu, stats: () => ({ bytesStaged, bytesQueued, calls }) }
}

const CAPACITY = 160_000
const APPEND_PER_FRAME = 1_000 // a busy emitter's per-frame newborn window
const FRAMES = 60

/** The LEGACY shape: the pre-178 sync — the full prefix [0, published). */
function legacySync(view: { count: () => number; bytes: () => Float32Array }, synced: { value: number }, stride: number, gpu: GPUFacade): void {
  const published = Math.min(view.count(), CAPACITY)
  if (published > synced.value) {
    gpu.syncVertexBuffer(view.bytes(), published * stride)
    synced.value = published
  }
}

function run(label: string, legacy: boolean): void {
  // A SAB-backed core feed (T1/T2 transport) — the hot path's own memory.
  const sab = new SharedArrayBuffer(64 + CAPACITY * 64)
  const u32 = new Uint32Array(sab)
  const bytes = new Float32Array(sab, 64, (CAPACITY * 64) / 4)
  const view = { feedId: 1, stride: 64, capacity: CAPACITY, count: () => Atomics.load(u32, 1), bytes: () => bytes, recycle: () => {} }
  const { gpu, stats } = makeMockGpu()
  // The real renderer feed over the transport view (the production wiring —
  // the external-view world: the worker writes the SAB and publishes the
  // atomic counter; the render world only sync()s).
  const feed = createRendererFeedGPU(gpu, view as never)
  const synced = { value: 0 } // the legacy leg's own cursor

  let published = 0
  const t0 = performance.now()
  for (let frame = 0; frame < FRAMES; frame++) {
    // the worker's frame: APPEND_PER_FRAME records, publish
    for (let r = 0; r < APPEND_PER_FRAME; r++) {
      const at = (published + r) * 16
      for (let f = 0; f < 16; f++) bytes[at + f] = f + frame
    }
    published += APPEND_PER_FRAME
    Atomics.store(u32, 1, published)
    if (legacy) legacySync(view, synced, 64, gpu)
    else feed.sync()
  }
  const ms = (performance.now() - t0) / FRAMES
  const s = stats()
  console.log(`  ${label.padEnd(7)} sync wall: ${ms.toFixed(4)} ms/frame | staged ${s.bytesStaged / 1e6 | 0} MB | queued ${s.bytesQueued / 1e6 | 0} MB | ${s.calls} writeBuffer calls | ${((s.bytesQueued / 1e6) / FRAMES).toFixed(2)} MB/frame queued`)
}

console.log(`── Task 178: the WG feed upload wire (${CAPACITY / 1000}k capacity, +${APPEND_PER_FRAME}/frame, ${FRAMES} frames, SAB) ──`)
for (let warm = 0; warm < 3; warm++) { run('legacy', true); run('dirty', false) }
run('legacy', true)
run('dirty', false)
console.log('conclusion: the dirty window turns the per-frame upload from O(total records) into O(this frame\'s append)')
