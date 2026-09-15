/**
 * scripts/task211-local.mjs — the LOCAL pre-deploy gate for Task 211's edit
 * mode (the live gate's rehearsal): serves the repo, boots the occlusion
 * page bare (?bare=1 — the smoke already proved the static validation),
 * freezes the auto-orbit, and proves THE EDIT LOOP end to end on both
 * backends:
 *   · the upload math (48 drones → ~2.3 KB over 48 ranges vs the ~961 KB
 *     full write — the partial-upload law);
 *   · THE RECORD-MIRROR GATE: the GPU's own copy of a drone record (the
 *     device's readRecords readback) equals the store's bytes;
 *   · THE TELEPORT PROBE: a VISIBLE record teleported far behind the
 *     frustum THROUGH THE STORE flips its verdict (1 → 2) and moves the
 *     drawn count — the cull provably reads the uploaded bytes;
 *   · the pixel law, done at wall-clock speed (the drones fly real
 *     seconds): two pause instants differ with the edits ON, and the
 *     still-frame law holds with them OFF;
 *   · zero page/GPU errors while the drones fly.
 *
 * The pause discipline (the Task-209 lesson): every surface read happens
 * under a PAUSED loop — a read while the rAF runs races the snapshot
 * blit's own read on the SwiftShader stack and kills the renderer.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const port = 8917
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`[local] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

/** The pixel-law hasher: the SURFACE hash on BOTH backends (Task 219 —
 * the crowd renders into the surface everywhere now; the canvas is a
 * presentation surface reached by ONE blit, and a screenshot of a
 * CSS-stretched canvas is raster-nondeterministic between shots on BOTH
 * legs — the rendered surface is the deterministic truth). Under a PAUSED
 * loop, as always. */
async function pixelHash(page, _mode) {
  await page.evaluate(() => { window.__hizCtl.pause() })
  await page.waitForTimeout(400)
  try {
    return await page.evaluate(async () => {
      const r = await window.__hizTier.surface.read()
      const d = await crypto.subtle.digest('SHA-256', new Uint8Array(r.data))
      return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('')
    })
  } finally {
    await page.evaluate(() => { window.__hizCtl.resume() })
  }
}

