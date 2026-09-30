import { useCallback, useRef, useState } from 'react'

const LIMIT = 80

interface State<T> {
  past: T[]
  present: T | null
  future: T[]
}

/** Snapshot-based undo/redo: every committed edit stores the whole document. */
export function useHistory<T>() {
  const [s, setS] = useState<State<T>>({ past: [], present: null, future: [] })

  const last = useRef<{ key?: string; at: number }>({ at: 0 })

  /**
   * Records a new state. Pushes sharing a `coalesce` key within a moment of each other
   * (e.g. dragging through a color picker) collapse into a single undo step.
   */
  const push = useCallback((value: T, coalesce?: string) => {
    const now = Date.now()
    const merge = coalesce !== undefined && last.current.key === coalesce && now - last.current.at < 1500
    last.current = { key: coalesce, at: now }
    setS((prev) => {
      if (prev.present === value) return prev
      if (merge && prev.present !== null) return { ...prev, present: value, future: [] }
      const past = prev.present === null ? prev.past : [...prev.past, prev.present].slice(-LIMIT)
      return { past, present: value, future: [] }
    })
  }, [])

  const undo = useCallback(() => {
    last.current = { at: 0 }
    setS((prev) => {
      if (!prev.past.length) return prev
      const present = prev.past[prev.past.length - 1]
      return { past: prev.past.slice(0, -1), present, future: prev.present === null ? prev.future : [prev.present, ...prev.future] }
    })
  }, [])

  const redo = useCallback(() => {
    last.current = { at: 0 }
    setS((prev) => {
      if (!prev.future.length) return prev
      const [present, ...future] = prev.future
      return { past: prev.present === null ? prev.past : [...prev.past, prev.present], present, future }
    })
  }, [])

  const reset = useCallback(() => setS({ past: [], present: null, future: [] }), [])

  return { present: s.present, push, undo, redo, reset, canUndo: s.past.length > 0, canRedo: s.future.length > 0 }
}
