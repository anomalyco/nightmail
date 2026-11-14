# How sending limits work (Hosted)

Hosted Nightmail gives each workspace a **sender score** (0–100) from the quality of what it sends. The score sets the **daily limit**. Nightmail stays out of the way unless something goes wrong: it **warns** first, then **holds marketing**, and **pauses** only for problems that put the shared pool at risk. These thresholds are public; how Nightmail detects abuse is not.

Everything here is in the API: `GET /v1/sender-score` (score, factors, `limit`, `standing`), the `account.standing.changed` webhook event, and `connection.standing` on `GET /v1/me`. Self-hosted and bring-your-own-AWS installations get the score for display only.

## Score → daily limit

| Score | Grade | Daily limit (rolling 24 h, recipients) | Per minute | Marketing per hour |
| --- | --- | --- | --- | --- |
| calibrating (first 100 recipients) | – | 100 | 50 | 25 |
| under 65 | D, F | 100 | 50 | 25 |
| 65–69 | D | 200 | 50 | 50 |
| 70–74 | C | 500 | 50 | 125 |
| 75–79 | C | 1,000 | 50 | 250 |
| 80–84 | B | 2,000 | 100 | 500 |
| 85–89 | B | 5,000 | 250 | 1,250 |
| 90 and up | A, A+ | 10,000 | 500 | 2,500 |
| on request | – | 25,000 / 50,000 / 100,000 | up to 1,000 | limit ÷ 4 |

- **Calibrating:** a new workspace sends at 100 a day until 100 real recipients were accepted (simulator mail never counts) and 24 hours passed. The score then starts at 65 (200 a day) if the mail was good, lower if it was not.
- **Movement:** the score moves towards its target by at most **+5 a day** and **−10 a day**, so a clean sender roughly doubles its limit each day and reaches 10,000 about a week after calibrating, if it sends enough to prove it.
- **Hysteresis:** a limit drops a band only when the score is 2 points under the band's floor.
- **Per minute:** `clamp(limit ÷ 20, 50, 500)` per workspace, half of it per sending domain.
- **Transactional reserve:** marketing may use at most `limit − max(100, 10% of limit)`. A small sender always keeps 100 a day for receipts and password resets; while calibrating, all 100 are for transactional mail.
- **Grades:** A+ ≥ 95, A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below.
- Lowering a limit applies to new mail at once. Mail already accepted is never recalled.

## What the score is made of

| Factor | Weight | Good (100) | Bad (0) |
| --- | --- | --- | --- |
| Complaints ÷ delivered | 30 | ≤ 0.01% | ≥ 0.3% |
| Spam screen rejections ÷ screened | 20 | ≤ 0.1% | ≥ 3% |
| Hard bounces to known recipients ÷ accepted | 15 | ≤ 0.5% | ≥ 5% |
| List quality: first-send bounces and suppression hits | 15 | ≤ 2% | ≥ 10% |
| Authentication: DKIM 40%, aligned SPF 30%, DMARC enforcing 30% | 10 | all three | none |
| Engagement: marketing unsubscribes ÷ delivered, lifted by clicks | 10 | ≤ 0.2% | ≥ 2% |

- A factor with nothing to measure is neutral: it drops out and the others are re-weighted.
- Evidence fades with a **30-day half-life**. Quality sets the ceiling; volume earns the way up: the target is `(n·Q + 250·60) ÷ (n + 250)`, where *n* is the faded volume. 100 perfect emails give 71; 1,000 give 92.
- Opens are ignored (mail privacy features inflate them).

## When something goes wrong: the ladder

Nightmail checks every 10 minutes. Every line needs a **count and a rate together**, so a few events never trip a small sender. Rates are over accepted mail in the window (24 hours of events against 48 hours of accepted mail, so late feedback is counted fairly).

| Signal | ① Warn | ② Restrict | ③ Pause |
| --- | --- | --- | --- |
| Complaints | ≥ 0.05% and ≥ 2 in 24 h, or ≥ 0.05% and ≥ 3 in 7 days | ≥ 0.1% and ≥ 3 in 24 h | ≥ 0.3% and ≥ 5 in 24 h, or ≥ 0.15% and ≥ 10 in 7 days |
| Hard bounces | ≥ 2% and ≥ 10 in 24 h, or ≥ 1.5% and ≥ 10 in 7 days | marketing ≥ 4% and ≥ 25, or any mail ≥ 8% and ≥ 50, in 24 h | **transactional** mail ≥ 5% and ≥ 50 in 24 h |
| Spam screen rejections ÷ screened | ≥ 2% and ≥ 3 in 24 h | ≥ 5% and ≥ 10 in 24 h | ≥ 10% and ≥ 25 in 24 h |
| External | – | – | AWS paused the workspace's SES tenant; confirmed abuse |

