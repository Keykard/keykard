/**
 * The scroll story: one KEYKARD travels through the whole page.
 *
 * Sections drop invisible markers (`<i data-k="hero" />`). Each marker names a pose. A marker's anchor is the
 * scroll position at which it crosses the middle of the viewport; between two anchors the pose is interpolated.
 * The 3D scene samples this every frame and damps toward it, so scrolling back and forth is always consistent
 * (no timeline state to get out of sync), and nothing here touches React state.
 */

export type Pose = {
  /** horizontal position, -1 (left edge) … 1 (right edge) of the viewport */
  x: number
  /** vertical position, -1 … 1 */
  y: number
  z: number
  rx: number
  ry: number
  rz: number
  /** scale multiplier */
  s: number
  /** dollar amount printed on the card face */
  limit: number
  /** auto-pay border progress 0…1 */
  ring: number
  /** NFC ripple intensity 0…1 */
  ripple: number
  /** 0 active · 1 overdue · 2 frozen · 3 defaulted · 4 settled (fractional values blend) */
  skin: number
  /** refused-payment glitch 0…1 */
  glitch: number
  /** family backup card 0…1 */
  family: number
  /** merchant helix 0…1 */
  helix: number
  /** card visibility 0…1 */
  show: number
}

export const BASE: Pose = {
  x: 0.42, y: 0, z: 0, rx: 0.12, ry: -0.42, rz: 0.05, s: 1,
  limit: 20, ring: 0, ripple: 0, skin: 0, glitch: 0, family: 0, helix: 0, show: 1,
}

/** Keyframes, in page order. Each inherits everything it doesn't set from the one before. */
const KEYFRAMES: [string, Partial<Pose>][] = [
  ['hero', {}],
  ['verify', { x: -0.4, y: 0, rx: 0.05, ry: Math.PI + 0.35, rz: -0.04 }],
  ['how-1', { x: 0.44, rx: 0.08, ry: -0.18, rz: 0.02, limit: 0 }],
  ['how-1b', { limit: 20 }],
  ['how-2', { ripple: 1, ry: -0.05, rx: 0.3 }],
  ['how-3', { ripple: 0, ring: 1, rx: 0.06, ry: -0.22 }],
  ['how-4', { ring: 0, limit: 100, s: 1.08, ry: -0.3 }],
  ['enforced', { x: 0.36, y: -0.05, ry: -0.12, rx: 0.1, s: 1, limit: 50 }],
  ['enforced-hit', { glitch: 1 }],
  ['enforced-out', { glitch: 0 }],
  ['states-0', { x: 0.4, y: 0.02, ry: -0.3, rx: 0.1, skin: 0 }],
  ['states-1', { skin: 1 }],
  ['states-2', { skin: 2 }],
  ['states-3', { skin: 3 }],
  ['states-4', { skin: 4 }],
  ['family', { skin: 0, x: 0.5, y: 0.12, ry: -0.35, rx: 0.12, s: 0.86, family: 1 }],
  ['family-out', { family: 0, show: 0, y: 0.6, s: 0.6 }],
  ['merchants', { x: 0.7, y: 0.9, s: 0.5, helix: 1 }],
  ['merchants-out', {}],
  ['demo', { helix: 0 }],
  ['road', { show: 0, y: 0.7, s: 0.6 }],
  ['final', { x: 0, y: 0.5, rx: 0.3, ry: 0.28, rz: -0.02, s: 0.8, show: 1, limit: 100 }],
]

const POSES: Record<string, Pose> = (() => {
  const out: Record<string, Pose> = {}
  let prev = BASE
  for (const [name, p] of KEYFRAMES) out[name] = prev = { ...prev, ...p }
  return out
})()

type Anchor = { at: number; pose: Pose }
let anchors: Anchor[] = []

/** Re-measure marker positions (on resize, font load, layout changes). */
export function measure() {
  if (typeof document === 'undefined') return
  const vh = window.innerHeight
  const y = window.scrollY
  anchors = Array.from(document.querySelectorAll<HTMLElement>('[data-k]'))
    .map((el) => {
      const pose = POSES[el.dataset.k!]
      if (!pose) return null
      const r = el.getBoundingClientRect()
      return { at: r.top + y - vh * 0.5, pose }
    })
    .filter((a): a is Anchor => a !== null)
    .sort((a, b) => a.at - b.at)
}

const smooth = (t: number) => t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** The pose at a scroll position. `out` is reused to avoid allocating every frame. */
export function sample(scroll: number, out: Pose = { ...BASE }): Pose {
  if (anchors.length === 0) return Object.assign(out, BASE)
  if (scroll <= anchors[0].at) return Object.assign(out, anchors[0].pose)
  const last = anchors[anchors.length - 1]
  if (scroll >= last.at) return Object.assign(out, last.pose)
  let i = 0
  while (i < anchors.length - 1 && anchors[i + 1].at < scroll) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  const t = smooth(Math.min(1, Math.max(0, (scroll - a.at) / Math.max(1, b.at - a.at))))
  for (const k of Object.keys(out) as (keyof Pose)[]) out[k] = lerp(a.pose[k], b.pose[k], t)
  return out
}

/** Shared pointer, normalised to -1…1 (window listener: the canvas itself never takes pointer events). */
export const pointer = { x: 0, y: 0 }
