import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Controls } from './components/Controls.tsx'
import { DropZone } from './components/DropZone.tsx'
import { ExportBar } from './components/ExportBar.tsx'
import { Inspector, type Edit } from './components/Inspector.tsx'
import { SvgEditor } from './components/SvgEditor.tsx'
import { CloseIcon, FitIcon, RedoIcon, UndoIcon, UploadIcon, ZoomInIcon, ZoomOutIcon } from './components/icons.tsx'
import { baseName, byteLength, formatBytes, loadImage, type LoadedImage } from './lib/image.ts'
import type { OptimizeResult } from './lib/optimize.ts'
import { DEFAULT_SETTINGS, type TraceSettings } from './lib/presets.ts'
import { hasSolidBackground } from './lib/raster.ts'
import { editSvg, matrixOf, setMatrix, SHAPE_SELECTOR } from './lib/svgdoc.ts'
import type { TraceResult } from './lib/vectorize.ts'
import { useHistory } from './lib/useHistory.ts'
import { Cancelled, optimizer, tracer } from './lib/workers.ts'

type Backdrop = 'checker' | 'light' | 'dark'

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Stage size = "fit" box (by aspect ratio) times zoom; see `.stage` in styles.css. */
const paneVars = (aspect: number, zoom: number) => ({ '--aspect': aspect, '--zoom': zoom }) as CSSProperties

