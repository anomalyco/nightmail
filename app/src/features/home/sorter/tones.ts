// The sorter's materials. Each is four flat tones of one colour, by how a surface faces the light: lit from above, the
// front, grazing, and shade (which is also what a cast shadow is). `floor` is the page itself, the dark the slab stands in. Night: one hue (268°, the brand's) at low chroma and
// its opposite, a warm paper white, for letters and whatever is lit; red only where something burns. Day is the same
// machine in pale enamel on a pale floor, its sorting frame still dark so the letters in it stay paper.
// A row is [lit, front, grazing, shade] lightness, chroma, hue, alpha (OKLCH); night first, then day.
type Row = [number, number, number, number, number, number, number]
const flat = (l: number, c: number, h: number, a = 1): Row => [l, l, l, l, c, h, a]
const TABLE = {
  floor:   [flat(.158, .014, 268), flat(.948, .01, 262)],
  slab:    [[.228, .192, .184, .178, .017, 268, 1], [.99, .905, .9, .928, .008, 262, 1]],
  body:    [[.365, .272, .242, .214, .018, 268, 1], [.985, .905, .86, .805, .008, 262, 1]],
  plinth:  [[.3, .212, .19, .168, .016, 268, 1], [.955, .868, .825, .775, .012, 262, 1]],
  wall:    [[.365, .272, .242, .214, .018, 268, 1], [.66, .565, .52, .46, .03, 262, 1]],
  trim:    [[.48, .375, .325, .28, .02, 268, 1], [.995, .945, .82, .73, .008, 262, 1]],
  steel:   [[.66, .52, .43, .34, .018, 268, 1], [.9, .75, .64, .54, .016, 262, 1]],
  dark:    [[.205, .14, .124, .106, .014, 268, 1], [.5, .4, .36, .31, .03, 262, 1]],
  bay:     [[.25, .185, .165, .15, .015, 268, 1], [.6, .5, .45, .4, .03, 262, 1]],
  rubber:  [[.27, .2, .178, .155, .014, 268, 1], [.46, .36, .32, .28, .025, 262, 1]],
  cell:    [flat(.328, .021, 268), flat(.505, .034, 262)],
  cell2:   [flat(.312, .02, 268), flat(.524, .033, 262)],
  paper:   [[.968, .955, .9, .8, .014, 92, 1], [.995, .985, .93, .84, .01, 92, 1]],
  dim:     [[.8, .76, .7, .62, .014, 92, 1], [.9, .86, .8, .72, .01, 92, 1]],
  ink:     [flat(.34, .03, 268), flat(.38, .03, 262)],
  brand:   [[.72, .638, .56, .47, .075, 269, 1], [.7, .6, .52, .44, .085, 269, 1]],
  red:     [flat(.64, .21, 27), flat(.6, .22, 27)],
  redzone: [[.62, .56, .5, .44, .17, 27, 1], [.66, .6, .54, .48, .19, 27, 1]],
  ember:   [flat(.78, .17, 58), flat(.74, .18, 55)],
  char:    [flat(.2, .025, 55), flat(.24, .03, 55)],
  glass:   [flat(.9, .02, 268, .055), flat(.3, .03, 262, .05)],
  sheen:   [flat(.95, .015, 268, .085), flat(1, 0, 0, .2)],
  pane:    [flat(.86, .02, 268, .22), flat(.55, .03, 262, .3)],
  crack:   [flat(.96, .01, 268, .5), flat(1, 0, 0, .85)],
  tube:    [[.95, .82, .62, .46, .02, 268, .2], [.4, .5, .34, .26, .03, 262, .2]],
  lampOff: [[.4, .32, .28, .25, .018, 268, 1], [.78, .7, .64, .58, .014, 262, 1]],
  lampOn:  [flat(.95, .06, 92), flat(.97, .1, 92)],
  dial:    [[.95, .925, .87, .8, .012, 92, 1], [.995, .975, .93, .85, .008, 92, 1]],
  slot:    [flat(.105, .014, 268), flat(.3, .03, 262)],
  screen:  [flat(.118, .016, 268), flat(.24, .03, 262)],
  line:    [flat(.2, .016, 268), flat(.8, .012, 262)],
  wallLine:[flat(.2, .016, 268), flat(.44, .03, 262)],
  smoke:   [flat(.36, .012, 268), flat(.7, .008, 262)],
  steam:   [flat(.82, .008, 268), flat(.99, .004, 262)],
  scorch:  [flat(.1, .012, 268, .7), flat(.35, .02, 262, .5)],
} as const
export type Mat = keyof typeof TABLE
export const MAT = Object.fromEntries(Object.keys(TABLE).map((name, index) => [name, index])) as Record<Mat, number>

/** OKLCH to 8-bit sRGB, clipped. */
export function oklch(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180)
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3, m = (L - .1055613458 * a - .0638541728 * b) ** 3, s = (L - .0894841775 * a - 1.291485548 * b) ** 3
  const gamma = (x: number) => Math.round(255 * Math.min(1, Math.max(0, x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055)))
  return [gamma(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s), gamma(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s), gamma(-.0041960863 * l - .7034186147 * m + 1.707614701 * s)]
}
/** One tone of a material as the page writes it: rgb(r g b). */
export function tone(mat: Mat, index: 0 | 1 | 2 | 3, dark: boolean) {
  const row = TABLE[mat][dark ? 0 : 1], [r, g, b] = oklch(row[index], row[4], row[5])
  return `rgb(${r} ${g} ${b})`
}
/** Every material's four tones, a row each, for the renderer. */
export function paletteBytes(dark: boolean, rows: number) {
  const bytes = new Uint8Array(rows * 16)
  Object.values(TABLE).forEach((pair, index) => {
    const row = pair[dark ? 0 : 1]
    for (let t = 0; t < 4; t++) { const [r, g, b] = oklch(row[t], row[4], row[5]); bytes.set([r, g, b, Math.round(row[6] * 255)], index * 16 + t * 4) }
  })
  return bytes
}
/** A glass tube over the page, as the page draws it below the machine: the renderer draws a tube's far wall (in
 * shade) and then its near wall (in the tone its facing gives), each at the tube's alpha, over what is behind. */
function glass(index: 0 | 1 | 2 | 3, dark: boolean) {
  const t = TABLE.tube[dark ? 0 : 1], f = TABLE.floor[dark ? 0 : 1], near = oklch(t[index], t[4], t[5]), far = oklch(t[3], t[4], t[5]), under = oklch(f[0], f[4], f[5]), a = t[6]
  return `rgb(${near.map((v, i) => Math.round(v * a + (far[i] * a + under[i] * (1 - a)) * (1 - a))).join(' ')})`
}
/** The machine's tones for the page's own boxes below it (variant-sorter.css reads them as --srt-*). */
export function toneVars(dark: boolean): Record<string, string> {
  return {
    '--srt-floor': tone('floor', 0, dark), '--srt-body': tone('body', 1, dark), '--srt-body-top': tone('body', 0, dark), '--srt-body-side': tone('body', 3, dark), '--srt-plinth': tone('plinth', 1, dark), '--srt-trim': tone('trim', 1, dark),
    '--srt-steel': tone('steel', 1, dark), '--srt-steel-top': tone('steel', 0, dark), '--srt-screen': tone('screen', 1, dark), '--srt-lamp-off': tone('lampOff', 1, dark),
    '--srt-tube-0': glass(0, dark), '--srt-tube-1': glass(1, dark), '--srt-tube-2': glass(2, dark), '--srt-tube-3': glass(3, dark),
  }
}
