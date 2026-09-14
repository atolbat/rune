/**
 * scripts/research208-prstatus.mjs — status check for the fresh bevy PRs the
 * occlusion-search page surfaced (titles verified there; this pass grabs each
 * PR's state/merge info from its own page — every claim stays page-verified).
 */
import { writeFileSync } from 'node:fs'

const out = '/home/z/my-project/rune/scripts/out/research208'
const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' }
const PRS = [22603, 22631, 22286, 23555, 22699, 17951, 23544, 23483]

const report = []
for (const num of PRS) {
  try {
    const res = await fetch(`https://github.com/bevyengine/bevy/pull/${num}`, { headers })
    const html = await res.text()
    writeFileSync(`${out}/direct-bevy-${num}.html`, html)
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '?'
    const state = html.match(/"state":"([A-Z]+)"/)?.[1] ?? '?'
    const closedTime = html.match(/"closedTime":"([^"]+)"/)?.[1] ?? '?'
    const merged = /State State--merged/.test(html)
    const who = html.match(/([\w-]+)(?:<!-- -->)?\s*merged \d+ commits into/)?.[1] ?? null
    report.push({ num, state: merged ? 'MERGED' : state, closedTime, title: title.split('·')[0].trim() })
    console.log(`#${num} · ${merged ? 'MERGED' : state} · ${closedTime} · ${title.split('·')[0].trim().slice(0, 90)}`)
    await new Promise(r => setTimeout(r, 1500))
  } catch (e) { console.log(`#${num} FAIL ${e.message}`); report.push({ num, fail: e.message }) }
}
writeFileSync(`${out}/prstatus.json`, JSON.stringify(report, null, 2))
