// The coin of the "nmc" homepage study: a one-cent piece lying on a table, on one canvas. Its outer ring is fifty
// slices round a medallion that carries the denomination: fifty emails to the cent, which is the price
// (RATES.emailUc in api/src/billing/money.ts is $0.0002). The coin settles the way a dropped coin does; as it comes
// to rest the slice that points at Sign in takes the brand's blue where it lies and is thrown out towards the
// button, and the coin recoils: one email, with its envelope on it. A slice slides out a little under the pointer,
// and is thrown out or back in when it is pressed.
//
// It is drawn flat, as a solid seen from above and in front: every surface has one tone of its own (the field, the
// ring raised round it, the two bands of the edge, the slot a slice leaves), and what stands up from a surface shows
// its top and, straight below it, its side.

const TAU = Math.PI * 2
const SLICES = 50
const STEP = TAU / SLICES
// The camera looks down at the table from 46° off vertical. A cent is 1.52 mm thick and 19.05 mm across.
const TILT = 46 * Math.PI / 180, COS = Math.cos(TILT), SIN = Math.sin(TILT)
const THICK = 0.16
/** Height of the coin's box over its width: the top face's ellipse and the edge that shows below it. */
export const COIN_ASPECT = COS + THICK * SIN / 2

// Lengths below are in coin radii unless they say px or ms.
const INNER = 0.66      // where the slices end and the medallion begins
const SEAM_PX = 0.45    // pieces drawn one by one overlap by this much, so that the page never shows between them
const PHASE = STEP / 4  // the slices are turned a quarter step, so no seam lies on the coin's vertical or horizontal
const PULL = 0.53       // how far a slice is thrown: its near end lands 0.19 beyond the rim
// A slice at least this far out, and on the table, overlaps nothing of the coin on the page.
const CLEAR = 1 - INNER + THICK * SIN / COS + 0.008
const HOP = 0.085       // how high a slice is thrown on its way
const KICK = 0.5        // the speed, in radii a second, at which the coin starts back when it throws a slice
const EAGER = 0.05      // how much nearer the button its slice goes while the pointer is on Sign in
const LIFT = 0.07       // how far a slice under the pointer slides out
// A slice's piece of the reeded edge: where each valley and ridge begins, as fractions of its rim (three reeds).
const REED = [0, 1 / 15, 4 / 15, 6 / 15, 9 / 15, 11 / 15, 14 / 15, 1]

// The intro, in ms: the coin drops DROP_PX onto the table and settles in SPIN. Over the last TINT of that the slice
// that points at Sign in takes the brand's blue where it lies, and as the coin comes to lie still it is thrown.
const SPIN = 640, FALL = 170, DROP_PX = 20, TINT = 120
// A throw takes FLIGHT from the slot to rest: in the air for LAND of that time and GLIDE of the way, then along the
// table a little past its place and back to it.
const FLIGHT = 520, LAND = 0.6, GLIDE = 0.86
// While sign-in starts a light goes round the ring, a slice every BUSY_TICK.
const BUSY_TICK = 22
// A coin dropped on a table rolls round on its rim: the tilt dies away while the point it rests on circles faster
// and faster (Euler's disk; Moffatt, Nature 404, 2000). Here the tilt falls almost evenly, so that every frame shows
// it lower than the last. The far rim first stands highest half a turn in, when the tilt is down to FAR of what it
// began at; the first tilt is as steep as the room above the coin allows for that.
const TILT_MAX = 24 * Math.PI / 180, TILT_MIN = 7 * Math.PI / 180, TURNS = 2.5, FAR = (1 - 0.5 / TURNS) ** (0.9 / 0.55)

// The light comes from the upper left: a cut face's tone is one of five, by how far it faces LIGHT (x to the right,
// y towards the camera, z up). The edge is a plain band, LIP of the coin's thickness, over a reeded one, each the
// same all the way round.
const LIGHT: [number, number, number] = [-0.86, 0.42, 0.29]
const LIP = 0.3
// The shadow on the table is a contact shadow: what lies on it, a few px down and to the right.
const SHADE_X = 2, SHADE_Y = 5

