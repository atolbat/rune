/**
 * scripts/demo-smoke.mjs — headless-проверка демо (запускать через bun).
 *
 * Поднимает статический сервер, открывает /demo/hello-cube/ в headless
 * Chromium (SwiftShader — программный WebGL2) и проверяет СТАНДАРТ ДЕМО:
 *   1. бейдж бэкенда заполнен (WebGPU или WebGL2);
 *   2. анимация живая (два скриншота канваса различаются);
 *   3. пауза замораживает кадры, «Продолжить» оживляет;
 *   4. тумблер бэкендов: форс WebGL2 → бейдж «WebGL2», форс WebGPU →
 *      бейдж начинается с «WebGPU» (работает или честный отказ в логе);
 *   5. лог-панель: записи копятся, «Копировать» отчитывается в логе;
 *   6. мобильный viewport 390×844: нет горизонтального переполнения,
 *      тач-цели тумблера ≥ 40 px;
 *   7. ноль ошибок консоли/страницы.
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
    errors.length === 0

  console.log(ok ? '[smoke] OK' : '[smoke] FAIL')
  failed = !ok
  await context.close()
} finally {
  await browser.close()
  server.stop(true)
}

process.exit(failed ? 1 : 0)
