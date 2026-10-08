import { marchingSquares, pointInPolygon, signedArea } from './contour.ts'
import { blur121 } from './filters.ts'
import { fitOutline, type FitOptions, type Outline } from './fit.ts'
import { getPreset, type TraceSettings } from './presets.ts'
import { quantize } from './quantize.ts'
import { crop, opaqueBounds, removeBackground, resize, type Bitmap, type Rect } from './raster.ts'
import { refineColors, type Fill } from './regions.ts'

export interface TraceResult {
  svg: string
  width: number
  height: number
  /** Flat colors used, bottom layer first. */
  colors: string[]
  /** Number of gradients used. */
  gradients: number
  /** With background removal: areas of the background color enclosed by the artwork. */
  enclosed: number
  paths: number
  /** Region of the source image that the SVG covers. */
  crop: Rect
}

export const ALPHA_THRESHOLD = 128

/**
 * PNG → SVG.
 *
 * 1. Quantize to a small palette; anti-aliased edge pixels are kept as a mix of the
 *    two colors they blend (plus their alpha), not snapped to one of them.
 * 2. Build a coverage field per color (0–1 per pixel). Because edge pixels carry
 *    partial coverage, the 50% iso-line sits where the original edge really was,
 *    with sub-pixel precision.
 * 3. Trace the iso-lines (marching squares), then fit lines and Bézier curves with
 *    corner detection and sharpening.
 */
