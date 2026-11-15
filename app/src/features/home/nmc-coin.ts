// The coin of the "nmc" homepage study: a one-cent piece lying on a table, cut into fifty slices, on one canvas.
// A slice is the price of one email: RATES.emailUc (api/src/billing/money.ts) is $0.0002, a fiftieth of a cent.
// The coin spins down the way a dropped coin does, a cut travels round it, and the slice that points at Sign in slides
// out. Every few seconds that slice leaves and the next takes its place; a slice still in the coin lifts under the
// pointer and leaves when it is pressed. Fifty slices later the next cent lands. Pressing Sign in sends the waiting
// slice off through the button.
//
// It is drawn flat, the way a struck coin is engraved: every raised part has a top, an edge that faces the light, an
// edge that faces away and the shadow it throws, each a tone of one metal a small step from the next.

const TAU = Math.PI * 2
const SLICES = 50
const STEP = TAU / SLICES
// The camera looks down at the table from 46° off vertical. A cent is 1.52 mm thick and 19.05 mm across.
const TILT = 46 * Math.PI / 180, COS = Math.cos(TILT), SIN = Math.sin(TILT)
const THICK = 0.16
/** Height of the coin's box over its width: the top face's ellipse and the edge that shows below it. */
export const COIN_ASPECT = COS + THICK * SIN / 2

// Lengths below are in coin radii unless they say px or ms.
const CUT = 0.0034      // width of a cut
const SEAM_PX = 0.45    // uncut slices overlap by this much, so no hairline shows between them
const PHASE = STEP / 4  // the slices are turned a quarter step, so no cut lies on the coin's vertical or horizontal
const PULL = 0.4        // how far the slice that points at Sign in slides out
const EAGER = 0.07      // and how much further while the pointer is on Sign in
const LIFT = 0.085      // how far a slice under the pointer slides out
// A slice's piece of the reeded edge: where each valley and ridge begins, as fractions of its rim (three reeds).
const REED = [0, 1 / 15, 4 / 15, 6 / 15, 9 / 15, 11 / 15, 14 / 15, 1]

// Timeline of the intro, in ms.
const SPIN = 1250, HOLD = 110, WAVE_STEP = 13, BUMP = 260, CUT_MS = 90, WAVE_RISE = 0.07
const FIRST_SEND = 3600, SEND_EVERY = 6400, DART = 380, NEXT_AFTER = 200, REMINT_AFTER = 900
const BUSY_PERIOD = 1100, BUSY_WIDTH = 0.2, BUSY_RISE = 0.06
// The spin-down of a coin on a table (Euler's disk): the tilt falls as (t0 − t)^(1/3) while the rim's contact point
// circles faster as (t0 − t)^(−1/6), then everything stops at once (Moffatt, Nature 404, 2000). The first tilt is as
// steep as the room above the coin allows.
const TILT_MAX = 24 * Math.PI / 180, TILT_MIN = 8 * Math.PI / 180, WOBBLE_HZ = 2.3

// The light comes from the upper left. AWAY is the way shadows fall on the face; a wall's tone is one of five, by how
// far it faces LIGHT (x to the right, y towards the camera, z up).
const AWAY_X = 0.6, AWAY_Y = 0.8
const LIGHT: [number, number, number] = [-0.86, 0.42, 0.29]
// The shadow on the table, in coin thicknesses.
const SHADE_X = 0.5, SHADE_Y = 0.34

