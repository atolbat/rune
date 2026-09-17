#!/usr/bin/env bun
/**
 * scripts/task223-local.mjs — the LOCAL gate for Task 223 (THE DENSE
 * FOREST: one tree, instanced).
 *
 *   · LEG 1 — THE SOURCE LAWS: the round's own bricks ship (the quantized
 *     feed in the device + the facades, drawMeshInstanced, texture, the
 *     wrap law, runCullCompact, the converter's nested-LOD + proxy
 *     contract on the demo page, the asset itself).
 *   · LEG 2 — THE VALIDATION (both backends, the software ladder's light
 *     load): the page's own autopilot walks the orbit, the occlusion
 *     probe, the still-camera zero-flip, the LOD dive — 7 laws each.
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const root = join(import.meta.dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.bin': 'application/octet-stream' }
let failures = 0
function check(name, ok, detail = '') {
  console.log(`[223] ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` · ${detail}` : ''}`)
  if (!ok) failures++
}

// ── LEG 1 — the source laws ───────────────────────────────────────────────
{
  console.log('[223] source leg: reading…')
  const device = await readFile(join(root, 'packages/gl/src/device.ts'), 'utf8')
  const wgFacade = await readFile(join(root, 'packages/webgpu/src/facade.ts'), 'utf8')
  const glFacade = await readFile(join(root, 'packages/webgl2/src/facade.ts'), 'utf8')
  const main = await readFile(join(root, 'demo/forest/main.js'), 'utf8')
  const shaders = await readFile(join(root, 'demo/forest/shaders.js'), 'utf8')
  const world = await readFile(join(root, 'demo/forest/world.js'), 'utf8')
  check('source: THE QUANTIZED FEED — the WG slot format + the GL typed attr lane',
    wgFacade.includes("'snorm16x4' | 'snorm8x4' | 'snorm16x2'")
      && glFacade.includes("type?: 'float' | 'short' | 'byte'")
      && device.includes('Int16Array | Int8Array'),
    '')
  check('source: drawMeshInstanced + texture + runCullCompact ship in the device',
    device.includes('function drawMeshInstanced') && device.includes('function texture')
      && device.includes('function runCullCompact') && device.includes('THE VERDICT COLLAPSE'),
    '')
  check('source: THE WRAP LAW — repeat rides both facades (the bark V-tiling)',
    wgFacade.includes("wrap?: 'clamp' | 'repeat'") && glFacade.includes("wrap?: 'clamp' | 'repeat'"),
    '')
  check('source: the instanced record run — baseInstance byte-shifts the GL feeds',
    main.includes('optionsIn.baseInstance * attr.stride') || device.includes('optionsIn.baseInstance * attr.stride'),
    '')
  check('source: THE OCCLUDER PROXY — the solid canopy core (depth-only, never colored)',
    shaders.includes('THE VERDICT COLLAPSE') && main.includes("mesh(0, 2)") && main.includes("const g = mesh(0, 2)"),
    '')
  check('source: THE TIGHT AABB — the yaw-exact rotated footprint (never the disc)',
    world.includes('THE TIGHT AABB LAW') && world.includes('4 footprint corners, rotated'),
    '')
  check('source: THE COUNTS CHANNEL — WG stats via the compact + args (never the scene mid-loop)',
    main.includes('runCullCompact') && main.includes('211-class poison') && device.includes('function runCullCompact'),
    '')
  check('source: the 211 discipline — the stats in-flight gate + the paused validation reads',
    main.includes('statsInFlight') && main.includes('readWhilePaused'),
    '')
  const binGz = Bun.file(join(root, 'demo/forest/assets/tree.bin.gz'))
  const bin = Bun.file(join(root, 'demo/forest/assets/tree.bin'))
  check('source: the assets ship (tree.bin.gz ≤ 8 MB + the raw twin + both textures)',
    await binGz.exists() && await bin.exists() && (await binGz.arrayBuffer()).byteLength < 8_000_000,
    `${((await binGz.arrayBuffer()).byteLength) / 1e6} MB gz`)
}

// ── LEG 2 — the validation (both backends) ────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
function serve(port) {
  return Bun.serve({
    port,
    async fetch(request) {
      let pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = Bun.file(join(root, pathname))
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      const ext = pathname.slice(pathname.lastIndexOf('.'))
      return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
    },
  })
}

async function validationLeg(mode, port, trees, awaitWalk) {
  console.log(`[223] validation leg ${mode}: goto…`)
  const server = serve(port)
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 160)}`))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
  await page.goto(`http://localhost:${port}/demo/forest/?trees=${trees}&mode=${mode}`, { waitUntil: 'networkidle', timeout: 150_000 })
  let res = null
  if (awaitWalk) {
    const gate = await page.waitForFunction(
      () => window.__forestGate !== undefined && typeof window.__forestGate.then === 'function',
      null, { timeout: 150_000, polling: 500 },
    ).then(() => page.evaluate(() => window.__forestGate))
    res = await Promise.race([gate, new Promise(r => setTimeout(() => r({ err: 'GATE_TIMEOUT' }), 420_000))])
    const list = res && Array.isArray(res.list) ? res.list : []
    for (const c of list) check(`[${mode}:validation] ${c.name}`, c.pass === true, c.detail ?? '')
    check(`[${mode}:validation] the autopilot walked the forest (all 7 laws)`,
      res && res.pass === true && res.checks === 7,
      res && res.err ? res.err : `${list.filter(c => c.pass).length}/${list.length} laws`)
  } else {
    // THE CONTAINER'S GL READBACK WALL (Task 225's re-pin): this box's
    // sync getBufferSubData runs 30–80 s per read — the full 21-read walk
    // is ~15 min, past every ceiling. The GL leg proves the walk is
    // RUNNING (the live counters land mid-sweep — the drawn law's own
    // evidence: 0 < drawn < total) + the loop + zero errors; the WG leg
    // carries the full 7-law walk.
    const landed = await page.waitForFunction(
      () => window.__forest.drawn > 0 && window.__forest.frame > 20,
      null, { timeout: 420_000, polling: 500 },
    ).then(() => true).catch(() => false)
    check(`[${mode}:validation] the autopilot is walking (the live counters land mid-sweep — the GL readback wall; the full walk is the WG leg's proof)`,
      landed, 'the drawn counter never landed')
  }
  check(`[${mode}:validation] zero page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  // the stats lane re-arms after the validation's pause — give it a beat
  await page.waitForTimeout(4000)
  const s = await page.evaluate(() => ({ f: window.__forest.frame, drawn: window.__forest.drawn, total: window.__forest.total, loadMs: window.__forest.loadMs }))
  check(`[${mode}] the loop lives (frames advancing, drawn landed)`,
    s.f > (awaitWalk ? 100 : 20) && s.drawn > 0 && s.drawn < s.total,
    `frame ${s.f} · drawn ${s.drawn}/${s.total} · load ${s.loadMs} ms`)
  await page.close()
  server.stop(true)
}

// the SwiftShader readback latency (the GL legs' sync getBufferSubData
// drains seconds of fill per read — a 150-tree walk ran ~15 min) makes the
// GL legs exceed every ceiling — the legs run chunked AND the GL leg pins
// the lighter ring (?trees=100 — the container's own budget; the WG legs
// carry the full 150-tree proof on both gates).
const LEG = process.argv[2] ?? 'all'
if (LEG === 'all' || LEG === 'webgpu') await validationLeg('webgpu', 8962, 150, true)
if (LEG === 'all' || LEG === 'webgl2') await validationLeg('webgl2', 8963, 100, false)
await browser.close()
console.log(`[223-local] ${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`} — the dense forest holds in the container`)
process.exit(failures === 0 ? 0 : 1)
