#!/usr/bin/env node
/** Один раз выравнивает манифесты всех workspace-пакетов rune. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? process.cwd()
const SCOPE = '@rune/'
const packagesDir = join(ROOT, 'packages')

let changed = 0

for (const entry of readdirSync(packagesDir)) {
  const file = join(packagesDir, entry, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    continue
  }
  if (!pkg.name?.startsWith(SCOPE)) continue

  const deps = pkg.dependencies ?? {}
  const devDeps = pkg.devDependencies ?? {}

  const unified = {
    name: pkg.name,
    version: pkg.version ?? '0.1.0',
    type: 'module',
    license: 'MIT',
    exports: { '.': './src/index.ts' },
    // ВНИМАНИЕ: без "sideEffects": false — bun build (1.3.14) перетряхивает
    // ре-экспортные цепочки в пустой каркас при этом флаге.
    ...(Object.keys(deps).length ? { dependencies: sorted(deps) } : {}),
    ...(Object.keys(devDeps).length ? { devDependencies: sorted(devDeps) } : {}),
  }

  const before = JSON.stringify(pkg)
  const after = JSON.stringify(unified)
  if (before !== after) {
    writeFileSync(file, JSON.stringify(unified, null, 2) + '\n')
    changed++
    console.log(`unified: ${pkg.name}`)
  }
}

console.log(changed ? `${changed} manifest(s) updated` : 'all manifests consistent')

function sorted(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}
