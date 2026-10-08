import { useMemo, useState, useEffect } from 'react'
import {
  getShapes,
  gradientColorAt,
  gradientCss,
  gradientOf,
  normalizeColor,
  ownGradient,
  paintOf,
  paletteOf,
  setPaint,
  setStopColor,
  type Gradient,
} from '../lib/svgdoc.ts'
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
  const gradient = mixedFill ? null : gradientOf(doc, fill)

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

  // A gradient shared with shapes outside the selection is copied first, so only the
  // selection changes.
  const setSelectedStop = (index: number, color: string) =>
    onEdit((root, all) => {
      const els = selection.map((i) => all[i]).filter(Boolean)
      setStopColor(root, ownGradient(root, all, els, fill), index, color)
    }, `stop:${index}`)

  return (
    <aside className="inspector" aria-label="Edit SVG">
      {selected.length ? (
        <section className="panel">
          <div className="panel-title">
            Selection <span className="muted">{selected.length === 1 ? '1 shape' : `${selected.length} shapes`}</span>
          </div>
          <div className="field">
            <span className="field-label">Fill</span>
            {gradient ? (
              <GradientField gradient={gradient} onStopChange={setSelectedStop} />
            ) : (
              <ColorField
                value={fill}
                mixed={mixedFill}
                onChange={(c) => editSelected((el) => setPaint(el, 'fill', c), 'fill')}
              />
            )}
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
            <div className="links">
              <button className="link-btn" onClick={() => selectColor(fill)}>
                {gradient ? 'Select same gradient' : 'Select same color'}
              </button>
              {gradient && (
                <button
                  className="link-btn"
                  onClick={() => editSelected((el) => setPaint(el, 'fill', gradientColorAt(gradient, 0.5)), 'fill')}
                  title="Replace the gradient with its middle color"
                >
                  Make solid
                </button>
              )}
            </div>
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
          {palette.map(({ color, count }, i) => {
            const g = gradientOf(doc, color)
            return (
              <li key={i}>
                {g ? (
                  <GradientField
                    gradient={g}
                    compact
                    onStopChange={(k, c) => onEdit((root) => setStopColor(root, color, k, c), `stop:${i}:${k}`)}
                  />
                ) : (
                  <ColorField value={color} compact onChange={(c) => recolor(i, color, c)} />
                )}
                <button className="palette-name" onClick={() => selectColor(color)} title="Select shapes with this fill">
                  <code>{g ? `${g.type} gradient` : color}</code>
                  <span className="muted">{count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </aside>
  )
}

function defaultStroke(size: number) {
  return Math.max(1, Math.round(size / 150))
}

/** A gradient as a bar, with a color picker at each stop. */
function GradientField(props: { gradient: Gradient; compact?: boolean; onStopChange: (index: number, color: string) => void }) {
  const { gradient, compact } = props
  const n = gradient.stops.length
  return (
    <span
      className={`gradient-field ${compact ? 'compact' : ''}`}
      style={{ background: gradientCss(gradient) }}
      title={`${gradient.type === 'linear' ? 'Linear' : 'Radial'} gradient`}
    >
      {gradient.stops.map((s, k) => (
        <label
          key={k}
          className="stop"
          style={{ left: `calc(9px + (100% - 18px) * ${s.offset})`, background: s.color }}
          title={`Stop ${k + 1}: ${s.color}`}
        >
          <input
            type="color"
            aria-label={`Gradient stop ${k + 1} of ${n}`}
            value={s.color}
            onChange={(e) => props.onStopChange(k, e.target.value)}
          />
        </label>
      ))}
    </span>
  )
}

interface ColorFieldProps {
  value: string
  mixed?: boolean
  compact?: boolean
  /** Accessible name of the color picker. */
  label?: string
  onChange: (color: string) => void
}

function ColorField({ value, mixed, compact, label = 'Pick color', onChange }: ColorFieldProps) {
  const isColor = /^#[0-9a-f]{6}$/.test(value)
  const none = value === 'none'
  const shown = mixed || !isColor ? '' : value
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
      <label className={`swatch ${none ? 'none' : ''}`} style={isColor ? { background: value } : undefined} title={label}>
        <input type="color" aria-label={label} value={isColor ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
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
