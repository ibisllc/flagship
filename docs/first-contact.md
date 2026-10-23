# First contact: pinning a server's own key

Owner decisions, 2026-10-24. A server makes its own identity key (STK) at install. The phone pins
that key the first time it blesses the server and checks everything against the pin from then on.
`.com`'s word about a server's key is never a trust input after that, and at the first moment it is
checked by a one-time enrollment secret and a six-digit code.

Every box today has a random STK (`install-helper gen-identity`). Nothing derives it from the UMK:
`ServerKeys.deriveStkPub(UMK, domain)` on iOS and Android matches no real box, so pins built on it
never formed. Since 0.3 refuses a known server without a pin, that anchor has to go.

## What the box does (built)

- **Enrollment proof.** The recipe may carry `enrollmentKeyHex`, a one-time 32-byte secret, as an
  unsigned sibling of the signed blob (like `swkHex`). The builder copies it into
  `/var/flagship/install-blob.json`. The box's first "is this your server?" request (the entitlement
  request, `POST /api/server/:d/secret-request`, purpose `entitlement`) carries
  `deviceInfo.enrollmentProof` = HMAC-SHA256(secret,
  `flagship/enrollment-proof/v1|<serverDomain>|<stkPubHex>|<authCode.serial>`). `.com` passes
  `deviceInfo` through unread. After the blessing the box removes the secret from disk.
- **Server code.** Six digits: first 4 bytes of SHA-256(`flagship/server-code/v1|<stkPubHex>`),
  big-endian, mod 1,000,000. The box writes it to the login banner (`/etc/issue.d`) and once to the
  console, plus a fixed line for Studio: `flagship-server-code <domain> <code> <stkPubHex>`.
- **App-name certificate grant** (`flagship/server-wildcard-grant/v1`, same moment): see below.

Protocol: `packages/protocol/src/enrollment.ts`, vectors `test-vectors/enrollment/vectors.json`.
Ports with tests: Swift `FlagshipCore/Enrollment.swift`, Kotlin `core/Enrollment.kt`, webapp
`lib/enrollment.js` (`newSecret`, proof check, `serverCode`).

## What the clients do (to build on feat/UX)

1. **Recipe.** Whoever creates a server (iOS, Android, webapp) generates a fresh secret, puts it in
   the recipe as top-level `enrollmentKeyHex`, and keeps a copy for that server: Keychain
   ThisDeviceOnly / Keystore-wrapped / the webapp's wrapped store, never synced. Delete it once the
   server is pinned.
2. **One pin store.** A per-device map `serverDomain → stkPubHex`, persisted, behind one function
   (`pinnedStk(domain)`). It replaces `deriveStkPub` everywhere: cert pins (`CertPinRegistry`,
   `DaemonStatusVerifier`), LAN hints, secret and unlock requests, sealing the disk key, the watch
   delegate.
3. **First blessing** (the entitlement request from a server with no pin yet):
   - Verify the request's signature under the `stkPub` it names.
   - If this device holds the server's enrollment secret, `deviceInfo.enrollmentProof` must verify.
     If it is missing or wrong, refuse and say so: "This server was not built from your recipe. Do
     not approve it." No pin, no blessing.
   - Show the server code computed **locally from that key** (never from anything the box or `.com`
     sends), in a small box directly above Approve: "If your machine has a monitor, it is showing this
     code: 482 913".
   - On Approve: pin the key, mint the entitlement as today, and in the same biometric session sign
     the app-name grant (below) and send it to the box.
   - A device without the secret (another device of the account, a demo account) pins on first sight
     with the same code box.
4. **Studio confirms by itself.** For a VM it hosts, Studio reads the console line
   `flagship-server-code <domain> <code> <stkPubHex>` and tells the paired phone the key it saw. The
   phone treats a match as the code confirmed and shows "Confirmed by Studio" in place of the code box.
5. **After the pin.** Everything from that server is checked against the pin. Seal the disk key only
   to the pinned key. A request, status report or `/pods` entry naming another key is refused and
   shown: "This server's key changed. If you did not rebuild it, do not approve anything for it."
6. **Changing a pin.** Only an explicit re-trust from an admin device: reinstalling the server from a
   new recipe (new secret, new pin) or re-pairing. Never silently.
7. **Existing servers.** A server already paired has no pin. Pin it on first sight after this update,
   with the same code box on its next approval. There are only test accounts before launch.

## App-name certificate grant

Once per server, the admin device signs `flagship/server-wildcard-grant/v1|<user>|<serverDomain>|<stkPubHex>|<issuedAt>`
with the sensitive-order key (admin root where pinned, else the IRK) and posts
`{ issuedAt, signature }` to `POST /api/screens/server-wildcard-grant` on that server. Use the
**pinned** STK. Ports: Swift `ServerWildcardGrant.swift`, Kotlin `ServerWildcardGrant.kt`, webapp
`lib/serverWildcardGrant.js`, vectors `test-vectors/server-wildcard-grant`. `GET` on the same path
says whether the server holds one; an admin device that finds `granted: false` signs it silently
while its session is unlocked. The box restarts once and its next certificate also covers
`*.<user>.<apex>`, so `<app>.<user>` works on whichever server holds it.

## Limits

- Someone who gets the recipe before the owner installs it can build a box that passes the proof. The
  code comparison is what catches that, and only where the owner can see the machine or trusts the
  person reading the code out. A hosting company that runs the VM can always read its memory; only
  hardware attestation (architecture v2) closes that.
- Until a device has pinned a server it has to trust what it sees first; the proof makes that first
  sight trustworthy only on the device that created the recipe.
