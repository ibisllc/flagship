# Apps that serve APIs, live connections and their own sign-in

**Status:** owner decisions 2026-10-12; being built. Principle: secure defaults,
flexible services — the owner's machine, the owner's rules.

## 1. Live connections

The box's app proxy streams responses as the app produces them (Server-Sent
Events, long downloads, chunked replies) and passes WebSocket upgrades through
to the app. The access decision (open or members-only, public route, member,
API key) is made on the upgrade request exactly as on any request; the identity headers (`X-Flagship-Visitor`, `-User`, `-Role`,
`-Signature` …, §5) are injected on it like on any request; then bytes flow both ways until
either side closes. Idle and per-app connection limits apply. Postgres stays
inside the box: an app exposes pub/sub to the world through its own WebSocket or
SSE routes, with `LISTEN`/`NOTIFY` behind them.

## 2. Who reaches the app without signing in (owner decision 2026-10-14)

| visitor | Open to all | Members only |
|---|---|---|
| anonymous, any path | forwarded, `X-Flagship-Visitor: anonymous` | knock page (browser) / 403 |
| anonymous, a `public_routes` path | forwarded, anonymous | forwarded, anonymous |
| member or owner (signed in) | forwarded with id + rank | forwarded with id + rank |
| owner's API key | forwarded as `api` | forwarded as `api` |

The same table holds for every method and for WebSocket upgrades. On an open app
`public_routes` changes nothing: every anonymous request reaches the app, which
decides what an anonymous visitor may do. On a members-only app
`access.public_routes` lists the only paths an anonymous visitor may reach: a
landing page, or a webhook another service calls (`"/hooks/stripe"`). If the
box can't tell which mode an app is in (its access state file is unreadable),
the app is members-only.

The AI chooses every URL; the manifest only says which are public. An entry is
an exact path or a prefix ending in `/*`: `"/api/public/*"` covers
`/api/public` and everything under it (segment-aware: not `/api/publicity`);
`"/*"` covers the whole app. Matching (`matchesPublicRoute`, `serviceProxy.ts`):

- the query and fragment are ignored; the path is percent-decoded once, `//`
  collapses to `/`, and a trailing `/` doesn't matter (`/webhook` covers
  `/webhook/`). Declared entries are normalised the same way;
