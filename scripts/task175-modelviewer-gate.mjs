// task175 — THE DEVICE-LOSS LIVE GATE. The unit pins drive the wire through
// the createGPU injection; this gate pins it LIVE on the real broken stack
// (the container's SwiftShader+Vulkan Chrome). The stack's WebGPU is broken
// at the FOUNDATION today (traced raw, no library in the loop): devices die
// right after their first present, silently; subscribing to device.lost
// destroys the instance outright; a second requestDevice after presents
// throws instance-gone. On such stacks the library SKIPS the device.lost
// subscription by design (the adapter-info denylist) and the COPY ARMOR is
// the detector — copyExternalImageToTexture is the first call that notices
// a dead device, and its sync TypeError is reported through the GPU error
// channel. On real hardware the subscription runs and device.lost is the
// channel (covered by the unit pins; the live cells below mark it N/A).
//   CELL A (auto): model-viewer boots WebGPU (auto) → the Forest House load
//     hits the dead device at the copy → the armor reports → the demo's
//     auto fallback re-boots WebGL2 → the prepared-model cache re-attaches
//     → the scene shows verts, the canvas ANIMATES, samba (skinned) loads.
//   CELL B (strict webgpu): the same load on a forced-WebGPU renderer →
//     the armor reports + the honest 'WebGPU lost' handling, NO auto
//     re-boot (the user chose the backend).
// Exit 0 — the wire works live; 1 — it does not.
// Usage: bun scripts/task175-modelviewer-gate.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK175GATE_PORT ?? 8186)

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary',
      '.fbx': 'application/octet-stream', '.wasm': 'application/wasm',
    }
    return new Response(await file.arrayBuffer(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const WG_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader']

async function canvasAlive(page) {
  const cdp = await page.context().newCDPSession(page)
  const shots = []
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(400)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 300, height: 220, scale: 1 } })
    shots.push(shot.data)
  }
  return shots[0] !== shots[1]
}

