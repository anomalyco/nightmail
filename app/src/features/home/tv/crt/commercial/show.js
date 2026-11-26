// Nightmail: a 1970s TV commercial, and what it does to Doug.
//
// A pitchman sells Nightmail's features to businesses, in saturated colour. He never mentions
// Doug. Intercut with him is black-and-white footage of Doug, who bought one garden gnome from
// Gnome Depot, and on whom Gnome Depot uses every feature the pitchman names. It only ever gets
// worse: earlier emails never stop, the badge on his phone only goes up, and each thing Doug
// tries makes more. In the end he drives to the studio.
//
// The commercial is the master clock: its clips play back to back and never wait for Doug. Every
// beat cuts to a new shot as its clip starts, and what happens inside the beat is keyed to the
// announcer's words, looked up by text in the audio manifest (ElevenLabs Scribe timings). So a
// new recording of the same script retimes the show by itself. Everything is a function of one
// sim clock (`this.t`): cues fire once, tweens interpolate, so ?t= can fast-forward.
import { LINES, TEAM } from "./atlas.js"
import { CH, CW, QF, TILES } from "./gpu.js"
import { SCENES, STAFF, caption, count } from "./scenes.js"
import { Cues, E, Tweens, clamp, lerp, rng } from "./tween.js"

const WHITE = [1, 1, 1, 1]
const CREAM = [1, 0.95, 0.84, 1]
const YELLOW = [1, 0.84, 0.3, 1]
const AMBER = [1, 0.66, 0.2, 1]
const GAP = 0.2 // breath between commercial clips
const JINGLE = 3.3
const FEED_W = 2560
const FEED_H = 1440
// the fine print that keeps each line of the pitch honest (atlas.js FINE)
const FINE_OF = { s1: "api", s2: "price", s3: "campaigns", s4: "tracking", s5: "inbox", s6: "rule", s7: "ai", s8: "agent" }

