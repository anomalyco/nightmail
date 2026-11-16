// The sorter at work. Letters fall into the hopper, are read under the scanner, ride the rollers to their lane's gate
// and drop down a chute; a capsule then leaves by that lane's tube. Scams are thrown out of the roof and burnt in the
// air by the laser. The pace climbs until the machine cannot keep up: letters pile on the roof, the gauge goes into the
// red, it shakes, steams, and bursts. After that every letter and every blown-off part is a rigid body: gravity, spin,
// contact with the floor and the cabinet through its corners, friction, and sleep once it lies still (a sleeping letter
// raises the floor under it, so the next one comes to rest on top: piles). Nothing runs once everything is asleep.
import { createRenderer, FX_FLOATS, LETTER_FLOATS, MATS, type Part } from './gl'
import { buildMachine, type Machine } from './machine'
import { aboutZ, pose, type V3 } from './mesh'
import { MAT as M, oklch, paletteBytes } from './tones'
import { DX, DY, type Plan } from './plan'

export type Letter = { subject: string; from: string; addr: string; snippet: string; route: number; scam: boolean }
/** The lanes, left to right, by the dataset's route names; a scam's route is 7. */
export const LANES = ['thread', 'webhook', 'agent', 'inbox', 'imap', 'ritual', 'campaign'] as const
export type Phase = 'boot' | 'run' | 'overload' | 'boom' | 'rest' | 'rebuild'
export type Hooks = { scan: (letter: Letter | null, verdict: 'read' | 'junk' | 'jam' | 'idle') => void; count: (sorted: number, burnt: number) => void; phase: (phase: Phase) => void; hover: (letter: Letter | null, x: number, y: number) => void }
export type Sorter = ReturnType<typeof mountSorter>

const MAX = 760, FREE = 0, SCRIPT = 1, DYN = 2, ASLEEP = 3, HELD = 4, HOME = 5
const CELL = 8, GX0 = -1300, GZ0 = -700, GW = 325, GD = 420, VOID = -9000
const rnd = (a = 1, b = 0) => b + Math.random() * (a - b)
const clamp = (x: number, a = 0, b = 1) => x < a ? a : x > b ? b : x
const ease = (t: number) => t * t * (3 - 2 * t), out = (t: number) => 1 - (1 - t) ** 3

type Bodies = { cap: number; pos: Float32Array; vel: Float32Array; quat: Float32Array; ang: Float32Array; half: Float32Array; state: Uint8Array; still: Float32Array; thin: boolean }
const bodies = (cap: number, thin: boolean): Bodies => ({ cap, pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3), quat: new Float32Array(cap * 4), ang: new Float32Array(cap * 3), half: new Float32Array(cap * 3), state: new Uint8Array(cap), still: new Float32Array(cap), thin })
const THIN = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0], BOX = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]

type Script = { stage: number; t: number; lane: number; x0: number; y0: number; ax: number; ay: number; az: number; turn: number; data: number; x: number }
type Fx = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; grow: number; rot: number; spin: number; r: number; g: number; b: number; a: number; shape: number; gravity: number; drag: number; glow: boolean; len: number }