A **notice** sits below Warn: a first complaint or a few bounces show on the dashboard, with no email.

| Step | You see | Mail | Limit |
| --- | --- | --- | --- |
| Notice | A note on the score card | unchanged | unchanged |
| ① Warn | Overview card, a dot on the score, an email to owners and admins | unchanged | frozen (no rises) |
| ② Restrict | A banner on every page, an email | Campaigns pause and new marketing is refused (409 `MARKETING_HELD`). Transactional mail keeps flowing. | frozen |
| ③ Pause | A red banner on every page, an email | All sending stops (409 `HOSTED_SENDING_PAUSED`) and the workspace's SES tenants are disabled. Receiving, inboxes and the dashboard keep working. Queued mail is held for 72 hours, then canceled (`ACCOUNT_PAUSED`). | 0 |

Bounces alone hold marketing; they stop everything only when **transactional mail itself** bounces at 5% (and 50). Complaints, the spam screen, abuse and an AWS tenant pause stop everything.

## Getting back

| Step | By itself | Owner (dashboard, after the fix checklist) | Nightmail |
| --- | --- | --- | --- |
| ① Warn | clears after 24 hours under 80% of its line | – | – |
| ② Restrict | – | 24 hours after it started, once every 14 days, when the last 24 hours are under the warn line: marketing resumes at 50% of its allowance for 48 hours | a second restrict within 14 days |
| ③ Pause from transactional bounces | – | once every 30 days: the limit is 50% for 48 hours and marketing stays held for 24 hours | otherwise |
| ③ Any other pause | – | – | review only |

- A resume never restarts the limit at 100 a day. The 50% is of the limit before the resume, for 48 hours; another resume in that window keeps it there. Each pause leaves a **strike** for 90 days; the second caps the limit at 50% for 7 days, and the third needs a review for any resume.
- The owner action is `POST /v1/sender-score/release` (dashboard sessions, owners and admins); `standing.selfService` in `GET /v1/sender-score` says whether it is available, and when.

## Campaign list probe

A Hosted campaign with more than 100 recipients sends a **probe** first: the first `min(500, 10%)` recipients, at least 100. Release waits until the probe has gone out and ten more minutes for its feedback (`delivery.waiting.reason` is `list_probe`). More than 3% hard bounces or 2 complaints **quarantines** the campaign (paused, `LIST_QUALITY`); bounced addresses are suppressed and owners get an email. After the probe, a campaign still pauses at more than 2% bounces after 1,000 accepted or more than 0.08% complaints after 2,000. The owner can resume a quarantined campaign once; a second quarantine needs a review (409 `QUARANTINE_REVIEW_REQUIRED`). A quarantine never pauses the account.

## Content screen: how much text

Hosted mail is screened for smuggled advertising and scams before it is delivered. The screen reads the text the HTML's body shows, in document order, with each image's `alt` text in its place, as a client shows it when images are blocked. A message with alt text is therefore read twice, as shown with its images and as shown without them, and both readings count toward the limit. Then it reads the text part: a text part that, normalized, is exactly the HTML's text (one generated from it) counts once; any other text part is screened in full. It also reads every distinct address the message links to or loads from (links, images, backgrounds, and addresses in its text), in full, the way a mail client resolves them; these count toward the limit too.

| What | Limit | When it is checked |
| --- | --- | --- |
| A message (`POST /v1/emails/send`, each item of `/v1/emails/batch`, replies and inbox sends) | **24,576 UTF-8 bytes** of screened text (24 KiB), 60 distinct link hosts | On submission |
| A campaign's own copy, placeholders unresolved, and a campaign test | **49,152 UTF-8 bytes** (48 KiB) | On send, schedule or test |
| Each recipient's copy of a campaign | 49,152 bytes; a copy over it is refused alone | Before it is released |

Every recipient's copy of a campaign is screened before it is released, but each distinct copy only once: recipients whose personalized copies read exactly the same share one verdict. A campaign personalized with first names costs one screen per distinct first name; one with a unique value per recipient costs one per recipient, as a single message would. The campaign's own copy is screened first: if it is refused, the campaign fails before anyone is sent to. A copy the screen refuses is never sent (`CONTENT_REJECTED_SPAM`, counted in the score like any refused message), and when refused copies pass 5% and 10 recipients the campaign pauses once for you to review.

