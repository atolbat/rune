/**
 * scripts/serve-demo.mjs — a static server for the demos (run with bun).
 *
 * Serves the repository root: /demo/ — the demos page, /dist/* — the built
 * library bundles. Port: 8080 (override: PORT=…).
 *
 * Usage: bun run demo   (= build + this server)
 */
import { join, normalize, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.PORT ?? 8080)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)

    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'

    // Only inside the repository root (no ../)
    const safe = normalize(pathname).replace(/^([.][.][/\\])+/, '')
    const file = Bun.file(join(root, safe))

    if (!(await file.exists())) {
      return new Response(`not found: ${pathname}`, { status: 404 })
    }
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    const type = MIME[ext] ?? 'application/octet-stream'
    return new Response(file, { headers: { 'content-type': type } })
  },
})

console.log(`[demo] http://localhost:${port}/demo/          (demo gallery)`)
console.log(`[demo] http://localhost:${port}/demo/hello-cube/  (bundles: /dist/)`)