// The face, in a unit circle with y down: the ring of fifty slices, raised like a coin's rim round a field that
// lies FIELD_DEEP below it and carries the legend and the denomination. In the brand's blue each slice has its
// envelope, ENV_W along the slice and ENV_H across it. Heights are in px: how far a side shows below its top.
const FIELD_DEEP = 2.5
const ENV_R = (INNER + 1) / 2, ENV_W = 0.19, ENV_H = 0.074, ENV_FLAP = 0.56, ENV_HIGH = 1.5
const LEG_R = 0.552, LEG_CAP = 0.083, LEG_TRACK = 0.14, LEG_SPACE = 0.36, LEG_HIGH = 1.25
const NUM_CAP = 0.415, NUM_HIGH = 2.5
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
// The tones of one face: the field, the ring and the side of the step between them; a seam between slices and the
// envelope on each ('' for none); the tops of what is struck on the field and of its legend, and their side; the
// line round the top edge.
type Tones = { face: string; ring: string; step: string; seam: string; mark: string; relief: string; legend: string; reliefSide: string; edge: string }
// A wall's tones: the plain band under the top edge, a reed's ridge and the valley beside it, and for a cut face
// five, darkest first.
type Walls = { lip: string; ridge: string; valley: string; cut: string[] }
type Band = keyof Walls
// cold is the coin's metal and hot the brand's blue, for a slice under the light or one that has left. slot is the
// wall of the slot a slice leaves. shadow lies on the table under whatever stands on it.
type Palette = { cold: Tones; hot: Tones; coldWalls: Walls; hotWalls: Walls; slot: Walls; shadow: string }
// out: how far through its throw, 0 in the coin to 1 at rest outside it. lift: slid out a little under the pointer.
// wanted: whether it is to be out.
type Slice = { out: number; lift: number; liftVel: number; wanted: boolean }

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
// The coin is a few steps of the page's own ground, graphite on a dark page and silver on a light one: the ring, a
// field a little lighter, an edge in two bands under them (its reeds a small step apart, so that they stay even
// where they are a pixel or two wide), and seams half a step under the ring. What is struck on
// it is in the page's text colour, with a side between that and the field, so the denomination is the brightest
// thing on it. Only a slice in the brand's blue has its envelope.
function paletteFor([r, g, b]: [number, number, number]): Palette {
  const dark = r + g + b < 384
  const hot: Tones = { face: blue(0.64), ring: blue(0.64), step: blue(0.52), seam: blue(0.58), mark: blue(0.985), relief: blue(0.97), legend: blue(0.97), reliefSide: blue(0.8), edge: blue(0.8) }
  const hotWalls: Walls = { lip: blue(0.57), ridge: blue(0.49), valley: blue(0.455), cut: [0.35, 0.39, 0.43, 0.47, 0.51].map(blue) }
  if (dark) return {
    cold: { face: steel(0.4), ring: steel(0.33), step: steel(0.25), seam: steel(0.293), mark: '', relief: steel(0.95), legend: steel(0.82), reliefSide: steel(0.62), edge: steel(0.6) },
    hot, hotWalls,
    coldWalls: { lip: steel(0.285), ridge: steel(0.225), valley: steel(0.195), cut: [0.15, 0.165, 0.18, 0.195, 0.21].map(steel) },
    slot: { lip: steel(0.1), ridge: steel(0.1), valley: steel(0.1), cut: [0.085, 0.092, 0.1, 0.108, 0.116].map(steel) },
    shadow: 'rgb(0, 0, 0)',
  }
  return {
    cold: { face: steel(0.9), ring: steel(0.84), step: steel(0.74), seam: steel(0.79), mark: '', relief: steel(0.2), legend: steel(0.34), reliefSide: steel(0.5), edge: steel(0.74) },
    hot, hotWalls,
    coldWalls: { lip: steel(0.77), ridge: steel(0.68), valley: steel(0.65), cut: [0.55, 0.59, 0.63, 0.67, 0.71].map(steel) },
    slot: { lip: steel(0.46), ridge: steel(0.46), valley: steel(0.46), cut: [0.4, 0.43, 0.46, 0.49, 0.52].map(steel) },
    shadow: `rgb(${Math.round(r * 0.92)}, ${Math.round(g * 0.92)}, ${Math.round(b * 0.92)})`,
  }
}
// Which of a cut face's five tones: how far its normal faces the light.
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
// metal. Everything on it lies on its surface: it is drawn in the unit circle and takes the camera's foreshortening,
// lettering and envelopes alike.
function paintFace(c: CanvasRenderingContext2D, k: Tones, R: number, dpr: number) {
  const { numeral, letters } = shapes()
  const unit = () => c.setTransform(R * dpr, 0, 0, R * COS * dpr, (R + 1) * dpr, (R * COS + 1) * dpr)
  const flood = (fill: string) => { c.fillStyle = fill; c.fillRect(-1.1, -1.1, 2.2, 2.2) }
  const disc = (r: number, down = 0) => { const path = new Path2D(); path.arc(0, down, r, 0, TAU); return path }
  const moved = (shape: Path2D, x: number, y: number) => { const path = new Path2D(); path.addPath(shape, { e: x, f: y }); return path }
  // A height in px as a distance down the sheet, in the unit circle.
  const high = (px: number) => px / (R * COS)

  // The sheet is flooded with the ring's tone past the coin's outline: each piece is clipped to its own outline when
  // it is drawn. The field lies a step below the ring: under the ring's far side, the side of the step shows.
  unit()
  flood(k.ring)
  c.save(); c.clip(disc(INNER)); flood(k.step); c.clip(disc(INNER, high(FIELD_DEEP))); flood(k.face); c.restore()
  // What stands up from a surface: its side shows straight below its top.
  const raised = (shape: Path2D, px: number, top: string) => {
    c.fillStyle = k.reliefSide
    for (let step = 1; step <= 3; step++) c.fill(moved(shape, 0, high(px * step / 3)))
    c.fillStyle = top; c.fill(shape)
  }
  raised(letters, LEG_HIGH, k.legend)
  raised(numeral, NUM_HIGH, k.relief)

  // The seams, between slice and slice and round the field.
  c.lineWidth = 1 / R; c.lineJoin = 'round'; c.lineCap = 'butt'
  c.strokeStyle = k.seam
  c.beginPath()
  for (let index = 0; index < SLICES; index++) { const a = PHASE + (index + 0.5) * STEP; c.moveTo(Math.cos(a) * INNER, Math.sin(a) * INNER); c.lineTo(Math.cos(a), Math.sin(a)) }
  c.moveTo(INNER, 0); c.arc(0, 0, INNER, 0, TAU)
  c.stroke()
  if (!k.mark) return
  // In a metal that has one, the envelope on each slice: a sheet that lies along its slice and stands up from it as
  // the lettering does, with the fold of its flap cut into it on the side that is uppermost on the page.
  const sheets = new Path2D(), folds = new Path2D()
  for (let index = 0; index < SLICES; index++) {
    const a = PHASE + index * STEP, ox = Math.cos(a), oy = Math.sin(a), top = ox > 0 ? -1 : 1
    // across runs along the slice, up across it from the envelope's foot to its flap's fold.
    const at = (across: number, up: number): [number, number] => [(ENV_R + across) * ox - top * up * oy, (ENV_R + across) * oy + top * up * ox]
    const w = ENV_W / 2, h = ENV_H / 2
    sheets.moveTo(...at(-w, h)); sheets.lineTo(...at(w, h)); sheets.lineTo(...at(w, -h)); sheets.lineTo(...at(-w, -h)); sheets.closePath()
    folds.moveTo(...at(-w, h)); folds.lineTo(...at(0, h - 2 * h * ENV_FLAP)); folds.lineTo(...at(w, h))
  }
  raised(sheets, ENV_HIGH, k.mark)
  c.save(); c.clip(sheets)
  c.strokeStyle = k.ring; c.lineWidth = 1.3 / R
  c.stroke(folds)
  c.restore()
}

