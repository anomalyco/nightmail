// The sorter's renderer: WebGL2, one oblique projection (fronts stay true rectangles, so the page's own text sits on the
// machine; depth runs up and a little to the left), one directional light with a shadow map, and flat materials. A
// surface takes one of four tones of its material by how it faces the light (lit top, front, grazing, shade), never a
// gradient; a cast shadow is the shade tone. Letters are instanced thin boxes whose envelope art (edge, flap, stamp,
// address lines, burn) is drawn in the fragment shader, so it is sharp at any size.

import { DX, DY } from './plan'
/** Towards the light: tops are lit most, fronts less, left sides not at all. */
export const LIGHT = norm([0.24, 0.8, -0.55])
export const TONES = 4, MATS = 48

function norm(v: number[]) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] }

const BANDS = `
vec4 pal(float mat, int tone) { return texelFetch(uPal, ivec2(tone, int(mat + .5)), 0); }
// The four flat tones of a material, chosen by facing; band edges are one pixel wide.
vec4 toned(float mat, float nl, float lit) {
  float w = max(fwidth(nl), 1e-4);
  vec4 c = pal(mat, 3);
  c = mix(c, pal(mat, 2), smoothstep(.04 - w, .04 + w, nl));
  c = mix(c, pal(mat, 1), smoothstep(.3 - w, .3 + w, nl));
  c = mix(c, pal(mat, 0), smoothstep(.62 - w, .62 + w, nl));
  return mix(pal(mat, 3), c, lit);
}
float shadowAt(vec3 world, vec3 n) {
  vec4 s = uLight * vec4(world + n * 1.6, 1.);
  vec3 p = s.xyz * .5 + .5;
  if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1. || p.z > 1.) return 1.;
  // Four taps a texel apart, each the card's own blend of four: a shadow's edge is a clean line, not the map's steps.
  vec2 t = 1.1 / vec2(textureSize(uShadow, 0)); float z = p.z - .0009;
  float lit = texture(uShadow, vec3(p.xy + vec2(-t.x, -t.y), z)) + texture(uShadow, vec3(p.xy + vec2(t.x, -t.y), z)) + texture(uShadow, vec3(p.xy + vec2(-t.x, t.y), z)) + texture(uShadow, vec3(p.xy + t, z));
  return smoothstep(.3, .7, lit * .25);
}`

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in float aMat;
uniform mat4 uProj, uModel;
out vec3 vWorld, vNrm; out float vMat;
void main() { vec4 w = uModel * vec4(aPos, 1.); vWorld = w.xyz; vNrm = mat3(uModel) * aNrm; vMat = aMat; gl_Position = uProj * w; }`
const MESH_FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld, vNrm; in float vMat;
uniform sampler2D uPal; uniform sampler2DShadow uShadow; uniform mat4 uLight; uniform vec3 uL, uFlashAt; uniform float uFlash, uFade, uSlab, uFlashR; uniform vec4 uClipA, uClipB;
out vec4 o;
${BANDS}
void main() {
  if (dot(vWorld, uClipA.xyz) > uClipA.w || dot(vWorld, uClipB.xyz) > uClipB.w) discard;
  vec3 n = normalize(vNrm); float nl = dot(n, uL);
  vec4 c = toned(vMat, nl, nl > 0. ? shadowAt(vWorld, n) : 0.);
  // The burst's light, on the machine's own faces: strongest round the window, gone a little way off (sooner below it).
  if (uFlash > 0. && abs(vMat - uSlab) > .5) { vec3 d = vWorld - uFlashAt; if (d.y < 0.) d.y *= 1.9; float far = length(d) / uFlashR; c.rgb = mix(c.rgb, vec3(1., .93, .78), uFlash * (.2 + .5 * max(nl, 0.)) * exp(-far * far)); }
  o = vec4(c.rgb, c.a * uFade);
}`