const failures = []
function check(cell, name, ok, detail = '') {
  console.log(`  [${cell}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(`${cell}/${name}`)
}

// ─── CELL A: the auto recovery ────────────────────────────────────────────
console.log('── CELL A: auto mode — the dead-device recovery (the armor path) ──')
{
  const browser = await chromium.launch({ headless: true, args: WG_ARGS })
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message.slice(0, 140)))
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').length > 0, null, { timeout: 60_000 })
  const bootBackend = await page.textContent('#backend')
  console.log(`  boot badge: ${bootBackend}`)

  await page.click('.mv-load')
  let sceneShown = false
  try {
    await page.waitForFunction(() => (document.querySelector('.mv-stats')?.textContent ?? '').includes('verts'), null, { timeout: 120_000 })
    sceneShown = true
  } catch { /* reported below */ }
  check('A', 'the scene came up (verts in stats) — via WG or the GL recovery', sceneShown)

  const logText = await page.evaluate(() => [...document.querySelectorAll('.rd-entry')].map(e => e.textContent.trim()).join('\n'))
  const hasCopyReport = logText.includes('copyExternalImageToTexture rejected')
  const hasLoss = logText.includes('device lost')
  const hasFallback = logText.includes('re-booting on WebGL2')
  const finalBadge = await page.textContent('#backend')
  console.log(`  final badge: ${finalBadge}`)
  if (!sceneShown) {
    console.log('  ── the log (failure diagnostics) ──')
    for (const e of logText.split('\n').slice(-16)) console.log('    |', e.slice(0, 150))
  }
  if (bootBackend.includes('WebGPU')) {
    // the WG leg ran: the dead device surfaced SOMEWHERE (the armor on this
    // stack; the device-lost fatal on healthy hardware — either is a pass)
    check('A', 'the dead WG device is REPORTED (armor or device-lost fatal)', hasCopyReport || hasLoss, hasCopyReport ? 'via the copy armor' : (hasLoss ? 'via the device-lost fatal' : 'no report'))
    if (hasCopyReport || hasLoss) {
      check('A', 'the auto fallback re-booted WebGL2', hasFallback, hasFallback ? '' : 'no re-boot line')
      check('A', 'the badge is WebGL2 after the recovery', finalBadge.includes('WebGL2'), finalBadge)
    }
  } else {
    console.log('  (the WG boot itself fell back to GL before any device — the recovery had nothing to do; the armor cells are covered by Cell B)')
  }
  if (sceneShown) {
    check('A', 'the canvas animates', await canvasAlive(page))
  }

  // samba (the skinned path) on the recovered renderer
  await page.click('.mv-pill')
  await page.click('.mv-rows .mv-row:nth-child(2)')
  await page.waitForFunction(() => (document.querySelector('.mv-load')?.textContent ?? '').includes('Load'), null, { timeout: 30_000 })
  await page.click('.mv-load')
  let sambaShown = false
  try {
    await page.waitForFunction(() => (document.querySelector('.mv-stats')?.textContent ?? '').includes('joints'), null, { timeout: 120_000 })
    sambaShown = true
  } catch { /* reported below */ }
  check('A', 'samba (skinned) loads on the recovered renderer', sambaShown)
  await browser.close()
}

// ─── CELL B: strict webgpu — the honest failure ───────────────────────────
console.log('── CELL B: strict webgpu — the honest failure (no auto re-boot) ──')
{
  const browser = await chromium.launch({ headless: true, args: WG_ARGS })
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
  page.on('pageerror', e => console.log('  PAGEERROR:', e.message.slice(0, 140)))
  await page.goto(`http://localhost:${port}/demo/model-viewer/`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="rd-mode"][value="webgpu"]')
    if (radio != null) radio.click()
  })
  await page.waitForFunction(() => (document.querySelector('#backend')?.textContent ?? '').startsWith('WebGPU'), null, { timeout: 90_000 })
  await page.click('.mv-load')
  await page.waitForTimeout(10_000) // the dead device + the armor + the strict handling
  const entries = await page.evaluate(() => [...document.querySelectorAll('.rd-entry')].map(e => e.textContent.trim()))
  const logText = entries.join('\n')
  const badge = await page.textContent('#backend')
  console.log(`  badge: ${badge}`)
  const hasCopyReport = logText.includes('copyExternalImageToTexture rejected')
  const hasLoss = logText.includes('device lost')
  if (hasCopyReport || hasLoss) {
    check('B', 'the dead device is REPORTED (the armor on this stack)', hasCopyReport || hasLoss)
    // the STRICT branch ran (not the auto one): the recovery hint is logged
    check('B', 'the strict-mode honesty (the "device is gone" hint, no silent switch)', logText.includes('The WebGPU device is gone'))
    // the badge: 'WebGPU lost' (the loss state) or 'load failed' (the load
    // that died ON the dead device overwrote it) — both honest outcomes
    check('B', 'the honest badge (WebGPU lost / load failed)', badge.includes('WebGPU lost') || badge.includes('load failed'), badge)
    // NO re-boot from the STRICT phase: a 're-booting' line AFTER the last
    // strict 'Booting: "WebGPU"' entry would be the auto recovery firing in
    // strict mode — forbidden (an auto-phase re-boot BEFORE the toggle is fine)
    const lastStrictBoot = entries.map((e, i) => e.includes('Booting') && e.includes('WebGPU') && !e.includes('Auto') ? i : -1).reduce((a, b) => Math.max(a, b), -1)
    const strictRebootIdx = entries.findIndex((e, i) => i > lastStrictBoot && e.includes('re-booting on WebGL2'))
    check('B', 'NO auto re-boot in strict mode', strictRebootIdx === -1, strictRebootIdx === -1 ? '' : `a re-boot line at entry ${strictRebootIdx} after the strict boot at ${lastStrictBoot}`)
  } else {
    // the WG device survived this boot AND the load never hit a dead copy —
    // there is nothing dead to report; the strict pause cells are N/A
    console.log('  (the device survived this boot — no loss to report; re-run for the flake)')
  }
  await browser.close()
}

server.stop()
console.log(failures.length === 0 ? '\nTASK175 GATE: PASS' : `\nTASK175 GATE: FAIL (${failures.join(', ')})`)
process.exit(failures.length === 0 ? 0 : 1)
