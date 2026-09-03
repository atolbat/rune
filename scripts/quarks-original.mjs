/** probe the original page structure: canvas box + animation state */
import { chromium } from 'playwright'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)) })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
await page.goto('https://alchemist0823.github.io/three.quarks/#explosion%20(Unity%20Exported)', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const info = await page.evaluate(() => {
  const canvas = document.getElementById('renderer-canvas')
  const r = canvas ? canvas.getBoundingClientRect() : null
  return {
    demoName: document.querySelector('#demo-name')?.textContent ?? null,
    canvas: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight },
    hash: location.hash,
    canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
    webgl: (() => { try { return !!canvas.getContext('webgl2') ?? !!canvas.getContext('webgl') } catch { return 'err' } })(),
  }
})
console.log(JSON.stringify(info, null, 1))
// two shots 500ms apart of the CANVAS REGION only
if (info.canvas) {
  const clip = { x: info.canvas.x, y: info.canvas.y, width: Math.min(1280, info.canvas.w), height: Math.min(800, info.canvas.h) }
  await page.screenshot({ path: '.shots/orig-canvas-a.png', clip })
  await page.waitForTimeout(600)
  await page.screenshot({ path: '.shots/orig-canvas-b.png', clip })
  console.log('canvas shots taken')
}
await browser.close()
