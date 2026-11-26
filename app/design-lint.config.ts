// The dashboard's design rules, checked by scripts/design-lint (bun run design-lint). Each rule says why it exists and
// what to use instead, from tokens.css, ui.css and components/ui; the allowlists below are the exceptions the design
// system itself makes, each with its reason. A rule at level 'report' prints and never fails; set it to 'error' to make
// the pre-merge check (api/scripts/check-premerge.ts) fail on it. Inline, a CSS line can opt out with
// `/* stylelint-disable-next-line nightmail/<rule> -- <reason> */`.

/** Files by glob (relative to app/), a CSS rule by its selector, or both. */
export type Allow = { files?: string[]; selector?: RegExp; reason: string }
export type Level = 'report' | 'error'
export type Rule = { level: Level; title: string; why: string; use: string; allow?: Allow[] }

// Pages outside the console keep a design of their own: tokens.css keeps hairlines (--color-border*) and focus rings
// (--focus-width, --color-focus) for them.
const ignore: Allow[] = [
  { files: ['src/styles/tokens.css'], reason: 'where the tokens are defined' },
  { files: ['src/features/home/**'], reason: 'the public homepage, outside the console: its own rules, rings and colours' },
  { files: ['src/features/home/tv/**'], reason: 'the homepage\'s television, outside the console: a photographed set with its own palette, sizes and edges (it stays when the factory\'s files and the folder-wide entry above go)' },
  { files: ['src/features/pricing/**'], reason: 'the price and compare pages, outside the console: their own rules, rings and colours' },
  { files: ['src/features/legal/**'], reason: 'the legal documents, outside the console: they rule their tables (--color-border)' },
]

// The campaign composer's sheet shows the email as it is delivered: mail clients get the email's own literal styles
// (colours, px, fonts, its divider block), not the dashboard's custom properties.
const email: Allow = { selector: /\.composer-(?:document|static-doc)\b/, reason: 'the email itself, styled as delivered (mail clients get no tokens)' }