// The face, in a unit circle with y down: a raised rim, a band of fifty envelopes (one to a slice), a band with the
// legend, and the denomination.
const RIM_IN = 0.948, BAND_R = 0.776, CORE_R = 0.596
const ENV_R = 0.862, ENV_W = 0.074, ENV_H = 0.048, ENV_FLAP = 0.56
const LEG_R = 0.686, LEG_CAP = 0.08, LEG_TRACK = 0.5, LEG_SPACE = 0.42
const NUM_CAP = 0.53
// Outlines from Inter at its display optical size (app/public/fonts, SIL OFL), weights 620 and 640, 2048 units to the
// em with a 1490-unit cap height: the coin is whole on its first frame whether or not the web font has arrived.
// A glyph is its path, its advance, and the left and right of its ink.
type Glyph = [d: string, advance: number, left: number, right: number]
const UPM = 2048, CAP_UNITS = 1490
const NUMERAL: Record<string, Glyph> = {
  '1': ['M662 1490V0H399V1233H397L42 1004V1252L411 1490Z', 783, 42, 662],
  '¢': ['M516 0V1490H646V0ZM581 192Q426 192 309 262Q192 332 127 456Q62 581 62 743Q62 906 127 1031Q192 1156 309 1226Q426 1296 581 1296Q681 1296 766 1267Q851 1237 915 1182Q978 1128 1017 1054Q1055 980 1064 891H808Q802 933 784 968Q766 1003 738 1028Q709 1053 671 1067Q632 1081 584 1081Q503 1081 445 1039Q387 998 356 922Q326 846 326 743Q326 641 356 566Q387 490 445 449Q503 408 584 408Q632 408 670 422Q708 435 735 460Q763 485 780 521Q798 556 807 599H1064Q1057 511 1019 437Q981 363 917 308Q853 253 767 223Q682 192 581 192Z', 1120, 62, 1064],
}
const LETTERS: Record<string, Glyph> = {
  N: ['M119 0V1490H419L925 686Q947 652 980 595Q1013 538 1050 472Q1088 405 1121 344L1090 273Q1086 338 1084 423Q1081 509 1080 587Q1078 665 1078 708V1490H1360V0H1059L602 725Q577 766 536 833Q495 901 445 989Q395 1077 339 1175L387 1213Q393 1102 396 1006Q399 910 400 839Q401 767 401 726V0Z', 1479, 119, 1360],
  I: ['M401 1490V0H119V1490Z', 519, 119, 401],
  G: ['M771 -24Q563 -24 405 73Q247 169 157 342Q68 515 68 744Q68 980 160 1153Q251 1326 409 1420Q568 1514 768 1514Q894 1514 1005 1477Q1116 1439 1203 1370Q1289 1301 1345 1206Q1401 1110 1416 994H1130Q1116 1055 1086 1104Q1055 1154 1009 1189Q963 1225 904 1244Q845 1263 775 1263Q645 1263 550 1199Q455 1135 404 1019Q352 903 352 744Q352 586 404 470Q456 354 551 291Q647 227 778 227Q886 227 970 270Q1054 313 1102 390Q1149 467 1149 569L1220 563H811V783H1426V598Q1426 416 1341 275Q1257 135 1109 56Q962 -24 771 -24Z', 1505, 68, 1426],
  H: ['M119 0V1490H401V882H1066V1490H1348V0H1066V639H401V0Z', 1466, 119, 1348],
  T: ['M46 1247V1490H1245V1247H787V0H505V1247Z', 1291, 46, 1245],
  M: ['M119 0V1490H526L799 742Q814 698 834 634Q854 570 876 500Q897 430 915 367Q934 304 945 261H876Q887 304 905 367Q923 430 945 500Q966 570 986 634Q1006 698 1020 742L1288 1490H1697V0H1420V740Q1420 789 1422 855Q1423 921 1425 996Q1427 1070 1429 1146Q1431 1222 1432 1291H1466Q1443 1214 1418 1135Q1394 1055 1371 981Q1348 907 1329 845Q1309 783 1294 740L1023 0H794L520 740Q505 783 485 845Q464 907 441 981Q418 1055 392 1135Q367 1214 342 1291H385Q386 1222 387 1146Q389 1070 391 996Q393 921 395 855Q396 789 396 740V0Z', 1816, 119, 1697],
  A: ['M11 0 540 1490H898L1425 0H1113L864 760Q823 892 779 1036Q735 1180 681 1371H758Q703 1180 659 1036Q615 892 572 760L315 0ZM334 343V572H1103V343Z', 1436, 11, 1425],
  L: ['M119 0V1490H401V243H1086V0Z', 1131, 119, 1086],
  O: ['M766 -24Q566 -24 408 71Q250 165 159 338Q68 511 68 744Q68 979 159 1152Q250 1325 408 1420Q566 1514 766 1514Q966 1514 1123 1420Q1281 1325 1372 1152Q1463 979 1463 744Q1463 510 1372 338Q1281 165 1123 70Q966 -24 766 -24ZM766 227Q885 227 978 287Q1072 348 1126 463Q1179 579 1179 744Q1179 910 1126 1026Q1072 1142 978 1203Q885 1263 766 1263Q647 1263 554 1203Q460 1142 406 1026Q352 910 352 744Q352 579 406 463Q460 348 554 287Q647 227 766 227Z', 1531, 68, 1463],
  E: ['M119 0V1490H1168V1247H401V874H1110V636H401V243H1168V0Z', 1233, 119, 1168],
  C: ['M773 -24Q568 -24 409 70Q250 165 159 337Q68 510 68 744Q68 980 159 1153Q249 1326 408 1420Q568 1514 773 1514Q901 1514 1011 1476Q1121 1438 1206 1367Q1292 1296 1347 1196Q1402 1097 1420 973H1135Q1121 1042 1089 1096Q1057 1150 1010 1187Q964 1225 905 1244Q845 1263 776 1263Q643 1263 548 1199Q454 1135 403 1018Q352 902 352 744Q352 587 403 471Q453 355 548 291Q643 227 776 227Q845 227 904 246Q963 265 1009 302Q1056 339 1088 393Q1120 446 1135 515H1420Q1402 392 1347 292Q1292 193 1206 122Q1120 52 1011 14Q901 -24 773 -24Z', 1485, 68, 1420],
}

type Vec3 = [number, number, number]
// The tones of one face: three bands of the field, the raised rim, the tops of relief, and its edges and shadows.
type Tones = { core: string; mid: string; outer: string; rim: string; relief: string; flap: string; lit: string; shade: string; cast: string; groove: string; grooveLit: string }
// A wall's five tones, darkest first: a reed's ridge and valley, and the thin bands along the wall's top and bottom.
type Walls = { ridge: string[]; valley: string[]; lip: string[]; toe: string[] }
// cold is the coin's metal and hot the brand's blue, for a slice that has left. pit shows through a closed cut.
type Palette = { cold: Tones; hot: Tones; coldWalls: Walls; hotWalls: Walls; pit: string; umbra: string; penumbra: string }
// out: 0 in the coin, 1 slid out towards Sign in. lift: slid out a little under the pointer. hop: off the table, in
// radii, when the slice beside it leaves. fly: when it left, or 0.
type Slice = { out: number; outVel: number; lift: number; liftVel: number; hop: number; hopVel: number; cut: number; gone: boolean; fly: number; from: number }

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const mod = (value: number, by: number) => ((value % by) + by) % by
// Up fast, down slowly: the lift a slice gets as the cut passes it.
const bump = (x: number) => x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x ** 0.55)

