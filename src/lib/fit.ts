/**
 * Turns a closed, sub-pixel polyline into a compact outline of lines and cubic Béziers:
 * finds corners, sharpens them back to the point the anti-aliasing rounded off, emits
 * straight runs as lines and fits the rest with Schneider's least-squares algorithm.
 */

export type Seg =
  | { c: 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }

export interface Outline {
  x: number
  y: number
  segs: Seg[]
}

export interface FitOptions {
  /** Max deviation (px) between the polyline and the fitted curve. */
  tolerance: number
  /** Turning angle (radians) above which a vertex is a corner. */
  cornerAngle: number
  /** Arc length (px) over which the turning angle is measured. */
  cornerWindow: number
  /** Max distance (px) a corner may move when sharpened. */
  sharpen: number
}

type Pt = { x: number; y: number }

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y
const len = (a: Pt) => Math.hypot(a.x, a.y)
const norm = (a: Pt): Pt => {
  const l = len(a)
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 }
}

export function fitOutline(flat: Float64Array, opts: FitOptions): Outline | null {
  const pts: Pt[] = []
  for (let i = 0; i < flat.length; i += 2) {
    const p = { x: flat[i], y: flat[i + 1] }
    const last = pts[pts.length - 1]
    if (!last || Math.abs(last.x - p.x) > 1e-7 || Math.abs(last.y - p.y) > 1e-7) pts.push(p)
  }
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-7) pts.pop()
  if (pts.length < 3) return null
  const n = pts.length

  // Cumulative arc length around the loop.
  const s = new Float64Array(n + 1)
  for (let i = 1; i <= n; i++) s[i] = s[i - 1] + dist(pts[i - 1], pts[i % n])
  const perimeter = s[n]
  const W = Math.min(opts.cornerWindow, perimeter / 6)

  // Point at arc length `t` (wraps around the loop).
  const pointAt = (t: number): Pt => {
    t = ((t % perimeter) + perimeter) % perimeter
    let lo = 0, hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s[mid] <= t) lo = mid
      else hi = mid
    }
    const seg = s[lo + 1] - s[lo]
    const k = seg > 0 ? (t - s[lo]) / seg : 0
    const a = pts[lo], b = pts[(lo + 1) % n]
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
  }

  // Turning angle at each vertex, measured across ±W and ±W/2 of arc length. At a real
  // corner both are about the same; along a tight smooth curve the half window turns
  // only half as much, which keeps small circles and dots from becoming polygons.
  const turnAt = (i: number, r: number) => {
    const a = pointAt(s[i] - r), b = pointAt(s[i] + r)
    const u = norm(sub(pts[i], a)), v = norm(sub(b, pts[i]))
    return Math.acos(Math.max(-1, Math.min(1, dot(u, v))))
  }
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) turn[i] = turnAt(i, W)

  // Corners: local maxima above the threshold, at least W apart. Small round blobs
  // (dots, bullets) are pixel polygons at this scale: they never get corners.
  const corners: number[] = []
  const isDot = perimeter < 40 && isRound(pts)
  for (let i = 0; i < n && !isDot; i++) {
    if (turn[i] < opts.cornerAngle || turnAt(i, W / 2) < turn[i] * 0.6) continue
    let isMax = true
    for (let j = 1; isMax && j < n; j++) {
      const back = (i - j + n) % n, fwd = (i + j) % n
      const dBack = arcBetween(s, perimeter, back, i), dFwd = arcBetween(s, perimeter, i, fwd)
      if (dBack > W && dFwd > W) break
      if (dBack <= W && (turn[back] > turn[i] || (turn[back] === turn[i] && back < i))) isMax = false
      if (dFwd <= W && turn[fwd] > turn[i]) isMax = false
    }
    if (isMax) corners.push(i)
  }

  // Classify corners. Each arm is either a straight line (fitted along the side) or a
  // curve (represented by its tangent line next to the corner):
  // - two straight arms meeting close to the vertex: a sharp corner that anti-aliasing
  //   rounded; move it back to the intersection. Meeting far away: it was drawn round
  //   (e.g. a round join), so it is no corner at all and the curve fit handles it;
  // - a curved arm: sharpen the same way when the tangents meet close by, otherwise
  //   keep the corner where it is, if the turn is concentrated enough to be real.
  // Zone around a corner that anti-aliasing rounded off; excluded from line fits.
  const guard = Math.min(W * 0.5, 0.9)
  const gap = (i: number, j: number) => arcBetween(s, perimeter, i, j) || perimeter
  const kept: { i: number; pos: Pt; dIn: Pt; dOut: Pt; sharp: boolean }[] = []
  corners.forEach((ci, k) => {
    const prevC = corners[(k - 1 + corners.length) % corners.length]
    const nextC = corners[(k + 1) % corners.length]
    // Use the side up to the neighbouring corner's rounded zone (at most 3W of it).
    const before = Math.min(W * 3, gap(prevC, ci) - guard)
    const after = Math.min(W * 3, gap(ci, nextC) - guard)
    const inLine = lineFit(pointAt, s[ci] - before, s[ci] - guard, true)
    const outLine = lineFit(pointAt, s[ci] + guard, s[ci] + after, true)
    const straight = !!inLine && !!outLine
    if (!straight && turnAt(ci, W / 2) < turn[ci] * 0.75) return
    const inT = inLine ?? lineFit(pointAt, s[ci] - Math.min(before, guard + W), s[ci] - guard, false)
    const outT = outLine ?? lineFit(pointAt, s[ci] + guard, s[ci] + Math.min(after, guard + W), false)
    if (inT && outT) {
      const interior = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(inT.dir, outT.dir))))
      // Anti-aliasing cuts a sharp corner back by about half a pixel / tan(angle / 2).
      const limit = Math.min(opts.sharpen, 0.75 / Math.tan(Math.max(0.05, interior / 2)))
      const x = intersect(inT.p, inT.dir, outT.p, outT.dir)
      if (x && dist(x, pts[ci]) <= limit) {
        kept.push({ i: ci, pos: x, dIn: inT.dir, dOut: outT.dir, sharp: true })
        return
      }
    }
    if (straight) return
    const local = W / 2
    kept.push({
      i: ci,
      pos: pts[ci],
      dIn: norm(sub(pts[ci], pointAt(s[ci] - local))),
      dOut: norm(sub(pointAt(s[ci] + local), pts[ci])),
      sharp: false,
    })
  })

  const segs: Seg[] = []
  if (kept.length === 0) {
    // Smooth closed curve: fit all the way around, with a continuous tangent at the seam.
    const sm = smoothLoop(pts, 2)
    const loop = [...sm, sm[0]]
    const tan = norm(sub(sm[Math.min(3, n - 1)], sm[n - Math.min(3, n - 1)]))
    fitRun(loop, tan, mul(tan, -1), opts.tolerance, segs)
    return { x: sm[0].x, y: sm[0].y, segs }
  }

  for (let k = 0; k < kept.length; k++) {
    const A = kept[k], B = kept[(k + 1) % kept.length]
    const a = A.i, b = B.i
    const run: Pt[] = [A.pos]
    const span = gap(a, b)
    // Interior vertices, skipping the rounded-off zone next to sharpened corners.
    const skipA = A.sharp ? guard : 0
    const skipB = B.sharp ? guard : 0
    for (let j = (a + 1) % n; j !== b; j = (j + 1) % n) {
      const d = arcBetween(s, perimeter, a, j)
      if (d > skipA && d < span - skipB) run.push(pts[j])
      if (d > span) break
    }
    run.push(B.pos)
    fitRun(smoothRun(run, 2), A.dOut, mul(B.dIn, -1), opts.tolerance, segs)
  }
  const start = kept[0].pos
  return { x: start.x, y: start.y, segs: mergeLines(start, segs, opts.tolerance * 0.5) }
}

