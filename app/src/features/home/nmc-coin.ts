// The coin of the "nmc" homepage study: a one-cent piece lying on a table, on one canvas. Its outer ring is fifty
// slices with an envelope on each, round a medallion that carries the denomination: fifty emails to the cent, which
// is the price (RATES.emailUc in api/src/billing/money.ts is $0.0002). The coin settles the way a dropped coin does,
// the slices are counted round in the brand's blue, and the last, the one that points at Sign in, slides out. A
// slice slides out a little under the pointer, and out or back in when it is pressed.
//
// It is drawn flat, as a solid seen from above and in front: every surface has one tone of its own (the medallion,
// the ring, the wall, the slot a slice leaves), and what stands up from a surface shows its top and, straight below
// it, its side.

const TAU = Math.PI * 2
const SLICES = 50
const STEP = TAU / SLICES
// The camera looks down at the table from 46° off vertical. A cent is 1.52 mm thick and 19.05 mm across.
const TILT = 46 * Math.PI / 180, COS = Math.cos(TILT), SIN = Math.sin(TILT)
const THICK = 0.16
/** Height of the coin's box over its width: the top face's ellipse and the edge that shows below it. */
export const COIN_ASPECT = COS + THICK * SIN / 2

// Lengths below are in coin radii unless they say px or ms.
const INNER = 0.7       // where the slices end and the medallion begins
const SEAM_PX = 0.45    // pieces in place overlap by this much, so that the page never shows between them
const PHASE = STEP / 4  // the slices are turned a quarter step, so no seam lies on the coin's vertical or horizontal
const PULL = 0.44       // how far a slice slides out: clear of the rim by 0.14
const EAGER = 0.12      // how much further the slice that points at Sign in goes while the pointer is on the button
const LIFT = 0.07       // how far a slice under the pointer slides out
const PLAIN_PX = 100    // a coin with a smaller radius than this carries a chevron on each slice in place of an envelope
// A slice's piece of the reeded edge: where each valley and ridge begins, as fractions of its rim (three reeds).
const REED = [0, 1 / 15, 4 / 15, 6 / 15, 9 / 15, 11 / 15, 14 / 15, 1]

// The intro, in ms: the coin settles, then the slices are counted round, one every TICK, each lit for LIT.
const SPIN = 950, HOLD = 90, TICK = 10, LIT = 110
// While sign-in starts the count keeps going round, slower.
const BUSY_TICK = 16
// A coin dropped on a table rolls round on its rim: the tilt dies away while the point it rests on circles faster
// and faster (Euler's disk; Moffatt, Nature 404, 2000). Here the tilt falls almost evenly, so that every frame shows
// it lower than the last; the first tilt is as steep as the room above the coin allows.
const TILT_MAX = 24 * Math.PI / 180, TILT_MIN = 7 * Math.PI / 180, TURNS = 3.1

// The light comes from the upper left: AWAY points from it across the face, and a wall's tone is one of five, by how
// far it faces LIGHT (x to the right, y towards the camera, z up). The rim's top edge is lit from 8 o'clock round to
// 1 o'clock and shaded from 2 to 7, as angles clockwise from 3 o'clock.
const AWAY_X = 0.6, AWAY_Y = 0.8
const LIGHT: [number, number, number] = [-0.86, 0.42, 0.29]
const LIT_FROM = 150 * Math.PI / 180, LIT_TO = 300 * Math.PI / 180, SHADE_FROM = 330 * Math.PI / 180, SHADE_TO = 480 * Math.PI / 180
// The shadow on the table is a contact shadow: what lies on it, a few px down and to the right.
const SHADE_X = 2, SHADE_Y = 5

