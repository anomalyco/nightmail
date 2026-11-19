// Web Audio: two buses, the broadcast (announcer, jingle, music bed) and the footage (Doug's
// world, thinner, like the sound on old film). The announcer ducks the music bed.
// Nothing loads before the click.

const FIRST = ["knob", "cut", "s0", "jingle", "bed", "ding", "s1"]
// The whole mix goes in at LEVEL and through the compressor, then a limiter, so the busiest
// moments (the ding storm, the radio come back louder, the thuds) never reach 0 dBFS.
const LEVEL = 0.6
const CEILING = 0.85

export class AudioEngine {
  constructor(base) {
    this.base = base
    this.ctx = null
    this.buf = new Map()
    this.loading = new Map()
    this.muted = false
    this.live = new Set()
    this.loops = new Map()
  }

  attach(ctx, muted) {
    this.ctx = ctx
    this.muted = muted
    const c = ctx
    this.master = c.createGain()
    this.master.gain.value = muted ? 0 : LEVEL
    const comp = c.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 3
    comp.attack.value = 0.005
    comp.release.value = 0.2
    const limit = c.createDynamicsCompressor()
    limit.threshold.value = -4
    limit.knee.value = 0
    limit.ratio.value = 20
    limit.attack.value = 0.001
    limit.release.value = 0.1
    const out = c.createGain()
    out.gain.value = CEILING
    this.master.connect(comp).connect(limit).connect(out).connect(c.destination)
    const bus = (pan) => {
      const g = c.createGain()
      const p = c.createStereoPanner()
      p.pan.value = pan
      const lp = c.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = 20000
      const hp = c.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 20
      g.connect(lp).connect(hp).connect(p).connect(this.master)
      return { g, lp, hp, p }
    }
    this.tv = bus(0)
    this.feed = bus(0.15)
    // the feed's microphone: no bass, no air
    this.feed.lp.frequency.value = 4200
    const hp = c.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 260
    this.feed.p.disconnect()
    this.feed.p.connect(hp).connect(this.master)
    this.voice = c.createGain()
    this.voice.connect(this.tv.g)
    this.music = c.createGain()
    this.music.gain.value = 0.55
    this.hushGain = c.createGain()
    this.music.connect(this.hushGain).connect(this.tv.g)
  }

  load(name) {
    if (!this.ctx) return Promise.resolve(null)
    if (this.buf.has(name)) return Promise.resolve(this.buf.get(name))
    if (!this.loading.has(name)) {
      this.loading.set(
        name,
        fetch(`${this.base}audio/${name}.mp3`)
          .then((r) => r.arrayBuffer())
          .then((a) => this.ctx.decodeAudioData(a))
          .then((b) => {
            this.buf.set(name, b)
            return b
          })
          .catch(() => null),
      )
    }
    return this.loading.get(name)
  }

  async preload(all) {
    await Promise.all(FIRST.map((n) => this.load(n)))
    await Promise.all(all.map((n) => this.load(n)))
  }

  setMuted(m) {
    this.muted = m
    if (!this.master) return
    this.master.gain.setTargetAtTime(m ? 0 : LEVEL, this.ctx.currentTime, 0.05)
  }

  // offset: seconds already elapsed (for seeking into the show)
  play(name, o = {}) {
    if (!this.ctx) return null
    const b = this.buf.get(name)
    if (!b) {
      // late: start it from where it should be once it arrives
      const t0 = performance.now()
      this.load(name).then((bb) => {
        if (bb && !o.loop) this.play(name, { ...o, offset: (o.offset || 0) + (performance.now() - t0) / 1000 })
        else if (bb) this.play(name, o)
      })
      return null
    }
    const off = o.offset || 0
    if (!o.loop && off >= b.duration / (o.rate || 1)) return null
    const c = this.ctx
    const src = c.createBufferSource()
    src.buffer = b
    src.loop = !!o.loop
    src.playbackRate.value = o.rate || 1
    const g = c.createGain()
    g.gain.value = o.gain ?? 1
    let node = src.connect(g)
    if (o.pan != null) {
      const p = c.createStereoPanner()
      p.pan.value = o.pan
      node = node.connect(p)
    }
    const dest = o.bus === "voice" ? this.voice : o.bus === "music" ? this.music : o.bus === "tv" ? this.tv.g : this.feed.g
    node.connect(dest)
    if (o.fadeIn) {
      g.gain.setValueAtTime(0, c.currentTime)
      g.gain.linearRampToValueAtTime(o.gain ?? 1, c.currentTime + o.fadeIn)
    }
    src.start(c.currentTime, (off * (o.rate || 1)) % b.duration)
    const h = { src, g, name }
    this.live.add(h)
    src.onended = () => this.live.delete(h)
    if (o.bus === "voice") this.duck(b.duration - off)
    return h
  }

