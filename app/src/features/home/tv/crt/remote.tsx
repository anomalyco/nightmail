import { useEffect, useRef, useState } from 'react'

// The set's remote control: a real object, not a picture. It is a signed-distance model (a rounded case, rubber keys,
// two rockers, a red power key, an infra-red window in its nose) ray-marched in a fragment shader, with its legends
// drawn to a small canvas and printed on its face. It is lit by the television: the light's colour and strength are
// the picture's, its direction is from wherever the remote is toward the screen, the keys throw shadows across the
// face, and on the table it throws a shadow of its own. It lies beside the set; picked up, it follows the pointer and
// keeps its nose on the screen, and a press sends the next channel.

/** What the television gives the room: the picture's colour (0..1 each) and how bright it is. */
export type RoomLight = { glow: [number, number, number]; level: number }

// Millimetres. The case is LEN x WID x THICK; SPAN is half the square the canvas shows.
const LEN = 172, WID = 48, THICK = 18, SPAN = 112

// The legends, 4 px to the millimetre: x across the face, z from the tail (-86) to the nose (+86, the top of the canvas).
const INK = 4
function drawLegends() {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!
  canvas.width = WID * INK; canvas.height = LEN * INK
  const X = (x: number) => (WID / 2 - x) * INK, Z = (z: number) => (LEN / 2 - z) * INK
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = ctx.strokeStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineCap = 'round'
  const text = (label: string, x: number, z: number, size: number, weight = 700, spacing = 0) => { ctx.font = `${weight} ${size * INK}px Inter, "Helvetica Neue", Arial, sans-serif`; ctx.letterSpacing = `${spacing * INK}px`; ctx.fillText(label, X(x) + spacing * INK / 2, Z(z) + 1) }
  // power
  ctx.lineWidth = 2.6; ctx.beginPath(); ctx.arc(X(13), Z(66), 8.5, -Math.PI * .28, Math.PI * 1.28); ctx.stroke(); ctx.beginPath(); ctx.moveTo(X(13), Z(66) - 11); ctx.lineTo(X(13), Z(66) - 1); ctx.stroke()
  // the number pad
  const pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'TV', '0', 'AV']
  pad.forEach((label, i) => text(label, (1 - i % 3) * 13.5, 46 - Math.floor(i / 3) * 13, label.length > 1 ? 2.9 : 4.6))
  // the rockers: + and - at their ends, their names beside them on the case
  for (const x of [-13, 13]) {
    ctx.lineWidth = 2.8
    ctx.beginPath(); ctx.moveTo(X(x) - 7, Z(-10.5)); ctx.lineTo(X(x) + 7, Z(-10.5)); ctx.moveTo(X(x), Z(-10.5) - 7); ctx.lineTo(X(x), Z(-10.5) + 7); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(X(x) - 7, Z(-27.5)); ctx.lineTo(X(x) + 7, Z(-27.5)); ctx.stroke()
  }
  text('VOL', 13, -36.5, 2.5, 600, .5); text('CH', -13, -36.5, 2.5, 600, .5)
  // mute (a crossed speaker) and menu
  const m = { x: X(0), y: Z(-11) }
  ctx.beginPath(); ctx.moveTo(m.x - 9, m.y - 3.5); ctx.lineTo(m.x - 4.5, m.y - 3.5); ctx.lineTo(m.x + 1, m.y - 8); ctx.lineTo(m.x + 1, m.y + 8); ctx.lineTo(m.x - 4.5, m.y + 3.5); ctx.lineTo(m.x - 9, m.y + 3.5); ctx.closePath(); ctx.fill()
  ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(m.x + 4.5, m.y - 4); ctx.lineTo(m.x + 10, m.y + 4); ctx.moveTo(m.x + 10, m.y - 4); ctx.lineTo(m.x + 4.5, m.y + 4); ctx.stroke()
  ctx.lineWidth = 2.4; for (const dy of [-5, 0, 5]) { ctx.beginPath(); ctx.moveTo(X(0) - 7, Z(-27) + dy); ctx.lineTo(X(0) + 7, Z(-27) + dy); ctx.stroke() }
  // the tape keys: rewind, play, forward, stop
  const tri = (cx: number, cy: number, w: number, dir: number) => { ctx.beginPath(); ctx.moveTo(cx - w * dir, cy - w); ctx.lineTo(cx + w * dir, cy); ctx.lineTo(cx - w * dir, cy + w); ctx.closePath(); ctx.fill() }
  const row = Z(-47)
  tri(X(16.5) + 4, row, 4.5, -1); tri(X(16.5) - 4, row, 4.5, -1); tri(X(5.5), row, 6, 1); tri(X(-5.5) - 4, row, 4.5, 1); tri(X(-5.5) + 4, row, 4.5, 1); ctx.fillRect(X(-16.5) - 5.5, row - 5.5, 11, 11)
  // the maker's name
  text('NIGHTMAIL', 0, -66, 3.1, 800, 1.1)
  return canvas
}

