# Messages abuse keys (docs/voici-and-messages.md §9.3)

One X-Wing key pair per quarter (`abuseEpoch`). `.com` seals each Messages key attestation's abuse tag (the
sender's account) to the current public key; only the owner can open one, offline, with a YubiKey touch.

| File | What |
|---|---|
| `list.json` | `{version: 1, entries: [{epoch, xwingPub, notBefore, notAfter, signature}]}`: each entry signed by the cold ca-track key as `flagship/abuse-key/v1\|<epoch>\|<xwingPub>\|<notBefore>\|<notAfter>`. `.com` bundles it and uses only entries that verify. |
| `<epoch>.pub.json` | the public half and window, written at generation, before signing. |
| `<epoch>.age` | the private 32-byte seed (hex), encrypted with `age` to both owner YubiKeys (`age-plugin-yubikey`). Never in clear on disk. |

Make, sign, rotate: `npm run abuse-key -- generate|sign|status` (`scripts/abuse-key.mjs`). Open a reported tag:
`npm run voici-abuse -- open-tag <report-id>`. Destroy `<epoch>.age` 120 days after its `notAfter`
(attestations live 30 days, reports are accepted 90 days); after that, that quarter's tags can never be opened.