// An OKLCH colour as sRGB: the tones are steps of lightness in one hue, and a canvas takes rgb() everywhere.
function oklch(l: number, c: number, h: number) {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180)
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3, M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3, S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channel = (v: number) => Math.round(255 * clamp(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
  return `rgb(${channel(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)}, ${channel(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)}, ${channel(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)})`
}
// The coin's metal, and the brand's blue (--color-brand is oklch(0.638 0.075 269)) for the top of a slice that has
// left: lightness in, colour out. Both lose chroma towards white.
const steel = (l: number) => oklch(l, 0.028 * (1 - clamp((l - 0.55) / 0.6)), 268)
const blue = (l: number) => oklch(l, 0.082 * (1 - clamp((l - 0.7) / 0.34)), 269)
const tones = (metal: (l: number) => string, base: number): Tones => ({
  core: metal(base), mid: metal(base + 0.018), outer: metal(base + 0.036), rim: metal(base + 0.095), relief: metal(base + 0.14), flap: metal(base + 0.195),
  lit: metal(base + 0.34), shade: metal(base - 0.085), cast: metal(base - 0.04), groove: metal(base - 0.09), grooveLit: metal(base + 0.13),
})
function paletteFor([r, g, b]: [number, number, number]): Palette {
  const dark = r + g + b < 384
  const dim = (by: number) => `rgb(${Math.round(r * (1 - by))}, ${Math.round(g * (1 - by))}, ${Math.round(b * (1 - by))})`
  return {
    cold: tones(steel, 0.39), hot: tones(blue, 0.6),
    coldWalls: { ridge: [0.24, 0.29, 0.34, 0.395, 0.455].map(steel), valley: [0.205, 0.25, 0.295, 0.345, 0.4].map(steel), lip: [0.3, 0.37, 0.45, 0.56, 0.7].map(steel), toe: [0.19, 0.22, 0.26, 0.3, 0.345].map(steel) },
    hotWalls: { ridge: [0.36, 0.42, 0.48, 0.54, 0.6].map(blue), valley: [0.32, 0.375, 0.43, 0.485, 0.54].map(blue), lip: [0.44, 0.52, 0.62, 0.74, 0.86].map(blue), toe: [0.29, 0.33, 0.375, 0.42, 0.47].map(blue) },
    pit: steel(0.255),
    umbra: dim(dark ? 0.5 : 0.1), penumbra: dim(dark ? 0.25 : 0.045),
  }
}
// Which of a wall's five tones: how far its normal faces the light.
const wallTone = (x: number, y: number, z: number) => clamp(Math.floor((x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2] + 1) / 2 * 5), 0, 4)

// What is struck on the face, as paths in the unit circle: the same for every size of coin.
type Shapes = { numeral: Path2D; letters: Path2D; bodies: Path2D; creases: Path2D }
let struck: Shapes | undefined
function shapes(): Shapes {
  if (struck) return struck
  const numeral = new Path2D(), letters = new Path2D(), bodies = new Path2D(), creases = new Path2D()
  const polygon = (path: Path2D, points: [number, number][]) => { points.forEach(([x, y], index) => index ? path.lineTo(x, y) : path.moveTo(x, y)); path.closePath() }

  // The denomination, centred on its ink.
  const one = NUMERAL['1'], cent = NUMERAL['¢'], size = NUM_CAP / CAP_UNITS
  let x = -(one[1] - one[2] + cent[3]) / 2 * size - one[2] * size
  for (const glyph of [one, cent]) { numeral.addPath(new Path2D(glyph[0]), { a: size, b: 0, c: 0, d: -size, e: x, f: NUM_CAP / 2 }); x += glyph[1] * size }

  // The legend: letters that stand on the circle LEG_R, feet towards the centre over the top and towards the rim below.
  const legend = (text: string, top: boolean) => {
    const scale = LEG_CAP / CAP_UNITS, track = LEG_TRACK * UPM * scale
    const widths = [...text].map(letter => (letter === ' ' ? LEG_SPACE * UPM : LETTERS[letter][1]) * scale)
    let at = -(widths.reduce((sum, width) => sum + width, 0) + track * (text.length - 1)) / 2
    ;[...text].forEach((letter, index) => {
      const along = (at + widths[index] / 2) / LEG_R
      at += widths[index] + track
      if (letter === ' ') return
      const theta = top ? along - Math.PI / 2 : Math.PI / 2 - along, side = top ? 1 : -1
      // t runs along the baseline, u from the baseline to the cap line.
      const tx = -side * Math.sin(theta), ty = side * Math.cos(theta), ux = side * Math.cos(theta), uy = side * Math.sin(theta)
      const foot = LEG_R - side * LEG_CAP / 2, middle = LETTERS[letter][1] / 2 * scale
      letters.addPath(new Path2D(LETTERS[letter][0]), { a: scale * tx, b: scale * ty, c: scale * ux, d: scale * uy, e: foot * Math.cos(theta) - middle * tx, f: foot * Math.sin(theta) - middle * ty })
    })
  }
  legend('NIGHTMAIL', true)
  legend('ONE CENT', false)
  // A four-pointed star between the two, left and right.
  for (const side of [-1, 1]) polygon(letters, Array.from({ length: 8 }, (_, k): [number, number] => { const r = k % 2 ? 0.0125 : 0.037, a = k * TAU / 8; return [side * LEG_R + Math.cos(a) * r, Math.sin(a) * r] }))

  // An envelope to a slice: a raised plate with the crease of its flap, which points at the centre.
  for (let index = 0; index < SLICES; index++) {
    const a = PHASE + index * STEP, ox = Math.cos(a), oy = Math.sin(a)
    const at = (across: number, out: number): [number, number] => [(ENV_R + out) * ox - across * oy, (ENV_R + out) * oy + across * ox]
    polygon(bodies, [at(-ENV_W / 2, ENV_H / 2), at(ENV_W / 2, ENV_H / 2), at(ENV_W / 2, -ENV_H / 2), at(-ENV_W / 2, -ENV_H / 2)])
    const [left, tip, right] = [at(-ENV_W / 2, ENV_H / 2), at(0, ENV_H / 2 - ENV_H * ENV_FLAP), at(ENV_W / 2, ENV_H / 2)]
    creases.moveTo(...left); creases.lineTo(...tip); creases.lineTo(...right)
  }
  return struck = { numeral, letters, bodies, creases }
}