export function traceImage(
  source: Bitmap,
  settings: TraceSettings,
  onProgress?: (fraction: number) => void,
  /** Size of the original image relative to `source`, when it was decoded smaller. */
  displayScale = 1,
): TraceResult {
  const preset = getPreset(settings.preset)
  let img = source
  let enclosed = 0
  if (settings.removeBackground) {
    const removal = removeBackground(source, { enclosed: settings.clearEnclosed })
    img = removal.image
    enclosed = removal.enclosed
  }

  // The SVG covers the solid part of the image; tracing uses one extra pixel around it
  // so faint anti-aliased edge pixels still place the outline precisely.
  let region: Rect = { x: 0, y: 0, width: img.width, height: img.height }
  let traced = region
  if (settings.cropTransparent) {
    const b = opaqueBounds(img, ALPHA_THRESHOLD) ?? opaqueBounds(img, 1)
    if (b) {
      region = b
      const x0 = Math.max(0, b.x - 1), y0 = Math.max(0, b.y - 1)
      const x1 = Math.min(img.width, b.x + b.width + 1), y1 = Math.min(img.height, b.y + b.height + 1)
      traced = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    }
  }
  img = crop(img, traced)
  const outW = region.width, outH = region.height
  const offX = region.x - traced.x, offY = region.y - traced.y

  // Huge images are traced at a reduced size (the output keeps the input's size).
  const longest = Math.max(img.width, img.height)
  const k = longest > preset.maxWorkSize ? preset.maxWorkSize / longest : 1
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  const sx = img.width / w, sy = img.height / h
  img = resize(img, w, h)
  onProgress?.(0.05)

  const pal = quantize(img, {
    maxColors: settings.colors,
    mergeDistance: preset.mergeDistance,
    minShare: preset.minShare,
    alphaThreshold: ALPHA_THRESHOLD,
    removeBlends: preset.flat,
  })
  onProgress?.(0.2)

  const d = settings.detail / 100
  const s = settings.smoothness / 100
  const minArea = ((0.8 + (1 - d) * 4.5) * (preset.flat ? 1 : 1.6)) ** 2

  // Region analysis: exact flat colors, kept accents, gradients.
  const fills = refineColors(img, pal, {
    gradients: settings.gradients !== false,
    minRegion: Math.max(48, Math.round(minArea * 2)),
    alphaThreshold: ALPHA_THRESHOLD,
  })
  onProgress?.(0.3)

  // Bottom-to-top: biggest areas first, so small details sit on top.
  const order = pal.counts.map((_, i) => i).sort((a, b) => pal.counts[b] - pal.counts[a])
  const rank = new Int16Array(order.length)
  order.forEach((c, r) => (rank[c] = r))

  const n = w * h
  const alpha = new Float32Array(n)
  const rMain = new Int16Array(n)
  const rSecond = new Int16Array(n)
  for (let p = 0; p < n; p++) {
    alpha[p] = img.data[p * 4 + 3] / 255
    rMain[p] = pal.indices[p] < 0 ? -1 : rank[pal.indices[p]]
    rSecond[p] = pal.second[p] < 0 ? -1 : rank[pal.second[p]]
  }

  // Small images get a tighter fit: they are usually scaled up, where every tenth of a
  // source pixel shows.
  const sizeFactor = Math.min(1, Math.max(0.35, Math.max(w, h) / 256))
  // Continuous-tone images have noisy color boundaries: fit them more loosely and drop
  // bigger specks, or the file fills up with detail nobody can see.
  const noisy = preset.flat ? 1 : 2.2
  const fit: FitOptions = {
    tolerance: (0.1 + (1 - d) * 0.45) * (0.8 + s * 0.8) * sizeFactor * noisy,
    cornerAngle: ((15 + s * 80) * Math.PI) / 180,
    cornerWindow: 1.6 + s * 2,
    sharpen: 2.5 * (1 - s * 0.7),
    // Separate shapes extend only ~1px under the colors above them.
    sharpenConcave: settings.layering === 'separate' ? 0.8 : undefined,
  }
  const decimals = Math.max(outW, outH) <= 128 ? 2 : 1
  const xf: PathTransform = { sx, sy, offX: offX + PAD * sx, offY: offY + PAD * sy, decimals }

  // Merge specks into the color around them before tracing (dropping them afterwards
  // would leave holes, since separate shapes don't cover each other).
  despeckle(rMain, rSecond, pal.mix, alpha, w, h, minArea)

  const own = new Float32Array(n)
  const reach = new Float32Array(n)
  const field = new Float32Array(n)
  const scratch = new Float32Array(n)
  const parts: string[] = []
  const defs: string[] = []
  const paint = new Map<number, string>()
  const paintOf = (entry: number) => {
    let v = paint.get(entry)
    if (!v) {
      const f = fills[entry]
      if (f.type === 'flat') v = hex(f.color)
      else {
        const id = `g${defs.length + 1}`
        defs.push(gradientDef(id, f, sx, sy, offX, offY))
        v = `url(#${id})`
      }
      paint.set(entry, v)
    }
    return v
  }
  let pathCount = 0

  for (let r = 0; r < order.length; r++) {
    // `own`: coverage of this color. `field`: coverage of this color or anything above it.
    for (let p = 0; p < n; p++) {
      const m = rMain[p], sc = rSecond[p]
      if (m < 0) { own[p] = 0; field[p] = 0; continue }
      const mx = pal.mix[p]
      const a = alpha[p]
      own[p] = a * ((m === r ? 1 - mx : 0) + (sc === r ? mx : 0))
      field[p] = a * ((m >= r ? 1 - mx : 0) + (sc >= r ? mx : 0))
    }
    if (!preset.flat) {
      // Photos: soften pixel staircases and noise before tracing.
      for (const g of [own, field]) { blur121(g, w, h, scratch); blur121(g, w, h, scratch) }
    }
    if (settings.layering === 'separate' && r < order.length - 1) {
      // Extend each shape ~1px underneath the colors above it (where they hide it), so
      // neighbouring colors never leave a hairline gap, yet every color remains its
      // own shape. `field - own` is the coverage of the colors above. Any pixel this
      // color has a real share of (edges, gradients, junctions of several colors)
      // reaches as far as one it fully owns; the extension stays hidden either way.
      // A blurred-and-amplified copy is a smooth dilation of ~1.5px: enough to absorb
      // the fitting tolerance of both shapes plus notch sharpening (a max filter would
      // leave a pixel staircase for the tracer to follow).
      for (let p = 0; p < n; p++) reach[p] = Math.min(1, own[p] * 4)
      for (let k = 0; k < UNDERLAP_BLUR; k++) blur121(reach, w, h, scratch)
      for (let p = 0; p < n; p++) field[p] = Math.max(own[p], Math.min(Math.min(1, reach[p] * UNDERLAP_GAIN), field[p] - own[p]))
    }

    // Pad by repeating the border pixels: shapes that touch the image edge continue past
    // it (the viewBox clips them), so no seam can open up along the border.
    const loops = marchingSquares(padEdges(field, w, h, PAD), w + 2 * PAD, h + 2 * PAD, 0.5)
    for (const shape of groupShapes(loops, minArea)) {
      const dParts: string[] = []
      for (const loop of shape) {
        const o = fitOutline(loop, fit)
        if (o) dParts.push(outlineToPath(o, xf))
      }
      if (!dParts.length) continue
      parts.push(`<path fill="${paintOf(order[r])}" d="${dParts.join('')}"/>`)
      pathCount++
    }
    onProgress?.(0.3 + (0.7 * (r + 1)) / order.length)
  }

  const dw = Math.round(outW * displayScale), dh = Math.round(outH * displayScale)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}" viewBox="0 0 ${outW} ${outH}">\n` +
    (defs.length ? `<defs>\n${defs.join('\n')}\n</defs>\n` : '') +
    parts.join('\n') +
    (parts.length ? '\n' : '') +
    `</svg>\n`

  const used = [...paint.values()]
  return {
    svg,
    width: outW,
    height: outH,
    colors: used.filter((v) => v.startsWith('#')),
    gradients: defs.length,
    enclosed,
    paths: pathCount,
    crop: region,
  }
}

