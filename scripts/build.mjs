/**
 * scripts/build.mjs — builds the rune library (run with bun).
 *
 * Artifacts:
 *   dist/rune.esm.js          — a self-contained ESM bundle of the @rune/gl meta-package
 *                               (core/math/prims/webgl2/webgpu inside) — for demos and CDN.
 *   dist/rune.esm.min.js      — the minified copy.
 *   dist/rune-loaders.esm.js  — a self-contained @rune/loaders (GLB/glTF/OBJ/FBX).
 *   dist/rune-animation.esm.js — a self-contained @rune/animation (skeletal
 *                               animation: sampling, hierarchy, skin palette).
 *   dist/rune-materials.esm.js — a self-contained @rune/materials (the
 *                               feature-mask shader assembly pipeline).
 *
 * Types are not needed here: the library ships as TS sources,
 * bun/bundlers take the types straight from src (exports → src/index.ts).
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
  { entrypoint: 'packages/animation/src/index.ts', outfile: 'rune-animation.esm.js' },
  { entrypoint: 'packages/materials/src/index.ts', outfile: 'rune-materials.esm.js' },
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
