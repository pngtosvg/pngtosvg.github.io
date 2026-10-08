/** Elements the editor treats as selectable shapes. */
export const SHAPE_SELECTOR = 'path, rect, circle, ellipse, polygon, polyline, line'

export function getShapes(root: Element): SVGGraphicsElement[] {
  return Array.from(root.querySelectorAll<SVGGraphicsElement>(SHAPE_SELECTOR))
}

/**
 * Fill or stroke as #rrggbb, 'none', or url(#id) for a gradient. Style attributes win
 * over presentation attributes.
 */
export function paintOf(el: Element, prop: 'fill' | 'stroke'): string {
  const style = (el as SVGElement).style?.getPropertyValue(prop)
  const raw = style || el.getAttribute(prop) || (prop === 'fill' ? '#000000' : 'none')
  const ref = raw.trim().match(/^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/)
  return ref ? `url(#${ref[1]})` : normalizeColor(raw)
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

export interface GradientStop {
  offset: number
  color: string
}

export interface Gradient {
  id: string
  type: 'linear' | 'radial'
  stops: GradientStop[]
}

function byId(root: Element, id: string): Element | null {
  for (const el of root.querySelectorAll('[id]')) if (el.getAttribute('id') === id) return el
  return null
}

function gradientElement(root: Element, paint: string): Element | null {
  const id = paint.match(/^url\(#(.+)\)$/)?.[1]
  const el = id ? byId(root, id) : null
  return el && (el.localName === 'linearGradient' || el.localName === 'radialGradient') ? el : null
}

/** The gradient a url(#id) paint points to, or null. */
export function gradientOf(root: Element, paint: string): Gradient | null {
  const el = gradientElement(root, paint)
  if (!el) return null
  const stops = Array.from(el.querySelectorAll('stop')).map((st) => {
    const off = (st as SVGElement).style?.getPropertyValue('offset') || st.getAttribute('offset') || '0'
    const color = (st as SVGElement).style?.getPropertyValue('stop-color') || st.getAttribute('stop-color') || '#000000'
    const v = parseFloat(off)
    return { offset: Math.min(1, Math.max(0, off.trim().endsWith('%') ? v / 100 : v || 0)), color: normalizeColor(color) }
  })
  if (!stops.length) return null
  return { id: el.getAttribute('id')!, type: el.localName === 'linearGradient' ? 'linear' : 'radial', stops }
}

/** Sets the color of one stop of the gradient that `paint` (url(#id)) points to. */
export function setStopColor(root: Element, paint: string, index: number, color: string) {
  const st = gradientElement(root, paint)?.querySelectorAll('stop')[index]
  if (!st) return
  ;(st as SVGElement).style?.removeProperty('stop-color')
  st.setAttribute('stop-color', color)
  if (st.getAttribute('style') === '') st.removeAttribute('style')
}

/**
 * Gives `els` a gradient of their own when shapes outside them use the same one, so
 * editing it changes only them. Returns the paint they now use.
 */
export function ownGradient(root: Element, shapes: Element[], els: Element[], paint: string): string {
  const src = gradientElement(root, paint)
  if (!src || shapes.every((el) => els.includes(el) || paintOf(el, 'fill') !== paint)) return paint
  const base = src.getAttribute('id')!
  let k = 2
  while (byId(root, `${base}-${k}`)) k++
  const copy = src.cloneNode(true) as Element
  copy.setAttribute('id', `${base}-${k}`)
  src.after(copy)
  const next = `url(#${base}-${k})`
  for (const el of els) if (paintOf(el, 'fill') === paint) setPaint(el, 'fill', next)
  return next
}

/** Color of a gradient at `t` (0–1). */
export function gradientColorAt(g: Gradient, t: number): string {
  const s = g.stops
  if (t <= s[0].offset) return s[0].color
  for (let k = 1; k < s.length; k++) {
    if (t > s[k].offset) continue
    const a = s[k - 1], b = s[k]
    const f = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 0
    const ca = hexRgb(a.color), cb = hexRgb(b.color)
    return '#' + ca.map((v, c) => Math.round(v + (cb[c] - v) * f).toString(16).padStart(2, '0')).join('')
  }
  return s[s.length - 1].color
}

function hexRgb(c: string): number[] {
  return /^#[0-9a-f]{6}$/.test(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : [0, 0, 0]
}

/** CSS background that shows a gradient's stops left to right (radial: center to edge). */
export function gradientCss(g: Gradient): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.offset * 1000) / 10}%`).join(', ')
  return `linear-gradient(90deg, ${stops})`
}

export interface PaletteEntry {
  /** #rrggbb, or url(#id) for a gradient. */
  color: string
  count: number
}

/** Distinct fills (colors and gradients) in paint order of first appearance, bottom layer first. */
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
