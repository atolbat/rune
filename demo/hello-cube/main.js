// Демо «hello cube»: вращающийся куб на выбранном бэкенде.
//   Авто    — showAny(): WebGPU с авто-фолбэком на WebGL2;
//   WebGL2 / WebGPU — showOn(): форсированный бэкенд, отказ виден в логе.
// Демо импортирует СОБРАННЫЙ бандл библиотеки: сначала `bun run build`,
// затем `bun run demo` (или откройте GitHub Pages-ссылку из demo/README.md).
import { showAny, showOn, probeWebGpu } from '../../dist/rune.esm.js'

const OPTS = { spin: 0.8 }
const MODE_NAMES = { auto: 'Авто (WebGPU → фолбэк WebGL2)', webgl2: 'WebGL2', webgpu: 'WebGPU' }

const shell = window.RuneDemoShell.mount({
  title: 'rune — hello cube',
  desc: 'Один вызов show() — вращающийся куб. Тумблер форсирует бэкенд, лог собирает ошибки и события.',
  hint: 'Локально: <code>bun run demo</code> → /demo/hello-cube/ · Бандл: <code>dist/rune.esm.js</code>',
  defaults: { mode: 'auto' },
  onMode: (mode) => void boot(mode),
  onPause: () => {
    activeShow?.pause()
    shell.log.event('Пауза')
  },
  onResume: () => {
    activeShow?.resume()
    shell.log.event('Продолжили')
  },
})

let activeShow = null
let bootSeq = 0

shell.log.info(`WebGL2: ${typeof WebGL2RenderingContext !== 'undefined' ? 'есть в браузере' : 'отсутствует'}`)
await boot(shell.mode)

/** Перезапуск визуализации на выбранном бэкенде. */
async function boot(mode) {
  const seq = ++bootSeq

  if (activeShow !== null) {
    try { activeShow.stop() } catch { /* контекст мог умереть вместе с канвасом — не важно */ }
    activeShow = null
  }

  // Свежий канвас на каждый запуск: WebGL2-контекст нельзя получить второй
  // раз на том же элементе после потери, WebGPU — тоже предпочитает новый.
  shell.slot.replaceChildren()
  const canvas = document.createElement('canvas')
  canvas.id = 'canvas'
  shell.slot.append(canvas)

  shell.log.event(`Запуск: режим «${MODE_NAMES[mode] ?? mode}»`)

  try {
    if (mode === 'auto') {
      const available = await probeWebGpu()
      if (seq !== bootSeq) return
      shell.log.info(available
        ? 'WebGPU доступен — пробуем первым, фолбэк WebGL2'
        : 'WebGPU недоступен (navigator.gpu или адаптер отсутствуют) — рендерим на WebGL2')

      const any = await showAny(canvas, OPTS)
      if (seq !== bootSeq) { any.stop(); return }
      const inner = any.webgpu ?? any.webgl2
      activeShow = {
        pause: () => inner?.pause(),
        resume: () => inner?.resume(),
        stop: () => any.stop(),
      }
      shell.setBadge(any.backend === 'webgpu' ? 'WebGPU' : 'WebGL2 (фолбэк)', any.backend === 'webgpu' ? 'gpu' : 'gl')
    } else {
      const result = await showOn(canvas, mode, OPTS)
      if (seq !== bootSeq) { result.stop(); return }

      if (result.active === null) {
        shell.setBadge(`${MODE_NAMES[mode]} недоступен`, 'err')
        shell.log.error(`showOn(${mode}): ${result.failureReason}`)
        shell.log.info('Это не ошибка библиотеки — бэкенда нет в этом браузере. Переключите тумблер на «Авто» или другой бэкенд.')
        return
      }
      activeShow = result
      shell.setBadge(mode === 'webgpu' ? 'WebGPU' : 'WebGL2', mode === 'webgpu' ? 'gpu' : 'gl')
    }
  } catch (error) {
    if (seq !== bootSeq) return
    shell.setBadge('ошибка запуска', 'err')
    shell.log.error(`show на бэкенде «${mode}» упал: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return
  }

  shell.log.event(`Визуализация запущена: ${MODE_NAMES[mode] ?? mode}`)
  // showAny на фолбэке подменяет канвас-узел — размеры берём у живого элемента
  const live = shell.slot.querySelector('canvas') ?? canvas
  shell.log.info(`Канвас: ${live.clientWidth}×${live.clientHeight} css-px, DPR ${window.devicePixelRatio}`)
  shell.markReady()
}
