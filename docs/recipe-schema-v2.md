# Flagship recipe schema (v2)

A **recipe** is a signed `InstallBlob` envelope that authorizes one Flagship pod
to register with `.com` under a specific username + server-domain. It's the
wire-form the phone produces, the desktop forwards via QR-pipe (or downloads
as a `.json` file), and the Builder consumes when writing a USB drive.

## Schema

```jsonc
{
  "version": 2,                          // single integer, currently 2
  "serverDomain": "home.harry.flagship.services",
  "username": "harry",
  "serverName": "home",                  // DNS label
  "phoneDelegatedPubKey": "<64-hex>",    // Ed25519 32 B
  "registrationUrl": "https://flagship.services/api/server/register",
  "authCode": {
    "version": 1,                        // distinct from blob.version
    "serial": "01ABCDEF…",
    "username": "harry",
    "serverName": "home",
    "serverDomain": "home.harry.flagship.services",
    "delegatedPubKey": "<64-hex>",
    "userPubKey": "<64-hex>",            // the user's IRK pub
    "issuedAt": 1779000000000,           // ms since epoch
    "expiresAt": 1779021600000           // ms since epoch — THE TTL
  },
  "authCodeUserSignature": "<128-hex>",  // IRK over canonical authCode
  "installerGitRef": "main",             // pinned git ref (tag preferred)
  "rckPubKey": "<64-hex>",               // routing-control-key pub
  "blobSignatureHex": "<128-hex>"        // IRK over canonical install-blob
}
```

## Canonical bytes (signature input)

The Builder verifies `blobSignatureHex` against the bytes produced by joining
these 12 fields with `|`:

```
flagship/install-blob/v1 | 2 | serverDomain | username | serverName |
phoneDelegatedPubKey(hex) | registrationUrl | authCode.serial |
authCode.userPubKey(hex) | authCodeUserSignature(hex) | installerGitRef |
rckPubKey(hex)
```

Notes:
- Tag stays `flagship/install-blob/v1` — the inner `version` field (2)
  discriminates v1-vs-v2 inputs by byte difference, preserving signature-domain
  separation.
- `blob.issuedAt` and `blob.expiresAt` were dropped in v2 (they had no
  consumer; `authCode.expiresAt` is the sole TTL).
- `authCode` has its own canonical-bytes for `authCodeUserSignature` —
  unchanged at v1.

## Single TTL

`authCode.expiresAt` is the single deadline gating the install. Three things
enforce it:

1. **Phone picker** clamps to `[5min, 24h]` (default 6h). iOS / Android /
   webapp UI all share these bounds.
2. **Builder** refuses to consume a recipe whose `authCode.expiresAt < now`
   (see `packages/flagship-builder/src/loadBlob.ts`).
3. **Worker** at `/api/server/register` refuses when
   `now > authCode.expiresAt` **and** when
   `authCode.expiresAt - authCode.issuedAt > 24h` (anti-spam cap; defense
   in depth against an outdated client signing arbitrarily long expiries).

## Verification flow (Builder)

1. Read the JSON.
2. Parse + extract `blobSignatureHex`.
3. Reconstruct the canonical-bytes from the 12 fields above.
4. `ed25519_verify(canonicalBytes, blobSignatureHex, authCode.userPubKey)`.
5. If verify fails or `now > authCode.expiresAt`, refuse with a specific
   `BuilderLoadError` code.

The Builder **never** calls `flagshipserver.com` to verify — the embedded
phone signature is the sole trust root. `.com`'s only involvement in the
recipe→install pipeline is the daemon's POST to `/api/server/register`
after first boot.

## Where each implementation lives

| Component | Path |
|---|---|
| Canonical-bytes (TS, ground truth) | `packages/protocol/src/auth.ts` (`canonicalInstallBlob`) |
| iOS / shared canonical-bytes | `apps/mobile/shared/Sources/FlagshipCore/InstallBlob.swift` |
| Android canonical-bytes | `apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/InstallBlob.kt` |
| Webapp canonical-bytes | `apps/web/public/webapp/lib/buildDraft.js` |
| Builder verify (TS / CLI) | `packages/flagship-builder/src/loadBlob.ts` (delegates to `verifyInstallBlob`) |
| Builder verify (Mac app) | `apps/builder-mac/Sources/FlagshipBuilderCore/Recipe.swift` (`canonicalBytes`) |
| Builder verify (Windows app) | `apps/builder-windows/src/Recipe.cs` (`CanonicalBytes`) |
| Worker enforce | `packages/control-plane/src/serverRegister.ts` |

All of these MUST produce byte-identical canonical-bytes given identical input.
The cross-platform tests in `apps/mobile/ios/Tests/.../InstallBlobTests.swift`
and `apps/mobile/android/.../InstallBlobTest.kt` lock in the bytes; the
canonical-bytes regression in `CreateServerTtlTests.swift` re-asserts the
12-field shape; the builder golden vectors live in
`apps/builder-mac/Tests/.../RecipeTests.swift` + `apps/builder-windows/tests/RecipeTests.cs`.

> ⚠️ **Two commitment points per builder — easy to miss.** A builder not only
> *verifies* the canonical bytes, it also *re-serializes* the blob into the ISO
> trailer (`installBlobToJson` in `packages/iso-personalizer/src/trailer.ts`;
> the hand-rolled `installBlobJSON` in the Mac/Windows `AlpinePersonalize`). Any
> optional blob field the canonical bytes commit to — `bootUnlockMode`,
> `certAutonomy`, and whatever comes next — MUST be emitted in **both** the
> canonical-bytes builder and the trailer serializer, or the daemon's POST to
> `/api/server/register` fails the Worker's re-verify even though the local burn
> "succeeded". (This is exactly the `certAutonomy` regression that broke the
> native builders while the TS path — which reuses the protocol helpers — stayed
> correct.)