export type Coin = { setBusy: (busy: boolean) => void; setEager: (eager: boolean) => void; destroy: () => void }

/**
 * The coin lies where `slot` is, on a canvas that covers the page; the slice that is thrown out points at `target`.
 * `onLand` is called once, when the intro's slice comes down on the table.
 */
export function mountCoin(canvas: HTMLCanvasElement, slot: HTMLElement, target: HTMLElement, { reduced, onLand }: { reduced: boolean; onLand?: () => void }): Coin {
  const ctx = canvas.getContext('2d')!
  const probe = document.createElement('span')
  probe.style.display = 'none'
  slot.appendChild(probe)

  // base is the slice that points at Sign in and reach how far it goes. The stage runs from `above` to `below`.
  let dpr = 1, width = 0, height = 0, R = 0, cx = 0, cy = 0, above = 0, below = 0, base = 0, reach = PULL, tilt0 = TILT_MIN
  let palette!: Palette, cold!: HTMLCanvasElement, hot!: HTMLCanvasElement
  // start is the time of the intro's first frame that could be seen: a page opened in a background tab plays it when
  // it is first looked at. made is what the last layout was made for.
  // ready: the intro's slice has been thrown, and landed: it has come down. eager: the pointer is on Sign in, and
  // creep how far that has drawn the slice that points at it. (kickX, kickY) is how far, in px, the coin is from its
  // place after throwing a slice.
  let raf = 0, dead = false, start = 0, last = performance.now(), made = ''
  let ready = reduced, landed = reduced, hover = -1, busyAt = 0, eager = false, creep = 0, creepVel = 0
  let kickX = 0, kickY = 0, kickVelX = 0, kickVelY = 0
  const slices: Slice[] = Array.from({ length: SLICES }, () => ({ out: 0, lift: 0, liftVel: 0, wanted: false }))
  // Where each slice is drawn: `off` radii along its own direction and `rise` px off the table. heat is how far it
  // has taken the brand's blue, and glow how far its top has, under the light.
  const pose = slices.map(() => ({ off: 0, rise: 0, heat: 0, glow: 0 }))
  const angle = (index: number) => PHASE + index * STEP
  // A slice's place round the ring from the one that points at Sign in: 0 for the slice after it, 49 for itself.
  const place = (index: number) => mod(index - base - 1, SLICES)
  const snap = (value: number) => Math.round(value * dpr) / dpr
  // A point of the coin's top, r px from its centre at angle t, on a piece moved by (dx, dy) px.
  const at = (r: number, t: number, dx = 0, dy = 0): [number, number] => [cx + dx + Math.cos(t) * r, cy + dy + Math.sin(t) * r * COS]
  // From the back: the far slices, the medallion, the near slices. A slice only ever moves along its own direction,
  // so it stays over its own sector of the table, and of two sectors the one that points more towards the camera is
  // in front.
  const MEDALLION = -1
  const depth = (index: number) => Math.sin(angle(index))
  const order = slices.map((_, index) => index).sort((a, b) => depth(a) - depth(b))
  const back = [...order.filter(index => depth(index) <= 0), MEDALLION, ...order.filter(index => depth(index) > 0)]
  const moved = (index: number) => pose[index].off > 0.002 || pose[index].rise > 0.5
  const clear = (index: number) => pose[index].off >= CLEAR && pose[index].rise <= 0.5
  const apart = (index: number, side: number) => { const beside = pose[mod(index + side, SLICES)]; return Math.abs(beside.off - pose[index].off) > 0.002 || Math.abs(beside.rise - pose[index].rise) > 0.5 }

  // A colour token as numbers. The tokens used are plain sRGB colours, which every browser computes to rgb(r, g, b).
  function color(name: string): [number, number, number] {
    probe.style.color = `var(${name})`
    const [r = 0, g = 0, b = 0] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
    return [r, g, b]
  }

  function face(k: Tones) {
    const sheet = document.createElement('canvas')
    sheet.width = Math.ceil((2 * R + 2) * dpr); sheet.height = Math.ceil((2 * R * COS + 2) * dpr)
    paintFace(sheet.getContext('2d')!, k, R, dpr)
    return sheet
  }
  const sheet = (image: HTMLCanvasElement, dx = 0, dy = 0) => ctx.drawImage(image, cx + dx - R - 1, cy + dy - R * COS - 1, image.width / dpr, image.height / dpr)

  // Lays the scene out for the page as it is now. False if nothing it depends on has changed: the canvas is left as
  // it is then, since sizing a canvas clears it.
  function layout() {
    const page = canvas.getBoundingClientRect(), box = slot.getBoundingClientRect(), to = target.getBoundingClientRect(), style = getComputedStyle(slot)
    const around = slot.parentElement?.getBoundingClientRect() ?? box, room = Math.max(0, box.top - around.top)
    const aimSet = parseFloat(style.getPropertyValue('--nmc-aim')), reachSet = parseFloat(style.getPropertyValue('--nmc-reach')), deep = color('--color-deep')
    const now = [window.devicePixelRatio, page.width, page.height, box.left - page.left, box.top - page.top, box.width, to.left - page.left, to.top - page.top, to.width, to.height, room, aimSet, reachSet, deep].join()
    if (now === made) return false
    made = now
    dpr = Math.min(window.devicePixelRatio || 1, 3)
    width = page.width; height = page.height; above = around.top - page.top; below = around.bottom - page.top
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    R = box.width / 2
    cx = snap(box.left - page.left + R); cy = snap(box.top - page.top + R * COS)
    // The slice nearest the line from the coin's centre to Sign in, or nearest --nmc-aim (degrees clockwise from 3
    // o'clock) where the page sets it: with the button straight below the coin, a slice aimed at it would come out
    // end-on to the camera and hang off the coin's front. It is thrown --nmc-reach radii where the page sets that.
    const towards = Number.isFinite(aimSet) ? aimSet * Math.PI / 180 : Math.atan2((to.top + to.height / 2 - page.top - cy) / COS, to.left + to.width / 2 - page.left - cx)
    const aim = mod(Math.round((towards - PHASE) / STEP), SLICES)
    if (aim !== base) { if (slices[base].wanted) { slices[base].wanted = false; slices[aim].wanted = true }; base = aim }
    reach = Number.isFinite(reachSet) ? reachSet : PULL
    // Tilted by a with its far side up, the coin's far rim stands 2R (sin a sin TILT − (1 − cos a) cos TILT) above
    // where it lies: the first tilt is the steepest that keeps it 12px inside the stage when it first comes up.
    const rise = (a: number) => 2 * R * (Math.sin(a * FAR) * SIN - (1 - Math.cos(a * FAR)) * COS) + 12
    tilt0 = TILT_MAX
    for (let low = TILT_MIN, high = TILT_MAX, n = 0; rise(TILT_MAX) > room && n < 12; n++) { const middle = (low + high) / 2; if (rise(middle) > room) high = middle; else low = middle; tilt0 = low }
    palette = paletteFor(deep)
    if (R > 0) { cold = face(palette.cold); hot = face(palette.hot) }
    return true
  }

  // A piece of wall under the edge from (x0, y0) to (x1, y1), as deep as (tx, ty): one of the edge's bands, or a
  // cut face in one of its five tones. heat is how far it has taken the brand's blue.
  const wall = (x0: number, y0: number, x1: number, y1: number, tx: number, ty: number, walls: Walls, band: Band, tone: number, heat = 0) => {
    for (const from of heat < 1 ? heat > 0 ? [walls, palette.hotWalls] : [walls] : [palette.hotWalls]) {
      ctx.globalAlpha = from === palette.hotWalls && heat < 1 ? heat : 1
      ctx.fillStyle = band === 'cut' ? from.cut[tone] : from[band]
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 + tx, y1 + ty); ctx.lineTo(x0 + tx, y0 + ty); ctx.closePath(); ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // The line round the top edge, about (x, y): one tone and one stroke, less the sectors of the slices in `less`,
  // so that it has no joints and, with every slice in place, no ends.
  const rim = (k: Tones, x: number, y: number, less: number[]) => {
    const r = R - 0.75, out = [...less].sort((a, b) => a - b)
    ctx.strokeStyle = k.edge; ctx.lineWidth = 1.5
    ctx.beginPath()
    if (!out.length) { ctx.ellipse(x, y, r, r * COS, 0, 0, TAU); ctx.closePath() }
    // From each slice that is left out round to the next one: an arc over the slices between them.
    else out.forEach((index, n) => {
      const from = angle(index) + STEP / 2, to = angle(out[(n + 1) % out.length]) - STEP / 2 + (n + 1 < out.length ? 0 : TAU)
      if (to - from > 1e-6) { ctx.moveTo(x + Math.cos(from) * r, y + Math.sin(from) * r * COS); ctx.ellipse(x, y, r, r * COS, 0, from, to) }
    })
    ctx.stroke()
  }
  // One slice's piece of it.
  const rimOf = (index: number, k: Tones, x: number, y: number) => {
    ctx.strokeStyle = k.edge; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(x, y, R - 0.75, (R - 0.75) * COS, 0, angle(index) - STEP / 2, angle(index) + STEP / 2); ctx.stroke()
  }

  // Adds a slice's sector of the ring to the path: moved by (dx, dy) px, from `inner` to `outer` px from the centre,
  // and `more` px wider on each side.
  const trace = (index: number, dx = 0, dy = 0, inner = INNER * R, outer = R, more = 0) => {
    const a = angle(index), wide = (r: number) => STEP / 2 + Math.asin(more / r)
    ctx.moveTo(...at(outer, a - wide(outer), dx, dy))
    for (let k = 1; k <= 6; k++) ctx.lineTo(...at(outer, a - wide(outer) + 2 * wide(outer) * k / 6, dx, dy))
    for (let k = 4; k >= 0; k--) ctx.lineTo(...at(inner, a - wide(inner) + 2 * wide(inner) * k / 4, dx, dy))
    ctx.closePath()
  }

  // The whole coin, tilted by alpha towards azimuth phi and turned by psi about its own axis, with its lowest rim
  // point `air` px over the table. `down` is how nearly it lies flat: its shadow comes with that. `glow` is how far
  // the top of the slice `lit` has taken the brand's blue.
  function drawSolid(alpha: number, phi: number, psi: number, air: number, down: number, lit: number, glow: number) {
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
    const originX = cx + ox, originY = cy + T * SIN + oy - air
    const [ax, ay] = project(e1[0] * R, e1[1] * R, e1[2] * R), [bx, by] = project(e2[0] * R, e2[1] * R, e2[2] * R)
    const [tx, ty] = project(-T * n[0], -T * n[1], -T * n[2])
    // Its shadow on the table, under where it will lie.
    ctx.globalAlpha = down
    ctx.fillStyle = palette.shadow
    ctx.beginPath(); ctx.ellipse(cx + SHADE_X, cy + T * SIN + SHADE_Y, R, R * COS, 0, 0, TAU); ctx.fill()
    ctx.globalAlpha = 1
    // The edge where it faces the camera: the reeds, then the plain band over them.
    const piece = (t0: number, t1: number, deep: number, band: Band) => {
      const tm = (t0 + t1) / 2
      const ny = Math.cos(tm) * e1[1] + Math.sin(tm) * e2[1], nz = Math.cos(tm) * e1[2] + Math.sin(tm) * e2[2]
      if (ny * SIN + nz * COS > 0) wall(originX + Math.cos(t0) * ax + Math.sin(t0) * bx, originY + Math.cos(t0) * ay + Math.sin(t0) * by, originX + Math.cos(t1) * ax + Math.sin(t1) * bx, originY + Math.cos(t1) * ay + Math.sin(t1) * by, tx * deep, ty * deep, palette.coldWalls, band, 0)
    }
    for (let index = 0; index < SLICES; index++) for (let k = 0; k < REED.length - 1; k++) piece(angle(index) - STEP / 2 + REED[k] * STEP, angle(index) - STEP / 2 + REED[k + 1] * STEP, 1, k % 2 ? 'ridge' : 'valley')
    for (let index = 0; index < SLICES; index++) for (let k = 0; k < 2; k++) piece(angle(index) + (k - 1) * STEP / 2 - 0.004, angle(index) + k * STEP / 2 + 0.004, LIP, 'lip')
    ctx.save()
    ctx.transform(ax / R, ay / R, bx / (R * COS), by / (R * COS), originX, originY)
    ctx.save()
    ctx.beginPath(); ctx.ellipse(0, 0, R, R * COS, 0, 0, TAU); ctx.clip()
    ctx.drawImage(cold, -R - 1, -R * COS - 1, cold.width / dpr, cold.height / dpr)
    ctx.restore()
    if (glow > 0) {
      ctx.save()
      ctx.beginPath(); trace(lit, -cx, -cy); ctx.clip()
      ctx.globalAlpha = glow
      ctx.drawImage(hot, -R - 1, -R * COS - 1, hot.width / dpr, hot.height / dpr)
      ctx.restore()
    }
    rim(palette.cold, 0, 0, [])
    if (glow > 0.5) rimOf(lit, palette.hot, 0, 0)
    ctx.restore()
  }

  // The walls of a slice that face the camera, hanging from its top where that lies (dx, dy) px from its place: its
  // inner end if it is out, the seams where the slice beside it is elsewhere (before, after), and its piece of the
  // edge, reeds under a plain band. heat is how far it has taken the brand's blue.
  function walls(index: number, dx: number, dy: number, out: boolean, heat: number, before: boolean, after: boolean) {
    const a = angle(index), half = STEP / 2, drop = THICK * R * SIN, inner = INNER * R
    // A wall that looks into the slot a slice has left is the slot's.
    const cut = out ? palette.coldWalls : palette.slot
    if (out && -Math.sin(a) > 0.02) wall(...at(inner, a - half, dx, dy), ...at(inner, a + half, dx, dy), 0, drop, cut, 'cut', wallTone(-Math.cos(a), -Math.sin(a), 0), heat)
    if (before && -Math.cos(a - half) > 0.001) wall(...at(inner, a - half, dx, dy), ...at(R, a - half, dx, dy), 0, drop, cut, 'cut', wallTone(Math.sin(a - half), -Math.cos(a - half), 0), heat)
    if (after && Math.cos(a + half) > 0.001) wall(...at(R, a + half, dx, dy), ...at(inner, a + half, dx, dy), 0, drop, cut, 'cut', wallTone(-Math.sin(a + half), Math.cos(a + half), 0), heat)
    if (Math.sin(a - half) <= 0 && Math.sin(a + half) <= 0) return
    // A slice in its place overlaps the next by a hair, and has one piece in the valley's tone under its reeds, so
    // that nothing shows between piece and piece.
    const more = out ? 0 : 0.004
    if (!out) wall(...at(R, a - half - more), ...at(R, a + half + more), 0, drop, palette.coldWalls, 'valley', 0)
    for (let k = 0; k < REED.length - 1; k++) {
      const t0 = a - half + STEP * REED[k], t1 = a - half + STEP * REED[k + 1], tm = (t0 + t1) / 2
      if (Math.sin(tm) > 0) wall(...at(R, t0, dx, dy), ...at(R, t1, dx, dy), 0, drop, palette.coldWalls, k % 2 ? 'ridge' : 'valley', 0, heat)
    }
    for (let k = 0; k < 2; k++) {
      const t0 = a + (k - 1) * half - more, t1 = a + k * half + more
      if (Math.sin((t0 + t1) / 2) > 0) wall(...at(R, t0, dx, dy), ...at(R, t1, dx, dy), 0, drop * LIP, palette.coldWalls, 'lip', 0, heat)
    }
  }

  // One slice that is out of its place: its walls, its top and its piece of the rim's edge.
  function whole(index: number) {
    const p = pose[index], a = angle(index)
    // A slice that is out is not carried along when the coin starts back.
    const dx = snap(Math.cos(a) * p.off * R) - kickX, dy = snap(Math.sin(a) * p.off * R * COS - p.rise) - kickY
    walls(index, dx, dy, true, p.heat, apart(index, -1), apart(index, 1))
    ctx.save()
    ctx.beginPath(); trace(index, dx, dy); ctx.clip()
    if (p.glow < 1) sheet(cold, dx, dy)
    if (p.glow > 0) { ctx.globalAlpha = p.glow; sheet(hot, dx, dy); ctx.globalAlpha = 1 }
    ctx.restore()
    rimOf(index, p.glow > 0.5 ? palette.hot : palette.cold, cx + dx, cy + dy)
  }

  // Pieces in their places, drawn as one: their walls, then a single cut of the face for all their tops and one
  // stroke for the line round the edge, so that no joint shows from piece to piece. `gone` are the slices out of
  // their places. With `all`, nothing lies between the pieces in place, and the cut is the coin's own outline less
  // the sectors of those slices.
  function inPlace(run: number[], all: boolean, gone: number[]) {
    const drop = THICK * R * SIN, inner = INNER * R
    for (const index of run) {
      if (index !== MEDALLION) walls(index, 0, 0, false, 0, apart(index, -1), apart(index, 1))
      // The wall under the field shows where a slice in front of it has gone.
      else for (const out of gone) if (depth(out) > 0) wall(...at(inner, angle(out) - STEP / 2), ...at(inner, angle(out) + STEP / 2), 0, drop, palette.slot, 'cut', wallTone(Math.cos(angle(out)), Math.sin(angle(out)), 0))
    }
    ctx.save()
    ctx.beginPath()
    if (all) {
      ctx.ellipse(cx, cy, R, R * COS, 0, 0, TAU); ctx.clip()
      if (gone.length) { ctx.beginPath(); ctx.rect(0, 0, width, height); for (const index of gone) trace(index, 0, 0, inner, R + 4); ctx.clip('evenodd') }
    } else {
      for (const index of run) {
        if (index !== MEDALLION) trace(index, 0, 0, inner - SEAM_PX, R, SEAM_PX)
        else { ctx.moveTo(cx + inner + SEAM_PX, cy); ctx.ellipse(cx, cy, inner + SEAM_PX, (inner + SEAM_PX) * COS, 0, 0, TAU); ctx.closePath() }
      }
      ctx.clip()
    }
    sheet(cold)
    ctx.restore()
    rim(palette.cold, cx, cy, all ? gone : order.filter(index => !run.includes(index)))
    // A slice in its place under the light.
    for (const index of run) if (index !== MEDALLION && pose[index].glow > 0) {
      ctx.save()
      ctx.beginPath(); trace(index); ctx.clip()
      ctx.globalAlpha = pose[index].glow; sheet(hot); ctx.globalAlpha = 1
      ctx.restore()
      if (pose[index].glow > 0.5) rimOf(index, palette.hot, cx, cy)
    }
  }

  function frame(now: number) {
    raf = 0
    if (!start && document.visibilityState !== 'hidden') start = now
    const dt = Math.min(48, now - last), t = start ? now - start : 0
    last = now
    let moving = false
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!R) return
    // While sign-in starts a light goes round the ring, a slice at a time: head is its place.
    const head = busyAt ? mod(Math.floor((now - busyAt) / BUSY_TICK), SLICES) : -1
    if (!reduced && t < SPIN) {
      const left = 1 - t / SPIN
      // It falls the last of its drop, then the tilt dies away as the point the rim rests on circles faster; rolling
      // without slipping turns the face slowly against the wobble, and it ends upright. Over the last of that the
      // slice that points at Sign in turns blue.
      const fall = clamp(t / FALL)
      drawSolid(tilt0 * left ** 0.9, -Math.PI / 2 + TAU * TURNS * (1 - left ** 0.55), -TAU * TURNS * (1 - Math.cos(tilt0)) * 0.5 * left ** 1.5, DROP_PX * (1 - fall * fall), fall * (1 - left) ** 2, base, clamp((t - SPIN + TINT) / TINT))
      raf = requestAnimationFrame(frame)
      return
    }
    // As the coin comes to lie still, that slice is thrown.
    if (!ready) { toss(base); ready = true }
    if (busyAt) moving = true
    // The slice that points at Sign in is drawn a little nearer it while the pointer is on the button, and stays
    // there once it is pressed. Springs are stepped in 4 ms slices so that a long frame can't throw them.
    const creepTo = eager || busyAt ? EAGER : 0
    for (let step = dt; step > 0; step -= 4) {
      const h = Math.min(4, step) / 1000
      creepVel += (240 * (creepTo - creep) - 26 * creepVel) * h; creep += creepVel * h
      // The coin comes back to its place from a throw's recoil, a little past it and back.
      kickVelX += (-900 * kickX - 21 * kickVelX) * h; kickX += kickVelX * h
      kickVelY += (-900 * kickY - 21 * kickVelY) * h; kickY += kickVelY * h
    }
    if (Math.abs(creepTo - creep) < 0.0004 && Math.abs(creepVel) < 0.004) { creep = creepTo; creepVel = 0 } else moving = true
    if (Math.hypot(kickX, kickY) < 0.03 && Math.hypot(kickVelX, kickVelY) < 1) kickX = kickY = kickVelX = kickVelY = 0
    else moving = true
    for (let index = 0; index < SLICES; index++) {
      const slice = slices[index], p = pose[index], liftTo = index === hover && !slice.wanted ? LIFT : 0
      // A throw runs at an even pace from the slot to rest, and back the same way.
      slice.out = reduced ? Number(slice.wanted) : clamp(slice.out + (slice.wanted ? dt : -dt) / FLIGHT)
      if (slice.out > 0 && slice.out < 1) moving = true
      for (let step = dt; step > 0; step -= 4) { const h = Math.min(4, step) / 1000; slice.liftVel += (520 * (liftTo - slice.lift) - 30 * slice.liftVel) * h; slice.lift += slice.liftVel * h }
      if (Math.abs(liftTo - slice.lift) < 0.0004 && Math.abs(slice.liftVel) < 0.004) { slice.lift = liftTo; slice.liftVel = 0 } else moving = true
      // In the air it gathers pace out of the slot and covers GLIDE of the way, highest half-way; on the table it
      // runs straight on, a little past its place, and comes back to it.
      const air = clamp(slice.out / LAND), ground = clamp((slice.out - LAND) / (1 - LAND))
      const way = slice.out < LAND ? GLIDE * air ** 1.25 : 1 - (1 - GLIDE) * (1 - ground) ** 2 * Math.cos(1.5 * Math.PI * ground)
      p.off = Math.max(0, (index === base ? reach : PULL) * way + slice.lift + (index === base ? creep * way : 0))
      p.rise = R * HOP * 4 * air * (1 - air)
      if (index === base && !landed && slice.out >= LAND) { landed = true; onLand?.() }
      p.heat = slice.wanted ? 1 : clamp(Math.max(slice.out * 3, slice.lift / LIFT * 1.5))
      p.glow = Math.max(p.heat, place(index) === head ? 1 : 0)
    }
    const drop = THICK * R * SIN, gone = order.filter(moved), restX = cx, restY = cy
    // The coin is drawn where its recoil has it; a slice that is out keeps its own place.
    cx += kickX; cy += kickY
    // The shadow on the table, under the coin and under each slice that is out of it.
    ctx.fillStyle = palette.shadow
    ctx.beginPath(); ctx.ellipse(cx + SHADE_X, cy + drop + SHADE_Y, R, R * COS, 0, 0, TAU); ctx.fill()
    for (const index of gone) {
      ctx.beginPath(); trace(index, Math.cos(angle(index)) * pose[index].off * R + SHADE_X - kickX, Math.sin(angle(index)) * pose[index].off * R * COS + drop + SHADE_Y - kickY)
      ctx.fill()
    }
    // A slice that is clear of the coin is drawn before it if it lies beyond it and after it if it lies in front.
    // The rest goes from the back: runs of pieces in their places, and between them each slice that is on its way.
    for (const index of gone) if (clear(index) && depth(index) <= 0) whole(index)
    if (gone.every(clear)) inPlace(back.filter(index => index === MEDALLION || !moved(index)), true, gone)
    else {
      let run: number[] = []
      for (const index of back) {
        if (index === MEDALLION || !moved(index)) run.push(index)
        else if (!clear(index)) { if (run.length) inPlace(run, false, gone); run = []; whole(index) }
      }
      if (run.length) inPlace(run, false, gone)
    }
    for (const index of gone) if (clear(index) && depth(index) > 0) whole(index)
    cx = restX; cy = restY
    if (moving) raf = requestAnimationFrame(frame)
  }

  // A slice is thrown out of the coin, and the coin starts back the other way.
  const toss = (index: number) => {
    slices[index].wanted = true
    kickVelX -= Math.cos(angle(index)) * KICK * R; kickVelY -= Math.sin(angle(index)) * KICK * R * COS
  }

  const kick = () => { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(frame) } }

  // The slice under a pointer, or −1: where it lies now, out of the coin or in it.
  function sliceAt(event: PointerEvent) {
    const page = canvas.getBoundingClientRect()
    const x = (event.clientX - page.left - cx) / R, y = (event.clientY - page.top - cy) / (R * COS)
    // Whether the point lies on a slice that is `off` radii out.
    const on = (index: number, off: number) => {
      const a = angle(index), px = x - Math.cos(a) * off, py = y - Math.sin(a) * off, r = Math.hypot(px, py)
      return r > INNER - 0.01 && r < 1.02 && Math.abs(mod(Math.atan2(py, px) - a + Math.PI, TAU) - Math.PI) < STEP / 2 + 0.012
    }
    for (let index = 0; index < SLICES; index++) if (slices[index].out > 0.5 && on(index, pose[index].off)) return index
    const index = mod(Math.round((Math.atan2(y, x) - PHASE) / STEP), SLICES)
    return slices[index].out > 0.5 || !on(index, 0) ? -1 : index
  }
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || !ready) return
    const index = sliceAt(event)
    if (index !== hover) { hover = index; kick() }
  }
  const onLeave = () => { if (hover >= 0) { hover = -1; kick() } }
  // Pressed, a slice is thrown out, or back in if it was out. One that would land off the stage, on the header or
  // the caption or past the page's edge, stays where it is.
  const onDown = (event: PointerEvent) => {
    const index = event.button === 0 && ready ? sliceAt(event) : -1
    if (index < 0) return
    const [x, y] = at((1 + PULL) * R + 8, angle(index))
    if (!slices[index].wanted && (x < 0 || x > width || y < above + 8 || y + THICK * R * SIN > below)) return
    if (slices[index].wanted) slices[index].wanted = false
    else toss(index)
    kick()
  }

  // Laid out again, the scene is drawn at once: the page is painted before the next frame's turn comes.
  const redraw = () => { if (layout() && !dead) { cancelAnimationFrame(raf); frame(performance.now()) } }
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
    // Sign-in has started: the light goes round the coin until the page goes.
    setBusy(busy) {
      if (reduced || !!busyAt === busy) return
      busyAt = busy ? performance.now() : 0
      kick()
    },
    // The pointer is on Sign in: the slice that points at it moves nearer, and stays there once it is pressed.
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
