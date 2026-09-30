import type { OptimizeResult } from './optimize.ts'
import type { TraceSettings } from './presets.ts'
import type { Bitmap } from './raster.ts'
import type { TraceResult } from './vectorize.ts'

type Reply<T> =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'done'; result: T }
  | { id: number; type: 'error'; message: string }

export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * Runs one job at a time in a dedicated worker. Starting a new job while another is
 * running terminates the stale worker, so the latest settings always win quickly
 * instead of queueing behind a slow trace.
 */
class LatestJobWorker<Req, Res> {
  private worker?: Worker
  private seq = 0
  private pending?: { id: number; reject: (e: Error) => void }

  constructor(private create: () => Worker) {}

  /** Stops the running job, if any (its promise rejects with Cancelled). */
  cancel() {
    if (!this.pending) return
    this.pending.reject(new Cancelled())
    this.pending = undefined
    this.worker?.terminate()
    this.worker = undefined
  }

  run(payload: Req, onProgress?: (value: number) => void): Promise<Res> {
    this.cancel()
    const worker = (this.worker ??= this.create())
    const id = ++this.seq
    return new Promise<Res>((resolve, reject) => {
      this.pending = { id, reject }
      worker.onmessage = (e: MessageEvent<Reply<Res>>) => {
        const msg = e.data
        if (msg.id !== id) return
        if (msg.type === 'progress') { onProgress?.(msg.value); return }
        this.pending = undefined
        if (msg.type === 'done') { resolve(msg.result); return }
        // Start the next job on a fresh worker rather than one in an unknown state.
        worker.terminate()
        if (this.worker === worker) this.worker = undefined
        reject(new Error(msg.message))
      }
      worker.onerror = (e) => {
        this.pending = undefined
        if (this.worker === worker) this.worker = undefined
        worker.terminate()
        reject(new Error(e.message || 'Worker failed'))
      }
      worker.postMessage({ id, ...payload })
    })
  }
}

export const tracer = new LatestJobWorker<{ bitmap: Bitmap; settings: TraceSettings; scale: number }, TraceResult>(
  () => new Worker(new URL('../workers/trace.worker.ts', import.meta.url), { type: 'module' }),
)

const optimizeWorker = () => new Worker(new URL('../workers/optimize.worker.ts', import.meta.url), { type: 'module' })

/** Keeps the size readout current while editing (each edit supersedes the last). */
export const optimizer = new LatestJobWorker<{ svg: string }, OptimizeResult>(optimizeWorker)

/** Download/Copy get their own worker, so a background re-optimization can't cancel them. */
export const exporter = new LatestJobWorker<{ svg: string }, OptimizeResult>(optimizeWorker)
