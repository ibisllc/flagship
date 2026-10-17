# Flagship Design System

A reference for everything Flagship-shaped: marketing site, web console, phone
clients, daemon admin UI, and the inside of any first-party app. The goal is
one consistent surface that says **"this is your box, your keys, your apps"**
without ever shouting.

---

## 1. Reference distillation

What we are stealing, and what we are deliberately leaving on the shelf.

| Source | What we take | What we leave |
| --- | --- | --- |
| **Mullvad** | Manifesto-style headline copy ("Privacy is for the people"). Single accent over a near-monochrome base. Refusal to decorate. | The militant tone. Flagship is calm, not angry. |
| **Proton** | Trust badges placed late, not in the hero. Generous line-height for body copy. Two CTAs (free / paid) without one drowning the other. | The slight stock-photography sheen on some pages. |
| **Tailscale** | "Networking for humans" voice — confident, plain, no jargon in the hero. Three-up feature blocks with line-art icons. Quantified social proof. | The cool-blue corporate cast. |
| **Linear** | Type hierarchy that does the work without rules or cards. Status pills. The dark theme that feels engineered, not gamer. The "no-shadow shadow" — 1px border + faint inner glow. | Density. Linear is for power users; Flagship's marketing must not be. |
| **Apple Home / HomePod** | Photography of the actual hardware in a real home. Sentence-case headlines that ask gentle rhetorical questions ("All your accessories in one app? Smart."). Color-coded category icons. | Closed-ecosystem vibe. We are explicitly the opposite. |
| **Stripe** | Two-column docs layout (prose left, code right) with sticky code panes. The way numbers are made to feel concrete ("$1.9T processed"). Subtle gradient *on the hero illustration only*, never on the page background. | The slanted-parallelogram motif — too on-brand to borrow. |
| **Vercel** | Dark mode that actually looks designed (not just inverted). Real-time pulse animations on a globe / network graphic. Monospace accents inline with prose. | The "deploy / ship / scale" verbing. Flagship is not a launchpad. |
| **Railway** | (Site redirected; using known patterns.) Soft-glow accent on dark, hand-drawn diagram aesthetic. | N/A — borrow lightly. |
| **Notion** | Conversational headlines that admit a little personality. Bento-grid feature sections. Logo carousel for trust without the "as seen in" framing. | The dark-only marketing aesthetic. |
| **Arc** | The aspirational testimonial pull-quote as a section anchor. Whitespace-as-a-feature. | The slightly precious copy ("a browser that anticipates"). |
| **Home Assistant / YunoHost (anti-patterns)** | — | Six SKUs presented as equals. Feature firehose in one paragraph. GitHub-stars-as-headline. Donate button next to install button. Multiple competing primary CTAs. Screenshot galleries with no narrative. |

**Synthesis.** Flagship's surface should feel like Apple Home wrote the copy, Linear set
the type, Stripe wrote the docs, and Mullvad refused to add anything else.

---

## 2. Color

The website (flagshipserver.com) is the reference: `apps/web/public/tokens.css`
holds the canonical values, and the webapp (`apps/web/public/webapp/style.css`)
mirrors them. Two themes. The site opens in light (with a toggle); the webapp
and the phone apps follow the device's setting. Both must be first-class.

### 2.1 Light theme

| Token | Hex | Use |
| --- | --- | --- |
| `--canvas` | `#F7F6F2` | Page background. Warm paper, not clinical white. |
| `--canvas-2` | `#F0EEE8` | Inputs, hovered rows, quiet fills. |
| `--surface` | `#FFFFFF` | Cards, settings groups, modals. |
| `--rule` / `--border` | `#E5E3DC` | Hairlines. 1px only, never 2px (callout edges excepted). |
| `--rule-strong` | `#C8C5BB` | Input and secondary-button outlines. |
| `--ink` | `#14140F` | Primary copy. Near-black, warm. |
| `--ink-muted` | `#555149` | Secondary copy, captions, mono labels. |
| `--teal` | `#14B8A6` | The Flagship teal. Fills: primary buttons, selection, progress, the eyebrow rule. Text on it is dark ink (`#0A0A09`), never white or cream (contrast). |
| `--accent` (webapp and site) | `#0F766E` | The teal deepened to pass AA (4.5:1) as small text: links, active tab label, pressed and hover text. Dark theme: `#2DD4BF`. |
| `--accent-graphic` (webapp and site) | `#0E9488` | The lighter teal for graphics (at least 3.2:1 on every light surface): icons beside labels, focus rings, spinners, rings, sparklines, state borders, large headings. Never small text. Dark theme: `#2DD4BF`. Owner, 2026-10-17: keep the light teal wherever it stays readable. `apps/web/tests/themeContrast.test.ts` pins every pairing. |
| `--ok` / `--warn` / `--err` (webapp and site) | `#166534` / `#944D05` / `#B91C1C` | Status text and icons; 4.5:1 on every light surface and on their own 6-8 % wash. Dark theme: `#4ADE80` / `#FBBF24` / `#F87171`. |

