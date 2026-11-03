# Reviewing a translation

You are checking a machine translation of Flagship, a personal-cloud product whose users trust it with their keys and data.
Wrong words in pairing, unlock, backup and recovery screens are a trust problem, not a style problem.

**Files.** For each surface directory under `i18n/` (and `i18n/web/`), `en.json` holds the English and `<lang>.json` the
translation, keyed identically. `ctx` says where a string appears (file:line, what it is attached to). The webapp (`i18n/webapp`) and the pages the box serves (`i18n/box`) are keyed by the English sentence itself; HTML in a key (`<strong>`, `<code>`, entities like `&lt;`) must be kept as it is. Web segments are in
`i18n/web/segments.json` (`en`, `kind`, `pages`) with translations in `i18n/web/<lang>.json`.

**Check, in this order**
1. Meaning: does it say what the English says, no more and no less? Warnings stay warnings; irreversible actions stay clearly irreversible.
2. `i18n/glossary.json`: keep-terms untouched (Flagship, Studio, TLS …); the language's chosen word for server / phone / device / backup / recovery / unlock / pair used every time.
3. Placeholders: `%1$s`, `%@`, `%lld`, `{0}`, `<1>…</1>` and the like present, same count, order may change. Run `npm run i18n` — it catches these mechanically.
4. Register and tone: direct and plain, the same as the English; formal/informal address consistent per language (tu/vous, du/Sie, usted/tú, です/ます).
5. Length: buttons and tab titles must fit; flag anything much longer than the English.
6. Plurals (`one`/`other`) read correctly; no sentence assembled by gluing words around a number.

**How to change one.** Edit the value in `<lang>.json` (never the generated resource/catalog files), then run `npm run i18n`
and `node scripts/i18n-<surface>.mjs build` (`pwa`, `box`, `android`, `ios`, `web`). Mark a string you are unsure about by adding `"…": "…"` to a `review-notes.md` next to the file rather than guessing.

**Do not** translate: brand and protocol names, code, file names, domains, keyboard shortcuts, the contents of `<1>…</1>` that wrap code.

**voi.ci site (`i18n/voici-site`, 2026-11-02, drafted by an agent, needs native review).** 85 strings of the public
page at voi.ci/<username> (sign-in sheet, thread, report sheet, error states). Keyed by the English sentence like the
webapp; rebuild with `node apps/voici-site/i18n.mjs build` and check with `node apps/voici-site/i18n.mjs check`.
Review first: "Messages are private. If someone reports your message, Flagship can see which account sent it.", the
two "You appear …" lines, and the report reasons (legal meaning of "Illegal content", "Pretending to be someone else").
The footer's "Terms" and "Report abuse" links (to the control apex's /terms and /abuse#voici) were added later
(chunk G); check "Terms" reads as the legal terms of service in each language.

**Messages and voi.ci pages in the iPhone app (`i18n/ios`, 2026-11-02, drafted by an agent, needs native review).**
129 strings in es, fr, de, pt-BR, ja and zh-Hans: the Messages tab, the page editor, the thread, the sign-in approval
screen, Settings > Messages, their error lines, and the two pushes (`New message`, the page-drafts alert). 72 reuse the
webapp's or Android's wording for the same English, 57 are new. Rebuild with `node scripts/i18n-ios.mjs build`.
Review first: the rules sheet ("Your page and your messages must not contain …", "Anyone can report …", "Messages are
private …"), the report sheet's line "Flagship gets this message as it was sent, sealed. It can then see which account
sent it, not what it says.", the publish warning ("Anyone can see this page. It shares your username …"), "This page was
removed by Flagship. You can appeal from flagshipserver.com/abuse." and the two "Try again %@" lines (the `%@` is a
relative date like "tomorrow" or "in 3 hours", from the system: check the sentence reads with it, ja and zh-Hans put
it before the verb). "Visitor " (with the trailing space) is the prefix of a pseudonym like "Visitor 4F3A"; keep the
space. "Rotate" is the inbox-key rotation (es/pt-BR use "Cambiar"/"Trocar", the Android wording).

**Messages FAQ on the website (`i18n/web`, 2026-11-02, drafted by an agent, needs native review).** 14 segments of the
new "voi.ci pages & Messages" section of `faq.html` (questions on what a page is, who can write, what Flagship can read,
report and block, the Apple/Google device check). The legal pages (terms, privacy, abuse) stay English-only on purpose
(`i18n/web/pages.json`). Review first the answer on what Flagship can read, and keep the in-app names it quotes
("Accept messages", "Requests", "Report this page") identical to the app's and the voi.ci site's translations.

