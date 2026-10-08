import { blur121 } from './filters.ts'
import { toOklab, type Palette } from './quantize.ts'
import type { Bitmap } from './raster.ts'

export type Rgb = [number, number, number]

export interface Stop {
  /** 0–1 along the gradient. */
  offset: number
  color: Rgb
}

/** How a palette entry is painted. Coordinates are in working pixels (pixel centers at +0.5). */
export type Fill =
  | { type: 'flat'; color: Rgb }
  | { type: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: Stop[] }
  | { type: 'radial'; cx: number; cy: number; r: number; stops: Stop[] }

export interface RefineOptions {
  /** Fit linear/radial gradients to regions whose color changes smoothly. */
  gradients: boolean
  /** Regions smaller than this many pixels are left to the quantizer. */
  minRegion: number
  /** Pixels at least this opaque (0–255) count as solid. */
  alphaThreshold: number
}

/** Max color step (RGB distance, after a light blur) between neighbours of one region. */
const TAU = 12
/** Max color change per pixel (central difference) for a pixel to belong to a region. */
const MAX_EDGE = 10
/** A region whose colors vary less than this (RMS), with hardly any pixel off by more than OUTLIER, is one flat color. */
const FLAT_RMS = 6
const OUTLIER = 12
/** Max RMS error of an accepted gradient model. */
const GRADIENT_RMS = 4.5
/** A gradient must span at least this much color, and change at most this fast per px. */
const MIN_SPAN = 20
const MAX_SLOPE = 10
/** OKLab distance under which a region's color is taken to be an existing palette color… */
const SAME_COLOR = 0.04
/** …unless a bigger region already set that color exactly and this one is clearly different. */
const DISTINCT = 0.012
const MAX_SAMPLES = 40000
/** Smallest color error (RGB distance) a gradient stop has to fix to be kept. */
const STOP_TOLERANCE = 4
/** Colors within this distance of a region's dominant color form a plateau (see peelPlateau). */
const PLATEAU = 8

/**
 * Looks at the image as regions rather than single pixels, to understand colors the
 * way a designer drew them:
 *
 * - pixels joined by small color steps form a region (a flat fill, or a gradient whose
 *   color drifts smoothly), while edges between shapes separate regions;
 * - a flat region gets one exact color (median), so compression noise that split it
 *   into several near-identical clusters disappears, and a small but distinct accent
 *   keeps its own color instead of being folded into a bigger cluster;
 * - a region whose color changes smoothly is fitted with a linear or radial gradient
 *   (with as many stops as it needs) and becomes its own palette entry;
 * - edge pixels next to refined regions are re-split between the colors actually
 *   present at that spot (a gradient's local color), so outlines stay precise.
 *
 * Mutates `pal` (labels, counts, appended colors) and returns a fill per entry.
 */
