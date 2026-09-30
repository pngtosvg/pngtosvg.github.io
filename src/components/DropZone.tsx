import { useRef, useState } from 'react'
import { ImageIcon, ShieldIcon, UploadIcon } from './icons.tsx'

interface Props {
  onFile: (file: File) => void
  onSample: () => void
  error?: string
}

export function DropZone({ onFile, onSample, error }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const browse = () => input.current?.click()

  return (
    <div className="empty">
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onFile(f)
        }}
        onClick={browse}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browse() }
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose a PNG image to convert"
      >
        <div className="drop-icon"><UploadIcon width={28} height={28} /></div>
        <p className="drop-title">Drop a PNG here</p>
        <p className="muted">
          or <span className="fake-link">browse files</span> · paste with <kbd>Ctrl</kbd>+<kbd>V</kbd>
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <input
          ref={input}
          type="file"
          accept="image/png,image/webp,image/jpeg,image/gif,image/bmp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
      </div>
      <div className="drop-meta">
        <span><ShieldIcon width={15} height={15} /> Never uploaded. Converted on your device.</span>
        <button className="link-btn" onClick={onSample}>
          <ImageIcon width={15} height={15} /> Try a sample
        </button>
      </div>
    </div>
  )
}