const VERT = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.); gl_Position = vec4(p, 0., 1.); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uInk;
uniform vec2 uRes;
uniform mat3 uRot;            // the remote's axes in view space
uniform vec3 uLight, uLightCol, uPlaneN;   // in the remote's own space
uniform float uPlaneD, uGround, uFlash, uPress;
out vec4 o;

const float TOP = 9., CAM = 900., SPAN = ${SPAN}.;

float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
float box3(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - r; }
float box2(vec2 p, vec2 h, float r) { vec2 d = abs(p) - h + r; return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - r; }
// a key: its outline on the face, standing \`rise\` proud of it, its top edge rounded
float key(float plan, float y, float rise) { vec2 w = vec2(plan, abs(y - (TOP - 1.)) - (1. + rise)); return min(max(w.x, w.y), 0.) + length(max(w + .7, 0.)) - .7; }

// x: distance; y: what it is (0 the case, 1 a grey key, 2 a round key, 3 the power key)
vec2 map(vec3 p) {
  vec2 res = vec2(box3(p, vec3(24., TOP, 86.), 5.5), 0.);
  vec2 q = p.xz - vec2(0., 26.5);
  vec2 c = vec2(clamp(round(q.x / 13.5), -1., 1.) * 13.5, (clamp(floor(q.y / 13.), -2., 1.) + .5) * 13.);
  float keys = key(box2(q - c, vec2(5.1, 4.2), 1.7), p.y, 1.6);
  vec2 t = p.xz - vec2(0., -47.);
  keys = min(keys, key(box2(t - vec2((clamp(floor(t.x / 11.), -2., 1.) + .5) * 11., 0.), vec2(4.3, 3.3), 1.5), p.y, 1.3));
  keys = min(keys, key(box2(p.xz - vec2(13., -19.), vec2(5.4, 12.5), 5.), p.y, 1.9));
  keys = min(keys, key(box2(p.xz - vec2(-13., -19.), vec2(5.4, 12.5), 5.), p.y, 1.9 - uPress));
  if (keys < res.x) res = vec2(keys, 1.);
  float rounds = min(key(length(p.xz - vec2(0., -11.)) - 4.7, p.y, 1.6), key(length(p.xz - vec2(0., -27.)) - 4.7, p.y, 1.6));
  if (rounds < res.x) res = vec2(rounds, 2.);
  float power = key(length(p.xz - vec2(13., 66.)) - 5.1, p.y, 1.7);
  if (power < res.x) res = vec2(power, 3.);
  return res;
}
vec3 normal(vec3 p) { const vec2 e = vec2(.04, -.04); return normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x + e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x); }
float shadow(vec3 ro, vec3 rd) { float res = 1., t = .5; for (int i = 0; i < 20; i++) { float h = map(ro + rd * t).x; res = min(res, 7. * h / t); t += clamp(h, .35, 7.); if (res < .01 || t > 90.) break; } return clamp(res, 0., 1.); }
float occlusion(vec3 p, vec3 n) { float a = 0.; for (float i = 1.; i < 4.; i++) { float d = i * 1.3; a += (d - map(p + n * d).x) / d; } return clamp(1. - a * .32, 0., 1.); }

