// Task 185 — THE SAB DIRECT-WRITE LADDER (the device-level mock): the WG
// facade's SAB-backed view uploads. queue.writeBuffer ACCEPTS SAB-backed
// views on Chrome/Dawn (verified empirically: no throw, no validation
// error, the bytes land) — the "WebGPU forbids shared memory in
// writeBuffer" belief behind the Task-164 staging copy was wrong. The
// facade now probes ONCE and writes DIRECT (zero-copy, the element form);
// staging survives as the fallback for probe-pending frames and rejecting
// browsers — never a lost write.
//
// The pins (guardedWriteVertex via syncVertexBuffer, writeExternalBuffer):
//  1. THE LADDER: the first SAB upload stages (the async probe is pending),
//     the popErrorScope resolves null, every upload after writes DIRECT —
//     the recorded writeBuffer call carries the SAB-backed Float32Array
//     ITSELF in the element form (data, dataOffset, size);
//  2. the bytes land exactly (the mock device materializes both forms);
//  3. a THROWING writeBuffer (a browser that rejects SAB views) — the probe
//     settles false, every upload stages, nothing escapes, the bytes land;
//  4. a SILENT validation error (popErrorScope resolves an error) — the
//     probe settles false, staging resumes;
//  5. writeExternalBuffer: the SAB view goes DIRECT in the element form
//     (the pre-185 ArrayBuffer form dropped the write on the floor — a
//     TypeError caught and reported, the data lost); a rejecting browser
//     stages and the bytes still land.
import { afterEach, describe, expect, it } from 'bun:test'
import { createRealGPU } from '../src/realGPU.ts'
import type { GPUFacade } from '../src/facade.ts'

// ────────────────── the mock device (unfilterableBind's own shape) ──────────────────

interface WriteCall {
  target: { size: number; store: Uint8Array }
  offset: number
  data: unknown
  dataOffset?: number
  size?: number
  /** whether `data` (or its .buffer) is SAB-backed — the direct-write marker. */
  sab: boolean
}

interface MockOptions {
  /** writeBuffer throws a TypeError on SAB-backed data (a rejecting browser). */
  rejectSab?: boolean
  /** popErrorScope resolves an error object (a silent validation failure). */
  errorScopeMessage?: string | null
}

function installMockGpu(options: MockOptions = {}): {
  facade: GPUFacade
  calls: WriteCall[]
  errors: string[]
  cleanup: () => void
  flushProbe: () => Promise<void>
} {
  const calls: WriteCall[] = []
  const errors: string[] = []
  let nextId = 1
  const id = (): number => nextId++

  const materialize = (call: WriteCall): void => {
    const data = call.data
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
      bytes = new Uint8Array(data, call.dataOffset ?? 0, call.size ?? data.byteLength)
    } else {
      const view = data as Uint8Array | Float32Array
      const elSize = view.BYTES_PER_ELEMENT
      const from = (call.dataOffset ?? 0) * elSize
      const len = call.size !== undefined ? call.size * elSize : view.byteLength
      bytes = new Uint8Array(view.buffer, view.byteOffset + from, len)
    }
    const dst = Math.min(bytes.byteLength, call.target.size - call.offset)
    call.target.store.set(bytes.subarray(0, Math.max(0, dst)), call.offset)
  }

  const queue = {
    writeBuffer(target: { size: number; store: Uint8Array }, offset: number, data: unknown, dataOffset?: number, size?: number): void {
      // SAB-backed = the raw SharedArrayBuffer form OR a typed-array view
      // whose .buffer is a SAB (the staging copies are plain ArrayBuffers).
      const isSabBacked = data instanceof SharedArrayBuffer
        || (typeof data === 'object' && data !== null && 'buffer' in (data as object)
          && (data as { buffer?: unknown }).buffer instanceof SharedArrayBuffer)
      if (options.rejectSab === true && isSabBacked) {
        throw new TypeError('writeBuffer: SharedArrayBuffer-backed views are not allowed')
      }
      const call: WriteCall = { target, offset, data, dataOffset, size, sab: isSabBacked }
      calls.push(call)
      materialize(call)
    },
    writeTexture: () => {},
    copyExternalImageToTexture: () => {},
    submit: () => {},
  }

  const device = {
    features: new Set<string>(),
    limits: {},
    queue,
    createBuffer(desc: { size: number; usage: number }) {
      return { size: desc.size, usage: desc.usage, store: new Uint8Array(desc.size), destroy: () => {}, id: id() }
    },
    createCommandEncoder() { return { finish: () => ({}), copyBufferToBuffer: () => {} } },
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(options.errorScopeMessage === undefined ? null : { message: options.errorScopeMessage }),
    addEventListener: () => {},
    destroy: () => {},
    lost: Promise.resolve({ reason: 'unknown' }),
  }
  const adapter = {
    features: new Set<string>(),
    limits: {},
    requestDevice: async () => device,
  }
  const gpuMock = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
  const canvas = {
    width: 8,
    height: 8,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({ canvasViewId: id() }) }) }
        : null,
  }
  const nav = navigator as unknown as { gpu?: unknown }
  const prevGpu = nav.gpu
  ;(navigator as unknown as { gpu: unknown }).gpu = gpuMock
  const g = globalThis as Record<string, unknown>
  const prevGlobals = {
    GPUBufferUsage: g.GPUBufferUsage,
    GPUMapMode: g.GPUMapMode,
  }
  // The REAL spec values (GPUBufferUsage): the live gate's own lesson — a
  // made-up enum silently mislabels buffers (0x2 is MAP_WRITE, not COPY_SRC).
  g.GPUBufferUsage = {
    MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10,
    VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
  }
  g.GPUMapMode = { READ: 0x1, WRITE: 0x2 }
  return {
    calls,
    errors,
    cleanup: () => {
      ;(navigator as unknown as { gpu: unknown }).gpu = prevGpu
      for (const [k, v] of Object.entries(prevGlobals)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
    // the popErrorScope promise (probe → sabDirect) rides the microtask
    // queue; one macrotask hop flushes it (and any then-chains after it).
    flushProbe: async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

/** Installs the mock AND builds the facade (the shared shape of every test). */
async function buildFacade(options?: MockOptions): Promise<{
  facade: GPUFacade
  calls: WriteCall[]
  errors: string[]
  cleanup: () => void
  flushProbe: () => Promise<void>
}> {
  const harness = installMockGpu(options)
  const canvas = {
    width: 8,
    height: 8,
    getContext: (type: string) =>
      type === 'webgpu'
        ? { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}) }) }
        : null,
  }
  const facade = await createRealGPU(canvas as never, (message: string) => { harness.errors.push(message) })
  return { facade, calls: harness.calls, errors: harness.errors, cleanup: harness.cleanup, flushProbe: harness.flushProbe }
}