export function refineColors(img: Bitmap, pal: Palette, opts: RefineOptions): Fill[] {
  const { width: w, height: h, data } = img
  const n = w * h
  for (let i = 0; i < pal.colors.length; i++) pal.colors[i] = snap(pal.colors[i])
  const fills: Fill[] = pal.colors.map((c) => ({ type: 'flat', color: c }))
  if (n === 0) return fills

  // Lightly smoothed colors (alpha-weighted, so transparency doesn't bleed in) for the
  // connectivity test and gradient fits: steps inside a gradient stay small and
  // compression noise is damped, while real edges stay steep.
  const sr = new Float32Array(n), sg = new Float32Array(n), sb = new Float32Array(n), sa = new Float32Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = data[i + 3] / 255
    sr[p] = data[i] * a; sg[p] = data[i + 1] * a; sb[p] = data[i + 2] * a; sa[p] = a
  }
  const scratch = new Float32Array(n)
  for (const f of [sr, sg, sb, sa]) blur121(f, w, h, scratch)
  for (let p = 0; p < n; p++) {
    const a = sa[p]
    if (a > 0) { sr[p] /= a; sg[p] /= a; sb[p] /= a }
  }

  // Pixels that take part in region growing: opaque, and not on an edge. Along an
  // anti-aliased edge at a shallow angle, neighbours *in the edge's direction* differ
  // only slightly, so a pure step test would let regions leak through it; across the
  // edge the change is steep, which this test catches.
  const solid = new Uint8Array(n)
  const edge2 = MAX_EDGE * MAX_EDGE * 4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (data[p * 4 + 3] < 230) continue
      const l = x > 0 ? p - 1 : p, r = x < w - 1 ? p + 1 : p
      const u = y > 0 ? p - w : p, d = y < h - 1 ? p + w : p
      const gx = (sr[r] - sr[l]) ** 2 + (sg[r] - sg[l]) ** 2 + (sb[r] - sb[l]) ** 2
      const gy = (sr[d] - sr[u]) ** 2 + (sg[d] - sg[u]) ** 2 + (sb[d] - sb[u]) ** 2
      if (gx <= edge2 && gy <= edge2) solid[p] = 1
    }
  }

  // Region growing.
  const label = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const sizes: number[] = []
  const tau2 = TAU * TAU
  for (let p0 = 0; p0 < n; p0++) {
    if (!solid[p0] || label[p0] >= 0) continue
    const id = sizes.length
    label[p0] = id
    let sp = 0, size = 0
    stack[sp++] = p0
    while (sp) {
      const q = stack[--sp]
      size++
      const x = q % w
      const r0 = sr[q], g0 = sg[q], b0 = sb[q]
      for (let k = 0; k < 4; k++) {
        const nb = k === 0 ? (x > 0 ? q - 1 : -1) : k === 1 ? (x < w - 1 ? q + 1 : -1) : k === 2 ? q - w : q + w
        if (nb < 0 || nb >= n || !solid[nb] || label[nb] >= 0) continue
        const dr = sr[nb] - r0, dg = sg[nb] - g0, db = sb[nb] - b0
        if (dr * dr + dg * dg + db * db <= tau2) { label[nb] = id; stack[sp++] = nb }
      }
    }
    sizes.push(size)
  }

  // Members of the regions worth analysing, grouped by region (counting sort).
  const regions = sizes.length
  const start = new Int32Array(regions + 1)
  for (let r = 0; r < regions; r++) start[r + 1] = start[r] + (sizes[r] >= opts.minRegion ? sizes[r] : 0)
  const members = new Int32Array(start[regions])
  const cursor = start.slice(0, regions)
  for (let p = 0; p < n; p++) {
    const l = label[p]
    if (l >= 0 && sizes[l] >= opts.minRegion) members[cursor[l]++] = p
  }

  const overridden = new Uint8Array(n)
  const labs = pal.colors.map((c) => toOklab(c[0], c[1], c[2]))
  const flatEntries = pal.colors.map((_, i) => i)
  const weight: number[] = pal.colors.map(() => 0)
  const original = pal.colors.length
  /** Entries that are the color of at least one refined region. */
  const regionColor: boolean[] = pal.colors.map(() => false)
  /** New flat colors found by region analysis, capped so texture can't add dozens. */
  let rescued = 0
  const maxRescued = Math.max(3, Math.ceil(original / 2))
  /** Membership of the pixel set being analysed (compared against `stamp`). */
  const mark = new Int32Array(n)
  let stamp = 0

  /** Fits a set of connected pixels and gives the ones that match the model its fill. */
  const refine = (pix: Int32Array, depth: number) => {
    const set = ++stamp
    for (let k = 0; k < pix.length; k++) mark[pix[k]] = set

    // Interior pixels (all neighbours in the set) are free of anti-aliasing.
    const interior: number[] = []
    let perimeter = 0
    let x0 = w, y0 = h, x1 = 0, y1 = 0
    for (let k = 0; k < pix.length; k++) {
      const p = pix[k]
      const x = p % w, y = (p / w) | 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const inside =
        (x === 0 || mark[p - 1] === set) && (x === w - 1 || mark[p + 1] === set) &&
        (y === 0 || mark[p - w] === set) && (y === h - 1 || mark[p + w] === set)
      if (inside) interior.push(p)
      else perimeter++
    }
    // Thin strips are anti-aliasing fringes along an edge, not shapes of their own.
    if (interior.length < 24 || pix.length / Math.max(1, perimeter) < 1.5) return

    const stride = Math.max(1, Math.ceil(interior.length / MAX_SAMPLES))
    const m = Math.ceil(interior.length / stride)
    const xs = new Float64Array(m), ys = new Float64Array(m), cs = new Float64Array(m * 3)
    for (let k = 0, j = 0; k < interior.length && j < m; k += stride, j++) {
      const p = interior[k]
      xs[j] = (p % w) + 0.5
      ys[j] = ((p / w) | 0) + 0.5
      cs[j * 3] = sr[p]; cs[j * 3 + 1] = sg[p]; cs[j * 3 + 2] = sb[p]
    }
    const fit = fitRegion(xs, ys, cs, m, [x0, y0, x1 + 1, y1 + 1], opts.gradients)
    if (!fit) {
      if (depth < 3 && interior.length >= 256) peelPlateau(pix, cs, m, depth)
      return
    }

    let entry: number
    let fill: Fill
    if (fit.type === 'flat') {
      // Exact color: median of the region's own (unsmoothed) interior pixels.
      const color = snap(medianColor(data, interior))
      const lab = toOklab(color[0], color[1], color[2])
      let best = -1, bestD = SAME_COLOR
      for (const e of flatEntries) {
        const d = Math.hypot(lab[0] - labs[e][0], lab[1] - labs[e][1], lab[2] - labs[e][2])
        if (d < bestD) { bestD = d; best = e }
      }
      if (best >= 0 && weight[best] > 0 && bestD > DISTINCT && rescued < maxRescued) best = -1
      if (best >= 0) {
        entry = best
        fill = fills[best]
        // The biggest region of a color defines it exactly (cluster centers can be
        // pulled slightly by noise and edge pixels).
        if (!weight[best] && fill.type === 'flat') {
          weight[best] = interior.length
          fill.color = color
          pal.colors[best] = color
          labs[best] = lab
        }
      } else if (rescued < maxRescued) {
        // A distinct color the quantizer folded into a bigger cluster (a small accent,
        // a light panel on white): give it its own.
        entry = addEntry(pal, fills, labs, { type: 'flat', color }, color)
        flatEntries.push(entry)
        weight[entry] = interior.length
        fill = fills[entry]
        rescued++
      } else return
    } else {
      fill = fit.fill
      entry = addEntry(pal, fills, labs, fill, middleColor(fill))
    }

    regionColor[entry] = true

    // Claim the pixels that match the fill (anti-aliased border pixels that don't are
    // handled by the edge pass below).
    const tol = Math.max(18, 3 * fit.rms)
    const tol2 = tol * tol
    const local: Rgb = fill.type === 'flat' ? [...fill.color] : [0, 0, 0]
    for (let k = 0; k < pix.length; k++) {
      const p = pix[k]
      if (fill.type !== 'flat') colorAt(fill, (p % w) + 0.5, ((p / w) | 0) + 0.5, local)
      const i = p * 4
      const dr = data[i] - local[0], dg = data[i + 1] - local[1], db = data[i + 2] - local[2]
      if (dr * dr + dg * dg + db * db > tol2) continue
      pal.indices[p] = entry
      pal.second[p] = -1
      pal.mix[p] = 0
      overridden[p] = 1
    }
  }

  /**
   * A gradient that fades into a flat color (a blue-to-white bar on white), or a pale
   * panel on white, has no hard edge where it meets that color, so both grow into one
   * region that no single model fits. When much of such a region is one color, take
   * that color out as a flat region of its own, then fit each piece that is left.
   */
  const peelPlateau = (pix: Int32Array, cs: Float64Array, m: number, depth: number) => {
    // Dominant color: mean of the fullest coarse histogram bin, refined by mean shift.
    const bin = (j: number) => ((cs[j * 3] >> 4) << 8) | ((cs[j * 3 + 1] >> 4) << 4) | (cs[j * 3 + 2] >> 4)
    const hist = new Uint32Array(4096)
    for (let j = 0; j < m; j++) hist[bin(j)]++
    let top = 0
    for (let b = 1; b < 4096; b++) if (hist[b] > hist[top]) top = b
    let seed: Rgb = [0, 0, 0]
    for (let j = 0; j < m; j++) {
      if (bin(j) !== top) continue
      seed[0] += cs[j * 3] / hist[top]; seed[1] += cs[j * 3 + 1] / hist[top]; seed[2] += cs[j * 3 + 2] / hist[top]
    }
    const tol2 = PLATEAU * PLATEAU
    let count = 0
    for (let it = 0; it < 4; it++) {
      let ar = 0, ag = 0, ab = 0
      count = 0
      for (let j = 0; j < m; j++) {
        const r = cs[j * 3], g = cs[j * 3 + 1], b = cs[j * 3 + 2]
        if ((r - seed[0]) ** 2 + (g - seed[1]) ** 2 + (b - seed[2]) ** 2 > tol2) continue
        ar += r; ag += g; ab += b
        count++
      }
      if (!count) return
      seed = [ar / count, ag / count, ab / count]
    }
    if (count < m * 0.25 || count === m) return

    const flat: number[] = [], rest: number[] = []
    for (let k = 0; k < pix.length; k++) {
      const p = pix[k]
      const near = (sr[p] - seed[0]) ** 2 + (sg[p] - seed[1]) ** 2 + (sb[p] - seed[2]) ** 2 <= tol2
      ;(near ? flat : rest).push(p)
    }

    // Split what is left into connected pieces before fitting any of them (fitting
    // reuses `mark`).
    const left = ++stamp, seen = ++stamp
    for (const p of rest) mark[p] = left
    const pieces: Int32Array[] = []
    for (const p0 of rest) {
      if (mark[p0] !== left) continue
      const piece: number[] = []
      let sp = 0
      stack[sp++] = p0
      mark[p0] = seen
      while (sp) {
        const q = stack[--sp]
        piece.push(q)
        const x = q % w
        if (x > 0 && mark[q - 1] === left) { mark[q - 1] = seen; stack[sp++] = q - 1 }
        if (x < w - 1 && mark[q + 1] === left) { mark[q + 1] = seen; stack[sp++] = q + 1 }
        if (q >= w && mark[q - w] === left) { mark[q - w] = seen; stack[sp++] = q - w }
        if (q + w < n && mark[q + w] === left) { mark[q + w] = seen; stack[sp++] = q + w }
      }
      if (piece.length >= opts.minRegion) pieces.push(Int32Array.from(piece))
    }
    refine(Int32Array.from(flat), 3)
    for (const piece of pieces) refine(piece, depth + 1)
  }

  // Biggest first: the main region of a color defines it.
  const bySize = sizes.map((_, r) => r).filter((r) => sizes[r] >= opts.minRegion).sort((a, b) => sizes[b] - sizes[a])
  for (const r of bySize) refine(members.subarray(start[r], start[r + 1]), 0)

  // Clusters that are no region's color and live (almost) only along the edges of
  // refined regions are artifacts: slices of a gradient, anti-aliasing blends,
  // compression ringing. Retire them; their pixels go to the real neighbouring fills.
  const near = dilate(overridden, w, h, 2)
  const total = new Array(original).fill(0), atEdge = new Array(original).fill(0)
  for (let p = 0; p < n; p++) {
    const e = pal.indices[p]
    if (overridden[p] || e < 0 || e >= original) continue
    total[e]++
    if (near[p]) atEdge[e]++
  }
  const retired = new Uint8Array(pal.colors.length)
  for (let e = 0; e < original; e++) {
    if (regionColor[e] || total[e] === 0) continue
    if (atEdge[e] >= total[e] * 0.8 || total[e] - atEdge[e] < opts.minRegion / 4) retired[e] = 1
  }

  splitEdges(data, w, h, pal, fills, overridden, retired)

  pal.counts = new Array(pal.colors.length).fill(0)
  for (let p = 0; p < n; p++) {
    const e = pal.indices[p]
    if (e >= 0 && data[p * 4 + 3] >= opts.alphaThreshold) pal.counts[e]++
  }
  return fills
}

