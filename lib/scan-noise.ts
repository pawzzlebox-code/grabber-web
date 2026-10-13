// One static tile for the progressive-scan visuals (ScanBanner, photo tiles),
// made once and jumped around with background-position — a moving noise field
// without redrawing anything per frame. Browser-only; '' during SSR.
let noiseTileUrl = ''

export function noiseTile(): string {
  if (noiseTileUrl || typeof document === 'undefined') return noiseTileUrl
  const c = document.createElement('canvas')
  c.width = c.height = 96
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(96, 96)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 20 + Math.random() * 150
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v + 10; img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  noiseTileUrl = c.toDataURL()
  return noiseTileUrl
}