Over a limit, the request is refused at once with 422 `CONTENT_TOO_LARGE_TO_SCREEN` and `error.details[0]` set to `{ screenedBytes, limitBytes }` (or `{ linkHosts, linkHostLimit }`); in a batch, `index` names the message and nothing in the batch is queued. `POST /v1/emails/check` reports the measured size as the `screen-bytes` finding. Self-hosted installations set the limits with `JEV_MESSAGE_LIMIT_BYTES` and `JEV_CAMPAIGN_LIMIT_BYTES`.

## Content screen: the delivered copy

Hosted mail is delivered as one canonical copy of its HTML, and the screen reads exactly that copy. The body is parsed once, as a document, the tree is reduced to the allow-list below, and the result is serialized. Those bytes go to SES, and the screened text, the list of every address the message links to or loads from, and the verdict all come from the same tree. The copy is read again until it reads as itself, so a recipient's client parses exactly what was screened. This applies to all Hosted mail: probation and trusted, transactional and marketing, and each campaign copy. On probation the copy is first reduced to text, as described in `api/README.md`.

**Kept**, and nothing else:
- **Elements:** `html`, `head`, `body`, `meta` (only `charset`, its `http-equiv="Content-Type"` form, and `viewport`), `style` (CSS as below), `div`, `span`, `p`, `br`, `hr`, `a`, `img`, `table`, `tbody`, `tr`, `td`, `th`, `h1`–`h6`, `ul`, `ol`, `li`, `b`, `strong`, `i`, `em`, `u`, `s`, `small`, `sup`, `sub`, `blockquote`, `pre`, `code`, `center` and `font`.
- **Attributes:** `href` and `target` on links, `src` and `alt` on images, `color`, `face` and `size` on `font`, and on any kept element `style` (CSS as below), `class`, `id`, `lang`, `role`, `width`, `height`, `align` (not `right` on an image or table, which floats it), `valign`, `bgcolor`, `border`, `cellpadding`, `cellspacing`, `colspan`, `rowspan`, and ARIA attributes that hold states, numbers or references rather than text (not `aria-label`, `aria-description`, `aria-roledescription`, `aria-valuetext` or `aria-placeholder`). Two attributes that change nothing in HTML are kept so XHTML templates read as written: `type="text/css"` on `style`, and `xmlns` declarations on `html`.

**Removed:**
- **With their content**, because a client draws text, controls or media of its own for them, or shows nothing of them: form controls (`form`, `input`, `button`, `select`, `option`, `textarea`, `output`, `meter`, `progress` …), `script`, `noscript`, `template`, frames, `object`, `embed`, `svg`, `math`, `details`/`summary`, `dialog`, `marquee`, `ruby`, `audio`, `video`, `canvas`, image maps, and `title` (a document's title isn't shown in a message).
- **Any other element** gives its place to its content: `section`, `header`, `caption`, `thead` and `tfoot` (a client draws them first and last wherever they are, so their rows stay where they are written), `label`, `q`, `bdo`, `link`, custom and Office (`o:p`) elements, and so on.
- **Any other attribute:** `title`, `dir`, `background`, `name`, `rel`, `data-*`, event handlers, a list's `type`, `start`, `value` and `reversed` (so list markers are bullets or 1, 2, 3…), `srcset`, `ping` and the rest, and inline `data:` addresses.
- **Every comment**, Outlook's conditional ones included, with both branches: what `<!--[if mso]>…<![endif]-->` holds goes, and the `<!--[if !mso]><!-->` markers go, so what they enclose shows in Outlook too. Every client then shows the same copy, the one screened; Outlook loses its VML buttons, ghost tables and Office settings.
- **Hidden content, with its text.** An element with the `hidden` attribute goes. An element its style hides keeps its place but loses its content (a hidden image goes): `display:none`, `visibility:hidden` or `collapse`, `opacity` of 0.1 or less, type under 2 px (`font-size` or `font`, nested sizes multiplied), a `line-height` under 1 px, or a box of 2 px or less in height or width with its overflow hidden. Text drawn in its background colour (within a contrast of 1.5, `transparent` included, over its `bgcolor` or background colour) goes too, unless a background image is behind it. Styles come from the element's `style` and from the copy's sheets, read as written and with every `@media` query matching (dark mode, small screens).
- **One hidden block is kept:** the preheader, the first thing the message holds when its own style hides it, a `div` or `p` of at most 300 characters of plain text. Inboxes show it beside the subject, and the screen reads it like the rest.
- **Bidi controls:** embedding, override and isolate characters (U+202A–U+202E, U+2066–U+2069) in text and alt text.

