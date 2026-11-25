// The design rules for stylesheets, as Stylelint rules (nightmail/<rule>). Each report's message is
// "<selector> { <what was found> } ⟶ <what to use instead>"; the rule's reason is in design-lint.config.ts.
import stylelint from 'stylelint'
import type { Context } from './index.ts'
import { bare, colorAdvice, lengths, nearest, primary, rawColors, scale } from './values.ts'

type Node = { type: string; parent?: Node; selector?: string; name?: string }
type Decl = Node & { prop: string; value: string }
type Root = Node & { source?: { input?: { file?: string } }; walkDecls(fn: (decl: Decl) => void): void }
type Result = Parameters<typeof stylelint.utils.report>[0]['result']

export const SEPARATOR = ' ⟶ '
const focus = /:focus(?:-visible|-within)?(?![\w-])/
const state = /:(?:hover|focus|focus-visible|focus-within|active|checked)(?![\w-])|\[(?:aria-(?:selected|pressed|expanded|current|checked)|data-state|data-selected|data-active|open)|\.active\b/

/** The selector a declaration sits under ('@font-face' and the like for an at-rule's own declarations). */
const selectorOf = (node: Node): string => {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'rule') return at.selector ?? ''
    if (at.type === 'atrule' && !['media', 'supports', 'container', 'layer'].includes(at.name ?? '')) return '@' + at.name
  }
  return ''
}