export function App() {
  const [image, setImage] = useState<LoadedImage | null>(null)
  const [settings, setSettings] = useState<TraceSettings>(DEFAULT_SETTINGS)
  const [loadError, setLoadError] = useState<string>()
  const [tracing, setTracing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [traceError, setTraceError] = useState<string>()
  const [info, setInfo] = useState<(TraceResult & { ms: number }) | null>(null)
  const [selection, setSelection] = useState<number[]>([])
  const [optimized, setOptimized] = useState<(OptimizeResult & { source: string }) | null>(null)
  const [zoom, setZoom] = useState(1)
  const [backdrop, setBackdrop] = useState<Backdrop>('checker')
  const [dragOver, setDragOver] = useState(false)
  const history = useHistory<string>()
  const svg = history.present
  const { push } = history
  const rawBytes = useMemo(() => (svg ? byteLength(svg) : 0), [svg])
  const solidBackground = useMemo(() => (image ? hasSolidBackground(image.bitmap) : false), [image])

  // ---- Loading -------------------------------------------------------------------------

  const openFile = useCallback(async (file: Blob, name?: string) => {
    setLoadError(undefined)
    try {
      const img = await loadImage(file, name ?? (file instanceof File ? file.name : 'pasted-image.png'))
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return img
      })
      history.reset()
      setSelection([])
      setOptimized(null)
      setInfo(null)
      setZoom(1)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not open that image.')
    }
  }, [history.reset])

  const openSample = async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/sample-logo.png`)
    await openFile(await res.blob(), 'sample-logo.png')
  }

  const closeImage = () => {
    if (image) URL.revokeObjectURL(image.url)
    setImage(null)
    history.reset()
    setInfo(null)
    setOptimized(null)
    setSelection([])
  }

  // Paste from clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) {
        e.preventDefault()
        openFile(file, file.name && file.name !== 'image.png' ? file.name : 'pasted-image.png')
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [openFile])

  // ---- Tracing (Web Worker) ------------------------------------------------------------

  useEffect(() => {
    if (!image) return
    let alive = true
    const timer = setTimeout(async () => {
      setTracing(true)
      setTraceError(undefined)
      setProgress(0)
      const t0 = performance.now()
      try {
        const result = await tracer.run({ bitmap: image.bitmap, settings }, (v) => alive && setProgress(v))
        if (!alive) return
        setInfo({ ...result, ms: performance.now() - t0 })
        setSelection([])
        push(result.svg)
        setTracing(false)
      } catch (e) {
        if (e instanceof Cancelled || !alive) return
        setTraceError(e instanceof Error ? e.message : 'Conversion failed.')
        setTracing(false)
      }
    }, 120)
    return () => {
      // Settings changed or the image was closed: the running trace is stale.
      alive = false
      clearTimeout(timer)
      tracer.cancel()
      setTracing(false)
    }
  }, [image, settings, push])

  // ---- Optimization (Web Worker, debounced) ---------------------------------------------

  useEffect(() => {
    if (!svg) return
    let alive = true
    const timer = setTimeout(() => {
      optimizer
        .run({ svg })
        .then((r) => alive && setOptimized({ ...r, source: svg }))
        .catch(() => {})
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [svg])

  const getOptimized = async (): Promise<string> => {
    if (!svg) return ''
    if (optimized?.source === svg) return optimized.svg
    try {
      const r = await optimizer.run({ svg })
      setOptimized({ ...r, source: svg })
      return r.svg
    } catch {
      return svg
    }
  }

  const download = async () => {
    const out = await getOptimized()
    const url = URL.createObjectURL(new Blob([out], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName(image?.name ?? 'image')}.svg`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const copy = async () => {
    const out = await getOptimized()
    try {
      await navigator.clipboard.writeText(out)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = out
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
  }

  // ---- Editing ---------------------------------------------------------------------------

  const applyEdit = useCallback(
    (fn: Edit, coalesce?: string) => {
      if (svg) push(editSvg(svg, fn), coalesce)
    },
    [svg, push],
  )

  const deleteSelection = useCallback(() => {
    if (!selection.length) return
    applyEdit((_, shapes) => selection.forEach((i) => shapes[i]?.remove()))
    setSelection([])
  }, [selection, applyEdit])

  const duplicateSelection = useCallback(() => {
    if (!selection.length) return
    const sorted = [...selection].sort((a, b) => a - b)
    applyEdit((root, shapes) => {
      const offset = Math.max(1, (root.viewBox.baseVal?.width || 100) / 50)
      let anchor: Element = shapes[sorted[sorted.length - 1]]
      for (const i of sorted) {
        const copy = shapes[i].cloneNode(true) as SVGGraphicsElement
        anchor.after(copy)
        anchor = copy
        setMatrix(copy, new DOMMatrix().translate(offset, offset).multiply(matrixOf(copy)))
      }
    })
    // The copies land right after the last selected shape, in the same order.
    const last = sorted[sorted.length - 1]
    setSelection(sorted.map((_, k) => last + 1 + k))
  }, [selection, applyEdit])

  const reorder = useCallback(
    (where: 'front' | 'back') => {
      if (!selection.length) return
      const sorted = [...selection].sort((a, b) => a - b)
      let count = 0
      applyEdit((root, shapes) => {
        count = shapes.length
        const els = sorted.map((i) => shapes[i])
        els.forEach((el) => el.remove())
        const first = root.querySelector(SHAPE_SELECTOR)
        els.forEach((el) => (where === 'front' ? root.appendChild(el) : root.insertBefore(el, first)))
      })
      setSelection(sorted.map((_, k) => (where === 'front' ? count - sorted.length + k : k)))
    },
    [selection, applyEdit],
  )

  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!selection.length) return
      applyEdit(
        (_, shapes) =>
          selection.forEach((i) => {
            const el = shapes[i]
            if (el) setMatrix(el, new DOMMatrix().translate(dx, dy).multiply(matrixOf(el)))
          }),
        'nudge',
      )
    },
    [selection, applyEdit],
  )

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if (!svg) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); setSelection([]) }
      else if (mod && k === 'y') { e.preventDefault(); history.redo(); setSelection([]) }
      else if (mod && k === 'd') { e.preventDefault(); duplicateSelection() }
      else if (mod && k === 'a') {
        e.preventDefault()
        const n = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll(SHAPE_SELECTOR).length
        setSelection([...Array(n).keys()])
      }
      else if (k === 'delete' || k === 'backspace') { if (selection.length) { e.preventDefault(); deleteSelection() } }
      else if (k === 'escape') setSelection([])
      else if (k.startsWith('arrow') && selection.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [svg, selection, history.undo, history.redo, deleteSelection, duplicateSelection, nudge])

  // ---- Drop anywhere on the tool -------------------------------------------------------

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!image || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!image) return
      e.preventDefault()
      setDragOver(false)
      const f = e.dataTransfer.files[0]
      if (f) openFile(f)
    },
  }

  const zoomBy = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-6)
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))])
  }

  if (!image) {
    return <DropZone onFile={(f) => openFile(f)} onSample={openSample} error={loadError} />
  }

  const view = info?.crop ?? { x: 0, y: 0, width: image.bitmap.width, height: image.bitmap.height }
  const trimmed = view.width !== image.bitmap.width || view.height !== image.bitmap.height

  return (
    <div className={`workspace ${dragOver ? 'drag-over' : ''}`} {...dropProps}>
      <div className="topbar">
        <Controls settings={settings} onChange={setSettings} solidBackground={solidBackground} />
        <div className="file-chip" title={image.name}>
          <span className="file-name">{image.name}</span>
          <span className="muted small">
            {image.width}×{image.height}
          </span>
          <label className="icon-btn" title="Open another image">
            <UploadIcon />
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg,image/gif,image/bmp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) openFile(f)
                e.target.value = ''
              }}
            />
          </label>
          <button className="icon-btn" onClick={closeImage} title="Close image" aria-label="Close image">
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="main">
        <div className="canvas-col">
          <div className="compare">
            <figure className="pane">
              <figcaption>
                <span>PNG input</span>
                <span className="muted small">
                  {trimmed ? 'trimmed view · ' : ''}
                  {formatBytes(image.bytes)}
                </span>
              </figcaption>
              <div className={`viewport bg-${backdrop}`} style={paneVars(view.width / view.height, zoom)}>
                <div className="stage crop">
                  {/* Show the same (trimmed) region as the SVG so both sides line up. */}
                  <img
                    src={image.url}
                    alt="Original PNG"
                    draggable={false}
                    style={{
                      width: `${(image.bitmap.width / view.width) * 100}%`,
                      marginLeft: `${(-view.x / view.width) * 100}%`,
                      marginTop: `${(-view.y / view.width) * 100}%`,
                    }}
                  />
                </div>
              </div>
            </figure>

            <figure className="pane">
              <figcaption>
                <span>SVG output</span>
                <span className="muted small">
                  {info ? `${plural(info.colors.length, 'color')} · ${plural(info.paths, 'path')} · ${Math.round(info.ms)} ms` : ''}
                </span>
              </figcaption>
              <div
                className={`viewport bg-${backdrop}`}
                style={paneVars(view.width / view.height, zoom)}
              >
                {svg && (
                  <SvgEditor
                    svg={svg}
                    selection={selection}
                    zoom={zoom}
                    onSelectionChange={setSelection}
                    onCommit={(s) => push(s)}
                  />
                )}
                {tracing && (
                  <div className="progress" role="status" aria-live="polite">
                    <div className="progress-bar" style={{ transform: `scaleX(${Math.max(0.04, progress)})` }} />
                    <span>Vectorizing… {Math.round(progress * 100)}%</span>
                  </div>
                )}
                {traceError && <p className="error overlay-msg">{traceError}</p>}
              </div>
            </figure>
          </div>
          <div className="viewbar">
            <div className="btn-group">
              <button className="icon-btn" onClick={() => { history.undo(); setSelection([]) }} disabled={!history.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
                <UndoIcon />
              </button>
              <button className="icon-btn" onClick={() => { history.redo(); setSelection([]) }} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
                <RedoIcon />
              </button>
            </div>
            <div className="btn-group">
              <button className="icon-btn" onClick={() => zoomBy(-1)} title="Zoom out" aria-label="Zoom out"><ZoomOutIcon /></button>
              <button className="zoom-level" onClick={() => setZoom(1)} title="Fit to view">
                {zoom === 1 ? <FitIcon /> : `${Math.round(zoom * 100)}%`}
              </button>
              <button className="icon-btn" onClick={() => zoomBy(1)} title="Zoom in" aria-label="Zoom in"><ZoomInIcon /></button>
            </div>
            <div className="btn-group backdrops" role="radiogroup" aria-label="Preview background">
              {(['checker', 'light', 'dark'] as Backdrop[]).map((b) => (
                <button
                  key={b}
                  role="radio"
                  aria-checked={backdrop === b}
                  className={`backdrop-btn bg-${b} ${backdrop === b ? 'on' : ''}`}
                  onClick={() => setBackdrop(b)}
                  title={`${b[0].toUpperCase()}${b.slice(1)} background`}
                />
              ))}
            </div>
          </div>
        </div>

        {svg && (
          <Inspector
            svg={svg}
            selection={selection}
            onEdit={applyEdit}
            onSelectionChange={setSelection}
            onDelete={deleteSelection}
            onDuplicate={duplicateSelection}
            onReorder={reorder}
          />
        )}
      </div>

      <ExportBar
        pngBytes={image.bytes}
        rawBytes={rawBytes}
        optimizedBytes={optimized?.source === svg ? optimized.bytes : null}
        disabled={!svg}
        onCopy={copy}
        onDownload={download}
      />
      {dragOver && <div className="drop-overlay">Drop to convert</div>}
    </div>
  )
}
