/**
 * scripts/build.mjs — сборка библиотеки rune (запускать через bun).
 *
 * Артефакты:
 *   dist/rune.esm.js          — самодостаточный ESM-бандл мета-пакета @rune/gl
 *                               (внутри core/math/prims/webgl2/webgpu) — для демо и CDN.
 *   dist/rune.esm.min.js      — минифицированная копия.
 *   dist/rune-loaders.esm.js  — самодостаточный @rune/loaders (GLB/glTF/OBJ/FBX).
 *
 * Типы при этом не нужны: библиотека распространяется в исходниках TS,
 * bun/бандлеры берут типы прямо из src (exports → src/index.ts).
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirnameOf(import.meta.url), '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const targets = [
  { entrypoint: 'packages/gl/src/index.ts', outfile: 'rune.esm.js' },
  { entrypoint: 'packages/gl/src/index.ts', outfile: 'rune.esm.min.js', minify: true },
  { entrypoint: 'packages/loaders/src/index.ts', outfile: 'rune-loaders.esm.js' },
]

let failed = false

for (const { entrypoint, outfile, minify = false } of targets) {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    target: 'browser',
    format: 'esm',
    minify,
    sourcemap: minify ? 'linked' : 'none',
    naming: '[name].[ext]',
  })

  if (!result.success) {
    failed = true
    console.error(`[build] FAIL ${outfile}`)
    for (const log of result.logs) console.error(String(log))
    continue
  }

  await Bun.write(join(dist, outfile), result.outputs[0])
  const kb = (statSync(join(dist, outfile)).size / 1024).toFixed(1)
  console.log(`[build] ${outfile} — ${kb} KiB`)
}

process.exit(failed ? 1 : 0)

function dirnameOf(url) {
  return fileURLToPath(new URL('.', url))
}
