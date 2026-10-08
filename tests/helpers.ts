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

/**
 * Imitates lossy compression (JPEG, WebP): color kept at half resolution (4:2:0) and
 * noise on brightness. Deterministic.
 */
export function compress(img: Bitmap, noise = 3): Bitmap {
  const { width: w, height: h, data } = img
  let seed = 3
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const Y = new Float32Array(w * h), Cb = new Float32Array(w * h), Cr = new Float32Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2]
    Y[p] = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[p] = -0.1687 * r - 0.3313 * g + 0.5 * b
    Cr[p] = 0.5 * r - 0.4187 * g - 0.0813 * b
  }
  const out = new Uint8ClampedArray(data)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cb = 0, cr = 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const q = Math.min(h - 1, (y & ~1) + dy) * w + Math.min(w - 1, (x & ~1) + dx)
          cb += Cb[q] / 4; cr += Cr[q] / 4
        }
      }
      const p = y * w + x
      const l = Y[p] + (rnd() - 0.5) * 2 * noise
      out[p * 4] = l + 1.402 * cr
      out[p * 4 + 1] = l - 0.34414 * cb - 0.71414 * cr
      out[p * 4 + 2] = l + 1.772 * cb
    }
  }
  return { width: w, height: h, data: out }
}
