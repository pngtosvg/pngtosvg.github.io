import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optimizeSvg } from '../src/lib/optimize.ts'
import { settingsForPreset, type PresetId, type TraceSettings } from '../src/lib/presets.ts'
import { traceImage } from '../src/lib/vectorize.ts'
import { compress, fixture, meanDiff, rasterize } from './helpers.ts'

const settings = (id: PresetId, extra: Partial<TraceSettings> = {}) => ({
  ...settingsForPreset(id),
  cropTransparent: false,
  ...extra,
})

/** Gradients in an SVG, with their stops (offset and color). */
function gradientsIn(svg: string) {
  return [...svg.matchAll(/<(linear|radial)Gradient[^>]*>(.*?)<\/\1Gradient>/g)].map((m) => ({
    type: m[1],
    stops: [...m[2].matchAll(/<stop offset="([^"]*)" stop-color="([^"]*)"/g)].map((s) => ({ offset: parseFloat(s[1]), color: s[2] })),
  }))
}

function trace(name: string, id: PresetId = 'logo', extra: Partial<TraceSettings> = {}) {
  const source = fixture(name)
  const result = traceImage(rasterize(source), settings(id, extra))
  return { result, gradients: gradientsIn(result.svg), diff: meanDiff(rasterize(source, 800), rasterize(result.svg, 800)) }
}

test('smooth color transitions become linear and radial gradients', () => {
  for (const id of ['logo', 'icon', 'smooth', 'detailed'] as const) {
    const { result, gradients, diff } = trace('illustration.svg', id)
    assert.deepEqual(gradients.map((g) => g.type).sort(), ['linear', 'radial'], `${id}: sky and sun`)
    assert.equal(result.gradients, 2)
    assert.ok(diff < 1, `${id}: mean difference ${diff.toFixed(2)}`)
  }
  // Without gradients the same image needs bands of flat color and looks clearly worse.
  const flat = trace('illustration.svg', 'logo', { gradients: false })
  assert.equal(flat.gradients.length, 0)
  assert.equal(flat.result.gradients, 0)
  assert.ok(flat.diff > 3)
})

test('gradients get as many stops as they need, and radial ones their center', () => {
  const circle = trace('gradient-circle.svg')
  assert.equal(circle.gradients.length, 1)
  assert.equal(circle.gradients[0].type, 'linear')
  assert.equal(circle.gradients[0].stops.length, 3, 'cyan, purple, amber')
  assert.ok(circle.diff < 0.6, `circle: ${circle.diff.toFixed(2)}`)

  const badge = trace('gradient-badge.svg')
  assert.equal(badge.gradients.length, 1)
  assert.equal(badge.gradients[0].type, 'radial')
  assert.deepEqual(badge.result.colors, ['#ffffff'], 'the check mark stays flat white')
  assert.ok(badge.diff < 0.6, `badge: ${badge.diff.toFixed(2)}`)
})

test('a gradient that fades into the background is still found', () => {
  const { result, gradients, diff } = trace('gradient-fade.svg')
  assert.equal(gradients.length, 1)
  assert.equal(gradients[0].type, 'linear')
  assert.deepEqual(result.colors, ['#ffffff'])
  assert.ok(diff < 0.6, `mean difference ${diff.toFixed(2)}`)
})

test('exact colors survive lossy compression, small accents and pale panels included', () => {
  const source = fixture('accents.svg')
  const lossy = compress(rasterize(source))
  for (const id of ['logo', 'icon', 'smooth', 'detailed'] as const) {
    const r = traceImage(lossy, settings(id))
    assert.deepEqual([...r.colors].sort(), ['#1e3a8a', '#2563eb', '#ef4444', '#f1f5f9', '#ffffff'], id)
    assert.equal(r.gradients, 0, `${id}: compression noise is not a gradient`)
    const diff = meanDiff(rasterize(source, 640), rasterize(r.svg, 640))
    assert.ok(diff < 0.3, `${id}: mean difference ${diff.toFixed(2)}`)
  }
})

test('enclosed areas of the background color are reported and cleared on request', () => {
  const src = rasterize(fixture('ring.svg'))
  const kept = traceImage(src, settings('logo', { removeBackground: true }))
  assert.equal(kept.enclosed, 1, 'the inside of the ring')
  assert.ok(kept.colors.includes('#ffffff'))
  const cleared = traceImage(src, settings('logo', { removeBackground: true, clearEnclosed: true }))
  assert.equal(cleared.enclosed, 1)
  assert.deepEqual([...cleared.colors].sort(), ['#1b4965', '#e4572e'])
  const out = rasterize(cleared.svg)
  assert.equal(out.data[(80 * out.width + 80) * 4 + 3], 0, 'ring center is transparent')
  assert.equal(out.data[(80 * out.width + 180) * 4 + 3], 255, 'artwork stays opaque')
  assert.equal(traceImage(src, settings('logo')).enclosed, 0, 'nothing to report without background removal')
})

test('optimization keeps gradients exact', () => {
  for (const name of ['gradient-circle.svg', 'gradient-badge.svg', 'illustration.svg']) {
    const { result } = trace(name)
    const optimized = optimizeSvg(result.svg).svg
    const byType = (a: { type: string }, b: { type: string }) => a.type.localeCompare(b.type)
    const before = gradientsIn(result.svg).sort(byType)
    const after = gradientsIn(optimized.replace(/ offset="\./g, ' offset="0.')).sort(byType)
    assert.equal(after.length, before.length, name)
    before.forEach((g, i) => {
      assert.equal(after[i].type, g.type)
      g.stops.forEach((s, k) => {
        assert.ok(Math.abs(after[i].stops[k].offset - s.offset) < 0.001, `${name}: stop offset ${s.offset} → ${after[i].stops[k].offset}`)
      })
    })
  }
})
