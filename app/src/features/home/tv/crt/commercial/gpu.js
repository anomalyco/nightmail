// WebGPU renderer for the broadcast. Two layers, back to front:
//
//   1. Doug's footage: each shot draws its little scene (uber pipeline) into its own tile of one
//      feed texture
//   2. the broadcast: the studio backdrop (uber), the footage tiles with their film look (FEED),
//      then the pitchman, the type and the graphics (uber), straight onto the canvas
//
// The canvas is only the picture: the television it is shown on (/cheaper/y's set) brings its own
// tube, glass and room, so there is no CRT, bloom or shake here.
import { BF, F, UBER } from "./shaders.js"

export { BF, F, FL, T } from "./shaders.js"

// One big tile for the main shot and eight small ones, in a 2560×1440 texture. Every shot
// draws in the same 640×480 space whatever the size of its tile.
export const CW = 640
export const CH = 480
const FEED_W = 2560
const FEED_H = 1440
export const TILES = [
  [0, 0, 1280, 960],
  [1280, 0, 640, 480], [1920, 0, 640, 480],
  [1280, 480, 640, 480], [1920, 480, 640, 480],
  [1280, 960, 640, 480], [1920, 960, 640, 480],
  [0, 960, 640, 480], [640, 960, 640, 480],
]
export const QF = 24 // floats per feed quad
const MAX_QUADS = 16

// A piece of Doug's footage on the broadcast: cover-cropped into its rect and given the look of
// old black-and-white film stock (the "before" half of every infomercial), with grain, line noise,
// a hum bar, and a flicker of static on every cut. Only red survives the monochrome: the badge on
// his phone, a gnome's hat, an ON AIR light.
const FEED = /* wgsl */ `
struct FU { view: vec4f } // broadcast w, h, time, -
struct Q {
  rect: vec4f,  // x, y, w, h in broadcast px
  src: vec4f,   // tile uv: u0, v0, u1, v1
  look: vec4f,  // mode (0 day, 1 night), -, noise, zoom
  look2: vec4f, // zoom centre x, y (0..1 of the tile), alpha, corner radius
  tone: vec4f,  // gain, contrast, glitch (0..1), flash
  misc: vec4f,  // seed, tile px height, -, -
}
@group(0) @binding(0) var<uniform> u: FU;
@group(0) @binding(1) var<storage, read> quads: array<Q>;
@group(0) @binding(2) var feed: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) qi: u32 }
const CORNERS = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let q = quads[ii];
  let k = CORNERS[vi];
  let w = q.rect.xy + k * q.rect.zw;
  var o: VO;
  o.pos = vec4f(w.x / u.view.x * 2.0 - 1.0, 1.0 - w.y / u.view.y * 2.0, 0.0, 1.0);
  o.uv = k;
  o.qi = ii;
  return o;
}
fn h(p: vec2f) -> f32 { var q = fract(p * vec2f(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn sdRBox(p: vec2f, b: vec2f, r: f32) -> f32 { let q = abs(p) - b + vec2f(r); return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r; }
fn tap(q: Q, t: vec2f) -> vec3f {
  let c = clamp(t, vec2f(0.002), vec2f(0.998));
  return textureSampleLevel(feed, samp, mix(q.src.xy, q.src.zw, c), 0.0).rgb;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let q = quads[i.qi];
  let time = u.view.z;
  let seed = q.misc.x;
  let px = q.rect.zw;
  let mask = 1.0 - smoothstep(-1.0, 1.0, sdRBox((i.uv - 0.5) * px, px * 0.5, q.look2.w));
  // cover crop: the tile is 4:3, the rect is whatever the layout needs
  let qa = px.x / px.y;
  let ta = 4.0 / 3.0;
  var s = vec2f(1.0);
  if (qa > ta) { s.y = ta / qa; } else { s.x = qa / ta; }
  var c = i.uv - 0.5;
  let rc = length(c * vec2f(min(qa, 1.6), 1.0));
  // the cut: the picture tears for a moment
  let glitch = q.tone.z;
  let row = floor(i.uv.y * 90.0);
  c.x = c.x + (h(vec2f(row, floor(time * 40.0) + seed)) - 0.5) * 0.35 * glitch * glitch;
  c.y = c.y + glitch * 0.8 * (0.3 + 0.7 * h(vec2f(seed, floor(time * 30.0))));
  var t = q.look2.xy + c * s / q.look.w;
  if (glitch > 0.001) { t.y = fract(t.y); }
  let inside = step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);
  // soft old stock: three taps across
  let tx = 1.0 / 640.0 / q.look.w;
  var col = (tap(q, t) * 2.0 + tap(q, t - vec2f(tx, 0.0)) + tap(q, t + vec2f(tx, 0.0))) * 0.25;
  let red = clamp((col.r - max(col.g, col.b)) * 2.6, 0.0, 1.0);
  var lum = dot(col, vec3f(0.299, 0.587, 0.114));
  lum = clamp((lum - 0.5) * q.tone.y + 0.5, 0.0, 1.5) * q.tone.x;
  // day: warm white. night: a room lit by the moon and a phone
  var out = vec3f(1.0, 0.975, 0.93) * lum;
  if (u32(q.look.x) == 1u) { out = vec3f(0.6, 0.76, 1.0) * lum; }
  out = mix(out, vec3f(1.0, 0.16, 0.1) * max(col.r, lum), red);
  // interlace, grain, line noise, hum bar
  let lines = q.misc.y / q.look.w;
  out = out * (0.9 + 0.1 * sin(t.y * lines * 3.14159));
  let noise = q.look.z;
  let gcell = floor(t * vec2f(lines * 1.333, lines));
  let g1 = h(gcell + vec2f(floor(time * 24.0) * 7.0 + seed, floor(time * 24.0) * 3.0));
  out = out + (g1 - 0.5) * noise * (0.6 + 0.8 * (1.0 - lum));
  let ln = h(vec2f(floor(t.y * lines * 0.5), floor(time * 18.0) + seed * 3.0));
  out = out + smoothstep(0.992, 1.0, ln) * 0.35 * noise * 3.0 * h(vec2f(floor(t.x * 60.0), ln));
  let hum = exp(-pow((fract(t.y * 0.6 - time * 0.11 + seed) - 0.5) * 5.0, 2.0));
  out = out * (1.0 + hum * 0.1);
  // static while it cuts
  let st = h(i.uv * px + vec2f(time * 91.0, time * 47.0));
  out = mix(out, vec3f(st) * 0.8, clamp(glitch * 1.4, 0.0, 0.85));
  out = out * inside;
  out = out * mix(1.0, smoothstep(0.86, 0.3, rc), 0.3);
  out = out + vec3f(q.tone.w);
  let a = mask * q.look2.z;
  return vec4f(out * a, a);
}
`

