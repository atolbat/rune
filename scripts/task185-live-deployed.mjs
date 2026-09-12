// task185-live-deployed — the deployed-site gate for Task 185: the vfx
// page on https://atolbat.github.io/rune/ must boot on ?v=185, animate,
// stay error-free; the served bundle must be BYTE-IDENTICAL to the local
// dist and carry the Task-185 markers (ensureSabDirectProbe — the SAB
// direct-write probe; the nested-uniform contract rides the same bundle).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const local = readFileSync(join(root, 'dist/rune.esm.js'))
function join(a, b) { return a + '/' + b }
const localMd5 = createHash('md5').update(local).digest('hex')

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 150)))
await page.goto('https://atolbat.github.io/rune/demo/vfx/', { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(2500)
const REGION = { x: 60, y: 140, width: 420, height: 420 }
const a = await page.screenshot({ clip: REGION, timeout: 60_000 })
await page.waitForTimeout(700)
const b = await page.screenshot({ clip: REGION, timeout: 30_000 })
let diff = 0
for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) diff++
const pill = await page.textContent('.pt-pill')
console.log('pill:', pill?.trim())
console.log('canvas diff bytes:', diff, '→', diff > 500 ? 'ANIMATES' : 'STATIC')
console.log('page errors:', errors.length === 0 ? 'none' : errors.join(' | '))
const v = await page.evaluate(() => [...document.querySelectorAll('script[type=module]')].map(s => s.src).join(','))
console.log('module srcs:', v)

// the served bundle: md5 parity with the local dist + the Task-185 markers
const served = await page.evaluate(async () => {
  const text = await (await fetch('https://atolbat.github.io/rune/dist/rune.esm.js?v=185')).text()
  return text
})
const servedMd5 = createHash('md5').update(served).digest('hex')
console.log(`rune.esm.js md5: local ${localMd5} · served ${servedMd5} → ${servedMd5 === localMd5 ? 'IDENTICAL' : 'DIFFERS'}`)
const markers = {
  ensureSabDirectProbe: served.includes('ensureSabDirectProbe'),
  sabDirectVerdict: served.includes('sabDirect'),
  writeRowsNested: served.includes('writeRows'),
}
console.log('Task-185 markers in the served bundle:', JSON.stringify(markers))

const ok = diff > 500 && errors.length === 0 && servedMd5 === localMd5
  && markers.ensureSabDirectProbe && markers.sabDirectVerdict && markers.writeRowsNested
console.log(ok ? 'LIVE DEPLOYED GATE: PASS' : 'LIVE DEPLOYED GATE: FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