  duck(dur) {
    const c = this.ctx
    const t = c.currentTime
    const m = this.music.gain
    m.cancelScheduledValues(t)
    m.setTargetAtTime(0.22, t, 0.06)
    m.setTargetAtTime(0.55, t + Math.max(0.1, dur - 0.1), 0.35)
  }

  loop(name, o = {}) {
    this.stopLoop(name)
    const h = this.play(name, { ...o, loop: true, fadeIn: o.fadeIn ?? 1.5 })
    if (h) this.loops.set(name, h)
    else this.load(name).then((b) => b && !this.loops.has(name) && this.loop(name, o))
  }

  stopLoop(name, fade = 0.8) {
    const h = this.loops.get(name)
    if (!h) return
    this.loops.delete(name)
    this.fadeOut(h, fade)
  }

  fadeOut(h, fade = 0.5) {
    if (!h) return
    const t = this.ctx.currentTime
    h.g.gain.cancelScheduledValues(t)
    h.g.gain.setValueAtTime(h.g.gain.value, t)
    h.g.gain.linearRampToValueAtTime(0, t + fade)
    try {
      h.src.stop(t + fade + 0.05)
    } catch {}
  }

  // the tape dying: pitch and speed sag to nothing
  tapeStop(h, dur = 1.6) {
    if (!h) return
    const t = this.ctx.currentTime
    h.src.playbackRate.cancelScheduledValues(t)
    h.src.playbackRate.setValueAtTime(h.src.playbackRate.value, t)
    h.src.playbackRate.exponentialRampToValueAtTime(0.06, t + dur)
    h.g.gain.setValueAtTime(h.g.gain.value, t + dur * 0.6)
    h.g.gain.linearRampToValueAtTime(0, t + dur)
    try {
      h.src.stop(t + dur + 0.05)
    } catch {}
  }

  // The commercial as it sounds from where Doug is. "open": full range, in the studio. "tinny":
  // out of a car radio. "off": he has headbutted it. "loud": it came back on, louder.
  radio(mode, time = 0.08) {
    if (!this.ctx) return
    const [lp, hp, gain] = { open: [20000, 20, 1], tinny: [2400, 700, 0.55], off: [2400, 700, 0], loud: [3200, 520, 1.5] }[mode]
    const t = this.ctx.currentTime
    this.tv.lp.frequency.setTargetAtTime(lp, t, time / 3)
    this.tv.hp.frequency.setTargetAtTime(hp, t, time / 3)
    this.tv.g.gain.setTargetAtTime(gain, t, time / 3)
  }

  // the music holds its breath
  hush(level, time = 0.3) {
    if (!this.ctx) return
    this.hushGain.gain.setTargetAtTime(level, this.ctx.currentTime, time / 3)
  }

  // A chorus of notification dings, `n` over `dur` seconds, getting denser.
  chorus(n, dur, gain = 0.5) {
    if (!this.ctx) return
    for (let i = 0; i < n; i++) {
      const k = i / n
      const at = dur * Math.sqrt(k)
      setTimeout(() => this.play(Math.random() < 0.35 ? "buzz" : "ding", { rate: 0.85 + Math.random() * 0.5, gain: gain * (0.4 + Math.random() * 0.6), pan: -0.4 + Math.random() * 0.8 }), at * 1000)
    }
  }

  stopAll(fade = 0.05) {
    for (const h of this.live) this.fadeOut(h, fade)
    this.loops.clear()
  }
}
