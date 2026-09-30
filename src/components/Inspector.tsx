import { useMemo, useState, useEffect } from 'react'
import { getShapes, normalizeColor, paintOf, paletteOf, setPaint } from '../lib/svgdoc.ts'
import { BackIcon, DuplicateIcon, FrontIcon, TrashIcon } from './icons.tsx'

export type Edit = (root: SVGSVGElement, shapes: SVGGraphicsElement[]) => void

interface Props {
  svg: string
  selection: number[]
  onEdit: (fn: Edit, coalesce?: string) => void
  onSelectionChange: (selection: number[]) => void
  onDelete: () => void
  onDuplicate: () => void
  onReorder: (where: 'front' | 'back') => void
}

export function Inspector({ svg, selection, onEdit, onSelectionChange, onDelete, onDuplicate, onReorder }: Props) {
  const doc = useMemo(() => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, [svg])
  const shapes = useMemo(() => getShapes(doc), [doc])
  const palette = useMemo(() => paletteOf(doc), [doc])
  const selected = selection.map((i) => shapes[i]).filter(Boolean)
  const size = useMemo(() => {
    const vb = doc.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
    return vb && vb.length === 4 ? Math.max(vb[2], vb[3]) : 512
  }, [doc])

  const first = selected[0]
  const fill = first ? paintOf(first, 'fill') : 'none'
  const stroke = first ? paintOf(first, 'stroke') : 'none'
  const strokeWidth = first ? parseFloat(first.getAttribute('stroke-width') ?? '1') || 1 : 1
  const mixedFill = selected.some((el) => paintOf(el, 'fill') !== fill)

  const editSelected = (fn: (el: Element) => void, key: string) =>
    onEdit((_, all) => selection.forEach((i) => all[i] && fn(all[i])), key)

  const setStroke = (color: string, width = strokeWidth) =>
    editSelected((el) => {
      if (color === 'none') {
        setPaint(el, 'stroke', 'none')
        el.removeAttribute('stroke-width')
        el.removeAttribute('stroke-linejoin')
        return
      }
      setPaint(el, 'stroke', color)
      el.setAttribute('stroke-width', String(width))
      el.setAttribute('stroke-linejoin', 'round')
    }, 'stroke')

  const selectColor = (color: string) =>
    onSelectionChange(shapes.flatMap((el, i) => (paintOf(el, 'fill') === color ? [i] : [])))

  // Keyed by palette position, not color: while a picker is dragged the color changes on
  // every step, but it must stay the same row (and one undo step).
  const recolor = (slot: number, from: string, to: string) =>
    onEdit((_, all) => all.forEach((el) => paintOf(el, 'fill') === from && setPaint(el, 'fill', to)), `recolor:${slot}`)

  return (
    <aside className="inspector" aria-label="Edit SVG">
      {selected.length ? (
        <section className="panel">
          <div className="panel-title">
            Selection <span className="muted">{selected.length === 1 ? '1 shape' : `${selected.length} shapes`}</span>
          </div>
          <div className="field">
            <span className="field-label">Fill</span>
            <ColorField
              value={fill}
              mixed={mixedFill}
              onChange={(c) => editSelected((el) => setPaint(el, 'fill', c), 'fill')}
            />
            <button
              className={`chip ${fill === 'none' ? 'on' : ''}`}
              onClick={() => editSelected((el) => setPaint(el, 'fill', fill === 'none' ? '#000000' : 'none'), 'fill-none')}
              title="No fill"
            >
              None
            </button>
          </div>
          <div className="field">
            <span className="field-label">Stroke</span>
            <ColorField value={stroke} onChange={(c) => setStroke(c, stroke === 'none' ? defaultStroke(size) : strokeWidth)} />
            <input
              className="num"
              type="number"
              min={0}
              step={0.5}
              value={stroke === 'none' ? 0 : strokeWidth}
              aria-label="Stroke width"
              onChange={(e) => {
                const w = parseFloat(e.target.value)
                if (!w || w <= 0) setStroke('none')
                else setStroke(stroke === 'none' ? '#000000' : stroke, w)
              }}
            />
          </div>
          <div className="actions">
            <button className="icon-btn" onClick={() => onReorder('front')} title="Bring to front"><FrontIcon /></button>
            <button className="icon-btn" onClick={() => onReorder('back')} title="Send to back"><BackIcon /></button>
            <button className="icon-btn" onClick={onDuplicate} title="Duplicate (Ctrl+D)"><DuplicateIcon /></button>
            <button className="icon-btn danger" onClick={onDelete} title="Delete (Del)"><TrashIcon /></button>
          </div>
          {fill !== 'none' && !mixedFill && (
            <button className="link-btn" onClick={() => selectColor(fill)}>Select same color</button>
          )}
        </section>
      ) : (
        <section className="panel hint-panel">
          <div className="panel-title">Edit</div>
          <p className="muted small">
            Click a shape to select it, <kbd>Shift</kbd>-click to add more. Drag to move, pull a corner to resize
            (<kbd>Shift</kbd> for free aspect). Arrow keys nudge, <kbd>Del</kbd> removes.
          </p>
        </section>
      )}
      <section className="panel">
        <div className="panel-title">
          Colors <span className="muted">{palette.length}</span>
        </div>
        <ul className="palette">
          {palette.map(({ color, count }, i) => (
            <li key={i}>
              <ColorField value={color} compact onChange={(c) => recolor(i, color, c)} />
              <button className="palette-name" onClick={() => selectColor(color)} title="Select shapes with this color">
                <code>{color}</code>
                <span className="muted">{count}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}

function defaultStroke(size: number) {
  return Math.max(1, Math.round(size / 150))
}

interface ColorFieldProps {
  value: string
  mixed?: boolean
  compact?: boolean
  onChange: (color: string) => void
}

function ColorField({ value, mixed, compact, onChange }: ColorFieldProps) {
  const none = value === 'none'
  const shown = mixed || none ? '' : value
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commitText = () => {
    const v = text.trim()
    if (!v) { setText(shown); return }
    const c = normalizeColor(/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? '#' + v : v)
    if (/^#[0-9a-f]{6}$/.test(c)) { if (c !== value) onChange(c); setText(c) }
    else setText(shown)
  }
  return (
    <span className={`color-field ${compact ? 'compact' : ''}`}>
      <label className={`swatch ${none ? 'none' : ''}`} style={none ? undefined : { background: value }} title="Pick color">
        <input type="color" value={none ? '#000000' : value} onChange={(e) => onChange(e.target.value)} />
      </label>
      {!compact && (
        <input
          className="hex"
          value={text}
          placeholder={mixed ? 'Mixed' : none ? 'None' : ''}
          spellCheck={false}
          aria-label="Hex color"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
    </span>
  )
}