// The face in the unit circle, in the tones of one metal. px is a CSS pixel in coin radii.
function paintFace(c: CanvasRenderingContext2D, k: Tones, px: number) {
  const { numeral, letters, bodies, creases } = shapes()
  const flood = (fill: string) => { c.fillStyle = fill; c.fillRect(-1.1, -1.1, 2.2, 2.2) }
  const disc = (r: number, x = 0, y = 0) => { const path = new Path2D(); path.arc(x, y, r, 0, TAU); return path }
  const moved = (shape: Path2D, by: number) => { const path = new Path2D(); path.addPath(shape, { e: AWAY_X * by, f: AWAY_Y * by }); return path }
  // A shape with a step at its outline: `near` along the side the light comes from, `far` along the other, each as
  // wide as given, and `top` inside. Raised, near is lit and far is shaded; sunk, the other way round.
  const step = (shape: Path2D, top: string, near: string, nearWidth: number, far: string, farWidth: number) => {
    c.save()
    c.clip(shape); flood(near)
    c.clip(moved(shape, nearWidth)); flood(far)
    c.clip(moved(shape, -farWidth)); flood(top)
    c.restore()
  }
  // Raised relief: the shadow it throws on the field, then the shape with a lit edge and a shaded one.
  const raise = (shape: Path2D, top: string, height: number) => {
    c.fillStyle = k.cast; c.fill(moved(shape, height * 1.5))
    step(shape, top, k.lit, height, k.shade, height * 1.15)
  }
  // An engraved line: dark, with the light catching its far wall.
  const groove = (line: Path2D, dark: string, light: string) => {
    c.lineWidth = 1.1 * px; c.lineJoin = 'miter'
    c.strokeStyle = light; c.stroke(moved(line, px))
    c.strokeStyle = dark; c.stroke(line)
  }

  // The sheet is flooded past the coin's outline: each slice is clipped to its wedge when it is drawn.
  flood(k.rim)
  step(disc(1), k.rim, k.lit, 0.011, k.shade, 0.012)
  step(disc(RIM_IN), k.outer, k.shade, 0.014, k.lit, 0.006)
  c.fillStyle = k.mid; c.fill(disc(BAND_R))
  c.fillStyle = k.core; c.fill(disc(CORE_R))
  groove(disc(BAND_R), k.groove, k.grooveLit); groove(disc(CORE_R), k.groove, k.grooveLit)
  raise(bodies, k.relief, 0.0042)
  groove(creases, k.shade, k.flap)
  raise(letters, k.relief, 0.0045)
  raise(numeral, k.relief, 0.0085)
}

export type Coin = { setBusy: (busy: boolean) => void; setEager: (eager: boolean) => void; destroy: () => void }