**Text reads in its own order.** Without `dir`, `direction` and `unicode-bidi`, every paragraph is laid out left to right, so inline boxes line up in the order they are written. Right-to-left scripts (Arabic, Hebrew) still display right to left within a line, by the Unicode bidi algorithm, but a right-to-left paragraph is no longer right-aligned: send such mail with `text-align:right` if it needs to be.

A repeated attribute is delivered once, the first, as every HTML parser reads it. `POST /v1/emails/check` lists everything the copy would lose in its `hosted-removed` finding (for example "input elements, with their content", "Outlook conditional comments", "hidden elements, with their content", "dir attributes on p", or "List style changed to plain numbers or bullets").

The screen reads only what the body shows: its text in document order (the head, the title and every comment excluded), with each image's `alt` text in its place.

**Refused** at submission with 422 `UNSUPPORTED_URL_IN_HOSTED_MAIL`, because where it leads depends on where the message is opened:
- `<base>`;
- any link or image address that isn't an absolute `https://` or `http://` address (with both slashes), `mailto:`, `tel:`, `cid:` (an attachment) or a `#fragment`. This covers relative (`/offer`, `../offer`, `https:offer`) and network-path (`//host/offer`, `\\host/offer`) addresses and other schemes. Inline `data:` is refused earlier, as `UNSAFE_HTML_URL`.

The error names each element and attribute, and `error.details[0].unsupported` lists them (with `index` in a batch). `POST /v1/emails/check` reports the same as the `unsupported-url` warning. A campaign's own copy may start an address with a placeholder (`href="{{link}}"`): each recipient's copy must then hold an allowed address, or that copy alone is refused with the same code.

**CSS** is never rewritten. A style sheet or `style` attribute is delivered byte for byte as written, less whole declarations and rules, cut out where they were parsed. What stays is a conservative allow-list:
- **A declaration stays** when its property is a presentation property (the list below) and its value holds only keywords, numbers, lengths, colours, gradients and `calc()`/`min()`/`max()`/`clamp()` arithmetic.
- **A declaration is removed** when its property is anything else, including custom properties (`--*`), `content`, `quotes`, counters, `cursor`, `filter`, `transform`, `direction`, `order`, transitions and animations. It is also removed when its value has `var()`, `env()`, `attr()`, `url()`, `image-set()`, `cross-fade()`, `element()`, `expression()` or any other function, a function name written with escapes, or a string anywhere but a font name.
- **`background-image`** may load exactly one absolute `https` image, written `url("…")` without escapes; that address is screened. Any other `background-image`, and a `background` shorthand with an image, is removed.
- **At-rules:** `@media` stays, with its rules filtered the same way. `@font-face` and `@import` stay only when they load from the font services below. Every other at-rule (`@supports`, `@keyframes`, `@counter-style`, `@page` …) is removed.
- **Hiding by selector:** in a style sheet, a declaration that would hide what its selector matches is removed, so the content shows: `display:none`, `visibility:hidden`, near-zero `opacity`, type or line height under 2 px, a zero height or width, and a transparent colour. A colour or background in a rule whose selector the screen's style reader doesn't apply (`:hover`, `:is()`, pseudo-elements) is removed too, so the screen sees every colour text can be drawn in.
- **Order:** removed wherever it is: `position` and its offsets, `z-index`, `float` other than `left`, negative margins and `text-indent`, letter or word spacing below −2 px, `grid-auto-flow`, `display` values that move table rows to a table's head or foot, and (already) `direction`, `unicode-bidi`, `order` and reversed flex. `mso-hide:all` is removed too, so Outlook shows what every other client shows.
- **Rules:** a rule stays only with a plain selector (type, class, id, attribute and pseudo selectors and combinators) and a block of plain declarations. A rule with nested rules or at-rules in its block, or with any other selector, is removed whole, as is a rule left without declarations. CSS comments stay where they are; every CSS reader ignores them.

