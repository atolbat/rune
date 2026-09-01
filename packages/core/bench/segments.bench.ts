import { measureFrameBuilders } from './frameBench.ts'

// Бенчмарк M1: проверяет механизм версионированных сегментов
// (дизайн-досье, гл. 9: ×37 на Node/V8; здесь — реальные пути кода).

const engine = typeof Bun !== 'undefined' ? 'bun/JSC' : `node/${process.version} (V8)`
const result = measureFrameBuilders(1000, 16, 20, 7)

console.log('── M1: версионированные сегменты против полной перезаписи ──')
console.log(`движок                  : ${engine}`)
console.log(
  `команд: ${result.commands}, операций на команду: ${result.opsPerCommand}, ` +
  `грязных за кадр: ${result.dirtyPerFrame}`,
)
console.log(`полная перезапись кадра : ${result.fullMs.toFixed(3)} мс`)
console.log(`сегментный кэш          : ${result.cachedMs.toFixed(3)} мс`)
console.log(`ускорение               : ×${result.speedup.toFixed(1)}`)
