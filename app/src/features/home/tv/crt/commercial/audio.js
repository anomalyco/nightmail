// Web Audio: two buses, the broadcast (announcer, jingle, music bed) and the footage (Doug's
// world, thinner, like the sound on old film). The announcer ducks the music bed. It all leaves
// through `out`, the node it is given: on /cheaper/y, the television's own speaker.
// Nothing loads before the click.

// what the first seconds of the show play: the show waits for these, the rest load behind them
const FIRST = ["cut", "s0", "sparkle", "jingle", "tap", "kaching"]

export class AudioEngine {
  // cache: decoded clips ({ buf, loading }), kept from one showing to the next on the same context
  constructor(base, cache = { buf: new Map(), loading: new Map() }) {
    this.base = base
    this.ctx = null
    this.buf = cache.buf
    this.loading = cache.loading
    this.live = new Set()
    this.loops = new Map()
    // how far the show's clock had run past a cue when it fired (a frame, or a stall): the sound
    // starts that far in, so it stays with the picture
    this.behind = 0
    this.closed = false
    this.gen = 0
  }

  attach(ctx, out) {
    this.ctx = ctx
    const c = ctx
    this.master = c.createGain()
    const comp = c.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 3
    comp.attack.value = 0.005
    comp.release.value = 0.2
    this.master.connect(comp).connect(out)
    this.out = comp
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

  // resolves when the first seconds' clips are in; the rest keep loading
  preload(all) {
    const first = Promise.all(FIRST.map((n) => this.load(n)))
    void first.then(() => all.forEach((n) => this.load(n)))
    return first
  }

  // offset: seconds already elapsed (for seeking into the show). late(h): told the handle of a
  // sound that had not loaded yet, once it starts
  play(name, o = {}) {
    if (!this.ctx || this.closed) return null
    return this.begin(name, { ...o, offset: (o.offset || 0) + this.behind })
  }

  begin(name, o) {
    const b = this.buf.get(name)
    if (!b) {
      // late: start it from where it should be once it arrives, unless everything has stopped since
      const t0 = this.ctx.currentTime
      const gen = this.gen
      this.load(name).then((bb) => {
        if (!bb || this.closed || gen !== this.gen) return
        const h = this.begin(name, o.loop ? o : { ...o, offset: o.offset + this.ctx.currentTime - t0 })
        o.late?.(h)
      })
      return null
    }
    const off = o.offset
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
    // started part of the way in, it comes up over a few ms, or the cut into the waveform clicks
    const fadeIn = o.fadeIn || (off > 0 ? 0.006 : 0)
    if (fadeIn) {
      g.gain.setValueAtTime(0, c.currentTime)
      g.gain.linearRampToValueAtTime(o.gain ?? 1, c.currentTime + fadeIn)
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
    // held in its place until it has loaded; if it was stopped by then, it does not start
    const mark = {}
    this.loops.set(name, mark)
    const late = (h) => (this.loops.get(name) === mark ? this.loops.set(name, h) : this.fadeOut(h, 0.05))
    const h = this.play(name, { ...o, loop: true, fadeIn: o.fadeIn ?? 1.5, late })
    if (h) this.loops.set(name, h)
  }

  stopLoop(name, fade = 0.8) {
    const h = this.loops.get(name)
    if (!h) return
    this.loops.delete(name)
    this.fadeOut(h, fade)
  }

  fadeOut(h, fade = 0.5) {
    if (!h?.src) return
    const t = this.ctx.currentTime
    h.g.gain.cancelScheduledValues(t)
    h.g.gain.setValueAtTime(h.g.gain.value, t)
    h.g.gain.linearRampToValueAtTime(0, t + fade)
    try {
      h.src.stop(t + fade + 0.05)
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

  stopAll(fade = 0.05) {
    this.gen++
    for (const h of this.live) this.fadeOut(h, fade)
    this.loops.clear()
  }

  // the show is over, or the channel was changed: everything fades, nothing else starts, and the
  // engine lets go of the speaker
  close(fade = 0.05) {
    if (!this.ctx || this.closed) return
    this.stopAll(fade)
    this.closed = true
    setTimeout(() => this.out.disconnect(), (fade + 0.1) * 1000)
  }
}
