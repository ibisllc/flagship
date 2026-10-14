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
- **On a 401**, mint again once if the keys are at hand; otherwise keep the
  last state on screen, mark status as paused until the next unlock, and
  never raise a prompt from a background poll.
- **Servers** mint with their STK whenever they need one (they read
  `/apps/aliases`).

Pre-release, `.com` enforces this from the first deploy: builds that don't
send tokens lose live status for real accounts (demo accounts are
unaffected). Set the secret before deploying:
`openssl rand -hex 32 | wrangler secret put ACCOUNT_READ_TOKEN_SECRET`.
