import assert from 'node:assert/strict'
import { test } from 'node:test'
import { byteLength } from '../src/lib/image.ts'
import { optimizeSvg } from '../src/lib/optimize.ts'
import { settingsForPreset } from '../src/lib/presets.ts'
import { traceImage } from '../src/lib/vectorize.ts'
import { fixture, meanDiff, rasterize } from './helpers.ts'

test('optimization shrinks the SVG without visible change', () => {
  for (const name of ['logo.svg', 'text.svg', 'illustration.svg']) {
    const { svg } = traceImage(rasterize(fixture(name)), settingsForPreset('detailed'))
    const out = optimizeSvg(svg)
    assert.ok(out.bytes < byteLength(svg) * 0.8, `${name}: ${out.bytes} vs ${byteLength(svg)}`)
    assert.match(out.svg, /viewBox=/)
    assert.match(out.svg, /width="\d+"/)
    const diff = meanDiff(rasterize(svg, 800), rasterize(out.svg, 800))
    assert.ok(diff < 0.3, `${name}: diff ${diff}`)
  }
})

test('optimization strips metadata and editor attributes', () => {
  const input =
    '<?xml version="1.0"?><!-- comment --><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
    '<metadata>x</metadata><path data-x="1" fill="#ff0000" transform="translate(1 1)" d="M0 0L5 0L5 5L0 5Z"/></svg>'
  const out = optimizeSvg(input).svg
  assert.doesNotMatch(out, /metadata|comment|data-x|<\?xml/)
  assert.match(out, /fill="red"|fill="#f00"/)
})
