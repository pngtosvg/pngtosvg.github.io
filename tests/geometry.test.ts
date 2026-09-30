import assert from 'node:assert/strict'
import { test } from 'node:test'
import { marchingSquares, signedArea } from '../src/lib/contour.ts'
import { fitOutline, type FitOptions } from '../src/lib/fit.ts'

const opts: FitOptions = { tolerance: 0.2, cornerAngle: (35 * Math.PI) / 180, cornerWindow: 2, sharpen: 2 }

function field(w: number, h: number, inside: (x: number, y: number) => boolean) {
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0
  return f
}

test('marching squares traces outer boundaries and holes with opposite winding', () => {
  const ring = field(20, 20, (x, y) => x > 3 && x < 17 && y > 3 && y < 17 && !(x > 8 && x < 12 && y > 8 && y < 12))
  const loops = marchingSquares(ring, 20, 20)
  assert.equal(loops.length, 2)
  const areas = loops.map(signedArea).sort((a, b) => a - b)
  assert.ok(areas[0] < 0 && areas[1] > 0, `areas ${areas}`)
})

test('marching squares places edges with sub-pixel precision', () => {
  // A vertical edge at x = 5.3 encoded as partial coverage of pixel column 5.
  const w = 10, h = 6
  const f = new Float32Array(w * h)
  for (let y = 1; y < 5; y++) for (let x = 0; x < w; x++) f[y * w + x] = x < 5 ? 1 : x === 5 ? 0.3 : 0
  const [loop] = marchingSquares(f, w, h)
  const xs = [...loop].filter((_, i) => i % 2 === 0)
  const right = Math.max(...xs)
  assert.ok(Math.abs(right - 5.3) < 1e-6, `edge at ${right}`)
})

test('a pixel square becomes four straight lines with exact corners', () => {
  const [loop] = marchingSquares(field(16, 16, (x, y) => x > 4 && x < 12 && y > 3 && y < 13), 16, 16)
  const o = fitOutline(loop, opts)!
  assert.ok(o.segs.every((s) => s.c === 'L'))
  const pts = [[o.x, o.y], ...o.segs.map((s) => [s.x, s.y])].map(([x, y]) => `${x},${y}`)
  assert.deepEqual(new Set(pts), new Set(['4,3', '12,3', '12,13', '4,13']))
})

test('a circle becomes a few smooth curves that stay on the circle', () => {
  const r = 20, n = 400
  const pts = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    pts[2 * i] = 30 + r * Math.cos((2 * Math.PI * i) / n)
    pts[2 * i + 1] = 30 + r * Math.sin((2 * Math.PI * i) / n)
  }
  const o = fitOutline(pts, opts)!
  assert.ok(o.segs.every((s) => s.c === 'C'))
  assert.ok(o.segs.length <= 8, `${o.segs.length} segments`)
  for (const s of o.segs) {
    if (s.c !== 'C') continue
    assert.ok(Math.abs(Math.hypot(s.x - 30, s.y - 30) - r) < 0.2)
  }
})