// The face, in a unit circle with y down: a raised rim, the ring of fifty envelopes (one to a slice), and on the
// medallion the legend and the denomination. Heights are in px: how far a raised part's side shows below its top.
const RIM_IN = 0.948, RIM_HIGH = 1.5
const ENV_R = (INNER + RIM_IN) / 2, ENV_W = 0.082, ENV_H = 0.054, ENV_FLAP = 0.52
const LEG_R = 0.585, LEG_CAP = 0.088, LEG_TRACK = 0.14, LEG_SPACE = 0.36, LEG_HIGH = 1.25
const NUM_CAP = 0.44, NUM_HIGH = 2.5
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
// The tones of one face: the medallion, the ring and the rim with its lit and shaded bevels and the side of its
// step; a seam between slices and the mark on each; the tops of what is raised and its side; the lines along the
// top edge of the rim where it is lit and where it is shaded.
type Tones = { face: string; ring: string; rim: string; rimLit: string; rimShade: string; rimSide: string; seam: string; mark: string; relief: string; reliefSide: string; edgeLit: string; edgeShade: string }
// A wall's five tones, darkest first, for a reed's ridge and for the valley beside it.
type Walls = { ridge: string[]; valley: string[] }
// cold is the coin's metal and hot the brand's blue, for a slice that is counted or has left. slot is the wall of
// the slot a slice leaves. shadow lies on the table under whatever stands on it.
type Palette = { cold: Tones; hot: Tones; coldWalls: Walls; hotWalls: Walls; slot: Walls; shadow: string }
// out: 0 in the coin, 1 slid out. lift: slid out a little under the pointer. wanted: whether it is to be out.
type Slice = { out: number; outVel: number; lift: number; liftVel: number; wanted: boolean }

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const mod = (value: number, by: number) => ((value % by) + by) % by

// An OKLCH colour as sRGB: the tones are steps of lightness in one hue, and a canvas takes rgb() everywhere.
function oklch(l: number, c: number, h: number) {
  const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180)
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3, M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3, S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channel = (v: number) => Math.round(255 * clamp(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
  return `rgb(${channel(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)}, ${channel(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)}, ${channel(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)})`
}
// The coin's metal, and the brand's blue (--color-brand is oklch(0.638 0.075 269)): lightness in, colour out. Both
// lose chroma towards white.
const steel = (l: number) => oklch(l, 0.018 * (1 - clamp((l - 0.6) / 0.42)), 268)
const blue = (l: number) => oklch(l, 0.082 * (1 - clamp((l - 0.7) / 0.34)), 269)
// Four flat steps, far enough apart to read at a glance: the medallion, the ring, the wall, the slot. On a dark page
// the coin is bright silver; on a light page it is pale, and its seams and marks are drawn in ink.
function paletteFor([r, g, b]: [number, number, number]): Palette {
  const dark = r + g + b < 384
  const hot: Tones = { face: blue(0.64), ring: blue(0.64), rim: blue(0.71), rimLit: blue(0.8), rimShade: blue(0.58), rimSide: blue(0.52), seam: blue(0.5), mark: blue(0.97), relief: blue(0.97), reliefSide: blue(0.48), edgeLit: blue(0.95), edgeShade: blue(0.5) }
  const hotWalls: Walls = { ridge: [0.38, 0.43, 0.48, 0.53, 0.58].map(blue), valley: [0.345, 0.39, 0.435, 0.48, 0.525].map(blue) }
  if (dark) return {
    cold: { face: steel(0.76), ring: steel(0.64), rim: steel(0.7), rimLit: steel(0.82), rimShade: steel(0.56), rimSide: steel(0.5), seam: steel(0.46), mark: steel(0.86), relief: steel(0.95), reliefSide: steel(0.47), edgeLit: steel(0.98), edgeShade: steel(0.5) },
    hot, hotWalls,
    coldWalls: { ridge: [0.31, 0.35, 0.39, 0.43, 0.47].map(steel), valley: [0.275, 0.315, 0.355, 0.395, 0.435].map(steel) },
    slot: { ridge: [0.2, 0.22, 0.245, 0.27, 0.295].map(steel), valley: [0.2, 0.22, 0.245, 0.27, 0.295].map(steel) },
    shadow: 'rgb(0, 0, 0)',
  }
  return {
    cold: { face: steel(0.94), ring: steel(0.885), rim: steel(0.915), rimLit: steel(0.975), rimShade: steel(0.845), rimSide: steel(0.79), seam: steel(0.64), mark: steel(0.54), relief: steel(1), reliefSide: steel(0.55), edgeLit: steel(0.74), edgeShade: steel(0.6) },
    hot, hotWalls,
    coldWalls: { ridge: [0.66, 0.7, 0.74, 0.78, 0.82].map(steel), valley: [0.625, 0.665, 0.705, 0.745, 0.785].map(steel) },
    slot: { ridge: [0.46, 0.49, 0.52, 0.55, 0.58].map(steel), valley: [0.46, 0.49, 0.52, 0.55, 0.58].map(steel) },
    shadow: `rgb(${Math.round(r * 0.92)}, ${Math.round(g * 0.92)}, ${Math.round(b * 0.92)})`,
  }
}
// Which of a wall's five tones: how far its normal faces the light.
const wallTone = (x: number, y: number, z: number) => clamp(Math.floor((x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2] + 1) / 2 * 5), 0, 4)

