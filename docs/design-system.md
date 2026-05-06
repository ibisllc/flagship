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

Two themes. Dark is the default (the product lives on a phone at night, on a
laptop in a coffee shop) but light must be first-class — the marketing site
ships in light by default for daytime credibility.

### 2.1 Light theme

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#FAFAF7` | Page background. Warm off-white, not clinical. |
| `--surface` | `#FFFFFF` | Cards, modals, elevated panels. |
| `--surface-sunken` | `#F2F1EC` | Inputs, code blocks, table headers. |
| `--border` | `#E6E4DD` | Hairlines. 1px only, never 2px. |
| `--text` | `#14140F` | Primary copy. Near-black, warm. |
| `--text-muted` | `#6B6A63` | Secondary copy, captions, metadata. |
| `--primary` | `#3B5BFF` | The Flagship blue. CTAs, links, focus rings. |
| `--primary-hover` | `#2C46E0` | Hover / pressed state of `--primary`. |
| `--success` | `#1F8A4C` | "Server online", "cert renewed", green padlock moments. |
| `--warning` | `#B8651A` | Amber. "Cert renews in 3 days". |
| `--danger` | `#C83A3A` | Destructive only. Confirmations, revoke, wipe. |

### 2.2 Dark theme

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#0E0F12` | Page background. Slight blue-black, not pure. |
| `--surface` | `#16181C` | Cards, modals. |
| `--surface-sunken` | `#1C1F24` | Inputs, code blocks. |
| `--border` | `#2A2D33` | Hairlines. |
| `--text` | `#F2F1EC` | Primary copy — same warm off-white as light `--bg`. |
| `--text-muted` | `#9A9A93` | Secondary copy. |
| `--primary` | `#7E96FF` | Lifted blue for legibility on dark. |
| `--primary-hover` | `#A8B8FF` | Hover / pressed. |
| `--success` | `#4FBE7A` | |
| `--warning` | `#E5A050` | |
| `--danger` | `#E86464` | |

**Rules.**

- Pure `#000` and pure `#FFF` are banned. They look cheap on OLED and on paper-white displays.
- Only `--primary`, `--success`, `--warning`, `--danger` may be saturated. Everything else lives on the warm-neutral axis.
- Subtle gradients are allowed on **accent surfaces only** — the hero illustration, the "your server is ready" celebration card, the status pulse. Never on page or section backgrounds.
- Status colors are semantic, not decorative. Don't paint a button green just because it is encouraging.

---

## 3. Typography

One pair, two roles. Both Google-Fonts-hosted and OFL-licensed, available as
system fallbacks on every target platform.

- **Headings:** **Space Grotesk** — geometric but slightly humanist; reads as
  "engineered" without being cold. Weights 500 and 600 only.
- **Body:** **Inter** — boring on purpose. Weights 400, 500, 600. Use the
  `cv11` and `ss03` OpenType features if available (curved single-storey `g`,
  rounded zero) for a hint of personality.
- **Mono:** **JetBrains Mono** for code, addresses, build codes, fingerprints.
  Weights 400 and 500.

System fallbacks:

```css
--font-heading: "Space Grotesk", ui-sans-serif, system-ui, -apple-system,
                "Segoe UI", Roboto, sans-serif;
--font-body:    "Inter", ui-sans-serif, system-ui, -apple-system,
                "Segoe UI", Roboto, sans-serif;
--font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas,
                monospace;
```

### 3.1 Type scale (1.250 / major third, slightly compressed at the top)

| Token | Size / line-height | Weight | Use |
| --- | --- | --- | --- |
| `display` | 56 / 60 px | 500 | Hero headline only. One per page. |
| `h1` | 40 / 48 px | 500 | Section openers. |
| `h2` | 28 / 36 px | 500 | Subsection. |
| `h3` | 22 / 30 px | 600 | Card titles, modal titles. |
| `h4` | 17 / 24 px | 600 | Inline group labels. |
| `body` | 16 / 26 px | 400 | Default. |
| `body-sm` | 14 / 22 px | 400 | Dense lists, table rows. |
| `caption` | 13 / 18 px | 500 | Metadata, status pill text, timestamps. |
| `mono` | 14 / 22 px | 400 | Code, fingerprints, build codes. |

**Rules.**

- Body line-length capped at **68 characters** (`max-width: 36rem`). Reading is the product.
- Headings are sentence case. Title Case is reserved for proper nouns and product names.
- Never use italics for emphasis; use weight (`500`) or the `--text` color against muted siblings.
- Mono inline runs get a tiny (`-1px` letter-spacing, `0.92em` size) optical correction.

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

Three sizes. Period.

| Token | px | Use |
| --- | --- | --- |
| `radius-sm` | 6 | Inputs, pills, small chips. |
| `radius-md` | 10 | Buttons, cards, list items. |
| `radius-lg` | 16 | Modals, hero cards, phone-screen sheet corners. |

Pills (status indicators) override to `999px`. Avatars override to `50%`.

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
CSS, Jetpack Compose, or SwiftUI without a framework.