/** The coin lies where `slot` is, on a canvas that covers the page; the slice that slides out points at `target`. */
export function mountCoin(canvas: HTMLCanvasElement, slot: HTMLElement, target: HTMLElement, { reduced }: { reduced: boolean }): Coin {
  const ctx = canvas.getContext('2d')!
  const probe = document.createElement('span')
  probe.style.display = 'none'
  slot.appendChild(probe)

  let dpr = 1, width = 0, height = 0, R = 0, cx = 0, cy = 0, base = 0, tilt0 = TILT_MIN
  let palette!: Palette, cold!: HTMLCanvasElement, hot!: HTMLCanvasElement
  // start is the time of the intro's first frame: a page opened in a background tab plays it when it is first seen.
  let raf = 0, timer = 0, next = 0, dead = false, start = 0, last = performance.now()
  // tray: the slice slid out towards Sign in, or on its way there. eager: the pointer is on Sign in.
  let cutDone = reduced, tray = -1, hover = -1, busyAt = 0, eager = false
  const slices: Slice[] = Array.from({ length: SLICES }, () => ({ out: 0, outVel: 0, lift: 0, liftVel: 0, hop: 0, hopVel: 0, cut: reduced ? 1 : 0, gone: false, fly: 0, from: 0 }))
  const angle = (index: number) => PHASE + index * STEP
  // Slices leave from the one that points at Sign in outwards, a side at a time: the opening stays aimed at the button.
  const nextFree = () => {
    for (let n = 0; n < SLICES; n++) { const index = mod(base + (n % 2 ? (n + 1) / 2 : -n / 2), SLICES); if (!slices[index].gone && !slices[index].fly) return index }
    return -1
  }
  // How many slices a slice is from the far side of the coin, where the cut starts.
  const rank = (index: number) => SLICES / 2 - Math.min(mod(index - base, SLICES), mod(base - index, SLICES))
  const snap = (value: number) => Math.round(value * dpr) / dpr

  // A colour token as numbers. The tokens used are plain sRGB colours, which every browser computes to rgb(r, g, b).
  function color(name: string): [number, number, number] {
    probe.style.color = `var(${name})`
    const [r = 0, g = 0, b = 0] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
    return [r, g, b]
  }

  // The flat coin's face as the camera sees it, at device resolution.
  function face(k: Tones) {
    const sheet = document.createElement('canvas')
    sheet.width = Math.ceil((2 * R + 2) * dpr); sheet.height = Math.ceil((2 * R * COS + 2) * dpr)
    const c = sheet.getContext('2d')!
    c.setTransform(R * dpr, 0, 0, R * COS * dpr, (R + 1) * dpr, (R * COS + 1) * dpr)
    paintFace(c, k, 1 / R)
    return sheet
  }

  function layout() {
    const page = canvas.getBoundingClientRect(), box = slot.getBoundingClientRect(), to = target.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 3)
    width = page.width; height = page.height
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    R = box.width / 2
    cx = snap(box.left - page.left + R); cy = snap(box.top - page.top + R * COS)
    // The slice nearest the line from the coin's centre to Sign in, or nearest --nmc-aim (degrees clockwise from
    // the right) where the page sets it.
    const set = parseFloat(getComputedStyle(slot).getPropertyValue('--nmc-aim'))
    const towards = Number.isFinite(set) ? set * Math.PI / 180 : Math.atan2((to.top + to.height / 2 - page.top - cy) / COS, to.left + to.width / 2 - page.left - cx)
    const aim = mod(Math.round((towards - PHASE) / STEP), SLICES)
    if (aim !== base) { base = aim; if (tray >= 0 && !slices[tray].fly) tray = nextFree() }
    // Tilted by a with its far side up, the coin's far rim stands 2R (sin a sin TILT − (1 − cos a) cos TILT) above
    // where it lies: the first tilt is the steepest that stays inside the stage.
    const room = Math.max(0, box.top - (slot.parentElement?.getBoundingClientRect().top ?? box.top))
    const rise = (a: number) => 2 * R * (Math.sin(a) * SIN - (1 - Math.cos(a)) * COS)
    tilt0 = TILT_MAX
    for (let low = TILT_MIN, high = TILT_MAX, n = 0; rise(TILT_MAX) > room && n < 12; n++) { const middle = (low + high) / 2; if (rise(middle) > room) high = middle; else low = middle; tilt0 = low }
    palette = paletteFor(color('--color-deep'))
    if (R > 0) { cold = face(palette.cold); hot = face(palette.hot) }
  }

  // A band of a wall: the quad under the edge from (x0, y0) to (x1, y1), between two depths along (tx, ty).
  const band = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number, from: number, to: number, fill: string) => {
    ctx.fillStyle = fill
    ctx.beginPath(); ctx.moveTo(x0 + tx * from, y0 + ty * from); ctx.lineTo(x1 + tx * from, y1 + ty * from); ctx.lineTo(x1 + tx * to, y1 + ty * to); ctx.lineTo(x0 + tx * to, y0 + ty * to); ctx.closePath(); ctx.fill()
  }
  // A piece of wall in one of the five tones: its body (a reed's ridge or the valley beside it), a lighter lip where
  // it meets the face and a darker toe at the table. heat is how far it has taken the brand's blue.
  const wall = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number, ridge: boolean, tone: number, heat = 0) => {
    const depth = Math.hypot(tx, ty), lip = Math.max(1, 0.011 * R) / depth, toe = Math.max(1, 0.012 * R) / depth
    for (const walls of heat < 1 ? heat > 0 ? [palette.coldWalls, palette.hotWalls] : [palette.coldWalls] : [palette.hotWalls]) {
      if (walls === palette.hotWalls && heat < 1) ctx.globalAlpha = heat
      band(x0, y0, x1, y1, tx, ty, 0, 1, (ridge ? walls.ridge : walls.valley)[tone])
      band(x0, y0, x1, y1, tx, ty, 0, lip, walls.lip[tone])
      band(x0, y0, x1, y1, tx, ty, 1 - toe, 1, walls.toe[tone])
    }
    ctx.globalAlpha = 1
  }

  // The whole coin, tilted by alpha towards azimuth phi and turned by psi about its own axis, with its lowest rim point on the table.
  function drawSolid(alpha: number, phi: number, psi: number) {
    const T = THICK * R, sa = Math.sin(alpha), ca = Math.cos(alpha), sp = Math.sin(phi), cp = Math.cos(phi)
    // Rz(phi) · Ry(alpha) · Rz(−phi) · Rz(psi): e1 and e2 span the face, n is its normal.
    const spin = (x: number, y: number): Vec3 => {
      const x1 = x * Math.cos(psi - phi) - y * Math.sin(psi - phi), y1 = x * Math.sin(psi - phi) + y * Math.cos(psi - phi)
      const x2 = x1 * ca, z2 = -x1 * sa
      return [x2 * cp - y1 * sp, x2 * sp + y1 * cp, z2]
    }
    const e1 = spin(1, 0), e2 = spin(0, 1), n: Vec3 = [sa * cp, sa * sp, ca]
    const project = (x: number, y: number, z: number): [number, number] => [x, y * COS - z * SIN]
    const centre: Vec3 = [T * n[0], T * n[1], R * sa + T * n[2]]
    const [ox, oy] = project(...centre)
    const originX = cx + ox, originY = cy + T * SIN + oy
    const [ax, ay] = project(e1[0] * R, e1[1] * R, e1[2] * R), [bx, by] = project(e2[0] * R, e2[1] * R, e2[2] * R)
    const [tx, ty] = project(-T * n[0], -T * n[1], -T * n[2])
    // The face's shadow on the table: every point is thrown SHADE times its height away from the light.
    for (const [far, fill] of [[1.7, palette.penumbra], [1, palette.umbra]] as const) {
      const kx = SHADE_X * far, ky = SHADE_Y * far
      ctx.save()
      ctx.transform((e1[0] + kx * e1[2]) * R, (e1[1] + ky * e1[2]) * R * COS, (e2[0] + kx * e2[2]) * R, (e2[1] + ky * e2[2]) * R * COS, cx + centre[0] + kx * centre[2], cy + T * SIN + (centre[1] + ky * centre[2]) * COS)
      ctx.fillStyle = fill
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill()
      ctx.restore()
    }
    for (let index = 0; index < SLICES; index++) for (let k = 0; k < REED.length - 1; k++) {
      const t0 = angle(index) - STEP / 2 + REED[k] * STEP, t1 = angle(index) - STEP / 2 + REED[k + 1] * STEP, tm = (t0 + t1) / 2
      const nx = Math.cos(tm) * e1[0] + Math.sin(tm) * e2[0], ny = Math.cos(tm) * e1[1] + Math.sin(tm) * e2[1], nz = Math.cos(tm) * e1[2] + Math.sin(tm) * e2[2]
      if (ny * SIN + nz * COS <= 0) continue
      wall(originX + Math.cos(t0) * ax + Math.sin(t0) * bx, originY + Math.cos(t0) * ay + Math.sin(t0) * by, originX + Math.cos(t1) * ax + Math.sin(t1) * bx, originY + Math.cos(t1) * ay + Math.sin(t1) * by, tx, ty, k % 2 > 0, wallTone(nx, ny, nz))
    }
    ctx.save()
    ctx.transform(ax / R, ay / R, bx / (R * COS), by / (R * COS), originX, originY)
    ctx.beginPath(); ctx.ellipse(0, 0, R, R * COS, 0, 0, TAU); ctx.clip()
    ctx.drawImage(cold, -R - 1, -R * COS - 1, cold.width / dpr, cold.height / dpr)
    ctx.restore()
  }

  // A slice's whole wedge of the coin, cuts included, as a path: moved by (dx, dy) px and widened by `more` radians a side.
  function wedge(index: number, dx: number, dy: number, more = 0) {
    const a0 = angle(index) - STEP / 2 - more
    ctx.beginPath(); ctx.moveTo(cx + dx, cy + dy)
    for (let k = 0; k <= 4; k++) { const t = a0 + (STEP + 2 * more) * k / 4; ctx.lineTo(cx + dx + Math.cos(t) * R, cy + dy + Math.sin(t) * R * COS) }
    ctx.closePath()
  }

  // One slice, slid `off` radii along its own direction and `rise` radii off the table. heat is how far it has taken
  // the brand's blue. A cut's wall is drawn where the slice beside it has moved or gone (before, after): between two
  // slices in place a cut shows only the pit.
  function drawSlice(index: number, off: number, rise: number, heat: number, before: boolean, after: boolean) {
    const slice = slices[index], a = angle(index), half = STEP / 2, drop = THICK * R * SIN
    const dx = snap(Math.cos(a) * off * R), dy = snap(Math.sin(a) * off * R * COS - rise * R * SIN)
    const inset = CUT * R / 2 * slice.cut - SEAM_PX * (1 - slice.cut)
    const tip = Math.max(0, inset / Math.sin(half)), lean = Math.asin(clamp(inset / R, -1))
    const tipX = cx + dx + Math.cos(a) * tip, tipY = cy + dy + Math.sin(a) * tip * COS
    const rim = REED.map((part): [number, number, number] => { const t = a - half + lean + (STEP - 2 * lean) * part; return [cx + dx + Math.cos(t) * R, cy + dy + Math.sin(t) * R * COS, t] })
    const end = rim[rim.length - 1]
    // Walls that face the camera: the two cuts, then its piece of the reeded edge. A cut's wall that looks into the
    // slot a slice has left is in that slot's shade, two tones down.
    const shade = off > 0.002 ? 0 : 2
    if (before && -Math.cos(a - half) > 0.001) wall(tipX, tipY, rim[0][0], rim[0][1], 0, drop, false, Math.max(0, wallTone(Math.sin(a - half), -Math.cos(a - half), 0) - shade), heat)
    if (after && Math.cos(a + half) > 0.001) wall(end[0], end[1], tipX, tipY, 0, drop, false, Math.max(0, wallTone(-Math.sin(a + half), Math.cos(a + half), 0) - shade), heat)
    for (let k = 0; k < rim.length - 1; k++) {
      const tm = (rim[k][2] + rim[k + 1][2]) / 2
      if (Math.sin(tm) > 0) wall(rim[k][0], rim[k][1], rim[k + 1][0], rim[k + 1][1], 0, drop, k % 2 > 0, wallTone(Math.cos(tm), Math.sin(tm), 0), heat)
    }
    ctx.save()
    ctx.beginPath(); ctx.moveTo(tipX, tipY)
    for (const [x, y] of rim) ctx.lineTo(x, y)
    ctx.closePath(); ctx.clip()
    const left = cx + dx - R - 1, top = cy + dy - R * COS - 1, w = cold.width / dpr, h = cold.height / dpr
    if (heat < 1) ctx.drawImage(cold, left, top, w, h)
    if (heat > 0) { ctx.globalAlpha = heat; ctx.drawImage(hot, left, top, w, h) }
    ctx.restore()
  }

  function frame(now: number) {
    raf = 0
    start ||= now
    const dt = Math.min(48, now - last), t = now - start
    last = now
    let moving = false
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!R) return
    if (!reduced && t < SPIN) {
      const left = 1 - t / SPIN
      const alpha = tilt0 * Math.cbrt(left)
      const phi = -Math.PI / 2 + TAU * WOBBLE_HZ * SPIN / 1000 * 1.2 * (1 - left ** (5 / 6))
      // Rolling without slipping turns the face slowly against the wobble; it ends upright.
      const psi = -TAU * WOBBLE_HZ * SPIN / 1000 * (1 - Math.cos(tilt0)) * 0.55 * left ** 1.5
      drawSolid(alpha, phi, psi)
      raf = requestAnimationFrame(frame)
      return
    }
    const wave = t - SPIN - HOLD
    if (!cutDone) {
      moving = true
      for (let index = 0; index < SLICES; index++) slices[index].cut = clamp((wave - rank(index) * WAVE_STEP) / CUT_MS)
      if (tray < 0 && wave >= SLICES / 2 * WAVE_STEP) leave(base)
      if (wave >= SLICES / 2 * WAVE_STEP + BUMP + CUT_MS) { cutDone = true; schedule(FIRST_SEND) }
    }
    const pose = slices.map(() => ({ off: 0, rise: 0, heat: 0 }))
    for (let index = 0; index < SLICES; index++) {
      const slice = slices[index], at = pose[index]
      if (slice.gone) continue
      // Springs, stepped in 4 ms slices so a long frame can't throw them: both run a little past and settle. A slice
      // that has left keeps the pose it left in.
      const outTo = index === tray ? 1 + (eager ? EAGER / PULL : 0) : 0, liftTo = index === hover && index !== tray ? LIFT : 0
      if (reduced) { slice.out = outTo; slice.outVel = 0 }
      for (let step = slice.fly ? 0 : dt; step > 0; step -= 4) {
        const h = Math.min(4, step) / 1000
        slice.outVel += (170 * (outTo - slice.out) - 17 * slice.outVel) * h; slice.out += slice.outVel * h
        slice.liftVel += (520 * (liftTo - slice.lift) - 30 * slice.liftVel) * h; slice.lift += slice.liftVel * h
        slice.hopVel += (-600 * slice.hop - 26 * slice.hopVel) * h; slice.hop += slice.hopVel * h
      }
      if (!slice.fly) {
        if (Math.abs(outTo - slice.out) < 0.0005 && Math.abs(slice.outVel) < 0.005) { slice.out = outTo; slice.outVel = 0 } else moving = true
        if (Math.abs(liftTo - slice.lift) < 0.0004 && Math.abs(slice.liftVel) < 0.004) { slice.lift = liftTo; slice.liftVel = 0 } else moving = true
        if (Math.abs(slice.hop) < 0.0004 && Math.abs(slice.hopVel) < 0.004) { slice.hop = 0; slice.hopVel = 0 } else moving = true
      }
      at.off = PULL * slice.out + slice.lift
      at.rise = Math.max(0, slice.hop)
      at.heat = clamp(slice.out * 1.7) + slice.lift / LIFT * 0.55 + at.rise * 6
      if (!cutDone && index !== base) { const push = bump((wave - rank(index) * WAVE_STEP) / BUMP); at.rise += WAVE_RISE * push; at.heat += push * 0.38 }
      if (busyAt) {
        const along = (((now - busyAt) / BUSY_PERIOD - index / SLICES) % 1 + 1) % 1
        if (along < BUSY_WIDTH && slice.out < 0.5) { const push = Math.sin(Math.PI * along / BUSY_WIDTH); at.rise += BUSY_RISE * push; at.heat += push * 0.5 }
        moving = true
      }
      if (slice.fly) {
        const k = (now - slice.fly) / DART
        if (k >= 1) { Object.assign(slice, { gone: true, fly: 0, out: 0, outVel: 0, lift: 0, liftVel: 0, hop: 0, hopVel: 0 }); continue }
        // A short draw back, then away until it is off the page.
        at.off = slice.from - 0.05 * Math.sin(Math.PI * clamp(k / 0.3)) + (reach(angle(index)) - slice.from) * clamp((k - 0.22) / 0.78) ** 2.4
        at.heat = 1
        moving = true
      }
      at.off = Math.max(0, at.off)
      at.heat = clamp(at.heat)
    }
    const here = slices.map((_, index) => index).filter(index => !slices[index].gone)
    // Each slice's shadow on the table, a soft edge and a dark middle: its wedge, thrown down and away from the light
    // by the height of its top.
    const T = THICK * R, drop = T * SIN
    for (const [far, fill] of [[1.7, palette.penumbra], [1, palette.umbra]] as const) {
      ctx.fillStyle = fill
      for (const index of here) {
        const high = (T + pose[index].rise * R) * far
        wedge(index, Math.cos(angle(index)) * pose[index].off * R + SHADE_X * high, Math.sin(angle(index)) * pose[index].off * R * COS + drop + SHADE_Y * high * COS, 0.004)
        ctx.fill()
      }
    }
    // Far slices first. A slice only ever moves along its own direction or straight up, so it stays over its own
    // sector of the table, and of two sectors the one that points more towards the camera is in front.
    const depth = (index: number) => Math.sin(angle(index))
    const apart = (index: number, side: number) => { const beside = mod(index + side, SLICES); return slices[beside].gone || Math.abs(pose[beside].off - pose[index].off) > 0.002 || Math.abs(pose[beside].rise - pose[index].rise) > 0.001 }
    for (const index of here.sort((a, b) => depth(a) - depth(b))) {
      // Under a slice that hasn't slid out, its footprint in the tone of a closed cut: a cut is too narrow and too
      // deep to see the table through, so it shows as that tone and never as the page's or a wall's behind it.
      if (!pose[index].off) {
        ctx.fillStyle = palette.pit
        wedge(index, 0, 0); ctx.fill()
        const a0 = angle(index) - STEP / 2, a1 = a0 + STEP
        if (Math.sin(a0) > 0 || Math.sin(a1) > 0) band(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R * COS, cx + Math.cos(a1) * R, cy + Math.sin(a1) * R * COS, 0, drop, 0, 1, palette.pit)
      }
      drawSlice(index, pose[index].off, pose[index].rise, pose[index].heat, apart(index, -1), apart(index, 1))
    }
    if (cutDone && !here.length && !timer) timer = window.setTimeout(remint, REMINT_AFTER)
    if (moving) raf = requestAnimationFrame(frame)
  }

  // How far, in radii, a slice travels in a direction before all of it has left the canvas.
  function reach(a: number) {
    const ux = Math.cos(a), uy = Math.sin(a) * COS
    const toX = ux > 0 ? (width - cx) / ux : ux < 0 ? -cx / ux : Infinity, toY = uy > 0 ? (height - cy) / uy : uy < 0 ? -cy / uy : Infinity
    return Math.min(toX, toY) / R + 0.2
  }

  const kick = () => { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(frame) } }

  // A slice starts out towards Sign in; the slices beside it hop as it goes.
  function leave(index: number) {
    tray = index
    for (const side of [-1, 1]) for (const away of [1, 2, 3]) { const beside = slices[mod(index + side * away, SLICES)]; if (!beside.gone && !beside.fly) beside.hopVel += 1.5 / away }
  }

  function send(index: number) {
    const slice = slices[index]
    if (!cutDone || !slice || slice.gone || slice.fly) return
    slice.fly = performance.now(); slice.from = PULL * slice.out + slice.lift
    if (tray === index) {
      tray = -1
      window.clearTimeout(next)
      next = window.setTimeout(() => { if (tray < 0) { const index = nextFree(); if (index >= 0) leave(index); kick() } }, NEXT_AFTER)
    }
    if (hover === index) hover = -1
    kick()
  }

  function schedule(delay: number) {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = 0
      if (document.hidden || hover >= 0 || busyAt || eager) { schedule(SEND_EVERY); return }
      if (tray >= 0) send(tray)
      if (slices.some(slice => !slice.gone && !slice.fly)) schedule(SEND_EVERY)
    }, delay)
  }

  // Fifty slices later the cent is spent: the next one lands.
  function remint() {
    timer = 0
    for (const slice of slices) Object.assign(slice, { out: 0, outVel: 0, lift: 0, liftVel: 0, hop: 0, hopVel: 0, cut: 0, gone: false, fly: 0, from: 0 })
    cutDone = false; tray = -1; hover = -1
    start = 0
    kick()
  }

  // The slice under a pointer, or −1: first the one that has slid out, then those still in the coin.
  function sliceAt(event: PointerEvent) {
    const page = canvas.getBoundingClientRect()
    const x = (event.clientX - page.left - cx) / R, y = (event.clientY - page.top - cy) / (R * COS)
    if (tray >= 0 && slices[tray].out > 0.9 && !slices[tray].fly) {
      const a = angle(tray), px = x - Math.cos(a) * PULL, py = y - Math.sin(a) * PULL
      const along = px * Math.cos(a) + py * Math.sin(a), across = Math.abs(py * Math.cos(a) - px * Math.sin(a))
      if (along > 0 && along < 1.02 && across < along * Math.tan(STEP / 2) + 0.012) return tray
    }
    const radius = Math.hypot(x, y)
    if (radius < 0.08 || radius > 1.02) return -1
    const index = mod(Math.round((Math.atan2(y, x) - PHASE) / STEP), SLICES)
    return slices[index].gone || slices[index].fly || index === tray ? -1 : index
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || !cutDone) return
    const index = sliceAt(event)
    if (index !== hover) { hover = index; kick() }
  }
  const onLeave = () => { if (hover >= 0) { hover = -1; kick() } }
  const onDown = (event: PointerEvent) => { if (event.button === 0) send(sliceAt(event)) }

  const redraw = () => { layout(); kick() }
  const resize = new ResizeObserver(redraw)
  resize.observe(canvas); resize.observe(slot); resize.observe(target)
  // The theme toggle swaps the page's colours: the coin's shadow is repainted in them.
  const theme = new MutationObserver(redraw)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const stage = canvas.parentElement!
  if (!reduced) {
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerleave', onLeave)
    stage.addEventListener('pointerdown', onDown)
  }
  layout()
  if (reduced) { tray = base; slices[base].out = 1 }
  kick()

  return {
    // Sign-in has started: the slice that had slid out leaves through the button, and a ripple runs round the coin
    // until the page goes.
    setBusy(busy) {
      if (reduced || !!busyAt === busy) return
      busyAt = busy ? performance.now() : 0
      if (busy && tray >= 0 && slices[tray].out > 0.9) send(tray)
      kick()
    },
    // The pointer is on Sign in: the slice that has slid out leans towards it.
    setEager(on) {
      if (reduced || eager === on) return
      eager = on
      kick()
    },
    destroy() {
      dead = true
      cancelAnimationFrame(raf); window.clearTimeout(timer); window.clearTimeout(next)
      resize.disconnect(); theme.disconnect()
      stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerleave', onLeave); stage.removeEventListener('pointerdown', onDown)
      probe.remove()
    },
  }
}
