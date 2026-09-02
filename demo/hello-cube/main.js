// "hello cube" demo: a spinning cube on the selected backend.
//   Auto    — showAny(): WebGPU with an automatic fallback to WebGL2;
//   WebGL2 / WebGPU — showOn(): a forced backend, a refusal is visible in the log.
// The demo imports the BUILT bundle of the library: run `bun run build` first,
// then `bun run demo` (or open the GitHub Pages link from demo/README.md).
import { showAny, showOn, probeWebGpu } from '../../dist/rune.esm.js'

const OPTS = { spin: 0.8 }
const MODE_NAMES = { auto: 'Auto (WebGPU → WebGL2 fallback)', webgl2: 'WebGL2', webgpu: 'WebGPU' }

const shell = window.RuneDemoShell.mount({
  title: 'rune — hello cube',
  desc: 'A single show() call — a spinning cube. The toggle forces the backend, the log collects errors and events.',
  hint: 'Locally: <code>bun run demo</code> → /demo/hello-cube/ · Bundle: <code>dist/rune.esm.js</code>',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => {
    activeShow?.pause()
    shell.log.event('Paused')
  },
  onResume: () => {
    activeShow?.resume()
    shell.log.event('Resumed')
  },
})

let activeShow = null
let bootSeq = 0

shell.log.info(`WebGL2: ${typeof WebGL2RenderingContext !== 'undefined' ? 'present in the browser' : 'missing'}`)
await boot(shell.mode)

/** Restarts the visualization on the selected backend. */
async function boot(mode) {
  const seq = ++bootSeq

  if (activeShow !== null) {
    try { activeShow.stop() } catch { /* the context may have died with the canvas — does not matter */ }
    activeShow = null
  }

  // A fresh canvas for every boot: a WebGL2 context cannot be acquired a second
  // time on the same element after a loss; WebGPU also prefers a new one.
  shell.slot.replaceChildren()
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(canvas)

  shell.log.event(`Booting: “${MODE_NAMES[mode] ?? mode}”`)

  try {
    if (mode === 'auto') {
      const available = await probeWebGpu()
      if (seq !== bootSeq) return
      shell.log.info(available
        ? 'WebGPU available — trying it first, fallback to WebGL2'
        : 'WebGPU unavailable (navigator.gpu or adapter missing) — rendering on WebGL2')

      const any = await showAny(canvas, OPTS)
      if (seq !== bootSeq) { any.stop(); return }
      const inner = any.webgpu ?? any.webgl2
      activeShow = {
        pause: () => inner?.pause(),
        resume: () => inner?.resume(),
        stop: () => any.stop(),
      }
      shell.setBadge(any.backend === 'webgpu' ? 'WebGPU' : 'WebGL2 (fallback)', any.backend === 'webgpu' ? 'gpu' : 'gl')
    } else {
      const result = await showOn(canvas, mode, OPTS)
      if (seq !== bootSeq) { result.stop(); return }

      if (result.active === null) {
        shell.setBadge(`${MODE_NAMES[mode]} unavailable`, 'err')
        shell.log.error(`showOn(${mode}): ${result.failureReason}`)
        shell.log.info('This is not a library error — the backend is missing in this browser. Switch the toggle to Auto or another backend.')
        return
      }
      activeShow = result
      shell.setBadge(mode === 'webgpu' ? 'WebGPU' : 'WebGL2', mode === 'webgpu' ? 'gpu' : 'gl')
    }
  } catch (error) {
    if (seq !== bootSeq) return
    shell.setBadge('startup failed', 'err')
    shell.log.error(`show on backend “${mode}” failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return
  }

  shell.log.event(`Rendering started: ${MODE_NAMES[mode] ?? mode}`)
  // showAny swaps the canvas node on fallback — take the sizes from the live element
  const live = shell.slot.querySelector('canvas') ?? canvas
  shell.log.info(`Canvas: ${live.clientWidth}×${live.clientHeight} css-px, DPR ${window.devicePixelRatio}`)
  shell.markReady()
}
