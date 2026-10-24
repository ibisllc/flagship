# Runbook: the PQ release key

The release ML-DSA-65 key adds a post-quantum signature to every release endorsement. A release
is valid only with **both** the YubiKey's Ed25519 endorsement (unchanged) and the hybrid
companion `flagship/release-endorsement/v2`, once the code pin names the key. Format and rule:
`docs/architecture-v2/pq-suites.md` §12.

Label it exactly: **PQ release signature (software key, YubiKey-encrypted at rest)**. Claims
about it stay "pending external review" (Q01). The ML-DSA key is a software key: it is only as
safe as the two YubiKeys, the encrypted file on your Mac and the paper.

## What lives where

| Thing | Where | Secret? |
|---|---|---|
| ML-DSA seed, encrypted to both YubiKeys | `~/.flagship-release/pq-release-key.age` on your Mac only | yes: never commit, upload or back up to a cloud. Its encryption is classical (P-256 in the YubiKeys) |
| age-plugin-yubikey identity stubs | `~/.flagship-release/yubikey-identities.txt` | no (they only name the YubiKey slot) |
| Paper backup | three rows of base32 on paper, in a safe place apart from the YubiKeys | yes |
| Binding (`release-key` role) | `.maintainers/release-pq/bindings/<keyid>.json` | no, committed |
| Companions | `.maintainers/release-pq/endorsements/<tag>.json` | no, committed |
| The pin (key id + cutover marker) | `packages/protocol/src/releasePqPin.ts` | no, committed; it is what boxes trust |

The plaintext seed is never written to disk: it exists in memory while a command runs and is
wiped after (best effort: JavaScript and the age child process may leave copies in freed memory).

## Before the ceremony

- Both YubiKeys, the one with the Ed25519 release key in PIV slot 9c (the ca-track holder) and
  the backup.
- `brew install age age-plugin-yubikey`, and the maintainers CLI built (as for
  `endorse-release.mjs`; set `FLAGSHIP_MAINTAINERS_DIR` if it is not next to the repo).
- `npx tsc -b` in the repo, on a clean `main` checkout.
- Paper and a pen. No phone camera in the room.

## 1. One age identity per YubiKey

For **each** YubiKey (insert one at a time):

```sh
age-plugin-yubikey --generate --name flagship-release --pin-policy always --touch-policy always
```

It prints a recipient (`age1yubikey1...`) and an identity stub (`AGE-PLUGIN-YUBIKEY-...`).
Append both stubs to `~/.flagship-release/yubikey-identities.txt` (mode 0600) and note both
recipients. The key lives in a retired PIV slot; slot 9c is untouched.

## 2. Make the key

Insert the YubiKey that holds slot 9c, then:

```sh
node scripts/pq-release-key.mjs init \
  --recipient age1yubikey1<first> --recipient age1yubikey1<second>
```

It reads the Ed25519 release key from slot 9c, makes the ML-DSA seed in memory, encrypts it to
both recipients (`~/.flagship-release/pq-release-key.age`), asks for the PIV PIN on the terminal
and a touch to sign the binding, writes the binding to `.maintainers/release-pq/bindings/`, and
prints the paper backup on the terminal (`/dev/tty`, never stdout). Write the three rows down,
check each character, press Enter: the screen is cleared. Note the release key id it prints.

## 3. Prove both YubiKeys open it

For **each** YubiKey:

```sh
node scripts/pq-release-key.mjs verify-yubikey
```

age asks for that YubiKey's PIN and a touch. It must print `OK` with the key id. Then prove the
paper: `node scripts/pq-release-key.mjs restore-from-paper --recipient ... --recipient ... --out /tmp/check.age`
(type the rows; each row has a two-character check, so a typo is caught on that row), then
`rm /tmp/check.age`.

## 4. Pin it

```sh
node scripts/pq-release-key.mjs pin --key-id <id> --require-pq-after auto
node scripts/pq-release-key.mjs show-pub
```

`auto` makes the newest committed endorsement the cutover marker: it and the endorsements it
chains back to stay valid as lineage, never as targets. Then `npx tsc -b`, `npx vitest run`,
and commit the binding and `releasePqPin.ts` together.

A box enforces the pin from the release that contains it: the box runs its own code's pin. So:

1. Retro-sign the marker release, so boxes still have a target right after the cutover:
   `node scripts/endorse-release.mjs --pq-only <marker releaseId> --sign`.
2. Endorse the release that contains the pin as usual (next section). It is the first release
   whose boxes require both signatures.
3. `.com` (`/api/releases`) uses the pin it was built with; deploy it after the pin is on `main`.

## Signing a release

```sh
node scripts/endorse-release.mjs --to <sha> --from <box commit>          # preview
node scripts/endorse-release.mjs --to <sha> --from <box commit> --sign
```

The preview shows `PQ companion: REQUIRED`. With `--sign` you touch the YubiKey three times:
the v1 endorsement (maintainers CLI), opening the age file (PIN + touch), and the Ed25519 half of
the companion (PIN + touch). The companion is checked with the boxes' verifier before it is
written and staged. If the companion step fails, the v1 endorsement is already written: fix the
cause and run `node scripts/endorse-release.mjs --pq-only <releaseId> --sign`. `--no-pq` is
refused once the pin is set.

## Losing things

- **One YubiKey lost or broken:** the other still opens the file. Make a new age identity on a
  replacement YubiKey (step 1), then re-encrypt from paper:
  `restore-from-paper --recipient <survivor> --recipient <new> --force`. Revoke nothing: the
  lost YubiKey cannot open the file without the file, and the file never left your Mac. If the
  file may have left it, treat the key as compromised.
- **The Mac (file) lost:** restore from paper to a new Mac with both YubiKeys as recipients.
- **Both YubiKeys lost:** restore from paper with two new YubiKeys. The Ed25519 release key in
  slot 9c is gone with them; that is the maintainers succession procedure
  (`docs/maintainer-ca-endorsement.md`), and the new Ed25519 key needs a new binding and pin.
- **Compromise (paper copied, file leaked):** run `init` again for a new key, pin the new key id
  alone (edit `keyIds` to remove the old one) and ship that release. Until boxes run it they still
  accept the old key.

## Test mode

Every command takes `--fake-yubikey <dir>`: fake YubiKeys (an AES key and a PIN each) stand in
for age and the token, the PIN comes from `FLAGSHIP_PQ_FAKE_PIN`, the paper code goes to stdout and
is read from stdin. `node scripts/pq-release-key.mjs fake-yubikeys --fake-yubikey /tmp/yk` makes
two. Test mode refuses to write into the repo's own `.maintainers`. The tests
(`scripts/pq-release-key.test.ts`) run the whole ceremony this way, with `--signing-key file:`.
