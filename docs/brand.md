# Brand

The logo is the **Moon stamp**, a square postage stamp with a crescent moon in its window, and the **NIGHTMAIL** wordmark, in geometric capitals of one weight. The **lockup** is the stamp with the wordmark beside it. In running text the product's name stays lowercase: nightmail.

## Files

Each file comes in a light version (`-light`, ink `#0a0a0a`, for a pale background) and a dark one (`-dark`, paper `#fafafa`, for a dark background). They are the final vector set's own files, copied in unchanged: outlined, so no font is needed, with no background and no margin. The number in a name is the size the file opens at; every one scales, except that the stamp has a second drawing for small sizes.

| file | use |
| --- | --- |
| `app/public/brand/nightmail-logo-1024-*.svg` | the stamp, from 32 px up |
| `app/public/brand/nightmail-logo-16-*.svg` | the stamp under 32 px: the small drawing (see Construction) |
| `app/public/brand/nightmail-wordmark-128-*.svg` | the wordmark alone |
| `app/public/brand/nightmail-lockup-256-*.svg` | the lockup, from 32 px tall (the repository's README sets it at 32) |
| `app/public/brand/nightmail-lockup-24-*.svg` | the lockup under 32 px tall, with the small stamp |
| `app/public/favicon.svg`, `favicon-dark.svg` | the tab icon: the stamp's crescent on a rounded tile, for a browser's pale and dark themes |
| `app/public/favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | the tab icon for browsers without vectors, and the home-screen icons |
| `app/public/og.png` | the link-preview card: a fixed file, which still shows the old lockup and wordmark until it is re-rendered |
| `app/src/lib/marks.ts` | the wordmark's and both stamps' outlines, as the app draws them |
| `app/src/components/NightmailLogo.tsx` | `NightmailWordmark` (the wordmark) and `NightmailMark` (the stamp), each one inline SVG that follows the theme |

`node scripts/brand-assets.mjs` in `app/` builds `favicon.svg`, `favicon-dark.svg`, `favicon.ico` and the four home-screen icons from the stamp files in `app/public/brand/` (the tab icon from the stamp's moon). Run it after changing a mark.

Use PNGs in email, because many mail clients don't show SVG. No email Nightmail sends carries a logo today (account notices are words and one button, `api/src/notices.ts`). One that does should take a PNG of the light lockup or stamp, at twice its size in the message, on its own paper (`#fafafa`) rectangle with at least half the cap height of padding round it, so a client that darkens the message does not leave ink on a dark canvas.

## Colour

| where | light | dark |
| --- | --- | --- |
| The app (`--color-logo`, `styles/tokens.css`) | the app's ink `#0A0B0F` | its paper `#F4F2EC` |
| Standalone files (`app/public/brand/`, the favicons, the icons) | the set's ink `#0a0a0a` | its paper `#fafafa` |

In the app the marks are one outline coloured by the theme, so they take the app's own ink and paper, the colours its text and pages are set in. A standalone file is seen outside the app, so it keeps the set's colours exactly. The two are a hair apart; never mix them in one picture.

The marks are set in ink on a pale ground and paper on a dark one, and in nothing else. The app icons are the paper stamp on a full square of ink. The periwinkle `--color-brand` (`#798ABA`) is an accent on the homepage's machine, not a logo colour.

## Construction

Measured from the SVGs.

- **Stamp:** a square of 1000 units. A frame 122.4 wide round a square window 755.1 across (122.4 to 877.5); the window is a hole, so the ground shows through it. The perforations are bites out of the frame's outer edge, 59.5 deep:
  - **from 32 px:** semicircles of radius 59.5, centred on the edge every 200 units (four whole ones a side) and a quarter-circle at each corner: five bites a side, counting the corners.
  - **under 32 px:** wider, shallower bites (148.6 across, 59.5 deep), centred every 250 units (three whole ones a side), and notched corners: four a side. At 16 px each bite is about a pixel, which the larger drawing's would not be.
  - **Moon:** a crescent opening to the lower left, 548 × 565 units, centred in the window; the same in both drawings.
- **Wordmark:** cap height 1000 units and nothing above or below it: 10720 wide, so 10.72 cap heights. Every stem, bar and diagonal is 280. The G's two outer left corners are rounded by 240; every other corner is sharp. Letters stand 100 apart (70 round the T, 89 round the A).
- **Lockup:** with the cap height as 100: the stamp 147 square, centred on the caps (it stands 23.5 over and under them), then a gap of 42, then the wordmark: 1261 wide in all.

## Clear space and size

- **Clear space:** half the cap height on every side of the wordmark and the lockup; a quarter of its side round the stamp alone.
- **Minimum size:** the stamp at 16 px, the lockup 16 px tall (both with the small stamp under 32 px). The wordmark at 10 px cap height in the app, where it is set against its interface's own type; 16 px elsewhere, as the set's smallest file is.

## Where the app sets them

- **In the app, the wordmark stands alone.** The stamp is for places that need a square mark: the app icons and the support chat's avatar. The browser's tab takes its moon alone, on a tile.
- **Dashboard sidebar:** `NightmailWordmark` at 13 px cap height, so 139 px across, at the top with the theme button beside it and the workspace picker under it. Its first stem stands on the text's left edge, the same x as the picker's name and the navigation labels (`--sidebar-inset`). In the narrower sidebar (900 to 1100 px wide) it is 11 px, so it clears the theme button.
- **A phone's top bar (under 640 px):** 11 px, as tall as the caps of the workspace picker's name beside it; 10 px under 380 px. From 640 px the bar carries it at 13 px.
- **Onboarding and the legal pages:** 13 px, at the head of the page.
- **Support chat:** `NightmailMark` at 18 px beside the agent's name, so the small drawing (`NightmailMark` takes it for any `size` under 32).
- **Homepage:** there is no header and no stamp. The wordmark stands across the page's end as solids cut off by the page's edge (`features/home/end-band.tsx`), raised from its outline. The rendered machine above it (`features/home/factory/`: `first.avif` and the posters, for desktop and phone, and the video segments on the media bucket) and `og.png` still carry the old wordmark in lights until they are re-rendered.
- **The wordmark's box** is set in CSS before it draws (`.nightmail-wordmark` in `styles/app.css`: the cap height, and 10.72 times it across), so nothing moves when it does.

## Favicon and app icons

- **Browser tab:** the stamp's crescent alone on a rounded tile, because at 16 px the stamp's frame and perforations turn to noise and the outline has too little mass beside other sites' solid icons. It is drawn on the 16 px grid: a 16 px square with its corners rounded by 3, and the moon, at the real mark's shape and angle, 11 tall and centred (the same proportions at 32 px: corners 6, moon 22). `favicon.svg` is a paper moon on an ink tile, for a browser's pale theme; `favicon-dark.svg` an ink moon on a paper tile, for its dark one. `favicon.ico` holds the light one at 16 and 32 px, for browsers that take no vector: its paper moon reads on a strip of either theme.
  `<link rel="icon" href="/favicon.ico" sizes="32x32">`, then `<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">` and the same for `/favicon-dark.svg` with `dark`. Keep `sizes="32x32"` on the `.ico`: with `16x16` listed too, Chrome takes the `.ico` over the vectors. `app/index.html` and `app/public/signed-in/index.html` carry the links; the support Worker serves the same two files for its own pages (`support/src/favicon.ts`: keep them the same).
- **Home screen:** `apple-touch-icon.png` (180), `icon-192.png` and `icon-512.png` are the paper stamp at 66 % of the side, centred on a full square of ink: its corners stand 17 % in from the icon's, clear of the corners iOS rounds, and the perforations keep the ink round them. `icon-maskable-512.png` has it at 52 %, so the whole stamp, corners included, is inside the 80 % circle a launcher may crop to.

## Don't

- Stretch, respace, redraw or rotate the marks, or set the wordmark in another typeface or in lowercase.
- Scale the large stamp under 32 px, or the small one up past it.
- Recolour them outside ink and paper, or add gradients, outlines, shadows or glows.
- Fill the stamp's window with anything but its own ground.
- Set the moon alone anywhere but the tab icon.
- Crop the marks. The homepage's end band, cut off by the page's edge as a poster's is, is the one exception; there the wordmark is given depth, its face stays the outline itself and its sides take a darker tone.