function addEntry(pal: Palette, fills: Fill[], labs: [number, number, number][], fill: Fill, color: Rgb): number {
  pal.colors.push(color)
  pal.counts.push(0)
  fills.push(fill)
  labs.push(toOklab(color[0], color[1], color[2]))
  return pal.colors.length - 1
}

/**
 * Re-splits anti-aliased pixels around refined regions between the colors really
 * present at that spot: the local color of a gradient, or the exact flat color.
 *
 * Blends are measured mostly by brightness: lossy formats (JPEG, WebP) keep color at
 * half resolution, so an edge pixel's hue is smeared while its brightness is exact.
 */
function splitEdges(data: Uint8ClampedArray, w: number, h: number, pal: Palette, fills: Fill[], overridden: Uint8Array, retired: Uint8Array) {
  const R = 2
  const cand: number[] = []
  const local: number[][] = []
  const tmp: Rgb = [0, 0, 0]
  const flat = fills.map((f, e) => (f.type === 'flat' && !retired[e] ? e : -1)).filter((e) => e >= 0)
  const add = (e: number) => {
    if (e >= 0 && !retired[e] && !cand.includes(e)) cand.push(e)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (overridden[p]) continue
      const i = p * 4
      const alpha = data[i + 3]
      if (alpha === 0) continue
      const own = pal.indices[p], other = pal.second[p]
      const stale = (own >= 0 && retired[own] === 1) || (other >= 0 && retired[other] === 1)
      cand.length = 0
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && overridden[yy * w + xx]) add(pal.indices[yy * w + xx])
        }
      }
      if (!cand.length && !stale) continue
      add(own)
      add(other)
      if (!cand.length) {
        // A leftover far from any refined region: nearest kept flat colors.
        const c = [data[i], data[i + 1], data[i + 2]]
        const byDist = flat
          .map((e) => [e, dist3(c, (fills[e] as { color: Rgb }).color)] as const)
          .sort((u, v) => u[1] - v[1])
        for (const [e] of byDist.slice(0, 2)) add(e)
        if (!cand.length) continue
      }

      local.length = 0
      for (const e of cand) {
        colorAt(fills[e], x + 0.5, y + 0.5, tmp)
        local.push(ycc(tmp[0], tmp[1], tmp[2]))
      }
      const c = ycc(data[i], data[i + 1], data[i + 2])
      let bestSingle = 0, bestSingleD = Infinity
      for (let k = 0; k < cand.length; k++) {
        const L = local[k]
        const d = (c[0] - L[0]) ** 2 + (c[1] - L[1]) ** 2 + (c[2] - L[2]) ** 2
        if (d < bestSingleD) { bestSingleD = d; bestSingle = k }
      }
      let pairA = -1, pairB = -1, pairT = 0, pairD = Infinity
      // A semi-transparent pixel blends with the background, not with a second color.
      if (alpha >= 242) {
        for (let a = 0; a < cand.length; a++) {
          for (let b = a + 1; b < cand.length; b++) {
            const A = local[a], B = local[b]
            const e0 = B[0] - A[0], e1 = B[1] - A[1], e2 = B[2] - A[2]
            const len2 = e0 * e0 + e1 * e1 + e2 * e2
            if (len2 < 1) continue
            const t = Math.min(1, Math.max(0, ((c[0] - A[0]) * e0 + (c[1] - A[1]) * e1 + (c[2] - A[2]) * e2) / len2))
            const d = (A[0] + e0 * t - c[0]) ** 2 + (A[1] + e1 * t - c[1]) ** 2 + (A[2] + e2 * t - c[2]) ** 2
            if (d < pairD) { pairD = d; pairA = a; pairB = b; pairT = t }
          }
        }
      }
      if (pairA >= 0 && pairD < bestSingleD * 0.5 && pairT > 0.02 && pairT < 0.98) {
        const main = pairT < 0.5 ? pairA : pairB
        pal.indices[p] = cand[main]
        pal.second[p] = cand[main === pairA ? pairB : pairA]
        pal.mix[p] = pairT < 0.5 ? pairT : 1 - pairT
      } else {
        pal.indices[p] = cand[bestSingle]
        pal.second[p] = -1
        pal.mix[p] = 0
      }
    }
  }
}

