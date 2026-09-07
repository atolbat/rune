// task149-static — the MIME-correct static server for the probes that
// expect an already-running server (task134-vfx-probe: PORT ?? 8099).
// The Task-147 lesson: ad-hoc servers MUST carry the correct MIME map
// (.css as text/css) or the stylesheet is rejected and the canvas stays
// inline 300x150 in the corner.
import { join } from 'node:path'

const root = '/home/z/my-project/rune'
const port = Number(process.argv[2] ?? 8099)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}
Bun.serve({
  port,
  async fetch(request) {
    let pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname === '/') pathname = '/demo/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = Bun.file(join(root, pathname))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const ext = pathname.slice(pathname.lastIndexOf('.'))
    return new Response(file, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } })
  },
})
console.log(`[task149-static] serving ${root} on :${port}`)
