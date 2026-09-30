/** Plain RGBA bitmap that can cross the worker boundary. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Bounding box of pixels whose alpha is at least `threshold`. Null if the image is fully transparent. */
export function opaqueBounds(img: Bitmap, threshold: number): Rect | null {
  const { width, height, data } = img
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    let row = y * width * 4 + 3
    for (let x = 0; x < width; x++, row += 4) {
      if (data[row] >= threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function crop(img: Bitmap, r: Rect): Bitmap {
  if (r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height) return img
  const out = new Uint8ClampedArray(r.width * r.height * 4)
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4
    out.set(img.data.subarray(src, src + r.width * 4), y * r.width * 4)
  }
  return { width: r.width, height: r.height, data: out }
}

/**
 * Makes a solid background transparent by flood-filling from the image border.
 * Only pixels connected to the edge and close to the dominant border color are removed,
 * so matching colors inside the artwork (e.g. white text) are kept.
 */
export function removeBackground(img: Bitmap, tolerance = 32): Bitmap {
  const { width: w, height: h } = img
  const src = img.data
  const bg = borderColor(img)
  if (!bg) return img
  const data = new Uint8ClampedArray(src)
  const tol2 = tolerance * tolerance * 3
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (p: number) => {
    if (seen[p]) return
    seen[p] = 1
    const i = p * 4
    if (data[i + 3] < 16) { stack.push(p); return }
    const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2]
    if (dr * dr + dg * dg + db * db <= tol2) stack.push(p)
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (stack.length) {
    const p = stack.pop()!
    data[p * 4 + 3] = 0
    const x = p % w, y = (p / w) | 0
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (y > 0) push(p - w)
    if (y < h - 1) push(p + w)
  }
  return { width: w, height: h, data }
}

/** Most common opaque color on the image border, if the border is mostly one color. */
function borderColor(img: Bitmap): [number, number, number] | null {
  const { width: w, height: h, data } = img
  const counts = new Map<number, number>()
  let total = 0
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4
    if (data[i + 3] < 200) return
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y) }
  let best = -1, bestCount = 0
  for (const [k, c] of counts) if (c > bestCount) { best = k; bestCount = c }
  if (best < 0 || bestCount < total * 0.5) return null
  return [((best >> 10) & 31) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4]
}

/**
 * Resizes with bilinear interpolation (upscaling) or box averaging (downscaling),
 * in premultiplied alpha so transparent pixels don't bleed dark fringes into edges.
 */
export function resize(img: Bitmap, width: number, height: number): Bitmap {
  if (width === img.width && height === img.height) return img
  const { width: sw, height: sh, data: s } = img
  const out = new Uint8ClampedArray(width * height * 4)
  if (width >= sw && height >= sh) {
    const fx = sw / width, fy = sh / height
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5))
      const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5))
        const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4
        const a00 = s[i00 + 3] * w00, a10 = s[i10 + 3] * w10, a01 = s[i01 + 3] * w01, a11 = s[i11 + 3] * w11
        const a = a00 + a10 + a01 + a11
        const o = (y * width + x) * 4
        out[o + 3] = a
        if (a > 0) {
          for (let c = 0; c < 3; c++) {
            out[o + c] = (s[i00 + c] * a00 + s[i10 + c] * a10 + s[i01 + c] * a01 + s[i11 + c] * a11) / a
          }
        }
      }
    }
    return { width, height, data: out }
  }
  // Box filter downscale.
  const fx = sw / width, fy = sh / height
  for (let y = 0; y < height; y++) {
    const ys = Math.floor(y * fy), ye = Math.max(ys + 1, Math.floor((y + 1) * fy))
    for (let x = 0; x < width; x++) {
      const xs = Math.floor(x * fx), xe = Math.max(xs + 1, Math.floor((x + 1) * fx))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = ys; yy < ye && yy < sh; yy++) {
        for (let xx = xs; xx < xe && xx < sw; xx++) {
          const i = (yy * sw + xx) * 4
          const al = s[i + 3]
          r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++
        }
      }
      const o = (y * width + x) * 4
      out[o + 3] = a / n
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a }
    }
  }
  return { width, height, data: out }
}