/** Brightness plus down-weighted color difference (see splitEdges). */
function ycc(r: number, g: number, b: number): number[] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  return [y, (b - y) * 0.35, (r - y) * 0.35]
}

function dist3(a: number[], b: Rgb) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Square dilation of a 0/1 mask by `r` pixels (separable). */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) tmp[y * w + k] = 1
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!tmp[y * w + x]) continue
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) out[k * w + x] = 1
    }
  }
  return out
}

type RegionFit = { type: 'flat'; rms: number } | { type: 'gradient'; fill: Fill; rms: number }

/**
 * Decides whether a region is a flat color, a linear gradient or a radial gradient,
 * from samples of its interior (x, y, smoothed rgb). Returns null when none of these
 * models explains it (photographic texture): the quantizer's colors are kept then.
 */
function fitRegion(xs: Float64Array, ys: Float64Array, cs: Float64Array, m: number, box: [number, number, number, number], gradients: boolean): RegionFit | null {
  let mr = 0, mg = 0, mb = 0, mx = 0, my = 0
  for (let j = 0; j < m; j++) {
    mr += cs[j * 3]; mg += cs[j * 3 + 1]; mb += cs[j * 3 + 2]
    mx += xs[j]; my += ys[j]
  }
  mr /= m; mg /= m; mb /= m; mx /= m; my /= m
  let ssFlat = 0, outliers = 0
  for (let j = 0; j < m; j++) {
    const d2 = (cs[j * 3] - mr) ** 2 + (cs[j * 3 + 1] - mg) ** 2 + (cs[j * 3 + 2] - mb) ** 2
    ssFlat += d2
    if (d2 > OUTLIER * OUTLIER) outliers++
  }
  const rmsFlat = Math.sqrt(ssFlat / m)
  // Flat, unless a part of it is clearly another color (a pale shape on white).
  if (rmsFlat <= FLAT_RMS && outliers <= m * 0.02) return { type: 'flat', rms: rmsFlat }
  if (!gradients) return null

  // Linear: least-squares plane per channel, then the direction of fastest change.
  let sxx = 0, sxy = 0, syy = 0
  const sxc = [0, 0, 0], syc = [0, 0, 0]
  const mean = [mr, mg, mb]
  for (let j = 0; j < m; j++) {
    const X = xs[j] - mx, Y = ys[j] - my
    sxx += X * X; sxy += X * Y; syy += Y * Y
    for (let c = 0; c < 3; c++) {
      const v = cs[j * 3 + c] - mean[c]
      sxc[c] += X * v; syc[c] += Y * v
    }
  }
  const det = sxx * syy - sxy * sxy
  let best: { fill: Fill; rms: number; span: number; slope: number } | null = null
  if (det > 1e-9) {
    let m00 = 0, m01 = 0, m11 = 0
    for (let c = 0; c < 3; c++) {
      const gx = (sxc[c] * syy - syc[c] * sxy) / det
      const gy = (syc[c] * sxx - sxc[c] * sxy) / det
      m00 += gx * gx; m01 += gx * gy; m11 += gy * gy
    }
    const theta = 0.5 * Math.atan2(2 * m01, m00 - m11)
    const ux = Math.cos(theta), uy = Math.sin(theta)
    const t = new Float64Array(m)
    for (let j = 0; j < m; j++) t[j] = (xs[j] - mx) * ux + (ys[j] - my) * uy
    const prof = profile(t, cs, m)
    if (prof) {
      best = {
        fill: {
          type: 'linear',
          x1: mx + ux * prof.t0, y1: my + uy * prof.t0,
          x2: mx + ux * prof.t1, y2: my + uy * prof.t1,
          stops: prof.stops,
        },
        rms: prof.rms,
        span: prof.span,
        slope: prof.slope,
      }
    }
  }

  // Radial: center from a quadratic fit of the color's main axis, then a profile along
  // the distance from it.
  const center = radialCenter(xs, ys, cs, m, mx, my, mean)
  if (center) {
    const [cx, cy] = center
    const bw = box[2] - box[0], bh = box[3] - box[1]
    const inside = cx > box[0] - bw * 0.25 && cx < box[2] + bw * 0.25 && cy > box[1] - bh * 0.25 && cy < box[3] + bh * 0.25
    if (inside) {
      const t = new Float64Array(m)
      for (let j = 0; j < m; j++) t[j] = Math.hypot(xs[j] - cx, ys[j] - cy)
      const prof = profile(t, cs, m)
      if (prof && prof.t1 > 0 && (!best || prof.rms < best.rms * 0.85)) {
        const R = prof.t1
        best = {
          fill: { type: 'radial', cx, cy, r: R, stops: prof.stops.map((st) => ({ offset: (prof.t0 + st.offset * (prof.t1 - prof.t0)) / R, color: st.color })) },
          rms: prof.rms,
          span: prof.span,
          slope: prof.slope,
        }
      }
    }
  }

  if (!best) return null
  const ok = best.rms <= Math.max(GRADIENT_RMS, 0.35 * rmsFlat) && best.span >= MIN_SPAN && best.slope <= MAX_SLOPE
  return ok ? { type: 'gradient', fill: best.fill, rms: best.rms } : null
}