The presentation properties (each also with a `-webkit-`, `-moz-`, `-ms-` or `-o-` prefix):
- **Typography:** `font` and its longhands (`font-family`, `-size`, `-style`, `-weight`, `-variant*`, `-feature-settings`, `-variation-settings`, `-stretch`, `-kerning`, `-optical-sizing`, `-synthesis`, `-size-adjust`, `-smoothing`), `line-height`, `letter-spacing`, `word-spacing`, `text-align(-last)`, `text-decoration*`, `text-underline-offset`/`-position`, `text-transform`, `text-indent`, `text-shadow`, `text-rendering`, `text-size-adjust`, `white-space`, `word-break`, `word-wrap`, `overflow-wrap`, `hyphens`, `tab-size`, `vertical-align`, `list-style` and `list-style-type` (only `none`, `disc`, `circle`, `square` or `decimal`, below), `list-style-position`, `interpolation-mode`.
- **Colour:** `color`, `background`, `background-color`, `background-image` (above), `background-position`, `-size`, `-repeat`, `-clip`, `-origin`, `opacity`, `color-scheme`, `supported-color-schemes`, `accent-color`, `caret-color`, `text-fill-color`.
- **Spacing:** `margin*`, `padding*` (physical and logical), `gap`, `row-gap`, `column-gap`, `grid-gap`.
- **Sizing:** `width`, `height`, `min-`/`max-width`/`-height`, `inline-size`, `block-size` and their `min-`/`max-`, `box-sizing`, `aspect-ratio`, `object-fit`, `object-position`.
- **Borders:** `border*` (sides, widths, styles, colours, radii), `border-collapse`, `border-spacing`, `outline*`, `box-shadow`.
- **Display and layout:** `display`, `float`, `clear`, `overflow(-x/-y)`, `table-layout`, `caption-side`, `empty-cells`, `flex`, `flex-direction`, `flex-wrap`, `flex-flow` (not reversed), `flex-grow`, `flex-shrink`, `flex-basis`, `grid-template-columns`/`-rows`, `grid-auto-columns`/`-rows`, `columns`, `column-count`, `column-width`, `column-rule`.
- **Alignment:** `align-items`, `align-content`, `align-self`, `justify-content`, `justify-items`, `justify-self`, `place-items`, `place-content`, `place-self`.
- **Visibility:** `visibility`.
- **Outlook:** `mso-table-lspace`, `mso-table-rspace`, `mso-line-height-rule`, `mso-line-height-alt`, `mso-hide`, `mso-padding-alt`, `mso-margin-top-alt`, `mso-margin-bottom-alt`, `mso-text-raise`, `mso-font-width`, `mso-ansi-font-size`, `mso-bidi-font-size`, `mso-height-rule`, `mso-border-alt`, `mso-width-percent`, `mso-fit-shape-to-text`, `mso-wrap-style`, `v-text-anchor`.

**Fonts:** a font can draw any text in place of the text the screen reads, and a style sheet can generate text, so Hosted mail loads both only from font services whose fonts senders can't upload. `@font-face` files and `@import` may come from `fonts.gstatic.com`, `fonts.googleapis.com`, `use.typekit.net`, `p.typekit.net` and `fonts.bunny.net`, over `https`. Self-hosted installations set the list with `JEV_FONT_HOSTS`. Font files may also come from the installation's own font directory (the campaign editor's Inter). Fonts and style sheets from anywhere else are removed from the delivered copy rather than refused (a `<link>` is removed wherever it points: load a font service's sheet with `@import`), and `POST /v1/emails/check` shows a `custom-font` warning: "Custom font from <host> removed; use a hosted font service."

Every kept address (links, images, `background-image`, fonts, imports) is on the screen's list and counts toward the screened-text limit and the 60-host limit above.

**Bring-your-own AWS with `screen: true`:** the message goes out exactly as submitted and is screened as written, by the same rules. Since it isn't changed, it must hold nothing the canonical copy would remove; otherwise it is refused at once with 422 `UNSUPPORTED_HTML_IN_SCREENED_MAIL`, the message and `error.details[0].removed` listing what to remove (the same list as the checker's `hosted-removed` finding). `<base>` and relative addresses are refused as above. Without `screen: true` the mail is unaffected.

## The `account.standing.changed` event

Subscribe a webhook to `account.standing.changed` to hear about every change of step, a campaign quarantine, and an owner's or Nightmail's release. `data` has `step`, `previousStep`, `reasons` (code, metric, value, count, threshold, minimum, window, message), `since`, `version`, `sequence` (per workspace, always increasing: ignore a sequence you have already seen), `marketingHeld`, `change` and `actor.kind` (`system`, `owner` or `operator`).
