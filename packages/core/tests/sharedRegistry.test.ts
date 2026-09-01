import { describe, expect, it } from 'bun:test'
import { createSharedRegistry, attachSharedRegistry, signal, schemaHash } from '../src/index.ts'

const NAMES = ['game.hp', 'game.sun', 'ui.exposure']

describe('shared registry (T1/T2)', () => {
  it('владелец пишет — читатель видит актуальное значение без сообщений', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    const hp = signal(100)

    registry.bind(hp, 'game.hp')
    expect(mirror.signal('game.hp').value).toBe(100)

    hp.value = 42
    expect(mirror.signal('game.hp').value).toBe(42)
  })

  it('версия слота растёт с каждой записью', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    registry.write('game.sun', 1)
    const before = mirror.signal('game.sun').version
    registry.write('game.sun', 2)
    expect(mirror.signal('game.sun').version).toBeGreaterThan(before)
  })

  it('sampleAll уведомляет подписчиков только изменившихся слотов (эпоха)', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    const observed: number[] = []
    mirror.signal('game.hp').subscribe(value => observed.push(value))

    expect(mirror.sampleAll()).toBe(0) // ничего не менялось
    registry.write('game.hp', 7)
    expect(mirror.sampleAll()).toBe(1)
    expect(mirror.sampleAll()).toBe(0) // второй семпл — уже без изменений
    expect(observed).toEqual([7])
  })

  it('несовпадение схемы ловится при привязке', () => {
    const registry = createSharedRegistry(['game.hp'])
    expect(() => attachSharedRegistry(registry.buffer, ['game.hp', 'game.extra'])).toThrow()
  })

  it('неизвестное имя — понятная ошибка', () => {
    const registry = createSharedRegistry(NAMES)
    const mirror = attachSharedRegistry(registry.buffer, NAMES)
    expect(() => mirror.signal('game.unknown')).toThrow()
  })

  it('schemaHash устойчив и различает наборы', () => {
    expect(schemaHash(['a', 'b'])).toBe(schemaHash(['a', 'b']))
    expect(schemaHash(['a', 'b'])).not.toBe(schemaHash(['b', 'a']))
  })
})
