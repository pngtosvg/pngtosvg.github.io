import type { Bitmap } from './raster.ts'

/** Largest side we decode at; bigger images are downscaled (tracing works below this anyway). */
const MAX_SIDE = 4096

export interface LoadedImage {
  bitmap: Bitmap
  url: string
  name: string
  bytes: number
  /** Original dimensions before any safety downscale. */
  width: number
  height: number
}

export async function loadImage(file: Blob, name = 'image.png'): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.')
  let source: ImageBitmap
  try {
    source = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  } catch {
    throw new Error('This image could not be decoded. Try a PNG, JPG or WebP file.')
  }
  const { width, height } = source
  const k = Math.min(1, MAX_SIDE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  source.close()
  const data = ctx.getImageData(0, 0, w, h).data
  return {
    bitmap: { width: w, height: h, data },
    url: URL.createObjectURL(file),
    name,
    bytes: file.size,
    width,
    height,
  }
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
