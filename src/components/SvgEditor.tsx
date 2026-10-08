import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getShapes, matrixOf, serialize, setMatrix, SHAPE_SELECTOR } from '../lib/svgdoc.ts'

interface Props {
  svg: string
  selection: number[]
  zoom: number
  onSelectionChange: (selection: number[]) => void
  onCommit: (svg: string) => void
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Drag {
  kind: 'move' | 'resize'
  pointerId: number
  els: SVGGraphicsElement[]
  orig: DOMMatrix[]
  toUser: DOMMatrix
  start: DOMPoint
  /** Fixed point for resizing, in root user units. */
  origin?: DOMPoint
  moved: boolean
  /** Shape that was clicked, to collapse a multi-selection on a plain click. */
  clicked?: number
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/**
 * Renders the working SVG and lets the user pick, move and resize shapes directly.
 * Live drags mutate the rendered DOM for smoothness; the result is committed as a
 * new document string on pointer up (one undo step per gesture).
 */
export function SvgEditor({ svg, selection, zoom, onSelectionChange, onCommit }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [box, setBox] = useState<Box | null>(null)

  const root = () => hostRef.current?.querySelector('svg') as SVGSVGElement | null
  const shapes = () => (hostRef.current ? getShapes(hostRef.current) : [])

  useLayoutEffect(() => {
    if (hostRef.current) hostRef.current.innerHTML = svg
  }, [svg])

  const measure = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const all = shapes()
    const els = selection.map((i) => all[i]).filter(Boolean)
    if (!els.length) { setBox(null); return }
    const s = stage.getBoundingClientRect()
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const el of els) {
      const r = el.getBoundingClientRect()
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top)
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom)
    }
    setBox({ x: x0 - s.left, y: y0 - s.top, width: x1 - x0, height: y1 - y0 })
  }, [selection])

  useLayoutEffect(measure, [measure, svg, zoom])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [measure])

  const toUserPoint = (m: DOMMatrix, e: { clientX: number; clientY: number }) =>
    new DOMPoint(e.clientX, e.clientY).matrixTransform(m)

  const begin = (e: React.PointerEvent, kind: Drag['kind'], els: SVGGraphicsElement[], extra: Partial<Drag> = {}) => {
    const svgEl = root()
    const ctm = svgEl?.getScreenCTM()
    if (!svgEl || !ctm) return
    const toUser = ctm.inverse()
    drag.current = {
      kind,
      pointerId: e.pointerId,
      els,
      orig: els.map(matrixOf),
      toUser,
      start: toUserPoint(toUser, e),
      moved: false,
      ...extra,
    }
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const all = shapes()
    const target = (e.target as Element).closest?.(SHAPE_SELECTOR)
    const idx = target ? all.indexOf(target as SVGGraphicsElement) : -1
    if (idx < 0) {
      if (!(e.target as Element).closest('.sel-box')) onSelectionChange([])
      return
    }
    e.preventDefault()
    let next = selection
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      next = selection.includes(idx) ? selection.filter((i) => i !== idx) : [...selection, idx]
      onSelectionChange(next)
      if (!next.includes(idx)) return
    } else if (!selection.includes(idx)) {
      next = [idx]
      onSelectionChange(next)
    }
    begin(e, 'move', next.map((i) => all[i]).filter(Boolean), { clicked: idx })
  }

  const onHandleDown = (e: React.PointerEvent, corner: Corner) => {
    e.stopPropagation()
    e.preventDefault()
    const all = shapes()
    const els = selection.map((i) => all[i]).filter(Boolean)
    const svgEl = root()
    const ctm = svgEl?.getScreenCTM()
    if (!els.length || !ctm || !box || !stageRef.current) return
    const s = stageRef.current.getBoundingClientRect()
    const ox = corner.includes('w') ? box.x + box.width : box.x
    const oy = corner.includes('n') ? box.y + box.height : box.y
    const origin = new DOMPoint(ox + s.left, oy + s.top).matrixTransform(ctm.inverse())
    begin(e, 'resize', els, { origin })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const p = toUserPoint(d.toUser, e)
    const dx = p.x - d.start.x, dy = p.y - d.start.y
    // Ignore jitter under ~3 screen pixels so a click never nudges a shape.
    if (!d.moved && Math.hypot(dx, dy) < 3 * Math.abs(d.toUser.a)) return
    let op: DOMMatrix
    if (d.kind === 'move') {
      op = new DOMMatrix().translate(dx, dy)
    } else {
      const o = d.origin!
      const v0x = d.start.x - o.x, v0y = d.start.y - o.y
      const vx = p.x - o.x, vy = p.y - o.y
      let sx: number, sy: number
      if (e.shiftKey) {
        sx = Math.abs(v0x) > 1e-6 ? vx / v0x : 1
        sy = Math.abs(v0y) > 1e-6 ? vy / v0y : 1
      } else {
        const len = v0x * v0x + v0y * v0y
        sx = sy = len > 1e-6 ? (vx * v0x + vy * v0y) / len : 1
      }
      const clampScale = (v: number) => (Math.abs(v) < 0.02 ? (v < 0 ? -0.02 : 0.02) : v)
      op = new DOMMatrix().translate(o.x, o.y).scale(clampScale(sx), clampScale(sy)).translate(-o.x, -o.y)
    }
    d.moved = true
    d.els.forEach((el, i) => setMatrix(el, op.multiply(d.orig[i])))
    measure()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    stageRef.current?.releasePointerCapture(e.pointerId)
    const svgEl = root()
    if (d.moved && svgEl) onCommit(serialize(svgEl))
    else if (!d.moved && d.clicked !== undefined && !e.shiftKey && !e.metaKey && !e.ctrlKey && selection.length > 1) {
      onSelectionChange([d.clicked])
    }
  }

  return (
    <div
      ref={stageRef}
      className="stage editor"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={hostRef} className="svg-host" />
      {box && (
        <div className="sel-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
          {CORNERS.map((c) => (
            <span
              key={c}
              className={`handle ${c}`}
              onPointerDown={(e) => onHandleDown(e, c)}
              aria-hidden="true"
            />
          ))}
        </div>
      )}
    </div>
  )
}
