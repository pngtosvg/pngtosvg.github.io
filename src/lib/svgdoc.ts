/** Elements the editor treats as selectable shapes. */
export const SHAPE_SELECTOR = 'path, rect, circle, ellipse, polygon, polyline, line'

export function getShapes(root: Element): SVGGraphicsElement[] {
  return Array.from(root.querySelectorAll<SVGGraphicsElement>(SHAPE_SELECTOR))
}

/** Fill or stroke color as #rrggbb, or 'none'. Style attributes win over presentation attributes. */
export function paintOf(el: Element, prop: 'fill' | 'stroke'): string {
  const style = (el as SVGElement).style?.getPropertyValue(prop)
  const raw = style || el.getAttribute(prop) || (prop === 'fill' ? '#000000' : 'none')
  return normalizeColor(raw)
}

export function setPaint(el: Element, prop: 'fill' | 'stroke', color: string) {
  ;(el as SVGElement).style?.removeProperty(prop)
  el.setAttribute(prop, color)
  if (el.getAttribute('style') === '') el.removeAttribute('style')
}

let ctx: CanvasRenderingContext2D | null | undefined

export function normalizeColor(c: string): string {
  const v = c.trim().toLowerCase()
  if (v === 'none' || v === 'transparent') return 'none'
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (/^#[0-9a-f]{3}$/.test(v)) return '#' + [...v.slice(1)].map((ch) => ch + ch).join('')
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return v
  ctx.fillStyle = '#000000'
  ctx.fillStyle = v
  return ctx.fillStyle.startsWith('#') ? ctx.fillStyle : v
}

export interface PaletteEntry {
  color: string
  count: number
}

/** Distinct fill colors in paint order of first appearance, bottom layer first. */
export function paletteOf(root: Element): PaletteEntry[] {
  const map = new Map<string, number>()
  for (const el of getShapes(root)) {
    const c = paintOf(el, 'fill')
    if (c === 'none') continue
    map.set(c, (map.get(c) ?? 0) + 1)
  }
  return [...map].map(([color, count]) => ({ color, count }))
}

export function matrixOf(el: SVGGraphicsElement): DOMMatrix {
  const t = el.transform?.baseVal.consolidate()
  if (!t) return new DOMMatrix()
  const m = t.matrix
  return new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f])
}

const r = (v: number) => {
  const x = Math.round(v * 1000) / 1000
  return Object.is(x, -0) ? '0' : String(x)
}

export function setMatrix(el: Element, m: DOMMatrix) {
  if (m.isIdentity) el.removeAttribute('transform')
  else if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) el.setAttribute('transform', `translate(${r(m.e)} ${r(m.f)})`)
  else el.setAttribute('transform', `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(r).join(' ')})`)
}

export function serialize(root: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(root).replace(/ xmlns:xlink="[^"]*"/, '') + '\n'
}

/**
 * Applies an edit to a detached copy of the document and returns the new markup.
 * Keeps all mutations out of React's rendered DOM so undo/redo stays a plain string swap.
 */
export function editSvg(svg: string, fn: (root: SVGSVGElement, shapes: SVGGraphicsElement[]) => void): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement as unknown as SVGSVGElement
  fn(root, getShapes(root))
  return serialize(root)
}