describe('Task 185: the SAB direct-write ladder (guardedWriteVertex / writeExternalBuffer)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  /** The real uploads (the probe's own 16-byte throwaway write excluded —
   * the only 16-byte buffer these tests ever create). */
  const uploads = (calls: WriteCall[]): WriteCall[] => calls.filter(c => c.target.size !== 16)

  it('the ladder: first SAB upload STAGES (probe pending), then writes DIRECT in the element form — and the bytes land', async () => {
    const { facade, calls, errors, cleanup, flushProbe } = await buildFacade()
    cleanups.push(cleanup)
    const sab = new SharedArrayBuffer(64 + 128 * 4)
    const view = new Float32Array(sab, 64, 128) // 128 floats = 512 bytes
    for (let i = 0; i < 64; i++) view[i] = i + 0.5
    // frame 1: the probe fires (its own 16-byte write) and the upload
    // STAGES — the async verdict is pending
    facade.syncVertexBuffer(view, 256, 0)
    const staged = uploads(calls)
    expect(staged.length).toBe(1)
    expect(staged[0]!.sab).toBe(false)
    expect(staged[0]!.data).toBeInstanceOf(Uint8Array)
    // the bytes landed despite the staging detour
    const store1 = staged[0]!.target.store
    const got1 = new Float32Array(store1.buffer, 0, 64)
    for (let i = 0; i < 64; i++) expect(got1[i]).toBe(i + 0.5)
    // the probe resolves (popErrorScope → null)…
    await flushProbe()
    // frame 2: the append window [256, 512) — DIRECT, zero-copy: the call
    // carries the SAB-backed Float32Array ITSELF, element form
    for (let i = 64; i < 128; i++) view[i] = i * 2
    facade.syncVertexBuffer(view, 256, 256)
    const all = uploads(calls)
    expect(all.length).toBe(2)
    const direct = all[1]!
    expect(direct.sab).toBe(true)
    expect(direct.data).toBe(view) // THE SAB VIEW — no copy in between
    expect(direct.dataOffset).toBe(64) // 256 bytes / 4 — in float elements
    expect(direct.size).toBe(64) // 256 bytes / 4
    expect(direct.offset).toBe(256)
    // the bytes landed through the direct form
    const got2 = new Float32Array(direct.target.store.buffer, 0, 128)
    for (let i = 64; i < 128; i++) expect(got2[i]).toBe(i * 2)
    expect(errors).toEqual([])
  })

  it('a THROWING writeBuffer (a rejecting browser): the probe settles false, every upload stages, nothing escapes', async () => {
    const { facade, calls, errors, cleanup, flushProbe } = await buildFacade({ rejectSab: true })
    cleanups.push(cleanup)
    const sab = new SharedArrayBuffer(256)
    const view = new Float32Array(sab)
    for (let i = 0; i < 64; i++) view[i] = 7 - i
    // frame 1: the PROBE write itself throws → sabDirect = false immediately;
    // the upload stages (the probe's throw is internal — one staged call)
    facade.syncVertexBuffer(view, 256, 0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.sab).toBe(false)
    // frames 2..3: staging forever, no throw escapes, bytes land
    facade.syncVertexBuffer(view, 256, 0)
    facade.syncVertexBuffer(view, 256, 0)
    expect(calls.length).toBe(3)
    for (const call of calls) expect(call.sab).toBe(false)
    const got = new Float32Array(calls[2]!.target.store.buffer, 0, 64)
    for (let i = 0; i < 64; i++) expect(got[i]).toBe(7 - i)
    // no onGpuError escaped either (the probe's rejection is an internal
    // verdict, not a user-facing failure)
    expect(errors).toEqual([])
    await flushProbe()
  })

  it('a SILENT validation error (popErrorScope resolves an error): the probe settles false, staging resumes', async () => {
    const { facade, calls, cleanup, flushProbe } = await buildFacade({ errorScopeMessage: 'writeBuffer: shared memory is not allowed' })
    cleanups.push(cleanup)
    const sab = new SharedArrayBuffer(256)
    const view = new Float32Array(sab)
    // frame 1: stages while the probe pends
    facade.syncVertexBuffer(view, 256, 0)
    expect(uploads(calls).length).toBe(1)
    expect(uploads(calls)[0]!.sab).toBe(false)
    await flushProbe()
    // the probe resolved an ERROR — staging forever (the write would have
    // been a silent no-op on the direct path)
    facade.syncVertexBuffer(view, 256, 0)
    const all = uploads(calls)
    expect(all.length).toBe(2)
    expect(all[1]!.sab).toBe(false)
    expect(all[1]!.data).toBeInstanceOf(Uint8Array)
  })

  it('writeExternalBuffer: the SAB view goes DIRECT (element form) — the pre-185 ArrayBuffer form LOST the write', async () => {
    const { facade, calls, errors, cleanup, flushProbe } = await buildFacade()
    cleanups.push(cleanup)
    // warm the probe first (a tiny feed upload stages while it resolves) —
    // the point under test is the STEADY state, not the first-ever frame
    const warm = new Float32Array(new SharedArrayBuffer(64 * 4))
    facade.syncVertexBuffer(warm, 256, 0)
    await flushProbe()
    calls.length = 0 // drop the warm-up — the external write is the subject
    const sab = new SharedArrayBuffer(64 * 4)
    const view = new Float32Array(sab)
    for (let i = 0; i < 64; i++) view[i] = i * 3
    const bufferId = facade.createExternalBuffer(256, 0x4 | 0x8 | 0x20) // COPY_SRC | COPY_DST | VERTEX (the real enum)
    facade.writeExternalBuffer(bufferId, view)
    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.sab).toBe(true)
    expect(call.data).toBe(view)
    expect(call.dataOffset).toBe(0) // the view from its start (the pre-185 contract)
    expect(call.size).toBe(64)
    expect(call.offset).toBe(0)
    const got = new Float32Array(call.target.store.buffer, 0, 64)
    for (let i = 0; i < 64; i++) expect(got[i]).toBe(i * 3)
    expect(errors).toEqual([])
  })

  it('writeExternalBuffer on a REJECTING browser: staging fallback lands the bytes (never a lost write)', async () => {
    const { facade, calls, errors, cleanup } = await buildFacade({ rejectSab: true })
    cleanups.push(cleanup)
    const sab = new SharedArrayBuffer(64 * 4)
    const view = new Float32Array(sab)
    for (let i = 0; i < 64; i++) view[i] = i + 100
    const bufferId = facade.createExternalBuffer(256, 0x2 | 0x8 | 0x20)
    facade.writeExternalBuffer(bufferId, view)
    expect(calls.length).toBe(1)
    expect(calls[0]!.sab).toBe(false) // staged
    const got = new Float32Array(calls[0]!.target.store.buffer, 0, 64)
    for (let i = 0; i < 64; i++) expect(got[i]).toBe(i + 100)
    expect(errors).toEqual([])
  })

  it('plain ArrayBuffer-backed feeds are untouched (the fast path, byte-identical forms)', async () => {
    const { facade, calls, cleanup } = await buildFacade()
    cleanups.push(cleanup)
    const view = new Float32Array(64)
    for (let i = 0; i < 64; i++) view[i] = i
    // full view at 0 — the whole-view form
    facade.syncVertexBuffer(view, 256, 0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.data).toBe(view)
    expect(calls[0]!.dataOffset).toBeUndefined()
    expect(calls[0]!.size).toBeUndefined()
    // an append window — the ArrayBuffer byte-offset form
    facade.syncVertexBuffer(view, 128, 128)
    expect(calls.length).toBe(2)
    expect(calls[2 - 1]!.data).toBe(view.buffer)
    expect(calls[1]!.dataOffset).toBe(128)
    expect(calls[1]!.size).toBe(128)
  })
})
