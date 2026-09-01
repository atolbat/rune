#!/usr/bin/env node
/**
 * postinstall: гарантирует workspace-симлинки node_modules/@rune/*.
 *
 * Часть окружений (например, bun 1.3.14 в контейнерах) не создаёт симлинки
 * workspace-пакетов автоматически. Скрипт идемпотентен: создаёт ссылку,
 * только если её нет, и не трогает существующие.
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
    continue // пакет без манифеста пропускаем
  }

  mkdirSync(modulesDir, { recursive: true })
  const link = join(modulesDir, name)
  if (existsSync(link)) continue
  try {
    symlinkSync(pkgDir, link, 'dir')
    created.push(`@rune/${name}`)
  } catch {
    // best effort — не ломаем установку
  }
}

if (created.length) console.log(`[rune] созданы workspace-симлинки: ${created.join(', ')}`)
