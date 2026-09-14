/**
 * scripts/research208-direct.mjs — the direct-HTTP harvest for Task 208's
 * fresh-sweep (the z-ai function quota is exhausted: web_search AND
 * page_reader both 429 — see graphics-research-208.md's caveat). Plan B:
 * plain fetch() against the KNOWN urls of the verified corpus, looking for
 * NEW status/material only (no blind discovery — every claim stays
 * page-verified):
 *   1. bevy PR #17413 (cross-frame HZB seed) — merged? when?
 *   2. bevy PR #18711 (late downsample)      — merged? when?
 *   3. bevy open PR list mentioning occlusion — any NEWER two-phase PRs
 *   4. therealmjp.github.io post index        — anything newer than Sep 2025
 * Output: scripts/out/research208/direct-*.json + console digest.
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const outDir = '/home/z/my-project/rune/scripts/out/research208'
mkdirSync(outDir, { recursive: true })

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }

async function grab(name, url, pick) {
  try {
    const res = await fetch(url, { headers, redirect: 'follow' })
    const html = await res.text()
    writeFileSync(`${outDir}/direct-${name}.html`, html)
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
    console.log(`\n=== [${name}] ${res.status} ${url}`)
    for (const re of pick) {
      const m = text.match(re)
      console.log(`  /${re.source}/ →`, m ? m[0].slice(0, 240) : '(no match)')
    }
    return { name, status: res.status, len: html.length }
  } catch (e) {
    console.log(`\n=== [${name}] FAIL ${e.message}`)
    return { name, fail: e.message }
  }
}

const out = []
// 1–2. the two bevy PRs — state badge + title
out.push(await grab('bevy-17413', 'https://github.com/bevyengine/bevy/pull/17413',
  [/Opened\s+on[^A-Za-z]*[^·]+·?\s*[^ ]* ?[^ ]* by \w+/, /\b(Merged|Closed|Open|Draft)\b[^·]{0,80}/, /[Tt]wo-phase occlusion culling[^·]{0,120}/]))
out.push(await grab('bevy-18711', 'https://github.com/bevyengine/bevy/pull/18711',
  [/\b(Merged|Closed|Open|Draft)\b[^·]{0,80}/, /[Ll]ate downsample[^·]{0,120}/]))
// 3. newer occlusion PRs in bevy
out.push(await grab('bevy-prs-occlusion', 'https://github.com/bevyengine/bevy/pulls?q=is%3Apr+occlusion+culling+sort%3Aupdated-desc',
  [/occlusion culling[^·]{0,100}/g]))
// 4. Pettineo index — newest posts
out.push(await grab('pettineo-index', 'https://therealmjp.github.io/',
  [/[A-Z][a-z]+ \d{1,2}, 20\d\d[^·]{0,60}/g]))

writeFileSync(`${outDir}/direct-summary.json`, JSON.stringify(out, null, 2))
console.log('\nharvest done →', outDir)
