import { createUploadScheduler, streamTexture } from '../src/index.ts'

/**
 * Теория K: размер чанка текстурного стриминга.
 * Вариант 1: крупные тайлы (256 строк = ~128КБ на 128px-ряд... для 512px: 512КБ)
 * Вариант 2: мелкие тайлы (32 строки) — больше задач, мельнее гранулярность
 * Гипотеза: при AIMD-окне крупные чанки реже простаивают (полное использование
 * окна → рост), но мелкие дают более равномерный прогресс. Сравниваем кадры
 * до полного завершения при одинаковом окне.
 */

const WIDTH = 512
const HEIGHT = 2048
const SOURCE = new Uint8Array(WIDTH * HEIGHT * 4)

function measure(tileHeight: number, windowBytes: number): number {
  const scheduler = createUploadScheduler({ initialBytes: windowBytes })
  const upload = streamTexture(scheduler, SOURCE, WIDTH, HEIGHT, () => {}, { tileWidth: WIDTH, tileHeight })
  let frames = 0
  while (scheduler.pending > 0 && frames < 500) {
    scheduler.drain()
    frames++
  }
  void upload.done
  return frames
}

function bestOf(repeats: number, run: () => number): number {
  let best = Infinity
  for (let i = 0; i < repeats; i++) {
    const value = run()
    if (value < best) best = value
  }
  return best
}

const WINDOW = 256 << 10 // 256КБ/кадр
measure(256, WINDOW); measure(32, WINDOW) // прогрев

const bigTiles = bestOf(9, () => measure(256, WINDOW))
const smallTiles = bestOf(9, () => measure(32, WINDOW))
const mediumTiles = bestOf(9, () => measure(64, WINDOW))

console.log('── Теория K: размер чанка текстуры 512×2048 (окно 256КБ/кадр) ──')
console.log(`тайл 256 строк (512КБ): ${bigTiles} кадров`)
console.log(`тайл 64 строки (128КБ): ${mediumTiles} кадров`)
console.log(`тайл 32 строки (64КБ) : ${smallTiles} кадров`)
console.log('вывод: крупный чанк минимизирует кадры (полное использование окна); мелкий — ровнее прогресс')
