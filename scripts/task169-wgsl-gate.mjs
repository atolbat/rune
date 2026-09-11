// task169 — THE WGSL TWIN GATE. The field report that started this task:
// a phone (Chrome 150, WebGPU) opened the astral demo and hit
// `expected ';' for discard statement` — the WGSL twins shipped with
// syntax GLSL forgives and WGSL does not (`{ discard }`, a missing
// statement `;`), because NOTHING in the pipeline ever compiled them:
// the container has no WebGPU adapter under the plain demo-smoke flags,
// so every smoke run booted the WebGL2 twin and the WGSL half was
// field-tested only by users. The demo WAS the test.
//
// This gate closes the class, not the instance:
//   A. SOURCE COMPILE — a real WebGPU device (SwiftShader + the Vulkan
//      feature flags — the task164-steady discovery), every WGSL source
//      of the astral demo through createShaderModule with an error-scope
//      capture + getCompilationInfo, on a BARE page (the astral page's
//      own auto-boot would race for the GPU process — the contention
//      that makes SwiftShader devices flaky).
//      THE CANARY: the channel is calibrated against a KNOWN-BAD module
//      before any real verdict — if a deliberately broken shader yields
//      no error through ANY channel, the channel is DEAD and the cell
//      FAILS honestly ("cannot verify") instead of silently passing.
//      (The first draft of this gate had exactly that hole: on the flaky
//      GPU process both popErrorScope and getCompilationInfo REJECT, and
//      `.catch(() => null)` read the dead channel as "no problems" —
//      three broken shaders sailed through "compiles clean".)
//   B. LIVE BOOT — the whole demo forced onto WebGPU: the badge, the
//      frame counter alive (the storm pause freezes it — the exact
//      failure mode of the field report), the world booted, zero `GPU:`
//      lines in the log. Pixel liveness is NOT asserted here (the
//      task152 lesson: the SwiftShader-WG canvas lies to screenshots);
//      the frame counter and the error log are the honest instruments.
//
// Exit 0 — the WGSL twins compile and render; 1 — they do not.
// Usage: bun scripts/task169-wgsl-gate.mjs
import { chromium } from 'playwright'

const root = '/home/z/my-project/rune'
const port = Number(process.env.TASK169_PORT ?? 8169)

const server = Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname === '/gate.html') {
      return new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(`${root}${pathname}`)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.woff2': 'font/woff2',
    }
    return new Response(await file.text(), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})

let failed = false

