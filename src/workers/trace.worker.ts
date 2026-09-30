/// <reference lib="webworker" />
import type { TraceSettings } from '../lib/presets.ts'
import type { Bitmap } from '../lib/raster.ts'
import { traceImage } from '../lib/vectorize.ts'

export type TraceRequest = { id: number; bitmap: Bitmap; settings: TraceSettings; scale?: number }

self.onmessage = (e: MessageEvent<TraceRequest>) => {
  const { id, bitmap, settings, scale } = e.data
  try {
    const result = traceImage(bitmap, settings, (value) => self.postMessage({ id, type: 'progress', value }), scale)
    self.postMessage({ id, type: 'done', result })
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
