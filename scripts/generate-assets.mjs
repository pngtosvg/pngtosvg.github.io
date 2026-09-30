// Renders the static PNG assets in public/ (icons, social preview, sample image).
// Run with: node scripts/generate-assets.mjs
import fs from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const out = (p) => new URL(`../public/${p}`, import.meta.url)
const render = (svg, width, file, background) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background, font: { loadSystemFonts: true } })
    .render()
    .asPng()
  fs.writeFileSync(out(file), png)
}

const favicon = fs.readFileSync(out('favicon.svg'), 'utf8')
render(favicon, 32, 'favicon-32.png')
render(favicon.replace('rx="8"', 'rx="0"'), 180, 'apple-touch-icon.png')
render(favicon, 192, 'icon-192.png')
render(favicon.replace('rx="8"', 'rx="0"'), 512, 'icon-512.png')

// Sample for "Try a sample": a flat, transparent logo, the typical use case.
const sample = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">
  <circle cx="240" cy="240" r="200" fill="#0f766e"/>
  <path d="M240 96c-58 64-92 112-92 160a92 92 0 0 0 184 0c0-48-34-96-92-160Z" fill="#fef3c7"/>
  <path d="M240 190c-26 32-40 56-40 78a40 40 0 0 0 80 0c0-22-14-46-40-78Z" fill="#f59e0b"/>
  <rect x="120" y="376" width="240" height="22" rx="11" fill="#fef3c7"/>
</svg>`
render(sample, 480, 'samples/sample-logo.png')

// Social preview (1200×630).
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="c" width="24" height="24" patternUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="#ffffff"/><rect width="12" height="12" fill="#eceef2"/><rect x="12" y="12" width="12" height="12" fill="#eceef2"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="#f6f7f9"/>
  <g transform="translate(80 92)">
    <rect width="64" height="64" rx="16" fill="#4f46e5"/>
    <g transform="scale(2)"><path d="M8 22.5c3.5-9 6.5-13 9-13 3 0 1.5 7 4.5 7 1.4 0 2.4-1.2 3-2.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="8" cy="22.5" r="2.2" fill="#fff"/><circle cx="24.5" cy="14" r="2.2" fill="#fff"/></g>
    <text x="84" y="46" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="38" fill="#101828">PNG<tspan fill="#667085" font-weight="400">to</tspan>SVG</text>
  </g>
  <text x="80" y="268" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="64" fill="#101828" letter-spacing="-1.5">PNG to SVG</text>
  <text x="80" y="344" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="64" fill="#4f46e5" letter-spacing="-1.5">Converter</text>
  <text x="80" y="420" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" fill="#475467">Transparent logos &amp; icons → clean,</text>
  <text x="80" y="458" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" fill="#475467">editable vectors. Free and private.</text>
  <g transform="translate(80 510)">
    <rect width="300" height="46" rx="23" fill="#ecfdf3"/>
    <text x="150" y="31" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="20" fill="#067647">100% in your browser</text>
  </g>
  <g transform="translate(700 115)">
    <rect width="400" height="400" rx="24" fill="url(#c)" stroke="#d0d5dd"/>
    <g transform="translate(40 40) scale(0.6667)">${sample.replace(/<\/?svg[^>]*>/g, '')}</g>
    <g fill="#fff" stroke="#4f46e5" stroke-width="3">
      <rect x="67" y="67" width="266" height="266" fill="none" stroke-dasharray="8 6"/>
      <rect x="60" y="60" width="14" height="14" rx="3"/><rect x="326" y="60" width="14" height="14" rx="3"/>
      <rect x="60" y="326" width="14" height="14" rx="3"/><rect x="326" y="326" width="14" height="14" rx="3"/>
    </g>
  </g>
</svg>`
render(og, 1200, 'og-image.png')
console.log('assets written')
