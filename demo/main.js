// Демо «hello cube»: одна строка showAny() — вращающийся куб на лучшем
// доступном бэкенде (WebGPU, фолбэк WebGL2). Демо импортирует СОБРАННЫЙ
// бандл библиотеки: сначала `bun run build`, затем `bun run demo`.
import { showAny } from '../dist/rune.esm.js'

const state = await showAny('#canvas', { spin: 0.8 })

// pause/resume есть у Show (webgl2) и WebGpuShow — берём активную ветку.
const active = state.webgpu ?? state.webgl2

const pauseButton = document.querySelector('#pause')
const resumeButton = document.querySelector('#resume')

pauseButton?.addEventListener('click', () => active?.pause())
resumeButton?.addEventListener('click', () => active?.resume())
