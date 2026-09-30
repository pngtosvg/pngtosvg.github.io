/**
 * Marching squares on a scalar field (one value per pixel, pixel centers at +0.5).
 *
 * Returns closed polylines at `iso`, with sub-pixel vertex positions. The field is treated as 0 outside the image so every contour closes.
 * Orientation is consistent: the region >= iso is always on the same side, so outer
 * boundaries and holes come out with opposite winding (ready for the nonzero fill rule).
 */
export function marchingSquares(field: Float32Array, w: number, h: number, iso = 0.5): Float64Array[] {
  // Padded grid: corner (X, Y) maps to pixel (X - 1, Y - 1); the one-pixel ring is 0.
  const PW = w + 2
  const PH = h + 2
  const at = (X: number, Y: number) => (X < 1 || Y < 1 || X > w || Y > h ? 0 : field[(Y - 1) * w + (X - 1)])

  // Only scan cells around the part of the field that reaches the iso level.
  let minX = PW, minY = PH, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (field[row + x] >= iso) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return []
  // Cells whose corners include the inside pixels (padded coordinates).
  const cx0 = minX, cy0 = minY, cx1 = maxX + 1, cy1 = maxY + 1

  // next[edge] = following edge along the contour. Edge ids: horizontal (X,Y)-(X+1,Y) = 2*(Y*PW+X),
  // vertical (X,Y)-(X,Y+1) = 2*(Y*PW+X)+1.
  const next = new Map<number, number>()
  const H = (X: number, Y: number) => 2 * (Y * PW + X)
  const V = (X: number, Y: number) => 2 * (Y * PW + X) + 1

  const link = (a: number, b: number) => next.set(a, b)

  for (let Y = cy0; Y <= cy1 && Y < PH - 1; Y++) {
    for (let X = cx0; X <= cx1 && X < PW - 1; X++) {
      const tl = at(X, Y), tr = at(X + 1, Y), br = at(X + 1, Y + 1), bl = at(X, Y + 1)
      const code = (tl >= iso ? 8 : 0) | (tr >= iso ? 4 : 0) | (br >= iso ? 2 : 0) | (bl >= iso ? 1 : 0)
      if (code === 0 || code === 15) continue
      // Edges in clockwise order: top (tl→tr), right (tr→br), bottom (br→bl), left (bl→tl).
      const top = H(X, Y), right = V(X + 1, Y), bottom = H(X, Y + 1), left = V(X, Y)
      // A segment starts where the clockwise walk enters the inside region and ends
      // where it leaves it. Non-saddle cells have exactly one of each.
      switch (code) {
        case 8: link(left, top); break // tl
        case 4: link(top, right); break // tr
        case 2: link(right, bottom); break // br
        case 1: link(bottom, left); break // bl
        case 12: link(left, right); break // tl tr
        case 6: link(top, bottom); break // tr br
        case 3: link(right, left); break // br bl
        case 9: link(bottom, top); break // bl tl
        case 14: link(left, bottom); break // all but bl
        case 13: link(bottom, right); break // all but br
        case 11: link(right, top); break // all but tr
        case 7: link(top, left); break // all but tl
        case 10: // tl + br (saddle)
          if ((tl + tr + br + bl) / 4 >= iso) { link(left, bottom); link(right, top) }
          else { link(left, top); link(right, bottom) }
          break
        case 5: // tr + bl (saddle)
          if ((tl + tr + br + bl) / 4 >= iso) { link(top, left); link(bottom, right) }
          else { link(top, right); link(bottom, left) }
          break
      }
    }
  }

  // Where the crossing lies between two samples a and b (0 = at a, 1 = at b). For the
  // 50% level of a coverage field this uses the box-filter model of anti-aliasing: an
  // edge through the outside pixel at coverage c sits c past the pixel boundary, i.e.
  // offset = a + b - 0.5 from the inside sample, exact for straight edges.
  const cross = (a: number, b: number) => {
    if (iso !== 0.5) return (iso - a) / (b - a)
    return a >= iso ? a + b - 0.5 : 1 - (a + b - 0.5)
  }
  const point = (id: number, out: number[]) => {
    const cell = id >> 1
    const X = cell % PW, Y = (cell / PW) | 0
    if ((id & 1) === 0) out.push(X + cross(at(X, Y), at(X + 1, Y)) - 0.5, Y - 0.5)
    else out.push(X - 0.5, Y + cross(at(X, Y), at(X, Y + 1)) - 0.5)
  }

  const loops: Float64Array[] = []
  for (const start of next.keys()) {
    if (!next.has(start)) continue
    const pts: number[] = []
    let id = start
    for (;;) {
      const n = next.get(id)
      if (n === undefined) break
      next.delete(id)
      point(id, pts)
      id = n
      if (id === start) break
    }
    if (pts.length >= 6) loops.push(Float64Array.from(pts))
  }
  return loops
}

/** Shoelace signed area of a closed polyline (x0,y0,x1,y1,…). */
export function signedArea(p: Float64Array): number {
  let a = 0
  const n = p.length
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n
    a += p[i] * p[j + 1] - p[j] * p[i + 1]
  }
  return a / 2
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(x: number, y: number, p: Float64Array): boolean {
  let inside = false
  const n = p.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
