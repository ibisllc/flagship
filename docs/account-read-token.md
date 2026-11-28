# Account read tokens

Who can read an account's servers, devices and apps from `.com`.

## Why

`/api/users/<u>/pods` and `/stream` used to answer anyone who knew a
username, and usernames are public (every server's name sits in
Certificate Transparency logs). They returned each server's liveness and
last heartbeat, health, app names, which app each server leads, whether a
server was waiting at its unlock prompt, pending orders and why a server was
revoked: a live feed of the owner's habits. `/audit` (device history),
`/apps/aliases` and `/apps/<id>/links` (app names) leaked the same way.

Server names stay public (CT, DNS) and so does
`/api/server/by-domain/<d>` (servers verify each other with it); it no
longer says why a server was revoked.

## The token

`POST /api/accounts/<u>/read-token` returns `{ token, expiresAt }`. The
token is opaque (`art1.<claims>.<HMAC>`, keyed by the Worker secret
`ACCOUNT_READ_TOKEN_SECRET`); only `.com` reads it. Send it as
`authorization: Bearer <token>`, never in a URL.

Three signers can mint one. Each uses an envelope it already has; the
vectors in `packages/protocol/test-vectors/account-read-token/` pin all
three (`scripts/gen-account-read-token-vectors.mjs`).

| Signer | Request | Lifetime |
|---|---|---|
| A device of the account | `account-directory-request/v1` over `POST /api/accounts/<u>/read-token`, in the `x-flagship-device-id/-device-pub/-request-id/-issued-at/-signature` headers (the same headers as `/profile`) | 30 days |
| The account's IRK | body `{auth, authSignature}`: a `device-endpoint-claim/v1` with `endpointLabel: "account-read-token"`, a fresh 32-byte nonce, `expiresAt` a few minutes out | 24 hours |
| One of the account's servers | body `{box, signature}`: `box-read-token-request/v1` (`username`, `serverDomain`, `stkPubHex`, `issuedAt`, 16-byte `nonceHex`) signed with its STK | 24 hours |

Every request must be within 5 minutes of `.com`'s clock and is accepted
once (request id / nonce). Every read re-checks the signer: a revoked
device, a rotated IRK or a revoked server stops reading on its next
request.

## What it gates

With a token for `<u>` (otherwise `401`, `cache-control: private,
no-store`):

