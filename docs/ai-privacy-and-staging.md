# AI privacy, staging and egress

**Status:** owner decisions 2026-10-12; build in progress (see AGENTS.md).
Supersedes the same-container idea in `dev-prod-dataspace-harness-spec.md` §4
for AI builds (it keeps that spec's synthesizer and dev dataspace).

## The rule

An AI (the box's own model with the owner's key, or an IDE agent over MCP)
only ever sees and controls **sample data from the repo or the internet**, on a
**private staging copy**, and **never again** once the app is live. Nothing it
can read may help a compromised or curious AI provider tell **who** the owner
is or **where** they are.

Threat model: the provider (or anyone who controls a model's output) is
hostile. It reads everything sent to it and controls every tool call and every
line of code the model writes. With the owner's own key the provider already
knows who pays; Flagship must not add the Flagship account, the server, the
owner's other apps, their address, time zone, locale or habits.

## 1. What the model may see

| Never | How it is kept out |
|---|---|
| Account name, server name, any `*.flagship.services` address | Not in any prompt; tool results, errors and logs go through `llm/modelPrivacy.ts` (`buildModelRedactor`) |
| The owner's other apps (names, descriptions, stores) | Removed from the chat prompt; name clashes are the box's to resolve |
| Plan/tier, clock times, time zone, locale | Not in prompts; `get_journal` returns kind/actor/summary only; staging runs `TZ=UTC`, `LANG=C.UTF-8` |
| The live URL or service id | `deploy` returns `{ok:true}`; the URL travels on a side channel the box keeps |
| Real data, real visitors, real logs | Staging copy only (§2); no tool reads a live container |
| Owner secret values | Names only (as before); staging injects placeholders, so even an app that prints its env leaks nothing |
| The box's public IP | AI traffic goes through the Flagship relay (§4); staging has no internet (§3); build RUN steps reach package registries only (§3) |

The redactor is applied to **box-written** text only. The repo's own files
(`read_file`, `list_files`) are passed unchanged: they belong to the repo, and
rewriting them would corrupt the code the model edits.

What the model still sees, by the owner's choice: the repo, the owner's own
instructions and attachments, the app's chosen name, and the NAMES of env vars
the app uses. Sample data the owner attaches (CSV/JSON) is written only into
the private test copy's files volume (`/data/sample/`), never the live app;
a PDF's text is extracted on the box. When a long conversation is summarised
to fit the model's context, the summariser reads the redacted transcript and
its summary is redacted again.

## 2. Staging, then live (AI create and AI edit)

One step for the owner ("Use AI to adapt and deploy"); two phases on the box.

**Staging (the AI's phase).**
- The AI's `deploy` builds the image and runs it as `flagship-stg-<buildId>` on
  the `flagship-staging` network, never routed from the internet (no owner
  preview either: the owner's browser headers would reach logs the AI reads).
- Its data stores are a fresh **dev dataspace** (`provisionDevDataspace`,
  seeded by the synthesizer from the app's migrations when it has a schema).
- Identity env is neutral: `FLAGSHIP_HOST=app.example`, `FLAGSHIP_CREATOR=owner`,
  a staging app id; owner env vars get placeholder values.
- Tools: `deploy` (to staging, with the start check), `check_app` (the box
  requests a path from the staging copy over loopback with neutral headers and
  returns status, content type and the first few KB), `get_logs` (staging
  container only), the data tools once a deploy succeeded (`query_db`,
  `list_tables`: the dev database as its dev role; `list_data_files`,
  `read_data_file`: the dev `/data` volume through a throwaway container with
  no network; docs/app-apis.md §6), `finish` (the AI says it works). All
  results are redacted.
- The box's own failures never go to the AI (`buildmodes/environmentFailure.ts`):
  a data layer that is down or still starting, the egress fence down, dockerd
  gone, a registry outage (retried once first) or a full disk fails the deploy
  at once with a reason the owner can act on. A running loop (git adapt, the
  chat's Deploy) stops before the model sees it; an IDE is told it's the
  server's problem and to stop, and the build shows the owner's reason. An app
  that can't reach its stores counts as the server's only while the stores are
  down.

**Going live (the box's phase, after the AI is gone).**
1. The build is **sealed**: the AI key for it is forgotten, an MCP key is
   revoked, and every tool on that build refuses from then on.
2. The staging container and dev dataspace are removed.
3. The box installs (create) or redeploys (edit) the live service with the
   **same image** it staged, real data stores, real env, and runs migrations
   itself. The AI is not told the outcome.
4. If the manifest declares egress hosts (§3), the app still goes live, with
   no internet; the box drafts a suggested access list from them (§3a
   "Suggested lists"), its page asks the owner to review it, and only their
   signed approval opens anything. Nothing waits, and nothing opens by default.

A live service can never be attached to an AI session: edits always start a
new build that stages a copy with empty or synthetic data. The chat ("vibe")
path's Deploy runs the same staged loop with the chat's files.

## 3. Network

- **Build sandbox** (`docker build`, network `flagship-build`): RUN steps reach
  only package registries (npm, PyPI, Alpine/Debian mirrors, GitHub, Go/Rust/Ruby
  registries) through the box's egress gateway; DNS answers only those names.
  `validate` rejects `ADD <url>` and `FROM`/`--from` outside the public
  registries (Docker Hub, ghcr.io, quay.io, mcr.microsoft.com, public.ecr.aws,
  gcr.io), because dockerd fetches those from the host network.
- **Staging** (`flagship-staging`): no internet at all; only its dev
  Postgres on the host gateway, and its own dev files volume.
- **Live apps** (`flagship-apps`): no internet by default. What an app may
  reach is its owner-signed access list (§3a, stored sealed in
  `app-access.sealed`); `network.egress` hosts only become a suggested list
  (a draft) the owner answers. The older `flagship/app-egress/v1` grant is still accepted and
  becomes `allow` lines. Consent is the signature the box verifies, never a
  boolean. Enforced by the box's egress gateway (TLS SNI and HTTP Host allowlists, a
  filtering DNS) plus firewall rules that drop everything else from the app
  bridges.

### How the box enforces it (`packages/server-daemon/src/egress/`)

- **Bridges** have fixed interface names: `fs-build` (created `--internal`: no
  route out, no DNS forwarding), `fs-staging`, `fs-apps`. A network left from
  before (a `br-<id>` bridge, or a build bridge that isn't internal) is
  recreated at boot after its containers are disconnected; the daemon recreates
  every app container on boot anyway.
- **Firewall**: chains `FLAGSHIP-EGRESS-NAT` (nat PREROUTING: 443/80/53 from a
  bridge → the gateway's ports 15443/15080/15053), `FLAGSHIP-EGRESS-FWD`
  (from DOCKER-USER: reject anything forwarded from a bridge) and
  `FLAGSHIP-EGRESS-IN` (INPUT: a bridge may reach only the gateway ports, and
  apps/staging the data port 5432), plus `FLAGSHIP-EGRESS6` in
  ip6tables. Written atomically with `iptables-restore --noflush` at every boot;
  they survive a daemon or dockerd restart, so while the gateway is down the
  bridges have no internet (fail closed).
- **DNS**: docker's embedded resolver forwards from the HOST namespace when the
  host's resolver is on loopback (systemd-resolved's 127.0.0.53), which would
  skip any filter. So every app and staging container is started with
  `--dns <its bridge gateway>`, which makes docker forward from the container's
  own namespace into the redirect. Builds can't take `--dns`; the build bridge
  is internal (no DNS at all) and each registry host is pinned to the build
  gateway with `--add-host`. AppRunner and `docker build` get these arguments
  automatically once the gateway enforces (`egress/sandboxNetworking.ts`).
- **Data stores**: Postgres binds 127.0.0.1 only, so the gateway forwards 5432
  from the apps and staging gateway IPs to it, and `host.flagship.internal`
  points at the bridge gateway instead of `host-gateway`. An app's files
  folder is a Docker named volume mounted at `/data` (no network). Every
  database name is opaque and each app role may connect only to its own
  database, so code in one app learns nothing about the owner's other apps.
- **Approvals** live in `<dataDir>/data/app-egress.sealed` (SWK), each with its
  signature; the box re-verifies them at boot and drops any that no longer
  verify. What opens is approved ∩ declared. A revoke also closes open
  connections. Uninstalling an app forgets its approval.
- **Operator switches**: `FLAGSHIP_EGRESS=off` in the daemon environment
  removes the rules, makes the build bridge routable again and runs unfenced
  (the old behaviour). If the gateway can't
  start (no docker within 60 s, no iptables), the daemon logs
  `[egress] NOT ENFORCED` and fails closed: no live app or staging copy
  starts (`appSandbox/state.ts`), the server page's `appSandbox` reads
  `unavailable` with the reason, and the daemon retries every 30 s, starting
  the held-back apps once the gateway runs. Builds still run unfenced.
  Blocked attempts are logged as `[egress] blocked <who> → <host>`.
- **Existing apps lose the internet** on the first boot with this code, unless
  their manifest declares `network.egress` and the owner approves it.
- **Limits**: HTTPS 443 and HTTP 80 only (no other ports, no QUIC); the
  bridges are IPv4-only; a name is reached by name, never by the IP the app
  dialled, and only when it resolves to a public address. Builds need the
  legacy builder: with buildx/BuildKit installed `docker build --network
  flagship-build` is refused by docker itself.

### Clients (iOS, Android, webapp)

The app page shows `egress.declared` and `egress.approved` (on
`/api/screens/apps-list` entries and `/api/screens/app-detail/:id`.app) and
asks the owner to allow the declared hosts. Allowing signs, with the
sensitive-order key, the canonical bytes

    flagship/app-egress/v1|<serverDomain>|<serviceId>|<hosts sorted, comma-joined>|<issuedAt ms>

and POSTs `{ grant: { serverDomain, serviceId, hosts, issuedAt }, signature: <hex> }`
to `/api/screens/services/<serviceId>/egress`. Hosts must be a subset of
`declared`; `hosts: []` revokes. The box answers 200 `{ ok, egress }`, 403
(bad signature, other server, `issuedAt` more than 10 min off), 400 (malformed,
other service), 409 (not newer than the applied grant) or 422 (undeclared
host). Golden vector: `packages/protocol/tests/appEgress.test.ts`.

## 3a. App access lists (which hosts a live app may reach)

Supersedes the all-or-nothing `network.egress` approval for live apps (the v1
`flagship/app-egress/v1` grant is still accepted and becomes `allow` lines).

**The file.** One rule per line, the allow/deny convention of nginx and
Apache, checked top to bottom: the first rule that matches decides, and a host
no rule matches is denied.

```
# weather app
allow api.open-meteo.com
allow *.tile.openstreetmap.org   # any subdomain, not the bare domain
deny  ads.example.com
allow all                        # or: deny all (the same as the default)
```

- `allow` / `deny` (any case), then one target: `all`, a host, or `*.` + a
  host. Hosts are lowercased. No schemes, paths, ports, IP addresses,
  `localhost`, or `*` anywhere but the start. `#` starts a comment.
- At most 200 rules. Errors name the line and say how to fix it.
- The text is normalized before it is hashed or signed: `\r\n` and `\r` become
  `\n`, trailing spaces go, trailing blank lines go, and a non-empty list ends
  in one `\n`.
- An app starts with this list (`defaultList` in the vectors), which denies
  everything and shows how to open it up; Allow and Deny add rules above it,
  so these lines stay last:
  ```
  # Uncomment the following line to allow all hosts
  #allow all
  ```
- `packages/protocol/test-vectors/app-access/vectors.json` is the reference.
  Every platform's normalizer, parser (exact error texts), matcher, editor
  (`withRule`) and signer must pass it.

**Authority.** The box enforces only a list the owner signed:
`flagship/app-access/v1|<serverDomain>|<serviceId>|<sha256 hex of the normalized list>|<issuedAt ms>`,
signed by the sensitive-order key (admin root when held, else the owner IRK),
sent with the list text. The box checks the signature, the hash, that the text
is already normalized and parses cleanly, that `serverDomain` is its own, and
that `issuedAt` is within 10 minutes and newer than the list it holds.

**Alerts.** When the egress gateway denies an app a host because **no rule
matched** (an explicit `deny` is the owner's answer and stays quiet), the box
records a request `{host, attempts, firstSeen, lastSeen}`. Hosts in the
manifest's `network.egress` become a draft instead (below); requests with
source "app" from older boxes stay until answered. The box
pushes at most one alert per app and host (or draft) per day and five per hour, through
`/api/push/relay` (category `generic`, see below), whose OS-visible text says
only "Open Flagship to see what's new." On any `generic` push the apps fetch
the box's access requests (and whatever else they check). The phone reads
the details from the box over the paired session, so neither Flagship nor
Apple or Google learns what the push was about, which app, or which host. An open app also gets an `access-request` event on the
screens socket.

**Suggested lists (drafts).** The AI says which hosts the app needs in the
manifest: `network.egress` entries are a host string or `{host, why}` (a short
reason, at most 120 characters). When the app goes live (and after an AI edit
that adds hosts), the box makes a **draft**: the current signed list with an
`allow <host>   # <why>` line on top for each suggested host the list doesn't
already allow. A draft opens nothing; nothing is drafted when nothing is new;
these hosts no longer become separate per-host requests.
- "Already allow": the box leaves out a host the list allows, and one a rule
  names to deny it (`deny <host>` or a `deny *.` rule covering it: the owner's
  answer); a final `deny all` is not an answer about one host.
- "New": a draft is made only when the manifest suggests a host the box hasn't
  suggested for that app before (so a redeploy with the same hosts, or one
  after a dismissed draft, drafts nothing); the draft then carries every
  suggested host the list doesn't decide. The box remembers suggested hosts
  until the app is uninstalled. Drafts are sealed with the lists.
- A draft alerts like a request: the `access-request` socket event and the
  generic push (one per app per day for drafts, the alerts switch respected). The owner reviews it on
the app's page (and through the usual generic alert), may edit it in the same
editor, and approves it with Face ID, which signs and sends it like any other
list; or dismisses it. A newer draft replaces an unanswered one.
- `GET /api/screens/services/:id/access` also returns
  `draft: {list, listSha256, hosts:[{host, why?}], createdAt} | null`.
- Approving is the normal `POST …/access` with the (possibly edited) text; the
  box drops the draft when a list is applied.
- `POST /api/screens/services/:id/access/draft/dismiss` discards it (no
  signature; it changes nothing the app can reach).
- `GET /api/screens/access-requests` also lists drafts as
  `{serviceId, appName, kind:"draft", hosts, createdAt}` (drafts first) so the
  alert can offer Review. App summaries' `access` gains `draft: true` while
  one waits.

**Turning push off.** The apps have one switch, Settings → "Push
notifications", on by default and stored on the device. It covers every push,
not only these alerts: even an opaque unlock push tells Apple or Google when a
server rebooted. Its text: "When this is off, nothing from Flagship is pushed
to this device, so Apple and Google never see when your servers need you.
You'll have to open Flagship to approve unlocks and see requests." Off does
two things:

1. The device revokes its push registration with flagshipserver.com (the
   signed `DELETE /api/push/:tokenId` every app already uses; the webapp also
   drops its Web Push subscription) and doesn't register again while the
   switch is off. With no token on file, `.com` has nowhere to push.
2. The device writes `{enabled:false}` to every box it manages
   (`GET`/`POST /api/screens/settings/access-alerts` `{enabled}`, owner
   session only, a companion gets 403, no signature because it can only
   reduce what leaves the box), and writes it again on start and on each
   return to the foreground wherever a box disagrees (a box without the
   setting answers 404 and is skipped). A box with alerts off never calls
   `/api/push/relay` for an access request, so nothing about it leaves the
   box, whichever devices are still registered. The setting lives in
   `<dataDir>/data/access-alerts.json`.

Requests are still recorded, the screens socket still sends `access-request`,
and requests still wait on each app's page, but the device shows no sheet. On
registers the device again and writes `{enabled:true}`. That's the point:
turning notifications off in the OS only hides them on the phone after
they've travelled. Pushes that are sent use the `generic` category (older
boxes sent `app-access`, which stays valid): Apple and Google see that
Flagship pinged the phone, not what about.

**Answering.** The alert shows "<App> wants to reach <host>" with **Allow**,
**Deny** and **Not now**. Allow or Deny edits the list with `withRule`: drop
any rule for exactly that host, then put the new one on top so it decides.
Then Face ID, sign, send, and confirm: "<App> can now reach <host>" (or "won't
reach") with **Close** and **View access list**. Not now keeps the request and hides it for 24 hours on that device;
Ignore (on the service page) dismisses it without changing the list.

**The service page.** An "Internet access" section shows the rule count, the
pending requests (Allow / Deny each), and View access list. The list opens in
an editor that parses as you type and shows each error by line. Save stays off
while there are errors, then asks for Face ID and sends the signed order.

**Box API** (paired session; companion sessions are read-only):
- `GET /api/screens/services/:id/access` returns
  `{list, listSha256, pending:[{host, source:"attempt"|"app", attempts, firstSeen, lastSeen}], draft}`.
- `POST /api/screens/services/:id/access` takes
  `{list, grant:{serverDomain, serviceId, listSha256, issuedAt}, signature}`.
  It returns 200 `{ok, access}`, 400 `{error, errors:[{line, message}]}`, 403,
  404 or 409.
- `POST /api/screens/services/:id/access/dismiss` takes `{host}`. It needs no
  signature, because it changes nothing the app can reach.
- `GET /api/screens/events?sessionToken=<paired session token>` (WebSocket):
  the box sends `{"type":"access-request","serviceId":"…"}` when a new
  request is recorded; the apps then fetch the requests. Companion sessions
  may listen.
- `GET /api/screens/access-requests` returns `{requests:[{serviceId, appName, host, source, attempts, firstSeen, lastSeen}]}`.
- App summaries carry `access: {rules, pending}`.

**Not involved:** Studio (no app UI, and it never holds the owner key), the
hub (unchanged). `.com` learns the `app-access` push category only.

## 4. AI provider relay

Calls to a provider leave the box through the Flagship hub
(`flagship.services`) over the box's existing tunnel: TLS runs end to end
between the box and the provider, so Flagship sees only the destination host,
timing and size, and the provider sees Flagship's address instead of the
owner's. The hub has to know the host to connect, but it logs nothing per
call: only totals across every box every 15 minutes (streams per destination,
bytes, refusals by reason), never a box or the size of one call. Known AI
providers are counted by name and every other host only as "other" (a rare
host would identify its user even in a total); a growing "other" count is the
signal that the relay is used for something besides AI. It relays to
any public host on 443 (custom provider URLs), never to private or Fly-internal
addresses. It is a per-key setting, **on by default**, shown when the owner adds
a key ("Better for your anonymity: the provider sees Flagship's address, not
yours") and in the key list. If a key asks for the relay and it is unavailable
the call fails rather than going direct. Local endpoints (a LAN Ollama) are
always direct. Later, possibly: a monthly relay allowance on Free and
unlimited on Pro (gating lives on `feat/marketplace`).

## 5. Residual risk (say it plainly)

Code the AI wrote runs on real data once live. The staging wall keeps the AI
from seeing that data; the egress wall keeps the code from sending it
anywhere the owner didn't approve. A malicious app can still misuse data it
legitimately holds inside its own UI.