function newDoug() {
  return {
    x: 0, y: 0, hy: 0, sq: 0, sqv: 0, rot: 0, alpha: 1,
    gx: 0, gy: 0.1, lid: 0.1, blink: 0, brow: 0, worry: 0, smile: 0.3, mouth: 0, wide: 1, squint: 0, twitch: 0, fx: 0, fy: 0, shine: 0,
    sink: 0, shiver: 0, drum: 0, autoBlink: 1, nextBlink: 2,
  }
}
// the pitchman's face at rest: a big easy grin, relaxed lids, level brows. He is never anything else
// for long, until Doug lands on him.
const EASY = { smile: 1, brow: 0.15, wide: 1, lid: 0.2 }
function newPitch() {
  return { in: 0, dx: 0, hy: 0, sq: 0, sqv: 0, rot: 0, gx: 0, gy: 0, fx: 0, mouth: 0, hype: 0, ...EASY }
}
function newCam(tile) {
  return { tile, scene: "couch", a: 1, cell: null, mode: 0, noise: 0.14, zoom: 1, cx: 0.5, cy: 0.5, gain: 1, contrast: 1.1, glitch: 0, flash: 0, caption: "", S: {} }
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
// how much of his own radius the pitchman needs, bouncing: above the band (hat included), and to each side
const ROOM = 3.0
const HALF = 1.1
const ANGRY = { lid: 0.4, squint: 0.55, brow: -0.6, worry: -1, smile: -0.45, autoBlink: 0 }

export class Show {
  constructor({ atlas, audio, seed = 7 }) {
    this.atlas = atlas
    this.audio = audio
    this.seed = seed
    this.BW = 1152
    this.BH = 720
    this.tube = { power: 0, static: 0, roll: 0, tracking: 0.035, warp: 0, bright: 1, tilt: 0 }
    this.reset()
  }

  reset() {
    this.rand = rng(this.seed)
    this.t = 0
    this.started = false
    this.ended = false
    this.tw = new Tweens()
    this.cues = new Cues()
    this.D = newDoug()
    this.G = newPitch()
    this.lay = { from: "standby", to: "standby", k: 1 }
    // the main shot, and six of Gnome Depot's office that only come up for one beat
    this.cams = [newCam(0)]
    STAFF.forEach((_, i) => this.cams.push(Object.assign(newCam(i + 1), { scene: "staff", a: 0, cell: i, zoom: 1.5, noise: 0.18, S: { who: i } })))
    this.split = 0 // 0: the main shot has the whole feed. 1: it shares it with the office
    this.replies = [] // when each of the office answered
    this.texts = {} // slot → { name, t0, col, soft }
    this.fineKey = null
    this.pops = [] // what arrives on Doug's phone, shown crisp at the top left of the footage
    this.popBudget = 0.5 // how far down the footage they may pile, as a fraction of its height
    this.badge = { n: 0, punch: 0 } // unread. It only goes up.
    this.amb = { rate: 0, acc: 0, i: 0, pool: [], sound: "ding", hold: false } // the ones that never stop
    this.buzz = 0 // 1 when something just arrived, decaying
    this.heat = 0 // 0..1: how much mail the phone is spitting out
    this.read = [] // the studio's amber readout: what the product is doing
    this.board = null // the studio's inbox board: { t0, mode: "inbox" | "slack", msg, sent }
    this.boardAt = [0, 0, 0] // where it is in the broadcast (x, y, width), for things flying to it
    this.flies = [] // things crossing between the footage and the commercial
    this.star = null
    this.callout = null // "via NIGHTMAIL", noticed
    this.set = null // the studio in the last shot: { door, doug, k }
    this.lower = null // the lower third
    this.atk = null // what Doug does to the pitchman after "Call n—" (see strike)
    this.coupon = null // when the last email arrived
    this.lamp = { a: 0, v: 0, k: 28, c: 0.7 } // the studio lights, swinging
    this.boom = { a: 0, v: 0, k: 14, c: 0.45 } // the boom mic, swinging
    this.radioMode = "open"
    this.post = { shake: 0, flash: 0 }
    this.hops = []
    this.voice = 0
    this.talkUntil = 0
    this.seeking = false
    this.audioLog = []
    this.loops = new Map()
    this.handles = {}
    this.marks = {}
    this.fade = 0
    this.fgClip = null
    Object.assign(this.tube, { static: 0, roll: 0, tracking: 0.035, warp: 0, bright: 1, tilt: 0 })
    // before anyone tunes in: Doug on his couch, shopping
    Object.assign(this.D, { gx: 0.9, gy: 0.45, smile: 0.35 })
  }

  size(w, h) {
    this.BW = w
    this.BH = h
  }

  // ─── helpers ──────────────────────────────────────────────────────────────────
  to(obj, key, v, dur = 0.4, ease = E.io, delay = 0) {
    this.tw.to(obj, key, v, dur, ease, delay, this.t)
  }
  doug(p, dur = 0.3, ease = E.io, delay = 0) {
    for (const [k, v] of Object.entries(p)) this.to(this.D, k, v, dur, ease, delay)
  }
  pitch(p, dur = 0.3, ease = E.io, delay = 0) {
    for (const [k, v] of Object.entries(p)) this.to(this.G, k, v, dur, ease, delay)
  }
  sfx(name, o = {}) {
    if (this.seeking) {
      this.audioLog.push({ name, o, t: this.t })
      return null
    }
    return this.audio?.play(name, o) ?? null
  }
  // a new line of the pitch: the band starts clean, so it only ever shows what he is saying now
  say(name, dur) {
    this.texts.chy = null
    this.fineKey = FINE_OF[name] || null
    this.fineT = this.t
    this.talkUntil = this.t + dur
    this.handles.voice = this.sfx(name, { bus: "voice" })
  }
  loop(name, o = {}) {
    this.loops.set(name, o)
    if (!this.seeking) this.audio?.loop(name, o)
  }
  stopLoop(name, fade) {
    this.loops.delete(name)
    if (!this.seeking) this.audio?.stopLoop(name, fade)
  }
  // how the commercial sounds from where Doug is (audio.js radio)
  radio(mode) {
    this.radioMode = mode
    if (!this.seeking) this.audio?.radio?.(mode)
  }
  // One blow lands: on the pitchman ("p") or on his hat ("h"). Everything in the studio feels it.
  strike(power = 1, on = "p") {
    const a = this.atk
    a.n++
    a.last = this.t
    a.talk = 0
    this.text("chy", null)
    this.D.sqv -= 9 * power
    if (on === "p") {
      this.G.sqv -= 17 * power
      a.flat = Math.min(0.92, a.flat + (a.n === 1 ? 0.25 : 0.045 * power)) // the tackle alone takes him down a peg
      a.wob.v += (a.n % 2 ? 1 : -1) * 6 * power
      a.mouth = 1
      if (a.n >= 3 && a.daze < 2) a.daze = Math.min(1, a.daze + 0.34)
      if (a.n === 2) a.hat = { t0: this.t } // off it comes
    } else {
      a.crush = Math.min(1, a.crush + 0.6)
      this.sfx("crunch", { bus: "tv", gain: 0.9, rate: 0.9 + a.crush * 0.2 })
    }
    a.bursts.push({ t0: this.t, on, seed: a.n, power })
    if (a.n % 3 === 0) a.sparks.push({ t0: this.t, seed: a.n })
    this.post.shake = 0.5 + 0.4 * power
    this.to(this.post, "shake", 0.04, 0.3)
    this.post.flash = 0.16 * power
    this.to(this.post, "flash", 0, 0.12)
    // the camera gets knocked (less on a phone, where a tilted picture loses more of its sides)
    const lim = this.BH > this.BW ? 0.045 : 0.09
    this.tube.tilt = clamp(this.tube.tilt + (((a.n * 7) % 5) - 2) * lim * 0.16, -lim, lim)
    this.lamp.v += (a.n % 2 ? 1 : -1) * 2.4 * power
    this.boom.v += 1.8 * power
    this.sfx("thud" + (a.n % 4), { bus: "tv", gain: 0.95, rate: 0.85 + ((a.n * 0.37) % 0.3) })
    if (this.handles.call && !this.seeking) this.audio?.fadeOut(this.handles.call, 0.02)
    this.handles.call = null
  }
  // everything stops dead
  silence() {
    this.audioLog.length = 0
    this.loops.clear()
    if (!this.seeking) this.audio?.stopAll(0.02)
    this.talkUntil = 0
    this.amb.rate = 0
    this.heat = 0
  }
  // kinetic type on the band along the bottom
  text(slot, name, col = CREAM, soft = false) {
    this.texts[slot] = name ? { name, t0: this.t, col, soft } : null
    if (name && !soft) this.G.sqv += 3
  }
  chy(name, col) {
    this.text("chy", "tv:" + name, col)
  }
  // a line on the studio's readout; it types itself out
  readout(text, col = AMBER, typed = true) {
    this.read.push({ text, col, t0: this.t, typed })
    if (this.read.length > 3) this.read.shift()
  }
  // something arrives on Doug's phone (or leaves it): shown crisp, because jokes are for reading
  pop(name, life = 3.6, o = {}) {
    const p = { name, t0: this.t, life, pin: true, ...o }
    this.pops.push(p)
    return p
  }
  // Something crosses the broadcast: his reply leaves the footage for the studio, the studio's
  // answer comes back. `from` and `to` are functions giving broadcast px, read every frame.
  fly(name, from, to, o = {}) {
    this.flies.push({ name, from, to, t0: this.t, hold: 0, dur: 0.4, s0: 0.6, s1: 0.6, arc: 60, ...o })
  }
  // a point in the main shot (640×480) as broadcast px
  inShot(sx, sy) {
    const r = this.cams[0].rect
    if (!r) return [0, 0]
    const v = r.vis
    return [r.x + ((sx - v.x0) / (v.x1 - v.x0)) * r.w, r.y + ((sy - v.y0) / (v.y1 - v.y0)) * r.h]
  }
  // the ones he was meant to read go when the shot does; the ones that never stop, don't
  trimPins() {
    for (const p of this.pops) if (p.pin) p.life = Math.min(p.life, this.t - p.t0 + 0.12)
  }
  budget(wide, tall = wide) {
    this.popBudget = this.BH > this.BW ? tall : wide
  }
  burst(name, dur = 2.2) {
    this.star = { name, t0: this.t, until: this.t + dur }
    this.G.sqv += 6
  }
  setLay(name, dur = 0.7, ease = E.io) {
    const cur = this.layout()
    this.lay = { from: cur, to: name, k: 0 }
    this.to(this.lay, "k", 1, dur, ease)
  }
  // cut to another shot of Doug
  cut(scene, o = {}, doug = {}) {
    const cam = this.cams[0]
    this.tw.list = this.tw.list.filter((t) => t.obj !== this.D && t.obj !== cam && t.obj !== cam.S)
    Object.assign(cam, { scene, a: 1, S: {}, mode: 0, noise: 0.14, zoom: 1, cx: 0.5, cy: 0.5, gain: 1, caption: "", flash: 0, clip: null, clipR: 0 }, o)
    cam.glitch = 0.6
    this.to(cam, "glitch", 0, 0.2, E.out)
    this.D = Object.assign(newDoug(), { nextBlink: this.t + 1.5 }, doug)
    this.hops = this.hops.filter((h) => h.obj !== this.D)
    this.trimPins()
    this.sfx("cut", { bus: "tv", gain: 0.4 })
    return cam
  }
  // an email he is meant to read arrives: the phone lights, the badge jumps
  ring(o = {}) {
    const S = this.cams[0].S
    S.lit = 1
    this.to(S, "lit", o.hold ?? 0.25, 1.2, E.io, 0.6)
    S.shake = 1
    this.to(S, "shake", 0, 0.45)
    this.badge.punch = 1
    if (o.buzz) this.sfx("buzz", { gain: 0.6 })
    else if (!o.silent) this.sfx("ding", { gain: o.gain ?? 0.85, rate: o.rate ?? 1 })
  }
  // the badge. It is only ever given a bigger number.
  unread(n, dur = 0.01, ease = E.lin) {
    this.to(this.badge, "n", Math.max(n, this.badge.n), dur, ease)
  }
  // the ones that never stop: `rate` a second, from these LINES, with this sound (null: silent)
  stream(rate, pools, sound = "ding") {
    Object.assign(this.amb, { rate, sound, hold: false })
    if (pools) this.amb.pool = pools.flatMap((k) => LINES[k])
  }
  ambient() {
    const a = this.amb
    if (a.pool.length) this.pops.push({ name: "line:" + a.pool[(a.i * 7) % a.pool.length], t0: this.t, life: 1.7, pin: false })
    a.i++
    this.buzz = 1
    this.badge.punch = Math.max(this.badge.punch, 0.5)
    if (this.seeking || !a.sound) return
    const gain = clamp(0.42 / Math.sqrt(Math.max(a.rate, 1)), 0.12, 0.42)
    this.audio?.play(a.sound, { gain, rate: 0.9 + Math.random() * 0.45, pan: Math.random() * 0.7 - 0.35 })
  }
  hop(obj, h, dur = 0.35) {
    this.hops = this.hops.filter((o) => o.obj !== obj)
    this.hops.push({ obj, t0: this.t, dur, h })
  }
  // the studio audience, kept low
  crowd(name, gain = 0.3) {
    this.sfx(name, { bus: "tv", gain })
  }

  // ─── the timeline ─────────────────────────────────────────────────────────────
  // D: clip durations. W: for each announcer clip, [word, seconds] pairs.
  build(D, W) {
    const at = (t, fn) => {
      if (t != null && !Number.isNaN(t)) this.cues.at(t, fn)
    }
    const G = this.G
    const cam = this.cams[0]
    const office = this.cams.slice(1)
    const M = this.marks
    let cur = 0.7
    const clip = (name, dur = D[name], gap = GAP) => {
      const s = cur
      cur += dur + gap
      return s
    }
    // when the announcer says a word: the first of `words` that is in the clip, or null
    const w = (name, start, words, nth = 0) => {
      for (const c of [].concat(words)) {
        let k = 0
        for (const [text, sec] of W[name] || []) if (norm(text) === norm(c) && k++ === nth) return start + sec
      }
      return null
    }
    // the band says what he says: [word(s), chyron, colour, and anything else that happens then]
    const lines = (name, start, list) =>
      list.forEach(([words, text, col, fn]) =>
        at(w(name, start, words), () => {
          if (text) this.chy(text, col)
          fn?.()
        }),
      )
    const S = () => cam.S
    const tall = () => this.BH > this.BW
    // No arms. Doug works his phone with his head: he leans over and puts his forehead on it.
    // `dir` is which side the phone is on.
    const lean = (dir, k = 1) => ({ rot: 0.42 * dir * k, x: 34 * dir * k, y: 18 * k })
    const peck = (t0, dir, o = {}) =>
      at(t0, () => {
        this.doug(lean(dir), 0.09, E.out)
        this.doug(lean(dir, o.rest ?? 0), o.back ?? 0.16, E.io, 0.12)
        this.sfx("tap", { gain: 0.6, rate: o.rate ?? 1 })
      })
    // where the pitchman is, from where Doug sits
    const toPitch = () => (tall() ? { gx: -0.5, gy: 1 } : { gx: -1, gy: 0.3 })

    // ── tune in ─────────────────────────────────────────────────────────────────
    // (the sound of tuning in is the television's own: its channel key)
    at(0, () => {
      this.tube.static = 1
      this.to(this.tube, "static", 0, 0.55, E.in)
      this.tube.roll = 0.6
      this.to(this.tube, "roll", 0, 0.5, E.out)
      this.setLay("solo", 0.01)
      this.pitch({ in: 1 }, 0.5, E.back, 0.2)
    })

    // ── 0. "Got customers?" Doug buys one garden gnome ──────────────────────────
    const s0 = clip("s0")
    M.b0 = s0
    at(s0, () => this.say("s0", D.s0))
    lines("s0", s0, [
      ["folks", "FOLKS!"],
      ["got", "GOT CUSTOMERS?", YELLOW, () => {
        // …and here is one
        this.setLay("monitor", 0.5, E.out)
        this.cut("couch", {}, { gx: 0.9, gy: 0.45, smile: 0.35 })
      }],
      ["then", "THEN YOU SEND EMAIL!"],
      ["nightmail", null, null, () => {
        this.text("chy", "logo")
        this.sfx("sparkle", { bus: "tv", gain: 0.6 })
        G.sqv += 9
      }],
    ])
    const sj = clip("jingle", JINGLE, 0)
    at(sj, () => {
      this.handles.jingle = this.sfx("jingle", { bus: "tv", gain: 0.8 })
      this.pitch({ hype: 0.5 }, 0.3)
    })
    peck(sj + 0.5, 1)
    at(sj + 0.75, () => {
      S().lit = 1
      this.to(S(), "lit", 0.3, 1.5, E.io, 0.8)
      this.pop("card:order", JINGLE - 0.9)
      this.sfx("kaching", { gain: 0.55 })
    })
    at(sj + 1.15, () => {
      // a gnome! He does a happy hop. Then another.
      this.doug({ smile: 0.95, squint: 0.4, gx: 0.6, gy: 0.3, brow: 0.5 }, 0.15)
      this.hop(this.D, 44, 0.4)
    })
    at(sj + 1.7, () => this.hop(this.D, 30, 0.34))
    at(sj + JINGLE - 0.5, () => this.audio && !this.seeking && this.audio.fadeOut(this.handles.jingle, 0.5))
    at(sj + JINGLE - 0.1, () => {
      this.handles.bed = this.sfx("bed", { bus: "music", gain: 0.8, fadeIn: 0.4, loop: true })
      this.bedStart = this.t
    })

    // ── 1. "receipt, SENT!" The only email he is glad to get ────────────────────
    const s1 = clip("s1")
    M.b1 = s1
    at(s1, () => {
      this.say("s1", D.s1)
      this.chy("ONE LINE OF CODE!")
      this.readout("nightmail.send({ to: customer })")
      this.sfx("typing", { bus: "tv", gain: 0.5 })
      this.pitch({ hype: 0.1 }, 0.3)
      this.doug({ smile: 0.5, squint: 0, gx: 0.3, gy: 0.2, brow: 0 }, 0.3)
    })
    const sent = w("s1", s1, "sent") ?? s1 + D.s1 * 0.4
    at(sent, () => {
      this.chy("RECEIPT: SENT!", YELLOW)
      this.sfx("sent", { bus: "tv", gain: 0.6 })
    })
    at(sent + 0.2, () => {
      this.ring()
      this.unread(1)
      this.pop("card:receipt", 3.6)
      this.doug({ gx: 0.9, gy: 0.45 }, 0.12)
    })
    at(sent + 0.6, () => {
      this.doug({ smile: 0.9, squint: 0.35 }, 0.15)
      this.hop(this.D, 20, 0.3)
    })
    at(w("s1", s1, "accepted"), () => this.readout("202 ACCEPTED · 98 MS", CREAM, false))
    at(w("s1", s1, "tenth"), () => this.chy("0.1 SECONDS!"))

    // ── 2. "why send just ONE?" Four more. He turns the phone over. ─────────────
    const s2 = clip("s2")
    M.b2 = s2
    at(s2, () => {
      this.say("s2", D.s2)
      this.read = []
      this.doug({ smile: 0.6, squint: 0, gx: 0.2, gy: 0.15 }, 0.3)
    })
    lines("s2", s2, [
      ["twenty", "20¢ PER THOUSAND!", CREAM, () => {
        this.burst("tv:20¢", 1.9)
        this.crowd("cheer", 0.3)
      }],
      ["why", "WHY SEND JUST ONE?", YELLOW],
    ])
    // ding, ding, ding, ding, on the beat, and done before the line is
    const d0 = w("s2", s2, "at") ?? s2 + D.s2 * 0.4
    const step = clamp((s2 + D.s2 - 0.55 - d0) / 3, 0.25, 0.5)
    const faces = [
      { gx: 0.9, gy: 0.45, smile: 0.45 },
      { smile: 0.15, brow: 0.3 },
      { smile: -0.1, worry: 0.4, gx: -1, gy: 0.7 },
      { smile: -0.3, lid: 0.35, worry: 0, brow: -0.2, gx: 0.9, gy: 0.45 },
    ]
    faces.forEach((face, i) =>
      at(d0 + i * step, () => {
        this.ring()
        this.unread(2 + i)
        this.pop("card:ship" + (i + 1), 2.6)
        this.doug(face, 0.12)
        if (i === 2) {
          // "Your gnome was delivered!" He is. He's right there.
          this.to(S(), "gnome", 1, 0.25, E.back)
          this.sfx("pop", { gain: 0.6 })
        }
        if (i === 3) this.readout("4 EMAILS = $0.0008", CREAM, false)
      }),
    )
    peck(d0 + 3 * step + 0.22, 1) // enough. Face down.
    at(d0 + 3 * step + 0.32, () => {
      this.to(S(), "down", 1, 0.12, E.in)
      this.doug({ lid: 0.4, smile: -0.15, gx: 0, gy: 0.2 }, 0.2, E.io, 0.15)
    })

    // ── 3. "Put EVERYBODY on the newsletter!" 3:00 AM ───────────────────────────
    const s3 = clip("s3")
    M.b3 = s3
    at(s3, () => {
      this.say("s3", D.s3)
      this.read = []
      this.setLay("big", 0.45)
      this.cut("bedroom", { mode: 1, noise: 0.2, caption: "3:00 AM", cx: tall() ? 0.56 : 0.5 }, { lid: 1, smile: 0.2, autoBlink: 0, mouth: 0.12 })
      S().zzz = 1
      this.loop("snore", { gain: 0.45 })
      // the shipping updates have not stopped
      this.stream(1.1, ["ship"], "buzz")
      this.unread(37, D.s3 + GAP, E.in)
      this.pitch({ hype: 0.25 }, 0.3)
    })
    lines("s3", s3, [
      ["no", "NO PER-CONTACT PRICING!"],
      ["everybody", "EVERYBODY ON THE NEWSLETTER!", YELLOW, () => this.readout("LIST: EVERYBODY")],
      ["schedule", "SCHEDULE IT FOR ANY TIME!", CREAM, () => this.readout("SEND AT: 3:00 AM", CREAM)],
    ])
    const flare = () => {
      this.ring({ hold: 0.55 })
      cam.gain = 2.1
      this.to(cam, "gain", 1.15, 0.6, E.out)
    }
    const weekly = w("s3", s3, "newsletter") ?? s3 + D.s3 * 0.55
    at(weekly, () => {
      // the room goes white. Two eyes open.
      flare()
      this.pop("card:weekly")
      this.stopLoop("snore", 0.1)
      S().zzz = 0
      Object.assign(this.D, { lid: 0, wide: 1.3, shine: 1, mouth: 0, smile: 0, gx: -1, gy: 0.3 })
      this.D.sqv += 6
      this.stream(1.6, ["ship", "news"], "ding")
    })
    at(weekly + (s3 + D.s3 - weekly) * 0.42, () => {
      flare()
      this.pop("card:daily")
      this.to(S(), "up", 1, 0.18, E.back) // bolt upright
      this.crowd("laugh")
    })
    at(weekly + (s3 + D.s3 - weekly) * 0.84, () => {
      flare()
      this.pop("card:hourly")
      this.doug({ lid: 0.45, wide: 1, brow: -0.4, worry: -0.8 }, 0.2)
      this.readout("REPEAT: HOURLY")
    })

    // ── 4. "And you see EVERYTHING!" He hunts for the unsubscribe link. ─────────
    const s4 = clip("s4")
    M.b4 = s4
    const del = Math.max(w("s4", s4, "delivered") ?? 0, s4 + 0.4)
    const opn = Math.max(w("s4", s4, "opened") ?? 0, del + 0.5)
    const clk = Math.max(w("s4", s4, "clicked") ?? 0, opn + 0.4)
    const we = Math.max(w("s4", s4, "we") ?? 0, clk + 0.35) // the aside
    let email = null
    at(s4, () => {
      this.say("s4", D.s4)
      this.read = []
      this.stopLoop("snore", 0.1)
      // chin-deep in bubbles, and done with this
      this.cut("bath", { cy: 0.52, cx: tall() ? 0.56 : 0.5 }, { lid: 0.35, smile: -0.2, gx: 1, gy: 0.15, worry: -0.5, brow: -0.2 })
      S().stamps = []
      this.stream(2, ["ship", "news"])
      this.unread(212, clk - s4)
      this.heat = 0.12
      this.budget(0.42, 0.36)
      this.pitch({ hype: 0.4 }, 0.3)
    })
    lines("s4", s4, [
      ["everything", "YOU SEE EVERYTHING!"],
      ["delivered", "DELIVERED!"],
      ["opened", "OPENED!", YELLOW],
      ["clicked", "CLICKED!"],
    ])
    at(del, () => {
      this.ring({ hold: 0.6 })
      this.pop("card:news", opn - del)
      S().stamps.push({ text: "DELIVERED", t0: this.t })
    })
    peck(opn - 0.12, 1)
    at(opn, () => {
      // he opens it, and scrolls. There has to be a link down there somewhere.
      S().lit = 1
      S().stamps.push({ text: "OPENED", t0: this.t })
      this.trimPins()
      email = this.pop("email", Math.min(we + 1.5, s4 + D.s4 + GAP - 0.15) - opn, { win: 104, scroll: { k: 0 } })
      this.to(email.scroll, "k", 1, clk - opn - 0.14, E.io)
      this.sfx("whoosh", { gain: 0.3 })
      this.doug({ gy: 0.8, squint: 0.4 }, clk - opn - 0.14)
      G.sqv += 9
    })
    peck(clk - 0.12, 1)
    at(clk, () => {
      // there. "unsubscribe", in six-point grey. He gets it with his forehead.
      S().stamps.push({ text: "CLICKED", t0: this.t })
      if (email) email.tap = this.t
      this.doug({ smile: 0.35, squint: 0, worry: 0, brow: 0.2, lid: 0.2, gy: 0.15 }, 0.2, E.io, 0.15) // peace, at last
      G.sqv += 9
    })
    at(we - 0.12, () => {
      // An aside, thrown away: the one time the pitchman looks at the footage. Nothing stops for
      // it. He is back to camera before the line is over.
      const up = tall()
      this.pitch({ gx: up ? 0.5 : 1, gy: up ? -1 : -0.15, fx: up ? 0.1 : 0.2, lid: 0.42, brow: 0.5 }, 0.12) // smug
      this.pitch({ gx: 0, gy: 0, fx: 0, ...EASY }, 0.18, E.io, 0.75)
      this.text("chy", "tv:WE SAW YOU OPEN THAT.", CREAM, true)
    })
    at(we + 0.25, () => {
      // Doug heard it
      this.tw.list = this.tw.list.filter((t) => t.obj !== this.D)
      Object.assign(this.D, { wide: 1.3, lid: 0, smile: 0, brow: 0.6, squint: 0, worry: 0, x: 0, y: 0, rot: 0, autoBlink: 0 })
      this.D.sqv += 5
    })
    at(we + 0.45, () => {
      // …his eyes go to the pitchman, and so do the duck's, and down he goes until only they show
      this.doug({ ...toPitch(), fx: tall() ? -0.05 : -0.12 }, 0.18)
      this.to(S(), "duck", -1, 0.01, E.lin, 0.15)
      this.doug({ sink: 1 }, 0.55, E.io, 0.15)
      this.to(S(), "duckIn", 1, 0.6, E.io, 0.15)
    })

    // ── 5. "Customers write back? Answer them, INSTANTLY!" A first date. ────────
    const s5 = clip("s5")
    M.b5 = s5
    at(s5, () => {
      this.say("s5", D.s5)
      this.pitch({ gx: 0, gy: 0, fx: 0, rot: 0, dx: 0, ...EASY, hype: 0.7 }, 0.2)
      this.pitch({ hype: 0.3 }, 0.5, E.io, 1.2)
      if (!this.seeking) this.audio?.hush(1, 0.3)
      this.setLay("desk", 0.45)
      this.cut("date", {}, { gx: -0.8, gy: 0, smile: 0.7, fx: -0.1 })
      S().date = { x: 0, gx: 0.8, gy: 0, smile: 0.7, mouth: 0, lid: 0.1, brow: 0.2, talk: 1 }
      this.budget(0.4, 0.34)
      this.heat = 0.25
      this.unread(400, D.s5 + GAP)
      // the unsubscribe worked
      this.stream(3.5, ["minutely", "ship", "news"])
      this.ring()
      this.pop("card:moved", 2.3)
      this.doug({ gx: -0.9, gy: 0.6, smile: 0.2 }, 0.12, E.io, 0.15)
      this.doug({ gx: -0.8, gy: 0, smile: 0.6 }, 0.15, E.io, 0.55) // nothing. Go on.
    })
    at(s5 + 0.75, () => {
      // she stops; she finds the ceiling interesting
      const d = S().date
      d.talk = 0
      this.to(d, "gx", 1, 0.12)
      this.to(d, "gy", 0.5, 0.12)
      this.to(d, "gx", -0.4, 0.3, E.io, 0.4)
      this.to(d, "gy", -0.7, 0.3, E.io, 0.4)
      this.to(d, "smile", 0.3, 0.3)
    })
    // "please stop", one slow peck of the forehead at a time
    const back = w("s5", s5, "back") ?? s5 + D.s5 * 0.55
    const p0 = Math.max(s5 + 0.95, back - 1.7)
    const pstep = clamp((back - 0.2 - p0) / 3, 0.2, 0.42)
    const sentAt = p0 + 3 * pstep + 0.2
    const phoneAt = () => this.inShot(362, 366)
    const boardAt = () => [this.boardAt[0], this.boardAt[1]]
    at(p0 - 0.15, () => this.doug({ gx: -0.9, gy: 0.8, smile: 0, lid: 0.3, brow: -0.2 }, 0.15))
    for (let i = 0; i < 4; i++) peck(p0 + i * pstep, -1, { rest: i < 3 ? 0.5 : 0, back: 0.14, rate: 0.9 + i * 0.05 })
    at(sentAt, () => {
      // it leaves his phone, and his half of the screen, for the studio's inbox
      this.trimPins()
      this.fly("bub:please stop", phoneAt, boardAt, { hold: 0.28, dur: 0.45, s0: 1, s1: 0.8, arc: 90 })
      this.sfx("sent", { gain: 0.5 })
      this.doug({ gx: -0.8, gy: 0, lid: 0.1, smile: 0.5, brow: 0 }, 0.2) // there. Sorry. You were saying?
    })
    at(sentAt + 0.73, () => {
      // …where the pitchman could not be prouder of it
      this.board.msg = this.t
      this.sfx("pop", { bus: "tv", gain: 0.7 })
      this.pitch({ gx: 0.2, gy: -1, brow: 0.5 }, 0.15)
      G.sqv += 8
    })
    lines("s5", s5, [
      ["but", "BUT WAIT!"],
      ["more", "THERE'S MORE!", YELLOW],
      ["customers", "CUSTOMERS WRITE BACK?", CREAM, () => (this.board = { t0: this.t, mode: "inbox", msg: null, sent: null })],
      ["answer", "ANSWER THEM!", YELLOW],
      ["instantly", "INSTANTLY!"],
    ])
    const inst = Math.max(w("s5", s5, "instantly") ?? 0, sentAt + 1.1)
    // the answers shoot back the other way, into his footage
    ;["thanks", "also"].forEach((k, i) => {
      at(inst + i * 0.3, () => {
        if (i === 0) {
          this.board.sent = this.t
          this.pitch({ gx: 0, gy: 0, brow: EASY.brow }, 0.2)
        }
        this.fly("card:" + k, boardAt, phoneAt, { dur: 0.26, s0: 0.7, s1: 0.3, arc: 50 })
        this.sfx("whoosh", { bus: "tv", gain: 0.35, rate: 1.3 })
      })
      at(inst + i * 0.3 + 0.26, () => {
        this.ring({ hold: 0.5, rate: 1 + i * 0.12 })
        this.pop("card:" + k, 3)
        const d = S().date
        if (i === 0) {
          this.doug({ gx: -0.9, gy: 0.8, lid: 0.45, smile: -0.2 }, 0.15) // he has been thanked
          this.to(d, "gx", 0.8, 0.2)
          this.to(d, "gy", 0.2, 0.2)
        } else {
          this.to(d, "smile", -0.1, 0.3)
          this.to(d, "lid", 0.4, 0.3)
        }
      })
    })

    // ── 6. "Post every reply to Slack! The WHOLE TEAM can answer!" ──────────────
    const s6 = clip("s6")
    M.b6 = s6
    const slack = w("s6", s6, "slack") ?? s6 + D.s6 * 0.4
    const first = Math.max(w("s6", s6, "whole") ?? 0, slack + 0.45)
    const rstep = Math.min(0.26, (s6 + D.s6 + GAP - 0.6 - first) / 5)
    at(s6, () => {
      this.say("s6", D.s6)
      this.read = []
      this.stream(5, ["minutely", "ship", "reply"])
      this.unread(1040, D.s6 + GAP)
      this.heat = 0.4
      this.doug({ gx: -0.8, gy: 0, lid: 0.2, smile: 0.2 }, 0.3)
    })
    lines("s6", s6, [
      ["post", "POST EVERY REPLY TO SLACK!", CREAM, () => this.readout("RULE: REPLY → #SLACK")],
      ["whole", "THE WHOLE TEAM CAN ANSWER!", YELLOW],
    ])
    at(slack - 0.55, () => {
      // Gnome Depot's office, all six of them
      this.trimPins()
      this.budget(0.3, 0)
      this.setLay("split", 0.3)
      this.to(this, "split", 1, 0.3, E.out)
      this.to(cam, "cx", 0.523, 0.3)
      this.to(cam, "cy", tall() ? 0.7 : 0.5, 0.3)
    })
    office.forEach((c, i) =>
      at(slack - 0.45 + i * 0.07, () => {
        c.S = { who: i }
        c.a = 1
        c.glitch = 1
        this.to(c, "glitch", 0, 0.25, E.out)
        this.sfx("cut", { bus: "tv", gain: 0.2, rate: 1.3 + i * 0.08 })
      }),
    )
    at(slack, () => {
      // the studio's board: his reply, posted to #customer-replies
      this.board = { t0: this.t, mode: "slack", msg: this.t, sent: null }
      this.sfx("pop", { bus: "tv", gain: 0.6 })
      this.pitch({ gx: 0.2, gy: -1, brow: 0.5 }, 0.15)
      this.pitch({ gx: 0, gy: 0, brow: EASY.brow }, 0.2, E.io, 0.6)
    })
    TEAM.forEach((_, i) => {
      const r = first + i * rstep - 0.18
      at(r - 0.14, () => {
        office[i].S.typed = this.t
        this.sfx("typing", { bus: "tv", gain: 0.3, rate: 1.5 })
      })
      at(r, () => {
        // each of them answers, and each answer goes straight out to him
        this.replies[i] = this.t
        const cell = () => {
          const c = office[i].rect
          return c ? [c.x + c.w / 2, c.y + c.h * 0.8] : [0, 0]
        }
        this.fly("team:" + i, cell, phoneAt, { dur: 0.18, s0: 0.8, s1: 0.25, arc: 40 })
      })
      at(r + 0.18, () => {
        this.ring({ hold: 0.4, gain: 0.9, rate: 1 + i * 0.07 })
        const d = S().date
        if (i === 0) {
          Object.assign(this.D, { lid: 0, wide: 1.25, autoBlink: 0 })
          this.doug({ gx: -0.9, gy: 0.8, worry: 0.6, smile: -0.1 }, 0.1)
          this.D.sqv += 4
        }
        if (i === 1) {
          this.to(d, "gx", 1, 0.12)
          this.to(d, "gy", 0.5, 0.12)
        }
        if (i === 3) {
          this.to(d, "gx", 0.8, 0.15)
          this.to(d, "gy", 0, 0.15)
          this.to(d, "brow", 0.9, 0.15)
          this.doug({ gx: -0.8, gy: 0, smile: 0.5, worry: 0.9 }, 0.15) // ha. Ha. Work.
        }
        if (i === 5) {
          // she leaves the way a bean leaves: sideways, without a word
          this.to(d, "x", -460, 0.5, E.in)
          this.doug({ gx: -1, gy: 0, smile: -0.2, lid: 0.15 }, 0.25)
          this.crowd("ooh", 0.3)
        }
      })
    })

    // ── 7. "Angry customer? The AI knows! Send them MORE coupons!" A funeral. ───
    const s7 = clip("s7")
    M.b7 = s7
    const ai = Math.max(w("s7", s7, "ai") ?? 0, s7 + 1.2)
    const pct = Math.max(w("s7", s7, "ninetyseven") ?? 0, ai + 0.9)
    const send = Math.max(w("s7", s7, "send") ?? 0, pct + 0.8)
    const more = Math.max(w("s7", s7, "more") ?? 0, send + 0.5)
    const notice = Math.max(w("s7", s7, "coupons") ?? 0, more + 0.4)
    at(s7, () => {
      this.say("s7", D.s7)
      this.read = []
      this.board = null
      this.flies = []
      this.replies = []
      this.tw.list = this.tw.list.filter((t) => !(t.obj === this && t.key === "split"))
      this.split = 0
      for (const c of office) c.a = 0
      this.cut("chapel", { cy: 0.52 }, { lid: 0.3, gy: 0.7, gx: -0.9, smile: -0.3, worry: 0.7, brow: 0.2, autoBlink: 0 })
      Object.assign(S(), { m: [{ look: 0 }, { look: 0.5 }], ai: [], muffled: 1, sweat: 1 })
      this.budget(0.34, 0.3)
      // the mail has not stopped. It is under a hymn book.
      this.loop("organ", { gain: 0.4, fadeIn: 0.3 })
      this.loop("muffle", { gain: 0.8, fadeIn: 0.05 })
      this.stream(7, ["minutely", "ship", "reply", "team"], null)
      this.unread(9000, D.s7 + GAP, E.in)
      this.heat = 0
      this.pitch({ hype: 0.5 }, 0.3)
    })
    lines("s7", s7, [
      ["angry", "ANGRY CUSTOMER?"],
      ["ai", "THE AI KNOWS!", YELLOW],
      ["ninetyseven", "97%!"],
      ["send", "SEND MORE COUPONS!", YELLOW, () => this.readout("ACTION: SEND COUPONS")],
    ])
    at(s7 + 0.3, () => {
      // that's it. The book goes.
      this.doug(lean(-1), 0.08, E.out)
      this.to(S(), "book", 1, 0.45, E.out, 0.06)
      this.sfx("whoosh", { gain: 0.4 })
      this.stopLoop("muffle", 0.05)
      S().muffled = 0
      this.amb.sound = "buzz"
      this.heat = 0.5
      this.doug({ worry: -1, brow: -0.6, lid: 0.3, smile: -0.4 }, 0.1)
      for (const m of S().m) this.to(m, "look", 1, 0.2)
    })
    at(s7 + 0.5, () => {
      // STOP EMAILING ME, as a drum roll
      this.D.drum = 1
      this.sfx("typing", { gain: 0.8, rate: 1.9 })
    })
    at(ai - 0.12, () => {
      this.D.drum = 0
      this.doug(lean(-1, 0), 0.15)
      this.trimPins()
      this.pop("bub:STOP EMAILING ME", pct + 1.2 - ai)
      this.sfx("sent", { gain: 0.5 })
      this.doug({ gx: 0, gy: 0.1 }, 0.2)
    })
    at(ai, () => {
      S().scan = this.t
      this.sfx("pager", { bus: "tv", gain: 0.4 })
      const tags = [[0, "SAD 99%"], [1, "SAD 98%"], ["doug", "READING…"], ["gnome", "CALM 100%"]]
      tags.forEach(([i, label], k) => S().ai.push({ i, label, t0: this.t + 0.1 + k * 0.13 }))
      for (const m of S().m) this.to(m, "look", 0.2, 0.4)
    })
    at(pct, () => {
      Object.assign(S().ai.find((x) => x.i === "doug"), { label: "ANGRY 97%", red: true })
      this.sfx("pager", { bus: "tv", gain: 0.6, rate: 1.5 })
      this.readout("SENTIMENT: ANGRY 97%")
      this.D.twitch = 0.5
      this.to(this.D, "twitch", 0, 0.35, E.elastic)
    })
    at(send, () => {
      // for a moment, the chapel is silent
      this.amb.hold = true
      this.heat = 0
      this.stopLoop("organ", 0.25)
      this.doug({ gx: -0.9, gy: 0.7, worry: 0.4, brow: 0.3, lid: 0.15 }, 0.2) // did that work?
    })
    at(more, () => {
      // three coupons, at once, at full volume
      this.trimPins()
      ;["coupon1", "coupon2", "coupon3"].forEach((k, i) => this.pop("card:" + k, 4, { t0: this.t + i * 0.001 }))
      this.ring({ hold: 0.8, gain: 1 })
      this.sfx("ding", { gain: 1, rate: 1.26 })
      this.sfx("ding", { gain: 1, rate: 1.5 })
      this.post.shake = 0.3
      this.to(this.post, "shake", 0, 0.5)
      S().ai.find((x) => x.i === "doug").label = "ANGRY 99%"
      for (const m of S().m) this.to(m, "look", 1, 0.12)
      Object.assign(this.D, { wide: 1.3, lid: 0, worry: 0, brow: 0.5 })
      this.D.sqv += 6
      this.stream(10, ["coupon", "minutely", "team", "reply"], "ding")
      this.heat = 0.7
      this.crowd("laugh", 0.3)
    })
    at(notice, () => {
      // …and then he reads the small print in the corner of every one of them
      this.callout = { t0: this.t }
      this.doug({ wide: 1, lid: 0.4, squint: 0.6, brow: -0.7, worry: -1, smile: -0.5, gx: -0.9, gy: 0.7 }, 0.2)
      this.sfx("pager", { gain: 0.3, rate: 0.7 })
    })
    at(notice + 0.45, () => {
      // he looks, for the first time, at the man who has been talking all this while
      this.doug(toPitch(), 0.25)
      this.D.twitch = 0.5
      this.to(this.D, "twitch", 0, 0.35, E.elastic)
    })
    // ── 8. "Plug in your AI agents! Hundreds of robots…" They come for him. ─────
    const s8 = clip("s8")
    M.b8 = s8
    const dozens = Math.max(w("s8", s8, "agents") ?? 0, s8 + 1.15) // a few robots, then all of them
    const dr = Math.max((w("s8", s8, "hundreds") ?? 0) - 0.15, dozens + 0.45) // he leaves the funeral
    const ext = Math.max((w("s8", s8, "all") ?? 0) - 0.2, dr + 2.2) // he arrives
    const st = Math.max((w("s8", s8, "long") ?? 0) + 0.38, ext + 1.4) // back to the commercial
    const nm = Math.max(w("s8", s8, "nightmail") ?? 0, st + 0.4)
    const call = Math.max(w("s8", s8, "call") ?? 0, nm + 0.6)
    const hit = s8 + D.s8 // "Call n—"
    const pew = () => this.inShot(296, 300)
    at(s8, () => {
      // still at the funeral
      this.say("s8", D.s8)
      this.read = []
      this.callout = null
      this.trimPins()
      this.stream(12, ["bot", "coupon", "minutely", "team"], "ding")
      this.unread(99999, (ext - s8) * 0.92, E.in)
      this.heat = 1
      this.loop("bots", { gain: 0.3, fadeIn: 0.2 })
      this.pitch({ hype: 1 }, 0.3)
    })
    lines("s8", s8, [
      ["plug", "PLUG IN YOUR AI AGENTS!", CREAM, () => this.readout("AGENTS CONNECTED: 400")],
      ["hundreds", "HUNDREDS OF ROBOTS!", YELLOW],
      ["sending", "SENDING EMAIL!"],
      ["all", "ALL NIGHT LONG!", YELLOW],
    ])
    // one pops up in the pew. Then another. Then one right next to him. Each has something to send.
    ;[[0.08, -0.9, 0.9, "bot3", 150, 372], [0.42, 0.5, 0.9, "bot1", 494, 372], [0.76, 1, 0.1, "bot2", 506, 300]].forEach(([dt, gx, gy, card, x, y], i) => {
      const t0 = s8 + Math.min(dt, (dozens - s8) * (i / 3) + 0.08)
      at(t0, () => {
        this.to(S(), "bots", i + 1, 0.16, E.out)
        this.sfx("pop", { gain: 0.7, rate: 1.1 + i * 0.15 })
        Object.assign(this.D, { wide: 1.25, lid: 0, squint: 0, worry: 0.4, brow: 0.4 })
        this.doug({ gx, gy }, 0.1)
        this.D.sqv += 4
      })
      at(t0 + 0.14, () => this.fly("card:" + card, () => this.inShot(x, y), pew, { dur: 0.2, s0: 0.3, s1: 0.22, arc: 50 }))
      at(t0 + 0.34, () => {
        this.ring({ rate: 1 + i * 0.12 })
        this.pop("card:" + card, 2.4)
      })
    })
    at(dozens, () => {
      // and then the rest of them
      this.to(S(), "bots", 32, Math.max(0.3, dr - dozens - 0.1), E.out)
      this.sfx("pager", { gain: 0.5 })
      this.loop("buzz_storm", { gain: 0.3, fadeIn: 0.3 })
      this.post.shake = 0.3
      this.to(this.post, "shake", 0, 0.5)
      for (const m of S().m) this.to(m, "look", 0, 0.15)
      this.doug({ gx: 0, gy: -0.2, wide: 1.3 }, 0.12)
    })
    at(dr - 0.42, () => {
      // that does it
      this.doug({ ...ANGRY, wide: 1, gx: 0, gy: 0.05 }, 0.1)
      this.D.twitch = 0.5
      this.to(this.D, "twitch", 0, 0.3, E.elastic)
    })
    at(dr - 0.26, () => {
      this.hop(this.D, 34, 0.26)
      this.doug({ x: 440 }, 0.26, E.in)
    })
    at(dr, () => {
      // he drives. They follow.
      const span = ext - dr
      this.read = []
      this.setLay("takeover", 0.25)
      this.cut("drive", { cx: tall() ? 0.62 : 0.5 }, { ...ANGRY, gx: 0, gy: 0.05 })
      S().signs = [
        { text: "2 MI", t0: this.t + 0.05, dur: span * 0.37 },
        { text: "1 MI", t0: this.t + span * 0.32, dur: span * 0.37 },
        { text: "EXIT NOW", red: true, t0: this.t + span * 0.64, dur: span * 0.37 },
      ]
      this.to(S(), "pile", 1, span, E.in)
      this.to(S(), "bots", 1, span * 0.7)
      this.budget(0.5, 0.3)
      this.stream(14, ["bot", "coupon", "minutely", "team"], "ding")
      this.loop("engine", { gain: 0.5, fadeIn: 0.1 })
      // and the commercial is on the car radio
      this.radio("tinny")
      S().radio = 1
    })
    // He gets as far as "Hundreds of robots," and turns it off, with his head. It is back, and
    // louder, for "…email, ALL NIGHT LONG!", and it stays that way until he is through the door.
    const off = clamp((w("s8", s8, "sending") ?? dr + (ext - dr) * 0.5) - 0.25, dr + 0.7, ext - 1)
    const on = off + 0.55
    at(off - 0.45, () => this.doug({ gx: -1, gy: 0.9, lid: 0.5, squint: 0.7 }, 0.12)) // he looks at it
    at(off - 0.1, () => {
      this.doug({ rot: -0.8, x: -70, y: 68 }, 0.1, E.in)
      this.doug({ rot: 0, x: 0, y: 0 }, 0.22, E.io, 0.16)
    })
    at(off, () => {
      this.radio("off")
      S().radio = 0
      S().dent = this.t
      this.sfx("thud2", { gain: 0.9, rate: 1.3 })
      this.sfx("cut", { gain: 0.5, rate: 0.8 })
      this.cams[0].flash = 0.5
      this.to(this.cams[0], "flash", 0, 0.2)
    })
    at(off + 0.3, () => this.doug({ gx: 0, gy: 0.05, lid: 0.3, squint: 0.2, smile: 0.1, brow: 0 }, 0.2)) // quiet. Good.
    at(on, () => {
      // it comes back on. Louder.
      this.radio("loud")
      S().radio = 2
      this.sfx("cut", { gain: 0.6, rate: 1.4 })
      Object.assign(this.D, { wide: 1.3, lid: 0, squint: 0, smile: -0.2 })
      this.D.sqv += 7
      this.D.twitch = 0.6
      this.to(this.D, "twitch", 0, 0.35, E.elastic)
      this.doug({ gx: -1, gy: 0.9 }, 0.08)
      this.doug({ ...ANGRY, wide: 1, gx: 0, gy: 0.05 }, 0.25, E.io, 0.45)
    })
    at(dr + (ext - dr) * 0.64 + 0.3, () => {
      // EXIT NOW. He takes it.
      this.doug({ rot: 0.2, x: 18 }, 0.2, E.out)
      this.doug({ rot: 0, x: 0 }, 0.3, E.io, 0.3)
    })
    at(ext, () => {
      this.stopLoop("engine", 0.05)
      this.read = []
      this.cut("exterior", { cy: 0.5, cx: tall() ? 0.62 : 0.5 }, { ...ANGRY, gx: 1, gy: 0 })
      Object.assign(S(), { carx: -260, skid: this.t, dive: 0.1 })
      this.to(S(), "carx", 296, 0.4, E.out)
      this.to(S(), "dive", 0, 0.5, E.elastic, 0.36)
      this.to(S(), "horde", 1, st - ext - 0.2, E.lin, 0.2) // and here they come
      this.sfx("screech", { gain: 0.8 })
      this.unread(99999)
    })
    at(ext + 0.5, () => {
      // the car door does not survive
      S().door = this.t
      this.sfx("pop", { gain: 0.9, rate: 0.6 })
    })
    at(ext + 0.58, () => {
      S().out = true
      S().dx = 348
      this.hop(this.D, 46, 0.2)
    })
    ;[0, 1, 2].forEach((i) =>
      at(ext + 0.76 + i * 0.2, () => {
        this.hop(this.D, 30, 0.19)
        this.doug({ x: (i + 1) * 64 }, 0.19, E.lin)
      }),
    )
    at(ext + 1.36, () => {
      // in
      S().lit = 1
      this.to(S(), "lit", 0, 0.3)
      this.D.alpha = 0
    })
    at(st, () => {
      // the commercial, at full tilt. There is a door at the back of the set.
      this.set = { door: 0, doug: false, k: 0 }
      this.lay = { from: "studio", to: "studio", k: 1 }
      this.radio("open") // and the sound opens up: we are in the room with him
      cam.a = 0
      this.tube.static = 0.5
      this.to(this.tube, "static", 0, 0.2)
      this.sfx("cut", { bus: "tv", gain: 0.5 })
      this.read = []
      this.pitch({ hype: 1, gx: 0, gy: 0, ...EASY }, 0.1)
    })
    at(nm, () => {
      this.text("chy", "logo")
      this.sfx("sparkle", { bus: "tv", gain: 0.6 })
      G.sqv += 9
    })
    at(nm + 0.1, () => {
      // it opens
      this.to(this.set, "door", 1, 0.1, E.out)
      this.set.doug = true
      this.D = Object.assign(newDoug(), ANGRY, { gx: -0.7, gy: 0.05 })
      this.D.sqv += 7
      this.sfx("doorbang", { bus: "tv", gain: 1 })
      this.post.shake = 0.5
      this.to(this.post, "shake", 0, 0.4)
    })
    at(nm + 0.3, () => (this.lower = { t0: this.t }))
    at(call - 0.25, () => {
      this.D.sqv -= 9 // Doug winds up. The pitchman has not noticed a thing, and won't.
    })
    at(call, () => {
      this.chy("CALL N—", YELLOW)
      this.lower = null
      this.to(this.set, "k", 1, hit - call, E.in) // a body launch: no arms
    })
    // ── after "Call n—": what Doug does to the pitchman. On camera, all of it. ───
    // No arms, so it is body-slams and headbutts: [seconds after the tackle, what he lands on
    // ("p" the pitchman, "h" the bowler), how hard]. It goes on well past where it would stop.
    const HITS = [
      [0.5, "p", 1], [0.9, "p", 0.8], [1.25, "p", 0.8], [1.55, "p", 0.9], [1.8, "p", 0.7], [2.05, "p", 0.7], [2.3, "p", 0.8], [2.55, "p", 1.1],
      [3.5, "p", 1.2], [3.8, "p", 0.8], [4.05, "p", 0.8], [4.3, "p", 0.8], [4.55, "p", 1.1],
      [5.5, "p", 1.2], [5.75, "p", 0.9],
      [6.45, "h", 1], [6.75, "h", 1.1],
      [7.85, "p", 1.3],
    ]
    // (between the hat and the last one he stands on the hat for a moment, and listens)
    const plan = [{ t: hit, on: "p" }, ...HITS.map(([dt, on]) => ({ t: hit + dt, on })), { t: hit + 7.3, on: "h", idle: true }].sort((a, b) => a.t - b.t)
    at(hit, () => {
      // the audio cuts dead, and the camera pushes in
      this.silence()
      this.radio("open")
      this.lower = null
      this.set.doug = false
      this.atk = { t0: this.t, plan, n: 0, last: this.t, flat: 0, daze: 0, hat: null, crush: 0, mouth: 0, talk: 0, pop: 0, wob: { a: 0, v: 0 }, bursts: [], sparks: [], rest: null }
      this.setLay("attack", 0.22, E.out)
      this.D = Object.assign(newDoug(), ANGRY, { wide: 1.2, lid: 0.2 })
      this.strike(1.2)
    })
    HITS.forEach(([dt, on, power]) => at(hit + dt, () => this.strike(power, on)))
    // Three times the pitchman tries to go on with it, slower and quieter each time. He never
    // gets to the end of "Call now", and the third time he is unconscious.
    ;[[2.95, "callnow", 0.92, 0.8, "CALL N—"], [4.95, "callnow", 0.74, 0.55, "CALL…"], [7.02, "now", 0.66, 0.45, "…NOW…"]].forEach(([dt, clip, rate, gain, text]) =>
      at(hit + dt, () => {
        this.atk.talk = 1
        this.chy(text, YELLOW)
        this.handles.call = this.sfx(clip, { bus: "tv", gain, rate })
        this.doug({ squint: 0.7, lid: 0.5, wide: 1 }, 0.15) // Doug can't believe it either
      }),
    )
    at(hit + 5.75, () => (this.atk.daze = 2)) // he is out
    at(hit + 5.95, () => this.doug({ gx: 1, gy: 0.3, lid: 0.3, squint: 0.4 }, 0.2)) // …the hat
    at(hit + 7.1, () => this.doug({ gx: -1, gy: 0.5, lid: 0.55, squint: 0.8 }, 0.18)) // …he said what?
    const rest = hit + HITS[HITS.length - 1][0]
    at(rest + 0.15, () => {
      // the aftermath: a crooked camera, and Doug, out of breath, standing on what is left
      this.atk.rest = this.t
      this.fineKey = null
      this.to(this.tube, "tilt", tall() ? -0.05 : -0.09, 0.6, E.elastic)
      this.doug({ lid: 0.45, squint: 0, wide: 1, brow: -0.2, worry: -0.3, smile: -0.2, gx: 0, gy: 0.5 }, 0.5)
    })
    at(rest + 2.5, () => {
      // silence. And then one more.
      this.coupon = this.t
      this.sfx("ding", { gain: 1 })
      this.doug(tall() ? { gx: 0, gy: -1, lid: 0.15, wide: 1.15 } : { gx: 1, gy: -0.15, lid: 0.15, wide: 1.15 }, 0.35, E.io, 0.3) // he reads it
    })
    at(rest + 3.5, () => {
      this.D.twitch = 0.6
      this.to(this.D, "twitch", 0, 0.4, E.elastic)
    })
    this.length = rest + 5.8
    at(this.length, () => (this.ended = true))
    this.cues.sort()
  }

  // ─── update ───────────────────────────────────────────────────────────────────
  start(D, W, from = 0) {
    this.reset()
    this.tube.power = 1
    this.started = true
    this.audio?.hush?.(1, 0.01)
    this.audio?.radio?.("open", 0.01)
    this.build(D, W)
    if (from > 0) {
      this.seeking = true
      while (this.t < from) this.step(1 / 30)
      this.seeking = false
      for (const a of this.audioLog) {
        const dur = this.audio?.buf.get(a.name)?.duration ?? 0
        const off = this.t - a.t
        if (off < dur || a.o.loop) {
          const h = this.audio?.play(a.name, { ...a.o, offset: off })
          if (a.o.bus === "music") this.handles.bed = h
          if (a.o.bus === "voice") this.handles.voice = h
        }
      }
      for (const [name, o] of this.loops) this.audio?.loop(name, o)
      this.audio?.radio?.(this.radioMode, 0.01)
    }
  }

  step(dt) {
    this.t += dt
    const t = this.t
    if (this.started) this.cues.run(t)
    this.tw.step(t)
    const D = this.D
    const G = this.G
    // things that swing: the studio lights, the boom mic, a pitchman who has just been hit
    for (const s of [this.lamp, this.boom, this.atk && { ...this.atk.wob, k: 110, c: 5, ref: this.atk.wob }]) {
      if (!s) continue
      const o = s.ref || s
      o.v += (-o.a * s.k - o.v * s.c) * dt
      o.a += o.v * dt
    }
    if (this.atk) {
      this.atk.mouth = Math.max(0, this.atk.mouth - dt * 3)
      this.atk.pop += (this.atk.talk - this.atk.pop) * Math.min(1, dt * 14)
      this.atk.bursts = this.atk.bursts.filter((b) => t - b.t0 < 0.9)
      this.atk.sparks = this.atk.sparks.filter((b) => t - b.t0 < 0.6)
    }
    for (const o of [D, G]) {
      o.sqv += (-o.sq * 180 - o.sqv * 11) * dt
      o.sq += o.sqv * dt
    }
    this.hops = this.hops.filter((h) => {
      const k = (t - h.t0) / h.dur
      h.obj.hy = k >= 1 ? 0 : -4 * h.h * k * (1 - k)
      if (k >= 1) h.obj.sqv -= 5
      return k < 1
    })
    if (D.autoBlink && t > D.nextBlink) {
      D.nextBlink = t + 2.4 + this.rand() * 3
      this.to(D, "blink", 1, 0.07)
      this.to(D, "blink", 0, 0.1, E.io, 0.1)
    }
    // the pitchman talks when the announcer talks, and bounces on the beat
    const talking = t < this.talkUntil
    G.mouth = talking ? clamp(this.voice * 3.2, 0.05, 1.1) : lerp(G.mouth, 0, 0.2)
    const beat = this.bedStart ? ((t - this.bedStart) * 118) / 60 : t * 2
    if (Math.floor(beat) !== this.lastBeat) {
      this.lastBeat = Math.floor(beat)
      if (this.started && G.in > 0.5 && talking) G.sqv += 2 + G.hype * 5
    }
    // the ones that never stop
    this.buzz = Math.max(0, this.buzz - dt * 3.2)
    this.badge.punch = Math.max(0, this.badge.punch - dt * 5)
    const a = this.amb
    if (a.rate > 0 && !a.hold) {
      a.acc += dt * a.rate
      while (a.acc >= 1) {
        a.acc -= 1
        this.ambient()
      }
    }
    this.flies = this.flies.filter((f) => t - f.t0 < f.hold + f.dur)
    this.pops = this.pops.filter((p) => t - p.t0 < p.life + 0.3)
    if (this.pops.length > 24) this.pops = this.pops.filter((p, i) => p.pin || i > this.pops.length - 16)
  }

  // ─── layout: where the footage and the pitchman sit in the broadcast ─────────
  // The pitchman is always whole: he stands on the top edge of the band, hat to foot, and nothing
  // is ever in front of him. Beside the footage he has a column of his own, with the readout and
  // the board above his hat. On a phone he has the left of the strip under the footage and they
  // have the right. (sx, sy, sw: where the readout and the board go. ROOM and HALF: how much
  // of his own radius he needs above the band and to each side, bouncing.)
  layoutOf(name) {
    const W = this.BW
    const H = this.BH
    const P = H > W
    const band = P ? 104 : 118
    const L = { bezel: 1, band, pip: 0, sx: 26, sy: 46, sw: 300, dk: P ? 1.5 : 2.4 } // dk: how far off the door is, in pitchmen
    const stand = (R) => H - L.band - R - 2
    // his column. rows: readout lines to leave room for. board: and the inbox board.
    // squarish: on a phone the footage may be made smaller to leave him a decent size; keep it 4:3
    const column = (cap, rows, board, squarish) => {
      const floor = H - L.band
      if (P) {
        const under = () => L.fy + L.fh + 14 * L.bezel
        const short = ROOM * W * 0.14 - (floor - under() - 14)
        if (short > 0) {
          L.fh -= short
          if (squarish) {
            L.fx += (L.fw - L.fh / 0.75) / 2
            L.fw = L.fh / 0.75
          }
        }
        L.pR = Math.min(W * 0.2, (floor - under() - 14) / ROOM)
        L.px = 10 + HALF * L.pR
        L.sx = L.px + HALF * L.pR + 12
        L.sy = under() + 12
        L.sw = W - L.sx - 14
      } else {
        L.sx = 26
        L.sy = Math.max(46, L.fy + 8)
        L.sw = L.fx - 44
        const edge = L.fx - (L.bezel ? 31 : 12)
        L.pR = Math.min(cap, edge / (2 * HALF + 0.1), (floor - 10 - L.sy - rows * 40 - (board ? 174 : 0) - 6) / ROOM)
        L.px = edge / 2
      }
      L.py = stand(L.pR)
    }
    if (name === "standby") {
      L.band = 0
      L.fw = P ? W - 90 : W * 0.36
      L.fh = L.fw * 0.75
      L.fx = P ? 45 : W - L.fw - 84
      L.fy = P ? H - L.fh - 150 : H - L.fh - 104
      L.pR = H * 0.2
      L.px = W * 0.3
      L.py = H + L.pR * 2.4
    } else if (name === "solo" || name === "studio" || name === "attack") {
      // the pitchman alone (studio: a wider shot of the set, for the end. attack: pushed in on it)
      L.fw = P ? W - 36 : W * 0.5
      L.fh = L.fw * 0.75
      L.fx = W + 80
      L.fy = P ? 64 : 60
      L.pR = name === "studio" ? (P ? W * 0.21 : H * 0.235) : name === "attack" ? (P ? W * 0.26 : H * 0.25) : P ? W * 0.27 : H * 0.245
      L.px = name === "studio" ? W * (P ? 0.25 : 0.36) : name === "attack" ? W * (P ? 0.42 : 0.46) : W * 0.5
      if (P && name === "studio") L.dk = 2.34 // on a phone the door has the other half of the picture, so Doug isn't behind him
      if (P && name === "solo") {
        // on a phone the footage comes in over his head, so he leaves it the room it will need
        const m = this.layoutOf("monitor")
        Object.assign(L, { fw: m.fw, fh: m.fh, fy: m.fy })
        L.pR = Math.min(L.pR, (H - L.band - 8 - (m.fy + m.fh + 17)) / ROOM)
      }
      L.py = stand(L.pR)
    } else if (name === "monitor") {
      L.fw = P ? W - 44 : Math.min(W * 0.56, ((H - band - 76) * 4) / 3)
      L.fh = L.fw * 0.75
      L.fx = P ? 22 : W - L.fw - 46
      L.fy = P ? 46 : (H - band - L.fh) / 2
      column(H * 0.2, 3, false, true)
    } else if (name === "big") {
      L.fx = P ? 10 : W * 0.3
      L.fy = P ? 34 : 24
      L.fw = W - L.fx - (P ? 10 : 24)
      L.fh = P ? Math.min(H * 0.5, L.fw * 0.92) : H - band - 50
      column(H * 0.185, 3, false, false)
    } else if (name === "split" || name === "desk") {
      // the footage edge to edge, beside the pitchman (desk: he gets more room, for his board)
      L.band = P ? 96 : 100
      L.bezel = 0
      L.fx = P ? 0 : W * (name === "desk" ? 0.36 : 0.26)
      L.fy = 0
      L.fw = W - L.fx
      L.fh = P ? Math.min(H * 0.6, W * 0.84) : H - L.band
      column(H * 0.17, 1, true, false)
    } else {
      // takeover: the footage is the broadcast and the pitchman is a picture in the corner
      // (on a phone it stays a wide picture across the top, so nothing in it is cropped away)
      L.band = 0
      L.bezel = 0
      L.fx = 0
      L.fy = 0
      L.fw = W
      L.fh = P ? W * 0.95 : H
      L.pip = 1
      L.pR = P ? 64 : 52
      L.px = P ? 124 : 108
      L.py = H - (P ? 150 : 112)
      L.sx = P ? 20 : 30
      L.sy = L.fy + L.fh + 26
      L.sw = P ? W - 40 : Math.min(430, W - 60)
    }
    L.pops = P ? 0.86 : 1.06
    return L
  }
  layout() {
    const a = typeof this.lay.from === "string" ? this.layoutOf(this.lay.from) : this.lay.from
    const b = this.layoutOf(this.lay.to)
    const k = this.lay.k
    if (k >= 1) return b
    const o = {}
    for (const key of Object.keys(b)) o[key] = lerp(a[key], b[key], k)
    return o
  }
  // a shot's rect in the broadcast, and what part of its 640×480 it shows. When the office comes
  // up it takes one side of the footage (the top, on a phone) as a grid of six.
  camRect(cam, L) {
    const P = this.BH > this.BW
    const k = this.split
    const c = cam.cell
    const sub =
      c == null
        ? P ? { x: 0, y: 0.45 * k, w: 1, h: 1 - 0.45 * k } : { x: 0.42 * k, y: 0, w: 1 - 0.42 * k, h: 1 }
        : P ? { x: (c % 3) / 3, y: Math.floor(c / 3) * 0.225, w: 1 / 3, h: 0.225 } : { x: (c % 2) * 0.21, y: Math.floor(c / 2) / 3, w: 0.21, h: 1 / 3 }
    const gap = k > 0.001 ? 3 : 0
    return this.crop(L.fx + sub.x * L.fw + gap, L.fy + sub.y * L.fh + gap, sub.w * L.fw - gap * 2, sub.h * L.fh - gap * 2, cam.zoom, cam.cx, cam.cy)
  }
  crop(x, y, w, h, zoom, cx0, cy0) {
    const qa = w / h
    const ta = CW / CH
    const vw = ((qa > ta ? 1 : qa / ta) * CW) / zoom
    const vh = ((qa > ta ? ta / qa : 1) * CH) / zoom
    const cx = clamp(cx0 * CW, vw / 2, CW - vw / 2)
    const cy = clamp(cy0 * CH, vh / 2, CH - vh / 2)
    return { x, y, w, h, cx, cy, vis: { x0: cx - vw / 2, y0: cy - vh / 2, x1: cx + vw / 2, y1: cy + vh / 2 } }
  }
  // the door at the back of the set
  door(L) {
    const floor = this.BH - L.band
    const hw = L.pR * 0.62
    const hh = L.pR * 1.25
    return { x: L.px + L.pR * L.dk, y: floor - hh, hw, hh, floor }
  }

  // ─── drawing: the footage ─────────────────────────────────────────────────────
  dougBean(list, x, y, R, o = {}) {
    const D = this.D
    const sq = D.sq
    const sh = D.shiver ? Math.sin(this.t * 61) * 1.6 * D.shiver : 0
    const drum = D.drum ? Math.sin(this.t * 58) * D.drum : 0
    list.bean({
      x: x + sh + drum * 5,
      y: y - sq * R * 0.2 + D.hy + Math.abs(drum) * 9,
      R,
      rot: D.rot + drum * 0.09,
      sx: 1 - sq * 0.3,
      sy: 1 + sq * 0.45,
      kind: 2,
      alpha: D.alpha,
      gx: D.gx,
      gy: D.gy,
      lid: D.lid,
      blink: D.blink,
      brow: D.brow,
      worry: -D.worry, // ours: + is worried (brows up in the middle), − is cross; the shader's is the reverse
      smile: D.smile,
      mouth: D.mouth,
      wide: D.wide,
      squint: D.squint,
      twitch: D.twitch,
      fx: D.fx,
      fy: D.fy,
      shine: D.shine,
      ...o,
    })
  }
  feed(list) {
    const L = this.layout()
    this.L = L
    const out = []
    for (const cam of this.cams) {
      if (cam.a <= 0.001) continue
      const r = this.camRect(cam, L)
      cam.rect = r
      const first = list.n
      SCENES[cam.scene]?.(list, this, cam)
      caption(list, cam, r.vis)
      const u = new Float32Array(32)
      u.set([CW, CH, 1, this.t, ...(cam.clip || [0, 0, CW, CH]), cam.clipR || 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1])
      out.push({ tile: cam.tile, first, count: list.n - first, uniforms: u })
    }
    return out
  }
  quads(q) {
    let n = 0
    for (const cam of this.cams) {
      if (cam.a <= 0.001 || !cam.rect) continue
      const r = cam.rect
      const [tx, ty, tw, th] = TILES[cam.tile]
      q.set(
        [
          r.x, r.y, r.w, r.h,
          tx / FEED_W, ty / FEED_H, (tx + tw) / FEED_W, (ty + th) / FEED_H,
          cam.mode, 0, cam.noise, cam.zoom,
          r.cx / CW, r.cy / CH, cam.a, this.split > 0.001 ? 0 : 18 * this.L.bezel,
          cam.gain, cam.contrast, cam.glitch, cam.flash,
          cam.tile * 3.7, 240, 0, 0,
        ],
        n++ * QF,
      )
    }
    return n
  }

  // ─── drawing: the broadcast, behind the footage ───────────────────────────────
  bg(list) {
    const L = this.L
    const W = this.BW
    const H = this.BH
    const t = this.t
    if (this.started) {
      // the studio: burnt orange, with the arches every set had in 197-something
      list.rbox(W / 2, H / 2, W / 2 + 2, H / 2 + 2, 0, { col: [0.86, 0.36, 0.1, 1], rim: [0.6, 0.2, 0.07, 1] })
      const ax = L.px
      const ay = H - L.band
      const R = Math.max(L.pR, 90)
      const cols = [[0.97, 0.88, 0.7, 1], [0.94, 0.66, 0.14, 1], [0.38, 0.17, 0.07, 1], [0.97, 0.88, 0.7, 1]]
      cols.forEach((c, i) => list.ring(ax, ay, R * (1.72 + i * 0.36), R * 0.1, 0, 0, { col: c }))
      list.glow(ax, ay - R, R * 2.6, R * 2.6, [1, 0.8, 0.5, 0.16])
    } else this.testCard(list)
    // the set's monitor, where the footage plays
    if (L.bezel > 0.01 && L.fx < W) {
      const a = L.bezel
      const cx = L.fx + L.fw / 2
      const cy = L.fy + L.fh / 2
      list.glow(cx + 8, cy + 22, L.fw * 0.62, L.fh * 0.66, [0, 0, 0, 0.45 * a], false)
      list.rbox(cx, cy, L.fw / 2 + 17, L.fh / 2 + 17, 30, { col: [0.13, 0.065, 0.03, a] })
      list.rbox(cx, cy, L.fw / 2 + 13, L.fh / 2 + 13, 27, { col: [0.95, 0.88, 0.72, a], rim: [0.78, 0.68, 0.5, a] })
      list.rbox(cx, cy, L.fw / 2 + 4, L.fh / 2 + 4, 21, { col: [0.05, 0.035, 0.025, a] })
    }
    // behind several shots at once: black
    if (this.split > 0.001) list.rbox(L.fx + L.fw / 2, L.fy + L.fh / 2, L.fw / 2, L.fh / 2, 0, { col: [0.02, 0.018, 0.016, 1] })
    // the last shot: a door at the back of the set, and who comes through it
    const set = this.set
    if (set) {
      const d = this.door(L)
      // the studio lights, on their cables. They swing when anything lands.
      for (const [fx, len, ph] of [[0.16, 0.2, 0], [0.56, 0.15, 1.3]]) {
        const a = this.lamp.a * (ph ? 0.8 : 1) + Math.sin(t * 1.3 + ph) * 0.015
        const lx = W * fx + Math.sin(a) * H * len
        const ly = Math.cos(a) * H * len
        list.seg(W * fx, -10, lx, ly, 2, { col: [0.13, 0.065, 0.03, 1] })
        list.glow(lx + Math.sin(a) * 120, ly + 150, 190, 230, [1, 0.9, 0.7, 0.13])
        list.tri(lx, ly + 14, 30, 20, 0, { col: [0.13, 0.065, 0.03, 1], rot: -a })
        list.ellipse(lx - Math.sin(a) * 30, ly + 30, 24, 7, { col: [1, 0.95, 0.8, 1], rot: -a })
      }
      // ON AIR. It doesn't take the fight well.
      const a = this.atk
      const on = a ? (a.rest != null ? (Math.sin(t * 31) * Math.sin(t * 7.3) > 0.1 ? 1 : 0.12) : Math.sin(t * 43 + a.n) > -0.4 ? 1 : 0.2) : 0.7 + 0.3 * Math.sin(t * 9)
      list.glow(d.x, d.y - d.hh - 34, 110, 50, [1, 0.2, 0.1, 0.4 * on])
      list.rbox(d.x, d.y - d.hh - 34, 62, 18, 4, { col: [0.93 * on + 0.3 * (1 - on), 0.13 * on + 0.05, 0.08 * on + 0.03, 1], rim: [0.2, 0.09, 0.04, 1] })
      list.text("mono", "ON AIR", d.x, d.y - d.hh - 34, 0.72, 0.5, [1, 1, 1, 0.5 + 0.5 * on])
      for (const s of a ? a.sparks : []) {
        const age = t - s.t0
        list.glow(d.x, d.y - d.hh - 34, 150, 80, [1, 0.8, 0.4, 0.5 * (1 - age / 0.6)])
        for (let j = 0; j < 9; j++) {
          const h = Math.abs((Math.sin(s.seed * 12.9898 + j * 78.233) * 43758.5453) % 1)
          const ang = -2.6 + j * 0.26 + h * 0.3
          const sx = d.x + (j % 2 ? 50 : -50) + Math.cos(ang) * (120 + h * 160) * age
          const sy = d.y - d.hh - 34 + Math.sin(ang) * (120 + h * 160) * age + 900 * age * age
          list.star(sx, sy, 7 * (1.2 - age), 4, 0.3, { col: [1, 0.95, 0.6, 1 - age / 0.6], rot: age * 12 + j })
        }
      }
      list.rbox(d.x, d.y, d.hw + 11, d.hh + 11, 6, { col: [0.2, 0.09, 0.04, 1] })
      list.rbox(d.x, d.y, d.hw, d.hh, 3, { col: set.door > 0.01 ? [1, 0.96, 0.84, 1] : [0.93, 0.84, 0.66, 1] })
      if (set.door > 0.01) list.glow(d.x, d.y, d.hw * 2.4, d.hh * 1.5, [1, 0.95, 0.8, 0.3 * set.door])
      const pw = d.hw * (1 - 0.86 * set.door)
      list.rbox(d.x + d.hw - pw, d.y, pw, d.hh, 3, { col: set.door > 0.01 ? [0.62, 0.5, 0.36, 1] : [0.93, 0.84, 0.66, 1] })
      if (set.door < 0.5) {
        list.rbox(d.x, d.y, d.hw - 14, d.hh - 14, 2, { col: [0.74, 0.62, 0.44, 1], stroke: 1.5 })
        list.ellipse(d.x - d.hw + 16, d.y + 10, 5, 5, { col: [0.2, 0.09, 0.04, 1] })
      }
      if (set.doug) {
        const k = set.k
        const R0 = L.pR * 0.72
        const x = lerp(d.x, L.px + L.pR * 0.3, k)
        const y = lerp(d.floor - R0 * 1.04, L.py - L.pR * 0.1, k) - Math.sin(k * Math.PI) * L.pR * 0.7
        this.dougBean(list, x, y, lerp(R0, L.pR * 0.92, k), { rot: -k * 0.9 + this.D.rot, light: [1, 0.6, 0.25, 0.6], ldir: [-0.6, 0.6] })
      }
    }
  }
  // PLEASE STAND BY: before anyone tunes in
  testCard(list) {
    const W = this.BW
    const H = this.BH
    const P = H > W
    list.rbox(W / 2, H / 2, W / 2 + 2, H / 2 + 2, 0, { col: [0.075, 0.07, 0.065, 1] })
    const bars = [[0.8, 0.76, 0.66], [0.85, 0.66, 0.2], [0.42, 0.56, 0.5], [0.5, 0.56, 0.24], [0.74, 0.36, 0.34], [0.78, 0.33, 0.12], [0.24, 0.26, 0.4]]
    const bh = H * (P ? 0.2 : 0.3)
    bars.forEach((c, i) => list.rbox((W * (i + 0.5)) / 7, bh / 2, W / 14 + 0.6, bh / 2, 0, { col: [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 1] }))
    list.rbox(W / 2, bh + 5, W / 2, 5, 0, { col: [0.9, 0.86, 0.76, 1] })
    const lx = P ? W / 2 : 84 + (W * 0.5 - 84) / 2
    const lw = P ? W - 90 : W * 0.5 - 100
    const y0 = bh + (P ? 70 : 112)
    const s = Math.min(0.5, lw / 760)
    list.sprite("logo:flat", lx, y0, lw / 600, 0, [0.96, 0.94, 0.9, 1])
    list.text("mono", "PLEASE STAND BY", lx - lw / 2, y0 + 62, 0.72, 0, [1, 0.66, 0.2, 1])
    list.text("mono", "TONIGHT'S PROGRAMME: ONE MINUTE, WITH SOUND", lx - lw / 2, y0 + 96, s, 0, [0.6, 0.58, 0.54, 1])
    list.text("mono", "TURN THE DIAL TO TUNE IN", lx - lw / 2, y0 + 124, s, 0, [0.96, 0.94, 0.9, 0.55 + 0.45 * Math.sin(this.t * 3.2)])
  }

  // ─── drawing: the broadcast, in front of the footage ──────────────────────────
  // What Doug does to the pitchman, and to his hat. `g`: where the pitchman is ({ R, px, pcy,
  // psy, floor }). No arms: Doug goes up, turns over and comes down on him head first, from
  // one side and then the other, and the plan (a.plan) says when each one lands.
  attack(list, g) {
    const a = this.atk
    const t = this.t
    const P = this.BH > this.BW
    const { R, px, floor } = g
    const Rd = R * 0.8
    const top = g.pcy - R * g.psy // the top of the pitchman, such as it is
    // the bowler: off his head on the second blow, and down by the door
    const hx = px + R * (P ? 1.25 : 1.6)
    const hsx = lerp(1, 1.3, a.crush)
    const hsy = lerp(1, 0.3, a.crush)
    const hatTop = floor - R * 0.55 * hsy
    if (a.hat) {
      const u = clamp((t - a.hat.t0) / 0.85, 0, 1)
      const th = u * Math.PI * 4
      const x = lerp(px, hx, u)
      const y = lerp(top - R * 0.1, floor - R * 0.11 * hsy, u) - Math.sin(u * Math.PI) * R * 1.5
      const lx = -0.04 * R * hsx
      const ly = -0.97 * R * hsy
      list.bean({ x: x - (Math.cos(th) * lx - Math.sin(th) * ly), y: y - (Math.sin(th) * lx + Math.cos(th) * ly), R, rot: th, sx: hsx, sy: hsy, kind: 6, dent: a.crush > 0 ? 1 : 0, rim: [0, 0, 0, 0] })
    }
    // Doug. side: which side of the target he comes down on (1: the door's)
    const side = (i) => (i % 2 ? -1 : 1)
    const at = (i) => {
      if (i === 0) return [px + R * 0.3, top + R * 0.75]
      if (a.plan[i].idle) return [hx, hatTop - Rd * 0.9]
      return a.plan[i].on === "h" ? [hx - side(i) * Rd * 0.12, hatTop - Rd * 0.74] : [px + side(i) * R * 0.2, top - Rd * 0.74]
    }
    const turn = (i) => (i === 0 ? -0.9 : a.plan[i].idle ? 0 : -side(i) * (i % 3 === 1 ? 1.7 : 2.5))
    let i = 0
    while (i < a.plan.length - 1 && a.plan[i + 1].t <= t) i++
    let x, y, rot
    let pant = 0
    if (i < a.plan.length - 1) {
      // (onto the hat to listen: a short hop, and then he is still)
      const gap = a.plan[i + 1].idle ? 0.3 : a.plan[i + 1].t - a.plan[i].t
      const u = clamp((t - a.plan[i].t) / gap, 0, 1)
      const [x0, y0] = at(i)
      const [x1, y1] = at(i + 1)
      const up = 4 * u * (1 - u)
      x = lerp(x0, x1, u) + side(i + 1) * R * 0.25 * up
      y = lerp(y0, y1, u) - R * clamp(gap * 2.6, 0.55, 2.7) * up
      const r1 = turn(i + 1) + (gap > 0.6 ? Math.sign(turn(i + 1) - turn(i)) * Math.PI * 2 : 0)
      rot = lerp(turn(i), r1, u)
    } else {
      // and then he is done, and standing on him
      const u = clamp((t - a.plan[i].t) / 0.55, 0, 1)
      const [x0, y0] = at(i)
      x = lerp(x0, px, u)
      y = lerp(y0, top - Rd * 0.9, u) - R * 0.5 * 4 * u * (1 - u)
      rot = lerp(turn(i), 0, E.out(u))
      if (a.rest != null) pant = Math.sin((t - a.rest) * 8.5) * 0.05 * Math.exp(-(t - a.rest) * 0.22)
    }
    const sq = this.D.sq
    this.dougBean(list, x, y - Rd * pant, Rd, {
      rot: rot + this.D.rot,
      sx: Math.max(0.3, 1 - sq * 0.3) * (1 - pant * 0.6),
      sy: Math.max(0.3, 1 + sq * 0.45) * (1 + pant),
      mouth: a.rest != null ? 0.22 + pant * 3 : this.D.mouth,
      light: [1, 0.6, 0.25, 0.6],
      ldir: [-0.6, 0.6],
    })
    for (let j = 0; j < 3 && a.rest != null; j++) {
      // it was a lot of work
      const u = ((t - a.rest) * 0.6 + j * 0.37) % 1
      const dx = x + (j % 2 ? 1 : -1) * Rd * (0.5 + 0.2 * u + (j > 1 ? 0.12 : 0))
      const dy = y - Rd * 0.7 + u * u * Rd
      const s = Rd * 0.085 * (1 - u * 0.35)
      const al = Math.min(1, u * 8) * (1 - u * u * u)
      list.tri(dx, dy - s * 0.95, s * 0.5, s * 0.7, 0, { col: [0.72, 0.9, 1, al] })
      list.ellipse(dx, dy, s * 0.72, s * 0.8, { col: [0.72, 0.9, 1, al] })
    }
    // what comes off them each time: a flash, stars, and a lot of mail
    for (const b of a.bursts) {
      const age = t - b.t0
      const [bx, by] = b.on === "h" ? [hx, hatTop] : [px, top]
      if (age < 0.13) {
        const s = R * (0.5 + 0.5 * b.power) * (0.6 + age * 5)
        list.star(bx, by, s, 11, 0.5, { col: [1, 0.84, 0.3, 1], rot: b.seed })
        list.star(bx, by, s * 0.6, 11, 0.5, { col: [1, 1, 0.94, 1], rot: b.seed + 0.3 })
      }
      const u = age / 0.9
      for (let j = 0; j < 9; j++) {
        const h1 = (Math.sin(b.seed * 12.9898 + j * 78.233) * 43758.5453) % 1
        const h2 = (Math.sin(b.seed * 39.346 + j * 11.135) * 24634.6345) % 1
        const ang = -Math.PI / 2 + (j - 4) * 0.33 + h1 * 0.25
        const sp = R * (2.6 + Math.abs(h2) * 2.4) * b.power
        const fx = bx + Math.cos(ang) * sp * age
        const fy = by + Math.sin(ang) * sp * age + R * 4.2 * age * age
        const al = 1 - u * u
        if (j % 3 === 0) list.star(fx, fy, R * 0.09 * (1.3 - u), 5, 0.45, { col: [1, 0.84, 0.3, al], rot: age * 9 + j })
        else if (j % 3 === 1) list.sprite("mail", fx, fy, R / 150, age * (7 + h1 * 6) + j, [1, 1, 1, al])
        else list.sprite("mini", fx, fy, R / 105, age * (5 + h2 * 5) + j, [1, 1, 1, al])
      }
    }
  }
  type(list, name, x, y, s, maxW, rot, col) {
    const [w] = list.size(name)
    list.sprite(name, x, y, Math.min(s, maxW / Math.max(w, 1)), rot, col)
  }
  slam(it) {
    const k = clamp((this.t - it.t0) / 0.16, 0, 1)
    return it.soft ? { s: 0.62, a: clamp((this.t - it.t0) / 0.5, 0, 1) } : { s: lerp(1.5, 1, E.back(k)), a: clamp(k * 3, 0, 1) }
  }
  fg(list) {
    const L = this.L
    const W = this.BW
    const H = this.BH
    const t = this.t
    const P = H > W
    const G = this.G
    this.fgClip = null
    const over = L.band <= 1 // the footage is the whole picture
    const live = this.started && this.cams[0].a > 0.001 && L.fx < W
    const main = this.cams[0].rect
    const floor = H - L.band

    // the pitchman: standing on the band, or (once the footage has taken over) in a circle in the corner
    const R = L.pR
    this.clear = [] // what else is drawn in the broadcast, as [name, x0, y0, x1, y1]: none of it may touch him (smoke.ts)
    const a = this.atk
    const px = L.px + G.dx * (1 - L.pip)
    const py = L.py + G.hy + (1 - G.in) * (R * 2.6 + L.band) + L.pip * R * 0.35
    if (L.pip > 0.01) {
      const cr = L.pR * 1.5
      list.ellipse(L.px, L.py, cr + 5, cr + 5, { col: [0.97, 0.88, 0.7, L.pip] })
      list.ellipse(L.px, L.py, cr, cr, { col: [0.86, 0.36, 0.1, L.pip] })
      this.fgClip = [L.px - cr, L.py - cr, cr * 2, cr * 2, cr]
      list.flags = 2
      list.ring(L.px, L.py + cr * 0.9, cr * 1.25, cr * 0.09, 0, 0, { col: [0.94, 0.66, 0.14, L.pip] })
    }
    const sq = Math.min(G.sq, 0.36) // (he only stretches as far as the room he has: ROOM)
    // What is left of him once Doug gets there: every blow leaves him a little flatter
    const flat = a ? a.flat * (1 - 0.3 * a.pop) : 0
    const psx = Math.max(0.2, 1 - sq * 0.3) * (1 + flat * 0.55)
    const psy = Math.max(0.16, 1 + sq * 0.45) * (1 - flat * 0.7)
    // (his feet stay where they are: a bounce stretches him upwards, never down into the band)
    const pcy = a ? lerp(py + R, floor + R * 0.04, clamp(flat * 5, 0, 1)) - R * psy : lerp(py + R - R * psy, py - sq * R * 0.2, L.pip)
    const out = a && a.daze >= 2
    // the room he is taking up, hat included
    this.box = [px - R * 0.82 * Math.max(psx, 1), pcy - R * psy * 1.56, px + R * 0.82 * Math.max(psx, 1), pcy + R * psy]
    if (L.pip < 0.01 && !a) list.glow(px, py + R, R * 0.9, R * 0.1, [0, 0, 0, 0.4], false)
    if (px > -R * 3) {
      // Until then he is a showman, and nothing has ever gone wrong for him: an easy grin with
      // all his teeth in it, relaxed lids, level brows, and his eyes on the camera.
      list.bean({
        x: px,
        y: pcy,
        R,
        rot: G.rot + Math.sin(t * 2.2) * 0.04 + (a ? a.wob.a * 0.5 : 0),
        sx: psx,
        sy: psy,
        kind: a?.hat ? 2 : 1, // 2: the bowler has left him
        askew: a ? 0.3 : 0,
        dents: a ? clamp((a.n - 1) / 11, 0, 1) : 0,
        daze: a ? a.daze : 0,
        gx: a ? 0.2 : G.gx,
        gy: a ? -1 : G.gy,
        lid: a ? 0 : G.lid,
        blink: !a && t % 3.7 < 0.11 ? 1 : 0,
        brow: a ? 0.9 : G.brow + G.hype * 0.15,
        worry: a ? -1 : 0.14,
        smile: a ? (a.pop > 0.5 ? 0.7 : out ? -0.15 : -0.6) : G.smile,
        mouth: a ? (a.pop > 0.5 ? 0.25 + 0.5 * Math.abs(Math.sin(t * 19)) : out ? 0 : a.mouth * 0.9) : Math.max(G.mouth, 0.32),
        wide: a ? 1.35 : G.wide + G.hype * 0.05,
        fx: G.fx,
        rim: [1, 0.93, 0.8, 1],
        light: [1, 0.55, 0.2, 0.5],
        ldir: [-0.6, 0.6],
        mw: 1.3,
      })
    }
    list.flags = 0
    if (a) this.attack(list, { R, px, pcy, psy, floor })

    // who that is, in the doorway
    if (this.lower && this.set) {
      const d = this.door(L)
      const k = E.out(clamp((t - this.lower.t0) / 0.18, 0, 1))
      const left = Math.max(d.x - d.hw - 78, L.px + R * HALF + 10) // it stops short of the pitchman
      const hw = (d.x + d.hw + 78 - left) / 2
      const x = left + hw + (1 - k) * W * 0.5
      this.clear.push(["lower third", x - hw, d.floor - 43, x + hw, d.floor - 5])
      const y = d.floor - 24
      list.rbox(x, y, hw, 17, 0, { col: [0.03, 0.025, 0.02, 0.94] })
      list.rbox(x, y - 17, hw, 1.5, 0, { col: [0.97, 0.88, 0.7, 1] })
      list.rbox(x, y + 17, hw, 1.5, 0, { col: [0.94, 0.66, 0.14, 1] })
      this.type(list, "tv:DOUG — ACTUAL RECIPIENT", x, y - 1, 0.4, hw * 2 - 16, 0, CREAM)
    }
    // The boom mic: a pole in from the top corner, and the mic on the end of it. It swings when
    // anything lands, and by the end whoever was holding it has let it drop.
    if (this.set) {
      const drop = a?.rest != null ? E.out(clamp((t - a.rest) / 0.8, 0, 1)) : 0
      const tx = L.px - R * (P ? 1.2 : 1.45)
      const ty = H * (0.05 + 0.13 * drop)
      const ang = clamp(this.boom.a * 0.6, -1.1, 1.1) + Math.sin(t * 1.1) * 0.03
      const len = R * 0.42
      const mx = tx + Math.sin(ang) * len
      const my = ty + Math.cos(ang) * len
      list.seg(tx - R * 1.6, ty - R * 0.75, tx, ty, 4, { col: [0.1, 0.05, 0.03, 1] })
      list.seg(tx, ty, mx, my, 1.6, { col: [0.1, 0.05, 0.03, 1] })
      list.rbox(mx + Math.sin(ang) * R * 0.17, my + Math.cos(ang) * R * 0.17, R * 0.1, R * 0.2, R * 0.1, { col: [0.3, 0.29, 0.3, 1], rim: [0.6, 0.58, 0.56, 1], rot: -ang })
      list.rbox(mx, my, R * 0.05, R * 0.035, 2, { col: [0.1, 0.05, 0.03, 1], rot: -ang })
    }

    // the band along the bottom, where the type lands
    if (!over) {
      list.rbox(W / 2, floor + L.band / 2 + 4, W / 2 + 2, L.band / 2 + 4, 0, { col: [0.2, 0.09, 0.04, 1], rim: [0.11, 0.05, 0.02, 1] })
      list.rbox(W / 2, floor + 3, W / 2 + 2, 3, 0, { col: [0.97, 0.88, 0.7, 1] })
      list.rbox(W / 2, floor + 10, W / 2 + 2, 2.5, 0, { col: [0.94, 0.66, 0.14, 1] })
    } else if (this.started) list.glow(W / 2, H + 20, W * 0.9, 130, [0, 0, 0, 0.8], false)
    if (this.coupon != null) {
      // one more: beside him, over the door he came in by (on a phone, over his head)
      const k = E.back(clamp((t - this.coupon) / 0.25, 0, 1))
      const d = this.door(L)
      const s0 = P ? Math.min(1.2, (W - 110) / 330) : 1.05
      const s = s0 * k
      const x = P ? W / 2 - 8 : L.px + R * 0.8 + 178 * s0
      const y = P ? floor - R * 3.3 : d.y - R * 0.15
      list.glow(x + 6, y + 12, 200 * s, 60 * s, [0, 0, 0, 0.5], false)
      list.sprite("card:last", x, y, s, -0.03, WHITE)
      list.sprite("mail", x + 132 * s, y - 42 * s, s * 0.62, 0.1, WHITE)
      const tw = list.measure("badge", "99,999+", s * 0.6)
      list.rbox(x + 140 * s, y - 58 * s, tw / 2 + 6 * s, 8 * s, 8 * s, { col: [0.93, 0.13, 0.08, 1] })
      list.text("badge", "99,999+", x + 140 * s, y - 58 * s, s * 0.6, 0.5, WHITE)
    }
    const chy = this.texts.chy
    if (chy) {
      const { s, a } = this.slam(chy)
      const under = L.fy + L.fh // on a phone the taken-over footage leaves room beneath it
      const x = over && !P ? W / 2 + 80 * L.pip : W / 2
      const k = (!over ? L.band / 118 : 1) * (P ? 0.66 : 0.88)
      const maxW = (W - (over && !P ? 50 + 290 * L.pip : 50)) * s
      const [cw, ch] = list.size(chy.name)
      const half = (ch * Math.min(k * s, maxW / Math.max(cw, 1))) / 2
      // in the band it lands big, but it stays in the band: the pitchman is standing on top of it
      const y = !over ? Math.max(H - L.band * 0.58, floor + 12 + half) : P ? (under < H - 200 ? under + (H - under) * 0.42 : H - 250) : H - 86
      this.type(list, chy.name, x, y - 4, k * s, maxW, chy.soft ? 0 : -0.012, [chy.col[0], chy.col[1], chy.col[2], a])
      if (cw) this.clear.push(["chyron", x - (cw * half) / ch, y - 4 - half * 0.86, x + (cw * half) / ch, y - 4 + half])
    }
    if (this.fineKey) {
      const a = clamp((t - this.fineT) / 0.3, 0, 1)
      const x = over && !P ? W / 2 + 80 * L.pip : W / 2
      this.type(list, "fine:" + this.fineKey, x, H - 23, 0.95, W - (over ? 70 + 340 * L.pip : 70), 0, [1, 0.95, 0.84, a])
    }
    // the studio's readout, and whatever graphic it's holding up
    const n = this.read.length
    const colW = L.sw
    const x0 = L.sx
    const y0 = over && !(P && L.fy + L.fh < H - 200) ? L.py - L.pR * 1.5 - 40 * n - 6 : L.sy
    if (live || !this.set)
      this.read.forEach((r, i) => {
        const typed = r.typed ? Math.floor((t - r.t0) * 38) : r.text.length
        const str = r.text.slice(0, typed)
        const s = Math.min(0.8, (colW - 22) / list.measure("mono", r.text, 1))
        const a = clamp((t - r.t0) / 0.1, 0, 1)
        const y = y0 + 8 + i * 40
        const tw = list.measure("mono", r.text, s) + 22
        this.clear.push(["readout", x0, y - 17, x0 + tw, y + 17])
        list.rbox(x0 + tw / 2, y, tw / 2, 17, 0, { col: [0.13, 0.06, 0.03, 0.92 * a] })
        list.text("mono", str, x0 + 11, y, s, 0, [r.col[0], r.col[1], r.col[2], a])
        if (r.typed && typed < r.text.length + 12 && Math.floor(t * 8) % 2) list.rbox(x0 + 11 + list.measure("mono", str, s) + 6, y, 5, 9, 0, { col: [r.col[0], r.col[1], r.col[2], a] })
      })
    // the studio's inbox board: where what Doug writes back ends up, and where the answers leave from
    const b = this.board
    if (b && !over) {
      const k = E.back(clamp((t - b.t0) / 0.22, 0, 1))
      const bw = colW
      const bh = (P ? 132 : 158) * k
      const bx = x0 + bw / 2
      const by = y0 + n * 40 + 16 + bh / 2
      const slack = b.mode === "slack"
      this.clear.push(["board", bx - bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2])
      list.glow(bx + 5, by + 10, bw * 0.6, bh * 0.7, [0, 0, 0, 0.45], false)
      list.rbox(bx, by, bw / 2, bh / 2, 9, { col: [0.95, 0.88, 0.72, 1] })
      list.rbox(bx, by, bw / 2 - 5, bh / 2 - 5, 5, { col: [0.07, 0.05, 0.04, 1] })
      const hy = by - bh / 2 + 24 * k
      list.text("mono", slack ? "#CUSTOMER-REPLIES" : "INBOX", bx - bw / 2 + 16, hy, Math.min(0.62, (bw - 120) / list.measure("mono", slack ? "#CUSTOMER-REPLIES" : "INBOX", 1)), 0, AMBER)
      const got = b.msg != null
      const pill = slack ? "POSTED" : got ? "1 NEW" : "0 NEW"
      const pw = list.measure("mono", pill, 0.46) + 14
      const hot = got && (slack || Math.floor(t * 5) % 2 === 0 || t - b.msg > 1)
      list.rbox(bx + bw / 2 - 14 - pw / 2, hy, pw / 2, 11, 0, { col: hot ? [0.93, 0.13, 0.08, 1] : [0.25, 0.2, 0.16, 1] })
      list.text("mono", pill, bx + bw / 2 - 14 - pw / 2, hy, 0.46, 0.5, WHITE)
      list.rbox(bx, hy + 17 * k, bw / 2 - 12, 0.8, 0, { col: [0.95, 0.88, 0.72, 0.4] })
      const my = by + 16 * k
      this.boardAt = [bx, my, bw]
      if (got) {
        const name = slack ? "slack" : "bub:please stop"
        const [sw, sh] = list.size(name)
        const pk = E.back(clamp((t - b.msg) / 0.2, 0, 1))
        const s = Math.min(slack ? 1 : 1.15, (bw - 28) / sw) * pk * k
        list.sprite(name, bx, my - (slack ? 0 : 8), s, 0, WHITE)
        if (!slack) {
          const note = b.sent != null ? "ANSWERED IN 0.1 S" : "FROM: A CUSTOMER"
          list.text("mono", note, bx, my + (sh * s) / 2 + 6, 0.46, 0.5, b.sent != null ? CREAM : [0.6, 0.55, 0.5, 1])
        }
      }
    }
    // a price, in a starburst
    if (this.star && t < this.star.until + 0.3) {
      const k = clamp((t - this.star.t0) / 0.2, 0, 1)
      const out = clamp((t - this.star.until) / 0.25, 0, 1)
      const s = E.back(k) * (1 - out)
      // (at the top of his column, clear of his hat; on a phone, beside him)
      const sr0 = P ? Math.min(74, (ROOM * L.pR - 70) / 2.3) : 62
      const sr = sr0 * s
      const sx = P ? L.sx + L.sw / 2 : L.sx + L.sw - sr0 * 1.15 - 6
      const sy = P ? L.sy + 56 + sr0 * 1.15 : L.sy + sr0 * 1.15 - 12
      this.clear.push(["star", sx - sr * 1.15, sy - sr * 1.15, sx + sr * 1.15, sy + sr * 1.15])
      list.star(sx, sy, sr * 1.15, 14, 0.8, { col: [0.2, 0.09, 0.04, 1], rot: t * 0.5 })
      list.star(sx, sy, sr, 14, 0.8, { col: [1, 0.8, 0.16, 1], rot: t * 0.5 })
      this.type(list, this.star.name, sx, sy, 0.7 * s, sr * 1.5, -0.1, WHITE)
    }
    // what each of the office said, in their own picture
    this.cams.forEach((c, i) => {
      const at = this.replies[i - 1]
      if (i === 0 || c.a < 0.5 || at == null || !c.rect) return
      const r = c.rect
      const [w, h] = list.size("team:" + (i - 1))
      const sc = Math.min((r.w - 10) / w, (r.h * 0.4) / h) * E.back(clamp((t - at) / 0.18, 0, 1))
      list.sprite("team:" + (i - 1), r.x + r.w / 2, r.y + r.h - (h * sc) / 2 - 5, sc, 0, WHITE)
    })
    if (main && live) {
      const edge = L.bezel > 0.5 ? 15 : 24
      // Doug's phone, legibly. The ones he is meant to read are pinned at the top left of the
      // footage, newest first; the ones that never stop pile up underneath them.
      const s = L.pops
      const top = main.y + edge
      const budget = main.h * this.popBudget
      let y = top
      let pinTop = null
      const order = [...this.pops.filter((p) => p.pin).reverse(), ...this.pops.filter((p) => !p.pin).reverse()]
      for (const p of budget > 1 ? order : []) {
        const age = t - p.t0
        if (age < 0) continue
        const kin = E.out(clamp(age / 0.18, 0, 1))
        const out = clamp((age - p.life) / 0.25, 0, 1)
        const [w, fullH] = list.size(p.name)
        const h = p.win ?? fullH
        const bub = p.name.startsWith("bub:")
        const sc = s * (bub ? 1.1 : 1)
        const hp = h * sc
        const full = p.pin ? 0 : clamp((y + hp - top - budget) / hp, 0, 1)
        const a = (1 - out) * kin * (1 - full)
        if (a > 0.01) {
          const x = bub ? main.x + edge + 312 * s - (w * sc) / 2 : main.x + edge + (w * sc) / 2
          const yy = y + hp / 2 - (1 - kin) * hp * 0.5
          list.glow(x + 4, yy + 6, w * sc * 0.55, hp * 0.8, [0, 0, 0, 0.4 * a], false)
          if (p.win && L.pip < 0.01) {
            // an opened email: a window on something much longer
            this.fgClip = [x - (w * sc) / 2, yy - hp / 2, w * sc, hp, 9 * sc]
            list.flags = 2
            list.sprite(p.name, x, yy - hp / 2 + (fullH * sc) / 2 - p.scroll.k * (fullH - h) * sc, sc, 0, [1, 1, 1, a])
            list.flags = 0
            if (p.tap != null) {
              const u = clamp((t - p.tap) / 0.5, 0, 1)
              list.ellipse(x, yy + hp / 2 - 12 * sc, (22 + u * 30) * sc, (8 + u * 10) * sc, { col: [1, 0.66, 0.2, 1 - u], stroke: 2.5 })
            }
          } else list.sprite(p.name, x, yy, sc, 0, [1, 1, 1, a])
          if (p.pin && !bub && !pinTop) pinTop = { x: x - (w * sc) / 2, y: yy - hp / 2, sc }
        }
        if (full >= 1) break
        y += (hp + 6 * s) * kin * (1 - out)
      }
      // the small print in the corner of every one of them
      if (this.callout && pinTop) {
        const k = E.back(clamp((t - this.callout.t0) / 0.25, 0, 1))
        const tx = pinTop.x + 268 * pinTop.sc
        const ty = pinTop.y + 19 * pinTop.sc
        const cs = (P ? 0.56 : 1.15) * k
        const tw = list.measure("mono", "via NIGHTMAIL", cs) + 28
        const bx = pinTop.x + 312 * pinTop.sc + 30 + tw / 2
        list.ellipse(tx, ty, 42 * pinTop.sc, 12 * pinTop.sc, { col: AMBER, stroke: 2.5 })
        list.seg(tx + 42 * pinTop.sc, ty, bx - tw / 2, ty + 4, 1.6, { col: AMBER })
        list.rbox(bx, ty + 4, tw / 2, 24 * k, 0, { col: [0.13, 0.06, 0.03, 0.96] })
        list.rbox(bx, ty + 4, tw / 2, 24 * k, 0, { col: AMBER, stroke: 2 })
        list.text("mono", "via NIGHTMAIL", bx, ty + 4, cs, 0.5, AMBER)
      }
      // the mail app, and its badge, at the top right
      const bs = P ? 1 : 1.3
      const ix = main.x + main.w - edge - 30 * bs
      const iy = main.y + edge + 36 * bs
      list.glow(ix + 3, iy + 5, 34 * bs, 34 * bs, [0, 0, 0, 0.4], false)
      list.sprite("mail", ix, iy, bs, 0, WHITE)
      if (this.badge.n >= 1) {
        // it hangs off the icon's top right corner and grows to the left
        const str = count(this.badge.n)
        const ps = bs * (1 + this.badge.punch * 0.25)
        const tw = list.measure("badge", str, ps)
        const right = ix + 30 * bs
        const by = iy - 22 * bs
        list.rbox(right - tw / 2 - 8 * ps, by, tw / 2 + 8 * ps, 12.5 * ps, 12.5 * ps, { col: [0.93, 0.13, 0.08, 1] })
        list.text("badge", str, right - 8 * ps, by, ps, 1, WHITE)
      }
    }
    // whatever is crossing between the footage and the commercial
    for (const f of this.flies) {
      const age = t - f.t0
      const e = E.io(clamp((age - f.hold) / f.dur, 0, 1))
      const k0 = f.hold ? E.back(clamp(age / 0.16, 0, 1)) : 1
      const [ax, ay] = f.from()
      const [bx, by] = f.to()
      const x = lerp(ax, bx, e)
      const y = lerp(ay - (f.hold ? 44 * k0 : 0), by, e) - Math.sin(e * Math.PI) * f.arc
      const s = lerp(f.s0, f.s1, e) * k0
      const [fw, fh] = list.size(f.name)
      list.glow(x + 4, y + 8, fw * s * 0.55, fh * s * 0.8, [0, 0, 0, 0.4], false)
      list.sprite(f.name, x, y, s, Math.sin(e * Math.PI) * 0.1, WHITE)
      this.clear.push(["in flight", x - (fw * s) / 2, y - (fh * s) / 2, x + (fw * s) / 2, y + (fh * s) / 2])
    }
    if (live) this.clear.push(["footage", L.fx - 17 * L.bezel, L.fy - 17 * L.bezel, L.fx + L.fw + 17 * L.bezel, L.fy + L.fh + 17 * L.bezel])
    if (!over) this.clear.push(["band", 0, floor, W, H])
    if (this.fade > 0) list.rbox(W / 2, H / 2, W / 2 + 2, H / 2 + 2, 0, { col: [0, 0, 0, this.fade] })
  }
}
