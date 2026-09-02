import { measureFrameBuilders } from './frameBench.ts'

// Benchmark M1: verifies the versioned segments mechanism
// (design dossier, ch. 9: ×37 on Node/V8; here — real code paths).

const engine = typeof Bun !== 'undefined' ? 'bun/JSC' : `node/${process.version} (V8)`
const result = measureFrameBuilders(1000, 16, 20, 7)

console.log('── M1: versioned segments vs full rewrite ──')
console.log(`engine                  : ${engine}`)
console.log(
  `commands: ${result.commands}, ops per command: ${result.opsPerCommand}, ` +
  `dirty per frame: ${result.dirtyPerFrame}`,
)
console.log(`full frame rewrite       : ${result.fullMs.toFixed(3)} ms`)
console.log(`segment cache           : ${result.cachedMs.toFixed(3)} ms`)
console.log(`speedup                 : ×${result.speedup.toFixed(1)}`)
