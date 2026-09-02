import { describe, expect, it } from 'bun:test'
import { createSharedRegistry, attachSharedRegistry, signal, schemaHash } from '../src/index.ts'

const NAMES = ['game.hp', 'game.sun', 'ui.exposure']

describe('shared registry (T1/T2)', () => {
  it('the owner writes — the reader sees the current value without messages', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    const hp = signal(100)

    registry.bind(hp, 'game.hp')
    expect(mirror.signal('game.hp').value).toBe(100)

    hp.value = 42
    expect(mirror.signal('game.hp').value).toBe(42)
  })

  it('the slot version grows with every write', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    registry.write('game.sun', 1)
    const before = mirror.signal('game.sun').version
    registry.write('game.sun', 2)
    expect(mirror.signal('game.sun').version).toBeGreaterThan(before)
  })

  it('sampleAll notifies subscribers of changed slots only (epoch)', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    const observed: number[] = []
    mirror.signal('game.hp').subscribe(value => observed.push(value))

    expect(mirror.sampleAll()).toBe(0) // nothing changed
    registry.write('game.hp', 7)
    expect(mirror.sampleAll()).toBe(1)
    expect(mirror.sampleAll()).toBe(0) // the second sample — no changes anymore
    expect(observed).toEqual([7])
  })

  it('a schema mismatch is caught at bind time', () => {
    const registry = createSharedRegistry(['game.hp'])
    expect(() => attachSharedRegistry(registry.buffer, ['game.hp', 'game.extra'])).toThrow()
  })

  it('unknown name — a clear error', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    expect(() => mirror.signal('game.unknown')).toThrow()
  })

  it('schemaHash is stable and distinguishes sets', () => {
    expect(schemaHash(['a', 'b'])).toBe(schemaHash(['a', 'b']))
    expect(schemaHash(['a', 'b'])).not.toBe(schemaHash(['b', 'a']))
  })
})
