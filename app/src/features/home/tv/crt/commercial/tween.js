// Sim-time tweens and a tiny cue runner, so the whole show is a function of one clock and can be
// fast-forwarded (?t=) deterministically.

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
export const lerp = (a, b, t) => a + (b - a) * t
export const E = {
  lin: (t) => t,
  io: (t) => t * t * (3 - 2 * t),
  out: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  in: (t) => t * t * t,
  back: (t) => {
    const c = 1.9
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
  },
  elastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
}

export class Tweens {
  constructor() {
    this.list = []
  }
  // animate obj[key] from its value at start time to `to`
  to(obj, key, to, dur, ease = E.io, delay = 0, now = 0) {
    this.list = this.list.filter((t) => !(t.obj === obj && t.key === key && t.start >= now + delay - 1e-6) || false)
    this.list.push({ obj, key, to, dur: Math.max(dur, 1e-4), ease, start: now + delay, from: null })
  }
  step(now) {
    const keep = []
    // later tweens on the same key win
    for (const t of this.list) {
      if (now < t.start) {
        keep.push(t)
        continue
      }
      if (t.from === null) {
        t.from = t.obj[t.key] ?? 0
        // a newer tween on this key supersedes older running ones
        for (const o of this.list) if (o !== t && o.obj === t.obj && o.key === t.key && o.start < t.start) o.dead = true
      }
      if (t.dead) continue
      const k = clamp((now - t.start) / t.dur, 0, 1)
      t.obj[t.key] = lerp(t.from, t.to, t.ease(k))
      if (k < 1) keep.push(t)
    }
    this.list = keep.filter((t) => !t.dead)
  }
  clear() {
    this.list = []
  }
}

export class Cues {
  constructor() {
    this.list = []
    this.i = 0
  }
  at(t, fn) {
    this.list.push([t, fn])
  }
  sort() {
    this.list.sort((a, b) => a[0] - b[0])
  }
  run(now) {
    while (this.i < this.list.length && this.list[this.i][0] <= now) {
      const [t, fn] = this.list[this.i++]
      fn(t)
    }
  }
  reset() {
    this.i = 0
  }
}

export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