try {
  // ─── Cell A: every WGSL source of the astral demo, compiled on a real device ──
  {
    const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
    const page = await context.newPage()
    await page.goto(`http://localhost:${port}/gate.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const report = await page.evaluate(async (port) => {
      const out = { device: false, canary: 'not run', shaders: [] }

      async function freshDevice() {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter === null) return null
        try { return await adapter.requestDevice() } catch { return null }
      }

      // popErrorScope's shape varies by Chrome vintage: the newer spec
      // resolves GPUError[], older builds resolve a SINGLE GPUError (or
      // null) — both are handled below.
      async function compileVerdict(device, code) {
        // Returns { problems: string[] } on a healthy channel, or null when
        // the channel is DEAD (both the scope and compilation-info reject
        // or vanish — the flaky SwiftShader GPU process).
        device.pushErrorScope('validation')
        let module = null
        try {
          module = device.createShaderModule({ code })
        } catch (e) {
          return { problems: [`createShaderModule threw: ${String(e).slice(0, 200)}`] }
        }
        let scope = null
        let scopeAlive = true
        try { scope = await device.popErrorScope() } catch { scopeAlive = false }
        const problems = []
        if (scopeAlive) {
          const list = scope === null || scope === undefined ? [] : Array.isArray(scope) ? scope : [scope]
          for (const e of list) problems.push(`error: ${String(e && typeof e === 'object' && 'message' in e ? e.message : e).slice(0, 200)}`)
        }
        let infoAlive = false
        try {
          const info = await module.getCompilationInfo()
          infoAlive = true
          for (const msg of info.messages) {
            if (msg.type === 'error' || msg.type === 'warning') {
              problems.push(`${msg.type} line ${msg.lineNum}: ${String(msg.message).slice(0, 160)}`)
            }
          }
        } catch { /* channel dead — see the alive flags below */ }
        if (!scopeAlive && !infoAlive) return null // dead channel — NOT a verdict
        if (problems.length > 0) return { problems }
        // no problems seen — but if the only alive channel was the (empty)
        // scope and compilation-info rejected, a clean verdict is not
        // proven: the scope may report nothing on some builds
        if (!infoAlive) return null
        return { problems }
      }

      // THE CANARY — a known-bad module (the exact field-report class).
      // A healthy channel MUST flag it; if nothing flags it the channel
      // cannot see shader errors and every "clean" verdict would be a
      // silent pass. Retry with a fresh device, then fail honestly.
      const CANARY = '@fragment fn f() -> @location(0) vec4<f32> { if (true) { discard } return vec4<f32>(); }'
      let device = null
      for (let attempt = 0; attempt < 3; attempt++) {
        device = await freshDevice()
        if (device === null) { out.canary = 'no device'; continue }
        const verdict = await compileVerdict(device, CANARY)
        if (verdict !== null && verdict.problems.length > 0) {
          out.canary = `caught (${verdict.problems.length} problem(s))`
          break
        }
        device = null
        out.canary = `attempt ${attempt + 1}: channel cannot see shader errors`
        await new Promise(r => setTimeout(r, 300))
      }
      if (device === null) return out
      out.device = true

      const mod = await import(`http://localhost:${port}/demo/astral/shaders.js?gate=170`)
      // Task 170: the demo's shader set grew (sky/nebula/haze/bgstar/pring
      // twins) — discover EVERY *Shader export instead of a fixed list, so
      // a new pass can never ship uncompiled again (the class stays closed)
      const named = Object.keys(mod)
        .filter(k => k.endsWith('Shader') && mod[k] && typeof mod[k].wgsl === 'string')
        .sort()
        .map(k => [k.replace(/Shader$/, ''), mod[k].wgsl])
      // THE BEAUTY PASS (Task 171): post.js carries the bloom chain's WGSL
      // (pass fragments + the dual-texture composite). Same compile verdict,
      // same closure — the post chain ships compiled or not at all.
      const post = await import(`http://localhost:${port}/demo/astral/post.js?v=1&gate=171`)
      for (const [name, sh] of Object.entries(post.postWgslShaders ?? {})) {
        if (typeof sh.wgsl === 'string') named.push([name, sh.wgsl])
      }
      for (const [name, code] of named) {
        const verdict = await compileVerdict(device, code)
        out.shaders.push({
          name,
          lines: code.split('\n').length,
          problems: verdict === null ? ['CHANNEL UNAVAILABLE — cannot verify (device flake)'] : verdict.problems,
        })
      }
      return out
    }, port)

    if (!report.device) {
      console.log(`[task169-A] FAIL — no calibrated WebGPU device (canary: ${report.canary})`)
      failed = true
    } else {
      console.log(`[task169-A] canary: ${report.canary}`)
      for (const s of report.shaders) {
        if (s.problems.length > 0) {
          console.log(`[task169-A] ${s.name} (${s.lines} lines) — ${s.problems.length} PROBLEM(S):`)
          for (const p of s.problems) console.log(`           ${p}`)
          failed = true
        } else {
          console.log(`[task169-A] ${s.name} (${s.lines} lines) — compiles clean`)
        }
      }
    }
    await context.close()
  }

  // ─── Cell B: the live WebGPU boot — badge, frames, world, log ────────────────
  {
    const context = await browser.newContext({ viewport: { width: 480, height: 320 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))

    await page.goto(`http://localhost:${port}/demo/astral/?seed=1234`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => window.__astral !== undefined && window.__astral.frame > 0, null, { timeout: 30_000 })

    // force the WebGPU backend (the task152 radio-click pattern); every wait
    // below converts a timeout into an honest diagnostic FAIL — the broken
    // WGSL class manifests as a frozen frame counter (the storm pause), and
    // a crash-with-stack is not a verdict
    let bootDiag = ''
    try {
      await page.evaluate(() => {
        const radio = document.querySelector('input[name="rd-mode"][value="webgpu"]')
        if (radio != null) radio.click()
      })
      await page.waitForFunction(
        () => (document.querySelector('#backend')?.textContent ?? '') === 'WebGPU',
        null,
        { timeout: 30_000 },
      )
    } catch {
      bootDiag = 'badge never reached WebGPU (boot failed or timed out)'
    }
    if (bootDiag === '') {
      try {
        await page.waitForFunction(
          () => window.__astral !== undefined && window.__astral.frame > 0,
          null,
          { timeout: 20_000 },
        )
      } catch {
        bootDiag = 'the re-booted frame counter never started'
      }
    }

    const state = await page.evaluate(() => ({
      backend: document.querySelector('#backend')?.textContent ?? '',
      frames: window.__astral?.frame ?? -1,
      world: window.__astral?.world != null
        ? { systems: window.__astral.world.systems.length, ships: window.__astral.world.ships.length }
        : null,
      logTail: (document.querySelector('#log-list')?.textContent ?? '').slice(-2000),
    })).catch(() => null)
    await page.waitForTimeout(1200)
    const framesAfter = await page.evaluate(() => window.__astral?.frame ?? -1).catch(() => -1)

    if (state === null) {
      console.log('[task169-B] FAIL — the page state became unreadable')
      failed = true
    } else {
      const gpuErrors = [...state.logTail.matchAll(/GPU:|storm|Boot on webgpu failed/gi)].length
      const advancing = state.frames >= 0 && framesAfter > state.frames
      console.log(`[task169-B] backend: ${state.backend}, frames ${state.frames}→${framesAfter} (${advancing ? 'advancing' : 'FROZEN'}), world ${state.world ? `${state.world.systems} systems / ${state.world.ships} ships` : 'unreadable'}, gpu-log-hits ${gpuErrors}${bootDiag !== '' ? ` [${bootDiag}]` : ''}`)
      if (state.backend !== 'WebGPU' || !advancing || gpuErrors > 0 || bootDiag !== '') failed = true
      if (gpuErrors > 0 && bootDiag === '') {
        // show the GPU lines verbatim — the field report's class deserves
        // the same diagnostics here as the phone showed
        for (const line of state.logTail.split('\n')) {
          if (/GPU:|storm/i.test(line)) console.log(`           ${line.slice(0, 200)}`)
        }
      }
    }
    if (pageErrors.length > 0) {
      console.log(`[task169-B] page errors: ${pageErrors.length}`)
      for (const e of pageErrors) console.log(`           ${e}`)
      failed = true
    }
    await context.close()
  }
} catch (error) {
  console.error(`[task169] gate crashed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  await browser.close()
  server.stop()
}

console.log(failed ? '\nTASK169 WGSL GATE: FAIL' : '\nTASK169 WGSL GATE: PASS')
process.exit(failed ? 1 : 0)
