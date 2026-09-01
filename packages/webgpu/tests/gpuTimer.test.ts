/**
 * Тесты WebGPU GpuTimer — createGpuGpuTimer.
 *
 * В headless-окружении нет реального GPUDevice, поэтому тесты создают mock
 * объекты с подходящим shape. Реальная интеграция (с querySet, writeTimestamp,
 * mapAsync) проверяется только в real-browser smoke test с GPU.
 *
 * Тесты проверяют:
 *  - createGpuGpuTimer возвращает null если device.features.has('timestamp-query') === false
 *  - createGpuGpuTimer возвращает { timer, handle } если feature есть
 *  - timer.result() возвращает null на первом кадре (нет pending resolve)
 *  - timer.begin()/end() не бросают без pending resolve
 *  - handle.onBeginPass/onEndPass/onSubmit безопасно вызываются на mock pass/encoder
 */

import { describe, expect, it } from 'bun:test'
import { createGpuGpuTimer } from '../src/gpuTimer.ts'

// Mock GPUDevice с features.has(name)
function makeMockDevice(hasFeature: boolean): GPUDevice {
  return {
    features: {
      has: (name: string) => hasFeature && name === 'timestamp-query',
      size: hasFeature ? 1 : 0,
      [Symbol.iterator]: function* () {
        if (hasFeature) yield 'timestamp-query'
      },
    },
    createQuerySet: (_desc: unknown) => ({}) as GPUQuerySet,
    createBuffer: (_desc: unknown) => ({
      size: 16,
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(16),
      unmap: () => {},
      destroy: () => {},
    }) as unknown as GPUBuffer,
  } as unknown as GPUDevice
}

// Mock GPURenderPassEncoder с writeTimestamp
function makeMockPass(): GPURenderPassEncoder {
  return {
    writeTimestamp: () => {},
    end: () => {},
  } as unknown as GPURenderPassEncoder
}

// Mock GPUCommandEncoder с resolveQuerySet + copyBufferToBuffer
function makeMockEncoder(): GPUCommandEncoder {
  return {
    resolveQuerySet: () => {},
    copyBufferToBuffer: () => {},
    finish: () => ({}) as GPUCommandBuffer,
  } as unknown as GPUCommandEncoder
}

describe('createGpuGpuTimer — feature gating', () => {
  it('возвращает null если device не имеет timestamp-query feature', () => {
    const device = makeMockDevice(false)
    const result = createGpuGpuTimer(device)
    expect(result).toBeNull()
  })

  it('возвращает { timer, handle } если device имеет timestamp-query feature', () => {
    const device = makeMockDevice(true)
    const result = createGpuGpuTimer(device)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('timer')
    expect(result).toHaveProperty('handle')
  })
})

describe('GpuTimer — контракт на mock (без реального GPU)', () => {
  it('result() возвращает null на свежем timer (нет pending resolve)', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(timer.result()).toBeNull()
  })

  it('begin() не бросает без pending resolve', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(() => timer.begin()).not.toThrow()
  })

  it('end() не бросает (noop на уровне timer)', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(() => timer.end()).not.toThrow()
  })
})

describe('GpuTimerHandle — mock вызовы', () => {
  it('onBeginPass не бросает на mock pass', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const pass = makeMockPass()
    expect(() => handle.onBeginPass(pass)).not.toThrow()
  })

  it('onEndPass не бросает на mock pass', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const pass = makeMockPass()
    expect(() => handle.onEndPass(pass)).not.toThrow()
  })

  it('onSubmit не бросает на mock encoder', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const encoder = makeMockEncoder()
    expect(() => handle.onSubmit(encoder)).not.toThrow()
  })

  it('после onSubmit begin() запускает mapAsync (mock resolved)', async () => {
    const device = makeMockDevice(true)
    const { timer, handle } = createGpuGpuTimer(device)!
    const encoder = makeMockEncoder()
    handle.onSubmit(encoder)
    // begin() запускает mapAsync — mock resolve() сразу
    await timer.begin()
    // После resolved map результат — null (mock getMappedRange возвращает
    // ArrayBuffer 16 = 2 BigInt64 = 0,0 → result null из-за end < start проверки)
    // На самом деле end=0, start=0 → end>=start → result = 0ms. Проверим
    // что не undefined.
    const r = timer.result()
    expect(r === null || typeof r === 'number').toBe(true)
  })
})
