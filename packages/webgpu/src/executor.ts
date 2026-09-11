/**
 * Executor of WG tapes: slice uploads BEFORE the pass (ordered with submit —
 * the GPU does not read what the CPU writes), then the pass with dynamic offsets.
 * Frame order: uploadUniforms → beginPass → draw → endPass → submit.
 */

import type { TapeView } from '@rune/core'
import type { WgpuCommand } from './command.ts'
import type { WgpuCompileContext } from './command.ts'
import type { SliceArena } from './sliceArena.ts'
import type { GPUFacade } from './facade.ts'
import type { GpuPipelineDesc } from './pipeline/pipelineCache.ts'

export interface GpuExecutorOptions {
  readonly gpu: GPUFacade
  readonly arena: SliceArena
  readonly commands: readonly WgpuCommand[]
  readonly clears: ReadonlyArray<{ readonly color: readonly [number, number, number, number]; readonly depth: number | null }>
  /** Task 145: the compile context — activating it switches the upload pass
   *  from the legacy O(ops) tape walk to the O(dirty) pending-upload queue
   *  (the mark bus shared with writeUniforms). Absent — the legacy walk
   *  (backward compatible: every executor built before Task 145). */
  readonly context?: WgpuCompileContext
  /** Task 174 — THE MULTI-DRAW TIER (the WG dialect): two levels over the
   *  same run detection as the GL tier (Task 169):
   *  • THE FAST-PATH FLOOR (works on every browser): consecutive Draw ops
   *    of the SAME command run the prologue ONCE — every per-draw
   *    assertion below (usePipeline, bindUniforms, the attribute and
   *    texture binds) is a memo no-op for a same-command repeat, so
   *    members 2..N skip the JS call sequence entirely and issue bare
   *    pass.draw calls.
   *  • THE INDIRECT SHAPE (drawIndirectCount — capability-gated at the
   *    facade: the method exists IFF the device's pass encoder has it):
   *    a run of length ≥ 2 collapses into ONE drawIndirectCount call over
   *    ring buffers the facade owns. Chrome 151 (this container, probed)
   *    still lacks the spec method — the tier rides the floor there;
   *    browsers with the method get N→1.
   *  Runs of length 1 ride the classic path verbatim (the GL tier's
   *  discipline); degenerates (count 0 / instances 0) end runs; the cap
   *  is 512 members; multiDraw: false restores the per-draw classic path
   *  exactly. */
  readonly multiDraw?: boolean
}

export interface GpuTapeExecutor {
  run(view: TapeView): void
}

