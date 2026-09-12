/**
 * WebGL2 tape executor: interprets opcodes on top of the facade.
 * Uniforms — BY NAME (lazy location caches), value-compare in the arena
 * suppresses redundant uploads; the state cache skips useless
 * depth/culling switches between commands.
 */

import type { SegmentStore, TapeView, UniformArena } from '@rune/core'
import type { CompiledCommand } from './command.ts'
import type { UniformStrategy } from './command.ts'
import type { GLFacade } from './facade.ts'

export interface GLExecutorOptions {
  readonly gl: GLFacade
  readonly arena: UniformArena
  readonly commands: readonly CompiledCommand[]
  readonly clears: ReadonlyArray<{ readonly color: readonly [number, number, number, number]; readonly depth: number | null }>
  readonly segments?: SegmentStore
  readonly uniformStrategy?: UniformStrategy
  /** Task 169/187 — THE MULTI-DRAW TIERS: collapse runs of consecutive draws
   *  of the SAME command into one WEBGL_multi_draw call — the arrays tier
   *  (Task 169, non-indexed runs → multiDrawArraysInstanced) and the indexed
   *  tier (Task 187, indexed runs → multiDrawElementsInstanced — one element
   *  buffer, all offsets 0). Only active when the facade actually exposes the
   *  matching method (the extension is present); default true. A kill-switch
   *  for driver-bug insurance: false restores the per-draw drawArrays /
   *  drawElements paths exactly — the batched and unbatched tapes are
   *  pixel-identical by construction (the batch semantics are the verbatim
   *  expansion of the per-draw calls). Batched draws are ALSO unchanged for
   *  scenes that never repeat a command: a run of length 1 takes the classic
   *  path verbatim. */
  readonly multiDraw?: boolean
}

const DEFAULT_CLEAR = { color: [0.07, 0.08, 0.11, 1] as const, depth: 1 }

export interface GLExecutor {
  run(view: TapeView): void
  /** Task 168 — THE RESTORE WIRE: after webglcontextlost+restored the
   *  facade was reset (fresh Maps — the old program/buffer ids are unknown
   *  again), so every command's derived GPU state is stale. This walks the
   *  command set and drops programId/bufferIds (the next draw re-creates
   *  them lazily from the command specs — the exact boot path), and re-dirt
   *  ies every uniform field: the arena's value-compare suppressed uploads
   *  because the DEAD program already had the values — the fresh program
   *  has nothing until each field uploads once. Optional (the historical
   *  executors without it keep their pre-168 behavior). */
  invalidate?(): void
}