/**
 * Taubin smoothing (a shrink step then an inflate step per pass) over a closed loop:
 * removes the ±0.1 px jitter anti-aliasing quantization leaves in the contour without
 * shrinking tight curves the way plain averaging would.
 */
function smoothLoop(p: Pt[], passes: number): Pt[] {
  const n = p.length
  let cur = p
  const step = (k: number) =>
    (cur = cur.map((q, i) => {
      const a = cur[(i - 1 + n) % n], b = cur[(i + 1) % n]
      return { x: q.x + k * ((a.x + b.x) / 2 - q.x), y: q.y + k * ((a.y + b.y) / 2 - q.y) }
    }))
  for (let i = 0; i < passes; i++) { step(0.5); step(-0.53) }
  return cur
}

/** Same as smoothLoop for an open run whose end points (corners) stay fixed. */
function smoothRun(p: Pt[], passes: number): Pt[] {
  let cur = p
  const step = (k: number) =>
    (cur = cur.map((q, i) =>
      i === 0 || i === cur.length - 1
        ? q
        : { x: q.x + k * ((cur[i - 1].x + cur[i + 1].x) / 2 - q.x), y: q.y + k * ((cur[i - 1].y + cur[i + 1].y) / 2 - q.y) },
    ))
  for (let i = 0; i < passes; i++) { step(0.5); step(-0.53) }
  return cur
}

