import { useState } from 'react'
import { formatBytes } from '../lib/image.ts'
import { CheckIcon, CopyIcon, DownloadIcon } from './icons.tsx'

interface Props {
  pngBytes: number
  rawBytes: number
  optimizedBytes: number | null
  disabled: boolean
  onCopy: () => Promise<void>
  onDownload: () => Promise<void>
}

export function ExportBar({ pngBytes, rawBytes, optimizedBytes, disabled, onCopy, onDownload }: Props) {
  const [copied, setCopied] = useState(false)
  const saved = optimizedBytes !== null && rawBytes > 0 ? Math.round((1 - optimizedBytes / rawBytes) * 100) : null

  return (
    <div className="export-bar">
      <dl className="sizes">
        <div>
          <dt>PNG</dt>
          <dd>{formatBytes(pngBytes)}</dd>
        </div>
        <div>
          <dt>SVG raw</dt>
          <dd>{rawBytes ? formatBytes(rawBytes) : '—'}</dd>
        </div>
        <div className="optimized">
          <dt>Optimized</dt>
          <dd>
            {optimizedBytes !== null ? formatBytes(optimizedBytes) : '…'}
            {saved !== null && saved > 0 && <span className="badge">−{saved}%</span>}
          </dd>
        </div>
      </dl>
      <div className="export-actions">
        <button
          className="btn"
          disabled={disabled}
          onClick={async () => {
            await onCopy()
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy SVG'}
        </button>
        <button className="btn primary" disabled={disabled} onClick={onDownload}>
          <DownloadIcon /> Download SVG
        </button>
      </div>
    </div>
  )
}