**New 0.3 website pages (`i18n/web`, 2026-11-02, drafted by an agent, needs native review).** 80 segments of four pages
added in 0.3 that had shipped English-only: `dibs.html` (the .com name-dibs window, 21), `security/runtime.html` and
`security/iso-seed.html` (verify the Node runtime and the boot seed, 55 between them, their shared footer included) and
the framing prose of `security/hall-of-fame.html` (4; the write-ups were translated afterwards, see "Every customer-facing page" below). The dibs status
sentences now live in the page (`#dibs-messages`) and the script only fills in the date (`<1/>`, formatted in the page's
language). Review first: the four dibs status lines (the date lands where `<1/>` is; check each reads with a long date),
"There is no appeal process.", the "$20, once." line (currency format), the dibs-window word, which must match the apps'
(es "ventana de reserva", fr "période de réservation", de "Vorrangfenster", pt-BR "janela de prioridade", ja "優先期間",
zh-Hans "优先认领期"), and on the runtime page "What this proves, and what it does not." and the table headings ("Security
floor", "Lock digest", "Sequence"). The seed is "imagen base" / "image de base" / "Seed" / "imagem-base" / "シード" /
"种子镜像"; "lock" (runtime lock) is kept as "lock" in pt-BR and de, "bloqueo"/"verrou" in es/fr: pick one per language.
`node scripts/i18n-web.mjs check` now fails on any English page under `apps/web/public` that is in neither `pages` nor
`englishOnly` (with a reason) in `i18n/web/pages.json`.

**Hard-coded strings moved into the catalogs (2026-11-02, drafted by an agent, needs native review).** Found by the new
gate (`scripts/i18n-literals.mjs`, part of `npm run i18n`). iOS (`i18n/ios`): 49 strings of the quantum-safe protection
screen, its refusals and the quantum-safe connection errors (37 reuse Android's wording for the same English; new are the
nine in `PqBoxChannel.swift`/`QuantumSafety.swift` such as "This server only accepts quantum-safe connections, …", "An
older recovery path that is not quantum-safe stays open." and "Apple push"), plus "Trust its new key" and "Email" (the
voi.ci page editor's caption for a mail link; also new in `i18n/webapp`). Studio for Mac (`i18n/studio-mac`): "The image
could not be handed to the helper.", "The helper would not accept that disk.", "Couldn't unmount the disk: %@" (de uses
"aushängen"; check it reads as unmount, not eject). The Studios' version label "Beta" (`studio-mac`, `studio-linux`,
`studio-windows`) reuses the iPhone app's translation. Android (`i18n/android`, keys `access_list_*`): the ten access-list
line errors ("one host per line" …), copied from the iPhone app's reviewed wording.

**Every customer-facing page (`i18n/web`, 2026-11-02, drafted by agents, needs native review).** Owner rule: everything a
customer sees is translated, except server error sentences. 106 new segments in all six languages: the open-in-app page
(`open/index.html`: the headline and line for each app link, `/join` … `/voici-sign-in`, the store buttons, "or continue
with the web app"), the short-URL fallback (`disambiguate.html`), the Studio download page (`studio/index.html`), the
status board (`status/index.html`, including the words its script shows: "operational", "degraded", "down",
"Auto-refresh: on/off", the probe tooltip), the security report form's replies ("Submitting…", "Thank you. Reference:
<1/>. We'll be in touch." …) and the four hall-of-fame write-ups (`security/hall-of-fame.html`). The Worker serves the
open-in-app page and `/studio` at their own URL in the visitor's language. The switcher's accessible name ("Language")
is in `scripts/i18n-web.mjs` `LANGUAGE_LABEL`. Review first: the hall-of-fame write-ups (security meaning must be
exact): "blessing" (relay-hub blessing; drafted es "bendición", pt-BR "bênção", fr "bénédiction", de "Segen", ja "承認",
zh-Hans "认可": keeping the English word may read better), "fails closed" (each language drafted a literal form), "trust
lockdown" (de "Vertrauenssperre"), "squatted" names, "passphrase-gated wrapped-key fetch", and the "credit pending the
reporter's preference" line (fr is long). On the open-in-app page, "Let a browser in with the Flagship app" (zh-Hans
"让浏览器进入" may read awkwardly) and the quoted page name "Access control" (matches the webapp's own label in each
language). On the Studio page, the menu path "Add server → Pair with Studio" is translated literally: it should match
the app's real labels (the English itself predates the current "Add a server" wording). On the status board, "Upstream",
"Heap used", "Passthrough" and the pill words; pt-BR and de keep "Status" as is.

**0.3 launch texts, added 2026-11-02 (drafted by an agent, needs native review).** In `i18n/web/<lang>.json`: the
13 new segments of `blog/flagship-0-3.html` (voi.ci page and Messages, the server time limit, Android 10 and the name
rules, the Node.js runtime check). In `store/listings/<lang>.json`: the new voi.ci, time limit, runtime, Android 10
and names bullets in both stores' descriptions and What's new texts, and the rewritten Google Play What's new (500
characters at most; `node scripts/store-assets/listings.mjs counts`). Review first: the end-to-end encryption
sentence, "senders appear as visitors, never by name", and the time-limit sentence (it must match the server page's
"If no admin opens Flagship for:" wording in each language).
