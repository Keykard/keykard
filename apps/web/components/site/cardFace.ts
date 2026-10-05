/**
 * The KEYKARD faces, drawn on 2D canvases and used as textures on the 3D card.
 * Everything is drawn in code: no image files to load, crisp at any size, and the amount can change live.
 */

export const FACE_W = 1024
export const FACE_H = 646 // ISO/IEC 7810 ID-1 ratio (85.6 × 53.98 mm)

const ACCENT = '#8b7cff'
const ACCENT_HI = '#b3a9ff'

function fontFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
  return v ? `${v}, ui-sans-serif, system-ui, sans-serif` : 'ui-sans-serif, system-ui, sans-serif'
}
function monoFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return v ? `${v}, ui-monospace, monospace` : 'ui-monospace, monospace'
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function base(ctx: CanvasRenderingContext2D, variant: 'main' | 'family') {
  const g = ctx.createLinearGradient(0, 0, FACE_W, FACE_H)
  if (variant === 'main') {
    g.addColorStop(0, '#1b1538')
    g.addColorStop(0.55, '#0e0c1c')
    g.addColorStop(1, '#07070c')
  } else {
    g.addColorStop(0, '#e9e6ff')
    g.addColorStop(1, '#bdb5ff')
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, FACE_W, FACE_H)

  // soft light bloom, top-left
  const glow = ctx.createRadialGradient(FACE_W * 0.18, FACE_H * 0.1, 0, FACE_W * 0.18, FACE_H * 0.1, FACE_W * 0.7)
  glow.addColorStop(0, variant === 'main' ? 'rgba(139,124,255,0.42)' : 'rgba(255,255,255,0.7)')
  glow.addColorStop(1, 'rgba(139,124,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, FACE_W, FACE_H)

  // guilloche: fine interference lines, the security-print texture of real cards
  ctx.save()
  ctx.globalAlpha = variant === 'main' ? 0.09 : 0.14
  ctx.strokeStyle = variant === 'main' ? ACCENT_HI : '#5a4fd6'
  ctx.lineWidth = 1.2
  for (let k = 0; k < 26; k++) {
    ctx.beginPath()
    for (let x = 0; x <= FACE_W; x += 8) {
      const y = FACE_H * 0.62 + Math.sin(x / 90 + k * 0.42) * (40 + k * 3) + Math.cos(x / 210 - k * 0.3) * 30 - k * 6
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

function wordmark(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  // key glyph: a ring + bit, drawn as the logomark
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 7
  ctx.beginPath()
  ctx.arc(x + 16, y - 15, 13, 0, Math.PI * 2)
  ctx.moveTo(x + 29, y - 15)
  ctx.lineTo(x + 58, y - 15)
  ctx.moveTo(x + 48, y - 15)
  ctx.lineTo(x + 48, y - 2)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.font = `700 40px ${fontFamily()}`
  ctx.letterSpacing = '6px'
  ctx.fillText('KEYKARD', x + 74, y)
  ctx.restore()
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = 118
  const h = 90
  const g = ctx.createLinearGradient(x, y, x + w, y + h)
  g.addColorStop(0, '#e8e4ff')
  g.addColorStop(0.5, '#9d92e8')
  g.addColorStop(1, '#d9d4ff')
  ctx.fillStyle = g
  roundRect(ctx, x, y, w, h, 16)
  ctx.fill()
  ctx.strokeStyle = 'rgba(40,30,90,0.45)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y + h / 3); ctx.lineTo(x + w * 0.36, y + h / 3)
  ctx.moveTo(x, y + (2 * h) / 3); ctx.lineTo(x + w * 0.36, y + (2 * h) / 3)
  ctx.moveTo(x + w, y + h / 3); ctx.lineTo(x + w * 0.64, y + h / 3)
  ctx.moveTo(x + w, y + (2 * h) / 3); ctx.lineTo(x + w * 0.64, y + (2 * h) / 3)
  ctx.stroke()
  roundRect(ctx, x + w * 0.36, y + h * 0.2, w * 0.28, h * 0.6, 8)
  ctx.stroke()
}

function contactless(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.arc(x, y, 12 + i * 14, -Math.PI / 3.2, Math.PI / 3.2)
    ctx.stroke()
  }
  ctx.restore()
}

export function drawFront(ctx: CanvasRenderingContext2D, limit: number) {
  ctx.clearRect(0, 0, FACE_W, FACE_H)
  base(ctx, 'main')
  wordmark(ctx, 64, 104, '#f5f5f7')
  contactless(ctx, FACE_W - 110, 88, 'rgba(245,245,247,0.85)')
  chip(ctx, 64, 190)

  ctx.fillStyle = 'rgba(245,245,247,0.55)'
  ctx.font = `600 22px ${fontFamily()}`
  ctx.letterSpacing = '4px'
  ctx.fillText('AVAILABLE TO SPEND', 64, 470)

  ctx.fillStyle = '#ffffff'
  ctx.font = `300 104px ${fontFamily()}`
  ctx.letterSpacing = '-2px'
  ctx.fillText(`$${Math.round(limit)}`, 58, 572)

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(245,245,247,0.7)'
  ctx.font = `500 26px ${monoFamily()}`
  ctx.letterSpacing = '2px'
  ctx.fillText('•••• 5392', FACE_W - 64, 520)
  ctx.fillStyle = ACCENT_HI
  ctx.font = `700 24px ${fontFamily()}`
  ctx.letterSpacing = '5px'
  ctx.fillText('CREDIT · TEMPO', FACE_W - 64, 568)
  ctx.textAlign = 'left'
  ctx.letterSpacing = '0px'
}

export function drawBack(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, FACE_W, FACE_H)
  base(ctx, 'main')
  // magnetic stripe
  ctx.fillStyle = '#050508'
  ctx.fillRect(0, 70, FACE_W, 110)

  // verified-human seal
  const cx = FACE_W - 200
  const cy = 390
  ctx.save()
  ctx.strokeStyle = ACCENT_HI
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(cx, cy, 118, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([3, 9])
  ctx.beginPath()
  ctx.arc(cx, cy, 100, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 12
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - 42, cy + 2)
  ctx.lineTo(cx - 10, cy + 34)
  ctx.lineTo(cx + 48, cy - 30)
  ctx.stroke()
  ctx.restore()

  ctx.fillStyle = '#ffffff'
  ctx.font = `600 46px ${fontFamily()}`
  ctx.fillText('Verified human', 64, 300)
  ctx.fillStyle = 'rgba(245,245,247,0.6)'
  ctx.font = `400 25px ${fontFamily()}`
  const lines = ['Unique person, proven with a zero-knowledge', 'ID check. No documents stored.']
  lines.forEach((l, i) => ctx.fillText(l, 64, 350 + i * 36))
  ctx.fillStyle = ACCENT_HI
  ctx.font = `700 22px ${fontFamily()}`
  ctx.letterSpacing = '4px'
  ctx.fillText('IDENTITY BY SELF', 64, 470)
  ctx.letterSpacing = '0px'

  ctx.fillStyle = 'rgba(245,245,247,0.45)'
  ctx.font = `400 20px ${fontFamily()}`
  ctx.fillText('This card can only pay KEYKARD merchants. Enforced by the Tempo protocol.', 64, 590)
}

export function drawFamily(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, FACE_W, FACE_H)
  base(ctx, 'family')
  wordmark(ctx, 64, 104, '#16122e')
  ctx.fillStyle = 'rgba(22,18,46,0.6)'
  ctx.font = `600 22px ${fontFamily()}`
  ctx.letterSpacing = '4px'
  ctx.fillText('FAMILY BACKUP', 64, 470)
  ctx.fillStyle = '#16122e'
  ctx.font = `300 88px ${fontFamily()}`
  ctx.letterSpacing = '-2px'
  ctx.fillText('up to $30', 58, 566)
  ctx.textAlign = 'right'
  ctx.font = `700 24px ${fontFamily()}`
  ctx.letterSpacing = '5px'
  ctx.fillStyle = '#4b3fd1'
  ctx.fillText('GUARANTOR', FACE_W - 64, 566)
  ctx.textAlign = 'left'
  ctx.letterSpacing = '0px'
}
