export type PresetId = 'logo' | 'icon' | 'smooth' | 'detailed'

export interface TraceSettings {
  preset: PresetId
  /** Maximum number of colors (layers) in the output. */
  colors: number
  /** 0–100: how small a detail is kept. */
  detail: number
  /** 0–100: 0 keeps sharp corners (polygons), 100 gives flowing curves. */
  smoothness: number
  cropTransparent: boolean
  removeBackground: boolean
  /** With removeBackground: also clear areas of the background color that the artwork encloses (letter counters, the inside of rings). */
  clearEnclosed: boolean
  /** "separate": every color is its own shape (best for editing). "stacked": lower colors fill in under upper ones (smallest file). */
  layering: 'separate' | 'stacked'
  /** Turn smooth color transitions into SVG gradients instead of bands of flat color. */
  gradients: boolean
}

export interface Preset {
  id: PresetId
  label: string
  hint: string
  defaults: Pick<TraceSettings, 'colors' | 'detail' | 'smoothness' | 'layering'>
  /** OKLab distance under which colors are merged. */
  mergeDistance: number
  /** Minimum share of opaque pixels for a color to get its own layer. */
  minShare: number
  /** Flat-color artwork: drop anti-aliasing blend colors. */
  flat: boolean
  /** Images larger than this are downscaled to keep tracing fast. */
  maxWorkSize: number
}

export const PRESETS: Preset[] = [
  {
    id: 'logo',
    flat: true,
    label: 'Logo',
    hint: 'Flat colors, crisp edges',
    defaults: { colors: 8, detail: 60, smoothness: 25, layering: 'separate' },
    mergeDistance: 0.07,
    minShare: 0.002,
    maxWorkSize: 2000,
  },
  {
    id: 'icon',
    flat: true,
    label: 'Icon',
    hint: 'Few colors, minimal paths',
    defaults: { colors: 4, detail: 50, smoothness: 20, layering: 'separate' },
    mergeDistance: 0.09,
    minShare: 0.004,
    maxWorkSize: 1200,
  },
  {
    id: 'smooth',
    flat: false,
    label: 'Smooth',
    hint: 'Soft curves, cleaner shapes',
    defaults: { colors: 12, detail: 35, smoothness: 70, layering: 'stacked' },
    mergeDistance: 0.05,
    minShare: 0.001,
    maxWorkSize: 1600,
  },
  {
    id: 'detailed',
    flat: false,
    label: 'Detailed',
    hint: 'More colors and fine detail',
    defaults: { colors: 32, detail: 85, smoothness: 35, layering: 'stacked' },
    mergeDistance: 0.025,
    minShare: 0.0002,
    maxWorkSize: 1600,
  },
]

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]
}

export function settingsForPreset(id: PresetId, keep?: Partial<TraceSettings>): TraceSettings {
  const p = getPreset(id)
  return {
    preset: id,
    cropTransparent: keep?.cropTransparent ?? true,
    removeBackground: keep?.removeBackground ?? false,
    clearEnclosed: keep?.clearEnclosed ?? false,
    gradients: keep?.gradients ?? true,
    ...p.defaults,
  }
}

export const DEFAULT_SETTINGS = settingsForPreset('logo')