/** True if the points lie on a circle within ~0.35 px. */
function isRound(p: Pt[]): boolean {
  let cx = 0, cy = 0
  for (const q of p) { cx += q.x; cy += q.y }
  cx /= p.length; cy /= p.length
  const r = p.map((q) => Math.hypot(q.x - cx, q.y - cy))
  const mean = r.reduce((a, b) => a + b, 0) / r.length
  return r.every((v) => Math.abs(v - mean) < 0.35)
}

function arcBetween(s: Float64Array, perimeter: number, i: number, j: number) {
  const d = s[j] - s[i]
  return d >= 0 ? d : d + perimeter
}

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Least-squares line through the polyline between two arc positions. With `straight`,
 * returns null unless the arc really is straight (otherwise it is a tangent estimate).
 */
function lineFit(pointAt: (t: number) => Pt, t0: number, t1: number, straight: boolean): { p: Pt; dir: Pt } | null {
  if (t1 - t0 < 0.6) return null
  const k = Math.max(3, Math.ceil((t1 - t0) / 0.5))
  const ps: Pt[] = []
  for (let i = 0; i <= k; i++) ps.push(pointAt(t0 + ((t1 - t0) * i) / k))
  const c = ps.reduce((acc, p) => add(acc, p), { x: 0, y: 0 })
  const m = mul(c, 1 / ps.length)
  let sxx = 0, sxy = 0, syy = 0
  for (const p of ps) {
    const d = sub(p, m)
    sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let dir = { x: Math.cos(angle), y: Math.sin(angle) }
  if (dot(dir, sub(ps[ps.length - 1], ps[0])) < 0) dir = mul(dir, -1)
  // Reject if the arc is visibly curved: then it is not a line to extend.
  const off = ps.reduce((mx, p) => Math.max(mx, Math.abs(cross(dir, sub(p, m)))), 0)
  if (straight && off > 0.35) return null
  return { p: m, dir }
}

const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x

function intersect(p: Pt, d: Pt, q: Pt, e: Pt): Pt | null {
  const den = cross(d, e)
  if (Math.abs(den) < 0.2) return null // nearly parallel: nothing to sharpen
  const t = cross(sub(q, p), e) / den
  return add(p, mul(d, t))
}

/**
 * Fits a run between two corners: straight stretches (sides of rounded rectangles,
 * stems of letters…) become exact lines, the rest is fitted with cubic Béziers that
 * meet those lines tangentially.
 */
function fitRun(run: Pt[], t1: Pt, t2: Pt, tol: number, out: Seg[]) {
  // Tight: an arc of radius R deviates from its chord by L²/8R, so a loose tolerance
  // would turn large curves into polygons.
  const lines = findLines(run, Math.min(0.08, tol * 0.5), 6)
  let from = 0
  let start = run[0]
  let tan = t1
  for (const line of lines) {
    if (line.i > from) fitCurve([start, ...run.slice(from + 1, line.i), line.a], tan, mul(line.dir, -1), tol, out)
    else if (dist(start, line.a) > 1e-6) out.push({ c: 'L', x: line.a.x, y: line.a.y })
    out.push({ c: 'L', x: line.b.x, y: line.b.y })
    from = line.j
    start = line.b
    tan = line.dir
  }
  const last = run.length - 1
  if (from < last) fitCurve([start, ...run.slice(from + 1, last), run[last]], tan, t2, tol, out)
  else if (dist(start, run[last]) > 1e-6) out.push({ c: 'L', x: run[last].x, y: run[last].y })
}

/** Emits a line when the points are straight, otherwise fits cubic Béziers. */
function fitCurve(run: Pt[], t1: Pt, t2: Pt, tol: number, out: Seg[]) {
  const first = run[0], last = run[run.length - 1]
  if (run.length <= 2 || maxChordDeviation(run) <= tol * 0.6) {
    out.push({ c: 'L', x: last.x, y: last.y })
    return
  }
  if (len(t1) === 0) t1 = norm(sub(run[1], first))
  if (len(t2) === 0) t2 = norm(sub(run[run.length - 2], last))
  fitCubic(run, 0, run.length - 1, t1, t2, tol * tol, out, 0)
}

interface Line {
  i: number
  j: number
  a: Pt
  b: Pt
  dir: Pt
}

/**
 * Greedy scan for maximal straight stretches at least `minLen` long whose points stay
 * within `tol` of their chord. Line ends are snapped onto the least-squares line,
 * except the run's own end points (corners), which never move.
 */
function findLines(run: Pt[], tol: number, minLen: number): Line[] {
  const lines: Line[] = []
  const last = run.length - 1
  let i = 0
  while (i < last) {
    let best = -1
    for (let j = i + 2; j <= last; j++) {
      if (chordDeviation(run, i, j) > tol) break
      best = j
    }
    if (best < 0 || dist(run[i], run[best]) < minLen) { i++; continue }
    // A straight side is bounded by a clear turn (a corner, or the arc of a rounded
    // corner); a short stretch of a large circle is not. Look half a line-length past
    // each end: if the contour hardly turns on either side, this is part of a curve.
    const L = dist(run[i], run[best])
    const chord = norm(sub(run[best], run[i]))
    const turnAt = (from: number, step: 1 | -1) => {
      if (from === (step > 0 ? last : 0)) return Math.PI
      let k = from, acc = 0
      while (k + step >= 0 && k + step <= last && acc < L / 2) { acc += dist(run[k], run[k + step]); k += step }
      const d = step > 0 ? norm(sub(run[k], run[from])) : norm(sub(run[from], run[k]))
      return Math.acos(Math.max(-1, Math.min(1, dot(d, chord))))
    }
    if (Math.max(turnAt(i, -1), turnAt(best, 1)) < (12 * Math.PI) / 180) { i++; continue }
    const pts = run.slice(i, best + 1)
    const m = mul(pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }), 1 / pts.length)
    let dir = norm(sub(run[best], run[i]))
    // Refine the direction by least squares (principal axis of the points).
    let sxx = 0, sxy = 0, syy = 0
    for (const p of pts) {
      const d = sub(p, m)
      sxx += d.x * d.x; sxy += d.x * d.y; syy += d.y * d.y
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const ls = { x: Math.cos(ang), y: Math.sin(ang) }
    if (dot(ls, dir) < 0) dir = mul(ls, -1)
    else dir = ls
    const project = (p: Pt) => add(m, mul(dir, dot(sub(p, m), dir)))
    lines.push({ i, j: best, a: i === 0 ? run[0] : project(run[i]), b: best === last ? run[last] : project(run[best]), dir })
    i = best
  }
  return lines
}

