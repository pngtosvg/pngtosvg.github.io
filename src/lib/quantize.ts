import type { Bitmap } from './raster.ts'

export interface Palette {
  /** sRGB colors, one per cluster. */
  colors: [number, number, number][]
  /** Main cluster per pixel, -1 for fully transparent pixels. */
  indices: Int16Array
  /**
   * Edge pixels that mix two palette colors (anti-aliasing) are split between them:
   * `second` is the other cluster (-1 if none) and `mix` its share (0–0.5).
   */
  second: Int16Array
  mix: Float32Array
  /** Number of solid (alpha >= threshold) pixels whose main cluster is each color. */
  counts: number[]
}

export interface QuantizeOptions {
  maxColors: number
  /** OKLab distance under which two clusters are merged into one color. */
  mergeDistance: number
  /** Clusters covering less than this share of opaque pixels are dropped. */
  minShare: number
  alphaThreshold: number
  /** Drop colors that are just a mix of two other colors (anti-aliasing), for flat artwork. */
  removeBlends?: boolean
}

type Lab = [number, number, number]
type Rgb = [number, number, number]

const srgbToLinear = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  srgbToLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function toOklab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear[r], lg = srgbToLinear[g], lb = srgbToLinear[b]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function dist2(a: Lab, b: Lab) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2]
  return d0 * d0 + d1 * d1 + d2 * d2
}

/** Deterministic PRNG so the same image and settings always give the same SVG. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

/**
 * Reduces the image to a small palette: k-means in OKLab over the distinct colors
 * (weighted by frequency), then merges near-duplicates and drops tiny clusters,
 * which is what keeps anti-aliasing ramps from turning into their own layers.
 */
