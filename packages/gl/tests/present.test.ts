/**
 * Task 102 (§8-5/§8-6): present.ts — юнит-тесты машины present-путей.
 *
 * Decay/PathRegistry/PathState — чистая логика: окна сэмплов, перцентили,
 * ratio-переходы, каскад селекции, pressure-гейт, фильтры. Реестр
 * канонических путей (§9.7) проверяется на fake-caps (createCaps с
 * paths-картой). Исполнение run-ов — браузерное (e2e smoke-present);
 * здесь — машина состояний и регистрация.
 */

import { describe, expect, it } from 'bun:test'
import { createCaps } from '@rune/core'
import type { Caps, PathSupport } from '@rune/core'
import {
  createDecayWindow,
  createPathRegistry,
  createPresentRegistry,
  DEGRADATION_RATIO,
  DEGRADE_WARN_RATIO,
  DEGRADATION_NOISE_FLOOR_MS,
  DEGRADATION_RECOVERY_MS,
  DEGRADATION_RECOVERY_BACKOFF,
  DEGRADATION_RECOVERY_MAX_MS,
  PRESSURE_HYSTERESIS,
  DEGRADATION_ABSOLUTE_MS,
} from '../src/present.ts'

/** Caps с заданной картой present-путей (всё остальное — пустое). */
function fakeCaps(paths: Record<string, PathSupport>): Caps {
  return createCaps({
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(Object.entries(paths)),
    extensions: new Map(),
    limits: {},
    backend: 'test',
  })
}

/** Полный набор ключей, нужный каноническим путям (все supported). */
function richCaps(): Caps {
  return fakeCaps({
    'canvas-direct': 'supported',
    'blit': 'supported',
    'preserve': 'supported',
    'OffscreenCanvas': 'supported',
    'transferToImageBitmap': 'supported',
    'bitmaprenderer': 'supported',
    'createImageBitmap': 'supported',
    'createImageBitmap.resize': 'supported',
    'Canvas2D': 'supported',
    'WebGPU': 'supported',
    'WebGPU.copyExternalImage': 'supported',
  })
}

/** Мелкий реестр с быстрыми порогами (не ждать 30 сэмплов). */
function smallRegistry() {
  return createPathRegistry({ window: 30, minSamples: 10, warnRatio: 1.2, disableRatio: 1.5 })
}

// ─── DecayWindow ─────────────────────────────────────────────────────────────

describe('createDecayWindow', () => {
  it('равномерные сэмплы → p50 = p95, ratio 1', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 50; i++) w.push(2)
    const s = w.stats()
    expect(s.count).toBe(50)
    expect(s.p50).toBe(2)
    expect(s.p95).toBe(2)
    expect(s.ratio).toBe(1)
  })

  it('шумовой порог: суб-миллисекундные колебания — НЕ деградация', () => {
    // Замер Task 102 (SwiftShader): draw2d p50 0.1 / p95 0.5 мс — «ratio 5»
    // на ничтожных абсолютах. p95 ниже порога → ratio честно 1.
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(0.1)
    for (let i = 0; i < 20; i++) w.push(0.5)
    const s = w.stats()
    expect(s.p95).toBe(0.5)
    expect(s.ratio).toBe(1)
    // настраиваемый порог: приложение, ищущее деградацию на 120 Гц, снижает его
    const hi = createDecayWindow(120, 0.2)
    for (let i = 0; i < 100; i++) hi.push(0.1)
    for (let i = 0; i < 20; i++) hi.push(0.5)
    expect(hi.stats().ratio).toBe(5)
  })

  it('спайки дают ratio ≥ 1.5 (p95/p50 = 30)', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(1)
    for (let i = 0; i < 20; i++) w.push(30)
    const s = w.stats()
    expect(s.p50).toBe(1)
    expect(s.p95).toBe(30)
    expect(s.ratio).toBe(30)
  })

  it('окно вытесняет старые спайки (выздоровление статистики)', () => {
    const w = createDecayWindow(10)
    for (let i = 0; i < 10; i++) w.push(100)
    for (let i = 0; i < 10; i++) w.push(1)
    const s = w.stats()
    expect(s.count).toBe(10)
    expect(s.p50).toBe(1)
    expect(s.p95).toBe(1)
    expect(s.ratio).toBe(1)
  })

  it('дельта-гард (Task 104): спайк p95 − p50 < порога — шум планировщика, не деградация', () => {
    // Замер Mali: живой путь p50 6 / p95 7.4 мс — «ratio 1.23» на джиттере
    // асинхронного планировщика; дельта 1.4 мс не съедает бюджет кадра ни на
    // 60, ни на 120 Гц → ratio 1, путь жив.
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(6)
    for (let i = 0; i < 20; i++) w.push(7.4)
    const s = w.stats()
    expect(s.p50).toBe(6)
    expect(s.p95).toBe(7.4)
    expect(s.ratio).toBe(1)
    // настоящий спайк (дельта 9 мс ≥ 2) — честный ratio 2.5
    const real = createDecayWindow(120)
    for (let i = 0; i < 100; i++) real.push(6)
    for (let i = 0; i < 20; i++) real.push(15)
    expect(real.stats().ratio).toBe(2.5)
    // порог настраиваем: приложение с 120 Гц-бюджетом ловит и мелкие дельты
    const fine = createDecayWindow(120, 0.5)
    for (let i = 0; i < 100; i++) fine.push(6)
    for (let i = 0; i < 20; i++) fine.push(7.4)
    expect(fine.stats().ratio).toBeCloseTo(7.4 / 6, 5)
  })

  it('p50 = 0 (квантование таймера): знаменатель — 1 мс', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(0)
    for (let i = 0; i < 10; i++) w.push(8)
    expect(w.stats().ratio).toBe(8) // спайк над нулевым полом — сигнал
    const q = createDecayWindow(120)
    for (let i = 0; i < 100; i++) q.push(0)
    for (let i = 0; i < 10; i++) q.push(1)
    expect(q.stats().ratio).toBe(1) // шум квантования — не деградация
  })
})

