import { optimize } from 'svgo/browser'
import { byteLength } from './image.ts'

export interface OptimizeResult {
  svg: string
  bytes: number
}

/**
 * Minifies an SVG for download: merges and shortens paths, bakes transforms into path
 * data, rounds coordinates to a precision that stays invisible at the SVG's own size,
 * and strips metadata and editor leftovers.
 */
export function optimizeSvg(svg: string): OptimizeResult {
  const precision = pickPrecision(svg)
  const result = optimize(svg, {
    multipass: true,
    floatPrecision: precision,
    plugins: [
      {
        name: 'preset-default',
        params: {
          overrides: {
            convertPathData: { floatPrecision: precision, transformPrecision: precision + 3 },
            // Gradient stop offsets are fractions (0–1): coordinate precision would move them.
            cleanupNumericValues: { floatPrecision: 3 },
          },
        },
      },
      'removeXlink',
      { name: 'removeAttrs', params: { attrs: ['data-.*'] } },
    ],
  })
  return { svg: result.data, bytes: byteLength(result.data) }
}

/** Decimal places that stay below ~1/20 px at the SVG's natural size. */
function pickPrecision(svg: string): number {
  const m = svg.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  const size = m ? Math.max(parseFloat(m[1]), parseFloat(m[2])) : 512
  if (size <= 128) return 2
  if (size <= 4096) return 1
  return 0
}