### 8.1 Button

Three variants, one size by default (40 px tall on web, 44 px on touch). Text
is `body-sm` weight 600. Padding `12px / 20px`. Radius `radius-md` (10).

- **Primary.** `--primary` background, white text. Hover: shifts to `--primary-hover`. Active: `translateY(0.5px)`. Focus: 2 px outline in `--primary` at `outline-offset: 2px`.
- **Secondary.** `--surface` background, `--text` color, 1 px `--border` outline. Hover: border darkens to `--text-muted`.
- **Ghost.** No background, no border. `--text` color. Hover: `--surface-sunken` background. Use inside cards and toolbars.
- **Destructive.** Same shape as primary, but `--danger`. Always require confirmation.

Disabled state: 40 % opacity, no hover, `cursor: not-allowed`.

### 8.2 Input

Single-line text fields. 40 px tall, `--surface-sunken` background, 1 px
`--border`. Padding `12px / 14px`, radius `radius-sm` (6). Label sits **above**
the field at `caption` size, weight 500. Helper text sits below at `body-sm`,
`--text-muted`. On focus: border becomes `--primary`, outline `2px`
`--primary` at 25 % alpha. On error: border `--danger`, helper text
`--danger`. Never use placeholder-as-label.

### 8.3 Card

Background `--surface`, 1 px `--border`, radius `radius-md` (10), padding
`space-6` (24) on desktop / `space-4` (16) on mobile. **No shadow** in either
theme — separation is by border, not by elevation. The only exception is
modals.

A card title is `h3` (22 px). A card may contain at most one primary action,
right-aligned in its footer.

### 8.4 Modal

Centered, max-width 480 px (small) or 720 px (large). Background
`--surface`, radius `radius-lg` (16), padding `space-8` (32). One shadow:
`0 12px 40px rgba(0,0,0,0.18)` in light, `0 12px 40px rgba(0,0,0,0.6)` in
dark. Backdrop: `rgba(14,15,18,0.5)` with a 4 px backdrop blur.

Title `h3`. Body `body`. Footer: secondary action left-or-ghost, primary
action right. Esc closes. Click-outside closes only if the modal has no
unsaved input.

### 8.5 Toast

Bottom-right on desktop, bottom-center on mobile. 320 px wide, radius
`radius-md`, 1 px `--border`, `--surface` background. Left-edge accent: 3 px
strip in the semantic color (`--success`, `--warning`, `--danger`, or
`--primary` for neutral info). Auto-dismiss at 5 s for info / success, manual
dismiss only for warning / danger. Stacks vertically with `space-2` gap.

### 8.6 Status pill

Inline with text or in a card header. Height 22 px, radius `999px`, padding
`2px 10px`, `caption` text weight 500. A 6 px filled dot precedes the label.

| Status | Dot | Background | Text |
| --- | --- | --- | --- |
| Online | `--success` | `--success` @ 12 % alpha | `--success` |
| Renewing | `--warning` | `--warning` @ 12 % alpha | `--warning` |
| Offline | `--danger` | `--danger` @ 12 % alpha | `--danger` |
| Provisioning | `--primary` | `--primary` @ 12 % alpha | `--primary` |
| Idle | `--text-muted` | `--surface-sunken` | `--text-muted` |

The "Online" dot has a subtle 1.5 s pulse (scale 1.0 → 1.15 → 1.0). All other
dots are static.

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

- **Web (vanilla CSS):** ship the tokens as `:root` and `:root[data-theme="dark"]` custom properties; switch via `prefers-color-scheme` + a manual override in `localStorage`.
- **iOS (SwiftUI):** mirror tokens in an `enum FSColor` / `enum FSSpace`; resolve the theme from `colorScheme` + an override in `UserDefaults`. The two fonts ship as bundled OTFs, registered at app launch.
- **Android (Jetpack Compose):** put tokens in a `FlagshipColors` data class and a `FlagshipTypography` object, exposed via `MaterialTheme` overrides. Both fonts are available on Google Fonts' Compose `GoogleFont` provider — no bundling needed.
- **Forbidden everywhere:** drop shadows on cards (modals only), gradient page backgrounds, glassmorphism / backdrop-blur on anything that isn't a modal scrim, neumorphic insets, animated stars / particles, "matrix"-style background canvases.
- **Encouraged everywhere:** generous whitespace, hairline 1 px borders, exactly one accent hue per surface, real numbers in copy, sentence-case everything, dark mode that was actually drawn instead of inverted.

---

## 12. Done means

A page or screen passes review when:

1. Every color is a token from §2.
2. Every font size and line-height is from §3.1.
3. Every spacing value is on the §4 grid.
4. Every radius is one of the three in §5.
5. There is exactly one primary CTA above the fold.
6. The copy could be read aloud to a non-technical friend without translation.
7. With `prefers-reduced-motion: reduce`, the page is still fully usable.
8. In light theme, in dark theme, on a 320 px screen, and at 200 % zoom — it still looks right.

If any of those is false, it isn't ready.