/**
 * Groups contours into shapes: each outer boundary with the holes directly inside it.
 * Marching squares gives outers and holes opposite winding, so the sign of the area
 * tells them apart. Specks smaller than `minArea` are dropped.
 */
function groupShapes(loops: Float64Array[], minArea: number): Float64Array[][] {
  type L = { pts: Float64Array; area: number; box: [number, number, number, number] }
  const outers: (L & { holes: Float64Array[] })[] = []
  const holes: L[] = []
  for (const pts of loops) {
    const a = signedArea(pts)
    if (Math.abs(a) < minArea) continue
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i])
      y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1])
    }
    const l = { pts, area: Math.abs(a), box: [x0, y0, x1, y1] as L['box'] }
    // With y pointing down, outer boundaries run counter-clockwise (negative area).
    if (a < 0) outers.push({ ...l, holes: [] })
    else holes.push(l)
  }
  outers.sort((a, b) => a.area - b.area)
  for (const hole of holes) {
    const hx = hole.pts[0], hy = hole.pts[1]
    const parent = outers.find(
      (o) =>
        o.area > hole.area &&
        hole.box[0] >= o.box[0] && hole.box[1] >= o.box[1] && hole.box[2] <= o.box[2] && hole.box[3] <= o.box[3] &&
        pointInPolygon(hx, hy, o.pts),
    )
    parent?.holes.push(hole.pts)
  }
  // Paint order within a layer does not matter; keep large shapes first for editing.
  return outers.reverse().map((o) => [o.pts, ...o.holes])
}

function outlineToPath(o: Outline, t: PathTransform): string {
  const f = 10 ** t.decimals
  const X = (v: number) => num(Math.round((v * t.sx - t.offX) * f) / f)
  const Y = (v: number) => num(Math.round((v * t.sy - t.offY) * f) / f)
  let cx = X(o.x), cy = Y(o.y)
  let d = `M${cx} ${cy}`
  const segs = o.segs
  // The closing segment back to the start is implied by Z when it is a line.
  const lastIdx = segs.length - 1
  segs.forEach((g, i) => {
    const x = X(g.x), y = Y(g.y)
    if (g.c === 'L') {
      if (i === lastIdx || (x === cx && y === cy)) return
      d += `L${x} ${y}`
    } else {
      d += `C${X(g.x1)} ${Y(g.y1)} ${X(g.x2)} ${Y(g.y2)} ${x} ${y}`
    }
    cx = x
    cy = y
  })
  return (d + 'Z').replace(/ -/g, '-')
}