// The lettering struck on the medallion, as paths in the unit circle: the same for every size of coin.
type Shapes = { numeral: Path2D; letters: Path2D }
let struck: Shapes | undefined
function shapes(): Shapes {
  if (struck) return struck
  const numeral = new Path2D(), letters = new Path2D()

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
  return struck = { numeral, letters }
}

// The face of a coin of radius R px as the camera sees it, on a sheet at device resolution, in the tones of one
// metal. Surfaces are filled in the unit circle; lines are stroked in px, so that each is as wide as the next
// whichever way it runs. `plain` draws a chevron on each slice in place of an envelope.
function paintFace(c: CanvasRenderingContext2D, k: Tones, R: number, dpr: number, plain: boolean) {
  const { numeral, letters } = shapes()
  const unit = () => c.setTransform(R * dpr, 0, 0, R * COS * dpr, (R + 1) * dpr, (R * COS + 1) * dpr)
  const flood = (fill: string) => { c.fillStyle = fill; c.fillRect(-1.1, -1.1, 2.2, 2.2) }
  const disc = (r: number, down = 0) => { const path = new Path2D(); path.arc(0, down, r, 0, TAU); return path }
  const moved = (shape: Path2D, x: number, y: number) => { const path = new Path2D(); path.addPath(shape, { e: x, f: y }); return path }
  // A height in px as a distance down the sheet, in the unit circle.
  const high = (px: number) => px / (R * COS)

  // The sheet is flooded past the coin's outline: each piece is clipped to its own outline when it is drawn.
  unit()
  flood(k.rim)
  // The rim's bevel: lighter where it faces the light, darker where it faces away, each tapering to nothing.
  c.save(); c.clip(disc(1)); flood(k.rimLit); c.clip(moved(disc(1), AWAY_X * 0.03, AWAY_Y * 0.03)); flood(k.rimShade); c.clip(moved(disc(1), -AWAY_X * 0.03, -AWAY_Y * 0.03)); flood(k.rim); c.restore()
  // The ring lies a step below the rim: on the far side the step's side shows.
  c.save(); c.clip(disc(RIM_IN)); flood(k.rimSide); c.clip(disc(RIM_IN, high(RIM_HIGH))); flood(k.ring); c.restore()
  c.fillStyle = k.face; c.fill(disc(INNER))
  // What is struck on the medallion stands up from it: its side shows straight below its top.
  const raised = (shape: Path2D, px: number) => {
    c.fillStyle = k.reliefSide
    for (let step = 1; step <= 3; step++) c.fill(moved(shape, 0, high(px * step / 3)))
    c.fillStyle = k.relief; c.fill(shape)
  }
  raised(letters, LEG_HIGH)
  raised(numeral, NUM_HIGH)

  // Lines, in px from the coin's centre, on whole device pixels where they run level or upright.
  c.setTransform(dpr, 0, 0, dpr, (R + 1) * dpr, (R * COS + 1) * dpr)
  const crisp = (v: number) => (Math.round(v * dpr - dpr % 2 / 2) + dpr % 2 / 2) / dpr
  c.lineWidth = 1; c.lineJoin = 'round'; c.lineCap = 'butt'
  // The seams: between slice and slice, and round the medallion.
  c.strokeStyle = k.seam
  c.beginPath()
  for (let index = 0; index < SLICES; index++) {
    const a = PHASE + (index + 0.5) * STEP
    c.moveTo(Math.cos(a) * INNER * R, Math.sin(a) * INNER * R * COS); c.lineTo(Math.cos(a) * R, Math.sin(a) * R * COS)
  }
  c.moveTo(INNER * R, 0); c.ellipse(0, 0, INNER * R, INNER * R * COS, 0, 0, TAU)
  c.stroke()
  // The mark on each slice, the right way up wherever its slice lies: an envelope, or the chevron of its flap.
  c.strokeStyle = k.mark
  c.beginPath()
  for (let index = 0; index < SLICES; index++) {
    const a = PHASE + index * STEP, w = Math.round(ENV_W * R), h = Math.round(ENV_H * R * COS)
    const left = crisp(Math.cos(a) * ENV_R * R - w / 2), top = crisp(Math.sin(a) * ENV_R * R * COS - h / 2)
    if (!plain) c.rect(left, top, w, h)
    c.moveTo(left, top); c.lineTo(left + w / 2, top + (plain ? h * 0.8 : h * ENV_FLAP)); c.lineTo(left + w, top)
  }
  c.stroke()
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
  // counted: the count has gone round. eager: the pointer is on Sign in.
  let raf = 0, dead = false, start = 0, last = performance.now()
  let counted = reduced, hover = -1, busyAt = 0, eager = false
  const slices: Slice[] = Array.from({ length: SLICES }, () => ({ out: 0, outVel: 0, lift: 0, liftVel: 0, wanted: false }))
  const angle = (index: number) => PHASE + index * STEP
  // A slice's place in the count: it starts with the slice after the one that points at Sign in and ends on that one.
  const place = (index: number) => mod(index - base - 1, SLICES)
  const snap = (value: number) => Math.round(value * dpr) / dpr
  // A point of the coin's top, r px from its centre at angle t, on a piece moved by (dx, dy) px.
  const at = (r: number, t: number, dx = 0, dy = 0): [number, number] => [cx + dx + Math.cos(t) * r, cy + dy + Math.sin(t) * r * COS]

  // A colour token as numbers. The tokens used are plain sRGB colours, which every browser computes to rgb(r, g, b).
  function color(name: string): [number, number, number] {
    probe.style.color = `var(${name})`
    const [r = 0, g = 0, b = 0] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
    return [r, g, b]
  }

  function face(k: Tones) {
    const sheet = document.createElement('canvas')
    sheet.width = Math.ceil((2 * R + 2) * dpr); sheet.height = Math.ceil((2 * R * COS + 2) * dpr)
    paintFace(sheet.getContext('2d')!, k, R, dpr, R < PLAIN_PX)
    return sheet
  }
  const sheet = (image: HTMLCanvasElement, dx = 0, dy = 0) => ctx.drawImage(image, cx + dx - R - 1, cy + dy - R * COS - 1, image.width / dpr, image.height / dpr)

  function layout() {
    const page = canvas.getBoundingClientRect(), box = slot.getBoundingClientRect(), to = target.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 3)
    width = page.width; height = page.height
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    R = box.width / 2
    cx = snap(box.left - page.left + R); cy = snap(box.top - page.top + R * COS)
    // The slice nearest the line from the coin's centre to Sign in. Where the button is straight below the coin, the
    // slice would come out end-on to the camera: one a little to the right shows its top and its side.
    let towards = Math.atan2((to.top + to.height / 2 - page.top - cy) / COS, to.left + to.width / 2 - page.left - cx)
    if (Math.abs(towards - Math.PI / 2) < 0.42) towards = Math.PI / 2 - 0.46
    const aim = mod(Math.round((towards - PHASE) / STEP), SLICES)
    if (aim !== base) { if (slices[base].wanted) { slices[base].wanted = false; slices[aim].wanted = true }; base = aim }
    // Tilted by a with its far side up, the coin's far rim stands 2R (sin a sin TILT − (1 − cos a) cos TILT) above
    // where it lies: the first tilt is the steepest that stays inside the stage.
    const room = Math.max(0, box.top - (slot.parentElement?.getBoundingClientRect().top ?? box.top))
    const rise = (a: number) => 2 * R * (Math.sin(a) * SIN - (1 - Math.cos(a)) * COS)
    tilt0 = TILT_MAX
    for (let low = TILT_MIN, high = TILT_MAX, n = 0; rise(TILT_MAX) > room && n < 12; n++) { const middle = (low + high) / 2; if (rise(middle) > room) high = middle; else low = middle; tilt0 = low }
    palette = paletteFor(color('--color-deep'))
    if (R > 0) { cold = face(palette.cold); hot = face(palette.hot) }
  }

  // A piece of wall under the edge from (x0, y0) to (x1, y1), as deep as (tx, ty), in one of the five tones of a
  // reed's ridge or of the valley beside it. heat is how far it has taken the brand's blue.
  const wall = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number, walls: Walls, ridge: boolean, tone: number, heat = 0) => {
    for (const from of heat < 1 ? heat > 0 ? [walls, palette.hotWalls] : [walls] : [palette.hotWalls]) {
      ctx.globalAlpha = from === palette.hotWalls && heat < 1 ? heat : 1
      ctx.fillStyle = (ridge ? from.ridge : from.valley)[tone]
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 + tx, y1 + ty); ctx.lineTo(x0 + tx, y0 + ty); ctx.closePath(); ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  // The line along the rim's top edge over one slice's width, where that edge is lit or shaded: one colour each,
  // so that it runs unbroken from slice to slice. `trace` draws the edge between two angles.
  const edgeLine = (index: number, k: Tones, trace: (from: number, to: number) => void) => {
    const a = mod(angle(index), TAU)
    const tone = a >= LIT_FROM && a <= LIT_TO ? k.edgeLit : a >= SHADE_FROM || a + TAU <= SHADE_TO ? k.edgeShade : ''
    if (!tone) return
    ctx.strokeStyle = tone; ctx.lineWidth = 1.5
    ctx.beginPath(); trace(a - STEP / 2, a + STEP / 2); ctx.stroke()
  }

  // The whole coin, tilted by alpha towards azimuth phi and turned by psi about its own axis, with its lowest rim
  // point on the table. `down` is how nearly it lies flat: its shadow comes with that.
  function drawSolid(alpha: number, phi: number, psi: number, down: number) {
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
    // Its shadow on the table, under where it will lie.
    ctx.globalAlpha = down
    ctx.fillStyle = palette.shadow
    ctx.beginPath(); ctx.ellipse(cx + SHADE_X, cy + T * SIN + SHADE_Y, R, R * COS, 0, 0, TAU); ctx.fill()
    ctx.globalAlpha = 1
    for (let index = 0; index < SLICES; index++) for (let k = 0; k < REED.length - 1; k++) {
      const t0 = angle(index) - STEP / 2 + REED[k] * STEP, t1 = angle(index) - STEP / 2 + REED[k + 1] * STEP, tm = (t0 + t1) / 2
      const nx = Math.cos(tm) * e1[0] + Math.sin(tm) * e2[0], ny = Math.cos(tm) * e1[1] + Math.sin(tm) * e2[1], nz = Math.cos(tm) * e1[2] + Math.sin(tm) * e2[2]
      if (ny * SIN + nz * COS <= 0) continue
      wall(originX + Math.cos(t0) * ax + Math.sin(t0) * bx, originY + Math.cos(t0) * ay + Math.sin(t0) * by, originX + Math.cos(t1) * ax + Math.sin(t1) * bx, originY + Math.cos(t1) * ay + Math.sin(t1) * by, tx, ty, palette.coldWalls, k % 2 > 0, wallTone(nx, ny, nz))
    }
    ctx.save()
    ctx.transform(ax / R, ay / R, bx / (R * COS), by / (R * COS), originX, originY)
    ctx.save()
    ctx.beginPath(); ctx.ellipse(0, 0, R, R * COS, 0, 0, TAU); ctx.clip()
    ctx.drawImage(cold, -R - 1, -R * COS - 1, cold.width / dpr, cold.height / dpr)
    ctx.restore()
    for (let index = 0; index < SLICES; index++) edgeLine(index, palette.cold, (from, to) => ctx.ellipse(0, 0, R - 0.75, (R - 0.75) * COS, 0, from, to))
    ctx.restore()
  }

  // A slice's sector of the ring as a path, moved by (dx, dy) px.
  function sector(index: number, dx: number, dy: number) {
    const a0 = angle(index) - STEP / 2
    ctx.beginPath()
    for (let k = 0; k <= 4; k++) ctx.lineTo(...at(R, a0 + STEP * k / 4, dx, dy))
    for (let k = 4; k >= 0; k--) ctx.lineTo(...at(INNER * R, a0 + STEP * k / 4, dx, dy))
    ctx.closePath()
  }

  // One slice, slid `off` radii along its own direction; heat is how far it has taken the brand's blue. The wall of
  // a seam is drawn where the slice beside it has moved (before, after).
  function drawSlice(index: number, off: number, heat: number, before: boolean, after: boolean) {
    const a = angle(index), half = STEP / 2, drop = THICK * R * SIN, out = off > 0.002
    const dx = snap(Math.cos(a) * off * R), dy = snap(Math.sin(a) * off * R * COS)
    // In place, a slice's top overlaps its neighbours' and the medallion's by a hair.
    const more = out ? 0 : SEAM_PX, inner = INNER * R - more, wide = (r: number) => half + Math.asin(more / r)
    const rim = REED.map(part => at(R, a - wide(R) + 2 * wide(R) * part, dx, dy))
    const bore = [0, 0.5, 1].map(part => at(inner, a - wide(inner) + 2 * wide(inner) * part, dx, dy))
    const edge = REED.map(part => a - half + STEP * part)
    // Walls that face the camera: its inner end, the two seams, then its piece of the reeded edge. A wall that
    // looks into the slot a slice has left is the slot's.
    const cut = out ? palette.coldWalls : palette.slot
    if (-Math.sin(a) > 0.02) for (let k = 0; k < 2; k++) wall(bore[k][0], bore[k][1], bore[k + 1][0], bore[k + 1][1], 0, drop, cut, false, wallTone(-Math.cos(a), -Math.sin(a), 0), heat)
    if (before && -Math.cos(a - half) > 0.001) wall(bore[0][0], bore[0][1], rim[0][0], rim[0][1], 0, drop, cut, false, wallTone(Math.sin(a - half), -Math.cos(a - half), 0), heat)
    if (after && Math.cos(a + half) > 0.001) wall(rim[7][0], rim[7][1], bore[2][0], bore[2][1], 0, drop, cut, false, wallTone(-Math.sin(a + half), Math.cos(a + half), 0), heat)
    for (let k = 0; k < edge.length - 1; k++) {
      const tm = (edge[k] + edge[k + 1]) / 2
      if (Math.sin(tm) > 0) wall(...at(R, edge[k], dx, dy), ...at(R, edge[k + 1], dx, dy), 0, drop, palette.coldWalls, k % 2 > 0, wallTone(Math.cos(tm), Math.sin(tm), 0), heat)
    }
    ctx.save()
    ctx.beginPath()
    for (const [x, y] of bore) ctx.lineTo(x, y)
    for (let k = rim.length - 1; k >= 0; k--) ctx.lineTo(rim[k][0], rim[k][1])
    ctx.closePath(); ctx.clip()
    if (heat < 1) sheet(cold, dx, dy)
    if (heat > 0) { ctx.globalAlpha = heat; sheet(hot, dx, dy); ctx.globalAlpha = 1 }
    ctx.restore()
    edgeLine(index, heat > 0.5 ? palette.hot : palette.cold, (from, to) => ctx.ellipse(cx + dx, cy + dy, R - 0.75, (R - 0.75) * COS, 0, from, to))
  }

  // The medallion the slices stand round. Its wall shows where a slice in front of it has gone.
  function drawMedallion() {
    const drop = THICK * R * SIN, half = STEP / 2
    for (let index = 0; index < SLICES; index++) {
      const a = angle(index)
      if (Math.sin(a) > 0) wall(...at(INNER * R, a - half), ...at(INNER * R, a + half), 0, drop, palette.slot, false, wallTone(Math.cos(a), Math.sin(a), 0))
    }
    ctx.save()
    ctx.beginPath(); ctx.ellipse(cx, cy, INNER * R + SEAM_PX, (INNER * R + SEAM_PX) * COS, 0, 0, TAU); ctx.clip()
    sheet(cold)
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
      // The tilt dies away as the point the rim rests on circles faster; rolling without slipping turns the face
      // slowly against the wobble, and it ends upright.
      drawSolid(tilt0 * left ** 0.9, -Math.PI / 2 + TAU * TURNS * (1 - left ** 0.55), -TAU * TURNS * (1 - Math.cos(tilt0)) * 0.5 * left ** 1.5, (1 - left) ** 2)
      raf = requestAnimationFrame(frame)
      return
    }
    // The count: each slice is lit in turn, and the last, the one that points at Sign in, stays lit and slides out.
    const count = (t - SPIN - HOLD) / TICK
    if (!counted) {
      moving = true
      if (count >= SLICES - 1) slices[base].wanted = true
      if (count >= SLICES - 1 + LIT / TICK) counted = true
    }
    const lit = (index: number) => !counted && count >= place(index) && count < place(index) + LIT / TICK
      || busyAt > 0 && mod(Math.floor((now - busyAt) / BUSY_TICK) - place(index), SLICES) < LIT / BUSY_TICK
    if (busyAt) moving = true
    const pose = slices.map(() => ({ off: 0, heat: 0 }))
    for (let index = 0; index < SLICES; index++) {
      const slice = slices[index], p = pose[index]
      // Springs, stepped in 4 ms slices so a long frame can't throw them: each runs a little past and settles.
      const outTo = slice.wanted ? 1 + (eager && index === base ? EAGER / PULL : 0) : 0, liftTo = index === hover && !slice.wanted ? LIFT : 0
      if (reduced) { slice.out = outTo; slice.outVel = 0 }
      for (let step = dt; step > 0; step -= 4) {
        const h = Math.min(4, step) / 1000
        slice.outVel += (170 * (outTo - slice.out) - 17 * slice.outVel) * h; slice.out += slice.outVel * h
        slice.liftVel += (520 * (liftTo - slice.lift) - 30 * slice.liftVel) * h; slice.lift += slice.liftVel * h
      }
      if (Math.abs(outTo - slice.out) < 0.0005 && Math.abs(slice.outVel) < 0.005) { slice.out = outTo; slice.outVel = 0 } else moving = true
      if (Math.abs(liftTo - slice.lift) < 0.0004 && Math.abs(slice.liftVel) < 0.004) { slice.lift = liftTo; slice.liftVel = 0 } else moving = true
      p.off = Math.max(0, PULL * slice.out + slice.lift)
      p.heat = slice.wanted || lit(index) ? 1 : clamp(Math.max(slice.out * 3, slice.lift / LIFT * 1.5))
    }
    // The shadow on the table, under the coin and under each slice that has slid out of it.
    const drop = THICK * R * SIN
    ctx.fillStyle = palette.shadow
    ctx.beginPath(); ctx.ellipse(cx + SHADE_X, cy + drop + SHADE_Y, R, R * COS, 0, 0, TAU); ctx.fill()
    for (let index = 0; index < SLICES; index++) if (pose[index].off > 0.002) {
      sector(index, Math.cos(angle(index)) * pose[index].off * R + SHADE_X, Math.sin(angle(index)) * pose[index].off * R * COS + drop + SHADE_Y)
      ctx.fill()
    }
    // Far slices, the medallion, near slices. A slice only ever moves along its own direction, so it stays over its
    // own sector of the table, and of two sectors the one that points more towards the camera is in front.
    const depth = (index: number) => Math.sin(angle(index))
    const apart = (index: number, side: number) => Math.abs(pose[mod(index + side, SLICES)].off - pose[index].off) > 0.002
    const order = slices.map((_, index) => index).sort((a, b) => depth(a) - depth(b))
    const piece = (index: number) => drawSlice(index, pose[index].off, pose[index].heat, apart(index, -1), apart(index, 1))
    for (const index of order) if (depth(index) <= 0) piece(index)
    drawMedallion()
    for (const index of order) if (depth(index) > 0) piece(index)
    if (moving) raf = requestAnimationFrame(frame)
  }

  const kick = () => { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(frame) } }

  // The slice under a pointer, or −1: where it lies now, slid out or in the coin.
  function sliceAt(event: PointerEvent) {
    const page = canvas.getBoundingClientRect()
    const x = (event.clientX - page.left - cx) / R, y = (event.clientY - page.top - cy) / (R * COS)
    // Whether the point lies on a slice that has slid `off` radii out.
    const on = (index: number, off: number) => {
      const a = angle(index), px = x - Math.cos(a) * off, py = y - Math.sin(a) * off, r = Math.hypot(px, py)
      return r > INNER - 0.01 && r < 1.02 && Math.abs(mod(Math.atan2(py, px) - a + Math.PI, TAU) - Math.PI) < STEP / 2 + 0.012
    }
    for (let index = 0; index < SLICES; index++) if (slices[index].out > 0.5 && on(index, PULL * slices[index].out)) return index
    const index = mod(Math.round((Math.atan2(y, x) - PHASE) / STEP), SLICES)
    return slices[index].out > 0.5 || !on(index, 0) ? -1 : index
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || !counted) return
    const index = sliceAt(event)
    if (index !== hover) { hover = index; kick() }
  }
  const onLeave = () => { if (hover >= 0) { hover = -1; kick() } }
  // Pressed, a slice slides out, or back in if it was out.
  const onDown = (event: PointerEvent) => {
    const index = event.button === 0 && counted ? sliceAt(event) : -1
    if (index < 0) return
    slices[index].wanted = !slices[index].wanted
    kick()
  }

  const redraw = () => { layout(); kick() }
  const resize = new ResizeObserver(redraw)
  resize.observe(canvas); resize.observe(slot); resize.observe(target)
  // The theme toggle swaps the page's colours: the coin is struck again in the metal for them.
  const theme = new MutationObserver(redraw)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const stage = canvas.parentElement!
  if (!reduced) {
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerleave', onLeave)
    stage.addEventListener('pointerdown', onDown)
  }
  layout()
  if (reduced) { slices[base].wanted = true; slices[base].out = 1 }
  // The first frame is drawn at once, so that the page's first paint has the coin on it.
  frame(performance.now())

  return {
    // Sign-in has started: the count goes round the coin until the page goes.
    setBusy(busy) {
      if (reduced || !!busyAt === busy) return
      busyAt = busy ? performance.now() : 0
      kick()
    },
    // The pointer is on Sign in: the slice that points at it moves towards it.
    setEager(on) {
      if (reduced || eager === on) return
      eager = on
      kick()
    },
    destroy() {
      dead = true
      cancelAnimationFrame(raf)
      resize.disconnect(); theme.disconnect()
      stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerleave', onLeave); stage.removeEventListener('pointerdown', onDown)
      probe.remove()
    },
  }
}