async function runLeg(mode) {
  console.log(`[local] leg ${mode}: goto…`)
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  page.on('crash', () => console.log(`[local] leg ${mode}: PAGE CRASH (renderer died)`))
  await page.goto(`http://localhost:${port}/demo/occlusion/?bare=1${mode === 'webgl2' ? '&mode=webgl2' : ''}`, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForFunction(() => window.__hizStats && window.__hizStats.drawn > 0, null, { timeout: 120_000 })
  await page.evaluate(() => { window.__hizCam.auto = 0 })
  await page.waitForTimeout(700)
  const pausedHash = async () => {
    await page.evaluate(() => { window.__hizCtl.pause() })
    await page.waitForTimeout(350) // the last frame's async blit settles
    const h = await shaHex(page)
    await page.evaluate(() => { window.__hizCtl.resume() })
    return h
  }
  // EVERY GPU readback (records / verdicts / stats / surface) runs under
  // a paused loop — the same race class as the blit: a mapAsync staging
  // read while frames keep submitting kills the SwiftShader renderer
  // (the local gate's own lesson, one layer past Task-209's)
  const paused = async (fn) => {
    await page.evaluate(() => { window.__hizCtl.pause() })
    await page.waitForTimeout(250)
    try {
      return await fn()
    } finally {
      await page.evaluate(() => { window.__hizCtl.resume() })
    }
  }

  // (a) the still-frame law: edits OFF, frozen camera → identical frames.
  // THE SETTLE FIRST (the Task-208b lesson, one layer down): the GL leg
  // can carry a borderline flapper (a straddling box whose verdict feeds
  // back through the two-pass pyramid at a frozen camera — the documented
  // borderline class); a few frames of settle let the carry converge, and
  // the drawn pair rides the detail line so a FAIL is diagnosable.
  await page.waitForTimeout(3000)
  const stillA = await paused(() => page.evaluate(async () => ({ h: 0, drawn: (await window.__hizTier.readStats()).drawn })))
  const still1 = await pixelHash(page, mode)
  await page.waitForTimeout(900)
  const still2 = await pixelHash(page, mode)
  const stillB = await paused(() => page.evaluate(async () => ({ drawn: (await window.__hizTier.readStats()).drawn })))
  check(`[${mode}] the still-frame law (frozen camera, edits OFF)`, still1 === still2,
    still1 === still2 ? `drawn ${stillA.drawn}` : `drawn ${stillA.drawn} → ${stillB.drawn} (a borderline flap? — the hash pair is the judge)`)

  // (b) the drones ON — the upload math
  await page.evaluate(() => { window.__hizEdits.set(true) })
  const edit = await page.waitForFunction(
    () => (window.__hizEdits.last().bytes > 0 ? window.__hizEdits.last() : undefined),
    null,
    { timeout: 60_000 },
  ).then(h => h.jsonValue())
  check(`[${mode}] the partial upload lands`, (edit?.bytes ?? 0) > 0 && (edit?.bytes ?? 0) < (edit?.full ?? 1) / 100,
    `${edit?.bytes} B over ${edit?.ranges} ranges vs full ${((edit?.full ?? 0) / 1024).toFixed(0)} KB — ${((edit?.full ?? 0) / Math.max(1, edit?.bytes ?? 1)).toFixed(0)}×`)
  check(`[${mode}] the range count ≈ the drone count`, (edit?.ranges ?? 0) >= 40 && (edit?.ranges ?? 0) <= 48, `${edit?.ranges} ranges`)

  // (c) THE RECORD-MIRROR GATE: the GPU's copy ≡ the store's bytes
  await page.waitForTimeout(900)
  const mirror = await paused(() => page.evaluate(async () => {
    const id = window.__hizEdits.droneId(7)
    const cpu = window.__hizEdits.record(id)
    const gpu = Array.from(await window.__hizDebug.records(id), v => +v.toFixed(4))
    return { id, cpu, gpu }
  }))
  const mirrorOk = Array.isArray(mirror.gpu) && mirror.cpu.length === mirror.gpu.length &&
    mirror.cpu.every((v, i) => Math.abs(v - mirror.gpu[i]) < 5e-4)
  check(`[${mode}] the record mirror ≡ the store (drone #${mirror.id})`, mirrorOk,
    `cpu ${mirror.cpu?.slice(0, 3).map(v => v.toFixed(2)).join(',')} · gpu ${Array.isArray(mirror.gpu) ? mirror.gpu.slice(0, 3).map(v => v.toFixed(2)).join(',') : '?'}`)

  // (d) THE TELEPORT PROBE — the cull provably reads the uploaded bytes:
  // a VISIBLE non-drone record, teleported far behind the frustum through
  // the store, must flip its verdict (1 → 2) and move the drawn count
  const target = await paused(() => page.evaluate(async () => {
    const verdicts = Array.from(await window.__hizTier.readVerdicts())
    const droneIds = new Set(Array.from({ length: 48 }, (_, d) => window.__hizEdits.droneId(d)))
    for (let i = 23; i < verdicts.length; i++) {
      if (verdicts[i] === 1 && !droneIds.has(i)) return i
    }
    return -1
  }))
  const drawnBefore = await paused(() => page.evaluate(async () => (await window.__hizTier.readStats()).drawn))
  await page.evaluate(id => { window.__hizEdits.teleport(id, 0, 500, 0) }, target)
  await page.waitForTimeout(1400) // frames render: the upload lands, the cull reads it
  const flip = await paused(() => page.evaluate(async id => ({
    v: (await window.__hizTier.readVerdicts())[id],
    drawn: (await window.__hizTier.readStats()).drawn,
    gpu: Array.from(await window.__hizDebug.records(id), v => +v.toFixed(1)).slice(0, 3),
  }), target))
  check(`[${mode}] the teleport probe (record #${target}: verdict 1 → 2, the cull reads the upload)`, flip.v === 2 && flip.gpu[1] === 500,
    `verdict ${flip.v} · mirror ${JSON.stringify(flip.gpu)} · drawn ${drawnBefore} → ${flip.drawn}`)

  // (e) the pixel law at wall-clock speed: two pause instants differ
  await page.waitForTimeout(1100)
  const moved1 = await pixelHash(page, mode)
  await page.waitForTimeout(1400)
  const moved2 = await pixelHash(page, mode)
  check(`[${mode}] the pixels MOVE with the edits ON`, moved1 !== moved2)

  // (f) the HUD channel + cleanliness + a long flight (the bvh rebuild rides it)
  const hud = await paused(() => page.evaluate(() => ({ e: window.__hizStats.edits, b: window.__hizStats.uploadBytes, r: window.__hizStats.uploadRanges })))
  check(`[${mode}] the HUD counters carry the edit math`, hud.e === 1 && hud.b > 0 && hud.r > 0, `${hud.b} B · ${hud.r} ranges`)
  await page.waitForTimeout(2500)
  check(`[${mode}] zero errors while the drones fly`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.close()
}

try {
  await runLeg('webgpu')
  await runLeg('webgl2')
} catch (e) {
  failures++
  console.error(`[local] CRASH: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser.close()
  server.stop(true)
}

console.log(`\n[local] ${failures === 0 ? 'VERDICT: PASS — the edit loop works on both backends' : `VERDICT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