interface Profile {
  /** Stops with offsets 0–1 between t0 and t1. */
  stops: Stop[]
  t0: number
  t1: number
  rms: number
  /** Largest color distance between two stops. */
  span: number
  /** Steepest color change per pixel between consecutive stops. */
  slope: number
}

/**
 * Color as a function of one coordinate `t`: averages the samples in narrow bins,
 * then keeps only the bins needed to reproduce that curve closely (RDP).
 */
function profile(t: Float64Array, cs: Float64Array, m: number): Profile | null {
  if (m < 24) return null
  const sorted = Float64Array.from(t).sort()
  const t0 = sorted[Math.floor(m * 0.005)], t1 = sorted[Math.min(m - 1, Math.floor(m * 0.995))]
  const len = t1 - t0
  if (len < 4) return null
  const nb = Math.max(4, Math.min(64, Math.round(len / 1.5)))
  const sum = new Float64Array(nb * 3), cnt = new Float64Array(nb)
  for (let j = 0; j < m; j++) {
    const k = Math.min(nb - 1, Math.max(0, Math.floor(((t[j] - t0) / len) * nb)))
    sum[k * 3] += cs[j * 3]; sum[k * 3 + 1] += cs[j * 3 + 1]; sum[k * 3 + 2] += cs[j * 3 + 2]
    cnt[k]++
  }
  const pts: { t: number; c: Rgb }[] = []
  for (let k = 0; k < nb; k++) {
    if (cnt[k] < 3) continue
    pts.push({ t: t0 + ((k + 0.5) / nb) * len, c: [sum[k * 3] / cnt[k], sum[k * 3 + 1] / cnt[k], sum[k * 3 + 2] / cnt[k]] })
  }
  if (pts.length < 2) return null
  pts[0].t = t0
  pts[pts.length - 1].t = t1

  // Few stops, as a designer would use: the tolerance grows with the gradient's range
  // (a few levels off in a long blend are invisible).
  let range = 0
  for (const q of pts) range = Math.max(range, dist(q.c, pts[0].c))
  const tol = Math.max(STOP_TOLERANCE, range * 0.07)
  /** Largest deviation of the bins between stops a and b from the straight blend a→b. */
  const deviation = (a: number, b: number) => {
    let worst = -1, worstD = 0
    for (let k = a + 1; k < b; k++) {
      const f = (pts[k].t - pts[a].t) / (pts[b].t - pts[a].t)
      let d = 0
      for (let c = 0; c < 3; c++) d += (pts[a].c[c] + (pts[b].c[c] - pts[a].c[c]) * f - pts[k].c[c]) ** 2
      if (d > worstD) { worstD = d; worst = k }
    }
    return { worst, d: Math.sqrt(worstD) }
  }
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const rdp = (a: number, b: number) => {
    const { worst, d } = deviation(a, b)
    if (worst >= 0 && d > tol) { keep[worst] = 1; rdp(a, worst); rdp(worst, b) }
  }
  rdp(0, pts.length - 1)
  // Top-down splitting can keep stops that its later splits made unnecessary.
  let idx = pts.map((_, k) => k).filter((k) => keep[k])
  for (let changed = true; changed && idx.length > 2;) {
    changed = false
    for (let j = 1; j < idx.length - 1; j++) {
      if (deviation(idx[j - 1], idx[j + 1]).d > tol) continue
      idx.splice(j, 1)
      changed = true
      break
    }
  }
  const kept = idx.map((k) => pts[k])

  let ss = 0
  const out: Rgb = [0, 0, 0]
  for (let j = 0; j < m; j++) {
    interpolate(kept, Math.min(t1, Math.max(t0, t[j])), out)
    ss += (cs[j * 3] - out[0]) ** 2 + (cs[j * 3 + 1] - out[1]) ** 2 + (cs[j * 3 + 2] - out[2]) ** 2
  }
  let span = 0, slope = 0
  for (let a = 0; a < kept.length; a++) {
    for (let b = a + 1; b < kept.length; b++) span = Math.max(span, dist(kept[a].c, kept[b].c))
    if (a > 0) slope = Math.max(slope, dist(kept[a].c, kept[a - 1].c) / Math.max(1e-6, kept[a].t - kept[a - 1].t))
  }
  return {
    stops: kept.map((k) => ({ offset: (k.t - t0) / len, color: k.c.map((v) => Math.round(Math.min(255, Math.max(0, v)))) as Rgb })),
    t0,
    t1,
    rms: Math.sqrt(ss / m),
    span,
    slope,
  }
}

