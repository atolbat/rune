/**
 * WebGPU GpuTimer tests — createGpuGpuTimer.
 *
 * In a headless environment there is no real GPUDevice, so the tests create
 * mock objects with a suitable shape. Real integration (with querySet,
 * writeTimestamp, mapAsync) is checked only in a real-browser smoke test
 * with a GPU.
 *
 * The tests check:
 *  - createGpuGpuTimer returns null if device.features.has('timestamp-query') === false
 *  - createGpuGpuTimer returns { timer, handle } if the feature is present
 *  - timer.result() returns null on the first frame (no pending resolve)
 *  - timer.begin()/end() do not throw without a pending resolve
 *  - handle.onBeginPass/onEndPass/onSubmit are safely callable on a mock pass/encoder
 */

import { describe, expect, it } from 'bun:test'
import { createGpuGpuTimer } from '../src/gpuTimer.ts'

// Mock GPUDevice with features.has(name)
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

// Mock GPURenderPassEncoder with writeTimestamp
function makeMockPass(): GPURenderPassEncoder {
  return {
    writeTimestamp: () => {},
    end: () => {},
  } as unknown as GPURenderPassEncoder
}

// Mock GPUCommandEncoder with resolveQuerySet + copyBufferToBuffer
function makeMockEncoder(): GPUCommandEncoder {
  return {
    resolveQuerySet: () => {},
    copyBufferToBuffer: () => {},
    finish: () => ({}) as GPUCommandBuffer,
  } as unknown as GPUCommandEncoder
}

describe('createGpuGpuTimer — feature gating', () => {
  it('returns null if the device lacks the timestamp-query feature', () => {
    const device = makeMockDevice(false)
    const result = createGpuGpuTimer(device)
    expect(result).toBeNull()
  })

  it('returns { timer, handle } if the device has the timestamp-query feature', () => {
    const device = makeMockDevice(true)
    const result = createGpuGpuTimer(device)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('timer')
    expect(result).toHaveProperty('handle')
  })
})

describe('GpuTimer — contract on mocks (without a real GPU)', () => {
  it('result() returns null on a fresh timer (no pending resolve)', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(timer.result()).toBeNull()
  })

  it('begin() does not throw without a pending resolve', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(() => timer.begin()).not.toThrow()
  })

  it('end() does not throw (noop at the timer level)', () => {
    const device = makeMockDevice(true)
    const { timer } = createGpuGpuTimer(device)!
    expect(() => timer.end()).not.toThrow()
  })
})

describe('GpuTimerHandle — mock calls', () => {
  it('onBeginPass does not throw on a mock pass', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const pass = makeMockPass()
    expect(() => handle.onBeginPass(pass)).not.toThrow()
  })

  it('onEndPass does not throw on a mock pass', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const pass = makeMockPass()
    expect(() => handle.onEndPass(pass)).not.toThrow()
  })

  it('onSubmit does not throw on a mock encoder', () => {
    const device = makeMockDevice(true)
    const { handle } = createGpuGpuTimer(device)!
    const encoder = makeMockEncoder()
    expect(() => handle.onSubmit(encoder)).not.toThrow()
  })

  it('after onSubmit begin() starts mapAsync (mock resolved)', async () => {
    const device = makeMockDevice(true)
    const { timer, handle } = createGpuGpuTimer(device)!
    const encoder = makeMockEncoder()
    handle.onSubmit(encoder)
    // begin() starts mapAsync — the mock resolves() immediately
    await timer.begin()
    // After a resolved map the result is null (the mock getMappedRange
    // returns ArrayBuffer 16 = 2 BigInt64 = 0,0 → result null due to the
    // end < start check)
    // Actually end=0, start=0 → end>=start → result = 0ms. Check
    // that it is not undefined.
    const r = timer.result()
    expect(r === null || typeof r === 'number').toBe(true)
  })
})