- `GET /api/users/<u>/pods` and `GET /api/users/<u>/stream`
- `GET /api/users/<u>/audit`
- `GET /api/users/<u>/apps/aliases` and `GET /api/users/<u>/apps/<id>/links`
- `GET /api/users/<u>/re-pair`, the pending recovery with the initiate's
  signatures (security report F3): the account's devices show the banner and
  the admin veto from it, its servers verify a completed re-pair with it
  (the box's STK token). An anonymous caller gets the 401 and nothing of the
  row; 0.3 store builds lose the pending-recovery banner until they update,
  and a box without the endorsed release that sends its token holds the old
  key until it updates.
- `GET /api/server/<d>/sealed-luks-key`, the disk key sealed to the account
  IRK: only a token minted by a device of the server's account or its IRK
  (a server's own token is refused). It is classical ciphertext, so anyone
  holding a copy opens it once X25519 falls.
- `GET /api/server/<d>/unlock-key/lease-v2`, the disk key sealed to the box:
  only that box's own STK token (boxes read leases from the boot worker).

Demo accounts (a `demo_users` row) are keyless by design and read without a
token, so store review keeps working on any build.

Without a token:

- `GET /api/order/<serial>/health` returns `{serverDomain, health}` for the
  server an order created. Studio uses it; the order serial is the
  capability.
- Keyless remote (companion) browsers read nothing from `.com`; they show
  only the server they're attached to, from that server.

## Clients

- **Mint silently, never prompt.** Mint when the account keys are already
  unlocked in this session (the app's unlock, a signing operation), keep
  the token device-local and outside biometrics, and wipe it with the
  profile. Prefer the device path (30 days); use the IRK path when the
  device has no account device identity.
- **Keep the device key at hand.** The first time a session unwraps the UMK
  (any unlock or signing operation), store this device's account device key
  on the device (device-local, outside biometrics, as joined devices already
  do), so later mints use the device path without the UMK. It only signs
  account-directory requests (the sealed profile and read tokens).
- **On a 401**, mint again once if the keys are at hand; otherwise keep the
  last state on screen, mark status as paused until the next unlock, and
  never raise a prompt from a background poll.
- **A refused read is never "no servers".** With no token and nothing on
  screen yet, Home says the server list is locked and offers one button
  ("Show my servers") that unlocks the account key (one biometric or
  passcode prompt), mints, and reloads. The app's own lock is optional, so
  this button is how a phone with the lock off gets its first token.
- **Servers** mint with their STK whenever they need one (they read
  `/apps/aliases`).

Pre-release, `.com` enforces this from the first deploy: builds that don't
send tokens lose live status for real accounts (demo accounts are
unaffected). Set the secret before deploying:
`openssl rand -hex 32 | wrangler secret put ACCOUNT_READ_TOKEN_SECRET`.

## Org routes

An org's reads (`/api/orgs/<orgId>/...`, `docs/enterprise-accounts.md`) take an **org read token**:
`POST /api/orgs/<orgId>/read-token` with body `{request, signature}`, where `request` is a
`flagship/org-read-token-request/v1` (`orgId`, `subject`, `pubHex`, `issuedAt`, 16-byte `nonceHex`;
canonical bytes `TAG|orgId|subject|pubHex|issuedAt|nonceHex`, `packages/protocol/src/orgReadToken.ts`)
signed with Ed25519 by the key named in `subject`:

| Signer | `subject` | Key | Lifetime |
|---|---|---|---|
| A live seat | `seat:<seatId>` | its seat member key or seat admin key (an org admin holds only the admin key) | 7 days |
| A seat waiting for an admin | `seat:<seatId>` | the member key it accepted with (its accept on a live, unexpired invitation) | 7 days |
| One of the org's servers | `box:<serverDomain>` | its STK, as registered at `servers/register` | 24 hours |

The token is `ort1.<claims>.<HMAC>`, under the same `ACCOUNT_READ_TOKEN_SECRET` with its own MAC
context (`flagship/org-read-token/v1`), so an account token never passes as an org token or the
other way round. Same 5-minute freshness and single use as above; the mint has its own rate budget
(`org-read-token`: per source and per org). Every read re-checks the signer against the org as `.com`
verifies it from genesis: a revoked, frozen or lapsed seat, an admin no longer in the record, a
withdrawn or expired invitation, or a server that was revoked or re-registered under another key
stops reading on its next request.

From 0.5 every org GET needs a token, with no compatibility window (old clients and boxes that send
none are refused, 401 `org-read-token-required`). The scope of each route (`orgReadScope` in
`apps/com/src/controlPlaneRoutes.ts`, checked by `requireOrgRead`):

| Route | Scope | Who |
|---|---|---|
| `GET /api/orgs/<id>/plan` | none | public by design (the Business plan's state) |
| `GET /api/orgs/<id>/invites/<seatId>` (the offer) | none | the invite-key proof alone (the joiner has no seat yet); the answer carries the org's `authority` (as `GET .../authority`), so the joiner verifies the chain before it accepts |
| `GET .../export`, `GET .../log` | `admin` | an org admin of the current record (kind `admin`) or a `servers-add` seat |
| `GET .../keys` | `admin-or-box` | as `admin`, or one of the org's servers; ordinary members are refused |
| `GET .../authority`, `.../seats`, `.../ceremonies` | `joining` | a live seat, one of the org's servers, or a seat waiting for an admin |
| every other org GET (`servers`, `directory`, `directory/slices`, `connectors`, `proposals`, `plan-attestation`, `voucher-wallet`) | `any` | a live seat or one of the org's servers |

For `admin`, an org admin's own seat counts with any of its keys (its member key too): a token only
reads, and every write still takes the admin key. Clients (webapp `lib/orgReadToken.js`, iOS and
Android `OrgReadTokens`) mint with the seat member key (an admin seat on a phone with its admin key),
keep the token until 10 minutes before it expires, and mint again once after a 401. Boxes do the same
with the STK (`packages/server-daemon/src/orgReadToken.ts`). Shared vectors:
`packages/protocol/test-vectors/org-read-token`.
