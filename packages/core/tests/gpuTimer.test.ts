/**
 * Тесты GpuTimer — интерфейс + StatsCollector integration.
 *
 * Покрываем:
 *  - GpuTimer: mock begin/end/result — результат сдвинут на 1 кадр
 *  - StatsCollector.setGpuTimer(null) → gpuMs = null
 *  - StatsCollector.setGpuTimer(timer) → gpuMs появляется после 2-х кадров
 *  - Snapshot отражает текущий gpuMs
 *  - Disjoint (timer.result=null) → gpuMs сбрасывается в null
 */

import { test } from 'bun:test'
import { expect } from 'bun:test'
import { createStatsCollector } from '@rune/core'
import type { GpuTimer } from '@rune/core'

// ─── Mock GpuTimer — фиксированные результаты для тестов ─────────────────────

function createMockGpuTimer(results: (number | null)[]): GpuTimer {
  let idx = 0
  let active = false
  return {
    begin() {
      active = true
    },
    end() {
      active = false
    },
    result() {
      // Возвращает следующий результат из массива (или последний)
      if (idx < results.length) {
        return results[idx++]!
      }
      return results[results.length - 1] ?? null
    },
  }
}

// ─── StatsCollector без timer → gpuMs=null ───────────────────────────────────

test('StatsCollector без timer → gpuMs = null в snapshot', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  sc.beginFrame()
  t = 5
  sc.addDrawCall()
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(5)
  expect(s.gpuMs).toBeNull()
})

// ─── StatsCollector.setGpuTimer(null) → gpuMs остаётся null ──────────────────

test('StatsCollector.setGpuTimer(null) → gpuMs = null', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(null)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── GpuTimer: 1-й кадр → result=null (нет предыдущего), 2-й кадр → число ────

test('GpuTimer mock: 1-й кадр result() возвращает null, 2-й кадр — число', () => {
  let t = 0
  // Последовательность: кадр 1 begin/end → result=null (нет прошлого)
  //                       кадр 2 begin/end → result=12.3 (прошлый кадр)
  const timer = createMockGpuTimer([null, 12.3])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Кадр 1
  sc.beginFrame() // timer.begin() — query открыт
  t = 5
  sc.endFrame() // timer.end() — query закрыт

  // На момент snapshot после 1-го кадра — gpuMs=null (нет прошлого query)
  // (begin прочитал null от timer.result() — это и есть gpuMs)
  expect(sc.snapshot().gpuMs).toBeNull()

  // Кадр 2
  sc.beginFrame() // timer.begin() → timer.result() возвращает 12.3 (прошлый)
  t = 10
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(12.3)
})

// ─── GpuTimer: disjoint → result=null → gpuMs сбрасывается ──────────────────

test('GpuTimer mock: disjoint (result=null в середине) → gpuMs=null', () => {
  let t = 0
  // Последовательность: кадр 1 → result=null (нет прошлого)
  //                       кадр 2 → result=15.5 (прошлый кадр)
  //                       кадр 3 → result=null (disjoint, сброс)
  const timer = createMockGpuTimer([null, 15.5, null])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Кадр 1 — gpuMs = null (нет прошлого)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Кадр 2 — gpuMs = 15.5 (прошлый кадр)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(15.5)

  // Кадр 3 — gpuMs = null (disjoint сброс)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── setGpuTimer после 1-го кадра — следующий кадр читает null ───────────────

test('setGpuTimer(t) после 1-го кадра → следующий кадр gpuMs=null (нет прошлого)', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  // Кадр 1 без timer
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Подключаем timer после 1-го кадра
  const timer = createMockGpuTimer([null, 42.0])
  sc.setGpuTimer(timer)

  // Кадр 2 — timer.begin дёргает result() → null (прошлого нет)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Кадр 3 — timer.begin дёргает result() → 42.0 (кадр 2 закрыт)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(42.0)
})

// ─── setGpuTimer(null) после работы timer → gpuMs снова null ─────────────────

test('setGpuTimer(null) после работы → gpuMs снова null', () => {
  let t = 0
  const timer = createMockGpuTimer([null, 99.9])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Кадр 1
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Кадр 2
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(99.9)

  // Отключаем timer
  sc.setGpuTimer(null)

  // Кадр 3 — gpuMs снова null (нет timer)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── drawCalls и memory не зависят от timer ─────────────────────────────────

test('StatsCollector с timer: drawCalls и memoryEstimate работают независимо', () => {
  let t = 0
  const timer = createMockGpuTimer([null, 7.7])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  sc.beginFrame()
  t = 3
  sc.addDrawCall()
  sc.addDrawCall()
  sc.addMemory(1024)
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(3)
  expect(s.drawCalls).toBe(2)
  expect(s.memoryEstimate).toBe(1024)
  expect(s.gpuMs).toBeNull() // первый кадр, нет прошлого

  // Кадр 2
  sc.beginFrame()
  sc.addDrawCall()
  sc.endFrame()
  const s2 = sc.snapshot()
  expect(s2.gpuMs).toBe(7.7)
  expect(s2.drawCalls).toBe(1) // новый кадр, обнулён
  expect(s2.memoryEstimate).toBe(1024) // аккумулятор
  expect(s2.frameCount).toBe(2)
})

// ─── GpuTimer idempotent: begin дважды = no-op ───────────────────────────────

test('GpuTimer mock: begin дважды подряд = no-op (не падает)', () => {
  const timer = createMockGpuTimer([5.0])
  // Дважды begin без end между ними
  expect(() => {
    timer.begin()
    timer.begin()
  }).not.toThrow()
  timer.end()
  expect(timer.result()).toBe(5.0)
})

// ─── GpuTimer end без begin = no-op ──────────────────────────────────────────

test('GpuTimer mock: end без begin = no-op', () => {
  const timer = createMockGpuTimer([3.3])
  expect(() => timer.end()).not.toThrow()
  expect(timer.result()).toBe(3.3)
})