function interpolate(pts: { t: number; c: Rgb }[], t: number, out: Rgb) {
  let k = 1
  while (k < pts.length - 1 && pts[k].t < t) k++
  const a = pts[k - 1], b = pts[k]
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
  for (let c = 0; c < 3; c++) out[c] = a.c[c] + (b.c[c] - a.c[c]) * f
}

/**
 * Center of a radial gradient: fits s = a + b·x + c·y + d·(x² + y²) to the color's
 * main axis s, whose stationary point is the center. Null if there is no curvature.
 */
function radialCenter(xs: Float64Array, ys: Float64Array, cs: Float64Array, m: number, mx: number, my: number, mean: number[]): [number, number] | null {
  // Main color axis (power iteration on the color covariance).
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let j = 0; j < m; j++) {
    const v = [cs[j * 3] - mean[0], cs[j * 3 + 1] - mean[1], cs[j * 3 + 2] - mean[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += v[a] * v[b]
  }
  let axis = [1, 1, 1]
  for (let it = 0; it < 20; it++) {
    const nx = [0, 1, 2].map((a) => cov[a * 3] * axis[0] + cov[a * 3 + 1] * axis[1] + cov[a * 3 + 2] * axis[2])
    const l = Math.hypot(nx[0], nx[1], nx[2])
    if (l < 1e-12) return null
    axis = nx.map((v) => v / l)
  }
  // Normal equations for [a, b, c, d] with scaled, centered coordinates.
  let scale = 0
  for (let j = 0; j < m; j++) scale = Math.max(scale, Math.abs(xs[j] - mx), Math.abs(ys[j] - my))
  if (scale < 2) return null
  const A = new Float64Array(16), rhs = new Float64Array(4)
  for (let j = 0; j < m; j++) {
    const X = (xs[j] - mx) / scale, Y = (ys[j] - my) / scale
    const f = [1, X, Y, X * X + Y * Y]
    const s = (cs[j * 3] - mean[0]) * axis[0] + (cs[j * 3 + 1] - mean[1]) * axis[1] + (cs[j * 3 + 2] - mean[2]) * axis[2]
    for (let a = 0; a < 4; a++) {
      rhs[a] += f[a] * s
      for (let b = 0; b < 4; b++) A[a * 4 + b] += f[a] * f[b]
    }
  }
  const sol = solve4(A, rhs)
  if (!sol) return null
  const [, b, c, d] = sol
  if (Math.abs(d) < 1e-6) return null
  return [mx + (-b / (2 * d)) * scale, my + (-c / (2 * d)) * scale]
}

/** Gaussian elimination with partial pivoting for a 4×4 system. */
function solve4(A: Float64Array, b: Float64Array): number[] | null {
  const M = Array.from({ length: 4 }, (_, r) => [A[r * 4], A[r * 4 + 1], A[r * 4 + 2], A[r * 4 + 3], b[r]])
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < 4; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let k = col; k < 5; k++) M[r][k] -= f * M[col][k]
    }
  }
  return M.map((row, r) => row[4] / row[r])
}

