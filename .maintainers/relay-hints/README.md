# Relay hints

`current.json` is `null` (nothing signed) or one `RelayHint` signed offline by the cold
ca-track maintainer authority: the relay's well-known addresses, an advisory the apps use
only when DNS fails. Publishing one is a commit plus a `.com` deploy. Format, rules and why
it is safe: `docs/relay-hints.md`. Sign with `node scripts/relay-hint.mjs`.