vec3 shade(vec3 p, vec3 rd) {
  float id = map(p).y;
  vec3 n = normal(p);
  bool face = n.y > .55;
  // what it is made of: grained black plastic, rubber keys, a red power key, a dark red window in the nose
  float grain = noise(p * 2.6), fine = noise(p * 9.);
  vec3 base = vec3(.042) * (.82 + .36 * grain); float gloss = 46., shine = .30;
  bool window = id < .5 && p.z > 83.2 && abs(p.x) < 15. && abs(p.y) < 5.5;
  if (id > .5) { base = vec3(.10) * (.9 + .2 * fine); gloss = 9.; shine = .07; }
  if (id > 1.5) { base = vec3(.15) * (.9 + .2 * fine); }
  if (id > 2.5) { base = vec3(.40, .030, .026) * (.9 + .2 * fine); gloss = 14.; shine = .12; }
  if (window) { base = vec3(.045, .004, .004); gloss = 260.; shine = 1.1; }
  if (id < .5 && !window) {
    n = normalize(n + .05 * (vec3(noise(p * 3.1 + 7.), noise(p * 3.1 + 19.), noise(p * 3.1 + 31.)) - .5));
    // where it has been held: the case is a little shinier, in patches
    float worn = noise(vec3(p.xz * .055, 3.)); gloss *= .6 + 1.1 * worn; shine *= .7 + .8 * worn;
  }
  // printed legends, and the little lamp beside the power key
  if (face) {
    float ink = texture(uInk, vec2((24. - p.x) / 48., (86. - p.z) / 172.)).r;
    base = mix(base, id > .5 ? vec3(.62, .62, .58) : vec3(.34, .34, .33), ink * (id > 2.5 ? .9 : 1.));
  }
  float lamp = id < .5 && face ? smoothstep(1.6, 1.2, length(p.xz - vec2(-13., 66.))) : 0.;
  base = mix(base, vec3(.10, .008, .006), lamp);

  vec3 v = -rd, L = uLight, h = normalize(L + v);
  float lit = clamp((dot(n, L) + .12) / 1.12, 0., 1.), sh = lit > 0. ? shadow(p + n * .12, L) : 0., ao = occlusion(p, n);
  float fres = pow(1. - clamp(dot(n, v), 0., 1.), 4.);
  vec3 col = base * uLightCol * lit * sh;
  col += uLightCol * shine * (pow(max(dot(n, h), 0.), gloss) * (gloss + 8.) / 40.) * lit * sh;
  col += uLightCol * (.02 + .5 * shine) * fres * .12 * ao;                 // the screen's light wrapping its edges
  col += base * (vec3(.055, .060, .075) + uLightCol * .06) * (.6 + .4 * n.y) * ao;   // the room
  col += vec3(1.6, .10, .06) * uFlash * (lamp + (window ? .55 * smoothstep(9., 0., length(p.xy)) : 0.));
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2. - uRes) / uRes;
  mat3 inv = transpose(uRot);
  vec3 ro = inv * vec3(0., 0., CAM), rd = inv * normalize(vec3(uv * SPAN, -CAM));
  float t = CAM - 100., hit = -1., near = 1e9, at = t;
  for (int i = 0; i < 80; i++) {
    float d = map(ro + rd * t).x;
    if (d < near) { near = d; at = t; }
    if (d < .025) { hit = t; break; }
    t += d;
    if (t > CAM + 100.) break;
  }
  float px = 2.4 * SPAN / uRes.x, cover = hit > 0. ? 1. : clamp(1. - near / px, 0., 1.);
  vec3 col = cover > 0. ? shade(ro + rd * (hit > 0. ? hit : at), rd) : vec3(0.);
  // what it does to the table: a shadow away from the screen, and darkness where it touches
  float dark = 0., dn = dot(rd, uPlaneN);
  if (uGround > 0. && cover < 1. && dn < -1e-4) {
    vec3 g = ro + rd * (-(dot(ro, uPlaneN) + uPlaneD) / dn);
    float thrown = dot(uPlaneN, uLight) > 0. ? (1. - shadow(g + uPlaneN * .2, uLight)) * clamp(length(uLightCol) * 1.1, 0., 1.) : 0.;
    float touch = exp(-max(map(g).x, 0.) / 4.5);
    dark = uGround * clamp(thrown * .62 + touch * .55, 0., .9) * smoothstep(1., .72, length(uv));
  }
  col = pow(max(col, 0.), vec3(1. / 2.2));
  o = vec4(col * cover, cover + dark * (1. - cover));
}`

type V = [number, number, number]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: V): V => scale(a, 1 / (Math.hypot(...a) || 1))
const blend = (a: V, b: V, k: number): V => add(scale(a, 1 - k), scale(b, k))
/** `a` with what it shares with the unit vector `f` taken out. */
const square = (a: V, f: V): V => unit(add(a, scale(f, -dot(a, f))))
const rad = (degrees: number) => degrees * Math.PI / 180
const clamp = (v: number) => Math.min(1, Math.max(0, v))
const ease = (v: number) => { const k = clamp(v); return k * k * (3 - 2 * k) }

export function Remote({ light, onZap }: { light: RoomLight; onZap: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), spot = useRef<HTMLButtonElement>(null)
  const [held, setHeld] = useState(false), [ready, setReady] = useState(true)
  const state = useRef({ held: false, over: false, flashAt: -1e9, zap: null as { at: number; sent: boolean } | null }).current
  const zap = useRef(onZap)
  zap.current = onZap
  useEffect(() => {
    const el = canvas.current, button = spot.current, room = el?.closest<HTMLElement>('.chy-set')
    if (!el || !button || !room) return
    const gl = el.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true })
    if (!gl) { setReady(false); return }
    const shader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(program)); setReady(false); return }
    gl.useProgram(program)
    const u = Object.fromEntries(['uInk', 'uRes', 'uRot', 'uLight', 'uLightCol', 'uPlaneN', 'uPlaneD', 'uGround', 'uFlash', 'uPress'].map(name => [name, gl.getUniformLocation(program, name)]))
    const texture = gl.createTexture()
    let alive = true
    const print = () => {
      if (!alive) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawLegends()); gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      drawn = ''
    }
    const calm = matchMedia('(prefers-reduced-motion: reduce)'), touch = matchMedia('(hover: none)')
    // Where things are, in the set's own box (pixels): its width, the middle of the screen, the remote's place on the
    // table (beside the set where the page has room, in front of it where it has not), and the scale (px to a mm:
    // the set is about 46 cm wide).
    let turn = -1, W = 1, mm = 1, screen = { x: 0, y: 0 }, rest = { x: 0, y: 0 }, side = 0
    let pos = { x: 0, y: 0 }, cursor = { x: 0, y: 0 }, lift = 0, hover = 0, raf = 0, drawn = '', last = 0
    const layout = () => {
      // beside the set on whichever side has more room (the left, the set standing right of centre), its nose toward it
      const box = room.getBoundingClientRect(), onLeft = box.left > innerWidth - box.right, free = onLeft ? box.left : innerWidth - box.right, beside = free > box.width * .27
      const away = Math.min(free / 2, box.width * .2, free - LEN * box.width / 460 * .86 * .54)
      turn = beside && onLeft ? 1 : -1
      W = box.width; mm = W / 460 * (beside ? .86 : .72); side = SPAN * 2 * mm
      screen = { x: W * .443, y: box.height * .47 }
      rest = beside ? { x: onLeft ? -away : W + away, y: box.height * 1.0 } : { x: W * .24, y: box.height * 1.02 }
      el.style.width = el.style.height = `${side}px`
      const scaleBy = Math.min(devicePixelRatio || 1, 2), px = Math.round(side * scaleBy)
      if (el.width !== px) { el.width = el.height = px; drawn = '' }
      Object.assign(button.style, { left: `${rest.x - LEN * mm * .5}px`, top: `${rest.y - LEN * mm * .16}px`, width: `${LEN * mm}px`, height: `${LEN * mm * .32}px` })
      if (!state.held && lift === 0) pos = { ...rest }
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = Math.min(64, now - (last || now)); last = now
      // a tap where there is no pointer to follow: it lifts, sends the next channel, and goes back
      const auto = state.zap, since = auto ? now - auto.at : 0
      if (auto && since > 330 && !auto.sent) { auto.sent = true; state.flashAt = now; zap.current() }
      if (auto && since > 900) state.zap = null
      const up = state.held || !!state.zap
      const rate = calm.matches ? 1 : dt / 260
      lift = clamp(lift + (up ? rate : -rate)); hover = clamp(hover + (state.over && !up ? 1 : -1) * (calm.matches ? 1 : dt / 160))
      const h = ease(lift), g = ease(hover) * (1 - h)
      const aim = state.zap ? { x: rest.x + turn * W * .2, y: rest.y - W * .24 } : cursor
      // its axes in the room: lying on the table with its nose turned toward the set, and held with its nose on the screen
      const tilt = rad(16 + 12 * h)
      const lying: V = unit([turn * Math.cos(rad(15)), 0, -Math.sin(rad(15))]), toward: V = unit([screen.x - pos.x, pos.y - screen.y, -W * (.32 + .5 * h)])
      const nose = unit(blend(lying, unit([screen.x - aim.x, aim.y - screen.y, -W * .82]), h))
      const top = square(blend(square([0, Math.cos(rad(40 * g)), Math.sin(rad(40 * g))], lying), [0, 1, .3], h), nose), right = cross(top, nose)
      // seen from a little above: more so in the hand, so its face shows
      const see = (a: V): V => [a[0], a[1] * Math.cos(tilt) - a[2] * Math.sin(tilt), a[1] * Math.sin(tilt) + a[2] * Math.cos(tilt)]
      const axes = [see(right), see(top), see(nose)]
      // in the hand the pointer has it by the tail
      const tip = axes[2]!, target = up ? { x: aim.x + tip[0] * 46 * mm, y: aim.y - tip[1] * 46 * mm } : { x: rest.x, y: rest.y - 9 * mm * g }
      const follow = calm.matches ? 1 : up ? .3 : .2
      pos = { x: pos.x + (target.x - pos.x) * follow, y: pos.y + (target.y - pos.y) * follow }
      if (!up && lift === 0 && hover === 0) pos = { ...rest }
      el.style.transform = `translate3d(${pos.x - side / 2}px, ${pos.y - side / 2}px, 0)`
      const flash = clamp(1 - (now - state.flashAt) / 260), level = Math.min(1.5, light.level)
      const inOwn = (a: V): V => [dot(a, right), dot(a, top), dot(a, nose)]
      const from = inOwn(toward), ground: V = [right[1], top[1], nose[1]]
      const tint = light.glow.map(c => (.35 + c * .9) * level * 1.5)
      const key = [axes.flat().map(v => v.toFixed(3)), from.map(v => v.toFixed(2)), tint.map(v => v.toFixed(2)), h.toFixed(3), g.toFixed(3), flash.toFixed(2), el.width].join()
      if (key === drawn) return
      drawn = key
      gl.viewport(0, 0, el.width, el.height)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1i(u.uInk!, 0); gl.uniform2f(u.uRes!, el.width, el.height)
      gl.uniformMatrix3fv(u.uRot!, false, axes.flat())
      gl.uniform3fv(u.uLight!, from); gl.uniform3fv(u.uLightCol!, tint); gl.uniform3fv(u.uPlaneN!, ground)
      gl.uniform1f(u.uPlaneD!, THICK / 2 + 10 * g + 260 * h); gl.uniform1f(u.uGround!, 1 - ease(h * 2.2))
      gl.uniform1f(u.uFlash!, flash); gl.uniform1f(u.uPress!, flash * 1.1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const move = (event: PointerEvent) => { if (event.pointerType === 'touch') return; const box = room.getBoundingClientRect(); cursor = { x: event.clientX - box.left, y: event.clientY - box.top } }
    const set = (to: boolean) => { state.held = to; setHeld(to) }
    const pick = (event: MouseEvent) => {
      if (touch.matches) { if (!state.zap) state.zap = { at: performance.now(), sent: false }; return }
      const box = room.getBoundingClientRect(); cursor = { x: event.clientX - box.left, y: event.clientY - box.top }
      set(!state.held)
    }
    // in the hand, a press anywhere that is not a control of its own sends the next channel
    const press = (event: MouseEvent) => { if (!state.held || (event.target as Element).closest('button, a, input, [role="slider"]')) return; state.flashAt = performance.now(); zap.current() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && state.held) set(false) }
    const over = () => { state.over = true }, out = () => { state.over = false }
    const sized = new ResizeObserver(layout)
    sized.observe(room)
    addEventListener('resize', layout); addEventListener('pointermove', move); document.addEventListener('click', press); addEventListener('keydown', escape)
    button.addEventListener('click', pick); button.addEventListener('pointerenter', over); button.addEventListener('pointerleave', out)
    layout(); print()
    void document.fonts.load('700 16px Inter').then(print)
    raf = requestAnimationFrame(frame)
    return () => {
      alive = false
      cancelAnimationFrame(raf); sized.disconnect()
      removeEventListener('resize', layout); removeEventListener('pointermove', move); document.removeEventListener('click', press); removeEventListener('keydown', escape)
      button.removeEventListener('click', pick); button.removeEventListener('pointerenter', over); button.removeEventListener('pointerleave', out)
      gl.deleteTexture(texture); gl.deleteProgram(program)
    }
  }, [light, state])
  if (!ready) return null
  return <>
    <canvas className="chy-remote" ref={canvas} aria-hidden="true" />
    <button type="button" className="chy-remote-spot" ref={spot} aria-label="Remote control" aria-pressed={held} />
  </>
}
