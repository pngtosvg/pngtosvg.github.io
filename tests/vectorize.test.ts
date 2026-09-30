import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingsForPreset, type PresetId } from '../src/lib/presets.ts'
import { opaqueBounds } from '../src/lib/raster.ts'
import { traceImage } from '../src/lib/vectorize.ts'
import { fixture, meanDiff, rasterize } from './helpers.ts'

const untrimmed = (id: PresetId) => ({ ...settingsForPreset(id), cropTransparent: false })

/** Traces a fixture and compares the result with the source vector at high resolution. */
function accuracy(name: string, id: PresetId = 'logo') {
  const source = fixture(name)
  const r = traceImage(rasterize(source), untrimmed(id))
  return { result: r, diff: meanDiff(rasterize(source, 1200), rasterize(r.svg, 1200)) }
}

test('logo preset recovers the exact flat colors, ignoring anti-aliasing', () => {
  const r = traceImage(rasterize(fixture('logo.svg')), settingsForPreset('logo'))
  assert.deepEqual([...r.colors].sort(), ['#1b4965', '#e4572e', '#ffc914', '#ffffff'])
  assert.equal(r.paths, 4, 'one shape per color')
})

test('traced logo, text and icon match their source vectors closely', () => {
  for (const [name, max] of [['logo.svg', 0.25], ['text.svg', 0.6], ['icon.svg', 0.9]] as const) {
    const { diff } = accuracy(name)
    assert.ok(diff < max, `${name}: mean difference ${diff.toFixed(3)} ≥ ${max}`)
  }
})

test('sharp corners are restored and straight edges become lines', () => {
  // The "!" bar of the 48 px icon is a 4×13 rectangle.
  const { result } = accuracy('icon.svg')
  assert.match(result.svg, /d="M22 16L22 29L26 29L26 16Z"/)
})

test('transparent margins are trimmed and stay transparent', () => {
  const src = rasterize(fixture('logo.svg'))
  const bounds = opaqueBounds(src, 128)!
  const r = traceImage(src, settingsForPreset('logo'))
  assert.deepEqual([r.width, r.height], [bounds.width, bounds.height])
  assert.match(r.svg, new RegExp(`viewBox="0 0 ${bounds.width} ${bounds.height}"`))
  // The corner of the trimmed box lies outside the circle.
  assert.equal(rasterize(r.svg).data[3], 0)
})

test('opaque images are covered edge to edge, without hairline gaps between colors', () => {
  for (const id of ['logo', 'smooth', 'detailed'] as const) {
    for (const layering of ['separate', 'stacked'] as const) {
      const src = rasterize(fixture('illustration.svg'))
      const out = rasterize(traceImage(src, { ...settingsForPreset(id), layering }).svg, src.width * 2)
      let minAlpha = 255
      for (let i = 3; i < out.data.length; i += 4) minAlpha = Math.min(minAlpha, out.data[i])
      assert.ok(minAlpha >= 250, `${id}/${layering}: found a gap (alpha ${minAlpha})`)
    }
  }
})

test('solid backgrounds can be removed', () => {
  const onWhite = fixture('logo.svg').replace('>', '><rect width="100%" height="100%" fill="#ffffff"/>')
  const src = rasterize(onWhite)
  const kept = traceImage(src, { ...settingsForPreset('logo'), removeBackground: false })
  const removed = traceImage(src, { ...settingsForPreset('logo'), removeBackground: true })
  assert.equal(kept.width, src.width, 'opaque background: nothing to trim')
  assert.ok(removed.width < src.width, 'background removed, then trimmed')
  assert.equal(rasterize(removed.svg).data[3], 0)
  // Anti-aliased edges are un-blended from the old background: no fringe colors or slivers.
  const transparent = traceImage(rasterize(fixture('logo.svg')), settingsForPreset('logo'))
  assert.deepEqual([...removed.colors].sort(), [...transparent.colors].sort())
  assert.equal(removed.paths, transparent.paths)
})

test('every preset and layering produces a valid SVG', () => {
  const src = rasterize(fixture('logo.svg'))
  for (const id of ['logo', 'icon', 'smooth', 'detailed'] as const) {
    for (const layering of ['separate', 'stacked'] as const) {
      const r = traceImage(src, { ...settingsForPreset(id), layering })
      assert.ok(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
      assert.ok(r.paths > 0)
      assert.doesNotMatch(r.svg, /NaN|Infinity/)
      rasterize(r.svg)
    }
  }
})

test('a fully transparent image gives an empty SVG instead of failing', () => {
  const blank = { width: 10, height: 10, data: new Uint8ClampedArray(400) }
  const r = traceImage(blank, settingsForPreset('logo'))
  assert.equal(r.paths, 0)
  assert.equal(r.colors.length, 0)
  rasterize(r.svg)
})