export class Gpu {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error("no webgpu")
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error("no adapter")
    const device = await adapter.requestDevice()
    return new Gpu(canvas, device)
  }

  constructor(canvas, device) {
    this.canvas = canvas
    this.device = device
    device.addEventListener("uncapturederror", (e) => console.error("webgpu:", e.error.message))
    // the broadcast is drawn straight onto the canvas, and the footage in the same format
    const rt = navigator.gpu.getPreferredCanvasFormat()
    this.ctx = canvas.getContext("webgpu")
    this.ctx.configure({ device, format: rt, alphaMode: "opaque" })
    this.samp = device.createSampler({ magFilter: "linear", minFilter: "linear" })
    const blend = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    }
    const pipe = (code) => {
      const module = device.createShaderModule({ code })
      return device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: rt, blend }] },
        primitive: { topology: "triangle-list" },
      })
    }
    this.uber = pipe(UBER)
    this.feedPipe = pipe(FEED)

    const U = GPUBufferUsage
    this.buf = (size, usage) => device.createBuffer({ size, usage })
    this.passes = {}
    this.feedUbo = this.buf(16, U.UNIFORM | U.COPY_DST)
    this.quadBuf = this.buf(MAX_QUADS * QF * 4, U.STORAGE | U.COPY_DST)
    this.feedTex = device.createTexture({ size: [FEED_W, FEED_H], format: rt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.feedGroup = device.createBindGroup({
      layout: this.feedPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.feedUbo } },
        { binding: 1, resource: { buffer: this.quadBuf } },
        { binding: 2, resource: this.feedTex.createView() },
        { binding: 3, resource: this.samp },
      ],
    })
    this.atlas = null
  }

  // A list gets its own instance and bean buffers; `ubos` is how many sets of uniforms draw from
  // it (one per shot for the feed list).
  setAtlas(canvas, lists) {
    const d = this.device
    const U = GPUBufferUsage
    this.atlas = d.createTexture({ size: [canvas.width, canvas.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
    d.queue.copyExternalImageToTexture({ source: canvas }, { texture: this.atlas, premultipliedAlpha: true }, [canvas.width, canvas.height])
    const view = this.atlas.createView()
    for (const [name, { list, ubos = 1 }] of Object.entries(lists)) {
      const inst = this.buf(list.cap * F * 4, U.STORAGE | U.COPY_DST)
      const beans = this.buf(list.beanCap * BF * 4, U.STORAGE | U.COPY_DST)
      const sets = []
      for (let i = 0; i < ubos; i++) {
        const ubo = this.buf(256, U.UNIFORM | U.COPY_DST)
        const group = d.createBindGroup({
          layout: this.uber.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubo } },
            { binding: 1, resource: { buffer: inst } },
            { binding: 2, resource: view },
            { binding: 3, resource: this.samp },
            { binding: 4, resource: { buffer: beans } },
          ],
        })
        sets.push({ ubo, group })
      }
      this.passes[name] = { inst, beans, sets }
    }
  }

  // the picture (px)
  resize(w, h) {
    if (w === this.canvas.width && h === this.canvas.height) return
    this.canvas.width = w
    this.canvas.height = h
  }

  upload(name, list, uniforms) {
    const p = this.passes[name]
    const q = this.device.queue
    uniforms.forEach((u, i) => q.writeBuffer(p.sets[i].ubo, 0, u))
    if (list.n) q.writeBuffer(p.inst, 0, list.data.buffer, 0, list.n * F * 4)
    if (list.nb) q.writeBuffer(p.beans, 0, list.beans.buffer, 0, list.nb * BF * 4)
  }

  // f: {
  //   feed: { list, cams: [{ tile, first, count, uniforms }] },
  //   bg, fg: { list, uniforms },
  //   quads: Float32Array, nQuads, feedU
  // }
  frame(f) {
    if (!this.atlas) return
    const d = this.device
    const q = d.queue
    const enc = d.createCommandEncoder()
    const black = { r: 0, g: 0, b: 0, a: 1 }
    const draw = (pass, name, list, set = 0, first = 0, count = list.n) => {
      if (!count) return
      pass.setPipeline(this.uber)
      pass.setBindGroup(0, this.passes[name].sets[set].group)
      pass.draw(6, count, 0, first)
    }

    // 1. the footage
    this.upload("feed", f.feed.list, f.feed.cams.map((c) => c.uniforms))
    {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.feedTex.createView(), clearValue: black, loadOp: "clear", storeOp: "store" }] })
      f.feed.cams.forEach((c, i) => {
        const [x, y, w, h] = TILES[c.tile]
        pass.setViewport(x, y, w, h, 0, 1)
        pass.setScissorRect(x, y, w, h)
        draw(pass, "feed", f.feed.list, i, c.first, c.count)
      })
      pass.end()
    }
    // 2. the broadcast
    this.upload("bg", f.bg.list, [f.bg.uniforms])
    this.upload("fg", f.fg.list, [f.fg.uniforms])
    q.writeBuffer(this.feedUbo, 0, f.feedU)
    if (f.nQuads) q.writeBuffer(this.quadBuf, 0, f.quads.buffer, 0, f.nQuads * QF * 4)
    {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: black, loadOp: "clear", storeOp: "store" }] })
      draw(pass, "bg", f.bg.list)
      if (f.nQuads) {
        pass.setPipeline(this.feedPipe)
        pass.setBindGroup(0, this.feedGroup)
        pass.draw(6, Math.min(f.nQuads, MAX_QUADS))
      }
      draw(pass, "fg", f.fg.list)
      pass.end()
    }
    q.submit([enc.finish()])
  }

  destroy() {
    this.ctx.unconfigure()
    this.device.destroy()
  }
}
