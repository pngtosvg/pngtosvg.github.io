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

export interface BackgroundRemoval {
  image: Bitmap
  /** Areas of the background color enclosed by the artwork (letter counters, the inside of rings). */
  enclosed: number
}

/**
 * Makes a solid background transparent by flood-filling from the image border.
 * Only pixels connected to the edge and close to the dominant border color are removed,
 * so matching colors inside the artwork (e.g. white text) are kept, unless `enclosed`
 * asks to clear enclosed areas of that color too. Along the cut, the anti-aliased
 * pixels are "un-blended" from the background color, so edges come out softly
 * transparent instead of keeping a fringe of the old background.
 */
export function removeBackground(img: Bitmap, opts: { enclosed?: boolean; tolerance?: number } = {}): BackgroundRemoval {
  const { width: w, height: h } = img
  const tolerance = opts.tolerance ?? 32
  const src = img.data
  const approx = borderColor(img)
  if (!approx) return { image: img, enclosed: 0 }
  const data = new Uint8ClampedArray(src)
  const tol2 = tolerance * tolerance * 3
  const removed = new Uint8Array(w * h)
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (p: number) => {
    if (seen[p]) return
    seen[p] = 1
    const i = p * 4
    if (data[i + 3] < 16) { stack.push(p); return }
    const dr = data[i] - approx[0], dg = data[i + 1] - approx[1], db = data[i + 2] - approx[2]
    if (dr * dr + dg * dg + db * db <= tol2) stack.push(p)
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  let sr = 0, sg = 0, sb = 0, sn = 0
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    if (data[i + 3] >= 250) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sn++ }
    removed[p] = 1
    data[i + 3] = 0
    const x = p % w, y = (p / w) | 0
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (y > 0) push(p - w)
    if (y < h - 1) push(p + w)
  }
  if (!sn) return { image: { width: w, height: h, data }, enclosed: 0 }
  const bg = [sr / sn, sg / sn, sb / sn]

  // Areas of the background color that the fill couldn't reach: letter counters and the
  // inside of rings, but just as well white parts of the artwork, so they are only
  // cleared on request.
  const isBackground = (p: number) => {
    const i = p * 4
    if (src[i + 3] < 16) return false
    const dr = src[i] - bg[0], dg = src[i + 1] - bg[1], db = src[i + 2] - bg[2]
    return dr * dr + dg * dg + db * db <= tol2
  }
  const minArea = Math.max(16, Math.round(w * h * 0.00002))
  const visited = new Uint8Array(w * h)
  const visit = (p: number) => {
    if (removed[p] || visited[p] || !isBackground(p)) return
    visited[p] = 1
    stack.push(p)
  }
  const area: number[] = []
  let enclosed = 0
  for (let p0 = 0; p0 < w * h; p0++) {
    if (removed[p0] || visited[p0] || !isBackground(p0)) continue
    area.length = 0
    visit(p0)
    while (stack.length) {
      const p = stack.pop()!
      area.push(p)
      const x = p % w, y = (p / w) | 0
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (y > 0) visit(p - w)
      if (y < h - 1) visit(p + w)
    }
    if (area.length < minArea) continue
    enclosed++
    if (opts.enclosed) for (const p of area) { removed[p] = 1; data[p * 4 + 3] = 0 }
  }

  // Soften the cut. Pixels within 2px of the removed area may be anti-aliased blends of
  // the background with the artwork: take the foreground color from the nearest pixel
  // further in, and the alpha from how far the pixel is from background to foreground.
  const R = 2
  const band = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (removed[p] || data[p * 4 + 3] === 0) continue
      search: for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && removed[yy * w + xx]) { band[p] = 1; break search }
        }
      }
    }
  }
  const S = R + 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!band[p]) continue
      // Nearest solid pixel outside the band.
      let best = -1, bestD = Infinity
      for (let dy = -S; dy <= S; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -S; dx <= S; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (removed[q] || band[q] || src[q * 4 + 3] < 250) continue
          const dd = dx * dx + dy * dy
          if (dd < bestD) { bestD = dd; best = q }
        }
      }
      const i = p * 4
      const fg = best >= 0 ? [src[best * 4], src[best * 4 + 1], src[best * 4 + 2]] : null
      let a: number
      if (fg) {
        const fb = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]]
        const len2 = fb[0] * fb[0] + fb[1] * fb[1] + fb[2] * fb[2]
        if (len2 < 30 * 30) continue // foreground too close to the background to tell apart
        a = ((src[i] - bg[0]) * fb[0] + (src[i + 1] - bg[1]) * fb[1] + (src[i + 2] - bg[2]) * fb[2]) / len2
        a = Math.min(1, Math.max(0, a))
        if (a < 0.999) for (let c = 0; c < 3; c++) data[i + c] = fg[c]
      } else {
        // Thin artwork with no solid pixel nearby: classic "color to alpha".
        a = 0
        for (let c = 0; c < 3; c++) {
          const v = src[i + c], b = bg[c]
          const ca = v > b ? (b < 255 ? (v - b) / (255 - b) : 0) : v < b ? (b > 0 ? (b - v) / b : 0) : 0
          if (ca > a) a = ca
        }
        a = Math.min(1, a)
        if (a > 0.004 && a < 0.999) for (let c = 0; c < 3; c++) data[i + c] = bg[c] + (src[i + c] - bg[c]) / a
      }
      data[i + 3] = a <= 0.004 ? 0 : src[i + 3] * a
    }
  }
  return { image: { width: w, height: h, data }, enclosed }
}

/** True if the image sits on an opaque, uniform background (e.g. a logo exported on white). */
export function hasSolidBackground(img: Bitmap): boolean {
  const bg = borderColor(img)
  if (!bg) return false
  const { width: w, height: h, data } = img
  let total = 0, match = 0
  const check = (x: number, y: number) => {
    const i = (y * w + x) * 4
    total++
    const dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2]
    if (data[i + 3] >= 200 && dr * dr + dg * dg + db * db <= 40 * 40) match++
  }
  for (let x = 0; x < w; x++) { check(x, 0); check(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { check(0, y); check(w - 1, y) }
  return match >= total * 0.9
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
