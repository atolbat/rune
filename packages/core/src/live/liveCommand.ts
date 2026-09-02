// Live command: a segment + dirty-by-dependencies + every(n) amortization.

import type { SegmentStore } from '../tape/segments.ts'
import { createTapeWriter } from '../tape/writer.ts'
import type { TapeWriter, WriterColumns } from '../tape/writer.ts'
import type { ReadableSignal } from '../signal/types.ts'

export interface LiveCommand {
  /** Identifier (index in the renderer's registry). */
  readonly id: number
  /** Temporal amortization: emit once every n frames (bloom/SSAO every other frame). */
  every(n: number): LiveCommand
  /** Frame tick: phase and activity. Called by the frame builder. */
  tickFrame(): void
  /** Whether the command is emitted in the current frame. */
  readonly active: boolean
  /** Dependencies changed since the last recording. */
  readonly dirty: boolean
  /** Record into the tape (fresh or cache replay). force=true — rewrite
   *  the segment from scratch (the full path without the cache — the "full rewrite" benchmark). */
  emit(writer: TapeWriter, force?: boolean): boolean
  /** Forced cache invalidation. */
  invalidate(): void
}

export interface LiveCommandOptions {
  readonly id?: number
  readonly deps?: readonly ReadableSignal[]
}

let nextLiveId = 1

export function createLiveCommand(
  segments: SegmentStore,
  record: (writer: TapeWriter) => void,
  deps: readonly ReadableSignal[] = [],
): LiveCommand {
  const id = nextLiveId++
  const versions = deps.map(() => -1)
  // The command's private writer — createTapeWriter(64): the SAME writer the
  // tape uses (grows ×2, a long command is never truncated), seeded for the
  // typical command size. Previously a 60-line verbatim copy of the tape
  // writer lived here — two implementations to keep in sync for no gain.
  const scratch = createTapeWriter(64)
  let frameStride = 1
  let framePhase = 0
  let frameCounter = 0
  let active = true
  let dirty = true

  function every(n: number): LiveCommand {
    if (n < 1) throw new Error('rune: every(n) requires n >= 1')
    frameStride = n
    framePhase = frameCounter % n
    return command
  }

  function tickFrame(): void {
    frameCounter++
    active = frameCounter % frameStride === framePhase
    pollDeps()
  }

  /** Refreshes `dirty` from the dependency versions (writes the snapshot,
 *  reads nothing back — one source of truth for the dirty state). */
  function pollDeps(): void {
    for (let at = 0; at < deps.length; at++) {
      const version = deps[at].version
      if (version !== versions[at]) {
        versions[at] = version
        dirty = true
      }
    }
  }

  function emit(writer: TapeWriter, force = false): boolean {
    if (!active) return false
    const cached = segments.fetch(id)
    if (!force && !dirty && cached !== undefined) {
      replay(writer, cached.rows, cached.count)
      return true
    }
    scratch.reset()
    record(scratch)
    const count = scratch.count
    const columns = scratch.columns
    const rows = packRows(columns, count)
    segments.store(id, rows, count)
    replay(writer, rows, count)
    dirty = false
    return true
  }

  function invalidate(): void {
    dirty = true
    segments.invalidate(id)
  }

  const command: LiveCommand = {
    id,
    every,
    tickFrame,
    get active() { return active },
    get dirty() { return dirty },
    emit,
    invalidate,
  }
  return command
}

/** Replays packed rows into the tape (bulk — without per-op emit calls). */
function replay(writer: TapeWriter, rows: Int32Array, count: number): void {
  writer.emitPacked(rows, count)
}

/** Packs the scratch writer's columns into dense rows. */
function packRows(columns: WriterColumns, count: number): Int32Array {
  const rows = new Int32Array(count * 5)
  for (let at = 0; at < count; at++) {
    const base = at * 5
    rows[base] = columns.op[at]
    rows[base + 1] = columns.a[at]
    rows[base + 2] = columns.b[at]
    rows[base + 3] = columns.c[at]
    rows[base + 4] = columns.d[at]
  }
  return rows
}