interface PathTransform {
  sx: number
  sy: number
  offX: number
  offY: number
  decimals: number
}

const PAD = 2
/** Blur passes and gain that set how far separate shapes extend under upper colors. */
const UNDERLAP_BLUR = 3
const UNDERLAP_GAIN = 6

function padEdges(src: Float32Array, w: number, h: number, pad: number): Float32Array {
  const W = w + 2 * pad, H = h + 2 * pad
  const out = new Float32Array(W * H)
  for (let Y = 0; Y < H; Y++) {
    const y = Math.min(h - 1, Math.max(0, Y - pad))
    for (let X = 0; X < W; X++) {
      out[Y * W + X] = src[y * w + Math.min(w - 1, Math.max(0, X - pad))]
    }
  }
  return out
}

/** SVG gradient element for a fill, in the output's user space. */
function gradientDef(id: string, f: Exclude<Fill, { type: 'flat' }>, sx: number, sy: number, offX: number, offY: number): string {
  const X = (v: number) => num(Math.round((v * sx - offX) * 100) / 100)
  const Y = (v: number) => num(Math.round((v * sy - offY) * 100) / 100)
  const stops = f.stops
    .map((st) => `<stop offset="${num(Math.round(st.offset * 1000) / 1000)}" stop-color="${hex(st.color)}"/>`)
    .join('')
  if (f.type === 'linear') {
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${X(f.x1)}" y1="${Y(f.y1)}" x2="${X(f.x2)}" y2="${Y(f.y2)}">${stops}</linearGradient>`
  }
  const r = num(Math.round(f.r * Math.sqrt(sx * sy) * 100) / 100)
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${X(f.cx)}" cy="${Y(f.cy)}" r="${r}">${stops}</radialGradient>`
}

function num(v: number) {
  return (Object.is(v, -0) ? 0 : v).toString()
}

function hex([r, g, b]: [number, number, number]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Reassigns 4-connected regions of one color smaller than `minArea` pixels to the most
 * common color bordering them (or to transparency, if nothing else borders them).
 */
function despeckle(main: Int16Array, second: Int16Array, mix: Float32Array, alpha: Float32Array, w: number, h: number, minArea: number) {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack: number[] = []
  const region: number[] = []
  for (let start = 0; start < n; start++) {
    if (seen[start] || main[start] < 0) continue
    const label = main[start]
    region.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      region.push(p)
      const x = p % w
      if (x > 0 && !seen[p - 1] && main[p - 1] === label) { seen[p - 1] = 1; stack.push(p - 1) }
      if (x < w - 1 && !seen[p + 1] && main[p + 1] === label) { seen[p + 1] = 1; stack.push(p + 1) }
      if (p >= w && !seen[p - w] && main[p - w] === label) { seen[p - w] = 1; stack.push(p - w) }
      if (p < n - w && !seen[p + w] && main[p + w] === label) { seen[p + w] = 1; stack.push(p + w) }
    }
    // Size weighted by coverage, so a spread of faint pixels still counts as a speck.
    let mass = 0
    for (const p of region) mass += alpha[p]
    if (mass >= minArea) continue
    const votes = new Map<number, number>()
    for (const p of region) {
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || main[q] === label) continue
        votes.set(main[q], (votes.get(main[q]) ?? 0) + 1)
      }
    }
    let best = -1, bestVotes = 0
    for (const [l, v] of votes) if (l >= 0 && v > bestVotes) { best = l; bestVotes = v }
    for (const p of region) {
      main[p] = best
      second[p] = -1
      mix[p] = 0
      if (best < 0) alpha[p] = 0
    }
  }
}