const LETTER_VS = `#version 300 es
layout(location=0) in vec3 aCorner; layout(location=1) in vec3 aFace;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iQuat; layout(location=4) in vec3 iSize; layout(location=5) in vec4 iA;
uniform mat4 uProj;
out vec3 vWorld, vNrm; out vec2 vUV; out float vFace; out vec4 vA; out vec2 vSize;
vec3 rot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec3 w = iPos + rot(iQuat, aCorner * iSize);
  vWorld = w; vNrm = rot(iQuat, aFace); vUV = aCorner.xy + .5; vFace = aFace.z; vA = iA; vSize = iSize.xy;
  gl_Position = uProj * vec4(w, 1.);
}`
// iA: x seed (0..1), y burn (0..1.2), z kind (0 letter, 1 scam, 2 lodged in the price wall, 3 capsule slip), w highlight.
const LETTER_FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld, vNrm; in vec2 vUV; in float vFace; in vec4 vA; in vec2 vSize;
uniform sampler2D uPal; uniform sampler2DShadow uShadow; uniform mat4 uLight; uniform vec3 uL; uniform float uFlash, uDepthOnly;
uniform float uPaper, uInk, uStamp, uRed, uEmber, uChar, uDim;
out vec4 o;
${BANDS}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y); }
float seg(vec2 p, vec2 a, vec2 b) { vec2 d = b - a; return length(p - a - d * clamp(dot(p - a, d) / dot(d, d), 0., 1.)); }
void main() {
  float burn = vA.y, r = 0.;
  if (burn > 0.) { r = length(vUV - .5) * 1.1 + noise(vUV * 7. + vA.x * 50.) * .45; if (r < burn * 1.3 - .14) discard; }
  if (uDepthOnly > .5) { o = vec4(0.); return; }
  vec3 n = normalize(vNrm); float nl = dot(n, uL);
  float lit = nl > 0. ? shadowAt(vWorld, n) : 0.;
  bool lodged = vA.z > 1.5 && vA.z < 2.5;
  vec4 paper = lodged ? pal(uPaper, 1) : toned(vA.z > 2.5 ? uDim : uPaper, nl, lit);
  vec3 c = paper.rgb;
  // Lengths on the face in pixels: p is the position from the bottom left, s the face's size.
  vec2 s = vSize, p = vUV * s; float px = max(fwidth(p.x), fwidth(p.y)) + 1e-4;
  if (abs(vFace) > .5) {
    vec3 ink = pal(uInk, 1).rgb;
    bool scam = vA.z > .5 && vA.z < 1.5;
    bool front = vFace < 0. ? fract(vA.x * 7.) < (lodged ? .12 : 2.) : false;
    if (front) {
      // The address side: a stamp, three lines of address; a scam shouts across the top.
      vec2 q = (p - s * vec2(.8, .7)) / (s.y * vec2(.16, .2));
      float stamp = 1. - smoothstep(1. - px / (s.y * .16), 1., max(abs(q.x), abs(q.y)));
      c = mix(c, pal(scam ? uRed : uStamp, 1).rgb, stamp);
      for (int i = 0; i < 3; i++) {
        float y = s.y * (.5 - float(i) * .13), x1 = s.x * (.5 - float(i) * .07), t = max(s.y * .028, px * .5);
        float line = (1. - smoothstep(t - px, t + px, abs(p.y - y))) * step(s.x * .14, p.x) * step(p.x, x1);
        c = mix(c, ink, line * .5 * min(1., t / px * .5 + .35));
      }
      if (scam) c = mix(c, pal(uRed, 1).rgb, 1. - smoothstep(-px, px, s.y * .84 - p.y));
    } else {
      // The flap side: two creases from the top corners to a point under the middle.
      float d = min(seg(p, vec2(0., s.y), s * vec2(.5, .42)), seg(p, vec2(s.x, s.y), s * vec2(.5, .42)));
      c = mix(c, ink, (1. - smoothstep(0., px * 1.3, d - px * .2)) * (lodged ? .3 : .42));
      if (scam) c = mix(c, pal(uRed, 1).rgb, 1. - smoothstep(-px, px, p.y - s.y * .14));
    }
    // A hairline edge, so letters in a heap stay apart.
    float e = min(min(p.x, s.x - p.x), min(p.y, s.y - p.y));
    if (!lodged) c = mix(c, ink, (1. - smoothstep(0., px * 1.2, e)) * .34);
    if (vA.w > 0.) c = mix(c, pal(uStamp, 0).rgb, (1. - smoothstep(px * 1.5, px * 2.5, e)) * vA.w);
  } else c = mix(c, pal(uInk, 1).rgb, .25);
  if (burn > 0.) {
    float b = burn * 1.3 - .14;
    c = mix(c, pal(uChar, 1).rgb, (1. - smoothstep(b + .1, b + .55, r)) * .92);
    c = mix(c, pal(uEmber, 1).rgb, 1. - smoothstep(b + .02, b + .08, r));
    c = mix(c, vec3(1., .96, .8), 1. - smoothstep(b, b + .025, r));
  }
  o = vec4(c, 1.);
}`

// Puffs, sparks and light: quads that face the page. Shape 0 a flat disc, 1 a flat rectangle, 2 a soft light, 3 a beam.
const FX_VS = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec3 iPos; layout(location=2) in vec3 iSize; layout(location=3) in vec4 iCol; layout(location=4) in float iShape;
uniform mat4 uProj; uniform vec2 uView;
out vec2 vQ; out vec4 vCol; out float vShape; out vec2 vHalf;
void main() {
  float c = cos(iSize.z), s = sin(iSize.z); vec2 q = aQuad * iSize.xy; q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = uProj * vec4(iPos, 1.); gl_Position.xy += q * 2. / uView;
  vQ = aQuad; vCol = iCol; vShape = iShape; vHalf = iSize.xy;
}`
const FX_FS = `#version 300 es
precision highp float;
in vec2 vQ; in vec4 vCol; in float vShape; in vec2 vHalf;
out vec4 o;
void main() {
  float a = 1.;
  if (vShape < .5) { float r = length(vQ) * vHalf.x; a = 1. - smoothstep(vHalf.x - 1.2, vHalf.x, r); }
  else if (vShape < 1.5) { vec2 e = (1. - abs(vQ)) * vHalf; a = clamp(min(e.x, e.y), 0., 1.); }
  else if (vShape < 2.5) { float r = clamp(1. - length(vQ), 0., 1.); a = r * r; }
  else { float y = abs(vQ.y); a = (1. - smoothstep(.0, 1., y)) * .55 + (1. - smoothstep(.12, .3, y)); o = vec4(mix(vCol.rgb, vec3(1.), 1. - smoothstep(.1, .34, y)) * vCol.a * min(a, 1.), 0.); return; }
  o = vec4(vCol.rgb * vCol.a * a, vShape > 1.5 ? 0. : vCol.a * a);
}`

