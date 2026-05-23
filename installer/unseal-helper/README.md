# flagship-unseal

A tiny static Go binary that opens a phone-sealed boot secret using the box's
Ed25519 identity (STK) seed. It exists for **one** job: the **pre-unlock LUKS
unseal** in the initramfs.

## Why this exists

On the burner / live boot path the disk is LUKS-encrypted. `boot-stage.sh` runs
in the **initramfs, before the root is unlocked**, where `/opt/flagship` (node +
`@flagship/protocol`) sits on the still-encrypted root and is unavailable, and
plain `openssl` can't do the Ed25519→X25519 private-key birational map or an
AES-GCM open of the seal format. So the box needs a self-contained static binary
on the unencrypted `/boot` that unseals the phone's reply with the box's STK
key.

The **entitlement** path does *not* need this — it runs post-unlock in the
daemon, which has the full protocol available. This helper is **only** for the
pre-unlock unseal.

It is **wire-compatible, byte-for-byte**, with:

- `packages/protocol/src/encryption.ts` — `sealForRecipient` /
  `sealForEd25519Recipient` / `openSealedFromEd25519Recipient`
- `packages/protocol/src/phoneEndpoint.ts` — `buildSealedSecretResponse` /
  `openSealedSecretResponse`

A wire mismatch here would brick a server's unlock, so the TS→Go cross-check
(below) is the load-bearing gate, not a Go-only round-trip.

## CLI

The box's STK private key is the 32-byte Ed25519 **seed** (the `privateKey` half
of the protocol's `Keypair`).

### Raw sealed blob (`sealForEd25519Recipient`, `AutoUnlockLeaseV2.sealedKey`)

```
flagship-unseal --identity-priv-hex <64 hex> --sealed-hex <hex>
```

→ prints the unsealed secret as hex on stdout (newline-terminated). Add `--raw`
to write the raw secret bytes instead of hex.

### SealedSecretResponse (the phone's nonce/purpose-bound reply)

Provide the sealed blob plus the `(nonce, purpose)` of the `SecretRequest` the
box actually sent; the bound context header is verified before the secret is
returned (rejects a response replayed against a different request / purpose):

```
flagship-unseal --identity-priv-hex <64 hex> --sealed-hex <hex> \
                --response --nonce-hex <hex> --purpose unlock-key
```

Or feed a `SealedSecretResponse` as JSON (the wire shape from
`phoneEndpoint.ts`, with the `sealed` bytes rendered as `sealedHex`) on stdin or
from a file:

```
flagship-unseal --identity-priv-hex <64 hex> --response-json -        # stdin
flagship-unseal --identity-priv-hex <64 hex> --response-json reply.json
```

The JSON's embedded `requestNonceHex` + `purpose` are used as the expected
`(nonce, purpose)` — these are echoes the daemon should have cross-checked
against the request it sent before invoking this tool.

### Exit codes

`0` on success (secret on stdout). Non-zero with a message on stderr on **any**
failure: bad/short key, malformed hex, GCM tag mismatch (wrong key or tampered
ciphertext), or a `(nonce, purpose)` mismatch in the bound context.

## Format matched (exact)

- **Seal blob layout**: `[eph_x25519_pub:32][nonce:12][AES-256-GCM ct+tag:var]`.
- **Recipient X25519 private scalar** (the birational map = libsodium
  `crypto_sign_ed25519_sk_to_curve25519` = noble `toMontgomerySecret`):
  `scalar = clamp( SHA-512(seed)[0:32] )`, where `clamp` is RFC 7748 X25519
  clamping (`b[0] &= 248; b[31] &= 127; b[31] |= 64`). This is derived from the
  Ed25519 **seed**, *not* a coordinate map of the public key.
- **Shared secret**: `X25519(scalar, eph_pub)` (standard RFC 7748;
  `golang.org/x/crypto/curve25519`, which clamps the scalar again — idempotent —
  masks bit 255 of the peer u-coordinate, and rejects all-zero/low-order
  output, matching noble).
- **Key derivation**: `HKDF-SHA256(ikm=shared, salt=eph_pub,
  info="flagship.seal.v1", len=32)`.
- **AEAD**: AES-256-GCM, 12-byte nonce, 16-byte tag, no AAD.
- **SealedSecretResponse inner payload** (before sealing):
  `[ctxLen:4 big-endian][ctx][secret]`, where
  `ctx = "flagship/secret-response/v1" | hex(nonce) | purpose` (canonical-bytes
  `|` separator, UTF-8). On open the helper re-derives `ctx` from the
  caller-supplied `(nonce, purpose)` and rejects any mismatch.

## Build (reproducible, static linux/amd64)

```
make build               # -> dist/flagship-unseal (CGO-free static ELF, ~2.5 MB)
make verify-reproducible # builds twice and cmp-asserts byte-identical output
make test                # go test ./...
make vet                 # go vet ./...
```

The shipped build is:

```
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false -ldflags '-s -w' -o dist/flagship-unseal .
```

`-trimpath` + `-buildvcs=false` + `-s -w` make two clean builds on the same Go
toolchain byte-identical. The prebuilt binary is **not** committed
(`dist/` is gitignored); wave 4 decides build-at-install vs commit-prebuilt. The
helper has only one external dependency, `golang.org/x/crypto`, pinned in
`go.mod` / `go.sum`.

## The gate (wire-compat is the requirement)

The authoritative check is a **TS→Go cross-check**, not a Go-only round-trip:
`tools/unseal-crosscheck` seals known secrets with the **real**
`@flagship/protocol` and asserts this binary recovers them byte-for-byte — for
both a raw `sealForEd25519Recipient` blob and a `SealedSecretResponse`, plus
tamper cases (flipped ciphertext, wrong identity key, wrong nonce/purpose) and a
**pinned vector** frozen from a known protocol so a future wire change is caught.
That pinned vector is also embedded in the Go unit test
(`internal/unseal/unseal_test.go`) so `go test ./...` alone catches drift even
without Node.

Run it:

```
# from repo root
npx vitest run tools/unseal-crosscheck
```
