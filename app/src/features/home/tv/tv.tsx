import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router'
import { productName, publicOrigin } from '../../../../../api/src/brand'
import { useCopy } from '../../../components/ui'
import { SignInConsent } from '../../../components/LegalLinks'
import { NightmailWordmark } from '../../../components/NightmailLogo'
import type { HomeProps, HomeStart } from '..'
import { useSignupsFull } from '../signups-open'
import { StartButton } from '../start'
import { MONTHS, OPENING, PER_THOUSAND, VOLUMES, count, usd, type Volume } from './data'
import { Remote, type RoomLight } from './crt/remote'
import type { Broadcast } from './crt/commercial/play'
import scene from './crt/scene.webp'
import knob from './crt/knob.webp'
import newAge from './crt/sound/newage.mp3'
import channelClunk from './crt/sound/channel.mp3'
import knobClick from './crt/sound/knob.mp3'
import remoteClick from './crt/sound/remote.mp3'
import powerOn from './crt/sound/power-on.mp3'
import powerOff from './crt/sound/power-off.mp3'
import tapeStart from './crt/sound/tape.mp3'
import staticLoop from './crt/sound/static.mp3'
import { nightmail } from '../../pricing/prices.ts'
import './tv.css'

// The scene: one photograph of a 1980s 14-inch television standing on a walnut table, lit by its own screen, cut out
// of its room (the wall behind is the page's own) with the tube's glass open so the live picture shows through. SCENE is the photograph, SET where the
// television is in it. Its controls are placed as fractions of the set: eight channel buttons in a column, two knobs
// and the power light.
const SCENE = { width: 2048, height: 1152 }, SET = { x: 524, y: 150, width: 1000, height: 736 }
const sceneStyle: CSSProperties = { left: `${-SET.x / SET.width * 100}%`, top: `${-SET.y / SET.height * 100}%`, width: `${SCENE.width / SET.width * 100}%`, height: `${SCENE.height / SET.height * 100}%` }
const BUTTON_X = .9206, BUTTON_Y = [.1044, .1446, .1837, .2239, .2620, .3012, .3404, .3805]
const KNOB_Y = [.4568, .5311]
const HIT = { w: .040, h: .039 }, CAP = { w: .0262, h: .0295 }, DIAL = .05

// What is on: channel 1 is the tape (the page's own comparison); each of the next six says one more thing about what
// Nightmail costs, every figure from the billing code (pricing/prices.ts: nightmail) or the comparison (data.ts). Channel 8 is on the air: Nightmail's old television commercial (crt/commercial), fetched and shown when its key is pressed.
type Row = { name: string; value: string; ours: boolean }
type Channel = { kind: 'list'; head?: string; title: string; rows: Row[]; tape?: boolean; cycle?: boolean } | { kind: 'air' }
const cents = (dollars: number) => usd(Math.round(dollars * 100) / 100)
const month = (volume: Volume, value: (dollars: number, ours: boolean) => string = d => usd(d)): Row[] => MONTHS[volume].map(line => ({ name: line.name.toUpperCase(), value: value(line.dollars, line.ours), ours: line.ours }))
const fact = (name: string, value: string): Row => ({ name, value, ours: false })
const CHANNELS: Channel[] = [
  { kind: 'list', tape: true, cycle: true, head: `${PER_THOUSAND} PER ${count(1000)} EMAILS`, title: `PER ${count(OPENING)} EMAILS`, rows: month(OPENING) },
  // what is free every month, before anything is charged
  { kind: 'list', title: 'FREE EVERY MONTH', rows: [fact('EMAILS SENT', count(nightmail.freeSent)), fact('EMAILS RECEIVED', count(nightmail.freeReceived)), fact('STORAGE', `${nightmail.freeStorageGb} GB`)] },
  // what is charged after that, and what never is
  { kind: 'list', title: 'AFTER THE FREE ONES', rows: [fact(`${count(1000)} SENT`, nightmail.perThousand), fact(`${count(1000)} RECEIVED`, nightmail.perThousand), fact('CONTACTS', 'FREE'), fact('TEAMMATES', 'FREE')] },
  { kind: 'list', title: `PER ${count(1000)} EMAILS`, rows: month(OPENING, (d, ours) => ours ? PER_THOUSAND : cents(d / (OPENING / 1000))) },
  { kind: 'list', title: `A YEAR AT ${count(OPENING)} A MONTH`, rows: month(OPENING, d => cents(d * 12)) },
  // what keeping received mail costs
  { kind: 'list', title: 'RECEIVED MAIL, KEPT', rows: [fact(`FIRST ${nightmail.storageAfterDays} DAYS`, 'FREE'), fact(`NEXT ${nightmail.freeStorageGb} GB`, 'FREE'), fact('EACH GB A MONTH', nightmail.storagePerGb)] },
  // the largest month the tape plays, held still
  { kind: 'list', title: `PER ${count(1_000_000)} EMAILS`, rows: month(1_000_000) },
  { kind: 'air' },
]
const TAPE = CHANNELS[0] as Extract<Channel, { kind: 'list' }>, AIR = CHANNELS.findIndex(channel => channel.kind === 'air')

// The tape goes round the volumes, a page each, starting from the opening one. A page turns as a character generator
// redraws a screen: the tape hiccups (a flick of static, the picture jumps a line or two and settles), then a
// highlight bar runs down the screen, title first and then row by row, and under it each figure runs to the next
// page's. Rows keep their places (the opening page's order) so each figure can be watched changing.
const PAGE = 5200, COUNT = 620, FIRST = 140, STEP = 85, TURN = FIRST + 6 * STEP + COUNT
const PAGES = [...VOLUMES.slice(VOLUMES.indexOf(OPENING)), ...VOLUMES.slice(0, VOLUMES.indexOf(OPENING))]
const BILLS = Object.fromEntries(VOLUMES.map(volume => [volume, MONTHS[OPENING].map(line => MONTHS[volume].find(other => other.slug === line.slug)!.dollars)])) as Record<Volume, number[]>
type Line = Row & { lit: number }
type Page = { key: string; title: string; lit: number; rows: Line[]; since: number | null }
/** The tape `ms` after its first page came up (before that, and with reduced motion, the opening page). since: how
 *  long ago this page began to turn in, while it still is. */
