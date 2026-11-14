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

Hosted mail is screened for smuggled advertising and scams before it is delivered. The screen reads the HTML's visible text and `alt` text, then the text part: a text part that, normalized, is exactly the HTML's text (one generated from it) counts once; any other text part is screened in full. It also reads every distinct address the message links to or loads from (links, images, backgrounds, and addresses in its text), in full, the way a mail client resolves them; these count toward the limit too.

| What | Limit | When it is checked |
| --- | --- | --- |
| A message (`POST /v1/emails/send`, each item of `/v1/emails/batch`, replies and inbox sends) | **24,576 UTF-8 bytes** of screened text (24 KiB), 60 distinct link hosts | On submission |
| A campaign's own copy, placeholders unresolved, and a campaign test | **49,152 UTF-8 bytes** (48 KiB) | On send, schedule or test |
| Each recipient's copy of a campaign | 49,152 bytes; a copy over it is refused alone | Before it is released |

Every recipient's copy of a campaign is screened before it is released, but each distinct copy only once: recipients whose personalized copies read exactly the same share one verdict. A campaign personalized with first names costs one screen per distinct first name; one with a unique value per recipient costs one per recipient, as a single message would. The campaign's own copy is screened first: if it is refused, the campaign fails before anyone is sent to. A copy the screen refuses is never sent (`CONTENT_REJECTED_SPAM`, counted in the score like any refused message), and when refused copies pass 5% and 10 recipients the campaign pauses once for you to review.

Over a limit, the request is refused at once with 422 `CONTENT_TOO_LARGE_TO_SCREEN` and `error.details[0]` set to `{ screenedBytes, limitBytes }` (or `{ linkHosts, linkHostLimit }`); in a batch, `index` names the message and nothing in the batch is queued. `POST /v1/emails/check` reports the measured size as the `screen-bytes` finding. Self-hosted installations set the limits with `JEV_MESSAGE_LIMIT_BYTES` and `JEV_CAMPAIGN_LIMIT_BYTES`.

## Content screen: which addresses

The screen reads every address a message links to or loads from, so Hosted mail uses only addresses whose destination it can read exactly: ones that lead to the same place wherever the message is opened. This applies to all Hosted mail, probation and trusted, transactional and marketing, and to campaigns.

- **Allowed:** absolute `https://` and `http://` addresses (with both slashes), `mailto:` and `tel:`. A `#fragment` or empty link stays in the message, and `cid:` names one of its attachments. Inline `data:` is refused earlier, as `UNSAFE_HTML_URL`.
- **No base:** no `<base>` or SVG `xml:base`, and no relative (`/offer`, `../offer`, `https:offer`) or network-path (`//host/offer`, `\\host/offer`) addresses.
- **No `srcset`:** give each image one absolute `src`.
- **No CSS resources:** no `url()`, `image()`, `image-set()`, `src()` or `@import` in `<style>` sheets, `style` attributes or SVG presentation attributes. Two exceptions: `background-image: url("https://…")` in a `style` attribute (double quotes, and no backslash anywhere in the attribute), and `url(#id)` references within the message. Most mail clients ignore or block CSS resources anyway; use the `background` attribute or an `<img>`.
- **Nothing else that loads:** no `<link>`, no `<meta http-equiv="refresh">` or `"link"`, no plugin elements (`<object>`, `<embed>`, `<applet>`), and no SVG `<set>` or `<animate>` of an address or style.

Every URL-bearing attribute is either read as a destination or refused:

| Attribute | Treatment |
| --- | --- |
| `href`, `src`, `background`, `poster`, `action`, `formaction`, `cite`, `longdesc`, `usemap`, `data`, `codebase`, `classid`, `code`, `profile`, `manifest`, `icon`, `lowsrc`, `dynsrc`, SVG `xlink:href`, and any prefixed `…:href` or `…:src` (Office `o:href`, `v:src`) | Read as a destination; must be an allowed address |
| `ping`, `attributionsrc` | Each space-separated address is read as a destination |
| `srcset`, `imagesrcset`, `archive`, `xml:base` | Refused |
| `style` | `background-image: url("https://…")` is read as a destination; any other CSS resource is refused |
| `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker`, `marker-start`, `marker-mid`, `marker-end`, `cursor`, `color-profile` | A CSS resource other than `url(#id)` is refused |
| `<style>` contents | A CSS resource is refused. The one exception is the web-font sheet the campaign editor adds, whose two font files are read as destinations |

Markup is read the way a validator reads it: as a fragment and as a whole document (so `<html>` and `<body>` keep their attributes), including Outlook conditional comments, other comments, `<template>` contents and frame fallback content. Destinations count toward the screened-text limit and the 60-host limit above.

Anything else is refused at once with 422 `UNSUPPORTED_URL_IN_HOSTED_MAIL`. The message names each element and attribute, and `error.details[0].unsupported` lists them (with `index` in a batch). `POST /v1/emails/check` reports the same as the `unsupported-url` warning. A campaign's own copy may start an address with a placeholder (`href="{{link}}"`): each recipient's copy must then hold an allowed address, or that copy alone is refused with the same code.

## The `account.standing.changed` event

Subscribe a webhook to `account.standing.changed` to hear about every change of step, a campaign quarantine, and an owner's or Nightmail's release. `data` has `step`, `previousStep`, `reasons` (code, metric, value, count, threshold, minimum, window, message), `since`, `version`, `sequence` (per workspace, always increasing: ignore a sequence you have already seen), `marketingHeld`, `change` and `actor.kind` (`system`, `owner` or `operator`).
