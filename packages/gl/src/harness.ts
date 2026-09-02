import type { TapeWriter } from '@rune/core'
import type { PortableSpec, BackendAdapter, CompiledOnBackend } from './adapters.ts'

/** A durable command handle: survives backend switches and device loss. */
export interface PortableCommand {
  readonly id: number
  record(props: any, ctx: any, writer: TapeWriter): void
}

/** Command declaration in the harness journal: declare/destroy (append-only). */
export interface CommandDecl {
  readonly kind: 'declare' | 'destroy'
  readonly id: number
}

/** Harness command journal: append-only, length is for audit/tests. */
export interface CommandJournal {
  declare(id: number): void
  destroy(id: number): void
  readonly length: number
}

/** Recovery result: how many live commands were re-declared. */
export interface ReplaySummary {
  readonly recompiled: number
  readonly backend: 'webgl2' | 'webgpu'
}

/** Portability harness: command journal + two backends + one replay mechanism. */
export interface PortabilityHarness {
  readonly backend: 'webgl2' | 'webgpu'
  readonly journal: CommandJournal
  compile(spec: PortableSpec): PortableCommand
  destroy(command: PortableCommand): void
  switchBackend(kind: 'webgl2' | 'webgpu'): ReplaySummary
  simulateLoss(): ReplaySummary
}

/** Creates a harness: switchBackend and simulateLoss share the same replay. */
export function createPortability(
  adapters: { readonly webgl2: BackendAdapter; readonly webgpu: BackendAdapter },
  initial: 'webgl2' | 'webgpu' = 'webgl2',
): PortabilityHarness {
  // Command journal: the same principle as the resource Journal from @rune/core
  // (append-only declarations + replay), but the domain is portable commands,
  // not GPU resources (a command spec is serializable and backend-
  // independent — replay = recompilation on the new context).
  const ops: CommandDecl[] = []
  const journal: CommandJournal = {
    declare: id => ops.push({ kind: 'declare', id }),
    destroy: id => ops.push({ kind: 'destroy', id }),
    get length() { return ops.length },
  }
  const live = new Map<number, LiveEntry>()
  let active = initial
  let context = adapters[active].create()
  let nextId = 0

  function compile(spec: PortableSpec): PortableCommand {
    const id = nextId++
    journal.declare(id)
    const entry: LiveEntry = { id, spec, compiled: compileOn(adapters, active, context, spec) }
    live.set(id, entry)
    return makeFacade(entry)
  }

  function destroy(command: PortableCommand): void {
    journal.destroy(command.id)
    live.delete(command.id)
  }

  function switchBackend(kind: 'webgl2' | 'webgpu'): ReplaySummary {
    active = kind
    context = adapters[kind].create()
    return replay()
  }

  function simulateLoss(): ReplaySummary {
    context = adapters[active].create()
    return replay()
  }

  function replay(): ReplaySummary {
    let recompiled = 0
    for (const op of ops) {
      if (op.kind === 'destroy') {
        live.delete(op.id)
        continue
      }
      if (!live.has(op.id)) continue
      recompiled++
      const target = live.get(op.id)!
      target.compiled = compileOn(adapters, active, context, target.spec)
    }
    return { recompiled, backend: active }
  }

  return {
    get backend() { return active },
    journal,
    compile,
    destroy,
    switchBackend,
    simulateLoss,
  }
}

interface LiveEntry {
  readonly id: number
  readonly spec: PortableSpec
  compiled: CompiledOnBackend
}

function compileOn(
  adapters: { webgl2: BackendAdapter; webgpu: BackendAdapter },
  kind: 'webgl2' | 'webgpu',
  context: unknown,
  spec: PortableSpec,
): CompiledOnBackend {
  return adapters[kind].compile(context, spec)
}

/** The facade delegates to the current compilation: the handle is stable across backends. */
function makeFacade(entry: LiveEntry): PortableCommand {
  return {
    id: entry.id,
    record: (props, ctx, writer) => entry.compiled.record(props, ctx, writer),
  }
}
