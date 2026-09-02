#!/usr/bin/env node
/**
 * postinstall: ensures the node_modules/@rune/* workspace symlinks.
 *
 * Some environments (e.g. bun 1.3.14 in containers) do not create workspace
 * package symlinks automatically. The script is idempotent: it creates a link
 * only if it is missing and never touches existing ones.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')
const modulesDir = join(root, 'node_modules', '@rune')

if (!existsSync(packagesDir)) process.exit(0)

const created = []

for (const entry of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, entry)
  if (!lstatSync(pkgDir).isDirectory()) continue

  let name
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
    if (typeof manifest?.name === 'string' && manifest.name.startsWith('@rune/')) {
      name = manifest.name.slice('@rune/'.length)
    } else {
      continue
    }
  } catch {
    continue // skip packages without a manifest
  }

  mkdirSync(modulesDir, { recursive: true })
  const link = join(modulesDir, name)
  if (existsSync(link)) continue
  try {
    symlinkSync(pkgDir, link, 'dir')
    created.push(`@rune/${name}`)
  } catch {
    // best effort — do not break the install
  }
}

if (created.length) console.log(`[rune] created workspace symlinks: ${created.join(', ')}`)
