/** In-place [1 2 1]/4 blur in both directions (edges clamped). `tmp` is scratch space of the same size. */
export function blur121(f: Float32Array, w: number, h: number, tmp = new Float32Array(f.length)) {
  if (w > 1) {
    for (let y = 0; y < h; y++) {
      const row = y * w, end = row + w - 1
      tmp[row] = (3 * f[row] + f[row + 1]) / 4
      for (let p = row + 1; p < end; p++) tmp[p] = (f[p - 1] + 2 * f[p] + f[p + 1]) / 4
      tmp[end] = (f[end - 1] + 3 * f[end]) / 4
    }
  } else tmp.set(f)
  if (h > 1) {
    const last = (h - 1) * w
    for (let x = 0; x < w; x++) f[x] = (3 * tmp[x] + tmp[x + w]) / 4
    for (let p = w; p < last; p++) f[p] = (tmp[p - w] + 2 * tmp[p] + tmp[p + w]) / 4
    for (let p = last; p < last + w; p++) f[p] = (tmp[p - w] + 3 * tmp[p]) / 4
  } else f.set(tmp)
}
