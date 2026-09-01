import type { TapeWriter } from '@rune/core'
import type { PortableSpec, BackendAdapter, CompiledOnBackend } from './adapters.ts'

/** Устойчивый хэндл команды: переживает смену бэкенда и потерю устройства. */
export interface PortableCommand {
  readonly id: number
  record(props: any, ctx: any, writer: TapeWriter): void
}

/** Декларация команды в журнале харнесса: declare/destroy (append-only). */
export interface CommandDecl {
  readonly kind: 'declare' | 'destroy'
  readonly id: number
}

/** Журнал команд харнесса: append-only, length — для аудита/тестов. */
export interface CommandJournal {
  declare(id: number): void
  destroy(id: number): void
  readonly length: number
}

/** Итог восстановления: сколько живых команд пере-декларировано. */
export interface ReplaySummary {
  readonly recompiled: number
  readonly backend: 'webgl2' | 'webgpu'
}

/** Харнесс переносимости: журнал команд + два бэкенда + один механизм replay. */
export interface PortabilityHarness {
  readonly backend: 'webgl2' | 'webgpu'
  readonly journal: CommandJournal
  compile(spec: PortableSpec): PortableCommand
  destroy(command: PortableCommand): void
  switchBackend(kind: 'webgl2' | 'webgpu'): ReplaySummary
  simulateLoss(): ReplaySummary
}

/** Создаёт харнесс: switchBackend и simulateLoss — один и тот же replay. */
export function createPortability(
  adapters: { readonly webgl2: BackendAdapter; readonly webgpu: BackendAdapter },
  initial: 'webgl2' | 'webgpu' = 'webgl2',
): PortabilityHarness {
  // Журнал команд: тот же принцип, что у ресурсного Journal из @rune/core
  // (append-only декларации + replay), но домен — переносимые команды,
  // а не GPU-ресурсы (спецификация команды сериализуема и бэкенд-
  // независима — replay = повторная компиляция на новом контексте).
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

/** Фасад делегирует текущей компиляции: хэндл стабилен между бэкендами. */
function makeFacade(entry: LiveEntry): PortableCommand {
  return {
    id: entry.id,
    record: (props, ctx, writer) => entry.compiled.record(props, ctx, writer),
  }
}
