# Flagship store assets: creative brief (draft v1, for review by other models before build)

## What we are making
A full, localised set of App Store (iPhone, iPad) and Google Play (phone, 7" and 10" tablet, feature graphic, icon) visuals
for Flagship in en, es, fr, de, pt-BR, ja, zh-Hans: screenshots with captions, plus promo banners/panels.
Every localised asset is generated from one template and one string table, so a language is never a hand-edited one-off.

## The idea in one line
"Your cloud, in your pocket, and nobody else's." Flagship is a personal cloud server you own; the phone is the key.
The visuals should feel like holding a key, not like renting a service: calm, precise, a little ceremonial.

## Look and feel
- Palette: brand teal (#14B8A6 family) against deep ink (#0B1220) and warm paper (#F8FAFC). One accent at a time. No gradients-for-their-own-sake.
- Mark: the square / ring / core logo, used big and cropped as a recurring anchor (e.g. the ring is the phone's camera cutout, the core is the unlock moment).
- Type: one humanist sans for captions (must cover Latin, Japanese and Simplified Chinese with matching weight: e.g. Inter + Noto Sans JP/SC), short sentences, max 6 words per headline.
- Devices: real UI from the app, in a quiet frame (no 3D mockups, no hands). Light and dark variants alternate across the strip.
- Motion-free but with continuity: each screenshot hands a visual element to the next (a teal line, the ring), so the strip reads as one story when scrolled.

## Story (10 slides, 5 minimum if a store trims)
1. Own your cloud: home screen with servers and "online" state.
2. Your phone is the key: the unlock/approve moment (biometric sheet).
3. Install apps in a tap: services list / app store view.
4. Build with AI: the vibe-code screen, an app appearing.
5. Share without giving up control: invite / access list.
6. Backups you can hold: server backup and restore.
7. Nothing leaves unsealed: security/trust view (encrypted at rest, keys on device).
8. Your family, your rules: members and ranks.
9. Watch and widgets: status at a glance (iOS Watch, Wear OS).
10. Get yours: the closing mark and the website name.

Captions are written once in English, then translated by the same pipeline as the app (i18n/store/*.json), so wording matches in-app terms from i18n/glossary.json.

## Localisation rules
- Screenshots are captured from the real app running in each language, with demo data (the fictitious dataset), never mocked text over an English UI.
- Captions: translate meaning, not words; keep each within the same line count; Japanese/Chinese get their own line breaks and slightly larger size.
- Keep-terms stay Latin: Flagship, Studio, TLS, Face ID.
- No flags, no stock "global" imagery; the language is shown by the UI itself.
- Right-to-left is not in scope yet.

## Deliverables and sizes (confirm against current store specs at build time)
- iOS: 6.9" and 6.5" iPhone, 13" iPad (and 12.9" if still required); app preview optional.
- Android: phone (16:9 and 9:16 up to 3840px), 7" and 10" tablet, feature graphic 1024x500, hi-res icon 512, Wear OS screenshots.
- Per language: 10 slides x device classes; one banner per store.
- Files land in store/assets/<platform>/<lang>/ with a manifest; a check fails the build if any language lacks a size.

## Build plan (what Claude would do once approved)
1. Fix the demo dataset and a capture script that drives iOS simulator and Android emulator through the 10 states in each language.
2. One HTML/SVG layout template per slide type, rendered headlessly to PNG at each size, fed by i18n/store strings and the captures.
3. Banners/feature graphic from the same template system.
4. A review sheet (contact sheet per language) for the language reviewer, and a gate in `npm run i18n`.

## Questions for the reviewing model
- Is "your phone is the key" the strongest hook for a cold store visitor, or should slide 1 lead with the AI-builds-your-app moment?
- Which three slides would you cut for a 5-slide store listing?
- Suggest headline variants (max 6 words) per slide with a stronger voice, avoiding hype words.
- Critique the palette and type pairing for Japanese and Chinese legibility at thumbnail size.

## Revision notes

(Add one line per change: who or which model, what, why.)
