# `.maintainers/notices/`

The maintainer-signed security notice every Flagship app shows
(`docs/security-notices.md`).

- `current.json` is the notice in force, or `null` for none. The `.com`
  Worker bundles it and serves it at `GET /api/notices`; the apps verify it
  themselves against the baked maintainer pin. It is only ever written by
  `node scripts/security-notice.mjs ... --sign`, which signs with the cold
  ca-track YubiKey.
- `history/<seq>-<kind>.json` keeps every notice ever signed, so the next
  `seq` is always above the highest one apps may have remembered.

Never edit these by hand: an edited notice fails its signature check in every
app and is ignored (apps fail open).
