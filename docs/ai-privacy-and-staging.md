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
the app uses.

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
  container only), `finish` (the AI says it works). All results are redacted.

**Going live (the box's phase, after the AI is gone).**
1. The build is **sealed**: the AI key for it is forgotten, an MCP key is
   revoked, and every tool on that build refuses from then on.
2. The staging container and dev dataspace are removed.
3. The box installs (create) or redeploys (edit) the live service with the
   **same image** it staged, real data stores, real env, and runs migrations
   itself. The AI is not told the outcome.
4. If the manifest declares egress hosts (§3), the app still goes live, with
   no internet; its page asks the owner to allow those hosts, and only their
   signed approval opens them. Nothing waits, and nothing opens by default.

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
- **Staging** (`flagship-staging`): no internet at all; only its dev data
  stores on the host gateway.
- **Live apps** (`flagship-apps`): no internet by default. An app reaches only
  the hosts its manifest declares in `network.egress`, and only after the
  owner approves them with a signed grant (`flagship/app-egress/v1`, sensitive
  order key; consent is the signature the box verifies, never a boolean).
  Enforced by the box's egress gateway (TLS SNI and HTTP Host allowlists, a
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
  apps/staging the data ports 5432/6379/9000), plus `FLAGSHIP-EGRESS6` in
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
- **Data stores** bind 127.0.0.1 only, so the gateway forwards 5432/6379/9000
  from the apps and staging gateway IPs to them, and `host.flagship.internal`
  points at the bridge gateway instead of `host-gateway`.
- **Approvals** live in `<dataDir>/data/app-egress.sealed` (SWK), each with its
  signature; the box re-verifies them at boot and drops any that no longer
  verify. What opens is approved ∩ declared. A revoke also closes open
  connections. Uninstalling an app forgets its approval.
- **Operator switches**: `FLAGSHIP_EGRESS=off` in the daemon environment
  removes the rules, makes the build bridge routable again and runs unfenced
  (the old behaviour). If the gateway can't
  start (no docker within 60 s, no iptables), the daemon logs
  `[egress] NOT ENFORCED` and keeps the old behaviour rather than breaking
  installed apps. Blocked attempts are logged as `[egress] blocked <who> → <host>`.
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
