// The commercial as a picture and a sound for another television: /cheaper/y's set shows the
// broadcast on its own tube (its scanlines, static and room light) and plays the sound through its
// own speaker. Nothing here loads before that set's channel 8 is first pressed.
//
// start() gets ready what the first seconds need (the faces, the atlas of type and emails, the
// GPU's pipelines, the first clips) and resolves when the first frame can be shown: the set shows
// static until then. The show's clock is the sound's (the set's AudioContext), so picture and
// sound cannot drift apart, and both stand still while the tab is hidden.
import { buildAtlas } from "./atlas.js"
import { AudioEngine } from "./audio.js"
import { Gpu, QF } from "./gpu.js"
import { List } from "./list.js"
import { Show } from "./show.js"

const BASE = "/commercial/"
// The broadcast's own size: 4:3, so the show lays itself out as it would on a set like this one.
// The picture it is drawn into is smaller or larger as the tube needs (frame's width).
const BW = 960
const BH = 720
const STEP = 1 / 60

// The show's faces, Latin only (anything else is drawn in the system's font either way). Added to
// the document once, on the first showing.
const RANGE = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"
const FACES = [
  ["Inter Variable", "inter-latin-wght-normal.woff2", "100 900"],
  ["Bungee", "bungee-latin-400-normal.woff2", "400"],
  ["IBM Plex Mono", "ibm-plex-mono-latin-500-normal.woff2", "500"],
  ["IBM Plex Mono", "ibm-plex-mono-latin-600-normal.woff2", "600"],
]
let faces = null
const loadFaces = () =>
  (faces ??= Promise.all(
    FACES.map(([family, file, weight]) => {
      const face = new FontFace(family, `url(${BASE}fonts/${file})`, { weight, unicodeRange: RANGE })
      document.fonts.add(face)
      return face.load()
    }),
  ).catch((error) => {
    faces = null
    throw error
  }))
let manifest = null
const loadManifest = () =>
  (manifest ??= fetch(`${BASE}audio/manifest.json`)
    .then((r) => r.json())
    .catch((error) => {
      manifest = null
      throw error
    }))
// decoded clips, kept for the next showing on the same AudioContext
const clips = new WeakMap()
const cacheFor = (ctx) => {
  if (!clips.has(ctx)) clips.set(ctx, { buf: new Map(), loading: new Map() })
  return clips.get(ctx)
}
// Without sound, the clock is the page's, minus any time the page was not drawing.
const steady = () => {
  let last = performance.now()
  let t = 0
  return () => {
    const now = performance.now()
    t += Math.min(0.1, (now - last) / 1000)
    last = now
    return t
  }
}
// A new AudioContext can take a moment to open its device; until its clock runs, nothing would play.
const running = async (ctx) => {
  const from = ctx.currentTime
  for (let i = 0; i < 150 && ctx.currentTime === from; i++) await new Promise((r) => setTimeout(r, 20))
}
const stopped = (signal) => {
  if (signal.aborted) throw new DOMException("The channel was changed", "AbortError")
}
// view, then a clip rect (x, y, w, h, corner radius) for anything drawn with the CLIP flag
const plain = (w, h, t, c = [0, 0, w, h, 0]) => [w, h, 1, t, c[0], c[1], c[2], c[3], c[4], 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1]

export async function start({ sound, signal, onEnd }) {
  const canvas = document.createElement("canvas")
  canvas.width = 640
  canvas.height = 480
  const ctx = sound?.context ?? null
  const got = await Promise.allSettled([Gpu.create(canvas), loadFaces().then(buildAtlas), loadManifest()])
  const gpu = got[0].status === "fulfilled" ? got[0].value : null
  const failed = got.find((g) => g.status === "rejected")
  if (failed || signal.aborted) {
    gpu?.destroy()
    stopped(signal)
    throw failed.reason
  }
  const atlas = got[1].value
  const cues = got[2].value
  const audio = new AudioEngine(BASE, ctx ? cacheFor(ctx) : undefined)
  let analyser = null
  try {
    const lists = { feed: new List(12000, 420), bg: new List(600, 4), fg: new List(3000, 8) }
    for (const l of Object.values(lists)) l.atlas = atlas
    gpu.setAtlas(atlas.canvas, { feed: { list: lists.feed, ubos: 9 }, bg: { list: lists.bg }, fg: { list: lists.fg } })
    // the atlas is on the GPU now; its 4096² canvas is not needed again
    atlas.canvas.width = atlas.canvas.height = 0
    if (ctx) {
      audio.attach(ctx, sound.input)
      // the voice drives the pitchman's mouth
      analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      audio.voice.connect(analyser)
    }
    const show = new Show({ atlas, audio })
    show.size(BW, BH)
    const bgU = new Float32Array(32)
    const fgU = new Float32Array(32)
    const feedU = new Float32Array(4)
    const quads = new Float32Array(16 * QF)
    const draw = () => {
      const t = show.t
      lists.feed.reset()
      const cams = show.feed(lists.feed)
      const nQuads = show.quads(quads)
      lists.bg.reset()
      show.bg(lists.bg)
      lists.fg.reset()
      show.fg(lists.fg)
      bgU.set(plain(BW, BH, t))
      fgU.set(plain(BW, BH, t, show.fgClip || undefined))
      feedU.set([BW, BH, t, 0])
      gpu.frame({ feed: { list: lists.feed, cams }, bg: { list: lists.bg, uniforms: bgU }, fg: { list: lists.fg, uniforms: fgU }, quads, nQuads, feedU })
    }
    // One frame drawn and finished before anything is shown, so the pipelines are compiled and
    // the first second does not stutter; the first seconds' clips in; and the sound's clock running.
    show.start(cues.dur, cues.words)
    draw()
    await Promise.race([Promise.all([gpu.device.queue.onSubmittedWorkDone(), audio.preload(Object.keys(cues.dur))]), new Promise((r) => setTimeout(r, 8000))])
    if (ctx) await running(ctx)
    stopped(signal)

    const clock = ctx ? () => ctx.currentTime : steady()
    const level = new Float32Array(analyser?.fftSize ?? 0)
    let t0 = null
    let ended = false
    return {
      canvas,
      frame(width) {
        const now = clock()
        t0 ??= now
        const at = now - t0
        if (show.t < show.talkUntil) {
          if (analyser) {
            analyser.getFloatTimeDomainData(level)
            let s = 0
            for (let i = 0; i < level.length; i++) s += level[i] * level[i]
            show.voice = Math.sqrt(s / level.length)
          } else show.voice = 0.18 + 0.12 * Math.sin(at * 18)
        } else show.voice = 0
        // the show steps on to where the sound is; a cue that fires late starts its sound that far in
        while (show.t + STEP <= at) {
          audio.behind = at - show.t - STEP
          show.step(STEP)
        }
        audio.behind = 0
        if (show.ended && !ended) {
          ended = true
          onEnd()
        }
        gpu.resize(width, Math.round((width * BH) / BW))
        draw()
        return show.tube
      },
      stop() {
        audio.close(0.12)
        analyser?.disconnect()
        gpu.destroy()
        canvas.width = canvas.height = 0
      },
    }
  } catch (error) {
    audio.close()
    analyser?.disconnect()
    gpu.destroy()
    throw error
  }
}
