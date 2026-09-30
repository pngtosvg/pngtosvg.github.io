/// <reference lib="webworker" />
import { optimizeSvg } from '../lib/optimize.ts'

self.onmessage = (e: MessageEvent<{ id: number; svg: string }>) => {
  const { id, svg } = e.data
  try {
    self.postMessage({ id, type: 'done', result: optimizeSvg(svg) })
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