const config = {
  include: ['src/**/*.css', 'src/**/*.ts', 'src/**/*.tsx'],
  ignore,
  rules: {
    borderless: {
      level: 'report',
      title: 'No borders or outlines on surfaces',
      why: 'The console is borderless: an area is a solid surface a step off what is under it, a control a solid fill; no hairline, outline or 1px inset shadow draws either (tokens.css, Borderless).',
      use: 'Remove the line. Part areas by a solid step (background: var(--color-layer-1)) or by space (gap: var(--space-12)); show a picked or selected state with a fill (var(--color-active-bg), var(--color-contrast) on a picked control).',
      // A ring in the colour of the surface under it is a cut-out (an unread dot or a face set off from the icon or face
      // beside it), not a line.
      cutoutColors: ['--color-surface', '--color-deep', '--color-canvas', '--color-overlay-surface'],
      allow: [
        email,
        { files: ['src/features/ui-notes/notes.css'], selector: /\.uin-(outline|highlight)\b/, reason: 'UI notes outline the element being noted, on purpose (notes.css)' },
        { selector: /\.cm-cursor\b/, reason: 'CodeMirror draws its text caret as a border' },
      ],
    },
    'no-focus-ring': {
      level: 'error',
      title: 'No focus rings',
      why: 'Keyboard focus never draws a ring, outline or halo: it shows the hover cue as a solid step (ui.css, Focus).',
      use: 'A control: background: var(--color-control-focus). A row, menu item or ghost button: background: var(--color-hover). A text link: color: var(--color-text); text-decoration: underline.',
      allow: [email],
    },
    'one-surface-step': {
      level: 'report',
      title: 'At most one surface step',
      why: 'An area sits on the canvas or one step off it (--color-layer-1 and its aliases: well, card, thead, matte, a tone\'s -bg); a second shade only appears when a panel sits in a panel (tokens.css).',
      use: 'An area: var(--color-layer-1) (or --color-well, --color-card). A control: var(--color-control). A state: the scope\'s var(--color-hover), var(--color-active-bg) or var(--color-pressed). Inside a layer-1 surface, sit on it directly; its controls already take the raised set (app.css).',
      // The steps past the one (and lines' colours used as fills). A background reads only its token, not a var() fallback.
      deeperTokens: ['--color-layer-2', '--color-layer-3', '--color-border-muted', '--color-border', '--color-border-strong', '--color-control-edge'],
      allow: [
        email,
        { selector: /track|[-_]bar\b|progress|meter|skeleton|placeholder|loading|__mark\b|avatar|__face\b|__more\b|thumb|\bimg\b|__icon\b|chip|__pill\b|blank|-label\b|dot\b|::before|::after|switch|file-selector-button|grab|kbd|number\b|ui-tone--neutral/, reason: 'marks, chips, avatars, placeholders and control tracks, sized to their content, not areas' },
      ],
    },
    'token-color': {
      level: 'report',
      title: 'Colours from tokens',
      // A scope that sets a token again (--color-surface: #FFFFFF on the composer's light email sheet) is not checked.
      why: 'Every colour is a solid token from tokens.css, so both themes and every scope (deep, raised, overlay) stay in step; hue appears only as status inks, markers and chart series.',
      use: 'A token for the role (tokens.css): a neutral (--color-text, --color-muted, --color-layer-1, --color-control …), a status ink or marker (--color-danger, --color-success-marker …) or a chart series (--color-series-*).',
      allow: [
        email,
        { files: ['src/components/EmailFrame.tsx', 'src/components/EmailPreview.tsx'], reason: 'the email itself, rendered as delivered' },
      ],
    },
    'token-space': {
      level: 'error',
      title: 'Spacing from tokens',
      why: 'Margins, padding and gaps come from the spacing scale (--space-4 … --space-40, and --space-2 for a track\'s inset or the split between two filled rows), so rhythm stays even across pages.',
      use: 'var(--space-N), or calc(-1 * var(--space-N)) for a negative margin.',
      properties: ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-block-start', 'margin-block-end', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-block-start', 'padding-block-end', 'padding-inline', 'padding-inline-start', 'padding-inline-end', 'gap', 'row-gap', 'column-gap', 'grid-gap'],
      allow: [email],
    },
    'token-radius': {
      level: 'error',
      title: 'Radii from tokens',
      why: 'Corners come from the radius scale (--radius-xs 4, --radius-sm 6, --radius-lg 8; --radius-2xs 2 for marks, --radius-sheet 14 for a phone\'s sheet), so controls and surfaces round alike.',
      use: 'var(--radius-xs | --radius-sm | --radius-md | --radius-lg), var(--radius-2xs) for a mark, var(--radius-sheet) for a sheet; 50% for a dot or a face.',
      allow: [email],
    },
    'token-font-size': {
      level: 'error',
      title: 'Font sizes from tokens',
      why: 'Type has one size per role (--text-label 11 … --text-xl 24, --text-figure 22 and --text-display 26, tokens.css), and a phone steps body and titles up from the same tokens.',
      use: 'var(--text-…) for the role: label, xs, sm, md (body), section, heading, lg, title, xl, figure, display.',
      allow: [email],
    },
    'font-family': {
      level: 'report',
      title: 'Inter and OpenTUI Mono only',
      why: 'The dashboard sets Inter for the interface and OpenTUI Mono for data, through the font tokens and their metric-matched fallbacks.',
      use: 'var(--font-body) (Inter) or var(--font-mono) (OpenTUI Mono); inherit to follow the parent.',
      allow: [email],
    },
    'lucide-icons': {
      level: 'report',
      title: 'Icons from lucide-react',
      why: 'Every glyph is a static Lucide icon on one size and stroke scale (components/ui/icon.tsx); other packs and hand-drawn SVGs draw at other weights.',
      use: 'Import the glyph from lucide-react and render <Icon icon={Glyph} size="md" /> (components/ui/icon.tsx).',
      // An inline <svg> counts as an icon when it is small: a literal square-ish viewBox up to 48 units, or a literal
      // width or height up to 32. Charts and the brand's marks have computed or wide viewBoxes and are not icons.
      maxViewBox: 48,
      maxSize: 32,
      allow: [
        { files: ['src/components/NightmailLogo.tsx', 'src/components/AnomalyLogo.tsx'], reason: 'the brand\'s marks' },
        { files: ['src/styles/ui.css'], selector: /select\.ui-native-select/, reason: 'Lucide\'s chevron-down, drawn in CSS because a native select has no children' },
      ],
    },
    'page-full-width': {
      level: 'report',
      title: 'Pages run full width',
      why: 'Every dashboard page runs the full width of the canvas (Settings, Billing, domain detail, forms); a cap leaves a page in a column with empty space beside it.',
      use: 'Remove the max-width and let the block fill the page. Keep a reading measure on prose itself (max-width in ch on the <p>).',
      // A cap of at least this many px on a block that is not text, a control or an overlay is a page container's cap.
      // Measures in ch or em are text measures and never count.
      minCapPx: 400,
      notContainers: /(^|[\s>+~(,])(p|li|ol|ul|h[1-6]|dd|dt|label|code|pre|summary|blockquote|input|textarea|select)\b|input|field|search|select|chip|trigger|tooltip|popover|menu|toast|dialog|crumb|caption|label|cm-/,
      allow: [
        { selector: /\.campaign-compose-sheet\b|\.studio-notices\b|\.email-text\b/, reason: 'an email at its own width: the composer\'s sheet (680px) and its notices, and an email\'s plain text (800px)' },
        { selector: /\.onboarding-workspace\b/, reason: 'the onboarding header\'s workspace picker: half the header, and a longer name wraps' },
        { selector: /\.onboarding(?:--(?:narrow|choice|wide))?(?![\w-])|\.onboarding-notice(?![\w-])/, reason: 'Ryan: onboarding is a centred reading column (2026-11-25)' },
      ],
    },
    'no-label-truncation': {
      level: 'report',
      title: 'Labels are never truncated',
      why: 'A label (navigation, a tab, a field\'s or fact\'s name, a status, a title, a button) reads whole: an ellipsis hides what a control does.',
      use: 'Let the label wrap (drop white-space: nowrap and text-overflow; overflow-wrap: anywhere) or give it room. Long data has components of its own: Identifier for IDs, PrivateAddress for addresses.',
      // What may be cut: long free text whose whole is a click away (the row, the detail page, the copy button), matched
      // against the CSS selector. Derived from the comments beside each cut in the stylesheets.
      allow: [
        email,
        { selector: /snippet|subject|preview|__said\b|__body\b|__detail\b|__note\b|-desc\b|__desc\b|sample|recent/, reason: 'message content and free text: snippets, subjects, a server\'s reply, notes and descriptions' },
        { selector: /address|email|sender|recipient|__from\b|__who\b|-who\b|__people\b|-to\b|__to\b|user|people/, reason: 'people and addresses (PrivateAddress cuts a revealed address in place)' },
        { selector: /identifier|[-_]id\b|\bcode\b|__key\b|prefix|token|__link\b|url|host|domain|chain|match|__local\b/, reason: 'IDs, keys, links, hosts and patterns: compared by their ends and copied whole' },
        { selector: /names?\b|__workspace\b|file|attachment|issue|__ritual\b|__first\b|-rule\b|-from\b/, reason: 'names people gave things (a campaign, contact, file, workspace or rule) and who made a change' },
        { selector: /\bdd\b|input|clip\b/, reason: 'a fact\'s value (dd), a field\'s typed value, a cell value Receiving clips to one line (inbound.css)' },
        { selector: /(^|[\s.-])[\w-]*cell\b|\.ui-table td\b/, reason: 'a table cell\'s value in a fixed column: the row opens it whole' },
        { selector: /\.ui-card__(title|segment|link)\b|button\.ui-card__link/, reason: 'a phone\'s card shows a row\'s values in a fixed height; the card opens it whole (DataTable)' },
        { selector: /\.standing-banner__/, reason: 'the standing banner reserves its lines so a late reason moves nothing; the page it links says it whole (app.css)' },
      ],
    },
  },
} satisfies { include: string[]; ignore: Allow[]; rules: Record<string, Rule & Record<string, unknown>> }

export default config
export type RuleId = keyof typeof config.rules
