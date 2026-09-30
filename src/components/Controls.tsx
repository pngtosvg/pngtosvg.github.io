import { useState } from 'react'
import { PRESETS, settingsForPreset, type TraceSettings } from '../lib/presets.ts'
import { SlidersIcon } from './icons.tsx'

interface Props {
  settings: TraceSettings
  onChange: (settings: TraceSettings) => void
}

export function Controls({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const set = <K extends keyof TraceSettings>(key: K, value: TraceSettings[K]) => onChange({ ...settings, [key]: value })
  const preset = PRESETS.find((p) => p.id === settings.preset)!
  const customized = (Object.keys(preset.defaults) as (keyof typeof preset.defaults)[]).some(
    (k) => preset.defaults[k] !== settings[k],
  )

  return (
    <div className="controls">
      <div className="control-row">
        <div className="segmented" role="radiogroup" aria-label="Preset">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={settings.preset === p.id}
              className={settings.preset === p.id ? 'on' : ''}
              onClick={() => onChange(settingsForPreset(p.id, settings))}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="preset-hint muted small">{customized ? 'Custom settings' : preset.hint}</span>
        <button
          className={`btn ghost ${open ? 'on' : ''}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="adjust-panel"
        >
          <SlidersIcon /> Adjust
        </button>
      </div>
      {open && (
        <div className="adjust" id="adjust-panel">
          <Slider label="Colors" min={1} max={64} value={settings.colors} onChange={(v) => set('colors', v)} />
          <Slider label="Detail" min={0} max={100} value={settings.detail} onChange={(v) => set('detail', v)} />
          <Slider label="Smoothness" min={0} max={100} value={settings.smoothness} onChange={(v) => set('smoothness', v)} />
          <div className="toggles">
            <Toggle
              label="Trim transparent edges"
              checked={settings.cropTransparent}
              onChange={(v) => set('cropTransparent', v)}
            />
            <Toggle
              label="Remove solid background"
              checked={settings.removeBackground}
              onChange={(v) => set('removeBackground', v)}
            />
            <label className="select-field">
              <span>Layers</span>
              <select value={settings.layering} onChange={(e) => set('layering', e.target.value as TraceSettings['layering'])}>
                <option value="separate">Separate shapes (easy editing)</option>
                <option value="stacked">Stacked (smallest file)</option>
              </select>
            </label>
            {customized && (
              <button className="link-btn" onClick={() => onChange(settingsForPreset(settings.preset, settings))}>
                Reset to preset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Slider(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span className="slider-label">
        {props.label} <output>{props.value}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      {props.label}
    </label>
  )
}