### 2.2 Dark theme

| Token | Hex | Use |
| --- | --- | --- |
| `--canvas` | `#0A0A09` | Page background. Warm near-black, not pure. |
| `--canvas-2` | `#14130F` | Inputs, hovered rows. |
| `--surface` | `#1A1916` (site) / `#161512` (webapp) | Cards, modals. |
| `--rule` / `--border` | `#25231C` | Hairlines. |
| `--ink` | `#ECE7D6` | Primary copy — warm cream. |
| `--ink-muted` | `#8A8478` (site) / `#A39D8F` (webapp) | Secondary copy. |
| `--teal` / `--teal-bright` | `#14B8A6` / `#2DD4BF` | Fills / text and hover. |
| `--ok` / `--warn` / `--err` | `#4ADE80` / `#FBBF24` / `#F87171` | Status. |

**Rules.**

- Pure `#000` and pure `#FFF` are banned as page or text colours. They look cheap on OLED and on paper-white displays. (A QR code's tile is the exception.)
- Only teal and the three status colours may be saturated. Everything else lives on the warm-neutral axis.
- No gradients on page or section backgrounds, buttons or bars. The landing hero's single soft glow is the only one.
- Status colors are semantic, not decorative. Don't paint a button green just because it is encouraging.

---

## 3. Typography

One family, two cuts, both self-hosted from `/fonts/`:

- **Geist** for everything you read: titles (weight 500, tight negative
  tracking), body (400), emphasis (500).
- **Geist Mono** for the site's small uppercase voice: the wordmark, nav and
  tab labels, eyebrows above sections, field labels, buttons with a plain-text
  label, status tags, and anything that is a value (addresses, keys, codes,
  versions).

No serif, no italic display face. The phone apps use their platform's system
font with the same roles (a monospaced cut where the web uses Geist Mono).

### 3.1 Type scale

| Role | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| `display` | clamp(40px, 6vw, 68px) / 1.04, −0.026em | 500 | Landing hero only. |
| `h1` | clamp(30px, 4.8vw, 52px) / 1.05, −0.026em | 500 | Site page titles. |
| `h2` | clamp(22px, 2.8vw, 30px) / 1.14, −0.018em | 500 | Site section titles; app screen titles (26–32px). |
| `h3` | 15–18px | 500 | Card and modal titles. |
| `body` | 15–15.5px / 1.55 | 400 | Default. |
| `body-sm` | 14px / 1.55 | 400 | Notes, list subtitles. |
| `eyebrow` | 11px mono, uppercase, 0.16–0.18em | 500 | Section labels, preceded by a 16px teal rule. |
| `label` | 11–12px mono, uppercase, 0.1–0.14em | 500 | Field labels, buttons, tabs, status tags. |

**Rules.**

- Body line-length capped near 60 characters (`--reading-width: 60ch`). Reading is the product.
- Headings and copy are sentence case. Uppercase belongs only to the mono label voice above, never to a sentence or a paragraph.
- Never use italics for emphasis; use weight (500) or `--ink` against muted siblings.

---

## 4. Spacing

A strict 4-px grid: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`.

| Token | px | Typical use |
| --- | --- | --- |
| `space-1` | 4 | Tight pairs (icon ↔ label). |
| `space-2` | 8 | Pill padding-y, list-item gap. |
| `space-3` | 12 | Button padding-y, input padding-y. |
| `space-4` | 16 | Card inner padding (mobile), paragraph gap. |
| `space-6` | 24 | Card inner padding (desktop), section gap (mobile). |
| `space-8` | 32 | Subsection gap, modal padding. |
| `space-12` | 48 | Section gap (desktop). |
| `space-16` | 64 | Hero top/bottom, page gutters at ≥ 1440. |

**Rule.** If you are reaching for a value not on this grid, you are designing the wrong thing.

---

## 5. Border radius

Small and square, like the site.

| Token | px | Use |
| --- | --- | --- |
| `radius-xs` | 2 | Status tags, inline code, badges. |
| `radius-sm` | 4 | Buttons, inputs, chips, icon squares, toasts. |
| `radius-md` | 6 | Cards, settings groups, modals. |

Avatars and status dots are round. Nothing else is a pill.

---

## 6. Motion

> **Rule.** Use **200 ms ease-out** for state transitions; **350 ms ease-out** for layout changes. No spring physics on web. No animation longer than 350 ms unless it is the one celebratory "your server is ready" pulse.

Reduced-motion: every animation collapses to a 0-ms opacity swap when
`prefers-reduced-motion: reduce` is set. No exceptions.

---

## 7. Voice and tone

Flagship talks like a calm friend who happens to be a security engineer. It
never explains what a daemon is unless you ask. It never apologizes for being
private. It is allowed to be a little funny, but only at its own expense.

### 7.1 Five do's

1. **Say the concrete thing.** "Your server is at `harry.flagship.services`." Not "Your endpoint has been provisioned."
2. **Lead with what changed.** "Cert renewed. Good for 89 more days." Not "Renewal completed successfully."
3. **Address the person, not the user.** "You'll need your phone." Not "User authentication is required."
4. **Admit limits.** "We can't see your data — that means we also can't help you recover it. Your phone can." Honest > breezy.
5. **Be a little playful when stakes are low.** Empty-state on a brand-new app list: *"No apps yet. The hardest part of vibe-coding is the first idea."*

### 7.2 Five don'ts

1. **Don't market the cryptography.** Saying "Ed25519 signatures!" in a hero is a tell that you don't trust the rest of the page. Show the green padlock instead.
2. **Don't use security theater.** No shield icons, no padlock-with-checkmark mascots, no "military-grade." Just say what's true.
3. **Don't apologize.** "Sorry, something went wrong" is filler. Say what failed and what to try.
4. **Don't verb our nouns.** Nobody "Flagships" anything. Nobody "joins the Flagship." It's "set up your Flagship server" or "your box."
5. **Don't write developer-only copy on consumer surfaces.** "ACME via TLS-ALPN-01" belongs in `/docs`, not in the install flow. The install flow says *"Getting your TLS certificate. About 30 seconds."*

### 7.3 Voice samples

| Bad | Better |
| --- | --- |
| "Provision your sovereign personal cloud infrastructure today!" | "Set up your Flagship. About ten minutes." |
| "An error occurred during the unlock-key exchange." | "Your phone didn't answer. Try again, or unlock from the phone directly." |
| "Welcome to your Flagship dashboard, where you can manage all your services." | "Hi, Harry. Everything is online." |
| "AI-powered, end-to-end encrypted personal cloud." | "Your stuff, on your hardware, with a real green padlock." |
| "Click here to install the bootable USB image." | "Download the installer (1.4 GB)." |

---

## 8. Component patterns

Each pattern is described in flat prose so it can be implemented in vanilla
CSS, Jetpack Compose, or SwiftUI without a framework. `apps/web/public/components.css`
(site) and `apps/web/public/webapp/style.css` (webapp) are the reference
implementations.

### 8.1 Button

44 px tall, padding `0 18px`, radius 4. A plain-text label is Geist Mono
12px, uppercase, 0.1–0.12em tracking, weight 500; a button that holds richer
content (a row, a tile, a card) keeps Geist and sentence case.

- **Primary (solid).** `--teal` fill, dark ink text (`#0A0A09`). Hover: `--teal-bright`. Active: `translateY(1px)`. Focus: 2 px outline in the text-safe teal at `outline-offset: 2px`.
- **Secondary (outline).** Transparent, `--ink` text, 1 px `--rule-strong` outline. Hover: outline and text turn teal.
- **Ghost / link.** No fill, no outline; a link-coloured underline on hover.
- **Destructive.** Outline in `--err` with `--err` text; it fills red only under the pointer, so a screen with several never shouts. Always require confirmation.

Disabled state: 40 % opacity, no hover, `cursor: not-allowed`.

### 8.2 Input

44 px tall, `--canvas-2` background, 1 px `--rule-strong`, radius 4, padding
`10px 14px`. Label sits **above** the field in the mono label voice. Helper
text sits below at `body-sm`, muted. On focus: border `--teal`, a 3 px
`--teal` ring at 10 % alpha, background `--canvas`. On error: border and helper
text `--err`. A label that wraps its own checkbox or radio is a sentence and
stays in Geist. Never use placeholder-as-label.

### 8.3 Card

Background `--surface`, 1 px `--rule`, radius 6, padding 16–20 px. **No
shadow** in either theme — separation is by rule, not elevation; only floating
layers (modals, menus, toasts, a dragged row) lift. A card never nests inside
another card. Lists of related rows share one card with hairlines between rows
(the site's 1 px-gap grids).

### 8.4 Callout

For a caution or an announcement: the tone's 8–10 % tint, a 2 px rule on the
left edge in the tone (`--teal`, `--warn`, `--err`), radius 4. A bare line
icon, never an icon inside a tinted tile.

### 8.5 Modal

Centered, max-width 420–480 px, `--surface`, 1 px `--rule-strong`, radius 6,
padding 24 px, one lift shadow. Backdrop: the canvas at ~72 % with a 4 px
blur. Title `h3` in Geist 500. Footer: secondary left, primary right. Esc
closes.

### 8.6 Toast

Bottom-center, radius 4, 1 px `--rule-strong`, `--surface` background, a 2 px
left edge in the tone (`--teal` for info, `--ok`, `--warn`, `--err`).

### 8.7 Status tag

Inline with text or in a card header: a 6 px dot and Geist Mono 11px in a
hairline tag (radius 2, padding `2px 7px`), dot, text and outline all in the
status colour. No fill, no animation — the one live dot that breathes is a
server's own online indicator on Home (an opacity pulse, like the site's
"● LIVE").

### 8.8 Header and tabs

The app header is the site's nav: the logo mark, a mono uppercase wordmark
(0.22em tracking) and a hairline below; the screen's state rides on the right
in the mono label voice. Tabs are mono uppercase labels with line icons; the
active one is teal with a 2 px teal rule.

---

## 9. Hero / landing layout

```
+---------------------------------------------------------------------------+
|  Flagship                       Product   Docs   Status        [ Sign in ]|
+---------------------------------------------------------------------------+
|                                                                           |
|                                                                           |
|     Your stuff, on your hardware,                                         |
|     with a real green padlock.                          [ illustration:   |
|                                                           a small box on  |
|     A personal cloud you actually own. Plug              a desk, faint    |
|     it in at home, pair it with your phone,              pulse on the     |
|     and run the apps you (or your friends)               status LED.      |
|     vibe-code in an afternoon.                           Dark, not        |
|                                                           glowy. ]        |
|     [  Get a build code  ]   See how it works ->                          |
|                                                                           |
|                                                                           |
|     . Trusted by 0 institutions.   . No data center.   . You hold the keys|
|                                                                           |
+---------------------------------------------------------------------------+
|                                                                           |
|   How it works                                                            |
|                                                                           |
|   [ 1. Pair ]            [ 2. Boot ]            [ 3. Build ]              |
|   Your phone is the      Plug in any old PC.    Vibe-code an app.         |
|   keychain. No cloud     One USB stick. Ten     It runs at                |
|   account.               minutes.               yours.flagship.services.  |
|                                                                           |
+---------------------------------------------------------------------------+
|                                                                           |
|   The trust diagram (full-bleed, alternating image/text)                  |
|                                                                           |
|   +----------------------+    Your phone holds the keys.                  |
|   |                      |    flagship.services is a dumb pipe.           |
|   |   [SVG: phone -->    |    Your box terminates TLS itself.             |
|   |    .com -->          |    We literally cannot read your data.         |
|   |    .services -->     |                                                |
|   |    your box]         |    [ Read the architecture ->  ]               |
|   |                      |                                                |
|   +----------------------+                                                |
|                                                                           |
+---------------------------------------------------------------------------+
|                                                                           |
|   Apps people have built                                                  |
|                                                                           |
|   [ Bento 2x3 of small app cards: name, one-line, tiny screenshot ]       |
|                                                                           |
+---------------------------------------------------------------------------+
|                                                                           |
|   FAQ                              Footer: docs / status / source / blog  |
|                                                                           |
+---------------------------------------------------------------------------+
```

Notes:

- One headline. One primary CTA. One secondary text link. Nothing else above the fold.
- The illustration is the *only* place a gradient appears on this page.
- Trust badges live in the FAQ section, not the hero.
- The footer never has more than three columns.

---

## 10. Phone-screen wireframes

All three are 390 x 844 (iPhone 15 baseline). Sheet-style modals from the
bottom; safe-area top reserved 44 px.

### 10.1 "Your server is ready"

```
+---------------------------------------+
|  9:41                          ..ooo  |
|                                       |
|         (subtle pulse animation)      |
|              .---------.              |
|             |  *  *  *  |             |
|              `---------`              |
|                                       |
|         Your Flagship is online.      |
|                                       |
|     harry.flagship.services           |
|     . Online   . TLS valid 89d        |
|                                       |
|                                       |
|   +-------------------------------+   |
|   |  What's running               |   |
|   |                               |   |
|   |   notes        . online       |   |
|   |   photos       . online       |   |
|   |   browser      . idle         |   |
|   +-------------------------------+   |
|                                       |
|   [   Open in browser           ->]   |
|   [   Install an app                ] |
|                                       |
|        Manage from this phone         |
|                                       |
+---------------------------------------+
```

Tone: a quiet "it just works" moment. The pulse is the *one* place we let
ourselves celebrate. Everything else is restraint.

### 10.2 "Approve unlock"

```
+---------------------------------------+
|  9:41                          ..ooo  |
|                                       |
|     <  Cancel                         |
|                                       |
|                                       |
|         Unlock your Flagship?         |
|                                       |
|   Someone just powered on your        |
|   server at home. Approve to send     |
|   the unlock key.                     |
|                                       |
|   +-------------------------------+   |
|   |  Server                       |   |
|   |  harry.flagship.services      |   |
|   |                               |   |
|   |  Requested from               |   |
|   |  192.0.2.14 . your home Wi-Fi |   |
|   |                               |   |
|   |  Fingerprint                  |   |
|   |  4f:9a:..:b1   tap to verify  |   |
|   +-------------------------------+   |
|                                       |
|     . Auto-approve from home Wi-Fi    |
|       for 24 hours          [ off ]   |
|                                       |
|                                       |
|   [        Approve with Face ID    ]  |
|   [        Not me. Block.          ]  |
|                                       |
+---------------------------------------+
```

The destructive-equivalent action ("Not me. Block.") is a ghost button in
`--danger` color, never a fully painted red button. We don't want to train
people to pound it.

### 10.3 "Vibe-code a new app"

```
+---------------------------------------+
|  9:41                          ..ooo  |
|                                       |
|     <  Apps                           |
|                                       |
|         New app                       |
|                                       |
|   Describe what you want. Your        |
|   Flagship will build it and run it   |
|   at <name>.harry.flagship.services.  |
|                                       |
|   +-------------------------------+   |
|   | A little site to track which  |   |
|   | of my houseplants I've        |   |
|   | watered, with a photo per     |   |
|   | plant. Send me a push when    |   |
|   | one's been thirsty 5+ days.   |   |
|   |                          324  |   |
|   +-------------------------------+   |
|                                       |
|   Name        plants                  |
|   Visible to  just me     v           |
|   AI          Claude (your key) v     |
|                                       |
|   Permissions it'll ask for:          |
|     . Postgres   (a 'plants' table)   |
|     . Object store (photos)           |
|     . Push notifications              |
|                                       |
|   [        Build it                ]  |
|              about 90 seconds         |
|                                       |
+---------------------------------------+
```

Notes:

- Free-text first; structured fields second. The textarea is the hero.
- We tell people exactly which data-layer scopes the app will get. No surprises later.
- The estimate ("about 90 seconds") is the playful-but-honest register: real numbers, casual phrasing.

---

## 11. Implementation notes

- **Web (vanilla CSS):** ship the tokens as `:root` and `:root[data-theme="dark"]` custom properties. The site switches with a manual toggle kept in `localStorage` (`fs-theme`, light by default); the webapp follows `prefers-color-scheme`.
- **iOS (SwiftUI):** mirror tokens in an `enum FSColor` / `enum FSSpace`; resolve the theme from `colorScheme`. Text uses the system font in the roles of §3 (monospaced design for the label voice).
- **Android (Jetpack Compose):** put tokens in a `FlagshipColors` data class and a `FlagshipTypography` object, exposed via `MaterialTheme` overrides, with the same roles.
- **Forbidden everywhere:** drop shadows on cards (floating layers only), gradient page backgrounds or buttons, glassmorphism (a sticky header or tab bar may blur what scrolls under it, like the site's nav; nothing else), neumorphic insets, animated stars / particles, "matrix"-style background canvases, emoji used as icons, icons inside tinted tiles, pill-shaped buttons and badges, centered hero-style empty states.
- **Encouraged everywhere:** generous whitespace, hairline 1 px borders, exactly one accent hue per surface, real numbers in copy, sentence-case everything, dark mode that was actually drawn instead of inverted.

---

## 12. Done means

A page or screen passes review when:

1. Every color is a token from §2.
2. Every font size and line-height is from §3.1.
3. Every spacing value is on the §4 grid.
4. Every radius is one of the three in §5 (or round, for dots and avatars).
5. There is exactly one primary CTA above the fold.
6. The copy could be read aloud to a non-technical friend without translation.
7. With `prefers-reduced-motion: reduce`, the page is still fully usable.
8. In light theme, in dark theme, on a 320 px screen, and at 200 % zoom — it still looks right.

If any of those is false, it isn't ready.