export function quantize(img: Bitmap, opts: QuantizeOptions): Palette {
  const { data } = img
  const n = img.width * img.height

  // Histogram of distinct colors (5 bits per channel keeps it small and denoises).
  const hist = new Map<number, number>()
  const keys = new Int32Array(n)
  let opaque = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] < opts.alphaThreshold) { keys[p] = -1; continue }
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    keys[p] = key
    hist.set(key, (hist.get(key) ?? 0) + 1)
    opaque++
  }
  if (opaque === 0) return { colors: [], indices: new Int16Array(n).fill(-1), second: new Int16Array(n).fill(-1), mix: new Float32Array(n), counts: [] }

  // Mean sRGB per histogram bin, so output colors are exact rather than bin centers.
  const sums = new Map<number, [number, number, number]>()
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const k = keys[p]
    if (k < 0) continue
    const s = sums.get(k)
    if (s) { s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2] }
    else sums.set(k, [data[i], data[i + 1], data[i + 2]])
  }
  const binKeys = [...hist.keys()]
  const binIdx = new Int32Array(32768).fill(-1)
  binKeys.forEach((key, j) => (binIdx[key] = j))
  const binW = binKeys.map((k) => hist.get(k)!)
  const binRgb = binKeys.map((k, j) => {
    const s = sums.get(k)!
    return [s[0] / binW[j], s[1] / binW[j], s[2] / binW[j]] as [number, number, number]
  })
  const binLab = binRgb.map(([r, g, b]) => toOklab(Math.round(r), Math.round(g), Math.round(b)))

  const k = Math.max(1, Math.min(opts.maxColors, binKeys.length))
  const centers = kmeansPlusPlus(binLab, binW, k)
  const assign = new Int32Array(binKeys.length)
  for (let iter = 0; iter < 16; iter++) {
    let changed = false
    for (let j = 0; j < binLab.length; j++) {
      const c = nearest(centers, binLab[j])
      if (c !== assign[j]) { changed = true; assign[j] = c }
    }
    const acc = centers.map(() => [0, 0, 0, 0])
    for (let j = 0; j < binLab.length; j++) {
      const a = acc[assign[j]], w = binW[j], l = binLab[j]
      a[0] += l[0] * w; a[1] += l[1] * w; a[2] += l[2] * w; a[3] += w
    }
    for (let c = 0; c < centers.length; c++) {
      const a = acc[c]
      if (a[3] > 0) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]
    }
    if (!changed && iter > 0) break
  }

  // Cluster stats in sRGB (weighted by pixel count).
  // Flat artwork uses each cluster's most common color (exact, unaffected by edge pixels);
  // continuous-tone images use the mean.
  let clusters = centers.map(() => ({ w: 0, rgb: [0, 0, 0] as Rgb, lab: [0, 0, 0] as Lab, top: -1 }))
  for (let j = 0; j < binLab.length; j++) {
    const c = clusters[assign[j]], w = binW[j]
    c.w += w
    for (let ch = 0; ch < 3; ch++) c.rgb[ch] += binRgb[j][ch] * w
    if (c.top < 0 || w > binW[c.top]) c.top = j
  }
  clusters = clusters.filter((c) => c.w > 0)
  for (const c of clusters) {
    c.rgb = opts.removeBlends ? [...binRgb[c.top]] : (c.rgb.map((v) => v / c.w) as Rgb)
    c.lab = toOklab(Math.round(c.rgb[0]), Math.round(c.rgb[1]), Math.round(c.rgb[2]))
  }

  // Merge clusters that are visually the same color.
  const merge2 = opts.mergeDistance * opts.mergeDistance
  for (;;) {
    let bi = -1, bj = -1, bd = merge2
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist2(clusters[i].lab, clusters[j].lab)
        if (d < bd) { bd = d; bi = i; bj = j }
      }
    }
    if (bi < 0) break
    const a = clusters[bi], b = clusters[bj]
    // Keep the dominant color exact instead of averaging towards the minority,
    // so flat logo colors don't drift.
    const keep = a.w >= b.w ? a : b
    clusters[bi] = { ...keep, w: a.w + b.w }
    clusters.splice(bj, 1)
  }

  // Anti-aliased edges between two colors produce in-between colors. For flat artwork
  // those are never real fills, so any minor color lying between two bigger ones goes.
  // For continuous-tone images only thin ones go (1–3 px fringes along an edge), so
  // real gradient bands survive.
  if (clusters.length > 2) {
    const thin = opts.removeBlends ? null : thinClusters(clusters.map((c) => c.lab), binLab, binIdx, keys, img.width, img.height)
    const flags = clusters.map((c, i) => ({ c, thin: thin ? thin[i] : true }))
    for (;;) {
      const order = flags.map((_, i) => i).sort((a, b) => flags[a].c.w - flags[b].c.w)
      const victim = order.find((ci) => {
        const { c, thin } = flags[ci]
        if (!thin || c.w > opaque * 0.2) return false
        for (let a = 0; a < flags.length; a++) {
          for (let b = a + 1; b < flags.length; b++) {
            const A = flags[a].c, B = flags[b].c
            if (a === ci || b === ci || A.w < c.w || B.w < c.w) continue
            if (isBlend(c.rgb, A.rgb, B.rgb)) return true
          }
        }
        return false
      })
      if (victim === undefined) break
      flags.splice(victim, 1)
    }
    clusters = flags.map((f) => f.c)
  }

  // Drop clusters too small to matter (their pixels join the nearest survivor).
  const minW = opaque * opts.minShare
  const kept = clusters.filter((c) => c.w >= minW)
  if (kept.length) clusters = kept
  else clusters = [clusters.reduce((a, b) => (a.w >= b.w ? a : b))]

  // Final assignment of every visible pixel, including faint edge pixels, as a main
  // color plus an optional second color it is blended with.
  const labs = clusters.map((c) => c.lab)
  const rgbs = clusters.map((c) => c.rgb)
  const decA = new Int16Array(32768).fill(-2) // -2: not computed yet
  const decB = new Int16Array(32768)
  const decN = new Int16Array(32768)
  const indices = new Int16Array(n)
  const second = new Int16Array(n).fill(-1)
  const mix = new Float32Array(n)
  const counts = new Array(clusters.length).fill(0)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] === 0) { indices[p] = -1; continue }
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    if (decA[key] === -2) {
      const j = binIdx[key]
      const rgb: Rgb = j >= 0 ? binRgb[j] : [r, g, b]
      const lab = j >= 0 ? binLab[j] : toOklab(r, g, b)
      const near = nearest(labs, lab)
      const pair = blendPair(rgb, rgbs, near, !!opts.removeBlends)
      decN[key] = near
      decA[key] = pair ? pair[0] : near
      decB[key] = pair ? pair[1] : -1
    }
    // Semi-transparent pixels blend with the background, not with another color, and
    // their un-premultiplied RGB is imprecise: they simply belong to their nearest color
    // (alpha alone carries the partial coverage).
    const solid = data[i + 3] >= 230
    const A = solid ? decA[key] : decN[key], B = solid ? decB[key] : -1
    let main = A
    if (B >= 0) {
      const ca = rgbs[A], cb = rgbs[B]
      const dr = cb[0] - ca[0], dg = cb[1] - ca[1], db = cb[2] - ca[2]
      const t = Math.min(1, Math.max(0, ((r - ca[0]) * dr + (g - ca[1]) * dg + (b - ca[2]) * db) / (dr * dr + dg * dg + db * db)))
      main = t < 0.5 ? A : B
      second[p] = t < 0.5 ? B : A
      mix[p] = t < 0.5 ? t : 1 - t
    }
    indices[p] = main
    if (data[i + 3] >= opts.alphaThreshold) counts[main]++
  }
  return {
    colors: clusters.map((c) => c.rgb.map((v) => Math.round(v)) as Rgb),
    indices,
    second,
    mix,
    counts,
  }
}

