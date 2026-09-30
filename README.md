# PNGtoSVG

Free, private PNG to SVG converter that runs entirely in the browser: **https://pngtosvg.github.io**

Drop, paste or pick a PNG (JPG and WebP work too) and get a real, editable vector SVG. It is built
for transparent logos and icons: flat colors come out exact, edges are traced with sub-pixel
precision, corners stay sharp and straight sides become straight lines.

- **Private:** nothing is uploaded. Decoding, tracing and optimization all happen on your device,
  with the heavy work in Web Workers so the page never freezes.
- **Presets:** Logo, Icon, Smooth and Detailed, plus three sliders (colors, detail, smoothness)
  for fine-tuning.
- **Transparency:** kept exactly; empty transparent margins are trimmed, and a solid background can
  be removed with one toggle.
- **Side-by-side preview** of the PNG and the SVG, with zoom and checkerboard/light/dark backdrops.
- **Editing:** select shapes (Shift-click for more), recolor fill and stroke, recolor a whole color
  at once from the palette, move, resize, duplicate, reorder, delete. Undo/redo for everything.
- **Optimized output:** SVGO runs automatically before copy/download, and the page shows the size
  before and after.

## How the tracer works

`src/lib/vectorize.ts` is the whole pipeline:

1. **Quantize** (`quantize.ts`): k-means in OKLab over the image's colors, then merge near-duplicates.
   Anti-aliased edge pixels are recognized as a *mix of two palette colors* (plus alpha) instead of
   becoming colors of their own, which is what keeps logos to their real colors.
2. **Coverage fields**: for each color, a 0–1 value per pixel. Because edge pixels keep partial
   coverage, the 50 % iso-line sits where the original edge really was.
3. **Contours** (`contour.ts`): marching squares with box-filter interpolation gives sub-pixel
   outlines, with outer boundaries and holes wound in opposite directions.
4. **Curve fitting** (`fit.ts`): corner detection, corner sharpening (undoing the rounding that
   anti-aliasing adds), straight-line detection, and least-squares cubic Bézier fitting
   (Schneider's algorithm) for everything else.
5. **Layering**: by default every color is its own shape (easy to edit); each shape extends slightly
   underneath the colors above it, so neighbouring colors never show hairline gaps. "Stacked" mode
   instead lets lower colors fill under upper ones, which suits photos.

## Development

```sh
npm install
npm run dev      # local dev server
npm test         # tracer, geometry and optimizer tests (Node 22+)
npm run build    # type-check and build to dist/
```

`node scripts/generate-assets.mjs` re-renders the icons, social preview and sample image in `public/`.

## Deployment

`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub Pages on every push to
`main`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
