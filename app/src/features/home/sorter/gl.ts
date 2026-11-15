// The sorter's renderer: WebGL2, one oblique projection (fronts stay true rectangles, so the page's own text sits on the
// machine; depth runs up and a little to the left), one directional light with a shadow map, and flat materials. A
// surface takes one of four tones of its material by how it faces the light (lit top, front, grazing, shade), never a
// gradient; a cast shadow is the shade tone. Letters are instanced thin boxes whose envelope art (edge, flap, stamp,
// address lines, burn) is drawn in the fragment shader, so it is sharp at any size.

import { DX, DY } from './plan'
/** Towards the light: tops are lit most, fronts less, left sides not at all. */
export const LIGHT = norm([0.44, 0.8, -0.41])
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
  return texture(uShadow, vec3(p.xy, p.z - .0009));
}`

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in float aMat;
uniform mat4 uProj, uModel; uniform vec2 uShake;
out vec3 vWorld, vNrm; out float vMat;
void main() { vec4 w = uModel * vec4(aPos, 1.); vWorld = w.xyz; vNrm = mat3(uModel) * aNrm; vMat = aMat; gl_Position = uProj * w; gl_Position.xy += uShake; }`
const MESH_FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld, vNrm; in float vMat;
uniform sampler2D uPal; uniform sampler2DShadow uShadow; uniform mat4 uLight; uniform vec3 uL; uniform float uFlash, uFade;
out vec4 o;
${BANDS}
void main() {
  vec3 n = normalize(vNrm); float nl = dot(n, uL);
  vec4 c = toned(vMat, nl, nl > 0. ? shadowAt(vWorld, n) : 0.);
  c.rgb = mix(c.rgb, vec3(1.), uFlash * (.25 + .5 * max(nl, 0.)));
  o = vec4(c.rgb, c.a * uFade);
}`

const LETTER_VS = `#version 300 es
layout(location=0) in vec3 aCorner; layout(location=1) in vec3 aFace;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iQuat; layout(location=4) in vec3 iSize; layout(location=5) in vec4 iA;
uniform mat4 uProj; uniform vec2 uShake;
out vec3 vWorld, vNrm; out vec2 vUV; out float vFace; out vec4 vA; out vec2 vSize;
vec3 rot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec3 w = iPos + rot(iQuat, aCorner * iSize);
  vWorld = w; vNrm = rot(iQuat, aFace); vUV = aCorner.xy + .5; vFace = aFace.z; vA = iA; vSize = iSize.xy;
  gl_Position = uProj * vec4(w, 1.); gl_Position.xy += uShake;
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
  if (burn > 0.) { r = length(vUV - .5) * 1.1 + noise(vUV * 7. + vA.x * 50.) * .45; if (r < burn * 1.7 - .1) discard; }
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
    float b = burn * 1.7 - .1;
    c = mix(c, pal(uChar, 1).rgb, 1. - smoothstep(b + .06, b + .2, r));
    c = mix(c, pal(uEmber, 1).rgb, 1. - smoothstep(b + .02, b + .07, r));
    c = mix(c, vec3(1., .96, .8), 1. - smoothstep(b, b + .025, r));
  }
  c = mix(c, vec3(1.), uFlash * .3);
  o = vec4(c, 1.);
}`

// Puffs, sparks and light: quads that face the page. Shape 0 a flat disc, 1 a flat rectangle, 2 a soft light, 3 a beam.
const FX_VS = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec3 iPos; layout(location=2) in vec3 iSize; layout(location=3) in vec4 iCol; layout(location=4) in float iShape;
uniform mat4 uProj; uniform vec2 uView, uShake;
out vec2 vQ; out vec4 vCol; out float vShape; out vec2 vHalf;
void main() {
  float c = cos(iSize.z), s = sin(iSize.z); vec2 q = aQuad * iSize.xy; q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = uProj * vec4(iPos, 1.); gl_Position.xy += q * 2. / uView + uShake;
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

export type Part = { start: number; count: number; m: Float32Array; on: boolean; glass: boolean; fade: number }
export const LETTER_FLOATS = 14, FX_FLOATS = 11

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
  const mesh = program(MESH_VS, MESH_FS), letter = program(LETTER_VS, LETTER_FS), fx = program(FX_VS, FX_FS)

  // The palette: a row of four tones for each material.
  const palette = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, palette)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TONES, MATS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

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
  const quads = instanced(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2, FX_FLOATS, [3, 3, 4, 1])
  gl.bindVertexArray(null)

  const proj = new Float32Array(16), light = new Float32Array(16), identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  let W = 1, H = 1, dpr = 1, vertices = 0, wallCount = 0
  const mats = { paper: 0, ink: 0, stamp: 0, red: 0, ember: 0, char: 0, dim: 0 }

  return {
    gl,
    resize(width: number, height: number, ratio: number, ox: number, oy: number) {
      W = width; H = height; dpr = ratio
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      proj.set([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 2 * DX / W, 2 * DY / H, 1 / 3000, 0, 2 * ox / W - 1, 1 - 2 * oy / H, -1 / 3, 1])
      // The light's own view of everything the page can show, for the shadow map: a box round the floor in view and
      // the air over it, looked at along the light.
      const zf = -(H - oy) / DY - 200, zb = oy / DY + 200, x0 = -ox - 300, x1 = W - ox + 300, top = 1500
      const f = [-LIGHT[0], -LIGHT[1], -LIGHT[2]], r = norm([f[2], 0, -f[0]]), u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (const x of [x0, x1]) for (const y of [0, top]) for (const z of [zf, zb]) [r, u, f].forEach((axis, i) => { const d = axis[0] * x + axis[1] * y + axis[2] * z; lo[i] = Math.min(lo[i], d); hi[i] = Math.max(hi[i], d) })
      const sx = 2 / (hi[0] - lo[0]), sy = 2 / (hi[1] - lo[1]), sz = 2 / (hi[2] - lo[2])
      light.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0, -(hi[0] + lo[0]) / (hi[0] - lo[0]), -(hi[1] + lo[1]) / (hi[1] - lo[1]), -(hi[2] + lo[2]) / (hi[2] - lo[2]), 1])
      const wanted = W < 640 ? 1024 : 2048
      if (wanted !== shadowSize) { gl.deleteTexture(shadow); shadowSize = wanted; shadow = depthTexture(shadowSize); attach() }
    },
    setPalette(rgba: Uint8Array) { gl.bindTexture(gl.TEXTURE_2D, palette); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TONES, MATS, gl.RGBA, gl.UNSIGNED_BYTE, rgba) },
    setMaterials(next: typeof mats) { Object.assign(mats, next) },
    setMesh(data: Float32Array) { gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); vertices = data.length / 7 },
    setWall(data: Float32Array, count: number) { wall.upload(data, count); wallCount = count },
    get vertices() { return vertices },
    draw(scene: { parts: Part[]; letters: Float32Array; letterCount: number; fx: Float32Array; fxCount: number; glow: Float32Array; glowCount: number; shake: [number, number]; flash: number; wallOn: boolean }) {
      const pass = (matrix: Float32Array, depthOnly: boolean) => {
        gl.useProgram(mesh.p)
        gl.uniformMatrix4fv(mesh.u('uProj'), false, matrix); gl.uniformMatrix4fv(mesh.u('uLight'), false, light); gl.uniform3fv(mesh.u('uL'), LIGHT)
        gl.uniform2f(mesh.u('uShake'), depthOnly ? 0 : scene.shake[0] * 2 / W, depthOnly ? 0 : scene.shake[1] * 2 / H); gl.uniform1f(mesh.u('uFlash'), scene.flash); gl.uniform1f(mesh.u('uFade'), 1)
        gl.uniform1i(mesh.u('uPal'), 0); gl.uniform1i(mesh.u('uShadow'), 1)
        gl.bindVertexArray(meshVao)
        for (const part of scene.parts) if (part.on && !part.glass && part.fade >= 1) { gl.uniformMatrix4fv(mesh.u('uModel'), false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count) }
        gl.useProgram(letter.p)
        gl.uniformMatrix4fv(letter.u('uProj'), false, matrix); gl.uniformMatrix4fv(letter.u('uLight'), false, light); gl.uniform3fv(letter.u('uL'), LIGHT)
        gl.uniform2f(letter.u('uShake'), depthOnly ? 0 : scene.shake[0] * 2 / W, depthOnly ? 0 : scene.shake[1] * 2 / H); gl.uniform1f(letter.u('uFlash'), scene.flash); gl.uniform1f(letter.u('uDepthOnly'), depthOnly ? 1 : 0)
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadow)
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      pass(proj, false)
      // Glass and anything fading in or out, over what is behind it.
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false)
      gl.useProgram(mesh.p); gl.bindVertexArray(meshVao)
      for (const part of scene.parts) if (part.on && (part.glass || part.fade < 1) && part.fade > 0) { gl.uniform1f(mesh.u('uFade'), part.fade); gl.uniformMatrix4fv(mesh.u('uModel'), false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count) }
      gl.useProgram(fx.p); gl.uniformMatrix4fv(fx.u('uProj'), false, proj); gl.uniform2f(fx.u('uView'), W, H); gl.uniform2f(fx.u('uShake'), scene.shake[0] * 2 / W, scene.shake[1] * 2 / H)
      gl.bindVertexArray(quads.vao); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      if (scene.fxCount) { quads.upload(scene.fx, scene.fxCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.fxCount) }
      if (scene.glowCount) { gl.disable(gl.DEPTH_TEST); quads.upload(scene.glow, scene.glowCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.glowCount) }
      gl.bindVertexArray(null); gl.depthMask(true)
    },
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
  }
}