/**
 * Flags clusters whose regions are only a few pixels wide everywhere (area small
 * relative to their boundary), i.e. edge fringes rather than fills.
 */
function thinClusters(labs: Lab[], binLab: Lab[], binIdx: Int32Array, keys: Int32Array, w: number, h: number): boolean[] {
  const binLabel = binLab.map((l) => nearest(labs, l))
  const label = new Int16Array(w * h)
  for (let p = 0; p < label.length; p++) label[p] = keys[p] < 0 ? -1 : binLabel[binIdx[keys[p]]]
  const area = new Float64Array(labs.length)
  const edge = new Float64Array(labs.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const l = label[p]
      if (l < 0) continue
      area[l]++
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || label[p - 1] !== l || label[p + 1] !== l || label[p - w] !== l || label[p + w] !== l) edge[l]++
    }
  }
  return labs.map((_, i) => area[i] < edge[i] * 1.6)
}

/**
 * True if `c` sits on the segment between `a` and `b` (not at either end).
 * Checked in sRGB, the space where edge anti-aliasing actually mixes colors.
 */
function isBlend(c: Rgb, a: Rgb, b: Rgb) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  if (len2 < 400) return false
  const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2
  if (t < 0.06 || t > 0.94) return false
  let d = 0
  for (let i = 0; i < 3; i++) d += (a[i] + ab[i] * t - c[i]) ** 2
  return d < 20 * 20
}

/**
 * The two palette colors an edge pixel is a mix of, if it is one. For flat artwork any
 * pair qualifies, so a yellow/blue edge pixel never turns into some unrelated red that
 * happens to be closer; for photos the pair must include the nearest color.
 */
function blendPair(c: Rgb, colors: Rgb[], near: number, anyPair: boolean): [number, number] | null {
  const d2 = (x: Rgb, y: Rgb) => (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2
  let best: [number, number] | null = null
  let bestD = d2(c, colors[near]) * 0.5
  if (bestD < 4) return null // already (almost) exactly a palette color
  for (let a = 0; a < colors.length; a++) {
    if (!anyPair && a !== near) continue
    for (let b = 0; b < colors.length; b++) {
      if (b === a || (anyPair && b < a)) continue
      const A = colors[a], B = colors[b]
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
      if (len2 < 1) continue
      const t = ((c[0] - A[0]) * ab[0] + (c[1] - A[1]) * ab[1] + (c[2] - A[2]) * ab[2]) / len2
      if (t <= 0 || t >= 1) continue
      const d = (A[0] + ab[0] * t - c[0]) ** 2 + (A[1] + ab[1] * t - c[1]) ** 2 + (A[2] + ab[2] * t - c[2]) ** 2
      if (d < bestD) { bestD = d; best = [a, b] }
    }
  }
  return best
}

function nearest(centers: Lab[], p: Lab) {
  let best = 0, bd = Infinity
  for (let c = 0; c < centers.length; c++) {
    const d = dist2(centers[c], p)
    if (d < bd) { bd = d; best = c }
  }
  return best
}

function kmeansPlusPlus(points: Lab[], weights: number[], k: number): Lab[] {
  const rand = rng(0x9e3779b9)
  // Start from the most frequent color: for logos this is almost always a real fill color.
  let first = 0
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[first]) first = i
  const centers: Lab[] = [points[first]]
  const d = points.map((p) => dist2(p, points[first]))
  while (centers.length < k) {
    let total = 0
    for (let i = 0; i < points.length; i++) total += d[i] * weights[i]
    if (total <= 0) break
    let r = rand() * total, pick = 0
    for (let i = 0; i < points.length; i++) {
      r -= d[i] * weights[i]
      if (r <= 0) { pick = i; break }
    }
    centers.push(points[pick])
    for (let i = 0; i < points.length; i++) d[i] = Math.min(d[i], dist2(points[i], points[pick]))
  }
  return centers
}