- matching is case-sensitive (`/Webhook` is not `/webhook`);
- a path that could resolve somewhere else matches nothing, `/*` included: any
  `.` or `..` segment (also as `%2e%2e` or `..;x`), an encoded `/`, `\` or `%`
  (`%2f`, `%5c`, `%25`: double decoding), a backslash, a control character or a
  malformed escape. Browsers never send these, so on a members-only app such a
  request gets the knock page.

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
  `Authorization` header, and injects `X-Flagship-Visitor: api`,
  `X-Flagship-User: apikey:<keyId>`,
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
**anonymous for Flagship identity** (`X-Flagship-Visitor: anonymous`, §5). It
is then decided like any anonymous request (§2: forwarded on an open app, only
on public routes on a members-only one), and an app's own sign-in is unaffected.

## 5. Sign-in

Default and recommended: **Flagship identity**. The app reads the injected
headers; no login code, no passwords. The AI suggests this first.

**Who the app sees (members).** Members are the owner and the people the owner
let in (the service's allow-list, filled by invites,
docs/service-access-gating.md). A browser can't sign, so a person signs in with
their phone:

1. They open the app's sign-in link (`/__flagship/sign-in`, either mode), or,
   on a members-only app, any path outside `public_routes`. A browser
   navigation (GET with `Accept: text/html`) gets the knock page (QR, "Access
   site" deeplink, "Get link"); an API call or asset gets a 403.
2. Their phone signs the knock with their account id (AID) and posts it to
   the box (`POST /api/service-access/knock/authorize`). The box accepts the
   owner's AID (`ownerAidPub` in the box config) and allow-listed AIDs, and
   refuses anyone else with 401.
3. The page's poll picks up a `Flagship-App-Session` cookie (host-only, 12 h)
   for that app, and reloads.

On each request the box looks the cookie up (`appMemberSession.ts`): a live
session for THIS app whose AID is still let in becomes the member; a cookie for
another app, an expired, closed or unknown one, or one whose person was
removed is anonymous. The app gets `X-Flagship-User` = a per-app stable id
derived from the app secret and the AID (the same person has unrelated ids in
two apps; it survives their device and key changes) and `X-Flagship-Role` =
`owner` for the owner, otherwise the highest role the owner gave the person's
invites (or them), else the role the app's membership store holds for
that AID, else the manifest's `default_role`. Only the box owner is ever
`owner`: a default (or assigned) role of `owner` gives an invited person
`master`.

**The header contract.** On every request it forwards (plain, streamed or a
WebSocket upgrade) the box first drops every header the client sent whose name
starts with `X-Flagship-` (any case, and also spelled with underscores,
`x_flagship_role`, which CGI/WSGI servers fold into the same name), then sets:

| header | member | API key | anonymous |
|---|---|---|---|
| `X-Flagship-Visitor` | `member` | `api` | `anonymous` |
| `X-Flagship-User` | per-app stable id | `apikey:<keyId>` | *absent* |
| `X-Flagship-Role` | `member` / `manager` / `master` / `owner` | `api` | *absent* |
| `X-Flagship-Api-Scope` | *absent* | `read` / `write` | *absent* |
| `X-Flagship-App-Id`, `-Timestamp`, `-Signature` | set | set | set |

`X-Flagship-Signature` is hex Ed25519 by the box key
(`GET /.flagship/runtime-pubkey`) over
`flagship/inject/v1|<appId>|<user>|<role>|<timestamp>`, with `|<scope>`
appended for an API key; for an anonymous visitor `user` and `role` are the
literal `anonymous` (no member id or rank is ever that string), so a verifier
uses `anonymous` for both exactly when `X-Flagship-Visitor` is `anonymous`.

**Anonymous visitors (owner decision 2026-10-14).** Someone who hasn't signed
in has no rank: not `member`, nothing. On an open app the box forwards all
their requests (every path and method, WebSocket upgrades too) and says only
that they are anonymous; the app decides what they may do (an AI-built app makes
them read-only unless the owner asked otherwise). On a members-only app they
reach only `public_routes` (§2). An app must never treat a missing
`X-Flagship-User` or `X-Flagship-Role` as a member.

Ranks are Flagship's, ordered and cumulative (docs/service-access-gating.md,
"Open mode + members"): `member` < `manager` < `master`, plus `owner` for the
box owner. The owner gives each member a rank; a person holding several
invites has the highest. The manifest says what each rank can do in this app
(`access.role_descriptions`, one line each, shown to the owner in the rank
picker) and the app enforces it: the box delivers the rank and never blocks a
request by it, so the base `member` rank must still be able to use the app.

On an open app a member is an anonymous visitor (no rank) until they sign in: link to
`/__flagship/sign-in?next=<path>` (and `/__flagship/sign-out?next=<path>`),
which the box serves on the app's own host. A box with no owner AID pinned can't
recognise its owner, so a members-only app's private pages are reachable only
with API keys.

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

- **AI and IDE agents (MCP), staging only:** after a successful deploy of the
  test copy (refused before one, and once the build is sealed), tools
  `query_db {sql, store?}` (SQL against the staging copy's dev database as its
  dev role: 10 s statement timeout, at most 200 rows, cells cut at 300
  characters, writes allowed since they change only sample data),
  `list_tables {store?}` (tables and views with columns, types and row counts),
  `list_data_files {path?}` (the staging `/data` folder: names and sizes, no
  contents) and `read_data_file {path}` (the first 16 KB of one text file).
  The files tools run a throwaway container (the data layer's image) with no
  network, every capability dropped but reading, a read-only root and only the
  dev volume mounted read-only. (`list_files` stays the build workspace's
  listing.) Results are redacted like other tool output and journaled without
  the SQL. Sample data only, per docs/ai-privacy-and-staging.md; there is no
  tool for the live database or the live `/data` folder.
- **The owner, live data:** a Database section on each app's page: browse
  tables, run SQL, export a table as CSV. Served by the box over the owner's
  paired session (companions get 403 on every method), never reachable through
  MCP or by any AI. Everything runs as the app's own role (never the admin),
  with a 15 s statement timeout and at most 1000 rows returned
  (`packages/server-daemon/src/dataLayer/ownerDb.ts`).
  - `GET /api/screens/services/:id/db` → `{stores:[{store, tables:[{name,
    kind, rows, bytes}]}]}`. `name` is `table` in the public schema, else
    `schema.table`; `kind` is `table` or `view`; `rows` is the planner
    estimate, counted exactly for a never-analyzed table under 8 MB, and null
    when unknown (views, large never-analyzed tables).
  - `GET …/db/:store/tables/:table?offset=0&limit=100` → `{columns:[{name,
    type}], rows:[[…]], total}`; `limit` at most 1000. Values come back as
    Postgres prints them (strings), except booleans and small numbers; `bigint`
    and `numeric` stay strings.
  - `GET …/db/:store/tables/:table/export.csv` → the whole table as CSV
    (`text/csv`, a download), read in batches; a table over 64 MB as CSV gets
    413 (export it in parts with a query).
  - `POST …/db/:store/query` `{sql}` → `{command, columns, rows, rowCount,
    truncated}`, one statement, run in a READ ONLY transaction (the extended
    protocol refuses a second statement, so `COMMIT; …` can't escape it; a row
    query runs through a cursor that fetches at most 1001 rows). `command` is
    the first word of the statement's tag. A Postgres error is 400
    `{error, sqlState, position?}`; a write gets `needsGrant: true`
    (SQLSTATE 25006), the cue to sign it. COPY is refused. 503 when the
    database can't be reached; 404 for an unknown app, store or table.
  - Writes (anything that changes data or schema) need a signed order:
    `POST …/db/:store/query` `{sql, grant:{serverDomain, serviceId, store,
    sqlSha256, issuedAt}, signature}`, canonical
    `flagship/app-db-write/v1|serverDomain|serviceId|store|<sha256 hex of the
    UTF-8 sql>|issuedAt`, sensitive-order key (admin root when held, else the
    owner IRK). The box checks the store, service, server, the hash of the
    exact `sql` it was sent, that `issuedAt` is within 10 minutes, and the
    signature (`authorizeSensitiveOrder`), then runs the SQL (several
    statements allowed) in one normal transaction. Each order works once: the
    box remembers `serviceId|store|sqlSha256|issuedAt` past the freshness
    window, on disk (`<dataDir>/data/app-db-writes.json`), and a repeat gets
    409; signing the same statement again gives a new `issuedAt`. 400 for a
    grant naming another app or store; 403 for another server, a different
    statement, a stale order or a bad signature. Vectors:
    `packages/protocol/test-vectors/app-db-write/vectors.json`.
