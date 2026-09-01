/**
 * scripts/demo-smoke.mjs — headless-проверка демо (запускать через bun).
 *
 * Поднимает статический сервер, открывает /demo/ в headless Chromium
 * (SwiftShader — программный WebGL2) и проверяет:
 *   1. нет ошибок консоли/страницы;
 *   2. бейдж бэкенда заполнен (WebGPU или WebGL2);
 *   3. два скриншота канваса с интервалом различаются (анимация живая).
 *
 * Exit 0 — демо работает; 1 — нет. Использование: bun run demo:smoke
 */
import { join, normalize, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const port = 8123

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const type = pathname.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : 'text/javascript; charset=utf-8'
    return new Response(file, { headers: { 'content-type': type } })
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

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await page.goto(`http://localhost:${port}/demo/`, { waitUntil: 'networkidle' })

  // Бейдж: showAny() обязан проставить активный бэкенд
  await page.waitForFunction(
    () => document.querySelector('#backend')?.textContent !== '…',
    null,
    { timeout: 15_000 },
  )
  const backend = await page.textContent('#backend')
  console.log(`[smoke] бэкенд: ${backend}`)

  // Анимация: два кадра с интервалом обязаны различаться
  const canvas = page.locator('#canvas')
  await page.waitForTimeout(700)
  const shotA = await canvas.screenshot()
  await page.waitForTimeout(700)
  const shotB = await canvas.screenshot()

  const hashA = createHash('sha256').update(shotA).digest('hex')
  const hashB = createHash('sha256').update(shotB).digest('hex')
  const alive = hashA !== hashB
  console.log(`[smoke] анимация: ${alive ? 'живая (кадры различаются)' : 'СТАТИЧНАЯ'}`)

  // Пауза реально останавливает цикл (rAF снят — кадры физически невозможны)
  await page.click('#pause')
  await page.waitForTimeout(300)
  const shotPausedA = await canvas.screenshot()
  await page.waitForTimeout(500)
  const shotPausedB = await canvas.screenshot()
  const pausedStill =
    createHash('sha256').update(shotPausedA).digest('hex') ===
    createHash('sha256').update(shotPausedB).digest('hex')
  console.log(`[smoke] пауза: ${pausedStill ? 'кадры заморожены' : 'ПРОДОЛЖАЕТ РИСОВАТЬ'}`)

  if (errors.length) {
    console.error('[smoke] ошибки страницы:')
    for (const error of errors) console.error(`  ${error}`)
  }

  const ok = alive && pausedStill && errors.length === 0
  console.log(ok ? '[smoke] OK' : '[smoke] FAIL')
  process.exit(ok ? 0 : 1)
} finally {
  await browser.close()
  server.stop(true)
}
