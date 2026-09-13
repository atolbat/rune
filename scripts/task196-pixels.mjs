// task196-pixels — count scene content classes in the demo screenshot
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

const png = PNG.sync.read(readFileSync('/home/z/my-project/tool-results/hiz-live.png'))
let warm = 0, slate = 0, dark = 0, other = 0
const warmPixels = []
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    // the clear color ~ (11,14,23); slate buildings ~ (60-90, 65-95, 85-120);
    // warm props: r >> b (amber/coral: r>120, r-b>40)
    if (r + g + b < 90) dark++
    else if (r - b > 50 && r > 110) { warm++; if (warmPixels.length < 5) warmPixels.push([x, y, r, g, b]) }
    else if (b > r && b > 70) slate++
    else other++
  }
}
console.log(`image ${png.width}x${png.height}: warm(props)=${warm} slate(buildings)=${slate} dark(bg)=${dark} other=${other}`)
console.log('sample warm pixels:', JSON.stringify(warmPixels))