/** Split at top level (outside parentheses and brackets). */
function splitTop(text: string, at: (c: string) => boolean): string[] {
  const parts: string[] = []
  let depth = 0, current = ''
  for (const c of text) {
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (depth === 0 && at(c)) { if (current.trim()) parts.push(current.trim()); current = ''; continue }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
const selectors = (list: string) => splitTop(list, c => c === ',')
/** The compound a selector styles: its last one (`.a > .b:hover` → `.b:hover`). */
const subject = (selector: string) => splitTop(selector.replace(/\s*([>+~])\s*/g, ' '), c => /\s/.test(c)).at(-1) ?? ''
const vars = (value: string) => [...primary(value).matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]!)
const plain = (value: string) => value.replace(/\s*!important\s*$/i, '').trim()

type Shadow = { computed: boolean; clear: boolean; x: number; y: number; blur: number; spread: number; text: string }
/** Each shadow in a box-shadow: offsets, blur and spread in px when written as numbers. */
function shadows(value: string): Shadow[] {
  return splitTop(bare(primary(value)), c => c === ',').map(text => {
    const parts = splitTop(text, c => /\s/.test(c)), numbers = parts.filter(p => /^-?\d*\.?\d+(px)?$/.test(p)).map(parseFloat)
    return {
      computed: parts.some(p => /^(calc|min|max|clamp)\(/.test(p) || /^var\(--(space|focus)/.test(p)),
      clear: parts.includes('transparent') || /var\(--color-transparent\)/.test(text),
      x: numbers[0] ?? 0, y: numbers[1] ?? 0, blur: numbers[2] ?? 0, spread: numbers[3] ?? 0, text,
    }
  })
}
/** A shadow that draws a line: no blur, and a thin spread (a ring) or a thin offset (a hairline under or beside). */
const isLine = (s: Shadow) => !s.computed && !s.clear && s.blur === 0 && ((s.x === 0 && s.y === 0 && s.spread > 0 && s.spread <= 3) || (s.spread === 0 && (s.x !== 0 || s.y !== 0) && Math.abs(s.x) <= 2 && Math.abs(s.y) <= 2))
/** On a focused element any ring or glow counts: no offset and a spread up to 4px, or a blur. */
const isRing = (s: Shadow) => !s.computed && !s.clear && s.x === 0 && s.y === 0 && ((s.spread > 0 && s.spread <= 4) || s.blur > 0)

/** Every rule as a Stylelint plugin, closed over the shared context (tokens and allowlists). */
export function cssPlugins(ctx: Context) {
  const space = scale(ctx.tokens, '--space-'), radius = scale(ctx.tokens, '--radius-'), text = scale(ctx.tokens, '--text-')
  const rules = ctx.config.rules
  const plugin = (id: keyof typeof rules, check: (decl: Decl, selector: string, emit: (found: string, use?: string, word?: string) => void) => void) => {
    const ruleName = `nightmail/${id}`
    const rule = (() => (root: Root, result: Result) => {
      const file = root.source?.input?.file ?? ''
      root.walkDecls(decl => {
        const selector = selectorOf(decl)
        if (ctx.allowed(id, file, selector)) return
        const where = selector.replace(/\s+/g, ' ').length > 72 ? selector.replace(/\s+/g, ' ').slice(0, 71) + '…' : selector.replace(/\s+/g, ' ')
        check(decl, selector, (found, use = rules[id].use, word) => stylelint.utils.report({ ruleName, result, node: decl as never, message: `${where} { ${found} }${SEPARATOR}${use}`, word: word ?? decl.prop }))
      })
    }) as unknown as stylelint.Rule
    rule.ruleName = ruleName
    rule.messages = stylelint.utils.ruleMessages(ruleName, {})
    return stylelint.createPlugin(ruleName, rule)
  }
  const shown = (decl: Decl) => `${decl.prop}: ${decl.value}`
  const cutout = (value: string) => vars(value).some(v => rules.borderless.cutoutColors.includes(v))
  const invisible = (value: string) => /^(0|0px|none|hidden|transparent|initial|unset|inherit|0 none|none 0)$/i.test(plain(value)) || /^0(px)? (solid|none)/.test(plain(value)) || /var\(--color-transparent\)$/.test(plain(value))
  const borderProp = /^border(-(top|right|bottom|left|block|inline))?(-(start|end))?(-(width|style|color|image))?$/
  const outlineProp = /^outline(-(width|style|color))?$/
  const tokenNames = new Set([...ctx.tokens.light.keys(), ...ctx.tokens.dark.keys()])

  return [
    plugin('borderless', (decl, selector, emit) => {
      if (focus.test(selector)) return
      if ((borderProp.test(decl.prop) || outlineProp.test(decl.prop)) && !invisible(decl.value) && !cutout(decl.value)) emit(shown(decl))
      if (decl.prop === 'box-shadow' && shadows(decl.value).some(s => isLine(s) && !cutout(s.text))) emit(shown(decl), 'Remove the ring: a picked or selected state is a solid fill (var(--color-active-bg), or var(--color-contrast) on a picked control), never a line drawn by a shadow.')
    }),
    plugin('no-focus-ring', (decl, selector, emit) => {
      if (!focus.test(selector)) return
      const field = /input|textarea|select|field|search/i.test(selector), link = /(^|[\s>(,])a(?![\w-])|link/.test(selector)
      const use = field ? "background: var(--color-control-focus) (a field's focus step, as .ui-input:focus in ui.css)."
        : link ? "color: var(--color-text); text-decoration: underline (a link's focus cue)."
        : 'background: var(--color-hover) on a row, menu item or ghost button; var(--color-control-focus) on a control.'
      if ((outlineProp.test(decl.prop) || borderProp.test(decl.prop)) && !invisible(decl.value)) emit(shown(decl), use)
      if (decl.prop === 'box-shadow' && shadows(decl.value).some(s => isRing(s) || isLine(s))) emit(shown(decl), use)
    }),
    plugin('one-surface-step', (decl, selector, emit) => {
      if (decl.prop !== 'background' && decl.prop !== 'background-color') return
      const conf = rules['one-surface-step'], deeper = vars(decl.value).find(v => conf.deeperTokens.includes(v))
      if (!deeper) return
      emit(shown(decl), /border|edge/.test(deeper) ? `${deeper} is a line's colour, not a fill. ${conf.use}`
        : state.test(selector) ? `A state takes the scope's var(--color-hover), var(--color-active-bg) or var(--color-pressed) (or the control's var(--color-control-hover)), which follow the surface it is on; ${deeper} is a second step everywhere.`
        : `${deeper} is a second step off the canvas. ${conf.use}`, deeper)
    }),
    plugin('token-color', (decl, selector, emit) => {
      // A scope may set a token again (the composer's email sheet keeps the light theme's values in either theme).
      if (tokenNames.has(decl.prop) || /^(-webkit-)?mask|^content$|^font-family$|^(transition|animation|will-change|grid-template-areas)/.test(decl.prop)) return
      const dark = /data-theme=['"]?dark/.test(selector)
      for (const color of rawColors(decl.value)) emit(`${decl.prop}: ${color}`, colorAdvice(ctx.tokens, color, decl.prop, rules['token-color'].use, dark), color)
    }),
    plugin('token-space', (decl, _selector, emit) => {
      if (!rules['token-space'].properties.includes(decl.prop)) return
      for (const l of lengths(decl.value)) if (['px', 'rem', 'em'].includes(l.unit) && l.px !== 0)
        emit(`${decl.prop}: ${l.text}`, l.unit === 'em' ? 'var(--space-N) from the scale (4, 6, 8, 12, 16, 20, 24, 28, 32, 40).' : Math.abs(l.px) < 4 && !space.some(s => s.px === Math.abs(l.px)) ? `No step is ${l.text}: align with line-height or the element's height (an icon in a box of its line's height) instead of a nudge; var(--space-2) is only a track's inset or the split between two filled rows.` : nearest(space, l.px), l.text)
    }),
    plugin('token-radius', (decl, _selector, emit) => {
      if (!/^border(-[a-z]+)*-radius$/.test(decl.prop)) return
      for (const l of lengths(decl.value)) if (['px', 'rem', 'em'].includes(l.unit) && l.px !== 0 && l.px < 999) emit(`${decl.prop}: ${l.text}`, nearest(radius, l.px), l.text)
    }),
    plugin('token-font-size', (decl, _selector, emit) => {
      if (decl.prop !== 'font-size') return
      const v = plain(decl.value)
      if (/^(inherit|initial|unset|100%|1em)$/.test(v) || /^var\(--text-[\w-]+\)$/.test(v)) return
      const px = lengths(v).find(l => l.unit === 'px' || l.unit === 'rem')
      emit(shown(decl), px ? nearest(text, px.px) : rules['token-font-size'].use)
    }),
    plugin('font-family', (decl, _selector, emit) => {
      if (decl.prop !== 'font-family') return
      const v = plain(decl.value)
      if (/^(inherit|initial|unset)$/.test(v) || /^var\(--font-(body|mono|email)\)$/.test(v)) return
      emit(shown(decl), /OpenTUI|mono/i.test(v) ? 'var(--font-mono)' : /Inter/.test(v) ? 'var(--font-body)' : rules['font-family'].use)
    }),
    plugin('lucide-icons', (decl, _selector, emit) => {
      if (/url\(\s*["']?data:image\/svg\+xml/i.test(decl.value)) emit(`${decl.prop}: url("data:image/svg+xml,…")`, 'Render the glyph as an element: <Icon icon={ChevronDown} size="sm" /> from lucide-react (components/ui/icon.tsx), not an SVG drawn in CSS.')
    }),
    plugin('page-full-width', (decl, selector, emit) => {
      if (decl.prop !== 'max-width' && decl.prop !== 'max-inline-size') return
      const cap = Math.max(-1, ...lengths(decl.value).filter(l => l.unit === 'px' || l.unit === 'rem').map(l => l.px))
      if (cap < rules['page-full-width'].minCapPx) return
      if (selectors(selector).every(one => rules['page-full-width'].notContainers.test(subject(one)))) return
      emit(shown(decl))
    }),
    plugin('no-label-truncation', (decl, _selector, emit) => {
      if ((decl.prop === 'text-overflow' && !/^(clip|unset|initial)$/.test(plain(decl.value))) || (/^(-webkit-)?line-clamp$/.test(decl.prop) && !/^(none|unset|initial)$/.test(plain(decl.value)))) emit(shown(decl))
    }),
  ]
}
