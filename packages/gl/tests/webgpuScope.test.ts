import { describe, expect, it, beforeEach } from 'bun:test'
import {
  webgpuAvailability,
  probeWebgpuScope,
  reportWebgpuMainFact,
  reportWebgpuWorkerFact,
  combineWebgpuScope,
  describeWebgpuScope,
  WEBUGPU_PROBE_SRC,
  WEBUGPU_PROBE_MARKER,
} from '../src/index.ts'
import { _resetWebgpuScopeForTests } from '../src/webgpuScope.ts'

/**
 * Task 78: скоуп доступности WebGPU — свойство/геттер ДО инициализации.
 *
 * Контракт:
 *   - webgpuAvailability() — синхронный снимок фактов: main-факт мгновенно,
 *     worker-факт null, пока не выяснен; БЕЗ GPU-инициализации;
 *   - probeWebgpuScope() — микро-проба воркера (blob-Worker, только
 *     navigator.gpu, НИКАКОГО requestAdapter), кэш + дедуп;
 *   - reportWebgpuWorkerFact/MainFact — инъекция внешних фактов;
 *   - скоуп = чистая комбинация фактов, никогда не «додумывается».
 *
 * bun-окружение: это НЕ главный поток браузера (document нет, navigator.gpu
 * нет) — как раз честный кейс «снапшот вне main»: main-факт только через
 * reportWebgpuMainFact. Blob-воркеры в bun работают (проверено) — микро-проба
 * исполняется по-настоящему.
 */

describe('webgpuScope — чистая комбинация фактов', () => {
  it('combineWebgpuScope: все четыре состояния + null при нехватке фактов', () => {
    expect(combineWebgpuScope(true, true)).toBe('everywhere')
    expect(combineWebgpuScope(true, false)).toBe('main-only')
    expect(combineWebgpuScope(false, true)).toBe('worker-only')
    expect(combineWebgpuScope(false, false)).toBe('nowhere')
    expect(combineWebgpuScope(null, true)).toBe(null)
    expect(combineWebgpuScope(true, null)).toBe(null)
    expect(combineWebgpuScope(null, null)).toBe(null)
  })
})

describe('webgpuScope — синхронный снимок (до инициализации)', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('webgpuAvailability(): мгновенно, без GPU-работы, без исключений', () => {
    const a = webgpuAvailability()
    expect(typeof a.here).toBe('boolean')
    expect(typeof a.mainThread).toBe('boolean')
    // bun — не браузерный main: document нет → факт main неизвестен, пока не сообщат
    expect(a.mainThread).toBe(false)
    expect(a.main).toBe(null)
    expect(a.worker).toBe(null)
    expect(a.scope).toBe(null)
    expect(a.workerProbe).toBe('idle')
  })

  it('снапшот в bun: navigator.gpu здесь нет → here=false (без додумываний)', () => {
    expect(webgpuAvailability().here).toBe(false)
  })

  it('инъекция фактов: reportMain + reportWorker → скоуп сразу, синхронно', () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(false)
    const a = webgpuAvailability()
    expect(a.main).toBe(true)
    expect(a.worker).toBe(false)
    expect(a.scope).toBe('main-only')
    expect(a.workerProbe).toBe('external')
  })

  it('отсутствие WebGPU везде → nowhere (машина без WebGPU)', () => {
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(false)
    expect(webgpuAvailability().scope).toBe('nowhere')
  })

  it('главный без API + воркер с API → worker-only (редкая, но честная конфигурация)', () => {
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(true)
    expect(webgpuAvailability().scope).toBe('worker-only')
  })

  it('частичный факт не даёт скоупа: только main', () => {
    reportWebgpuMainFact(true)
    const a = webgpuAvailability()
    expect(a.scope).toBe(null)
    expect(a.worker).toBe(null)
  })
})

describe('webgpuScope — микро-проба воркера', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('probeWebgpuScope(): настоящий blob-воркер, факт boolean, кэш навсегда', async () => {
    reportWebgpuMainFact(true)
    const a = await probeWebgpuScope()
    // bun-воркер: navigator.gpu отсутствует → worker=false → main-only
    expect(a.worker).toBe(false)
    expect(a.scope).toBe('main-only')
    expect(a.workerProbe).toBe('done')
    // Кэш: повторный вызов синхронно-мгновенный, тот же факт
    const again = await probeWebgpuScope()
    expect(again.worker).toBe(false)
    expect(again.scope).toBe('main-only')
    // Кэш виден и в синхронном снимке (свойство-геттер)
    expect(webgpuAvailability().scope).toBe('main-only')
  })

  it('параллельные вызовы дедупятся (один воркер, одинаковый вердикт)', async () => {
    reportWebgpuMainFact(false)
    const [a, b] = await Promise.all([probeWebgpuScope(), probeWebgpuScope()])
    expect(a.worker).toBe(false)
    expect(b.worker).toBe(false)
    expect(a.scope).toBe('nowhere')
    expect(b.scope).toBe('nowhere')
  })

  it('проба после внешнего факта — мгновенный возврат без воркера', async () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(true)
    const a = await probeWebgpuScope()
    expect(a.scope).toBe('everywhere')
    expect(a.workerProbe).toBe('external')
  })

  it('таймаут: проба с 0мс не виснет, вердикт честно «неизвестен»', async () => {
    reportWebgpuMainFact(true)
    const a = await probeWebgpuScope({ timeoutMs: 0 })
    // 0мс: таймер срабатывает до/вместо ответа воркера — факт не выдуман
    expect(a.main).toBe(true)
    if (a.worker === null) {
      expect(a.scope).toBe(null)
      expect(a.workerProbe === 'timeout' || a.workerProbe === 'done').toBe(true)
    } else {
      expect(a.worker).toBe(false)
    }
  })
})

describe('webgpuScope — честные формулировки', () => {
  beforeEach(() => _resetWebgpuScopeForTests())

  it('описания различают потоки и не экстраполируют (урок Task 77)', () => {
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(false)
    const text = describeWebgpuScope(webgpuAvailability())
    expect(text).toContain('только в главном потоке')
    expect(text).toContain('воркерам navigator.gpu не выдан')

    _resetWebgpuScopeForTests()
    reportWebgpuMainFact(false)
    reportWebgpuWorkerFact(false)
    expect(describeWebgpuScope(webgpuAvailability())).toContain('отсутствует и в главном потоке')

    _resetWebgpuScopeForTests()
    reportWebgpuMainFact(true)
    reportWebgpuWorkerFact(true)
    expect(describeWebgpuScope(webgpuAvailability())).toContain('и в главном потоке, и в воркерах')
  })

  it('неизвестный скоуп объясняет, ЧЕГО не хватает', () => {
    const text = describeWebgpuScope(webgpuAvailability())
    expect(text.includes('неизвестен')).toBe(true)
  })
})

describe('webgpuScope — исходник микро-пробы', () => {
  it('не содержит GPU-инициализации (никакого requestAdapter)', () => {
    expect(WEBUGPU_PROBE_SRC).not.toContain('requestAdapter')
    expect(WEBUGPU_PROBE_SRC).toContain(WEBUGPU_PROBE_MARKER)
    expect(WEBUGPU_PROBE_SRC).toContain('navigator.gpu')
  })
})