/** The fill's color at a point (working pixel coordinates). */
export function colorAt(fill: Fill, x: number, y: number, out: Rgb): Rgb {
  if (fill.type === 'flat') {
    out[0] = fill.color[0]; out[1] = fill.color[1]; out[2] = fill.color[2]
    return out
  }
  let t: number
  if (fill.type === 'linear') {
    const dx = fill.x2 - fill.x1, dy = fill.y2 - fill.y1
    const l2 = dx * dx + dy * dy
    t = l2 > 0 ? ((x - fill.x1) * dx + (y - fill.y1) * dy) / l2 : 0
  } else {
    t = fill.r > 0 ? Math.hypot(x - fill.cx, y - fill.cy) / fill.r : 0
  }
  const s = fill.stops
  if (t <= s[0].offset) { out[0] = s[0].color[0]; out[1] = s[0].color[1]; out[2] = s[0].color[2]; return out }
  for (let k = 1; k < s.length; k++) {
    if (t <= s[k].offset) {
      const a = s[k - 1], b = s[k]
      const f = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 0
      for (let c = 0; c < 3; c++) out[c] = a.color[c] + (b.color[c] - a.color[c]) * f
      return out
    }
  }
  const last = s[s.length - 1]
  out[0] = last.color[0]; out[1] = last.color[1]; out[2] = last.color[2]
  return out
}