// Smoke and steam: soft sprites that face the page, each a billow. Its edge is eaten away by a cloud noise that is
// itself pushed about by a slower one (so no two look alike and none looks like a disc), and the noise drifts through
// it as it ages. It is lit like a ball by the scene's own light, the noise bending its surface, so a plume has a lit
// side and a dark one; just after the burst its dark side takes a little of the fire's colour. Drawn into a buffer a
// fraction of the page's size and laid over the scene: density adds up where billows overlap.
// iP: x age (0 to 1), y seed, z density, w what it is (0 steam, 1 smoke). iQ: x heat.
const SMOKE_VS = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec3 iPos; layout(location=2) in vec2 iSize; layout(location=3) in vec4 iP; layout(location=4) in float iHeat;
uniform mat4 uProj; uniform vec2 uView;
out vec2 vQ, vS; out vec4 vP; out float vHeat;
void main() {
  float c = cos(iSize.y), s = sin(iSize.y); vec2 q = vec2(aQuad.x * c - aQuad.y * s, aQuad.x * s + aQuad.y * c);
  gl_Position = uProj * vec4(iPos, 1.); gl_Position.xy += q * iSize.x * 2. / uView;
  vQ = aQuad; vS = q; vP = iP; vHeat = iHeat;
}`
const SMOKE_FS = `#version 300 es
precision mediump float;
in vec2 vQ, vS; in vec4 vP; in float vHeat;
uniform sampler2D uNoise; uniform vec3 uLit0, uLit1, uShade0, uShade1, uHot;
out vec4 o;
void main() {
  float r = length(vQ);
  if (r >= 1.) discard;
  vec2 p = vQ * .5, drift = vec2(0., -vP.x * .32);
  vec2 warp = texture(uNoise, p * .8 + vP.y * 7.31 + drift * .6).rg - .5;
  float cloud = texture(uNoise, p * 1.35 + warp * .42 + vP.y * 3.17 + drift).b * .72 + texture(uNoise, p * 3.4 + warp * .25 + vP.y * 1.3 + drift * 1.8).a * .28;
  float body = smoothstep(1., .18, r + (cloud - .5) * (.62 + vP.x * .55));
  float alpha = body * body * vP.z * smoothstep(0., .1, vP.x) * (1. - smoothstep(.45, 1., vP.x));
  // The page's own light (gl.ts LIGHT, as the page sees it): from above, a little from the right and the front.
  vec3 n = normalize(vec3(vS + warp * 1.1, sqrt(max(1. - r * r, 0.)) * .75 + .2));
  float lit = smoothstep(-.3, .8, dot(n, vec3(.24, .8, .55)) + (cloud - .5) * .5);
  vec3 c = mix(mix(uShade0, uShade1, vP.w), mix(uLit0, uLit1, vP.w), lit);
  c = mix(c, uHot, vHeat * (1. - lit) * .55);
  o = vec4(c * alpha, alpha);
}`
const OVER_VS = `#version 300 es
out vec2 vUV;
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.); vUV = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`
const OVER_FS = `#version 300 es
precision mediump float;
in vec2 vUV; uniform sampler2D uSmoke; out vec4 o;
void main() { o = texture(uSmoke, vUV); }`

/** A tile of cloud noise, four different ones in its four channels: two slow ones to push with, a cloud, a fine one. */
function noiseTile(size: number) {
  const bytes = new Uint8Array(size * size * 4)
  const lattice = (seed: number, period: number) => { const values = new Float32Array(period * period); let s = seed; for (let i = 0; i < values.length; i++) { s = Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0; values[i] = ((s ^ s >>> 13) >>> 0) / 4294967296 } return (x: number, y: number) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), at = (a: number, b: number) => values[(b % period + period) % period * period + (a % period + period) % period]; return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v } }
  const fbm = (seed: number, periods: number[]) => { const layers = periods.map((period, i) => [lattice(seed + i * 101, period), period, .5 ** i] as const), total = layers.reduce((sum, layer) => sum + layer[2], 0); return (x: number, y: number) => layers.reduce((sum, [noise, period, weight]) => sum + noise(x * period, y * period) * weight, 0) / total }
  const channels = [fbm(11, [3, 6]), fbm(47, [3, 6]), fbm(83, [4, 8, 16, 32]), fbm(131, [16, 32, 64])]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) bytes[(y * size + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (channels[c](x / size, y / size) - .5) * 1.7 + .5)) * 255)
  return bytes
}

/** `plain`: too small a thing to throw a shadow worth drawing (a roller in the works: fifty-six scallops along one edge). */
export type Part = { start: number; count: number; m: Float32Array; on: boolean; glass: boolean; fade: number; plain?: boolean; clip?: Float32Array }
/** `clip`: two planes (normal, distance); nothing of the part is drawn beyond either (a capsule sliding out of a block). */
export const LETTER_FLOATS = 14, FX_FLOATS = 11, SMOKE_FLOATS = 10

export type Renderer = ReturnType<typeof createRenderer>

export function createRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })
  if (!gl) return null
  const program = (vs: string, fs: string) => {
    const make = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('sorter shader', gl.getShaderInfoLog(s)); return s }
    const p = gl.createProgram()!; gl.attachShader(p, make(gl.VERTEX_SHADER, vs)); gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('sorter program', gl.getProgramInfoLog(p))
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    return { p, u: (name: string) => uniforms[name] ??= gl.getUniformLocation(p, name) }
  }
  const mesh = program(MESH_VS, MESH_FS), letter = program(LETTER_VS, LETTER_FS), fx = program(FX_VS, FX_FS), smoke = program(SMOKE_VS, SMOKE_FS), over = program(OVER_VS, OVER_FS)

  // The palette: a row of four tones for each material.
  const palette = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, palette)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TONES, MATS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  // The smoke's noise, and the small buffer smoke is drawn into.
  const noise = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, noise)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseTile(128))
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const haze = gl.createTexture()!, hazeTarget = gl.createFramebuffer()!
  let hazeW = 0, hazeH = 0
  const sizeHaze = (width: number, height: number) => {
    if (width === hazeW && height === hazeH) return
    hazeW = width; hazeH = height
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, haze)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTarget); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, haze, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // The shadow map, and a blank one to read while the real one is being drawn.
  const depthTexture = (size: number) => {
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL)
    return t
  }
  let shadowSize = 2048
  let shadow = depthTexture(shadowSize)
  const blank = depthTexture(1), target = gl.createFramebuffer()!
  const attach = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadow, 0); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); gl.bindFramebuffer(gl.FRAMEBUFFER, null) }
  attach()
  gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, blank, 0); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); attach()

  // The machine: one buffer of position, normal, material.
  const meshVao = gl.createVertexArray()!, meshBuffer = gl.createBuffer()!
  gl.bindVertexArray(meshVao); gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer)
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0)
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12)
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24)

  // A letter: a unit box, instanced.
  const boxData: number[] = []
  const face = (n: number[], a: number[], b: number[]) => { for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) boxData.push(.5 * (n[0] + a[0] * u + b[0] * v), .5 * (n[1] + a[1] * u + b[1] * v), .5 * (n[2] + a[2] * u + b[2] * v), n[0], n[1], n[2]) }
  face([0, 0, -1], [1, 0, 0], [0, 1, 0]); face([0, 0, 1], [-1, 0, 0], [0, 1, 0]); face([1, 0, 0], [0, 0, 1], [0, 1, 0]); face([-1, 0, 0], [0, 0, -1], [0, 1, 0]); face([0, 1, 0], [1, 0, 0], [0, 0, 1]); face([0, -1, 0], [1, 0, 0], [0, 0, -1])
  const instanced = (unit: Float32Array, unitSize: number, floats: number, layout: number[]) => {
    const vao = gl.createVertexArray()!, unitBuffer = gl.createBuffer()!, buffer = gl.createBuffer()!
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, unitBuffer); gl.bufferData(gl.ARRAY_BUFFER, unit, gl.STATIC_DRAW)
    let location = 0
    for (let offset = 0; offset < unitSize; location++) { const size = unitSize === 2 ? 2 : 3; gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, unitSize * 4, offset * 4); offset += size }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    let offset = 0
    for (const size of layout) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, floats * 4, offset * 4); gl.vertexAttribDivisor(location, 1); offset += size; location++ }
    let capacity = 0
    return { vao, upload(data: Float32Array, count: number) { gl.bindBuffer(gl.ARRAY_BUFFER, buffer); if (count * floats > capacity) { capacity = Math.max(count * floats, capacity * 2); gl.bufferData(gl.ARRAY_BUFFER, capacity * 4, gl.DYNAMIC_DRAW) } gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * floats) } }
  }
  const letters = instanced(new Float32Array(boxData), 6, LETTER_FLOATS, [3, 4, 3, 4]), wall = instanced(new Float32Array(boxData), 6, LETTER_FLOATS, [3, 4, 3, 4])
  const quads = instanced(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2, FX_FLOATS, [3, 3, 4, 1]), billows = instanced(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2, SMOKE_FLOATS, [3, 2, 4, 1])
  gl.bindVertexArray(null)

  const proj = new Float32Array(16), light = new Float32Array(16), identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  let W = 1, H = 1, dpr = 1, vertices = 0, wallCount = 0
  const mats = { paper: 0, ink: 0, stamp: 0, red: 0, ember: 0, char: 0, dim: 0, slab: 0 }
  const clear = [0, 0, 0], smokeTones = { lit0: [1, 1, 1], lit1: [.5, .5, .5], shade0: [.4, .4, .4], shade1: [.1, .1, .1], hot: [1, .6, .3] }
  let shadowWanted = 2048

  return {
    gl,
    /** `quality`: the shadow map's size and how much smaller than the page the smoke's buffer is. */
    /** `box`: how high and how deep the world is that throws and takes shadows. */
    resize(width: number, height: number, ratio: number, ox: number, oy: number, quality: { shadow: number; smoke: number }, box: { y0: number; y1: number; z0: number; z1: number }) {
      W = width; H = height; dpr = ratio; shadowWanted = quality.shadow
      sizeHaze(Math.max(64, Math.round(W * dpr * quality.smoke)), Math.max(64, Math.round(H * dpr * quality.smoke)))
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      proj.set([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 2 * DX / W, 2 * DY / H, 1 / 3000, 0, 2 * ox / W - 1, 1 - 2 * oy / H, -1 / 3, 1])
      // The light's own view of what the page shows, for the shadow map: a box round the slab in view, the machine
      // and a little air over it, looked at along the light. No wider than that: every texel is wanted.
      const zf = box.z0, zb = box.z1, x0 = -ox - 30, x1 = W - ox + 30, top = box.y1, bottom = box.y0
      const f = [-LIGHT[0], -LIGHT[1], -LIGHT[2]], r = norm([f[2], 0, -f[0]]), u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (const x of [x0, x1]) for (const y of [bottom, top]) for (const z of [zf, zb]) [r, u, f].forEach((axis, i) => { const d = axis[0] * x + axis[1] * y + axis[2] * z; lo[i] = Math.min(lo[i], d); hi[i] = Math.max(hi[i], d) })
      const sx = 2 / (hi[0] - lo[0]), sy = 2 / (hi[1] - lo[1]), sz = 2 / (hi[2] - lo[2])
      light.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0, -(hi[0] + lo[0]) / (hi[0] - lo[0]), -(hi[1] + lo[1]) / (hi[1] - lo[1]), -(hi[2] + lo[2]) / (hi[2] - lo[2]), 1])
      const wanted = shadowWanted
      if (wanted !== shadowSize) { gl.deleteTexture(shadow); shadowSize = wanted; shadow = depthTexture(shadowSize); attach() }
    },
    setPalette(rgba: Uint8Array) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palette); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TONES, MATS, gl.RGBA, gl.UNSIGNED_BYTE, rgba) },
    setMaterials(next: typeof mats) { Object.assign(mats, next) },
    /** The page's own colour, behind everything. */
    setClear(r: number, g: number, b: number) { clear[0] = r; clear[1] = g; clear[2] = b },
    /** Steam's and smoke's lit and shaded colours, and what the fire lends smoke's dark side. */
    setSmoke(next: typeof smokeTones) { Object.assign(smokeTones, next) },
    setMesh(data: Float32Array) { gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); vertices = data.length / 7 },
    setWall(data: Float32Array, count: number) { wall.upload(data, count); wallCount = count },
    get vertices() { return vertices },
    draw(scene: { parts: Part[]; letters: Float32Array; letterCount: number; fx: Float32Array; fxCount: number; glow: Float32Array; glowCount: number; smoke: Float32Array; smokeCount: number; flash: number; flashAt: number[]; flashR: number; wallOn: boolean }) {
      const pass = (matrix: Float32Array, depthOnly: boolean) => {
        gl.useProgram(mesh.p)
        gl.uniformMatrix4fv(mesh.u('uProj'), false, matrix); gl.uniformMatrix4fv(mesh.u('uLight'), false, light); gl.uniform3fv(mesh.u('uL'), LIGHT)
        gl.uniform1f(mesh.u('uFlash'), scene.flash); gl.uniform1f(mesh.u('uFade'), 1); gl.uniform1f(mesh.u('uSlab'), mats.slab); gl.uniform3fv(mesh.u('uFlashAt'), scene.flashAt); gl.uniform1f(mesh.u('uFlashR'), scene.flashR)
        gl.uniform1i(mesh.u('uPal'), 0); gl.uniform1i(mesh.u('uShadow'), 1)
        gl.bindVertexArray(meshVao); gl.uniform4f(mesh.u('uClipA'), 0, 0, 0, 1); gl.uniform4f(mesh.u('uClipB'), 0, 0, 0, 1)
        for (const part of scene.parts) if (part.on && !part.glass && part.fade >= 1 && !(depthOnly && part.plain)) {
          if (part.clip) { gl.uniform4fv(mesh.u('uClipA'), part.clip.subarray(0, 4)); gl.uniform4fv(mesh.u('uClipB'), part.clip.subarray(4, 8)) }
          gl.uniformMatrix4fv(mesh.u('uModel'), false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count)
          if (part.clip) { gl.uniform4f(mesh.u('uClipA'), 0, 0, 0, 1); gl.uniform4f(mesh.u('uClipB'), 0, 0, 0, 1) }
        }
        gl.useProgram(letter.p)
        gl.uniformMatrix4fv(letter.u('uProj'), false, matrix); gl.uniformMatrix4fv(letter.u('uLight'), false, light); gl.uniform3fv(letter.u('uL'), LIGHT)
        gl.uniform1f(letter.u('uFlash'), scene.flash); gl.uniform1f(letter.u('uDepthOnly'), depthOnly ? 1 : 0)
        gl.uniform1i(letter.u('uPal'), 0); gl.uniform1i(letter.u('uShadow'), 1)
        gl.uniform1f(letter.u('uPaper'), mats.paper); gl.uniform1f(letter.u('uInk'), mats.ink); gl.uniform1f(letter.u('uStamp'), mats.stamp); gl.uniform1f(letter.u('uRed'), mats.red); gl.uniform1f(letter.u('uEmber'), mats.ember); gl.uniform1f(letter.u('uChar'), mats.char); gl.uniform1f(letter.u('uDim'), mats.dim)
        if (!depthOnly && wallCount && scene.wallOn) { gl.bindVertexArray(wall.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, wallCount) }
        if (scene.letterCount) { gl.bindVertexArray(letters.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, scene.letterCount) }
      }
      if (scene.letterCount) letters.upload(scene.letters, scene.letterCount)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palette)
      // The shadow map first, reading a blank one meanwhile.
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blank)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, shadowSize, shadowSize); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4)
      pass(light, true)
      gl.disable(gl.POLYGON_OFFSET_FILL)
      // Smoke, into its own small buffer (every pass that is not the page's own comes first: a phone's GPU pays to be
      // interrupted mid-frame).
      if (scene.smokeCount) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTarget); gl.viewport(0, 0, hazeW, hazeH); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(smoke.p); gl.uniformMatrix4fv(smoke.u('uProj'), false, proj); gl.uniform2f(smoke.u('uView'), W, H); gl.uniform1i(smoke.u('uNoise'), 2)
        gl.uniform3fv(smoke.u('uLit0'), smokeTones.lit0); gl.uniform3fv(smoke.u('uLit1'), smokeTones.lit1); gl.uniform3fv(smoke.u('uShade0'), smokeTones.shade0); gl.uniform3fv(smoke.u('uShade1'), smokeTones.shade1); gl.uniform3fv(smoke.u('uHot'), smokeTones.hot)
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, noise)
        billows.upload(scene.smoke, scene.smokeCount); gl.bindVertexArray(billows.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.smokeCount)
        gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadow)
      gl.clearColor(clear[0], clear[1], clear[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      pass(proj, false)
      // Glass and anything fading in or out, over what is behind it.
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false)
      gl.useProgram(mesh.p); gl.bindVertexArray(meshVao)
      // A tube's far wall first, then its near one: the same glass whichever way a tube runs.
      gl.enable(gl.CULL_FACE)
      for (const face of [gl.BACK, gl.FRONT]) {
        gl.cullFace(face)
        for (const part of scene.parts) if (part.on && (part.glass || part.fade < 1) && part.fade > 0) { gl.uniform1f(mesh.u('uFade'), part.fade); gl.uniformMatrix4fv(mesh.u('uModel'), false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count) }
      }
      gl.disable(gl.CULL_FACE)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      if (scene.smokeCount) {
        gl.disable(gl.DEPTH_TEST); gl.useProgram(over.p); gl.uniform1i(over.u('uSmoke'), 3); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, haze)
        gl.bindVertexArray(null); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.enable(gl.DEPTH_TEST)
      }
      gl.useProgram(fx.p); gl.uniformMatrix4fv(fx.u('uProj'), false, proj); gl.uniform2f(fx.u('uView'), W, H)
      gl.bindVertexArray(quads.vao)
      if (scene.fxCount) { quads.upload(scene.fx, scene.fxCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.fxCount) }
      if (scene.glowCount) { gl.disable(gl.DEPTH_TEST); quads.upload(scene.glow, scene.glowCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.glowCount) }
      gl.bindVertexArray(null); gl.depthMask(true)
    },
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
  }
}
