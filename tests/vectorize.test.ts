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

/** Smallest alpha anywhere in the traced SVG rendered at `scale`× (255 = fully covered). */
function minAlpha(svg: string, width: number, scale: number) {
  const out = rasterize(svg, width * scale)
  let min = 255
  for (let i = 3; i < out.data.length; i += 4) min = Math.min(min, out.data[i])
  return min
}

test('sharpened notches never open pinholes between separate shapes', () => {
  // A curved stroke whose tight bend leaves a narrow notch of the background color.
  const art =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="32"><rect width="40" height="32" fill="#ff99ee"/>' +
    '<path d="M35.7 15.5 Q2.4 15.7 26.6 22.9" stroke="#33cc99" stroke-width="3.7" fill="none"/></svg>'
  const src = rasterize(art)
  for (const id of ['logo', 'icon'] as const) {
    const { svg } = traceImage(src, settingsForPreset(id))
    for (const scale of [2, 8]) assert.ok(minAlpha(svg, src.width, scale) >= 250, `${id} at ${scale}x`)
  }
})

test('random opaque artwork traces without gaps', () => {
  let seed = 99
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  const color = () => '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')
  for (let t = 0; t < 12; t++) {
    const w = 30 + Math.floor(rnd() * 60), h = 30 + Math.floor(rnd() * 60)
    const p = () => `${(rnd() * w).toFixed(1)} ${(rnd() * h).toFixed(1)}`
    let body = `<rect width="${w}" height="${h}" fill="${color()}"/>`
    for (let k = 0; k < 4; k++) {
      body += k % 2
        ? `<path d="M${p()} Q${p()} ${p()}" stroke="${color()}" stroke-width="${(1 + rnd() * 5).toFixed(1)}" fill="none"/>`
        : `<polygon points="${p()} ${p()} ${p()}" fill="${color()}"/>`
    }
    const src = rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)
    for (const id of ['logo', 'icon'] as const) {
      const { svg } = traceImage(src, settingsForPreset(id))
      assert.ok(minAlpha(svg, w, 3) >= 250, `artwork ${t}, ${id}`)
    }
  }
})

test('tiny dots become round shapes wound like their neighbours', () => {
  const art =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="2" y="2" width="8" height="16"/>' +
    '<circle cx="15.5" cy="10.5" r="0.8"/></svg>'
  const r = traceImage(rasterize(art), { ...settingsForPreset('logo'), detail: 100, cropTransparent: false })
  const paths = [...r.svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
  assert.equal(paths.length, 2)
  const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="${paths[1]}"/></svg>`
  const img = rasterize(dotSvg, 200)
  let ink = 0
  for (let i = 3; i < img.data.length; i += 4) ink += img.data[i] / 255
  const area = ink / 100 // px² at 1x
  assert.ok(Math.abs(area - Math.PI * 0.8 * 0.8) < 0.5, `dot area ${area.toFixed(2)}`)
  // Same winding as the rectangle: both are filled shapes, not holes.
  const signed = (d: string) => {
    const n = d.match(/-?\d*\.?\d+/g)!.map(Number)
    let a = 0
    for (let i = 0; i + 3 < n.length; i += 2) a += n[i] * n[i + 3] - n[i + 2] * n[i + 1]
    return Math.sign(a)
  }
  assert.equal(signed(paths[1]), signed(paths[0]))
})

test('images decoded smaller than their real size still export at full size', () => {
  const r = traceImage(rasterize(fixture('logo.svg')), settingsForPreset('logo'), undefined, 2.5)
  const [, w, h, vw, vh] = r.svg.match(/width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/)!.map(Number)
  assert.equal(w, Math.round(vw * 2.5))
  assert.equal(h, Math.round(vh * 2.5))
})