/** Max distance of run[i..j] from the chord run[i]–run[j]. */
function chordDeviation(run: Pt[], i: number, j: number) {
  const a = run[i], ab = sub(run[j], a)
  const L = len(ab)
  if (L < 1e-9) return Infinity
  let mx = 0
  for (let k = i + 1; k < j; k++) {
    const d = Math.abs(cross(ab, sub(run[k], a))) / L
    if (d > mx) mx = d
  }
  return mx
}

function maxChordDeviation(run: Pt[]) {
  const a = run[0], b = run[run.length - 1]
  const ab = sub(b, a)
  const L = len(ab)
  let mx = 0
  for (const p of run) {
    const d = L > 1e-9 ? Math.abs(cross(ab, sub(p, a))) / L : dist(p, a)
    if (d > mx) mx = d
  }
  // A closed-ish run (start ≈ end) is never a line.
  return L < 1e-6 ? Infinity : mx
}

/** Merges consecutive, collinear line segments. */
function mergeLines(start: Pt, segs: Seg[], tol: number): Seg[] {
  const out: Seg[] = []
  for (const seg of segs) {
    const last = out[out.length - 1]
    if (seg.c === 'L' && last?.c === 'L') {
      const from = out.length >= 2 ? endOf(out[out.length - 2]) : start
      const ab = sub(endOf(seg), from)
      const mid = sub(endOf(last), from)
      const L = len(ab)
      if (L > 1e-9 && Math.abs(cross(ab, mid)) / L <= tol && dot(mid, ab) > 0 && len(mid) < L) {
        out[out.length - 1] = seg
        continue
      }
    }
    out.push(seg)
  }
  return out
}

function endOf(seg: Seg): Pt {
  return { x: seg.x, y: seg.y }
}

// ---------- Schneider, "An Algorithm for Automatically Fitting Digitized Curves" ----------

type Bez = [Pt, Pt, Pt, Pt]

