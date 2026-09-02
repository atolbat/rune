/**
 * scripts/demo-smoke.mjs — headless-проверка демо (запускать через bun).
 *
 * Поднимает статический сервер и проверяет СТАНДАРТ ДЕМО в headless
 * Chromium (SwiftShader — программный WebGL2):
 *
 * hello-cube (/demo/hello-cube/):
 *   1. бейдж бэкенда заполнен (WebGPU или WebGL2);
 *   2. анимация живая (два скриншота канваса различаются);
 *   3. пауза замораживает кадры, «Продолжить» оживляет;
 *   4. тумблер бэкендов: форс WebGL2 → бейдж «WebGL2», форс WebGPU →
 *      бейдж начинается с «WebGPU» (работает или честный отказ в логе);
 *   5. канвас на каждый запуск ровно один.
 *
 * model-viewer (/demo/model-viewer/):
 *   6. кнопка «Загрузить и показать» стартует загрузку с прогресс-баром;
 *   7. сцена появляется (статы мешей), анимация живая;
 *   8. переключение на незагруженную модель возвращает кнопку загрузки;
 *   9. лог-панель: записи копятся, «Копировать» отчитывается в логе.
 *
 * Оба демо:
 *  10. мобильный viewport 390×844: нет горизонтального переполнения,
 *      тач-цели тумблера ≥ 40 px;
 *  11. ноль ошибок консоли/страницы.
 *
 * Exit 0 — демо соответствует стандарту; 1 — нет. Использование: bun run demo:smoke
 */
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8123

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const errors = []

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
})

/** Два скриншота канваса различаются → анимация живая. */
async function framesDiffer(page) {
  const canvas = page.locator('#canvas')
  await page.waitForTimeout(700)
  const shotA = await canvas.screenshot()
  await page.waitForTimeout(700)
  const shotB = await canvas.screenshot()
  return (
    createHash('sha256').update(shotA).digest('hex') !==
    createHash('sha256').update(shotB).digest('hex')
  )
}

let failed = false

