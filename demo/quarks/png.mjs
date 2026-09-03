// png.mjs — a minimal, EXACT PNG decoder for the demo's sprite atlases.
//
// WHY NOT the browser's image pipeline (ImageBitmap / OffscreenCanvas)?
// The Task 118 lesson: the browser is IN the loop on every canvas →
// ImageBitmap → texImage path, and its premultiply/flip semantics vary.
// This decoder produces the RAW RGBA bytes of the file — no color
// management, no premultiply, no flip — so texture.upload() lands
// byte-identical texels on WebGL2 and WebGPU alike.
//
// Scope (deliberately narrow — it serves ONE asset):
//   • 8-bit RGBA (color type 6), non-interlaced — the texture1.png atlas
//   • zlib-wrapped IDAT streams via DecompressionStream('deflate')
//     (the RFC-1950 wrapper — NOT 'deflate-raw')
//   • all five scanline filters (None/Sub/Up/Average/Paeth)
// Chunks other than IHDR/IDAT/IEND are skipped (iCCP, pHYs, cHRM...).
//
// three.js loads this same PNG with flipY = true; our renderer uploads
// UNFLIPPED, and our tile math (row-major from the first byte row) picks
// the same source cells their shader picks — only the in-tile vertical
// orientation mirrors, which is imperceptible for smoke/flash blobs.

/** @returns {Promise<{width: number, height: number, data: Uint8Array}>} */
export async function decodePngRgba(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fetch ${url} → HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())

  // ── the signature ──
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('not a PNG (bad signature)')
  }

  // ── the chunks: IHDR + the IDAT run ──
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  /** @type {Uint8Array[]} */
  const idat = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const body = at + 8
    if (type === 'IHDR') {
      width = readU32(bytes, body)
      height = readU32(bytes, body + 4)
      bitDepth = bytes[body + 8]
      colorType = bytes[body + 9]
      interlace = bytes[body + 12]
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(body, body + length))
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  if (width <= 0 || height <= 0 || idat.length === 0) throw new Error('PNG has no image data')
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`only 8-bit RGBA PNGs are supported (got depth ${bitDepth}, color type ${colorType})`)
  }
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')

  // ── the zlib stream: concatenate the IDAT run, inflate ──
  let total = 0
  for (const part of idat) total += part.length
  const zlibBytes = new Uint8Array(total)
  let offset = 0
  for (const part of idat) { zlibBytes.set(part, offset); offset += part.length }
  const raw = await inflate(zlibBytes)

  // ── the scanlines: unfilter all five filters ──
  const stride = width * 4
  if (raw.length < height * (1 + stride)) throw new Error('inflated data is short of the declared size')
  const data = new Uint8Array(width * height * 4)
  let prev = null // the previous row's UNFILTERED bytes (null for row 0)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const row = raw.subarray(src, src + stride)
    src += stride
    if (filter === 1) { // Sub: left
      for (let i = 4; i < stride; i++) row[i] = (row[i] + row[i - 4]) & 255
    } else if (filter === 2) { // Up: above
      if (prev !== null) for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 255
    } else if (filter === 3) { // Average: floor((left + above) / 2)
      if (prev !== null) {
        for (let i = 0; i < 4; i++) row[i] = (row[i] + (prev[i] >> 1)) & 255
        for (let i = 4; i < stride; i++) row[i] = (row[i] + ((row[i - 4] + prev[i]) >> 1)) & 255
      } else {
        for (let i = 4; i < stride; i++) row[i] = (row[i] + (row[i - 4] >> 1)) & 255
      }
    } else if (filter === 4) { // Paeth
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0
        const b = prev !== null ? prev[i] : 0
        const c = i >= 4 && prev !== null ? prev[i - 4] : 0
        row[i] = (row[i] + paeth(a, b, c)) & 255
      }
    } // filter 0: None
    data.set(row, y * stride)
    prev = row
  }
  return { width, height, data }
}

/** RFC-1950 zlib ('deflate' — the wrapped form, as PNG stores it). */
async function inflate(zlibBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable in this browser')
  }
  const stream = new Blob([zlibBytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  return out
}

function readU32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

/** The Paeth predictor (RFC 2083, the PNG spec's own formulation). */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}
