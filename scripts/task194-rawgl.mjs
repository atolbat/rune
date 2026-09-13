// task194-rawgl — does RAW WebGL2 rasterize into an FBO on this stack?
// (bisect: rune out of the picture — a hand-rolled program, FBO, draw,
// readPixels). If this fails, the stack itself can't do GL offscreen;
// if it passes, the blankness lives in rune's GL path.
// Usage: bun scripts/task194-rawgl.mjs
import { chromium } from 'playwright'

const port = Number(process.env.TASK194RAW_PORT ?? 8183)
const HTML = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="256" height="256"></canvas>
<script>
const gl = document.querySelector('#c').getContext('webgl2', { antialias: false })
window.__res = { ok: false }
if (!gl) { window.__res.err = 'no webgl2' }
else {
  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, 'attribute vec3 position; void main() { gl_Position = vec4(position, 1.0); }')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, 'precision mediump float; void main() { gl_FragColor = vec4(0.9, 0.5, 0.2, 1.0); }')
  gl.compileShader(fs)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
  window.__res.compileErr = gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(prog) || ''
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.7, 0]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

  // the FBO path (the surface redirect analogue)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER)

  gl.viewport(0, 0, 256, 256)
  gl.clearColor(0.05, 0.06, 0.09, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(prog)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const px = new Uint8Array(256 * 256 * 4)
  gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px)
  let nonClear = 0
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - 13) > 8 || Math.abs(px[i + 1] - 15) > 8 || Math.abs(px[i + 2] - 23) > 8) nonClear++
  }
  window.__res = { ok: true, fboComplete: fboStatus === gl.FRAMEBUFFER_COMPLETE, nonClear, glErr: gl.getError() }
}
</script></body></html>`

const server = Bun.serve({ port, fetch: () => new Response(HTML, { headers: { 'content-type': 'text/html' } }) })
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__res !== undefined && (window.__res.ok || window.__res.err), null, { timeout: 30_000 })
  const r = await page.evaluate(() => window.__res)
  if (r.err) console.log(`[rawgl] FAIL: ${r.err}`)
  else {
    console.log(`[rawgl] FBO complete: ${r.fboComplete} · nonClear: ${r.nonClear}/65536 · gl error: ${r.glErr}` + (r.compileErr ? ` · compile: ${String(r.compileErr).slice(0, 120)}` : ''))
    console.log(`[rawgl] ${r.nonClear > 1000 ? "RAW GL RASTERIZES INTO FBO — the stack is fine, the bug is in rune GL path" : 'RAW GL CANNOT RASTERIZE — the stack itself'}`)
  }
} finally {
  await browser.close()
  server.stop()
}
