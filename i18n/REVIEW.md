# Reviewing a translation

You are checking a machine translation of Flagship, a personal-cloud product whose users trust it with their keys and data.
Wrong words in pairing, unlock, backup and recovery screens are a trust problem, not a style problem.

**Files.** For each surface directory under `i18n/` (and `i18n/web/`), `en.json` holds the English and `<lang>.json` the
translation, keyed identically. `ctx` says where a string appears (file:line, what it is attached to). Web segments are in
`i18n/web/segments.json` (`en`, `kind`, `pages`) with translations in `i18n/web/<lang>.json`.

**Check, in this order**
1. Meaning: does it say what the English says, no more and no less? Warnings stay warnings; irreversible actions stay clearly irreversible.
2. `i18n/glossary.json`: keep-terms untouched (Flagship, Studio, TLS …); the language's chosen word for server / phone / device / backup / recovery / unlock / pair used every time.
3. Placeholders: `%1$s`, `%@`, `%lld`, `{0}`, `<1>…</1>` and the like present, same count, order may change. Run `npm run i18n` — it catches these mechanically.
4. Register and tone: direct and plain, the same as the English; formal/informal address consistent per language (tu/vous, du/Sie, usted/tú, です/ます).
5. Length: buttons and tab titles must fit; flag anything much longer than the English.
6. Plurals (`one`/`other`) read correctly; no sentence assembled by gluing words around a number.

**How to change one.** Edit the value in `<lang>.json` (never the generated resource/catalog files), then run `npm run i18n`
and `node scripts/i18n-<surface>.mjs build`. Mark a string you are unsure about by adding `"…": "…"` to a `review-notes.md` next to the file rather than guessing.

**Do not** translate: brand and protocol names, code, file names, domains, keyboard shortcuts, the contents of `<1>…</1>` that wrap code.