function middleColor(fill: Fill): Rgb {
  const out: Rgb = [0, 0, 0]
  if (fill.type === 'flat') return fill.color
  if (fill.type === 'linear') return colorAt(fill, (fill.x1 + fill.x2) / 2, (fill.y1 + fill.y2) / 2, out).map(Math.round) as Rgb
  return colorAt(fill, fill.cx + fill.r / 2, fill.cy, out).map(Math.round) as Rgb
}

function medianColor(data: Uint8ClampedArray, pixels: number[]): Rgb {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  const [hr, hg, hb] = hist
  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k] * 4
    hr[data[i]]++; hg[data[i + 1]]++; hb[data[i + 2]]++
  }
  const half = pixels.length / 2
  return hist.map((hc) => {
    let acc = 0
    for (let v = 0; v < 256; v++) { acc += hc[v]; if (acc >= half) return v }
    return 255
  }) as Rgb
}

/** Compression leaves white as #fefefe and black as #010101: snap those back. */
function snap(c: Rgb): Rgb {
  if (c[0] >= 250 && c[1] >= 250 && c[2] >= 250) return [255, 255, 255]
  if (c[0] <= 5 && c[1] <= 5 && c[2] <= 5) return [0, 0, 0]
  return c
}

function dist(a: Rgb, b: Rgb) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