export function mountSorter(canvas: HTMLCanvasElement, options: { plan: Plan; over: number; dark: boolean; reduced: boolean; quick: boolean; letters: Letter[]; hooks: Hooks }) {
  const renderer = createRenderer(canvas)
  if (!renderer) return null
  const { hooks, reduced } = options
  let p = options.plan, over = options.over, dark = options.dark, pool = options.letters, cursor = Math.floor(Math.random() * pool.length)
  let m!: Machine, parts!: Part[], px = 1, G = 1500, oyc = 0
  const L = bodies(MAX, true), kind = new Uint8Array(MAX), data = new Int32Array(MAX), seed = new Float32Array(MAX), burn = new Float32Array(MAX), burning = new Uint8Array(MAX), delay = new Float32Array(MAX), from = new Float32Array(MAX * 7)
  const scripts = new Map<number, Script>()
  let Dn = bodies(0, false), debrisPart: number[] = [], debrisHome: V3[] = [], selfPosed = new Set<number>(), turretBody = 0, boltBody = 0
  const instances = new Float32Array(MAX * LETTER_FLOATS), fxData = new Float32Array(700 * FX_FLOATS), glowData = new Float32Array(64 * FX_FLOATS)
  let fx: Fx[] = []
  const heights = new Float32Array(GW * GD)
  const colour = { steam: [1, 1, 1], smoke: [0, 0, 0], ember: [1, .6, .2], red: [1, .2, .2], paper: [1, 1, 1], spark: [1, .9, .6] }

  let phase: Phase = 'boot', clock = 0, runT = 0, heat = 0, speed = 1, feed = 1, spawnIn = .3, sorted = 0, burnt = 0, shake = 0, flash = 0, needle = 0, needleV = 0, time = 0
  let scanning = -1, spawned = 0, turretAngle = .45, turretAim = .45, aimHold = 0, steamIn = 0, sparkIn = 0, rainLeft = 0, bend = 0
  const queue: number[] = [], QUEUE = 5
  const flapAngle = new Float32Array(7), flapWant = new Float32Array(7), rollerSpin = new Float32Array(56)
  const caps = Array.from({ length: 28 }, () => ({ tube: 0, run: 0, s: 0, wait: 0, on: false }))
  let runLength: number[][][] = []
  const zaps: { id: number; at: number }[] = []
  const T = options.quick ? { calm: 1.6, ramp: 7.6, over: 1.4 } : { calm: 3.2, ramp: 13.6, over: 1.7 }
  let raf = 0, last = 0, visible = true, dead = false
  const pointer = { x: 0, y: 0, in: false, down: false, moved: 0, held: -1, hover: -1, dirty: false, mouse: true, holdY: 0 }

  // ── Building ──
  function build() {
    px = p.U / 9; G = 1500 * px; oyc = p.oy + over
    renderer!.resize(p.W, p.H + over, Math.min(window.devicePixelRatio || 1, p.phone ? 2 : 2), p.ox, oyc)
    m = buildMachine(p); parts = m.parts
    renderer!.setMesh(m.data); renderer!.setWall(m.wall, 1000)
    renderer!.setMaterials({ paper: M.paper, ink: M.ink, stamp: M.brand, red: M.red, ember: M.ember, char: M.char, dim: M.dim, slab: M.slab })
    runLength = m.lines.map(runs => runs.map(line => { const s = [0]; for (let i = 1; i < line.length; i++) s.push(s[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], line[i][2] - line[i - 1][2])); return s }))
    // What can be blown off: the hopper, the laser, the chimneys, the hatch, the glass in panes, every roller, gate and bolt.
    debrisPart = [m.idx.hopper, m.idx.turret, ...m.idx.vents, m.idx.hatch, ...m.idx.panes, ...m.idx.rollers, ...m.idx.flaps, ...m.idx.bolts]
    selfPosed = new Set([m.idx.turret, ...m.idx.rollers, ...m.idx.flaps]); turretBody = 1; boltBody = debrisPart.length - m.idx.bolts.length
    Dn = bodies(debrisPart.length, false)
    debrisHome = debrisPart.map((index, i) => {
      const part = m.parts[index], c: V3 = [(part.lo[0] + part.hi[0]) / 2, (part.lo[1] + part.hi[1]) / 2, (part.lo[2] + part.hi[2]) / 2]
      for (let k = 0; k < 3; k++) Dn.half[i * 3 + k] = Math.max(1, (part.hi[k] - part.lo[k]) / 2)
      return c
    })
    L.state.fill(FREE); scripts.clear(); fx = []; resetHeights(); queue.length = 0; spawned = 0; bend = 0
    for (const cap of caps) cap.on = false
    for (const index of m.idx.caps) parts[index].on = false
    parts[m.idx.scan].on = false; parts[m.idx.beaconOn].on = false; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = false
    for (const index of [...m.idx.cracks, ...m.idx.panes]) parts[index].on = false
    for (const index of m.idx.lamps) parts[index].on = false
    theme(dark)
  }
  function theme(next: boolean) {
    dark = next
    renderer!.setPalette(paletteBytes(dark, MATS))
    const page = dark ? oklch(.158, .014, 268) : oklch(.948, .01, 262); renderer!.setClear(page[0] / 255, page[1] / 255, page[2] / 255)
    const set = (name: keyof typeof colour, l: number, c: number, h: number) => { colour[name] = oklch(l, c, h).map(v => v / 255) }
    if (dark) { set('steam', .8, .008, 268); set('smoke', .33, .012, 268) } else { set('steam', .995, .003, 262); set('smoke', .7, .008, 262) }
    set('ember', .78, .17, 58); set('red', .64, .21, 27); set('paper', .955, .014, 92); set('spark', .93, .09, 85)
  }
  function resetHeights() {
    // The slab, and the cabinet's roof standing on it; everywhere else there is nothing to land on.
    for (let iz = 0; iz < GD; iz++) for (let ix = 0; ix < GW; ix++) { const x = GX0 + (ix + .5) * CELL, z = GZ0 + (iz + .5) * CELL; heights[iz * GW + ix] = x > -p.Xc && x < p.Xc && z > 0 && z < p.D ? p.yTop : Math.abs(x) < p.slabX && z > p.zLip + 22 * px && z < p.zBack ? 0 : VOID }
  }
  const cell = (x: number, z: number) => { const ix = Math.floor((x - GX0) / CELL), iz = Math.floor((z - GZ0) / CELL); return ix < 0 || iz < 0 || ix >= GW || iz >= GD ? -1 : iz * GW + ix }

  // ── Letters ──
  function alloc() {
    for (let i = 0; i < MAX; i++) if (L.state[i] === FREE) return i
    // Full: take one that has long been lying still.
    let pick = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] === ASLEEP && L.still[i] > L.still[pick]) pick = i
    return pick
  }
  function place(i: number, x: number, y: number, z: number) {
    L.pos[i * 3] = x; L.pos[i * 3 + 1] = y; L.pos[i * 3 + 2] = z
    L.quat.set([0, 0, 0, 1], i * 4); L.vel.fill(0, i * 3, i * 3 + 3); L.ang.fill(0, i * 3, i * 3 + 3)
    L.half[i * 3] = p.lw / 2; L.half[i * 3 + 1] = p.lh / 2; L.half[i * 3 + 2] = .7
    L.still[i] = 0; burn[i] = 0; burning[i] = 0; seed[i] = Math.random()
  }
  function nextLetter(i: number) { cursor = (cursor + 1223) % pool.length; data[i] = cursor; kind[i] = pool[cursor].scam ? 1 : 0 }
  function spawn() {
    const i = alloc(); nextLetter(i)
    // The second letter of the day is a scam, so the laser is seen at work early.
    if (spawned++ === 1) for (let tries = 0; tries < pool.length && !pool[cursor].scam; tries++) nextLetter(i)
    const x0 = rnd(-1, 1) * p.lw * 1.8, y0 = oyc + p.lh
    place(i, x0, y0, p.zL); L.state[i] = SCRIPT
    const letter = pool[data[i]]
    scripts.set(i, { stage: 0, t: 0, lane: letter.scam ? 7 : letter.route, x0, y0, ax: rnd(-1, 1), ay: rnd(-1, 1), az: rnd(-1, 1), turn: rnd(3, 7) * (Math.random() < .5 ? -1 : 1), data: data[i], x: 0 })
  }
  function loose(i: number, vx: number, vy: number, vz: number, spin = 6) {
    scripts.delete(i); L.state[i] = DYN; L.still[i] = 0
    L.vel[i * 3] = vx; L.vel[i * 3 + 1] = vy; L.vel[i * 3 + 2] = vz
    L.ang[i * 3] = rnd(-spin, spin); L.ang[i * 3 + 1] = rnd(-spin, spin); L.ang[i * 3 + 2] = rnd(-spin, spin)
    if (scanning === i) scanning = -1
    const at = queue.indexOf(i); if (at >= 0) queue.splice(at, 1)
  }
  const setQuat = (i: number, ax: number, ay: number, az: number, angle: number) => { const l = Math.hypot(ax, ay, az) || 1, s = Math.sin(angle / 2) / l; L.quat[i * 4] = ax * s; L.quat[i * 4 + 1] = ay * s; L.quat[i * 4 + 2] = az * s; L.quat[i * 4 + 3] = Math.cos(angle / 2) }

  // A letter's way through the works, a stage at a time. `rate` is how much faster than calm the machine is running.
  function script(i: number, s: Script, dt: number, roll: number) {
    // The hopper and the scanner quicken faster than the rollers do: the works fill up.
    const P = L.pos, o = i * 3, rate = s.stage >= 5 && s.stage <= 7 ? roll : feed
    s.t += dt
    if (s.stage === 0) {
      // Falling out of the night, tumbling, into the hopper; turned square by the time it is there.
      const d = .85 / Math.sqrt(rate), u = clamp(s.t / d), topY = m.hopperTop + p.lh * .2
      P[o] = s.x0 * (1 - out(u)); P[o + 1] = s.y0 + (topY - s.y0) * (u * u * .7 + u * .3); P[o + 2] = p.zL
      setQuat(i, s.ax, s.ay, s.az, s.turn * (1 - u) ** 1.6)
      if (u >= 1) {
        if (queue.length < QUEUE && phase !== 'overload') { queue.push(i); s.stage = 1; s.t = 0 }
        else loose(i, rnd(-1, 1) * 170 * px, rnd(140, 320) * px, rnd(-60, 150) * px, 5)
      }
    } else if (s.stage === 1) {
      // In the hopper, in line: the next to go lowest, the rest stacked over it, each a little askew.
      const j = queue.indexOf(i), k = Math.min(1, dt * 16), lean = j ? (j % 2 ? .2 : -.16) : 0
      P[o] += ((j % 2 ? 1 : -1) * Math.min(j, 1) * p.lw * .09 - P[o]) * k; P[o + 1] += (p.yTop + p.hopper * .34 + j * p.lh * .34 - P[o + 1]) * k
      setQuat(i, 0, 0, 1, lean)
      if (j === 0 && scanning === -1 && s.t > .1 / rate) { queue.shift(); scanning = i; s.stage = 10; s.t = 0; s.y0 = P[o + 1] }
    } else if (s.stage === 10) {
      // Down the throat and out of sight.
      const u = clamp(s.t / (.16 / rate))
      P[o] *= 1 - u; P[o + 1] = s.y0 + (p.yTop - p.lh - s.y0) * u * u; setQuat(i, 0, 0, 1, 0)
      if (u >= 1) { s.stage = 2; s.t = 0 }
    } else if (s.stage === 2) {
      const u = clamp(s.t / (.22 / rate))
      P[o] = 0; P[o + 1] = p.yFas + p.lh * .6 + (m.scanY - p.yFas - p.lh * .6) * out(u)
      if (u >= 1) { s.stage = 3; s.t = 0; hooks.scan(pool[s.data], pool[s.data].scam ? 'junk' : 'read') }
    } else if (s.stage === 3) {
      const d = Math.max(.09, .62 / rate), u = clamp(s.t / d), scan = parts[m.idx.scan]
      scan.on = true; pose(scan.m, [0, m.scanY, p.zL], [0, m.scanY + Math.cos(u * Math.PI * 2) * p.lh * .42, p.zL], [0, 0, 0, 1])
      if (u >= 1) { scan.on = false; s.stage = s.lane === 7 ? 20 : 4; s.t = 0; if (s.lane !== 7) scanning = -1 }
    } else if (s.stage === 4) {
      const u = clamp(s.t / (.14 / rate))
      P[o + 1] = m.scanY + (m.rideY - m.scanY) * u * u
      if (u >= 1) { s.stage = s.lane === 3 ? 6 : 5; s.t = 0; s.x = 0 }
    } else if (s.stage === 5) {
      // On the rollers, out to its lane's gate.
      const dir = s.lane < 3 ? -1 : 1, target = p.lanes[s.lane] - dir * p.P * .12
      s.x += dir * 120 * px * rate * dt
      if ((s.x - target) * dir >= 0) { s.x = target; s.stage = 6; s.t = 0 }
      P[o] = s.x; P[o + 1] = m.rideY + Math.sin(s.x * .9) * .5 * px
      if ((p.lanes[s.lane] - s.x) * dir < p.P * .5) flapWant[s.lane] = 1
    } else if (s.stage === 6) {
      // The gate drops away under it: it tips with the gate and slides off into the chute.
      const u = clamp(s.t / (.3 / rate)), dir = m.swing[s.lane], hinge = m.hinge[s.lane], a = -dir * 1.02 * ease(clamp(u * 1.4))
      flapWant[s.lane] = 1
      const lx = s.x - hinge[0] + dir * u * u * p.P * .3, ly = m.rr + p.lh / 2
      P[o] = hinge[0] + lx * Math.cos(a) - ly * Math.sin(a); P[o + 1] = hinge[1] + lx * Math.sin(a) + ly * Math.cos(a)
      setQuat(i, 0, 0, 1, a)
      if (u >= 1) { s.stage = 7; s.t = 0; s.x0 = P[o]; s.y0 = P[o + 1]; s.turn = a }
    } else if (s.stage === 7) {
      const u = clamp(s.t / (.34 / rate)), endY = p.yCav - p.lh * .9
      P[o] = s.x0 + (p.lanes[s.lane] - s.x0) * out(u); P[o + 1] = s.y0 + (endY - s.y0) * u * u
      setQuat(i, 0, 0, 1, s.turn * (1 - out(u)))
      if (u > .35) flapWant[s.lane] = 0
      if (u >= 1) { scripts.delete(i); L.state[i] = FREE; sorted++; hooks.count(sorted, burnt); launch(s.lane); launch(7) }
    } else if (s.stage === 20) {
      // A scam: back up behind the fascia, then thrown out of the roof for the laser.
      const u = clamp(s.t / (.2 / rate))
      P[o + 1] = m.scanY + (p.yFas + p.lh - m.scanY) * u * u
      if (u >= 1) {
        scanning = -1
        place(i, m.eject[0], m.eject[1] + p.lh * .2, p.zL); seed[i] = Math.random()
        loose(i, rnd(-50, 50) * px, rnd(640, 740) * px, rnd(-20, 20) * px, 2); L.ang[i * 3 + 2] = rnd(5, 9) * (Math.random() < .5 ? -1 : 1)
        zaps.push({ id: i, at: time + rnd(.32, .42) })
        puff(m.eject[0], m.eject[1], p.zL, 5, 'steam', 3)
      }
    }
  }

  // ── Rigid bodies ──
  const R = new Float32Array(9), tmp = new Float32Array(3)
  function matrix(q: Float32Array, o: number) {
    const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3]
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w)
    R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w)
    R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y)
  }
  // Inverse inertia (a unit mass, a box of the body's half sizes) times a world vector.
  function invInertia(x: number, y: number, z: number, ix: number, iy: number, iz: number) {
    const lx = (R[0] * x + R[3] * y + R[6] * z) * ix, ly = (R[1] * x + R[4] * y + R[7] * z) * iy, lz = (R[2] * x + R[5] * y + R[8] * z) * iz
    tmp[0] = R[0] * lx + R[1] * ly + R[2] * lz; tmp[1] = R[3] * lx + R[4] * ly + R[5] * lz; tmp[2] = R[6] * lx + R[7] * ly + R[8] * lz
  }
  function step(B: Bodies, i: number, dt: number) {
    const o = i * 3, q = i * 4, { pos, vel, ang, quat, half } = B, pts = B.thin ? THIN : BOX
    const hx = half[o], hy = half[o + 1], hz = Math.max(half[o + 2], B.thin ? 2.2 : 1.5)
    const ix = 3 / (hy * hy + hz * hz), iy = 3 / (hx * hx + hz * hz), iz = 3 / (hx * hx + hy * hy)
    vel[o + 1] -= G * dt
    matrix(quat, q)
    if (B.thin) {
      // Paper: the air resists a letter moving face on far more than edge on.
      const nx = R[2], ny = R[5], nz = R[8], vn = vel[o] * nx + vel[o + 1] * ny + vel[o + 2] * nz, k = Math.min(1, .7 * dt) * vn
      vel[o] -= nx * k; vel[o + 1] -= ny * k; vel[o + 2] -= nz * k
      const d = 1 - .22 * dt, da = 1 - .9 * dt
      vel[o] *= d; vel[o + 1] *= d; vel[o + 2] *= d; ang[o] *= da; ang[o + 1] *= da; ang[o + 2] *= da
    }
    pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt
    const wx = ang[o], wy = ang[o + 1], wz = ang[o + 2], qx = quat[q], qy = quat[q + 1], qz = quat[q + 2], qw = quat[q + 3], h = dt / 2
    let nqx = qx + h * (wx * qw + wy * qz - wz * qy), nqy = qy + h * (wy * qw + wz * qx - wx * qz), nqz = qz + h * (wz * qw + wx * qy - wy * qx), nqw = qw - h * (wx * qx + wy * qy + wz * qz)
    const nl = 1 / Math.hypot(nqx, nqy, nqz, nqw); quat[q] = nqx *= nl; quat[q + 1] = nqy *= nl; quat[q + 2] = nqz *= nl; quat[q + 3] = nqw *= nl
    matrix(quat, q)
    const rad = B.thin ? .8 : 0
    let touching = 0, cx = 0, cy = 0, cz = 0
    for (let k = 0; k < pts.length; k += 3) {
      const lx = pts[k] * hx, ly = pts[k + 1] * hy, lz = pts[k + 2] * half[o + 2]
      const rx = R[0] * lx + R[1] * ly + R[2] * lz, ry = R[3] * lx + R[4] * ly + R[5] * lz, rz = R[6] * lx + R[7] * ly + R[8] * lz
      const x = pos[o] + rx, y = pos[o + 1] + ry, z = pos[o + 2] + rz
      let nx = 0, ny = 1, nz = 0, pen = 0
      if (x > -p.Xc && x < p.Xc && z > 0 && z < p.D && y < p.yTop - 14) {
        // Inside the cabinet's walls: out through the nearest one.
        const front = z, back = p.D - z, left = x + p.Xc, right = p.Xc - x, least = Math.min(front, back, left, right)
        ny = 0; pen = least
        if (least === front) nz = -1; else if (least === left) nx = -1; else if (least === right) nx = 1; else nz = 1
      } else if (B.thin && z < 0 && z > -40 * px && x > -p.Xc - 8 && x < p.Xc + 8 && y < 40 * px) {
        // A kick plate that isn't drawn: nothing comes to rest against the foot of the front, where the page's small print is.
        ny = .743; nz = -.669; pen = rad - (y * ny + (z + 40 * px) * nz)
      } else { const c = cell(x, z); pen = (c < 0 ? VOID : heights[c]) + rad - y }
      if (pen <= 0) continue
      touching++
      const vx = vel[o] + ang[o + 1] * rz - ang[o + 2] * ry, vy = vel[o + 1] + ang[o + 2] * rx - ang[o] * rz, vz = vel[o + 2] + ang[o] * ry - ang[o + 1] * rx
      const vn = vx * nx + vy * ny + vz * nz
      if (vn < 0) {
        // An impulse along the normal that stops the point (and bounces it a little if it came in fast), then friction.
        const ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx
        invInertia(ax, ay, az, ix, iy, iz)
        const kn = 1 + (tmp[1] * rz - tmp[2] * ry) * nx + (tmp[2] * rx - tmp[0] * rz) * ny + (tmp[0] * ry - tmp[1] * rx) * nz
        const j = -(1 + (vn < -90 * px ? .28 : 0)) * vn / kn
        vel[o] += j * nx; vel[o + 1] += j * ny; vel[o + 2] += j * nz; ang[o] += tmp[0] * j; ang[o + 1] += tmp[1] * j; ang[o + 2] += tmp[2] * j
        const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz, tl = Math.hypot(tx, ty, tz)
        if (tl > 1e-3) {
          const ux = tx / tl, uy = ty / tl, uz = tz / tl, bx = ry * uz - rz * uy, by = rz * ux - rx * uz, bz = rx * uy - ry * ux
          invInertia(bx, by, bz, ix, iy, iz)
          const kt = 1 + (tmp[1] * rz - tmp[2] * ry) * ux + (tmp[2] * rx - tmp[0] * rz) * uy + (tmp[0] * ry - tmp[1] * rx) * uz
          const jt = Math.min(.55 * j, tl / kt)
          vel[o] -= jt * ux; vel[o + 1] -= jt * uy; vel[o + 2] -= jt * uz; ang[o] -= tmp[0] * jt; ang[o + 1] -= tmp[1] * jt; ang[o + 2] -= tmp[2] * jt
        }
      }
      const push = Math.min(pen, 6) * .5; cx += nx * push; cy += ny * push; cz += nz * push
    }
    if (touching) {
      pos[o] += cx / touching; pos[o + 1] += cy / touching; pos[o + 2] += cz / touching
      const slow = Math.hypot(vel[o], vel[o + 1], vel[o + 2]) < 26 * px && Math.hypot(ang[o], ang[o + 1], ang[o + 2]) < 1.1
      B.still[i] = slow ? B.still[i] + dt : 0
      if (slow) { const d = 1 - 6 * dt; vel[o] *= d; vel[o + 2] *= d; ang[o] *= d; ang[o + 1] *= d; ang[o + 2] *= d }
      if (B.still[i] > .3) sleep(B, i)
    } else B.still[i] = 0
    if (pos[o + 1] < -(p.floor + 300)) B.state[i] = B.thin ? FREE : ASLEEP
  }
  function sleep(B: Bodies, i: number) {
    const o = i * 3
    B.state[i] = ASLEEP; B.still[i] = 0; B.vel.fill(0, o, o + 3); B.ang.fill(0, o, o + 3)
    if (!B.thin) return
    // The floor under a sleeping letter is now that letter: the next one rests on it.
    matrix(B.quat, i * 4)
    for (let a = -1; a <= 1; a += .4) for (let b = -1; b <= 1; b += .5) {
      const lx = a * B.half[o], ly = b * B.half[o + 1], c = cell(B.pos[o] + R[0] * lx + R[1] * ly, B.pos[o + 2] + R[6] * lx + R[7] * ly), y = B.pos[o + 1] + R[3] * lx + R[4] * ly + 1.5
      if (c >= 0 && heights[c] > VOID && y > heights[c] && y < heights[c] + 30) heights[c] = y
    }
  }
  function wake(i: number) { if (L.state[i] === ASLEEP) { L.state[i] = DYN; L.still[i] = 0 } }

  // ── Effects ──
  function add(o: Partial<Fx> & { x: number; y: number; z: number }) {
    if (fx.length > 620) return
    fx.push({ vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 4, grow: 0, rot: 0, spin: 0, r: 1, g: 1, b: 1, a: 1, shape: 0, gravity: 0, drag: 0, glow: false, len: 0, ...o })
  }
  // Steam and smoke: many small puffs that swell and thin out as they rise.
  function puff(x: number, y: number, z: number, n: number, name: 'steam' | 'smoke', size: number, vy = 60, spread = 26) {
    const c = colour[name]
    for (let i = 0; i < n; i++) add({ x: x + rnd(-1, 1) * size * px, y: y + rnd(-1, 1) * size * px * .5, z: z - 1, vx: rnd(-1, 1) * spread * px, vy: rnd(.5, 1.2) * vy * px, vz: rnd(-8, 8), max: rnd(.9, 1.5), size: rnd(.5, 1) * size * px, grow: rnd(7, 15) * px, r: c[0], g: c[1], b: c[2], a: name === 'steam' ? .5 : .6, drag: 1.3 })
  }
  function sparks(x: number, y: number, z: number, n: number, power = 240, c = colour.spark) {
    for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2), s = rnd(.3, 1) * power * px; add({ x, y, z: z - 2, vx: Math.cos(a) * s, vy: Math.sin(a) * s + power * .3 * px, vz: rnd(-40, 40), max: rnd(.25, .6), size: 1.1 * px, len: rnd(3, 7) * px, r: c[0], g: c[1], b: c[2], shape: 1, gravity: 1, drag: 1.5 }) }
  }
  /** Where the laser is: on its pedestal, or wherever the burst left it. */
  const laserAt = (): ArrayLike<number> => Dn.state[turretBody] === FREE ? m.turret : Dn.pos.subarray(turretBody * 3, turretBody * 3 + 3)

  // The laser: aim, a beam for a moment (two flat bars, red and a paler core), and whatever it hits starts to burn.
  function fire(i: number) {
    if (L.state[i] === FREE || burning[i]) return
    const o = i * 3, tx = L.pos[o], ty = L.pos[o + 1], tz = L.pos[o + 2], from = laserAt(), mounted = Dn.state[turretBody] === FREE
    const sx = tx - from[0] + DX * (tz - from[2]), sy = ty - from[1] + DY * (tz - from[2]), angle = Math.atan2(sy, sx)
    if (mounted) { turretAim = turretAngle = angle; aimHold = .45 }
    const tip = mounted ? 22 * px : 0, bx = from[0] + Math.cos(angle) * tip, by = from[1] + Math.sin(angle) * tip, length = Math.hypot(sx, sy) - tip
    const mx = (bx + tx) / 2 - DX * (tz - from[2]) / 2, my = (by + ty) / 2 - DY * (tz - from[2]) / 2, mz = (from[2] + tz) / 2
    add({ x: mx, y: my, z: mz, max: .12, size: length / 2, len: 1.9 * px, rot: angle, ...rgb(colour.red), shape: 4 })
    add({ x: mx, y: my, z: mz - 1, max: .09, size: length / 2, len: .7 * px, rot: angle, ...rgb(colour.spark), shape: 4 })
    sparks(tx, ty, tz, 12, 220, colour.ember)
    burning[i] = 1; wake(i)
    if (L.state[i] === SCRIPT) loose(i, 0, 0, 0, 1)
    L.vel[o] *= .4; L.vel[o + 1] = L.vel[o + 1] * .3 + 60 * px; shake = Math.max(shake, 1.2)
  }
  function launch(tube: number) {
    const cap = caps.find(c => !c.on)
    if (cap) { cap.on = true; cap.tube = tube; cap.run = 0; cap.s = 0; cap.wait = 0 }
  }

  // ── The burst ──
  function boom() {
    setPhase('boom'); flash = 1; shake = 8; needleV = -9; bend = 1
    const cx = 0, cy = (p.yCav + p.yFas) / 2
    // Light, as an effect and only here: a hot core for two frames. The page behind is never lightened.
    add({ x: cx, y: cy, z: -10, max: .05, size: 88 * px, ...rgb(colour.spark), a: .95, shape: 2, glow: true })
    // Every letter in the works, and the hundreds the machine had swallowed, out through the front and the roof.
    for (const [i] of scripts) { L.pos[i * 3 + 2] = -6 * px; if (L.pos[i * 3 + 1] > p.yFas) L.pos[i * 3 + 1] = p.yTop + p.lh }
    // Each is thrown at a place: most onto the slab (heaped by the machine's sides, thinning out towards the slab's
    // ends, a strip along the front), some clean off it into the dark. Thrown a little long, for the air.
    const seen = Math.min(p.slabX - 24, p.W / 2 + 20), zA = p.zLip + 16 * px, zB = p.zBack - 16 * px
    const want = p.phone ? 170 : 300, launchOne = (i: number, roof: boolean) => {
      const o = i * 3, kind = Math.random(), side = Math.random() < .5 ? -1 : 1
      if (roof && Math.random() < .24) return loose(i, rnd(-1, 1) * 190 * px, rnd(260, 620) * px, rnd(-40, 190) * px, 9)
      let tx: number, tz: number
      if (kind < .26) { tx = side * (p.Xc + 14 * px + rnd(0, 1) ** 1.8 * 150 * px); tz = rnd(-30 * px, p.D * .95) }
      else if (kind < .44) { tx = rnd(-1, 1) * (p.Xc + 50 * px); tz = rnd(zA + 22 * px, -48 * px) }
      else if (kind < .8) { tx = side * rnd(Math.min(p.Xc + 30 * px, seen), seen); tz = zA + (zB - zA) * rnd(0, 1) ** 1.25 }
      else if (kind < .9) { tx = rnd(-1, 1) * seen; tz = p.zLip - rnd(40, 260) * px }
      else { tx = side * (seen + rnd(40, 320)); tz = rnd(zA, zB + 200) }
      const T = rnd(.75, 1.3), k = .46, far = k / (1 - Math.exp(-k * T))
      loose(i, (tx - L.pos[o]) * far, G * T / 2 * 1.06 - L.pos[o + 1] / T, (tz - L.pos[o + 2]) * far, 10)
    }
    for (const [i] of [...scripts]) launchOne(i, L.pos[i * 3 + 1] > p.yFas)
    let live = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE) { live++; if (L.state[i] === ASLEEP) { wake(i); L.vel[i * 3] = rnd(-1, 1) * 380 * px; L.vel[i * 3 + 1] = rnd(300, 760) * px; L.vel[i * 3 + 2] = rnd(-160, 300) * px; L.ang[i * 3] = rnd(-8, 8); L.ang[i * 3 + 2] = rnd(-8, 8) } }
    for (; live < want; live++) {
      const i = alloc(), roof = Math.random() < .22; nextLetter(i)
      if (roof) place(i, rnd(-1, 1) * p.Xw * .7, p.yTop + rnd(4, 30) * px, rnd(.1, .9) * p.D)
      else place(i, rnd(-1, 1) * p.Xw * .9, rnd(p.yCav + p.lh, p.yFas - p.lh * .4), -rnd(3, 14) * px)
      setQuat(i, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(0, 6)); launchOne(i, roof)
    }
    scanning = -1; queue.length = 0; zaps.length = 0; hooks.scan(null, 'jam')
    // The works come apart, each part with its own weight: the hopper, the laser and the chimneys go up off the roof and
    // come down on the slab; the hatch skims away; the glass leaves in panes; rollers, gates and bolts spray forward.
    debrisPart.forEach((index, i) => {
      const home = debrisHome[i], o = i * 3, roof = index === m.idx.hopper || index === m.idx.turret || index === m.idx.hatch || m.idx.vents.includes(index), pane = m.idx.panes.includes(index)
      Dn.state[i] = DYN; Dn.still[i] = 0; Dn.pos.set(home, o); Dn.quat.set([0, 0, 0, 1], i * 4); parts[index].on = true
      if (roof) { const side = home[0] === 0 ? (Math.random() < .5 ? -1 : 1) : Math.sign(home[0]); Dn.vel[o] = side * rnd(160, 420) * px; Dn.vel[o + 1] = rnd(620, 900) * px; Dn.vel[o + 2] = -rnd(60, 260) * px - home[2] * .9 }
      else { Dn.pos[o + 2] = -5 * px; Dn.vel[o] = (home[0] / p.Xw + rnd(-.5, .5)) * (pane ? 380 : 600) * px; Dn.vel[o + 1] = rnd(120, pane ? 520 : 740) * px; Dn.vel[o + 2] = -rnd(160, pane ? 420 : 600) * px }
      const spin = roof ? 5 : pane ? 6 : 12
      Dn.ang[o] = rnd(-spin, spin); Dn.ang[o + 1] = rnd(-spin, spin); Dn.ang[o + 2] = rnd(-spin, spin)
    })
    for (const index of m.idx.cracks) parts[index].on = false
    parts[m.idx.glass].on = false; parts[m.idx.scan].on = false; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = true
    for (const index of m.idx.caps) parts[index].on = false
    for (const cap of caps) cap.on = false
    sparks(cx, cy, -8, 70, 760); sparks(0, p.yTop, p.zL, 30, 600)
    for (let i = 0; i < 60; i++) { const a = rnd(0, Math.PI * 2), far = rnd(0, 1); add({ x: cx + Math.cos(a) * p.Xw * .5 * far, y: cy + Math.sin(a) * p.cavity * .4 * far, z: -8, vx: Math.cos(a) * rnd(60, 300) * px, vy: Math.sin(a) * rnd(40, 200) * px + 80 * px, vz: -rnd(0, 120), max: rnd(.9, 1.5), size: rnd(3, 7) * px, grow: rnd(10, 22) * px, ...rgb(i % 3 ? colour.steam : colour.smoke), a: .55, drag: 2 }) }
    for (const v of m.vents) puff(v[0], p.yTop, v[2], 10, 'steam', 4, 150)
  }
  const rgb = (c: number[]) => ({ r: c[0], g: c[1], b: c[2] })

  // Back together: the letters are drawn up into the hopper, the parts fly home, the gauge falls to zero.
  function rebuild() {
    if (phase !== 'rest' && phase !== 'boom') return
    setPhase('rebuild'); hooks.scan(null, 'idle')
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE) {
      const o = i * 3, d = Math.hypot(L.pos[o], L.pos[o + 2])
      L.state[i] = HOME; scripts.delete(i); delay[i] = .05 + d * .00055 / px + rnd(0, .25); from.set([L.pos[o], L.pos[o + 1], L.pos[o + 2], L.quat[i * 4], L.quat[i * 4 + 1], L.quat[i * 4 + 2], L.quat[i * 4 + 3]], i * 7); L.still[i] = 0
    }
    debrisPart.forEach((_, i) => { Dn.state[i] = HOME; Dn.still[i] = -(.5 + i * .01) })
    resetHeights(); pointer.held = -1; setHover(-1)
  }

  function setPhase(next: Phase) { phase = next; clock = 0; hooks.phase(next) }

  // ── A frame ──
  function advance(dt: number) {
    time += dt; clock += dt
    if (phase === 'boot') { needle = Math.sin(clamp(clock / .7) * Math.PI) * .9; parts[m.idx.lamps[2]].on = clock > .15; parts[m.idx.lamps[1]].on = clock > .3; if (clock > .75) { setPhase('run'); runT = 0; needle = 0 } }
    if (phase === 'run') {
      runT += dt
      const e = clamp((runT - T.calm) / T.ramp); heat = e ** 1.3
      if (e >= 1) setPhase('overload')
    }
    if (phase === 'overload') {
      heat = 1 + clock * .12
      // The glass gives twice before it goes; the gates chatter.
      m.idx.cracks.forEach((index, n) => { const at = T.over * (.22 + n * .4); if (!parts[index].on && clock >= at) { parts[index].on = true; shake = Math.max(shake, 7); sparks(m.crackAt[n][0], m.crackAt[n][1], -4, 12, 260, colour.steam) } })
      if (Math.random() < dt * 14) flapWant[Math.floor(rnd(0, 7))] = Math.random() < .5 ? 1 : 0
      if (clock > T.over) boom()
    }
    const running = phase === 'run' || phase === 'overload'
    // The rollers quicken, the scanner more, but never as fast as the mail arrives: that is what backs up.
    speed = running ? 1 + 1.9 * Math.min(1, heat) ** 1.5 + (phase === 'overload' ? .4 : 0) : 1
    feed = running ? 1 + 4.4 * Math.min(1, heat) ** 1.2 : 1
    if (running) {
      spawnIn -= dt
      if (spawnIn <= 0) { spawn(); spawnIn = phase === 'overload' ? .05 : 1.45 * (1 - heat) ** 3.4 + .07 }
      // Strain: the needle climbs and trembles, the red lamp starts to blink, vents steam, the scanner spits sparks.
      const want = Math.min(1.04, heat * .84 + (phase === 'overload' ? .12 + clock * .05 : 0)) + Math.sin(time * 31) * .012 * heat
      needleV += ((want - needle) * 60 - needleV * 9) * dt; needle += needleV * dt
      shake = Math.max(shake, heat > .4 ? 1 + clamp((heat - .4) / .6) * 5 + (phase === 'overload' ? clock * 1.1 : 0) : 0)
      parts[m.idx.lamps[0]].on = heat > .45 && Math.sin(time * (8 + heat * 22)) > 0
      parts[m.idx.beaconOn].on = heat > .8 && Math.sin(time * 26) > 0
      steamIn -= dt * Math.max(0, heat - .3) * (phase === 'overload' ? 110 : 46)
      while (steamIn < 0) { steamIn += 1; const v = m.vents[Math.random() < .5 ? 0 : 1]; puff(v[0], v[1], v[2], 1, 'steam', 2.5 + heat * 2, 60 + heat * 90, 14); if (heat > .75 && Math.random() < .5) puff(m.ventFront[0] + rnd(-1, 1) * p.U * 2.5, m.ventFront[1], m.ventFront[2], 1, 'steam', 2.5, 34, 40) }
      sparkIn -= dt * Math.max(0, heat - .66) * 26
      while (sparkIn < 0) { sparkIn += 1; const lane = Math.floor(rnd(0, 7)); sparks(p.lanes[lane] + rnd(-1, 1) * p.P * .3, m.yR, -2, 3, 130) }
      if (phase === 'overload' && Math.random() < dt * 9) { const i = Math.floor(rnd(0, m.idx.bolts.length)), k = boltBody + i; if (Dn.state[k] === FREE) { const home = debrisHome[k]; Dn.state[k] = DYN; Dn.pos.set(home, k * 3); Dn.quat.set([0, 0, 0, 1], k * 4); Dn.vel.set([rnd(-1, 1) * 260 * px, rnd(200, 520) * px, -rnd(200, 520) * px], k * 3); Dn.ang.set([rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)], k * 3); sparks(home[0], home[1], -4, 4, 160) } }
    } else {
      parts[m.idx.lamps[0]].on = phase === 'rest' || phase === 'boom'
      parts[m.idx.beaconOn].on = false
      if (phase === 'boom' || phase === 'rest') { needleV += ((-.38 - needle) * 26 - needleV * 2.2) * dt; needle += needleV * dt }
      if (phase === 'boom' && clock < 3.4 && Math.random() < dt * 34 * (1 - clock / 3.4)) { if (Math.random() < .5) puff(rnd(-1, 1) * p.Xw * .8, p.yFas - rnd(0, p.cavity * .5), p.zL, 1, 'smoke', 4, 60); else puff(rnd(-1, 1) * p.lw * .5, p.yTop, p.zL, 1, 'smoke', 4, 90, 12) }
    }
    shake = Math.max(0, shake - dt * (phase === 'boom' ? 14 : 30)); flash = Math.max(0, flash - dt * 4.2)

    for (const [i, s] of scripts) script(i, s, dt, speed)
    if (rainLeft > 0) { const n = Math.min(rainLeft, Math.ceil(dt * 140)); rainLeft -= n; for (let k = 0; k < n; k++) { const i = alloc(); nextLetter(i); place(i, rnd(-.5, .5) * p.W * 1.1 - DX * 600, oyc + rnd(20, 500), rnd(-150, (oyc - 120) / DY)); setQuat(i, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(0, 6)); loose(i, rnd(-60, 60), -rnd(200, 500), rnd(-40, 40), 6) } }
    // Rigid bodies, in steps of a 120th of a second or less: two a frame at full rate, more when frames come slowly.
    const passes = Math.max(2, Math.ceil(dt * 120)), h = dt / passes
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < MAX; i++) if (L.state[i] === DYN) step(L, i, h)
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === DYN) step(Dn, i, h)
    }
    // Scams in the air meet the laser; what burns, burns away.
    for (let k = zaps.length - 1; k >= 0; k--) if (time >= zaps[k].at) { fire(zaps[k].id); zaps.splice(k, 1) }
    for (let i = 0; i < MAX; i++) if (burning[i] && L.state[i] !== FREE) {
      burn[i] += dt * 1.9
      if (Math.random() < dt * 30) add({ x: L.pos[i * 3] + rnd(-1, 1) * p.lw * .4, y: L.pos[i * 3 + 1], z: L.pos[i * 3 + 2] - 1, vx: rnd(-30, 30) * px, vy: rnd(20, 110) * px, max: rnd(.3, .8), size: rnd(.8, 1.6) * px, len: rnd(.8, 1.6) * px, ...rgb(colour.ember), shape: 1, gravity: -.12, drag: 1 })
      if (burn[i] > .55 && Math.random() < dt * 9) puff(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2], 1, 'smoke', 3.5, 40, 8)
      if (burn[i] >= 1.1) { L.state[i] = FREE; burning[i] = 0; scripts.delete(i); burnt++; hooks.count(sorted, burnt); if (pointer.hover === i) setHover(-1) }
    }
    // Letters going home: up in an arc to the hopper, small as they go in.
    if (phase === 'rebuild') {
      let left = 0
      for (let i = 0; i < MAX; i++) if (L.state[i] === HOME) {
        left++; delay[i] -= dt
        if (delay[i] > 0) continue
        L.still[i] += dt / .55
        const u = clamp(L.still[i]), e = ease(u), o = i * 3, f = i * 7, lift = Math.sin(u * Math.PI) * 120 * px
        L.pos[o] = from[f] * (1 - e); L.pos[o + 1] = from[f + 1] + (m.hopperTop + p.lh - from[f + 1]) * e + lift; L.pos[o + 2] = from[f + 2] + (p.zL - from[f + 2]) * e
        for (let k = 0; k < 4; k++) L.quat[i * 4 + k] = from[f + 3 + k] * (1 - e) + (k === 3 ? e : 0)
        const ql = 1 / Math.hypot(L.quat[i * 4], L.quat[i * 4 + 1], L.quat[i * 4 + 2], L.quat[i * 4 + 3]); for (let k = 0; k < 4; k++) L.quat[i * 4 + k] *= ql
        if (u >= 1) L.state[i] = FREE
      }
      let away = 0
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === HOME) {
        Dn.still[i] += dt / .42
        const u = clamp(Dn.still[i]), e = out(u), o = i * 3
        if (u > 0) { for (let k = 0; k < 3; k++) Dn.pos[o + k] += (debrisHome[i][k] - Dn.pos[o + k]) * Math.min(1, e * .35 + dt * 6); for (let k = 0; k < 4; k++) Dn.quat[i * 4 + k] += ((k === 3 ? 1 : 0) - Dn.quat[i * 4 + k]) * Math.min(1, e * .4 + dt * 6); const ql = 1 / Math.hypot(Dn.quat[i * 4], Dn.quat[i * 4 + 1], Dn.quat[i * 4 + 2], Dn.quat[i * 4 + 3]); for (let k = 0; k < 4; k++) Dn.quat[i * 4 + k] *= ql }
        if (u >= 1) Dn.state[i] = FREE; else away++
      }
      needleV += ((0 - needle) * 40 - needleV * 8) * dt; needle += needleV * dt
      const glass = parts[m.idx.glass]
      if (clock > .9) { glass.on = true; glass.fade = clamp((clock - .9) / .3); parts[m.idx.soot].fade = parts[m.idx.shards].fade = 1 - glass.fade; parts[m.idx.hole].on = glass.fade < .5; bend = 1 - glass.fade }
      if (!left && !away && clock > 1.3) { glass.fade = 1; bend = 0; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = false; parts[m.idx.soot].fade = parts[m.idx.shards].fade = 1; spawned = 0; sorted = 0; burnt = 0; hooks.count(0, 0); heat = 0; runT = 0; spawnIn = .2; setPhase('run') }
    }
    if (phase === 'boom' && clock > 1.2) {
      let moving = 0
      for (let i = 0; i < MAX; i++) if (L.state[i] === DYN) { moving++; if (clock > 4.6) { const c = cell(L.pos[i * 3], L.pos[i * 3 + 2]); if (c < 0 || heights[c] === VOID || L.pos[i * 3 + 1] > heights[c] + 30 * px) L.state[i] = FREE; else sleep(L, i) } }
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === DYN && clock > 4.6) sleep(Dn, i)
      if (!moving) setPhase('rest')
    }

    // Capsules down the tubes: down the front between the manifolds, a moment out of sight inside the cabinet, then
    // out of its wall, across the slab and over the lip.
    caps.forEach((cap, k) => {
      const part = parts[m.idx.caps[k]]
      part.on = cap.on && cap.wait <= 0
      if (!cap.on) return
      if (cap.wait > 0) { cap.wait -= dt * Math.sqrt(speed); return }
      cap.s += dt * 540 * px * Math.sqrt(speed)
      const line = m.lines[cap.tube][cap.run], s = runLength[cap.tube][cap.run]
      if (cap.s >= s[s.length - 1]) { if (cap.run + 1 < m.lines[cap.tube].length) { cap.run++; cap.s = 0; cap.wait = .16 } else cap.on = false; part.on = false; return }
      let i = 1; while (s[i] < cap.s) i++
      const a = line[i - 1], b = line[i], u = (cap.s - s[i - 1]) / (s[i] - s[i - 1]), tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2], tl = Math.hypot(tx, ty, tz), angle = Math.acos(clamp(ty / tl, -1, 1)), al = Math.hypot(tz, tx) || 1, sn = Math.sin(angle / 2)
      pose(part.m, [0, 0, 0], [a[0] + tx * u, a[1] + ty * u, a[2] + tz * u], [tz / al * sn, 0, -tx / al * sn, Math.cos(angle / 2)])
    })

    // Gates, rollers, needle, laser.
    for (let i = 0; i < 7; i++) { flapAngle[i] += (flapWant[i] - flapAngle[i]) * Math.min(1, dt * 22 * Math.sqrt(speed)); if (!scripts.size) flapWant[i] = 0 }
    const spin = running ? 120 * px * speed / m.rr * dt : 0
    for (let j = 0; j < 56; j++) {
      const lane = m.rollerLane[j], k = j % 8, home = m.rollerHome[j], part = parts[m.idx.rollers[j]]
      rollerSpin[j] += spin * (lane < 3 ? 1 : lane > 3 ? -1 : .4)
      if (k >= 2 && k <= 5) {
        const a = -m.swing[lane] * 1.02 * flapAngle[lane], hinge = m.hinge[lane], dx = home[0] - hinge[0]
        pose(part.m, home, [hinge[0] + dx * Math.cos(a), hinge[1] + dx * Math.sin(a), home[2]], aboutZ(a + rollerSpin[j]))
      } else pose(part.m, home, home, aboutZ(rollerSpin[j]))
    }
    m.idx.flaps.forEach((index, i) => pose(parts[index].m, m.hinge[i], m.hinge[i], aboutZ(-m.swing[i] * 1.02 * flapAngle[i])))
    pose(parts[m.idx.needle].m, [p.gauge.x, p.gauge.y, 0], [p.gauge.x, p.gauge.y, 0], aboutZ((135 - 270 * needle) * Math.PI / 180))
    aimHold -= dt; if (aimHold <= 0) turretAim = .45 + Math.sin(time * .7) * .25
    turretAngle += (turretAim - turretAngle) * Math.min(1, dt * 10)
    pose(parts[m.idx.turret].m, m.turret, m.turret, aboutZ(turretAngle))
    // Blown-off parts follow their bodies; at home they stand where they were built. The tube the burst bent stays bent.
    debrisPart.forEach((index, i) => {
      if (Dn.state[i] !== FREE) pose(parts[index].m, debrisHome[i], Dn.pos, Dn.quat, 1, i * 3, i * 4)
      else if (!selfPosed.has(index)) { pose(parts[index].m, debrisHome[i], debrisHome[i], [0, 0, 0, 1]); if (m.idx.panes.includes(index)) parts[index].on = false }
    })
    const bent = parts[m.idx.bent]; pose(bent.m, m.parts[m.idx.bent].pivot, m.parts[m.idx.bent].pivot, aboutZ(-.36 * bend))

    // Effects.
    for (let k = fx.length - 1; k >= 0; k--) {
      const f = fx[k]; f.life += dt
      if (f.life >= f.max) { fx[k] = fx[fx.length - 1]; fx.pop(); continue }
      f.vy -= G * f.gravity * dt; const d = 1 - f.drag * dt; f.vx *= d; f.vy *= d; f.vz *= d
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt; f.size += f.grow * dt; f.rot += f.spin * dt
      if (f.gravity > 0 && f.y < 1 && f.z < 0) { f.y = 1; f.vy *= -.3; f.vx *= .5 }
    }
    if (pointer.held >= 0) hold(dt)
    if (pointer.dirty) { pointer.dirty = false; if (pointer.held < 0) setHover(pointer.in && pointer.mouse ? pick(pointer.x, pointer.y) : pointer.hover) }
    if (pointer.hover >= 0) { const i = pointer.hover; if (L.state[i] === FREE) setHover(-1); else hooks.hover(pool[data[i]], p.ox + L.pos[i * 3] + DX * L.pos[i * 3 + 2], oyc - over - L.pos[i * 3 + 1] - DY * L.pos[i * 3 + 2]) }
  }

  function render() {
    let n = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE) {
      const o = n * LETTER_FLOATS, shrink = L.state[i] === HOME ? 1 - clamp(L.still[i]) ** 3 * .7 : 1
      instances[o] = L.pos[i * 3]; instances[o + 1] = L.pos[i * 3 + 1]; instances[o + 2] = L.pos[i * 3 + 2]
      instances[o + 3] = L.quat[i * 4]; instances[o + 4] = L.quat[i * 4 + 1]; instances[o + 5] = L.quat[i * 4 + 2]; instances[o + 6] = L.quat[i * 4 + 3]
      instances[o + 7] = p.lw * shrink; instances[o + 8] = p.lh * shrink; instances[o + 9] = 1.4
      instances[o + 10] = seed[i]; instances[o + 11] = burn[i]; instances[o + 12] = kind[i]; instances[o + 13] = i === pointer.hover || i === pointer.held ? 1 : 0
      n++
    }
    let a = 0, g = 0
    for (const f of fx) {
      const u = f.life / f.max, target = f.glow ? glowData : fxData, o = (f.glow ? g++ : a++) * FX_FLOATS
      if (f.glow ? g > 64 : a > 700) { if (f.glow) g--; else a--; continue }
      // Puffs thin out as they swell; sparks lie along their flight; a bar (the laser's beam) lies where it is put.
      const size = f.size, bar = f.shape === 4
      target[o] = f.x; target[o + 1] = f.y; target[o + 2] = f.z
      target[o + 3] = f.shape === 1 || f.shape === 3 ? Math.max(f.len, size) : size; target[o + 4] = f.shape === 3 ? f.len : size
      target[o + 5] = f.shape === 1 && !f.spin ? Math.atan2(f.vy + DY * f.vz, f.vx + DX * f.vz) : f.rot
      if (bar) { target[o + 3] = f.size; target[o + 4] = f.len }
      target[o + 6] = f.r; target[o + 7] = f.g; target[o + 8] = f.b; target[o + 9] = f.a * (f.shape === 0 ? Math.min(1, u * 8) * (1 - u) ** 1.3 : bar ? 1 : f.shape === 2 ? 1 - u : Math.min(1, (1 - u) * 2.5)); target[o + 10] = bar ? 1 : f.shape
    }
    const s = shake * (reduced ? 0 : 1)
    renderer!.draw({ parts, letters: instances, letterCount: n, fx: fxData, fxCount: a, glow: glowData, glowCount: g, shake: [Math.sin(time * 71) * s, Math.cos(time * 59) * s], flash, wallOn: true })
  }

  // ── The pointer: read a letter, drag it, burn a scam ──
  function pick(sx: number, sy: number) {
    const wx = sx - p.ox, wy = oyc - over - sy
    let best = -1, depth = Infinity
    for (let i = 0; i < MAX; i++) {
      const state = L.state[i]
      if (state === FREE || state === HOME || burning[i]) continue
      const o = i * 3, x = L.pos[o], y = L.pos[o + 1], z = L.pos[o + 2]
      if (Math.abs(x + DX * z - wx) > p.lw || Math.abs(y + DY * z - wy) > p.lw) continue
      matrix(L.quat, i * 4)
      // The letter's plane cut by the line of sight through the pointer: inside its outline, and nearest wins.
      const nx = R[2], ny = R[5], nz = R[8], denom = -DX * nx - DY * ny + nz
      if (Math.abs(denom) < .04) continue
      const t = ((x - wx) * nx + (y - wy) * ny + z * nz) / denom, hx = wx - DX * t - x, hy = wy - DY * t - y, hz = t - z
      const u = hx * R[0] + hy * R[3] + hz * R[6], v = hx * R[1] + hy * R[4] + hz * R[7]
      if (Math.abs(u) <= p.lw / 2 + 2 && Math.abs(v) <= p.lh / 2 + 2 && t < depth) { depth = t; best = i }
    }
    // Behind the fascia or the label rail a letter is out of sight.
    if (best >= 0 && L.state[best] === SCRIPT) { const y = L.pos[best * 3 + 1]; if ((y > p.yFas - p.lh * .2 && y < p.yTop) || y < p.yCav) return -1 }
    return best
  }
  function setHover(i: number) { if (i === pointer.hover) return; pointer.hover = i; hooks.hover(i < 0 ? null : pool[data[i]], 0, 0); canvas.style.cursor = i < 0 ? '' : kind[i] ? 'crosshair' : 'grab'; kick() }
  function hold(dt: number) {
    const i = pointer.held, o = i * 3, wx = pointer.x - p.ox, wy = oyc - over - pointer.y, z = L.pos[o + 2], y = pointer.holdY
    // The pointer's line of sight meets the height the letter is carried at.
    const tz = clamp((wy - y) / DY, -(p.floor / DY), 1600), tx = wx - DX * tz
    const vx = (tx - L.pos[o]) * 16, vy = (y - L.pos[o + 1]) * 16, vz = (tz - z) * 16
    L.vel[o] = vx; L.vel[o + 1] = vy; L.vel[o + 2] = vz
    L.pos[o] += vx * dt; L.pos[o + 1] += vy * dt; L.pos[o + 2] += vz * dt
    // Carried face up.
    const want = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
    const dot = L.quat[i * 4] * want[0] + L.quat[i * 4 + 1] * want[1] + L.quat[i * 4 + 2] * want[2] + L.quat[i * 4 + 3] * want[3], sign = dot < 0 ? -1 : 1
    let l = 0; for (let k = 0; k < 4; k++) { L.quat[i * 4 + k] += (want[k] * sign - L.quat[i * 4 + k]) * Math.min(1, dt * 12); l += L.quat[i * 4 + k] ** 2 }
    l = 1 / Math.sqrt(l); for (let k = 0; k < 4; k++) L.quat[i * 4 + k] *= l
  }
  const local = (event: PointerEvent) => { const box = canvas.getBoundingClientRect(); pointer.x = event.clientX - box.left; pointer.y = event.clientY - box.top - over; pointer.mouse = event.pointerType === 'mouse'; pointer.dirty = true }
  const onMove = (event: PointerEvent) => {
    local(event); pointer.in = true
    if (pointer.down) { pointer.moved += Math.abs(event.movementX) + Math.abs(event.movementY); if (pointer.moved > 6 && pointer.held < 0 && pointer.hover >= 0 && pointer.mouse && L.state[pointer.hover] !== SCRIPT && !kind[pointer.hover]) { pointer.held = pointer.hover; pointer.holdY = L.pos[pointer.held * 3 + 1] + 46 * px; L.state[pointer.held] = HELD; canvas.style.cursor = 'grabbing'; canvas.setPointerCapture(event.pointerId) } }
    kick()
  }
  const onDown = (event: PointerEvent) => { local(event); pointer.down = true; pointer.moved = 0; if (!pointer.mouse) setHover(pick(pointer.x, pointer.y)); kick() }
  const onUp = (event: PointerEvent) => {
    local(event); pointer.down = false
    if (pointer.held >= 0) { const i = pointer.held; pointer.held = -1; L.state[i] = DYN; L.still[i] = 0; for (let k = 0; k < 3; k++) L.vel[i * 3 + k] = clamp(L.vel[i * 3 + k], -1400, 1400); L.ang[i * 3 + 1] = rnd(-3, 3); canvas.style.cursor = 'grab' }
    else if (pointer.moved <= 6) {
      const i = pointer.mouse ? pointer.hover : pick(pointer.x, pointer.y)
      if (i >= 0 && kind[i]) fire(i)
      else if (i >= 0 && L.state[i] !== SCRIPT) { wake(i); L.vel[i * 3 + 1] = 330 * px; L.vel[i * 3] += rnd(-60, 60) * px; L.ang[i * 3] += rnd(-7, 7); L.ang[i * 3 + 2] += rnd(-7, 7) }
    }
    kick()
  }
  const onLeave = () => { pointer.in = false; if (pointer.held < 0) setHover(-1) }
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave)

  const busy = () => phase !== 'rest' || fx.length > 0 || pointer.held >= 0 || rainLeft > 0 || L.state.includes(DYN) || Dn.state.includes(DYN) || burning.includes(1) || zaps.length > 0 || Math.abs(needleV) > .02
  function frame(now: number) {
    raf = 0
    if (dead) return
    const dt = Math.min(.1, (now - last) / 1000 || .016); last = now
    advance(dt); render()
    if (visible && busy()) raf = requestAnimationFrame(frame)
  }
  function kick() { if (!raf && !dead && visible && !reduced) { last = performance.now(); raf = requestAnimationFrame(frame) } }

  build()
  if (reduced) still(); else { advance(0); render(); kick() }

  // With reduced motion: one frame of the machine at work, nothing moving.
  function still() {
    setPhase('run'); needle = .22
    const freeze = (lane: number, set: (i: number) => void) => { const i = alloc(); for (let tries = 0; tries < 80; tries++) { nextLetter(i); if (pool[data[i]].scam === (lane === 7)) break } place(i, 0, 0, p.zL); L.state[i] = SCRIPT; set(i) }
    freeze(3, i => { L.pos[i * 3 + 1] = m.scanY; hooks.scan(pool[data[i]], 'read') })
    freeze(1, i => { L.pos[i * 3] = p.lanes[1] + p.P * .7; L.pos[i * 3 + 1] = m.rideY })
    freeze(5, i => { L.pos[i * 3] = p.lanes[5] - p.P * .4; L.pos[i * 3 + 1] = m.rideY })
    freeze(2, i => { L.pos[i * 3 + 1] = p.yTop + p.hopper * .34 })
    freeze(0, i => { L.pos[i * 3] = p.lw * .5; L.pos[i * 3 + 1] = m.hopperTop + p.lh * 2; setQuat(i, .3, .2, 1, .5) })
    freeze(7, i => { L.pos[i * 3] = m.eject[0] + p.lw * .2; L.pos[i * 3 + 1] = m.eject[1] + p.lh * 2.4; setQuat(i, .2, .1, 1, -.6) })
    parts[m.idx.lamps[1]].on = parts[m.idx.lamps[2]].on = true
    ;[[0, 0, .5], [6, 0, .3], [2, m.lines[2].length - 1, .35], [5, m.lines[5].length - 1, .6]].forEach(([tube, run, at], k) => { const cap = caps[k]; cap.on = true; cap.tube = tube; cap.run = run; cap.wait = 0; cap.s = runLength[tube][run].at(-1)! * at })
    scripts.clear(); advance(0); render()
  }

  return {
    setTheme(next: boolean) { theme(next); if (reduced) render(); else { render(); kick() } },
    setPlan(next: Plan, nextOver: number) { p = next; over = nextOver; phase = 'boot'; clock = 0; heat = 0; needle = 0; needleV = 0; sorted = burnt = 0; scanning = -1; zaps.length = 0; hooks.count(0, 0); hooks.scan(null, 'idle'); build(); hooks.phase('boot'); if (reduced) still(); else { advance(0); render(); kick() } },
    setLetters(next: Letter[]) { if (next.length) { pool = next; cursor = Math.floor(Math.random() * pool.length); for (let i = 0; i < MAX; i++) data[i] %= pool.length } },
    setVisible(next: boolean) { visible = next; if (next) kick() },
    /** The gauge: pressed while the machine runs it overloads it at once; pressed afterwards it puts it back together. */
    gauge() { if (reduced) return; if (phase === 'run' || phase === 'boot') { setPhase('overload'); heat = 1 } else rebuild(); kick() },
    rebuild() { rebuild(); kick() },
    /** The flood: a few hundred more letters out of the night, wherever the machine is in its day. */
    rain() { if (reduced) return; rainLeft += p.phone ? 140 : 280; kick() },
    get phase() { return phase },
    destroy() { dead = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); renderer.destroy() },
  }
}