function pageAt(ms: number): Page {
  const at = Math.max(0, Math.floor(ms / PAGE)), since = at === 0 ? TURN : ms - at * PAGE, done = since >= TURN
  const to = PAGES[at % PAGES.length]!, from = PAGES[(at + PAGES.length - 1) % PAGES.length]!
  // one line's turn: how far its figure has run, and how bright the bar on it is (brightest as it arrives)
  const line = (delay: number) => { const p = clamp((since - delay) / COUNT); return { k: easeOut(p), lit: p > 0 && p < 1 ? (1 - p) ** 1.6 : 0 } }
  const run = (a: number, b: number, k: number) => a + (b - a) * k, head = line(0)
  return {
    key: `${at}:${done ? 1 : Math.round(since)}`, since: done ? null : since,
    title: `PER ${count(head.k >= 1 ? to : Math.round(run(from, to, head.k) / 1000) * 1000)} EMAILS`, lit: head.lit,
    rows: TAPE.rows.map((row, i) => { const l = line(FIRST + i * STEP); return { ...row, lit: l.lit, value: usd(l.k >= 1 ? BILLS[to][i]! : Math.round(run(BILLS[from][i]!, BILLS[to][i]!, l.k))) } }),
  }
}

// The picture, drawn small (240 lines, as much as a tape holds) and left to the tube.
// The table's light: MW x MH cells, the picture CW of them wide. COOL: the colour of a dark picture's light; LIFT: how
// much of the photograph's own pool a black (but lit) screen leaves.
const MW = 40, MH = 10, CW = 28, WALL = [96, 124, 190], COOL = [.84, .9, 1], LIFT = .66
const TW = 320, TH = 240, INK = '#E9E8DF', OURS = '#9DAEFF', FONT = '700 16.5px Inter, "Helvetica Neue", Arial, sans-serif', CELL = 9.7
// A VCR's on-screen type: every character in its own cell. Set from a face whose zero is open (a dotted zero reads as
// an 8 once the tape has softened it), one character at a time.
function type(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, right = false) {
  const from = right ? x - text.length * CELL : x
  ctx.textAlign = 'center'
  for (let i = 0; i < text.length; i++) {
    // a wide letter is narrowed to its cell, as a character generator's are
    const w = ctx.measureText(text[i]!).width, fit = Math.min(1, (CELL - 1.3) / w)
    ctx.setTransform(fit, 0, 0, 1, from + (i + .5) * CELL, y)
    ctx.fillText(text[i]!, 0, 0)
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
/** bare: only the set's own type, on nothing (it is laid over the broadcast). */
function drawPicture(ctx: CanvasRenderingContext2D, channel: Channel, rows: number, play: boolean, osd: string | null, page: Page | null, bare = false) {
  if (bare) ctx.clearRect(0, 0, TW, TH)
  else { ctx.fillStyle = '#04050D'; ctx.fillRect(0, 0, TW, TH) }
  ctx.font = FONT
  ctx.textBaseline = 'alphabetic'
  if (channel.kind === 'list') {
    // the tape leads with the price; the lines come up in this order: price, title, then the rows
    const head = channel.head, top = head ? 62 : 70, under = 86, first = head ? 111 : 103, step = head ? 18 : 19, shown = head ? rows - 1 : rows
    if (head && rows > 0) { ctx.fillStyle = OURS; type(ctx, head, 32, top) }
    // the bar that runs down a turning page: a VCR menu's blue, behind the line being redrawn
    const bar = (lit: number, y: number) => { if (lit > 0) { ctx.fillStyle = `rgb(40 62 200 / ${lit})`; ctx.fillRect(24, y - 14, TW - 48, 18) } }
    if (shown > 0) { bar(page?.lit ?? 0, head ? under : top); ctx.fillStyle = INK; type(ctx, (page ?? channel).title, 32, head ? under : top) }
    ;(page ?? channel).rows.slice(0, Math.max(0, shown - 1)).forEach((row, i) => {
      const y = first + i * step
      bar((row as Partial<Line>).lit ?? 0, y)
      ctx.fillStyle = row.ours ? OURS : INK
      type(ctx, row.name, 32, y); type(ctx, row.value, TW - 32, y, true)
    })
  }
  if (play) {
    ctx.fillStyle = '#F4F4EE'; type(ctx, 'PLAY', 32, 34)
    ctx.beginPath(); ctx.moveTo(77, 22.5); ctx.lineTo(88, 28.5); ctx.lineTo(77, 34.5); ctx.closePath(); ctx.fill()
  }
  if (osd) { ctx.fillStyle = '#4DFF7A'; type(ctx, osd, TW - 32, 34, true) }
}

const VERT = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.); gl_Position = vec4(p, 0., 1.); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTape;
uniform vec2 uRes;
uniform float uTime, uPower, uStatic, uRoll, uTrack, uBad, uJump, uStill, uAir, uOsd, uTilt;
out vec4 o;

// ---------------------------------------------------------------- tuning: the tube
const float CURVE = .022;       // how far the picture bends with the glass
const float OVERSCAN = .03;     // how much of the picture the bezel hides
const float SCAN = .30;         // depth of the scanlines
const float MASK = .16;         // strength of the red/green/blue phosphor stripes
const float BLOOM = .50;        // glow around bright text
const float BLACK = .040;       // how far "black" is from black (a tube glows)
const float VIGNETTE = .26;     // darkening toward the corners
const float GLASS = 1.;         // the room reflected in the glass
// ---------------------------------------------------------------- tuning: the tape
const float BLEED = .016;       // colour smeared to the right, in screen widths
const float SOFT = .0019;       // softness of the picture
const float NOISE = .052;       // snow in the picture
const float WOBBLE = .0006;     // each line's sideways shake
const float BAND = .036;        // height of the tracking band
const float BAND_SNOW = .55;    // how much of the band is torn static (1: as a worn tape)
const float DROPOUTS = .12;     // how often a dropout streak crosses a line (0: never)
const float BAND_TEAR = .016;   // how far the band drags lines sideways
const float BAND_SPEED = .045;  // screens a second the band climbs
const float HEAD = .022;        // height of the tear along the foot of the picture
// ---------------------------------------------------------------- tuning: a broadcast (channel 8)
const float FIT = 1.045;        // it is drawn to the edges of its frame, so it is shown this much smaller (its edges carried
                                // on under the bezel), to keep its band of type and its corners in sight
const float AIR_BLEED = .6;     // cleaner than a worn tape: less colour smear,
const float AIR_GLOW = .5;      // and a tighter glow (the tape's wide one leaves ghost copies of sharp type)

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 yiq(vec3 c) { return vec3(dot(c, vec3(.299, .587, .114)), dot(c, vec3(.596, -.274, -.322)), dot(c, vec3(.211, -.523, .312))); }
vec3 rgb(vec3 c) { return vec3(c.x + .956 * c.y + .621 * c.z, c.x - .272 * c.y - .647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z); }
vec3 tape(vec2 c) {
  if (uAir > .5) {
    // a knocked camera (the broadcast's own): the picture turns, pushed in just far enough that its corners stay covered
    vec2 d = (c - .5) * vec2(4. / 3., 1.);
    d = mat2(cos(uTilt), sin(uTilt), -sin(uTilt), cos(uTilt)) * d / (cos(uTilt) + 4. / 3. * sin(abs(uTilt)));
    return texture(uTape, d / vec2(4. / 3., 1.) * FIT + .5).rgb;
  }
  return c.x < 0. || c.x > 1. || c.y < 0. || c.y > 1. ? vec3(0.) : texture(uTape, c).rgb;
}
float lum(vec2 c) { return dot(tape(c), vec3(.299, .587, .114)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes; uv.y = 1. - uv.y;
  vec2 p = uv * 2. - 1.;
  float r2 = dot(p, p);
  vec2 q = p * (1. + CURVE * r2) / (1. + CURVE) * (1. - OVERSCAN);
  vec2 s = q * .5 + .5;
  float still = step(.5, uStill), live = 1. - still, t = mix(uTime, 3.7, still), frame = floor(t * 30.);

  // switching on (and off): a bright line that opens into the picture
  float w = smoothstep(0., .3, uPower), h = smoothstep(.15, 1., uPower);
  s = (s - .5) / vec2(max(w, .004), max(h * h, .006)) + .5;

  // a roll: the picture slides up through one frame, the blanking bar with it
  float seam = abs(s.y - (1. - uRoll));
  s.y = fract(s.y + uRoll) + uJump;

  float lines = min(240., floor(uRes.y / 3.)), line = floor(s.y * 240.);
  float n = hash(vec2(line, frame));
  float bandY = 1. - fract(t * BAND_SPEED + uTrack);
  float d = (s.y - bandY) / (BAND * (1. + 2.5 * uBad)), band = exp(-d * d * 2.) * live;
  float head = smoothstep(1. - HEAD * (1. + 2. * uBad), 1., s.y);

  float x = s.x + ((n - .5) * WOBBLE * (1. + 9. * uBad) + sin(s.y * 9. + t * 1.3) * .0006 * (1. + 6. * uBad)) * live;
  x += band * (hash(vec2(line * 1.7, frame + 3.)) - .3) * BAND_TEAR * (1. + 1.5 * uBad);
  x += head * (.02 + .012 * sin(t * 7.)) * (1. + n) * mix(1., .4, still);
  x += uStatic * (n - .5) * .07;
  vec2 c = vec2(x, s.y);

  // luma: soft, with a faint ring on the edges; chroma: smeared in from the left, as tape carries colour
  float Y = lum(c) * .62 + lum(c - vec2(SOFT, 0.)) * .25 + lum(c + vec2(SOFT, 0.)) * .25 - lum(c - vec2(SOFT * 3.2, 0.)) * .12;
  vec2 IQ = vec2(0.); float sum = 0.;
  float bleed = BLEED * mix(1., AIR_BLEED, uAir);
  for (int i = 0; i < 6; i++) { float f = float(i) / 5., k = 1. - f * .6; IQ += yiq(tape(c - vec2(bleed * f + .004, -.003))).yz * k; sum += k; }
  vec3 col = rgb(vec3(Y, IQ / sum * 1.15 * (1. - .6 * uBad * step(.5, hash(vec2(floor(t * 3.), 5.))))));

  // phosphor glow
  float glow = 0.;
  for (int i = 0; i < 8; i++) { float a = float(i) * .7854, r = (i % 2 == 0 ? .011 : .026) * mix(1., AIR_GLOW, uAir); glow += lum(c + vec2(cos(a) * r, sin(a) * r * 1.33)); }
  col += glow / 8. * BLOOM * vec3(.85, .92, 1.);

  // snow, the tracking band's torn static, the head-switch tear, a dropout now and then
  float snow = hash(gl_FragCoord.xy * .71 + frame * 17.);
  col += (snow - .5) * NOISE * (1. + 2. * uBad) * (1. + band * 6. + uStatic * 10. + head * 3.);
  float streak = step(.80, hash(vec2(floor(s.x * 90. + n * 40.), line + frame)));
  col = mix(col, vec3(snow * .9 + .1), clamp(band * (.20 + .55 * streak) * mix(BAND_SNOW, 1., uBad) + uStatic * .78, 0., 1.));
  col = mix(col, vec3(snow), head * .5);
  float drop = hash(vec2(floor(t * 6.), 7.)), dropAt = hash(vec2(floor(t * 6.), 9.));
  if (drop > 1. - DROPOUTS - .4 * uBad && line == floor(drop * 240.) && s.x > dropAt && s.x < dropAt + .2) col += .55 * (1. - (s.x - dropAt) / .2) * live;
  col = mix(col, vec3(snow * .25), smoothstep(.045, .02, seam) * step(.001, uRoll));
  // on a channel with nothing on it, the set's own type is the set's, not the signal's: it stands clear of the static
  col = mix(col, tape(s) * 1.15 + .04, uOsd * smoothstep(.12, .3, lum(s)));

  // the tube: lifted blacks, scanlines, phosphor stripes, dark corners
  col = col * (1. - BLACK) + BLACK * vec3(.5, .6, 1.);
  col *= mix(1. - SCAN, 1., .5 + .5 * cos(6.28318 * s.y * lines));
  float mx = mod(gl_FragCoord.x, 3.);
  col *= mix(vec3(1.), vec3(mx < 1. ? 1.5 : .72, mx >= 1. && mx < 2. ? 1.5 : .72, mx >= 2. ? 1.5 : .72), MASK);
  col *= 1. - VIGNETTE * pow(r2 * .5, 1.3);
  col *= step(0., s.x) * step(s.x, 1.) * smoothstep(0., .25, uPower) * (1. + (1. - uPower) * 2.5);
  col += vec3(1.8, 1.9, 2.2) * (1. - smoothstep(.05, .7, uPower)) * exp(-pow((uv.y - .5) / (.004 + .03 * uPower), 2.)) * step(abs(p.x), max(w, .02)) * step(.001, uPower);

  // the room in the glass: a soft window of light high on the left, a faint sheen beside it
  col += GLASS * vec3(.030, .032, .038) * smoothstep(.62, .05, length((uv - vec2(.2, .13)) * vec2(1., 2.4)));
  col += GLASS * vec3(.010, .011, .014) * smoothstep(.16, 0., abs(uv.x - .13 - uv.y * .05)) * smoothstep(1., .2, uv.y);
  o = vec4(pow(max(col, 0.), vec3(.92)), 1.);
}`

const clamp = (v: number) => Math.min(1, Math.max(0, v))
const easeOut = (v: number) => 1 - (1 - clamp(v)) ** 3

/** The set's controls, as the tube reads them every frame. wake: draw again (the tube sets it). air: the commercial,
 *  once it is ready to be shown on channel 8. */
type Deck = RoomLight & { channel: number; power: boolean; bad: number; thumpAt: number; switchAt: number; note: string; noteAt: number; air: Broadcast | null; wake: () => void; hear: (snow: number, bad: number, on: boolean) => void }

function Tube({ deck, onLight, onFlat }: { deck: Deck; onLight: (level: number) => void; onFlat: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const gl = el.getContext('webgl2', { antialias: false, alpha: false })
    const picture = document.createElement('canvas'), ctx = picture.getContext('2d')
    picture.width = TW; picture.height = TH
    if (!gl || !ctx) { onFlat(); return }
    const shader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(program)); onFlat(); return }
    gl.useProgram(program)
    const u = Object.fromEntries(['uTape', 'uRes', 'uTime', 'uPower', 'uStatic', 'uRoll', 'uTrack', 'uBad', 'uJump', 'uStill', 'uAir', 'uOsd', 'uTilt'].map(name => [name, gl.getUniformLocation(program, name)]))
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) gl.texParameteri(gl.TEXTURE_2D, key, value)

    // The picture's light in the room. On the table: the picture, upside down and very small (the tabletop's two
    // canvases stretch and blur it), so what is at the foot of the screen lies nearest the set and each colour falls
    // under where it is on screen. "shade" is what the photograph's own pool of light is multiplied by: a dark
    // picture leaves it a dim cool white, a bright one takes it to full, and a strongly coloured one gives it its
    // colour. "tint" is the picture's own colour, added faintly. On the wall: the picture's average colour.
    const room = el.closest<HTMLElement>('.chy-set')
    const mirror = (name: string) => { const m = room?.querySelector<HTMLCanvasElement>('canvas.' + name); if (!m) return null; m.width = MW; m.height = MH; return m.getContext('2d') }
    const shadeOn = mirror('chy-reflect-shade'), tintOn = mirror('chy-reflect-tint')
    const scratch = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c.getContext('2d', { willReadFrequently: true })! }
    const half = scratch(TW / 2, TH / 2), quarter = scratch(TW / 4, TH / 4), eighth = scratch(TW / 8, TH / 8), cell = scratch(CW, MH)
    const shade = new Float32Array(MW * MH * 3), tint = new Float32Array(MW * MH * 3), out = new ImageData(MW, MH)
    const ramp = (lo: number, hi: number, v: number) => { const k = clamp((v - lo) / (hi - lo)); return k * k * (3 - 2 * k) }
    const sample = (from: CanvasImageSource) => {
      half.drawImage(from, 0, 0, TW / 2, TH / 2); quarter.drawImage(half.canvas, 0, 0, TW / 4, TH / 4); eighth.drawImage(quarter.canvas, 0, 0, TW / 8, TH / 8); cell.drawImage(eighth.canvas, 0, 0, CW, MH)
      const px = cell.getImageData(0, 0, CW, MH).data, all = [0, 0, 0]
      for (let x = 0; x < MW; x++) {
        // the picture lies under the screen, spread a little; beyond it, its edge colour carries on
        const cx = Math.round(clamp((x / (MW - 1) - .185) / .63) * (CW - 1)), col = [0, 0, 0]
        for (let y = 0; y < MH; y++) for (let j = 0; j < 3; j++) col[j]! += px[(y * CW + cx) * 4 + j]! / MH
        for (let y = 0; y < MH; y++) {
          const at = ((MH - 1 - y) * CW + cx) * 4, c = [0, 1, 2].map(j => (px[at + j]! * .4 + col[j]! * .6) / 255)
          const most = Math.max(c[0]!, c[1]!, c[2]!), own = ramp(.08, .4, most), level = Math.min(1, LIFT + most * 2.6)
          for (let j = 0; j < 3; j++) { shade[(y * MW + x) * 3 + j] = level * (COOL[j]! * (1 - own) + (most > 0 ? c[j]! / most : 1) * own); tint[(y * MW + x) * 3 + j] = c[j]!; all[j]! += c[j]! }
        }
      }
      const most = Math.max(...all) / (MW * MH), own = ramp(.08, .4, most) * .6
      const wall = WALL.map((v, j) => Math.round(v * (1 - own) + (most > 0 ? all[j]! / (MW * MH) / most : 1) * 150 * own))
      room?.style.setProperty('--tint', wall.join(' '))
      deck.glow = [wall[0]! / 255, wall[1]! / 255, wall[2]! / 255]
    }
    const reflect = (power: number, snow: number) => {
      const white = Math.min(1, snow * .8)
      for (const [on, from, flash] of [[shadeOn, shade, 1], [tintOn, tint, .5]] as const) {
        if (!on) continue
        for (let i = 0, k = 0; k < from.length; i += 4, k += 3) { for (let j = 0; j < 3; j++) out.data[i + j] = 255 * power * (from[k + j]! * (1 - white) + flash * white); out.data[i + 3] = 255 }
        on.putImageData(out, 0, 0)
      }
    }
    // Channel 8: the broadcast, with the set's own type laid over it as a set lays its channel number over whatever is on
    // (screen), and a small copy of that for the room's light (shot). Both are made the first time it is on. The room is
    // lit from every other frame: reading the picture back from the GPU is most of what a frame of it costs.
    let screen: CanvasRenderingContext2D | null = null, shot: CanvasRenderingContext2D | null = null, shots = 0
    const broadcast = (air: Broadcast) => {
      const w = air.canvas.width, h = air.canvas.height
      screen ??= document.createElement('canvas').getContext('2d')!
      shot ??= Object.assign(document.createElement('canvas'), { width: TW, height: TH }).getContext('2d')!
      if (screen.canvas.width !== w || screen.canvas.height !== h) { screen.canvas.width = w; screen.canvas.height = h }
      screen.drawImage(air.canvas, 0, 0); screen.drawImage(picture, 0, 0, w, h)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, screen.canvas)
      if (shots++ % 2) return
      shot.drawImage(screen.canvas, 0, 0, TW, TH)
      sample(shot.canvas)
    }
    const calm = matchMedia('(prefers-reduced-motion: reduce)')
    // Taking over from home.html's still of this picture (takeOver, below): on and settled from the first frame, without
    // switching on or the tape's first run-up.
    const handoff = !!document.getElementById('home-shell')
    let shown = '', raf = 0, last = 0, seen = true, track = 0, trackTo = 0, level = handoff ? 1 : 0, bootAt = performance.now() - (handoff ? 2100 : 0), wasOn = true, bad = 0
    const began = performance.now()
    const size = () => {
      const scale = Math.min(devicePixelRatio || 1, 2), w = Math.round(el.clientWidth * scale), h = Math.round(el.clientHeight * scale)
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
      gl.viewport(0, 0, w, h)
    }
    const draw = (now: number) => {
      const still = calm.matches, dt = Math.min(100, now - (last || now))
      if (deck.power && !wasOn) bootAt = now
      wasOn = deck.power
      level = still ? Number(deck.power) : clamp(level + (deck.power ? dt / 450 : -dt / 300) * Number(now - began > 150))
      const boot = now - bootAt, thump = now - deck.thumpAt, flick = now - deck.switchAt
      const channel = CHANNELS[deck.channel]!, first = deck.channel === 0 && boot < 2100 && flick > boot
      const power = easeOut(level)
      // channel 8: static until the broadcast is ready; then it is drawn for this frame (960 px wide on a sharp tube, 640 on
      // a small one), and its own tuning-in static, roll and knocked camera come through this tube
      const air = channel.kind === 'air' ? deck.air : null, aired = air?.frame(el.width > 820 ? 960 : 640)
      const snow = channel.kind === 'air' && !air ? 1 : still ? 0 : Math.max(first && boot >= 350 ? clamp(1 - (boot - 350) / 550) : 0, clamp(.9 - thump / 380), clamp(1 - flick / 260), aired?.static ?? 0)
      const roll = still ? 0 : Math.max(first && boot >= 900 ? 1 - easeOut((boot - 900) / 550) : 0, .5 * (1 - easeOut(thump / 450)), deck.bad > 1.75 ? (now / 2600) % 1 : 0, aired?.roll ?? 0)
      const rows = still || !first ? 9 : boot < 1150 ? 0 : Math.min(9, 1 + Math.floor((boot - 1150) / 100))
      const play = channel.kind === 'list' && !!channel.tape && (still || !first || boot >= 900)
      const said = now - deck.noteAt
      const osd = said < 2200 && said < flick ? deck.note : flick < 2200 ? `CH ${String(deck.channel + 1).padStart(2, '0')}` : null
      const page = channel.kind === 'list' && channel.cycle ? pageAt(still ? 0 : boot - 2100) : null
      // a page turning: the tape's hiccup (seen, not heard)
      const since = page?.since ?? null, hiccup = since === null ? 0 : .07 * clamp(1 - since / 200), jump = since === null ? 0 : .009 * Math.exp(-since / 110) * Math.cos(since / 30)
      const key = [deck.channel, rows, play, osd, page?.key, !!air].join()
      if (key !== shown) { shown = key; drawPicture(ctx, channel, rows, play, osd, page, !!air); if (!air) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture); sample(picture) } }
      if (air) broadcast(air)
      track += (trackTo - track) * .12
      bad += (deck.bad / 2 - bad) * .2
      size()
      gl.uniform1i(u.uTape!, 0); gl.uniform2f(u.uRes!, el.width, el.height); gl.uniform1f(u.uTime!, (now - began) / 1000)
      gl.uniform1f(u.uPower!, power); gl.uniform1f(u.uStatic!, Math.max(snow, hiccup)); gl.uniform1f(u.uRoll!, roll >= 1 ? 0 : roll); gl.uniform1f(u.uJump!, jump)
      gl.uniform1f(u.uTrack!, track); gl.uniform1f(u.uBad!, bad); gl.uniform1f(u.uStill!, still ? 1 : 0); gl.uniform1f(u.uAir!, air ? 1 : 0); gl.uniform1f(u.uOsd!, channel.kind === 'air' && !air ? 1 : 0); gl.uniform1f(u.uTilt!, aired?.tilt ?? 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      reflect(power, Math.max(snow, hiccup))
      deck.hear(snow, bad, deck.power)
      onLight(power * (.9 + snow * .7 + (still ? 0 : Math.sin(now / 90) * .02)))
      deck.level = power * (.9 + Math.max(snow, hiccup) * .7)
    }
    // Tape runs at 30 frames a second, and stops while nobody can see it.
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (!seen || document.hidden || now - last < 31) return
      draw(now)
      last = now
      // (a broadcast is the visitor's own choice to watch, so it plays on)
      if (calm.matches && !deck.air) { cancelAnimationFrame(raf); raf = 0 }
    }
    const start = () => { if (!raf) raf = requestAnimationFrame(loop) }
    deck.wake = start
    const watch = new IntersectionObserver(entries => { seen = entries.some(e => e.isIntersecting) })
    watch.observe(el)
    const resized = new ResizeObserver(() => { if (calm.matches) draw(performance.now()) })
    resized.observe(el)
    const move = (event: PointerEvent) => { const r = el.getBoundingClientRect(); trackTo = (clamp((event.clientY - r.top) / r.height) - .5) * .18 }
    el.addEventListener('pointermove', move); calm.addEventListener('change', start)
    void document.fonts.load(FONT).then(() => { shown = '' })
    start()
    return () => {
      cancelAnimationFrame(raf); watch.disconnect(); resized.disconnect()
      el.removeEventListener('pointermove', move); calm.removeEventListener('change', start)
      deck.wake = () => {}
      gl.deleteTexture(texture); gl.deleteProgram(program)
    }
  }, [deck, onLight, onFlat])
  return <canvas ref={canvas} aria-hidden="true" />
}

// The set's sound. Music: a loop of forecast music played as the set would play it (mono, band-limited to a small
// speaker, a little overdriven, the tape's speed wandering, worse as the tracking goes, hiss under it, and switching
// off runs the tape down). Static: a recording of a set between channels, with every burst on screen. And the set's
// own noises, recorded: the channel keys' clunk, the knobs' click, the tube switching on and off, the tape engaging,
// the remote's key. And a broadcast's sound (channel 8), which takes the music's place through the same speaker. Nothing
// is fetched or played until the visitor first uses the set.
/** The music on the tape: a loop that begins LEAD seconds in and is `length` long (crt/sound: the file repeats
 *  its first second after the end, so the loop point is exact whatever padding a decoder adds). */
const LEAD = .5, MUSIC = { url: newAge, length: 68.5709 }
const NOISES = { channel: channelClunk, knob: knobClick, remote: remoteClick, on: powerOn, off: powerOff, tape: tapeStart }
/** How loud a broadcast goes into the speaker: as loud as the tape's music (by meter and by ear). */
const BROADCAST = .7
type Noise = keyof typeof NOISES
type Speaker = { context: AudioContext; input: AudioNode }
/** air(true): a broadcast is on, and its sound goes in at the returned input (null before the set's sound has started);
 *  the music is let down while it is. */
type Sound = { readonly started: boolean; start: () => void; set: (snow: number, bad: number, on: boolean) => void; mute: (muted: boolean) => void; play: (noise: Noise, gain?: number, after?: number) => void; air: (on: boolean) => Speaker | null; stop: () => void }
function createSound(): Sound {
  let ctx: AudioContext | null = null, apply: ((snow: number, bad: number, on: boolean) => void) | null = null, inlet: Speaker | null = null
  let muted = false, airing = false, last = [0, 0, true] as [number, number, boolean]
  let play: Sound['play'] = () => {}
  const seen = () => { if (ctx) void (document.hidden ? ctx.suspend() : ctx.resume()) }
  const start = () => {
    if (ctx) { void ctx.resume(); return }
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return
    const c = ctx = new Context(), now = () => c.currentTime
    const gain = (value: number) => { const g = c.createGain(); g.gain.value = value; return g }
    const filter = (type: BiquadFilterType, frequency: number, q = .7, db = 0) => { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = frequency; f.Q.value = q; f.gain.value = db; return f }
    const fetched = new Map<string, Promise<AudioBuffer>>()
    const load = (url: string) => { if (!fetched.has(url)) fetched.set(url, fetch(url).then(response => response.arrayBuffer()).then(bytes => c.decodeAudioData(bytes))); return fetched.get(url)! }
    // everything leaves through `out` (the grille's mute); the set's speaker is `speaker`, the room's noises `room`
    const out = gain(1), speaker = gain(0), room = gain(.55)
    out.connect(c.destination); speaker.connect(out); room.connect(out)
    // the music's path: one channel, the tape's wandering speed, the speaker's band, a soft clip
    const mono = gain(1); mono.channelCount = 1; mono.channelCountMode = 'explicit'
    const wander = c.createDelay(.1); wander.delayTime.value = .03
    const wow = c.createOscillator(), wowBy = gain(.0016), flutter = c.createOscillator(), flutterBy = gain(.00012)
    wow.frequency.value = .55; flutter.frequency.value = 6.4
    wow.connect(wowBy).connect(wander.delayTime); flutter.connect(flutterBy).connect(wander.delayTime); wow.start(); flutter.start()
    const low = filter('lowpass', 3600), drive = c.createWaveShaper(), music = gain(.9)
    drive.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh((i / 511.5 - 1) * 1.7) / Math.tanh(1.7))
    mono.connect(wander).connect(filter('highpass', 190)).connect(filter('peaking', 1150, 1, 4.5)).connect(low).connect(drive).connect(music).connect(speaker)
    // what goes in: the tape's music (bed), or a broadcast's sound (air), never both
    const bed = gain(1), air = gain(0)
    bed.connect(mono); air.connect(mono)
    inlet = { context: c, input: air }
    // tape hiss (made here), and the set's static (recorded) for bursts and the dead channel
    const grain = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), data = grain.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const hiss = c.createBufferSource(), burst = gain(0)
    hiss.buffer = grain; hiss.loop = true
    hiss.connect(filter('highpass', 2600)).connect(gain(.011)).connect(speaker); hiss.start()
    burst.connect(filter('lowpass', 6500)).connect(speaker)
    void load(staticLoop).then(buffer => { if (c.state === 'closed') return; const s = c.createBufferSource(); s.buffer = buffer; s.loop = true; s.loopStart = LEAD; s.loopEnd = LEAD + 4; s.connect(burst); s.start(0, LEAD) }).catch(() => {})
    for (const url of Object.values(NOISES)) void load(url).catch(() => {})
    play = (noise, level = 1, after = 0) => { void load(NOISES[noise]).then(buffer => { if (c.state === 'closed') return; const s = c.createBufferSource(), g = gain(level); s.buffer = buffer; s.connect(g).connect(room); s.start(now() + after) }).catch(() => {}) }
    let tape: AudioBufferSourceNode | null = null
    void load(MUSIC.url).then(buffer => {
      if (c.state === 'closed') return
      tape = c.createBufferSource()
      tape.buffer = buffer; tape.loop = true; tape.loopStart = LEAD; tape.loopEnd = LEAD + MUSIC.length
      tape.connect(bed); tape.start(0, LEAD)
      apply?.(...last)
    }).catch(() => {})
    apply = (snow, bad, on) => {
      const t = now()
      burst.gain.setTargetAtTime(on ? snow * .2 : 0, t, .03)
      music.gain.setTargetAtTime(on ? .9 * (1 - .78 * snow) : 0, t, .05)
      bed.gain.setTargetAtTime(airing ? 0 : 1, t, .06); air.gain.setTargetAtTime(airing ? BROADCAST : 0, t, .015)
      wowBy.gain.setTargetAtTime(.0016 * (1 + 3 * bad), t, .15); flutterBy.gain.setTargetAtTime(.00012 * (1 + 9 * bad), t, .15)
      low.frequency.setTargetAtTime(3600 - 1500 * bad, t, .15)
      tape?.playbackRate.setTargetAtTime(on ? 1 : .5, t, .14)
      speaker.gain.setTargetAtTime(on ? .34 : 0, t, on ? .09 : .16)
      out.gain.setTargetAtTime(muted ? 0 : 1, t, .04)
    }
    apply(...last)
    document.addEventListener('visibilitychange', seen)
  }
  return {
    get started() { return ctx !== null },
    start,
    set: (snow, bad, on) => { const s = Math.round(snow * 40) / 40, b = Math.round(bad * 40) / 40; if (s === last[0] && b === last[1] && on === last[2]) return; last = [s, b, on]; apply?.(s, b, on) },
    mute: to => { muted = to; apply?.(...last) },
    play: (noise, level, after) => play(noise, level, after),
    air: to => { airing = to; apply?.(...last); return inlet },
    stop: () => { document.removeEventListener('visibilitychange', seen); void ctx?.close(); ctx = null; apply = null; inlet = null; play = () => {} },
  }
}

const at = (x: number, y: number, w: number, h: number) => ({ left: `${(x - w / 2) * 100}%`, top: `${(y - h / 2) * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` })
// A key's cap is its own piece of the photograph, cut out so it can travel: down when pressed, and it stays down while
// its channel is on, as a mechanical channel selector's does.
const capStyle = (x: number, y: number): CSSProperties => {
  // the cap's box in scene pixels, and the photograph laid behind it at the scene's own scale
  const w = CAP.w * SET.width, h = CAP.h * SET.height, left = SET.x + x * SET.width - w / 2, top = SET.y + y * SET.height - h / 2
  return {
    left: `${(1 - CAP.w / HIT.w) * 50}%`, top: `${(1 - CAP.h / HIT.h) * 50}%`, width: `${CAP.w / HIT.w * 100}%`, height: `${CAP.h / HIT.h * 100}%`,
    backgroundImage: `url(${scene})`, backgroundSize: `${SCENE.width / w * 100}% ${SCENE.height / h * 100}%`,
    backgroundPosition: `${left / (SCENE.width - w) * 100}% ${top / (SCENE.height - h) * 100}%`,
  }
}

/** A knob that turns: drag it round, or press it to step to its next stop. stops: the angles it rests at. */
function Dial({ y, label, stops, index, onIndex, onAngle }: { y: number; label: string; stops: number[]; index: number; onIndex: (index: number) => void; onAngle?: (degrees: number) => void }) {
  const [held, setHeld] = useState<number | null>(null)
  const grip = useRef<{ from: number; angle: number; moved: number } | null>(null)
  const bearing = (event: ReactPointerEvent<HTMLButtonElement>) => { const r = event.currentTarget.getBoundingClientRect(); return Math.atan2(event.clientY - r.top - r.height / 2, event.clientX - r.left - r.width / 2) * 180 / Math.PI }
  const lo = stops[0]!, hi = stops.at(-1)!
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); grip.current = { from: bearing(event), angle: stops[index]!, moved: 0 } }
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const g = grip.current
    if (!g) return
    const turned = ((bearing(event) - g.from + 540) % 360) - 180
    g.moved = Math.max(g.moved, Math.abs(turned))
    if (g.moved < 6) return
    const angle = Math.min(hi, Math.max(lo, g.angle + turned))
    setHeld(angle); onAngle?.(angle)
  }
  const up = () => {
    const g = grip.current
    grip.current = null
    if (!g) return
    if (held === null) onIndex((index + 1) % stops.length)
    else onIndex(stops.reduce((best, stop, i) => Math.abs(stop - held) < Math.abs(stops[best]! - held) ? i : best, 0))
    setHeld(null)
  }
  return <button type="button" className="chy-knob" style={{ ...at(BUTTON_X, y, DIAL, DIAL * SET.width / SET.height), '--turn': `${held ?? stops[index]}deg` } as CSSProperties} data-held={held !== null || undefined} aria-label={label}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { grip.current = null; setHeld(null) }} onClick={event => { if (event.detail === 0) onIndex((index + 1) % stops.length) }}>
    <span className="chy-dial" style={{ backgroundImage: `url(${knob})` }} />
    <span className="chy-dial-light" />
  </button>
}

// The way in: an airmail label, cream paper with the red and blue striped border of an airmail envelope and the page's
// button typed on it. On the table, in the screen's light under the middle of the picture; on a phone, where the table
// is too shallow for it, the same label under the table. It is not dimmed with the room: it is the brightest thing
// outside the screen.
const Label = ({ start, under }: { start: HomeStart; under?: boolean }) => <div className={`chyp${under ? ' chyp-under' : ''}`}><StartButton start={start} className="chyp-go" /></div>

/** What "Copy for your agent" copies: the homepage's Markdown twin, whose steps an agent follows (pricing/readable.ts). */
const AGENT_INSTRUCTION = `Set up ${productName} to send email from this project. Read ${publicOrigin}/index.md and follow its steps for agents.`
// In the terms line, set as its links are. Its two words share one cell, so saying Copied moves nothing.
function CopyForAgent() {
  const { copy, copied, failed } = useCopy()
  return <>
    <button type="button" className="chy-copy" data-copied={copied || undefined} onClick={() => void copy(AGENT_INSTRUCTION)}><span>Copy for your agent</span><span aria-hidden="true">Copied</span></button>
    <span className="chy-sr" role="status">{copied ? 'Copied to clipboard' : failed ? 'Couldn’t copy to clipboard' : ''}</span>
  </>
}
// After the terms (or alone, for someone signed in): the full price list, the API's docs and the agent's way in.
const More = ({ lead }: { lead?: boolean }) => <>{lead && <span aria-hidden="true"> · </span>}<a href="/pricing">Pricing</a><span aria-hidden="true"> · </span><a href="/docs">API docs</a><span aria-hidden="true"> · </span><CopyForAgent /></>

/** home.html's first screen (app/home-shell.ts: this page as first rendered, with a still of the tape behind the glass),
 *  over this one until now: it goes, handing on the label's focus. */
function takeOver(set: HTMLElement | null) {
  const shell = document.getElementById('home-shell')
  if (!shell) return
  const focused = shell.contains(document.activeElement)
  shell.remove()
  if (focused) [...set?.closest('.chy')?.querySelectorAll<HTMLElement>('.chyp-go') ?? []].find(el => el.getClientRects().length)?.focus()
}

/** The homepage: the television, the price list it plays, and the way in. */
export function TvHome({ start, notice }: HomeProps) {
  const visitor = !start.signedIn
  // No place open (signups-open.ts): the button says Join the waitlist, and a line under it says why, unless a sign-in
  // has something of its own to say there. The line is in the page from the start (empty), so its words move nothing.
  const full = useSignupsFull(visitor), said = notice || <p role="status">{full ? 'Full for now. Join the waitlist and we’ll email you when a place opens.' : ''}</p>
  const [flat, setFlat] = useState(false), [on, setOn] = useState(true), [channel, setChannel] = useState(0), [bad, setBad] = useState(0), [muted, setMuted] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const deck = useRef<Deck>({ channel: 0, power: true, bad: 0, thumpAt: -1e9, switchAt: -1e9, note: '', noteAt: -1e9, air: null, wake: () => {}, hear: () => {}, glow: [.38, .49, .75], level: 0 }).current
  // The sound starts with the visitor's first use of the set (a browser plays nothing before that); the speaker's
  // grille turns it off and on.
  const sound = useRef<Sound | null>(null), fresh = useRef(false)
  useEffect(() => { const made = sound.current = createSound(); deck.hear = made.set; return () => { deck.hear = () => {}; made.stop() } }, [deck])
  const say = (note: string) => { deck.note = note; deck.noteAt = performance.now(); deck.wake() }
  const noise = (name: Noise, level?: number, after?: number) => sound.current?.play(name, level, after)
  const light = useRef((level: number) => { box.current?.style.setProperty('--light', level.toFixed(3)); takeOver(box.current) }).current
  const fall = useRef(() => { setFlat(true); box.current?.style.setProperty('--light', '1'); requestAnimationFrame(() => takeOver(box.current)) }).current
  // A press on home.html's Get started made while this code loaded signs in now; its first screen gives way once the
  // picture is drawn (light, fall), or after a while if it never is.
  useEffect(() => {
    const held = window as Window & { __nightmailHomeStart?: boolean }
    if (held.__nightmailHomeStart && !start.signedIn) { delete held.__nightmailHomeStart; start.onSignIn() }
    const late = setTimeout(() => takeOver(box.current), 3000)
    return () => clearTimeout(late)
  }, [])
  const tune = (to: number) => { setChannel(to); deck.channel = to; deck.switchAt = performance.now(); deck.wake() }
  // Channel 8 has something on only where the commercial can be drawn (WebGPU). Once the set has warmed up a GPU is asked
  // for (nothing is fetched for it), and the key's lamp lights only when there is one; null: not known yet.
  const [gpu, setGpu] = useState<boolean | null>(() => 'gpu' in navigator ? null : false)
  useEffect(() => {
    const ask = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu
    if (!ask) return
    let live = true
    const later = setTimeout(() => void ask.requestAdapter().then(adapter => { if (live) setGpu(had => had ?? !!adapter) }, () => { if (live) setGpu(false) }), 2500)
    return () => { live = false; clearTimeout(later) }
  }, [])
  const dead = gpu === false
  // Channel 8 on: the commercial is fetched (the first time) and readied while the set shows static, then shown from the
  // top. Changing channel or switching off stops it at once; when it has finished, the set goes back to the tape.
  useEffect(() => {
    if (!on || channel !== AIR || flat) return
    if (dead) { say('NO SIGNAL'); return }
    sound.current?.start()
    const speaker = sound.current?.air(true) ?? null, stop = new AbortController()
    let shown: Broadcast | null = null
    void import('./crt/commercial/play')
      .then(({ start }) => start({ sound: speaker, signal: stop.signal, onEnd: () => { noise('channel', .6); tune(0) } }))
      .then(made => { if (stop.signal.aborted) return made.stop(); shown = deck.air = made; setGpu(true); deck.wake() })
      .catch(() => { if (!stop.signal.aborted) setGpu(false) })
    return () => { stop.abort(); deck.air = null; shown?.stop(); sound.current?.air(false) }
  }, [on, channel, flat, dead, deck])
  const list = <>
    <li><span>{TAPE.title}</span></li>
    {TAPE.rows.map(row => <li key={row.name} data-ours={row.ours || undefined}><span>{row.name}</span><span>{row.value}</span></li>)}
  </>
  return <main className="chy">
    <div className="chy-col">
      {/* In words, for whoever can't see the picture: the price, what is free, and the tape's opening page (channel 1). */}
      <h1 className="chy-sr">{PER_THOUSAND} per {count(1000)} emails</h1>
      <p className="chy-sr">The first {count(nightmail.freeSent)} emails sent each month are free.</p>
      <h2 className="chy-sr">What sending {count(OPENING)} emails a month costs</h2>
      <ul className="chy-sr">{MONTHS[OPENING].map(line => <li key={line.slug}>{line.name}: {usd(line.dollars)}</li>)}</ul>
      <div className="chy-set" ref={box} onClickCapture={event => { if ((event.target as Element).closest('[data-cta]')) return; fresh.current = !sound.current?.started; sound.current?.start() }}>
        <button type="button" className="chy-screen" aria-label="Television screen" onClick={() => { deck.thumpAt = performance.now(); deck.wake() }}>
          {flat ? <ul className="chy-flat" aria-hidden="true">{list}</ul> : <Tube deck={deck} onLight={light} onFlat={fall} />}
        </button>
        <span className="chy-glow" />
        <img className="chy-scene" src={scene} alt="" width={SCENE.width} height={SCENE.height} draggable={false} style={sceneStyle} />
        <canvas className="chy-reflect chy-reflect-shade" aria-hidden="true" />
        <canvas className="chy-reflect chy-reflect-tint" aria-hidden="true" />
        {!on && <span className="chy-unlit" style={at(.9485, .5053, .017, .023)} />}
        <Link to="/" aria-label="nightmail home" className="chy-badge"><NightmailWordmark /></Link>
        {BUTTON_Y.map((y, i) => {
          // channel 8's key has a lamp behind it while there is something on it to see
          const air = i === AIR && gpu === true && !flat
          return <button key={y} type="button" className="chy-key" style={at(BUTTON_X, y, HIT.w, HIT.h)} aria-label={air ? 'Channel 8: the Nightmail commercial, a minute long, with sound' : `Channel ${i + 1}`} aria-pressed={channel === i} data-air={air || undefined} data-lit={(air && on && channel !== AIR) || undefined} onClick={() => { noise('channel'); tune(i) }}>
            <span className="chy-well" style={capStyle(BUTTON_X, y)} />{air && <span className="chy-lamp" />}<span className="chy-cap" style={capStyle(BUTTON_X, y)} />
          </button>
        })}
        <button type="button" className="chy-grille" style={at(.882, .713, .1, .3)} aria-label="Sound" aria-pressed={!muted} onClick={() => { const to = fresh.current ? false : !muted; setMuted(to); sound.current?.mute(to); say(to ? 'MUTE' : 'SOUND ON') }} />
        <Dial y={KNOB_Y[0]!} label="Tracking" stops={[-55, 0, 55]} index={bad} onIndex={i => { noise('knob'); setBad(i); deck.bad = i; deck.wake() }} onAngle={angle => { deck.bad = (angle + 55) / 55; deck.wake() }} />
        <Dial y={KNOB_Y[1]!} label="Power" stops={[-50, 40]} index={Number(on)} onIndex={i => { noise('knob', .7); noise(i === 1 ? 'on' : 'off', .6, .05); if (i === 1) noise('tape', .3, .9); setOn(i === 1); deck.power = i === 1; deck.wake() }} />
        <Remote light={deck} onZap={() => { noise('remote'); tune((deck.channel + 1) % CHANNELS.length) }} />
        <Label start={start} />
      </div>
      <div className="chy-under">
        <div className="chy-way"><Label start={start} under /><div className="chy-notice">{said}</div></div>
        {visitor ? <SignInConsent className="chy-consent" after={<More lead />} /> : <p className="chy-consent"><More /></p>}
      </div>
    </div>
  </main>
}
