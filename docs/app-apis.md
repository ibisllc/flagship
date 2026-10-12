# Apps that serve APIs, live connections and their own sign-in

**Status:** owner decisions 2026-10-12; being built. Principle: secure defaults,
flexible services — the owner's machine, the owner's rules.

## 1. Live connections

The box's app proxy streams responses as the app produces them (Server-Sent
Events, long downloads, chunked replies) and passes WebSocket upgrades through
to the app. The access decision (public route, member, API key) is made on the
upgrade request; the identity headers (`X-Flagship-User`, `-Role`, `-Signature`
…) are injected on it like on any request; then bytes flow both ways until
either side closes. Idle and per-app connection limits apply. Postgres stays
inside the box: an app exposes pub/sub to the world through its own WebSocket or
SSE routes, with `LISTEN`/`NOTIFY` behind them.

## 2. Public routes

The AI chooses every URL; the manifest only says which are public.
`access.public_routes` entries are exact paths as before, or an explicit
prefix ending in `/*`: `"/api/public/*"` makes `/api/public/` and everything
under it public (segment-aware: not `/api/publicity`). `"/*"` makes the whole
app public. Nothing is public unless the manifest says so.

## 3. API keys (machine clients)

Scripts, devices and other servers call an app with
`Authorization: Bearer fsk_<keyId>_<secret>`. The owner creates keys on the
app's page:

- These are keys the owner's app ACCEPTS (for their scripts, devices or other
  servers), not a provider's keys (those are env vars). The phone picks `keyId`
  (16 lowercase hex) and a scope (`read`: GET/HEAD/OPTIONS only; `write`:
  everything), and signs
  `flagship/app-api-key/v1|serverDomain|serviceId|keyId|scope|expiresAt|issuedAt`
  with the sensitive-order key (admin root when held, else owner IRK). Keys last
  until revoked: the apps send expiresAt 0 (the field stays in the envelope; a
  non-zero value is still honoured by the box). Vectors: `packages/protocol/test-vectors/app-api-key/vectors.json`.
- `POST /api/screens/services/:id/api-keys` `{grant:{serverDomain, serviceId,
  keyId, scope, expiresAt, issuedAt}, signature, label}` → 200 `{ok, key}` with
  the full secret, shown ONCE; the box stores only a hash. 400 malformed, 403
  bad signature / other server / issuedAt > 10 min off, 404, 409 keyId exists.
- `GET /api/screens/services/:id/api-keys` → `{keys:[{keyId, label, scope,
  createdAt, lastUsedAt, expiresAt}]}`. `DELETE …/api-keys/:keyId` revokes
  (owner session, no signature: it only removes access). Companion sessions:
  read-only.
- Details all clients and the box share: the label is 1–64 characters after
  trimming; the apps preselect **Read**, offer no expiry (owner decision: "we are
  not your mom"); the key is the string `fsk_<keyId>_<43 base64url chars>`; a
  client that gets 409 retries once with a fresh keyId; the box's 403 `error`
  says which check failed in plain words (stale / other server / signature /
  companion).
- The box checks the key before the app sees the request, strips the
  `Authorization` header, and injects `X-Flagship-User: apikey:<keyId>`,
  `X-Flagship-Role: api`, `X-Flagship-Api-Scope: read|write` (signed like the
  other identity headers). Wrong, revoked or expired keys get 401; a `read` key
  on a write method gets 403. Per-key rate limits.

## 4. Cross-origin calls and sibling apps

The box adds no CORS rules: an app sends its own CORS headers and the box
passes them through. Apps are separate origins (each its own subdomain), and
Flagship's session cookie is host-only, so one app's pages can't read
another's responses unless that app allows it. One gap remains, because the
browser treats apps on the same server as the same *site*: app B's page could
make the browser send a form or API call to app A with the owner's Flagship
session attached. So the box treats an unsafe request (anything but
GET/HEAD/OPTIONS) whose `Origin` (or `Sec-Fetch-Site`) shows another origin as
**anonymous for Flagship identity**. It doesn't block the request, and an app's
own sign-in is unaffected.

## 5. Sign-in

Default and recommended: **Flagship identity**. The app reads the injected
headers; no login code, no passwords. The AI suggests this first.

If the owner asks for their own sign-in, the AI may build it:
- passwords: only slow salted hashes (pgcrypto `crypt()` with bcrypt, or the
  language's argon2/bcrypt/scrypt), never plaintext or reversible;
- social sign-in (Google, GitHub, …): client id/secret are env vars the AI
  requests value-free (`request_env_var`), explaining where the owner gets
  them; the provider hosts reach the app through the access list (the owner
  approves them);
- login, signup and OAuth callback paths listed in `public_routes`; sessions in
  Postgres; cookies `Secure; HttpOnly; SameSite=Lax`; CSRF protection on
  state-changing forms; rate-limit login attempts.

## 6. Looking inside an app's data

- **AI and IDE agents (MCP), staging only:** tools `query_db` (SQL against the
  staging copy's dev database, results capped and redacted like other tool
  output), `list_tables` (schema), `list_files` (the staging `/data` folder).
  Sample data only, per docs/ai-privacy-and-staging.md; there is no tool for the
  live database.
- **The owner, live data:** a Database section on each app's page (webapp first):
  browse tables, run SQL, export a table as CSV, behind Face ID / the unlocked
  owner session. Served by the box over the paired session, never reachable
  through MCP or by any AI.