function fitCubic(d: Pt[], first: number, last: number, tHat1: Pt, tHat2: Pt, error: number, out: Seg[], depth: number) {
  const nPts = last - first + 1
  if (nPts === 2) {
    const dd = dist(d[first], d[last]) / 3
    pushBez(out, [d[first], add(d[first], mul(tHat1, dd)), add(d[last], mul(tHat2, dd)), d[last]])
    return
  }
  let u = chordParam(d, first, last)
  let bez = generateBezier(d, first, last, u, tHat1, tHat2)
  let [maxErr, split] = maxError(d, first, last, bez, u)
  if (maxErr < error) {
    pushBez(out, bez)
    return
  }
  if (maxErr < error * 16) {
    for (let i = 0; i < 6; i++) {
      u = reparameterize(d, first, u, bez)
      bez = generateBezier(d, first, last, u, tHat1, tHat2)
      ;[maxErr, split] = maxError(d, first, last, bez, u)
      if (maxErr < error) {
        pushBez(out, bez)
        return
      }
    }
  }
  if (depth > 40 || nPts <= 3) {
    pushBez(out, bez)
    return
  }
  split = Math.min(last - 1, Math.max(first + 1, split))
  // Tangent at the split from a few points either side, so pixel noise can't tilt it.
  const k = Math.min(3, split - first, last - split)
  const center = norm(sub(d[split - k], d[split + k]))
  fitCubic(d, first, split, tHat1, center, error, out, depth + 1)
  fitCubic(d, split, last, mul(center, -1), tHat2, error, out, depth + 1)
}

function pushBez(out: Seg[], b: Bez) {
  out.push({ c: 'C', x1: b[1].x, y1: b[1].y, x2: b[2].x, y2: b[2].y, x: b[3].x, y: b[3].y })
}

function chordParam(d: Pt[], first: number, last: number): number[] {
  const u = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(d[i], d[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

function generateBezier(d: Pt[], first: number, last: number, u: number[], tHat1: Pt, tHat2: Pt): Bez {
  const p0 = d[first], p3 = d[last]
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t
    const a1 = mul(tHat1, b1), a2 = mul(tHat2, b2)
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2)
    const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)))
    x0 += dot(a1, tmp); x1 += dot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  let alphaL = 0, alphaR = 0
  if (Math.abs(det) > 1e-12) {
    alphaL = (x0 * c11 - x1 * c01) / det
    alphaR = (c00 * x1 - c01 * x0) / det
  }
  const segLen = dist(p0, p3)
  const eps = 1e-6 * segLen
  if (alphaL < eps || alphaR < eps || alphaL > segLen * 2 || alphaR > segLen * 2) {
    alphaL = alphaR = segLen / 3
  }
  return [p0, add(p0, mul(tHat1, alphaL)), add(p3, mul(tHat2, alphaR)), p3]
}

function bezierAt(b: Bez, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt, c = 3 * mt * mt * t, e = 3 * mt * t * t, f = t * t * t
  return { x: a * b[0].x + c * b[1].x + e * b[2].x + f * b[3].x, y: a * b[0].y + c * b[1].y + e * b[2].y + f * b[3].y }
}

function maxError(d: Pt[], first: number, last: number, b: Bez, u: number[]): [number, number] {
  let mx = 0, split = Math.floor((first + last) / 2)
  for (let i = 1; i < u.length - 1; i++) {
    const p = bezierAt(b, u[i])
    const e = (p.x - d[first + i].x) ** 2 + (p.y - d[first + i].y) ** 2
    if (e >= mx) { mx = e; split = first + i }
  }
  return [mx, split]
}

function reparameterize(d: Pt[], first: number, u: number[], b: Bez): number[] {
  return u.map((t, i) => newtonRoot(b, d[first + i], t))
}

function newtonRoot(q: Bez, p: Pt, t: number): number {
  const q1: Pt[] = [0, 1, 2].map((i) => mul(sub(q[i + 1], q[i]), 3))
  const q2: Pt[] = [0, 1].map((i) => mul(sub(q1[i + 1], q1[i]), 2))
  const qt = bezierAt(q, t)
  const mt = 1 - t
  const q1t = add(add(mul(q1[0], mt * mt), mul(q1[1], 2 * t * mt)), mul(q1[2], t * t))
  const q2t = add(mul(q2[0], mt), mul(q2[1], t))
  const diff = sub(qt, p)
  const num = dot(diff, q1t)
  const den = dot(q1t, q1t) + dot(diff, q2t)
  if (Math.abs(den) < 1e-12) return t
  const r = t - num / den
  return Math.min(1, Math.max(0, r))
}