export function createExecutor(options: GLExecutorOptions): GLExecutor {
  const gl = options.gl
  const arena = options.arena
  const commands = options.commands
  const clears = options.clears

  let lastProgram = -1
  let lastDepthTest = ''
  let lastCull = ''
  let lastBlend = ''

  // ── Task 169 — THE MULTI-DRAW TIER ──
  // A RUN is a maximal sequence of consecutive Draw ops referencing the
  // SAME command with count > 0 and instances > 0. Within a run every GL
  // assertion the classic per-draw path makes is a no-op by construction:
  //   • program/state/samplers/attributes — identical (the same command
  //     object → the same programId, the same precompiled state keys, the
  //     same textureIds and buffer bindings); the Task-163/165 facade
  //     memos would skip every re-assert anyway;
  //   • uniforms — the step() discipline is record-then-execute: ALL
  //     arena writes happen before run() starts, so the dirty flags are
  //     final; the run's first draw uploads (drains) them, and nothing can
  //     re-dirty a field mid-run (the recorder is done; the executor writes
  //     nothing). The classic path's own value-compare made draws 2..N of
  //     such a run upload NOTHING already — the batch tier only removes
  //     the redundant drawArrays round-trips.
  // Degenerate members (count 0 / instances 0) END the run instead of
  // joining it: their classic-path behavior is preserved byte-for-byte
  // (a 0-instance draw historically falls into the non-instanced
  // drawArrays branch — a quirk, but a pinned one; the multi-draw
  // expansion of instanceCount 0 is a no-op, which is NOT the same call).
  // The run is flushed (emitted) on: any non-Draw op (BeginPass resets
  // state mirrors, BindTarget switches the framebuffer — pending draws
  // belong to the OLD target), a different command, a degenerate draw,
  // the MAX_BATCH cap, or the tape's end. A run of length 1 emits through
  // the classic drawArrays path — scenes that never repeat a command see
  // byte-identical call sequences with the tier on or off.
  const multiDrawFn = typeof gl.multiDrawArraysInstanced === 'function'
    ? gl.multiDrawArraysInstanced.bind(gl)
    : undefined
  const multiDraw = (options.multiDraw ?? true) && multiDrawFn !== undefined
  // Task 187 — the INDEXED twin: the tier arms for indexed commands IFF the
  // facade exposes multiDrawElementsInstanced (a context/mock without it
  // keeps indexed commands on the classic per-draw drawElements path —
  // Task 180's behavior, verbatim).
  const multiDrawElemsFn = typeof gl.multiDrawElementsInstanced === 'function'
    ? gl.multiDrawElementsInstanced.bind(gl)
    : undefined
  const MAX_BATCH = 512
  const batchFirsts = new Int32Array(MAX_BATCH) // all zeros — first is always 0
  const batchCounts = new Int32Array(MAX_BATCH)
  const batchInstances = new Int32Array(MAX_BATCH)
  let batchCommand: CompiledCommand | undefined
  let batchLen = 0
  // Task 187 — THE INDEXED RUN: a maximal sequence of consecutive Draw ops
  // of the SAME indexed command (count > 0, instances > 0). The members
  // share ONE element buffer (created lazily at member 0's prologue — the
  // Task-180 discipline) and every member starts at index 0, so the offsets
  // list is all zeros (the facade's bind stays for the whole call). The
  // two-byte flag is a per-command constant (the indices array's type).
  const batchElemsCounts = new Int32Array(MAX_BATCH)
  const batchElemsInstances = new Int32Array(MAX_BATCH)
  const batchElemsOffsets = new Int32Array(MAX_BATCH) // all zeros — one element buffer, offset 0
  let batchElemsCommand: CompiledCommand | undefined
  let batchElemsLen = 0
  let batchElemsTwoByte = false

  function flushBatch(): void {
    if (batchLen === 0) { batchCommand = undefined; return }
    if (batchLen === 1) {
      // the lone draw rides the classic path — the pre-169 call, verbatim
      gl.drawArrays('triangles', batchFirsts[0], batchCounts[0], batchInstances[0])
    } else {
      multiDrawFn?.('triangles', batchFirsts, batchCounts, batchInstances, batchLen)
    }
    batchLen = 0
    batchCommand = undefined
  }

  function flushBatchElems(): void {
    if (batchElemsLen === 0) { batchElemsCommand = undefined; return }
    const command = batchElemsCommand as (CompiledCommand & { elementId?: number }) | undefined
    // member 0 always fell through the prologue (the run STARTS there), so
    // the element buffer exists; the guard keeps a corrupted state from
    // crashing — the draws are lost either way a classic call would be.
    const elementId = command?.elementId
    if (batchElemsLen === 1 || elementId === undefined) {
      // the lone draw rides the classic path — the pre-187 call, verbatim
      if (elementId !== undefined) {
        gl.drawElements(elementId, batchElemsCounts[0], batchElemsInstances[0], batchElemsTwoByte)
      }
    } else {
      multiDrawElemsFn?.('triangles', elementId, batchElemsCounts, batchElemsInstances, batchElemsOffsets, batchElemsLen, batchElemsTwoByte)
    }
    batchElemsLen = 0
    batchElemsCommand = undefined
  }

  function run(view: TapeView): void {
    // Task 163 — SUBMIT-ALL: every compiled-but-not-yet-created program is
    // submitted NOW, before the first draw. createProgram fires the
    // compile+link — and under KHR_parallel_shader_compile it RETURNS
    // without blocking, so the driver's background compile threads take
    // the WHOLE command set at once; the per-draw useProgram resolves then
    // pay max(link time) instead of the sum (a cold demo scene with N
    // distinct pipelines: N × 6–16ms of first-frame jank → one ~max
    // resolve). Buffers stay LAZY (ensureProgram at draw): a command the
    // frame never draws must not upload vertex data it may never use.
    // Steady state: one property check per command, zero GL calls.
    for (const command of commands) submitProgram(command)
    for (let at = 0; at < view.count; at++) {
      const op = view.op[at]
      if (op === 2) drawCommand(commands[view.a[at]], view.c[at], view.d[at])
      else {
        // Task 169/187: a non-Draw op ends the runs FIRST — their pending
        // draws were recorded for the state/target as they stood
        flushBatchElems()
        flushBatch()
        if (op === 1) beginPass()
        else if (op === 4) gl.bindTarget(view.a[at], view.b[at] === 1)
        // EndPass (3): a frame bracket, requires no GL cleanup
      }
    }
    flushBatchElems() // the tape's end — no draw may leak past the frame
    flushBatch() // the tape's end — no draw may leak past the frame
  }

  function beginPass(): void {
    // Guaranteed return to the canvas: the previous frame may have ended
    // on a surface (skip inside the facade if already on the canvas)
    gl.bindTarget(0, false)
    const clear = clears[0] ?? DEFAULT_CLEAR
    gl.clear(clear.color, clear.depth)
    // Task 75b (the blend regression class): re-assert the raster state at
    // EVERY pass start. The caches below mirror what WE last set — but the
    // real GL context is global mutable state: anything that touched it
    // between our frames (a context loss+restore, a browser extension, a
    // shared-surface blit, driver state resets) leaves the cache LYING while
    // the context no longer holds the blend/depth we set. A stale cache =
    // the pipeline state is silently skipped for the rest of the session —
    // the exact "particles render without blending" report class.
    // Cost: one redundant setDepthMode/setBlend per distinct state on the
    // first command of the frame (the facade passes straight through).
    lastProgram = -1
    lastDepthTest = ''
    lastCull = ''
    lastBlend = ''
  }

  function drawCommand(command: CompiledCommand | undefined, count: number, instances: number): void {
    if (command === undefined) return
    const rich = command as CompiledCommand & {
      state: { depthTest: string; depthWrite: boolean; depthKey: string; cull: string; blend: { src: string; dst: string; equation: string } | null; blendKey: string }
      fields: Array<{ name: string; type: string; slot: { base: number; size: number; dirty: boolean } }>
      samplers: Array<{ name: string; unit: number; textureId: number }>
      attributes: Array<{ location: number; size: number; data: Float32Array; stride?: number; offset?: number; bufferId?: number; instance?: boolean }>
      glsl: { vertex: string; fragment: string }
      indices?: { readonly data: Uint16Array | Uint32Array }
      elementId?: number
      programId?: number
      bufferIds?: number[]
    }
    // Task 180/187 — an INDEXED command's batch membership: it joins the
    // INDEXED run (multiDrawElementsInstanced) IFF the facade exposes the
    // method; otherwise it rides the classic per-draw drawElements path
    // verbatim (Task 180's behavior). The arrays tier (multiDrawArraysInstanced)
    // remains the NON-indexed vocabulary — the two runs never mix.
    const indexed = rich.indices !== undefined
    // Task 169/187 — the multi-draw fast paths: an APPEND (the run's command,
    // a real draw, room in the batch) skips the prologue entirely — every
    // assertion below is a no-op for a same-command repeat, proven at the
    // tier's design (see the batch block above). Runs of one stay classic.
    let batched = false
    if (multiDraw && count > 0 && instances > 0) {
      if (!indexed) {
        if (command === batchCommand && batchLen < MAX_BATCH) {
          batchCounts[batchLen] = count
          batchInstances[batchLen] = instances
          batchLen++
          return
        }
        // the arrays run starts: the pending INDEXED draws emit first —
        // under the state they were recorded with
        flushBatchElems()
        flushBatch()
        batchCommand = command
        batchCounts[0] = count
        batchInstances[0] = instances
        batchLen = 1
        batched = true
        // fall through to the prologue ONCE — for the whole run; the draw
        // itself stays PENDING in the batch (flushBatch emits it)
      } else if (multiDrawElemsFn !== undefined && rich.indices !== undefined) {
        if (command === batchElemsCommand && batchElemsLen < MAX_BATCH) {
          batchElemsCounts[batchElemsLen] = count
          batchElemsInstances[batchElemsLen] = instances
          batchElemsLen++
          return
        }
        // the indexed run starts: the pending ARRAYS draws emit first —
        // under the state they were recorded with
        flushBatch()
        flushBatchElems()
        batchElemsCommand = command
        batchElemsCounts[0] = count
        batchElemsInstances[0] = instances
        batchElemsLen = 1
        batchElemsTwoByte = rich.indices.data instanceof Uint16Array
        batched = true
        // fall through to the prologue ONCE — for the whole run; member 0's
        // pass creates the element buffer lazily (the Task-180 discipline),
        // the draw itself stays PENDING in the batch (flushBatchElems emits it)
      } else {
        // the facade lacks the indexed batch call — the classic path, and
        // any pending run of either kind must not absorb this draw
        flushBatchElems()
        flushBatch()
      }
    }
    else {
      // degenerate (count 0 / instances 0) or the tier is off — the run
      // must not absorb a draw whose classic behavior differs
      flushBatchElems()
      flushBatch()
    }
    const richPrologue = rich
    ensureProgram(richPrologue)
    if (richPrologue.programId !== lastProgram) {
      gl.useProgram(richPrologue.programId!)
      lastProgram = richPrologue.programId!
    }
    applyState(richPrologue)
    uploadUniforms(richPrologue)
    for (let s = 0; s < richPrologue.samplers.length; s++) {
      const sampler = richPrologue.samplers[s]
      gl.bindTexture(sampler.textureId, sampler.unit)
      gl.setUniform1i(richPrologue.programId!, sampler.name, sampler.unit)
    }
    for (let a = 0; a < richPrologue.attributes.length; a++) {
      const attribute = richPrologue.attributes[a]
      // M5 (Task 73): feed dual-bind — the feed renderer's external buffer with
      // interleaving (stride/offset); our own buffer — a tight layout.
      // Task 75: an instance attribute — divisor 1 (one feed record per instance,
      // the quad corners are unfolded from gl_VertexID).
      // Task 165: indexed walk (the Task-145 WG discipline — no iterator
      // protocol per draw), and the bind itself is memo-able: the facade's
      // vertex-bind mirror skips the 100%-redundant re-asserts (4 GL calls
      // per attribute per draw → 0 in the steady state).
      const divisor = attribute.instance === true ? 1 : 0
      if (attribute.bufferId !== undefined) {
        gl.bindVertexBuffer(attribute.bufferId, attribute.location, attribute.size, attribute.stride, attribute.offset, divisor)
      } else {
        gl.bindVertexBuffer(richPrologue.bufferIds![attribute.location], attribute.location, attribute.size, undefined, undefined, divisor)
      }
    }
    // Task 180 — THE INDEX TIER: the element buffer is created LAZILY at the
    // first indexed draw (the submit-all sweep may have compiled programs of
    // commands this frame never draws — the same discipline as the vertex
    // buffers), then the indexed draw. The tape's count IS the index count.
    // Task 187: a BATCHED member 0 skips the draw itself — it stays PENDING
    // in the indexed batch (flushBatchElems emits it; alone it rides the
    // classic call verbatim).
    const indices = rich.indices
    if (indices !== undefined) {
      if (rich.elementId === undefined) {
        rich.elementId = gl.createElementBuffer(indices.data)
      }
      if (!batched) gl.drawElements(rich.elementId, count, instances, indices.data instanceof Uint16Array)
      return
    }
    if (!batched) gl.drawArrays('triangles', 0, count, instances)
  }

  function ensureProgram(command: CompiledCommand & { programId?: number; bufferIds?: number[] }): void {
    const rich = command as CompiledCommand & {
      glsl: { vertex: string; fragment: string }
      attributes: Array<{ location: number; size: number; data: Float32Array; bufferId?: number }>
      programId?: number
      bufferIds?: number[]
    }
    if (rich.programId === undefined) {
      // A command the run()-start sweep never saw (created after this
      // frame's run began — the next run() submits it; here it submits
      // inline, exactly the pre-Task-163 lazy path).
      rich.programId = gl.createProgram(rich.glsl.vertex, rich.glsl.fragment)
    }
    // M5: a feed attribute lives in the feed renderer's external buffer — we do not create our own.
    // Task 163: the buffers keep their own guard — the submit-all sweep may
    // have created the PROGRAM of a command this frame never draws (the
    // compile+link parallelism win); the vertex-data upload must stay lazy.
    if (rich.bufferIds === undefined) {
      rich.bufferIds = rich.attributes.map(attribute => attribute.bufferId !== undefined ? -1 : gl.createBuffer(attribute.data))
    }
  }

  /** Task 163 — the run()-start program submission (see run): createProgram
   *  only, no buffers, no resolve — the link resolves at the program's first
   *  useProgram (the facade's deferred-link contract). */
  function submitProgram(command: CompiledCommand | undefined): void {
    if (command === undefined) return
    const rich = command as CompiledCommand & {
      glsl?: { vertex: string; fragment: string }
      programId?: number
    }
    if (rich.programId === undefined && rich.glsl !== undefined) {
      rich.programId = gl.createProgram(rich.glsl.vertex, rich.glsl.fragment)
    }
  }

  function applyState(command: CompiledCommand & { state: { depthTest: string; depthWrite: boolean; depthKey: string; cull: string; blend: { src: string; dst: string; equation: string } | null; blendKey: string } }): void {
    const state = command.state
    // Task 143: the keys come PRECOMPILED from compileDrawSpec — the
    // template literals are compile-time constants of the command, not
    // two fresh strings per draw call.
    if (state.depthKey !== lastDepthTest) {
      gl.setDepthMode(state.depthTest, state.depthWrite)
      lastDepthTest = state.depthKey
    }
    if (state.cull !== lastCull) {
      gl.setCull(state.cull)
      lastCull = state.cull
    }
    // Task 75: pipeline blending (additive/transparency for star quads).
    // Task 122: the equation joins the state key — a MAX pipeline next to
    // an ADD pipeline with the same factors must still re-assert.
    if (state.blendKey !== lastBlend) {
      gl.setBlend(
        state.blend === null ? null : state.blend.src,
        state.blend === null ? null : state.blend.dst,
        state.blend === null ? undefined : state.blend.equation,
      )
      lastBlend = state.blendKey
    }
  }

  function uploadUniforms(command: CompiledCommand & { programId?: number }): void {
    const rich = command as CompiledCommand & {
      programId?: number
      fields: Array<{ name: string; type: string; slot: { base: number; size: number; dirty: boolean }; view?: Float32Array }>
    }
    for (let f = 0; f < rich.fields.length; f++) {
      const field = rich.fields[f]
      if (!field.slot.dirty) continue
      // Task 165 — the slice-view twin of the WG executor's Task-145 cache:
      // the arena window is a compile-time constant of the field, but the
      // subarray allocated a fresh TypedArray view object per field per draw
      // (a 20-command × 5-field scene = 6000 view objects/second of pure GC
      // churn). The view is cached on the field — the arena's backing buffer
      // is created once and never reallocated.
      if (field.view === undefined) {
        field.view = arena.buffer.subarray(field.slot.base, field.slot.base + field.slot.size)
      }
      setByType(rich.programId!, field.name, field.type, field.view)
      field.slot.dirty = false
    }
  }

  function setByType(programId: number, name: string, type: string, values: Float32Array): void {
    if (type === 'mat4') gl.setUniformMatrix4(programId, name, values)
    else if (type === 'vec4') gl.setUniform4fv(programId, name, values)
    else if (type === 'vec3') gl.setUniform3fv(programId, name, values)
    else if (type === 'vec2') gl.setUniform2fv(programId, name, values)
    else gl.setUniform1f(programId, name, values[0])
  }

  /** Task 168 — see the interface doc. Steady-state cost: never called
   *  (the restore path only); when called — O(commands × fields). */
  function invalidate(): void {
    for (const command of commands) {
      if (command === undefined) continue
      const rich = command as CompiledCommand & {
        programId?: number
        bufferIds?: number[]
        elementId?: number
        fields: Array<{ slot: { dirty: boolean } }>
      }
      rich.programId = undefined
      rich.bufferIds = undefined
      // Task 180 — the element buffer dies with the restored context; the
      // next indexed draw re-creates it lazily (the program/buffer twin).
      rich.elementId = undefined
      for (let f = 0; f < rich.fields.length; f++) rich.fields[f].slot.dirty = true
    }
    // The per-frame state mirrors (lastProgram & co.) reset at beginPass of
    // every frame — nothing to do here.
    // Task 169: the batch tier's run state dies with the same stroke — a
    // pending batch's prologue ran against the DEAD program ids (between
    // frames the batch is always empty by the tape-end flush; this is the
    // hygiene arm of that invariant, not a reachable path).
    batchLen = 0
    batchCommand = undefined
    // Task 187: the indexed twin of the same hygiene.
    batchElemsLen = 0
    batchElemsCommand = undefined
  }

  return { run, invalidate }
}