try {
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })

  // 1. Бейдж: шелл/библиотека обязаны проставить активный бэкенд
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  console.log(`[smoke] бэкенд (авто): ${await page.textContent('#backend')}`)

  // 2. Анимация живая
  const alive = await framesDiffer(page)
  console.log(`[smoke] анимация: ${alive ? 'живая (кадры различаются)' : 'СТАТИЧНАЯ'}`)

  // 3. Пауза замораживает, «Продолжить» оживляет
  await page.click('#pause')
  await page.waitForTimeout(300)
  const shotPausedA = await page.locator('#canvas').screenshot()
  await page.waitForTimeout(500)
  const shotPausedB = await page.locator('#canvas').screenshot()
  const pausedStill =
    createHash('sha256').update(shotPausedA).digest('hex') ===
    createHash('sha256').update(shotPausedB).digest('hex')
  console.log(`[smoke] пауза: ${pausedStill ? 'кадры заморожены' : 'ПРОДОЛЖАЕТ РИСОВАТЬ'}`)

  await page.click('#resume')
  const aliveAgain = await framesDiffer(page)
  console.log(`[smoke] резюм: ${aliveAgain ? 'анимация оживила' : 'НЕ ожила'}`)

  // 4. Тумблер: форсированный WebGL2
  await page.click('label[for="mode-webgl2"]')
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent === 'WebGL2',
    null,
    { timeout: 10_000 },
  )
  console.log('[smoke] тумблер WebGL2: бейдж = WebGL2')

  // Форсированный WebGPU: работает или честный отказ («WebGPU недоступен»)
  await page.click('label[for="mode-webgpu"]')
  await page.waitForFunction(
    () => /^WebGPU/.test(document.querySelector('#backend')?.textContent ?? ''),
    null,
    { timeout: 10_000 },
  )
  console.log(`[smoke] тумблер WebGPU: бейдж = ${await page.textContent('#backend')}`)

  // Канвас на каждый запуск ровно один (старые пересоздаются)
  const canvasCount = await page.evaluate(() => document.querySelectorAll('#canvas').length)
  console.log(`[smoke] канвасов после переключений: ${canvasCount}`)

  // 5. Лог-панель: записи есть, «Копировать» отчитывается
  const logEntries = await page.locator('#log-list .rd-entry').count()
  console.log(`[smoke] записей в логе: ${logEntries}`)
  await page.click('#log-copy')
  await page.waitForFunction(
    () => document.querySelector('#log-list')?.textContent.includes('Лог скопирован'),
    null,
    { timeout: 5000 },
  )
  console.log('[smoke] копирование лога: отчёт в панели есть')

  // 6. Мобильный viewport: без горизонтального переполнения, тач-цели ок
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${port}/demo/hello-cube/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  const mobile = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const target = document.querySelector('label[for="mode-webgl2"]')?.getBoundingClientRect()
    return { overflow, touchTarget: Math.round(target?.height ?? 0) }
  })
  console.log(`[smoke] мобильный 390x844: переполнение ${mobile.overflow}px, тач-цель ${mobile.touchTarget}px`)
  const mobileOk = mobile.overflow <= 1 && mobile.touchTarget >= 40

  // ─── model-viewer: кнопка загрузки → прогресс → сцена → анимация ──────────
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  console.log(`[smoke] model-viewer бэкенд: ${await page.textContent('#backend')}`)

  // 6. Кнопка загрузки запускает прогресс
  const loadText = await page.textContent('.mv-load')
  console.log(`[smoke] кнопка загрузки: ${loadText ?? 'НЕТ'}`)
  await page.click('.mv-load')
  await page.waitForFunction(
    () => document.querySelector('.mv-progress')?.classList.contains('mv-active') === true
      || document.querySelector('.mv-stats')?.textContent.includes('верш'),
    null,
    { timeout: 10_000 },
  )
  console.log('[smoke] прогресс-бар показан')

  // 7. Сцена появилась (Draco+AVIF на SwiftShader — десятки секунд хватит)
  await page.waitForFunction(
    () => document.querySelector('.mv-stats')?.textContent.includes('верш'),
    null,
    { timeout: 60_000 },
  )
  console.log(`[smoke] сцена: ${await page.textContent('.mv-stats')}`)
  const viewerAlive = await framesDiffer(page)
  console.log(`[smoke] model-viewer анимация: ${viewerAlive ? 'живая' : 'СТАТИЧНАЯ'}`)

  // 8. Переключение на незагруженную модель возвращает кнопку загрузки
  await page.click('.mv-tab:nth-child(2)')
  await page.waitForFunction(
    () => (document.querySelector('.mv-load')?.textContent ?? '').includes('Загрузить'),
    null,
    { timeout: 5_000 },
  )
  console.log('[smoke] таб незагруженной модели: кнопка «Загрузить» вернулась')

  // 9. Лог: записи есть, «Копировать» отчитывается
  const viewerLogEntries = await page.locator('#log-list .rd-entry').count()
  console.log(`[smoke] model-viewer записей в логе: ${viewerLogEntries}`)
  await page.click('#log-copy')
  await page.waitForFunction(
    () => document.querySelector('#log-list')?.textContent.includes('Лог скопирован'),
    null,
    { timeout: 5000 },
  )
  console.log('[smoke] копирование лога: отчёт в панели есть')

  // Мобильный viewport model-viewer: канвас и панель не рвут вёрстку
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  const mobileViewer = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
    const target = document.querySelector('.mv-tab')?.getBoundingClientRect()
    return { overflow, touchTarget: Math.round(target?.height ?? 0) }
  })
  console.log(`[smoke] model-viewer мобильный: переполнение ${mobileViewer.overflow}px, тач-цель ${mobileViewer.touchTarget}px`)
  const mobileViewerOk = mobileViewer.overflow <= 1 && mobileViewer.touchTarget >= 40
  await page.setViewportSize({ width: 960, height: 720 })

  if (errors.length) {
    console.error('[smoke] ошибки страницы:')
    for (const error of errors) console.error(`  ${error}`)
  }

  const ok =
    alive &&
    pausedStill &&
    aliveAgain &&
    canvasCount === 1 &&
    logEntries > 0 &&
    mobileOk &&
    viewerAlive &&
    loadText !== null &&
    loadText.includes('Загрузить') &&
    viewerLogEntries > 0 &&
    mobileViewerOk &&
    errors.length === 0

  console.log(ok ? '[smoke] OK' : '[smoke] FAIL')
  failed = !ok
  await context.close()
} finally {
  await browser.close()
  server.stop(true)
}

process.exit(failed ? 1 : 0)
