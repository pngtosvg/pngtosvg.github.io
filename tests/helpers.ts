import fs from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import type { Bitmap } from '../src/lib/raster.ts'

/** Renders an SVG to straight-alpha RGBA, like a browser's getImageData(). */
export function rasterize(svg: string, width?: number): Bitmap {
  const img = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { loadSystemFonts: true },
  }).render()
  // resvg returns premultiplied pixels.
  const data = new Uint8ClampedArray(img.pixels)
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a > 0 && a < 255) for (let c = 0; c < 3; c++) data[i + c] = (data[i + c] * 255) / a
  }
  return { width: img.width, height: img.height, data }
}

export function fixture(name: string): string {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** Mean per-channel difference (0–255) of two same-size images, composited over white. */
export function meanDiff(a: Bitmap, b: Bitmap): number {
  let sum = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const va = (a.data[i + c] * a.data[i + 3] + 255 * (255 - a.data[i + 3])) / 255
      const vb = (b.data[i + c] * b.data[i + 3] + 255 * (255 - b.data[i + 3])) / 255
      sum += Math.abs(va - vb)
    }
  }
  return sum / ((a.data.length / 4) * 3)
}