// ─── PathRegistry: селекция ──────────────────────────────────────────────────

describe('PathRegistry.select', () => {
  it('пустой реестр → null', () => {
    expect(createPathRegistry().select(richCaps())).toBeNull()
  })

  it('ранг решает: меньший ранг выбирается первым', () => {
    const r = createPathRegistry()
    r.add('a', { rank: 20, run: () => {} })
    r.add('b', { rank: 10, run: () => {} })
    expect(r.select(richCaps())?.name).toBe('b')
  })

  it('без явного ранга — порядок добавления', () => {
    const r = createPathRegistry()
    r.add('first', { run: () => {} })
    r.add('second', { run: () => {} })
    expect(r.select(richCaps())?.name).toBe('first')
  })

  it('requires строкой: ключ не supported → unavailable, каскад дальше', () => {
    const caps = richCaps()
    const r = createPathRegistry()
    r.add('gated', { requires: 'Canvas2D', rank: 10, run: () => {} })
    r.add('fallback', { rank: 20, run: () => {} })
    const gated = fakeCaps({ 'Canvas2D': 'unsupported' })
    expect(r.select(gated)?.name).toBe('fallback')
    expect(r.status('gated').status).toBe('unavailable')
    expect(r.status('gated').reason).toContain('requirements')
    expect(r.status('gated').reason).toContain('Canvas2D')
    expect(r.select(caps)?.name).toBe('gated') // predicate not needed: same caps object family
  })

  it('requires списком: один мёртвый ключ → unavailable', () => {
    const r = createPathRegistry()
    r.add('bitmap-like', { requires: ['OffscreenCanvas', 'transferToImageBitmap', 'bitmaprenderer'], rank: 10, run: () => {} })
    const caps = fakeCaps({ 'OffscreenCanvas': 'supported', 'transferToImageBitmap': 'unsupported', 'bitmaprenderer': 'supported' })
    expect(r.select(caps)).toBeNull()
    expect(r.status('bitmap-like').reason).toContain('transferToImageBitmap')
  })

  it('requires предикатом: полный контроль', () => {
    const r = createPathRegistry()
    const calls: string[] = []
    r.add('pred', { requires: caps => { calls.push(caps.backend); return caps.path('blit') === 'supported' }, rank: 10, run: () => {} })
    expect(r.select(fakeCaps({ 'blit': 'unsupported' }))).toBeNull()
    expect(r.select(fakeCaps({ 'blit': 'supported' }))?.name).toBe('pred')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('путь без run не выбирается; includeRunless разрешает', () => {
    const r = createPathRegistry()
    r.add('runless', { rank: 1, note: 'знание реестра' })
    r.add('runner', { rank: 2, run: () => {} })
    expect(r.select(richCaps())?.name).toBe('runner')
    expect(r.select(richCaps(), 0, { includeRunless: true })?.name).toBe('runless')
  })

  it('pressureMax: путь отпадает при давлении, возвращается без', () => {
    const r = createPathRegistry()
    r.add('cheap-under-pressure', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('always', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('always')
    expect(r.select(richCaps(), 0)?.name).toBe('cheap-under-pressure')
    expect(r.select(richCaps(), 0.6)?.name).toBe('cheap-under-pressure') // граница включительно
  })

  it('filter — структурное исключение (сценарий приложения)', () => {
    const r = createPathRegistry()
    r.add('direct', { rank: 10, run: () => {} })
    r.add('bitmap', { rank: 50, run: () => {} })
    const offscreenScenario = (name: string): boolean => name !== 'direct'
    expect(r.select(richCaps(), 0, { filter: offscreenScenario })?.name).toBe('bitmap')
  })

  it('unavailable оживает, когда caps улучшается (invalidate → re-probe)', () => {
    const r = createPathRegistry()
    r.add('draw2d', { requires: 'Canvas2D', rank: 10, run: () => {} })
    r.add('any', { rank: 20, run: () => {} })
    expect(r.select(fakeCaps({ 'Canvas2D': 'unsupported' }))?.name).toBe('any')
    expect(r.status('draw2d').status).toBe('unavailable')
    expect(r.select(fakeCaps({ 'Canvas2D': 'supported' }))?.name).toBe('draw2d')
    expect(r.status('draw2d').status).toBe('healthy')
  })

  it('remove убирает путь из селекции', () => {
    const r = createPathRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    r.remove('a')
    expect(r.select(richCaps())?.name).toBe('b')
    expect(r.names).toEqual(['b'])
  })

  it('add-замена сбрасывает состояние и ранг', () => {
    const r = createPathRegistry()
    r.add('x', { rank: 1, run: () => {} })
    r.disable('x')
    expect(r.status('x').status).toBe('disabled')
    r.add('x', { rank: 5, run: () => {} })
    expect(r.status('x').status).toBe('healthy')
    expect(r.status('x').rank).toBe(5)
  })
})

// ─── PathRegistry.select: последний рубеж (Task 104) ──────────────────────

describe('PathRegistry.select — lastResort', () => {
  function allDead(): ReturnType<typeof createPathRegistry> {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('best', { rank: 10, run: () => {} })
    r.add('middle', { rank: 20, run: () => {} })
    for (const name of ['best', 'middle']) {
      for (let i = 0; i < 10; i++) r.report(name, 1)
      for (let i = 0; i < 10; i++) r.report(name, 30) // ratio 30 → disabled
    }
    return r
  }

  it('по умолчанию все отключены → null (прежняя семантика)', () => {
    expect(allDead().select(richCaps())).toBeNull()
  })

  it('lastResort: лучший disabled вместо null — показ важнее качества', () => {
    const sel = allDead().select(richCaps(), 0, { lastResort: true })
    expect(sel?.name).toBe('best') // меньший ранг даже среди отключённых
    expect(sel?.state.status).toBe('disabled') // статус честный — потребитель решает
  })

  it('lastResort не обходят unavailable', () => {
    const r = allDead()
    r.add('unavail', { rank: 5, requires: 'Canvas2D', run: () => {} })
    const caps = fakeCaps({ 'Canvas2D': 'unsupported' })
    const sel = r.select(caps, 0, { lastResort: true })
    expect(sel?.name).toBe('best') // недоступный ранг 5 не выбирается даже последним рубежом
  })

  it('lastResort уважает фильтр и pressure-гейт (с гистерезисом Task 106)', () => {
    const r = allDead()
    expect(r.select(richCaps(), 0, { lastResort: true, filter: n => n !== 'best' })?.name).toBe('middle')
    expect(r.select(richCaps(), 0, { lastResort: true, filter: () => false })).toBeNull()
    const gated = createPathRegistry({ window: 30, minSamples: 10 })
    gated.add('pressured', { rank: 10, pressureMax: 0.6, run: () => {} })
    gated.disable('pressured', 'оператор')
    expect(gated.select(richCaps(), 0.7, { lastResort: true })).toBeNull() // давление — политика приложения
    expect(gated.select(richCaps(), 0.5, { lastResort: true })).toBeNull() // полоса гистерезиса: решение держится
    expect(gated.select(richCaps(), 0.4, { lastResort: true })?.name).toBe('pressured') // 0.4 ≤ 0.6 − 0.15 — возврат
  })

  it('lastResort не возвращает путь без run', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('runless', { rank: 1 })
    r.disable('runless')
    expect(r.select(richCaps(), 0, { lastResort: true })).toBeNull()
  })

  it('живой путь предпочтительнее последнего рубежа (не «выключает» здоровое)', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('dead', { rank: 5, run: () => {} })
    r.disable('dead')
    r.add('alive', { rank: 50, run: () => {} })
    expect(r.select(richCaps(), 0, { lastResort: true })?.name).toBe('alive')
  })
})

// ─── PathState: деградация ───────────────────────────────────────────────────

describe('PathRegistry.report — деградационная машина', () => {
  it('спайки ratio ≥ 1.5 → disabled, селекция каскадом уходит дальше', () => {
    const r = smallRegistry()
    r.add('best', { rank: 10, run: () => {} })
    r.add('next', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('best', 1)
    expect(r.select(richCaps())?.name).toBe('best')
    for (let i = 0; i < 10; i++) r.report('best', 30) // p50=1, p95=30 → ratio 30
    const st = r.status('best')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('degradation')
    expect(st.ratio).toBe(30)
    expect(r.select(richCaps())?.name).toBe('next')
  })

  it('degraded-зона (1.2 ≤ ratio < 1.5): healthy-путь предпочтительнее', () => {
    const r = smallRegistry()
    r.add('wobbly', { rank: 10, run: () => {} })
    r.add('stable', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('wobbly', 10)
    for (let i = 0; i < 10; i++) r.report('wobbly', 13) // p50=10, p95=13 → 1.3
    expect(r.status('wobbly').status).toBe('degraded')
    expect(r.select(richCaps())?.name).toBe('stable') // healthy优先
  })

  it('degraded выбирается, когда healthy нет (последний шанс)', () => {
    const r = smallRegistry()
    r.add('only', { rank: 10, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('only', 10)
    for (let i = 0; i < 10; i++) r.report('only', 13)
    expect(r.status('only').status).toBe('degraded')
    expect(r.select(richCaps())?.name).toBe('only')
  })

  it('до minSamples переходов нет (ранняя статистика шумная)', () => {
    const r = smallRegistry() // minSamples 10
    r.add('early', { rank: 10, run: () => {} })
    for (let i = 0; i < 9; i++) r.report('early', 50)
    expect(r.status('early').status).toBe('healthy')
  })

  it('sub-noise-floor отчёты не отключают путь, даже «ratio» велик', () => {
    const r = smallRegistry()
    r.add('cheap', { rank: 10, run: () => {} })
    for (let i = 0; i < 40; i++) r.report('cheap', 0.1)
    for (let i = 0; i < 20; i++) r.report('cheap', 0.9) // p95 0.9 < 2 мс
    expect(r.status('cheap').status).toBe('healthy')
  })

  it('disabled sticky на уровне report(): чистые кадры не лечат — лечат срок/reset', () => {
    const r = smallRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('a', 1)
    for (let i = 0; i < 10; i++) r.report('a', 30)
    expect(r.status('a').status).toBe('disabled')
    for (let i = 0; i < 30; i++) r.report('a', 1) // чистые кадры
    expect(r.status('a').status).toBe('disabled') // sticky: вердикт меняют только испытательный срок (select + время) и reset()
    r.reset('a')
    expect(r.status('a').status).toBe('healthy')
    expect(r.status('a').samples).toBe(0)
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('ручной disable с причиной + полный reset()', () => {
    const r = smallRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    r.disable('a', 'оператор: артефакты композитора')
    expect(r.status('a').status).toBe('disabled')
    expect(r.status('a').reason).toContain('оператор')
    expect(r.select(richCaps())?.name).toBe('b')
    r.reset()
    expect(r.status('a').status).toBe('healthy')
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('report/status/disable на незарегистрированном пути — throw', () => {
    const r = createPathRegistry()
    expect(() => r.report('ghost', 1)).toThrow()
    expect(() => r.status('ghost')).toThrow()
    expect(() => r.disable('ghost')).toThrow()
  })

  it('snapshot: все пути по рангу с полной статистикой', () => {
    const r = smallRegistry()
    r.add('b', { rank: 20, run: () => {}, group: 'G2', note: 'n2' })
    r.add('a', { rank: 10, run: () => {}, group: 'G1', pressureMax: 0.6 })
    for (let i = 0; i < 12; i++) r.report('a', 1)
    const snap = r.snapshot()
    expect(snap.map(s => s.name)).toEqual(['a', 'b'])
    expect(snap[0]!.samples).toBe(12)
    expect(snap[0]!.pressureMax).toBe(0.6)
    expect(snap[1]!.group).toBe('G2')
    expect(snap[1]!.note).toBe('n2')
    expect(r.names).toEqual(['a', 'b'])
  })
})

// ─── onTransition: телеметрия переходов (Task 104) ─────────────────────

describe('PathRegistry — onTransition', () => {
  interface Mark { readonly name: string; readonly from: string; readonly to: string }

  it('report: healthy → degraded → disabled с полной статистикой перехода', () => {
    const marks: Mark[] = []
    const r = createPathRegistry({
      window: 30,
      minSamples: 10,
      onTransition: t => { marks.push({ name: t.name, from: t.from, to: t.to }) },
    })
    r.add('p', { rank: 1, run: () => {} })
    for (let i = 0; i < 10; i++) r.report('p', 10)
    for (let i = 0; i < 10; i++) r.report('p', 13) // ratio 1.3 → degraded
    for (let i = 0; i < 10; i++) r.report('p', 30) // ratio → disabled
    // Машина честна к переходному процессу окна: на 21-м кадре p95 ещё «не
    // дотянулся» до единственного нового спайка (13/13 → ratio 1 → здоров),
    // на 22-м спайк входит в p95 (30/13 = 2.31 ≥ 1.5) — сразу disabled.
    // Журнал переходов показывает и этот миг — телеметрия без прикрас.
    expect(marks).toEqual([
      { name: 'p', from: 'healthy', to: 'degraded' },
      { name: 'p', from: 'degraded', to: 'healthy' },
      { name: 'p', from: 'healthy', to: 'disabled' },
    ])
    // состояние в переходе — на момент ПОСЛЕ (disabled уже виден)
    const r2 = createPathRegistry({
      window: 30,
      minSamples: 10,
      onTransition: t => {
        if (t.to === 'disabled') {
          expect(t.state.status).toBe('disabled')
          expect(t.state.ratio).toBeGreaterThanOrEqual(1.5)
          expect(t.state.reason).toContain('degradation')
        }
      },
    })
    r2.add('q', { rank: 1, run: () => {} })
    for (let i = 0; i < 10; i++) r2.report('q', 1)
    for (let i = 0; i < 10; i++) r2.report('q', 30)
  })

  it('повторный report без смены статуса — НЕ событие (только reason освежается)', () => {
    let fired = 0
    const r = createPathRegistry({ window: 30, minSamples: 10, onTransition: () => { fired++ } })
    r.add('p', { rank: 1, run: () => {} })
    for (let i = 0; i < 40; i++) r.report('p', 5) // здоровые кадры — ноль переходов
    expect(fired).toBe(0)
  })

  it('disable/reset/select-доступность тоже дают переходы', () => {
    const marks: Mark[] = []
    const r = createPathRegistry({ onTransition: t => { marks.push({ name: t.name, from: t.from, to: t.to }) } })
    r.add('a', { requires: 'Canvas2D', rank: 1, run: () => {} })
    const capsOff = fakeCaps({ 'Canvas2D': 'unsupported' })
    const capsOn = fakeCaps({ 'Canvas2D': 'supported' })
    r.select(capsOff) // → unavailable
    r.select(capsOn) // → healthy (ожил)
    r.disable('a', 'оператор')
    r.reset('a') // → healthy
    expect(marks).toEqual([
      { name: 'a', from: 'healthy', to: 'unavailable' },
      { name: 'a', from: 'unavailable', to: 'healthy' },
      { name: 'a', from: 'healthy', to: 'disabled' },
      { name: 'a', from: 'disabled', to: 'healthy' },
    ])
  })
})

// ─── Испытательный срок (Task 105: полевой фидбек «отсеклись навсегда») ─────

describe('PathRegistry — испытательный срок (авто-восстановление)', () => {
  interface Mark { readonly name: string; readonly from: string; readonly to: string; readonly reason: string | null }

  /** Реестр с фейковыми часами: отключение → ход времени → select(). */
  function rig(opts?: { recoveryMs?: number; recoveryMaxMs?: number; recoveryBackoff?: number }) {
    let t = 0
    const marks: Mark[] = []
    const r = createPathRegistry({
      window: 30,
      minSamples: 10,
      recoveryMs: opts?.recoveryMs,
      recoveryMaxMs: opts?.recoveryMaxMs,
      recoveryBackoff: opts?.recoveryBackoff,
      now: () => t,
      onTransition: tr => { marks.push({ name: tr.name, from: tr.from, to: tr.to, reason: tr.state.reason }) },
    })
    return {
      r,
      marks,
      advance: (ms: number) => { t += ms },
      /** ratio 30 (10×1 + 10×30) → disabled на текущих фейковых часах. */
      kill: (name: string) => {
        for (let i = 0; i < 10; i++) r.report(name, 1)
        for (let i = 0; i < 10; i++) r.report(name, 30)
        if (r.status(name).status !== 'disabled') throw new Error(`rig: ${name} не отключился`)
      },
    }
  }

  it('degradation-отключение лечится временем: прошедший cooldown select() ре-армит путь', () => {
    const { r, advance, kill, marks } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(4999) // мс — на секунду раньше срока
    expect(r.select(richCaps())).toBeNull() // ещё disabled, живых нет
    advance(2) // 5001 ≥ 5000
    const sel = r.select(richCaps())
    expect(sel?.name).toBe('a')
    expect(sel?.state.status).toBe('healthy')
    expect(sel?.state.samples).toBe(0) // окно свежее — старый джанк не тянется
    expect(sel?.state.reason).toContain('испытательный срок')
    const last = marks[marks.length - 1]!
    expect(`${last.from} → ${last.to}`).toBe('disabled → healthy')
    expect(last.reason).toContain('повторная проба после 5 с')
  })

  it('лестница ожидания: рецидив удваивает cooldown (анти-флаппер)', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a') // cooldown 5 с
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // испытательный срок №1
    kill('a') // рецидив → cooldown 10 с
    advance(5000)
    expect(r.select(richCaps())).toBeNull() // рано: ждал 5 из 10 с
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // испытательный срок №2
  })

  it('потолок лестницы: ожидание не растёт бесконечно', () => {
    const { r, advance, kill } = rig({ recoveryMs: 40000 }) // рецидив: 80 с → потолок 60 с
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(40000)
    expect(r.select(richCaps())?.name).toBe('a')
    kill('a') // 40000 × 2 = 80000, но потолок 60000
    advance(59999)
    expect(r.select(richCaps())).toBeNull()
    advance(1) // ровно 60000
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('чистое полное окно после срока — лестница начинается заново', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // probations = 1
    for (let i = 0; i < 30; i++) r.report('a', 1) // полное чистое окно → репутация чиста
    kill('a') // если бы лестница помнила рецидив — cooldown 10 с
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // а он снова 5 с
  })

  it('ручной disable() — навсегда: время не лечит решение оператора', () => {
    const { r, advance, marks } = rig()
    r.add('a', { rank: 10, run: () => {} })
    r.disable('a') // без причины = manual
    advance(10_000_000) // хоть три месяца
    expect(r.select(richCaps())).toBeNull()
    expect(r.status('a').status).toBe('disabled')
    expect(marks.filter(m => m.to === 'healthy')).toHaveLength(0) // ни одного испытательного срока
    expect(r.select(richCaps(), 0, { lastResort: true })?.name).toBe('a') // но последний рубеж его даёт
  })

  it('disable с причиной (ошибка исполнения) — временный вердикт: срок оживит', () => {
    const { r, advance } = rig()
    r.add('a', { rank: 10, run: () => {} })
    r.disable('a', 'ошибка исполнения: createImageBitmap отказал под давлением памяти')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // транзитная ошибка могла пройти
  })

  it('recoveryMs: Infinity — прежняя sticky-семантика (отключён навсегда до reset)', () => {
    const { r, advance, kill } = rig({ recoveryMs: Number.POSITIVE_INFINITY })
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(10_000_000)
    expect(r.select(richCaps())).toBeNull()
    expect(r.status('a').status).toBe('disabled')
    r.reset()
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('статистика последнего рубежа живая: сэмплы пишутся и отключённому', () => {
    const { r, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a') // в окне 10×1 + 10×30
    for (let i = 0; i < 30; i++) r.report('a', 1) // джанк давно кончился — путь-то быстрый
    const st = r.status('a')
    expect(st.status).toBe('disabled') // вердикт sticky…
    expect(st.samples).toBe(30) // …но статистика живая: окно уже чистое
    expect(st.p50).toBe(1)
    expect(st.p95).toBe(1)
  })

  it('испытательный срок не обходит фильтр/давление: путь healthy, но не выбирается', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    kill('a')
    advance(5000)
    const sel = r.select(richCaps(), 0.7) // давление режет и здорового
    expect(sel?.name).toBe('b')
    expect(r.status('a').status).toBe('healthy') // срок отработал — путь готов вернуться
    expect(r.select(richCaps(), 0.5)?.name).toBe('b') // полоса гистерезиса — решение держится (Task 106)
    expect(r.select(richCaps(), 0.4)?.name).toBe('a') // 0.4 ≤ 0.45 — лучший ранг снова в деле
  })

  it('reset() чистит и лестницу: после сброса первое отключение снова ждёт базу', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a')
    kill('a') // рецидив: 10 с
    r.reset()
    expect(r.status('a').status).toBe('healthy')
    kill('a') // после reset — снова базовые 5 с
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a')
  })
})

// ─── Канонический реестр (§9.7) ──────────────────────────────────────────────

describe('createPresentRegistry', () => {
  const CANONICAL = [
    'direct', 'wgpu-direct', 'blit', 'wgpu-copy', 'quadcopy', 'quadpass',
    'uvremap', 'bitmap', 'asyncbmp', 'multibmp4', 'draw2d', 'multi4',
    'preserve', 'draw2d-half', 'scaled-half',
  ] as const

  it('все 15 путей §9.7 по рангу; GL-внутренние без run', () => {
    const r = createPresentRegistry()
    expect(r.names).toEqual([...CANONICAL])
    const runless = r.snapshot().filter(s => !s.hasRun).map(s => s.name)
    expect(runless).toEqual(['blit', 'quadcopy', 'quadpass', 'uvremap'])
  })

  it('полный caps → direct (ранг 10, ноль копий)', () => {
    const r = createPresentRegistry()
    expect(r.select(richCaps())?.name).toBe('direct')
  })

  it('сценарий «офскрин-источник → зрители»: GL-внутренние отфильтрованы → bitmap', () => {
    const r = createPresentRegistry()
    const offscreenOnly = (name: string): boolean =>
      !['direct', 'wgpu-direct', 'blit', 'wgpu-copy', 'quadcopy', 'quadpass', 'uvremap'].includes(name)
    expect(r.select(richCaps(), 0, { filter: offscreenOnly })?.name).toBe('bitmap')
  })

  it('среда без OffscreenCanvas: bitmap/asyncbmp/scaled-half unavailable → draw2d', () => {
    const r = createPresentRegistry()
    const caps = fakeCaps({
      'canvas-direct': 'supported',
      'blit': 'supported',
      'preserve': 'supported',
      'Canvas2D': 'supported',
      'createImageBitmap': 'unsupported',
      'OffscreenCanvas': 'unsupported',
      'transferToImageBitmap': 'unsupported',
      'bitmaprenderer': 'unsupported',
      'WebGPU': 'unsupported',
      'WebGPU.copyExternalImage': 'unsupported',
    })
    const offscreenOnly = (name: string): boolean => !['direct', 'blit', 'quadcopy', 'quadpass', 'uvremap'].includes(name)
    const sel = r.select(caps, 0, { filter: offscreenOnly })
    expect(sel?.name).toBe('draw2d')
    expect(r.status('bitmap').status).toBe('unavailable')
    expect(r.status('asyncbmp').status).toBe('unavailable')
    expect(r.status('scaled-half').status).toBe('unavailable')
  })

  it('давление 0.7 отрезает multibmp4/multi4 (pressureMax 0.6) — выбор ниже по рангу', () => {
    const r = createPresentRegistry()
    const onlyMulti = (name: string): boolean => name === 'multibmp4' || name === 'multi4' || name === 'draw2d'
    expect(r.select(richCaps(), 0, { filter: onlyMulti })?.name).toBe('multibmp4')
    expect(r.select(richCaps(), 0.7, { filter: onlyMulti })?.name).toBe('draw2d')
  })

  it('пример §9.7 (Mali): preserve с p95/p50 = 3.0 → disabled, выбор уходит в draw2d', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10, warnRatio: 1.2, disableRatio: 1.5 })
    // воспроизводим два конкурирующих пути канона: preserve (ранг 80) против draw2d (ранг 70)
    r.add('draw2d', { requires: 'Canvas2D', rank: 70, run: () => {} })
    r.add('preserve', { requires: ['preserve', 'Canvas2D'], rank: 80, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('preserve', 1)
    for (let i = 0; i < 10; i++) r.report('preserve', 3) // p50=1, p95=3 → ratio 3.0
    expect(r.status('preserve').status).toBe('disabled')
    expect(r.status('preserve').ratio).toBe(3)
    const caps = fakeCaps({ 'Canvas2D': 'supported', 'preserve': 'supported' })
    expect(r.select(caps)?.name).toBe('draw2d')
  })

  it('константы Контракта 1 на месте (§7-уточнение 1 + испытательный срок + Task 106)', () => {
    expect(DEGRADATION_RATIO).toBe(1.5)
    expect(DEGRADE_WARN_RATIO).toBe(1.2)
    expect(DEGRADATION_NOISE_FLOOR_MS).toBe(2)
    expect(DEGRADATION_RECOVERY_MS).toBe(5000)
    expect(DEGRADATION_RECOVERY_BACKOFF).toBe(2)
    expect(DEGRADATION_RECOVERY_MAX_MS).toBe(60000)
    expect(PRESSURE_HYSTERESIS).toBe(0.15)
    expect(DEGRADATION_ABSOLUTE_MS).toBe(50)
  })
})

// ─── Гистерезис давления (Task 106: полевой журнал Mali — дребезг границы 0.6) ─

describe('PathRegistry — гистерезис давления (Task 106)', () => {
  it('отсечение > max, в полосе [max−hyst, max] решение держится, возврат ≤ max−hyst', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('cheap') // отсечён
    expect(r.select(richCaps(), 0.6)?.name).toBe('cheap') // полоса: держим (прежде — мгновенный возврат)
    expect(r.select(richCaps(), 0.5)?.name).toBe('cheap') // полоса: держим
    expect(r.select(richCaps(), 0.44)?.name).toBe('dear') // ниже возвратной границы 0.6 − 0.15 ≈ 0.45
    expect(r.select(richCaps(), 0.55)?.name).toBe('dear') // снова не режем до > 0.6
  })

  it('дребезг границы 0.6↔0.7 больше не мечет селекцию (жалоба Mali дословно)', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    const picks: string[] = []
    for (const p of [0.7, 0.6, 0.7, 0.6, 0.7, 0.6]) {
      picks.push(r.select(richCaps(), p)?.name ?? 'null')
    }
    expect(picks).toEqual(['cheap', 'cheap', 'cheap', 'cheap', 'cheap', 'cheap'])
  })

  it('applyPressure — авторитетные переходы cut/returned (idempotent)', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('mid', { rank: 15, pressureMax: 0.8, run: () => {} })
    expect(r.applyPressure(0.7).map(t => `${t.name}:${t.to}`)).toEqual(['dear:cut'])
    expect(r.applyPressure(0.7)).toEqual([]) // тот же pressure — без событий
    expect(r.applyPressure(0.85).map(t => `${t.name}:${t.to}`)).toEqual(['mid:cut'])
    // 0.6: dear в полосе [0.45, 0.6] — держит отсечение; mid уже ниже своей
    // возвратной границы 0.8 − 0.15 = 0.65 — возвращается (у каждого пути СВОЯ полоса)
    expect(r.applyPressure(0.6).map(t => `${t.name}:${t.to}`)).toEqual(['mid:returned'])
    expect(r.applyPressure(0.4).map(t => `${t.name}:${t.to}`)).toEqual(['dear:returned'])
    expect(r.status('dear').pressureCut).toBe(false)
    expect(r.status('mid').pressureCut).toBe(false)
  })

  it('ignorePressure (форс оператора): гейт не применяется к выбору, флаги живут', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.select(richCaps(), 0.7) // отсечён
    expect(r.status('dear').pressureCut).toBe(true)
    const sel = r.select(richCaps(), 0.7, { filter: n => n === 'dear', ignorePressure: true })
    expect(sel?.name).toBe('dear') // оператор важнее гейта
    expect(r.status('dear').pressureCut).toBe(true) // флаг продолжает жить по реальному давлению
    expect(r.select(richCaps(), 0.7, { filter: n => n === 'dear' })).toBeNull() // без ignore — гейт снова действует
  })

  it('pressureHysteresis: 0 — прежняя мгновенная семантика возврата', () => {
    const r = createPathRegistry({ pressureHysteresis: 0 })
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('cheap')
    expect(r.select(richCaps(), 0.6)?.name).toBe('dear') // мгновенный возврат (0.6 ≤ 0.6 − 0)
  })

  it('lastResort + ignorePressure: форс отключённого пути под давлением — показ важнее', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('forced', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.disable('forced', 'оператор')
    expect(r.select(richCaps(), 0.9, { filter: n => n === 'forced', lastResort: true, ignorePressure: true })?.name).toBe('forced')
  })
})

// ─── Абсолютная медленность (Task 106: ratio слеп к равномерно-медленному) ────

describe('PathRegistry — абсолютная медленность (Task 106)', () => {
  it('равномерно медленный p50 ≥ 50 мс → disabled, хотя ratio 1.00 (полевой кадр multi4)', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('slowborn', { rank: 10, run: () => {} })
    r.add('fast', { rank: 20, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slowborn', 70) // путь родился в джанке — чистой базы нет
    const st = r.status('slowborn')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('абсолютная медленность')
    expect(st.ratio).toBe(1)
    expect(st.p50).toBe(70)
    expect(r.select(richCaps())?.name).toBe('fast') // каскад ушёл к быстрым
  })

  it('равномерно медленный, но в пределах потолка (40 мс) — терпим', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('ok', { rank: 10, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('ok', 40)
    expect(r.status('ok').status).toBe('healthy') // ниже потолка; переход (если будет) ловит ratio
  })

  it('смешанное окно (чистый p50 + джанковый p95) — ведёт ratio, не абсолют', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('drain', { rank: 10, run: () => {} })
    for (let i = 0; i < 25; i++) r.report('drain', 0.2)
    for (let i = 0; i < 5; i++) r.report('drain', 200)
    const st = r.status('drain')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('degradation') // p50 чистый — абсолют молчит, ведёт ratio
  })

  it('absoluteMaxMs: Infinity — вердикт выключен', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10, absoluteMaxMs: Number.POSITIVE_INFINITY })
    r.add('slow', { rank: 10, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slow', 70)
    expect(r.status('slow').status).toBe('healthy')
  })

  it('абсолютный вердикт лечится испытательным сроком: среда нормализовалась — путь вернулся', () => {
    let t = 0
    const r = createPathRegistry({ window: 30, minSamples: 10, recoveryMs: 5000, now: () => t })
    r.add('slow', { rank: 10, run: () => {} })
    r.add('fast', { rank: 20, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slow', 70)
    expect(r.status('slow').status).toBe('disabled')
    t = 5000
    const sel = r.select(richCaps())
    expect(sel?.name).toBe('slow') // испытательный срок — свежее окно
    expect(sel?.state.reason).toContain('испытательный срок')
    for (let i = 0; i < 10; i++) r.report('slow', 1) // среда нормализовалась
    expect(r.status('slow').status).toBe('healthy')
    expect(r.status('slow').reason).toBeNull()
  })
})