export function createGpuExecutor(options: GpuExecutorOptions): GpuTapeExecutor {
  const gpu = options.gpu
  const arena = options.arena
  const commands = options.commands
  // Task 145: the O(dirty) upload queue — activated by passing the compile
  // context; commands mark themselves onto it (writeUniforms false→true
  // transitions + born-dirty pushes at compile).
  const queue = options.context !== undefined ? options.context.activateUploadQueue() : null

  // ── Task 174 — THE MULTI-DRAW TIER (the WG dialect) ──
  // A RUN is a maximal sequence of consecutive Draw ops referencing the
  // SAME command with count > 0 and instances > 0 — the exact GL-tier
  // (Task 169) discipline, translated to the WG executor's shape. Within
  // a run every per-draw assertion of the prologue is a no-op by
  // construction: usePipeline/bindUniforms/attribute binds/texture binds
  // are the facade's memos (Task 164/165 — they skip re-asserts for the
  // same command), and the uniform slices are uploaded BEFORE the pass
  // opens (the Task-145 discipline: the record-then-execute tape means
  // all arena writes are final before run() starts). The multi shape
  // (drawIndirectCount present) keeps member 0 PENDING — flushRun emits
  // it (len 1 → classic verbatim, len ≥ 2 → one indirect call); the
  // fast-path floor draws every member directly (byte-identical call
  // stream to the classic path — the tier's floor can only SKIP memo
  // checks, never change a GPU call).
  // Degenerate members (count 0 / instances 0) END the run instead of
  // joining it (their classic behavior is pass.draw(count, 0) — a legal
  // no-op — kept verbatim). The run is flushed on: any non-Draw op (a
  // pending draw must not cross a pass/target boundary), a different
  // command, a degenerate, the 512 cap, the tape's end.
  const tierOn = options.multiDraw ?? true
  const multiFn = gpu.multiDraw // presence == capability (the facade's contract)
  const MAX_BATCH = 512
  const runArgs = new Uint32Array(MAX_BATCH * 4) // [vertexCount, instanceCount, firstVertex, firstInstance] × members
  let runCommand: RichWgpuCommand | undefined
  let runLen = 0

  function flushRun(): void {
    if (runLen === 0) { runCommand = undefined; return }
    if (runLen === 1 || multiFn === undefined) {
      // a lone member rides the classic path — the pre-174 call, verbatim
      // (the fast-path floor never keeps members pending — this is the
      // multi shape's run of one)
      gpu.draw(runArgs[0], runArgs[1])
    } else {
      const emitted = multiFn(runArgs, runLen)
      if (!emitted) {
        // the facade's ring is full — the classic expansion. The prologue
        // ran for the run (the memos hold); each member is a bare draw.
        for (let m = 0; m < runLen; m++) {
          const b = m * 4
          gpu.draw(runArgs[b], runArgs[b + 1])
        }
      }
    }
    runLen = 0
    runCommand = undefined
  }

  function run(view: TapeView): void {
    uploadDirtySlices(view)
    for (let at = 0; at < view.count; at++) {
      const op = view.op[at]
      if (op === 1) { flushRun(); beginPass() }
      else if (op === 2) drawCommand(commands[view.a[at]] as RichWgpuCommand, view.c[at], view.d[at])
      else if (op === 3) { flushRun(); gpu.endPass() }
      else if (op === 4) { flushRun(); gpu.bindTarget(view.a[at], view.b[at] === 1) }
    }
    flushRun() // the tape's end — no draw may leak past the frame
    gpu.submit()
  }

  /** First pass: dirty slices into the UBO before the pass opens.
   *  Task 145: with the queue attached — an O(dirty) drain in mark order
   *  (each command's slice is DISJOINT, so inter-command order cannot
   *  change what lands on the GPU; for well-formed frame flows mark order
   *  === tape order — pinned by the task145 parity test). Without the
   *  queue — the legacy O(ops) walk.
   *  Task 178 — THE MERGED UPLOAD: both drains collect the same dirty
   *  command list, SORT it by slice offset (mark order ≠ allocation
   *  order — and the sorted form makes the queue/legacy merge identical
   *  even for the divergent aborted-frame flows), then coalesce the
   *  disjoint 256-aligned slice windows into ONE writeBuffer per run of
   *  adjacent slices (gap < 256 — the SliceArena's own dirtyRanges rule;
   *  the bytes BETWEEN the slices ride along: the arena is the source of
   *  truth and the shader reads only its declared struct, so the extra
   *  bytes are inert). The binding window passed for a merged run is the
   *  MAX per-slice window — NOT ceil(merged length/256): the bind group's
   *  dynamic-offset range check needs only the largest single block, and
   *  a merged-length window would over-provision (a tail slice + window
   *  could exceed the buffer). A single dirty command rides the pre-178
   *  call verbatim (no window argument — the facade's own default). */
  function uploadDirtySlices(view: TapeView): void {
    const dirty: RichWgpuCommand[] = []
    if (queue !== null) {
      for (let at = 0; at < queue.length; at++) {
        const command = queue[at] as RichWgpuCommand | undefined
        if (command !== undefined && command.needsUpload) dirty.push(command)
      }
      queue.length = 0
    } else {
      for (let at = 0; at < view.count; at++) {
        if (view.op[at] !== 2) continue
        const command = commands[view.a[at]] as RichWgpuCommand | undefined
        if (command !== undefined && command.needsUpload) dirty.push(command)
      }
    }
    if (dirty.length === 0) return
    if (dirty.length > 1) dirty.sort((a, b) => a.sliceOffset - b.sliceOffset)
    // the merge walk: a run's window [from, to), the max per-slice binding
    // window, the run's member count (1 member → the classic call verbatim)
    let from = 0
    let to = 0
    let window = 0
    let members = 0
    // the run's FIRST member's cached view — set when a run starts, read
    // by flushRun when the run stayed a lone slice (the classic call form)
    let loneView: Uint8Array | undefined
    const flushRun = (): void => {
      if (members === 1 && loneView !== undefined) {
        // the lone slice: the CACHED view, no window arg (the pre-178
        // call, byte-identical call stream)
        gpu.uploadUniforms(from, loneView)
      } else if (members > 1) {
        gpu.uploadUniforms(from, arena.bytes.subarray(from, to), window)
      }
      members = 0
      loneView = undefined
    }
    for (const command of dirty) {
      // Upload — the actual uniform bytes (without the slice's trailing padding
      // up to dynamic-offset granularity): writeBuffer allows a multiple-of-4
      // size, the shader reads exactly as much as declared in the struct.
      // The subarray view is cached on the command (the slice window is
      // constant per command — no per-frame view allocation).
      if (command.sliceView === undefined) {
        const bytes = Math.min(command.uniformBytes ?? command.sliceBytes, command.sliceBytes)
        command.sliceView = arena.bytes.subarray(command.sliceOffset, command.sliceOffset + bytes)
      }
      command.needsUpload = false
      const offset = command.sliceOffset
      const bytes = command.sliceView.length
      const w = Math.ceil(bytes / 256) * 256
      if (members > 0 && offset - to < 256) {
        if (w > window) window = w
        if (offset + bytes > to) to = offset + bytes
        members++
      } else {
        flushRun()
        from = offset
        to = offset + bytes
        window = w
        members = 1
        loneView = command.sliceView
      }
    }
    flushRun()
  }

  function beginPass(): void {
    gpu.beginPass(0)
  }

  function drawCommand(command: RichWgpuCommand | undefined, count: number, instances: number): void {
    if (command === undefined) return
    // Task 174 — the run's fast path. An APPEND (the run's command, a real
    // draw, room in the batch) skips the prologue entirely — every
    // assertion below is a memo no-op for a same-command repeat (proven
    // at the tier's design; see the run block above). The multi shape
    // packs the member into runArgs (flushRun emits the batch); the
    // fast-path floor issues the bare pass.draw — the classic stream's
    // own draw, just without the redundant JS prologue around it.
    let member0Pending = false
    if (tierOn && count > 0 && instances > 0) {
      if (command === runCommand && runLen < MAX_BATCH) {
        if (multiFn !== undefined) {
          const b = runLen * 4
          runArgs[b] = count; runArgs[b + 1] = instances
          runLen++
          return
        }
        gpu.draw(count, instances)
        return
      }
      flushRun()
      runCommand = command
      runArgs[0] = count; runArgs[1] = instances
      if (multiFn !== undefined) {
        // the multi shape keeps member 0 PENDING (flushRun emits it —
        // alone it rides classic, with company it is one indirect call)
        runLen = 1
        member0Pending = true
      } else {
        // the fast-path floor: nothing pending — the run is runCommand
        // ONLY (the append detector); member 0 emits at the bottom like
        // the classic path
        runLen = 0
      }
      // fall through to the prologue ONCE — for the whole run
    }
    else {
      // degenerate (count 0 / instances 0) or the tier is off — the run
      // must not absorb a draw whose classic behavior differs
      flushRun()
    }
    if (!command.pipelineReady) {
      // M5 (Task 73): feed interleaving — rich slot {size, stride, offset};
      // tight attributes — a number (arrayStride = size*4, offset 0).
      // Task 75: step='instance' → pipeline stepMode; desc — blend/depth/
      // cull/primitive from GpuPipelineDesc (actually applied in buildPipeline).
      gpu.ensurePipeline(
        command.pipelineId,
        command.wgsl,
        command.attrOrder.map(a => a.stride !== undefined || a.step !== undefined
          ? { size: a.size, stride: a.stride, offset: a.offset ?? 0, step: a.step }
          : a.size),
        command.textureIds.length > 0,
        command.pipeline,
      )
      command.pipelineReady = true
    }
    gpu.usePipeline(command.pipelineId)
    gpu.bindUniforms(command.sliceOffset)
    // Indexed loop — no closure allocation per draw. Task 131: an
    // attribute with bufferId binds the EXTERNAL GPU buffer (the GPGPU
    // pack's output — the instance records, zero per-frame CPU upload);
    // otherwise the data-keyed vertex buffer.
    const attrOrder = command.attrOrder
    for (let slot = 0; slot < attrOrder.length; slot++) {
      const attribute = attrOrder[slot]
      if (attribute.bufferId !== undefined) gpu.bindExternalVertexBuffer(slot, attribute.bufferId)
      else gpu.bindVertexBuffer(slot, attribute.data, attribute.size)
    }
    // Task 145: indexed walk (no iterator protocol per draw; JSC usually
    // inlines array for..of, but the indexed form is guaranteed).
    const textureIds = command.textureIds
    for (let t = 0; t < textureIds.length; t++) gpu.bindTexture(textureIds[t])
    if (!member0Pending) gpu.draw(count, instances)
  }

  return { run }
}

/** Internal command shape (the compiler writes these fields). */
interface RichWgpuCommand extends WgpuCommand {
  readonly pipelineId: number
  readonly wgsl: string
  readonly attrOrder: readonly { readonly data: Float32Array; readonly size: number; readonly stride?: number; readonly offset?: number; readonly step?: 'vertex' | 'instance'; readonly bufferId?: number }[]
  readonly pipeline: GpuPipelineDesc
  readonly textureIds: readonly number[]
  readonly sliceOffset: number
  readonly sliceBytes: number
  /** Actual uniform bytes (upload without the slice's trailing padding). */
  readonly uniformBytes?: number
  /** Cached view of the arena slice window (constant per command). */
  sliceView?: Uint8Array
  needsUpload: boolean
  pipelineReady: boolean
}
