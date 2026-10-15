# Outbound proxy for a box

Status: phase 1 (the proxy) and phase 2 (OHTTP for the calls before the
daemon) built on `feat/outbound-proxy` (2026-10-14/15), except the initramfs
OHTTP client, which is design only. Not on `main`, not deployed, no box
release endorsed. A **Pro** feature (owner, 2026-10-15): it launches with
payments, see "Pro only" below.

## Goal

Today a box reaches the internet directly, so every service it talks to sees
its home IP. The ones that matter most are Flagship's own: the `.services` hub
(the tunnel), `.com` (heartbeat, deposits, registration) and the boot worker
(`boot.flagshipserver.com`, disk unlock). The hub also knows which boxes
belong to which account from the tunnel name `<server>.<user>.flagship.services`,
so hub logs could join "account" to "home address".

The owner can now give a box an **outbound proxy**: an HTTP CONNECT or SOCKS5
server that the box sends its outbound connections through. Flagship, Let's
Encrypt, GitHub, npm, AI providers and app destinations then see the proxy's
address, not the box's.

## Verdict: feasible, in two steps

- **The daemon: yes, fully, now.** It runs Node with three kinds of clients:
  global `fetch` (undici), the `ws` WebSocket client, and `acme-client`
  (axios). All three accept a custom connector: undici a dispatcher, `ws` and
  axios an `http.Agent`. One small connector (CONNECT and SOCKS5, about 150
  lines, Node built-ins only) behind those three hooks covers every call the
  daemon makes. Children the daemon spawns (git and npm during updates) get a
  loopback HTTP proxy the daemon runs, so they need nothing but standard
  `HTTPS_PROXY` support, even when the upstream is SOCKS5 (npm has no SOCKS).
- **Before the daemon exists: through OHTTP, not the proxy** (owner,
  2026-10-15). The setup POSTs and the initramfs unlock can't use the proxy's
  credentials (the recipe may not carry them, and they never go on the
  unencrypted `/boot`), so a box with a proxy sends those few calls through a
  third-party Oblivious HTTP relay (RFC 9458) instead. See "OHTTP" below.

**Ship first:** SOCKS5 (with remote DNS, i.e. `socks5h`) and plain HTTP
CONNECT, both with optional username/password. SOCKS5 covers Tor (its SOCKS
port), SSH `-D` tunnels and most commercial proxies; HTTP CONNECT covers
corporate proxies and squid. Later: an HTTPS proxy (TLS to the proxy, hides
destinations from the local network) and a WireGuard full tunnel. WireGuard
would hide everything including DNS and the OS's own traffic in one move, but
it moves the box's whole network stack (and LAN-direct, Docker, the egress
fence's firewall rules) under a tunnel interface, needs kernel config at
install time and its own failure handling; it is a separate project.

## The order

`flagship/box-proxy/v1` (`packages/protocol/src/boxProxy.ts`; vectors in
`packages/protocol/test-vectors/box-proxy/`, `scripts/gen-box-proxy-vectors.mjs`):

```
flagship/box-proxy/v1|<serverDomain>|<kind>|<host>|<port>|<auth 1|0>|<fallbackDirect 1|0>|<issuedAt ms>|<nonce>
```

- `kind`: `none`, `socks5` or `http`. `none` carries `host` "" and `port` 0 and
  no flags: it turns the proxy off.
- `host`: lowercase host name, IPv4, or IPv6 without brackets. The apps
  normalize typed input (`normalizeBoxProxyHost`) before signing. LAN
  addresses are allowed (a proxy on the home router is common).
- `auth`: the proxy needs a username and password. The credentials are never
  signed and never part of the order; they travel beside it (below).
- `fallbackDirect`: when the proxy can't be reached, the box may connect
  directly. Off by default.
- `nonce`: 32 random bytes, lowercase hex.
- Wire form: `{ proxy: {serverDomain, kind, host, port, auth, fallbackDirect, issuedAt, nonce}, signature }`.
- Signed by the **sensitive-order authority** (admin root when pinned, else the
  account IRK), like the server order and app access lists. The proxy decides
  who sees all of the box's connection metadata, and a bad one takes the box
  offline, so consent is a signature the box verifies, never a flag.

Credentials: `{ username, password }`, each 1–255 bytes (the SOCKS5 limit,
RFC 1929), no control characters, no `:` in the username (HTTP Basic). Checked
by `boxProxyCredentialsError` with the same vectors everywhere.

## Where the order comes from

1. **The recipe ("from inception").** In the create-a-server flow, under
   Advanced, the owner can set a proxy. The app signs the order for the new
   server's domain and puts it in the recipe as the unsigned sibling
   `outboundProxy` (the same pattern as `pairingOrder` and `debugGrant`: the
   signature is the order's own, so the signed install-blob bytes don't change
   and every builder just passes the sibling through to
   `/var/flagship/install-blob.json`). The box verifies it at first boot under
   the recipe's own authority (the IRK or admin root the install blob pins).
   No freshness window for this one: the recipe may be used hours later.
2. **The server page, later.** The owner edits the proxy on the server's page;
   the app asks for Face ID / Touch ID / fingerprint ("Confirm the proxy
   change"), signs, and POSTs to the box over the paired session:
   `POST /api/screens/outbound-proxy` `{proxy, signature, credentials?}`.
   The box checks: owner session (companions are read-only), signature under
   the sensitive-order authority, `serverDomain` is its own, `issuedAt` within
   10 minutes and newer than the order it holds, `auth` matches whether
   credentials were sent (or kept, see below). Then it **tests before it
   switches**: it opens a connection through the new proxy to the hub and
   completes a TLS handshake. If that fails it answers `422` with the reason
   and keeps the old setting, so an edit can never strand the box. On success
   it saves, answers `200`, and reconnects the tunnel and everything else
   through the new path.
   - `GET /api/screens/outbound-proxy` returns
     `{ proxy: <order fields> | null, hasCredentials, status }` where
     `status` is `{ state: "direct" | "ok" | "failing" | "fallback", since, lastError? }`.
     The password is never returned.
   - Keeping credentials across an edit: an order with `auth: true` and no
     `credentials` keeps the stored ones when host, port and kind are
     unchanged; otherwise it is refused (`400`, "Enter the proxy's username
     and password").
   - Server detail (`/api/screens/server-detail`) carries the same summary as
     `outboundProxy` so the page can show it without a second call; older
     boxes omit it and the apps hide the section.
   - The webapp signs with the unlocked session's key and shows no separate
     prompt (its signer takes no reason text, like the access-list save); the
     phones prompt. On an admin-root account, creating a server with a proxy
     prompts twice on the phones (the IRK for the recipe, the admin root for
     the proxy order).

**No `.com` deposit in phase 1, on purpose.** The server order uses a `.com`
lane because boxes must agree on it even when the owner's phone is far away.
A proxy change is for one box, and the cases where a deposit would help are
the ones where it can't: a box whose proxy is broken can't reach `.com`
either. When the box is reachable, the paired session reaches it (through the
hub or LAN-direct), and it is end-to-end TLS to the box, so the credentials
never touch Flagship. A deposit lane would need the credentials sealed to the
box key and buys nothing.

## Credentials are secrets; the recipe is secret-free

The recipe is meant to travel anywhere (a file to a helper or a hosting
operator, `.com`'s relay, a QR). So:

- The order (kind, host, port, flags) goes in the recipe. It isn't secret,
  though it does tell whoever holds the file that the owner uses that proxy.
- **Credentials go in the recipe only when the owner types them there**, as a
  second unsigned sibling `outboundProxyCredentials`, with the warning "The
  username and password are saved in the setup file. Only give the file to
  people you trust." This is the "embed secrets" exception the Advanced
  section already makes for `swkHex` / `pairingOrder`, scoped to what the
  owner typed.
- Why not deliver them after first boot, like the SWK? Because a proxy that
  needs a password can't be used until the password arrives, and the box can
  only fetch a deposit through the proxy: a chicken and egg. The choices for a
  password-protected proxy from inception are "password in the setup file" or
  "first contact goes direct". The app offers the first and says so; an owner
  who won't put the password in the file can use a proxy that needs none (Tor,
  a LAN proxy, an IP-allowlisted proxy) or add the password later on the
  server page (and accept that the box's setup happened directly).
- On the box: stored with the order in `<dataDir>/outbound-proxy.json`,
  mode 0600, written durably (`durableFile.ts`). The data partition is LUKS.
  Never logged, never in an error the AI or the apps can read (connection
  errors are reported as "the proxy refused the username or password", never
  with the values), never returned by any endpoint.

## What the box sends through the proxy (phase 1)

Everything leaving from the daemon, through one connector
(`packages/server-daemon/src/outboundProxy/`):

| Traffic | How it is routed |
|---|---|
| Tunnel to the hub (`tunnelClient.ts`, `ws`) | `agent` option on the WebSocket |
| Daemon-status heartbeat, deposits, every `.com` call, gossip to `broadcast--<user>.flagship.services`, endpoint discovery | global undici dispatcher (`setGlobalDispatcher`) |
| Box-to-box sibling sockets (`sibling/`) | `agent` option, LAN addresses go direct |
| ACME API calls to Let's Encrypt (`acme-client`) | `acme.axios.defaults.httpsAgent`, `proxy: false` |
| AI provider calls, inference shim, gVisor download, Debian package repair (`systemRepair.ts`), adapter index | global dispatcher (they use `fetch`) |
| git fetch and npm during updates (`updateConsumer.ts`, `updateReleases.ts`, `firstBootUpdate.ts`) | children inherit `HTTP(S)_PROXY=http://127.0.0.1:<bridge>`; the daemon's loopback bridge forwards through the proxy |
| Live apps' approved hosts (egress gateway, `egress/proxy.ts`) | the gateway dials the allowed host by name through the proxy |
| Health timer (`flagship-health.service`, `healthReporter.ts`, curl to `.com`) | `curl -K <dataDir>/outbound-proxy.curlrc`, a 0600 curl config the daemon writes on every switch; it names the upstream proxy itself because the timer keeps reporting while the daemon (and its bridge) is down |

The outbound AI relay already goes through the tunnel, so it inherits the
proxy for free.

**Direct on purpose:** loopback, RFC 1918 and unique-local addresses,
link-local, CGNAT (100.64/10) and `localhost`/`.local`/`.internal` names: the
data stores, a LAN Ollama, LAN-direct app copies between the owner's boxes
(`appCopy/lanFetch.ts` pins a LAN address with its own agent). Sending those to
a proxy would fail or leak the LAN layout to the proxy operator.

**Inbound is unaffected.** User content arrives over the tunnel the box
opened (now via the proxy), and ACME TLS-ALPN-01 validation arrives the same
way (Let's Encrypt → hub SNI passthrough → tunnel → box). Only the ACME API
calls (new order, finalize, download) are outbound, and they use the proxy.

**DNS.** SOCKS5 always sends names (remote resolution), so the box's resolver
learns nothing. HTTP CONNECT sends names too. The box still resolves the
proxy's own host name locally (use an IP to avoid even that), and the egress
gateway still resolves an app's allowed host locally to refuse private
addresses before it dials (that query goes to the box's resolver, not to
Flagship).

**Not yet through the proxy in phase 1** (phase 1b/2, each says why):

- Docker image pulls (data services' Postgres/Forgejo images, app base images,
  `docker build` of the browser image). dockerd is its own process; it needs a
  `docker.service.d` proxy drop-in pointing at the daemon's bridge plus a
  dockerd restart, and the data services pull at boot before the daemon (and
  its bridge) is up. Leaks the IP to Docker Hub / Codeberg, not to Flagship.
- The update guard (`updateGuard.ts`, a bash `ExecStartPre` that runs
  `npm ci` to repair an interrupted update while the daemon is down): no
  bridge exists then, so that rare repair goes to npm directly. Phase 1b: give
  it the curl config's proxy as `npm_config_proxy` (HTTP proxies only).
- The health report's `tunnel` field checks for an established connection to
  port 8443; behind a proxy that connection goes to the proxy's port, so it
  reads `false`. Cosmetic; fix with the proxy port in phase 1b.
- The container DNS filter (`egress/dnsFilter.ts`) forwards app DNS straight
  to the box's resolver; it never reaches Flagship.
- Anything the OS does on its own (unattended upgrades, NTP).

## How it affects setup (the first-boot path)

Every network call before the daemon runs, with where it happens and how it
would honour the proxy. Line numbers are in the TS generator
`packages/flagship-builder/src/userdata.ts` unless noted; the Mac, Windows and
Android builders run the same generator bundled as `preseed-engine.js`, so
one change covers every builder.

| Phase | Call | Reaches | Proxy |
|---|---|---|---|
| d-i installer ISO (`preseed.ts:214, 366–449, 173, 189, 191`) | busybox `wget` status beacons | `.com` `/api/order/<serial>/status` | busybox wget has no CONNECT or SOCKS: skip the beacons when a proxy is set |
| d-i (`preseed.ts:217–220`) | debootstrap + apt | Debian mirror | `mirror/http/proxy` (HTTP proxies only) |
| bootstrap 663–671 (skipped on the VM appliance) | NodeSource + apt | deb.nodesource.com, mirror | `Acquire::http(s)::Proxy` / `socks5h://` |
| bootstrap 725–736, 899, 912 | `report_phase` curl, network probe | `.com` | `curl -K <proxy curlrc>` |
| bootstrap 773–778 (skipped on the appliance) | git clone, npm install | github.com, npmjs | `HTTPS_PROXY` (npm: HTTP proxies only) |
| bootstrap 1717–1719 (skipped on the appliance) | `go build` of the unseal helper (fetches golang.org/x/crypto) | proxy.golang.org | `HTTPS_PROXY` |
| bootstrap 1611, 929 | `POST /api/server/register` | `.com` | `curl -K` |
| bootstrap 1664 | `POST /sealed-luks-key` | `.com` | `curl -K` |
| appliance specializer (`appliance.ts:42–142`) | status reports, then the bootstrap above | `.com` | same |
| cloud-init demo path (`control-plane/src/demoCloudConfig.ts`) | apt, NodeSource, git, npm, register | all of the above | cloud-init's `apt: http_proxy`; demo-only, not needed |
| daemon first boot | endpoint discovery, tunnel, heartbeat, ACME, pairing/SWK deposits, first-boot update (`firstBootUpdate.ts`: git fetch, npm ci) | `.com`, hub, LE, GitHub, npm | **phase 1** (above) |

The table's "Proxy" column was the phase-1b plan; the owner replaced it with
OHTTP (2026-10-15) for every call that reaches Flagship before the daemon:

- **Built:** the bootstrap's and the appliance specializer's `.com` calls
  (status reports, `POST /api/server/register`, `POST /sealed-luks-key`) go
  through `flagship_post` (`SETUP_POST_FN` in `userdata.ts`). For a recipe
  with `outboundProxy` it runs `install-helper.ts ohttp-post` (OHTTP through
  the relay, direct fallback marked); every other box keeps `curl`. Before
  Node is installed (the installer paths' earliest reports) a proxy box sends
  nothing rather than go direct. The register wrapper's network check
  becomes a DNS lookup instead of a GET to `.com`. d-i's busybox beacons and
  the bootstrap-failure log upload are left out of a proxy recipe's preseed.
  The default path (the VM appliance) has Node from the start, so every
  setup call goes through the relay.
- **Not through anything, by design:** the Debian mirror, NodeSource, GitHub,
  npm and Go (installer paths only; the appliance skips them). They are not
  Flagship and they are large; see "Large files never go through OHTTP".
- **The bootstrap uses the sibling without verifying it** (whoever writes the
  install media already controls the disk); the daemon verifies it before
  adopting the proxy.

**Behaviour now:** a box created with a proxy reaches `.com` only through
the relay during setup (or directly, marked, if the relay fails), then uses
the proxy for everything from the daemon's first call on.

### Disk unlock at boot (the initramfs)

The unlock runs in the initramfs, before the root filesystem exists
(`userdata.ts:1790–2190`, script `local-top/flagship-unlock`). It talks to the
boot worker `boot.flagshipserver.com` (not `.services`) with the initramfs's
copied-in `curl`: `GET /api/boot/lease/<domain>` (auto mode), `POST
/api/boot/request` and polling `GET /api/boot/response/…` (phone approval,
every 120 s, for up to a year). The hook (1728–1783) copies curl, its NSS
libraries and the CA bundle, and bakes `/boot` facts (boot host, unlock mode).

The earlier plan (bake the proxy, maybe its password, into `/boot`) is
dropped: **a proxy password never goes on `/boot`** (owner, 2026-10-15). The
initramfs uses OHTTP instead, which needs nothing secret: only the relay URL
and the gateway's public key configuration. The crypto is built; wiring it
into the initramfs script is design only (see below):

- **What's baked:** for a recipe with `outboundProxy`, the bootstrap writes
  `/boot/flagship-ohttp` (relay URL + hex key configuration, both public) next
  to `/boot/flagship-boot-host`, and the hook copies it into the initramfs.
  Boxes without a proxy get no file and unlock exactly as today.
- **The client (built):** the initramfs has curl, openssl and the Go
  `flagship-unseal` helper, but no Node, so the helper gained two modes:
  `flagship-unseal ohttp-seal --key-config-hex … --method … --url … [--header
  'name: value']… [--body-file …] --out-request … --out-context …` and
  `flagship-unseal ohttp-open --context … --response-file … --out-body …`
  (prints the inner status, like `curl -w %{http_code}`). The network stays in
  the initramfs's curl (`curl --data-binary @req -H 'content-type:
  message/ohttp-req' "$RELAY"`). `installer/unseal-helper/internal/ohttp`
  reproduces RFC 9458 Appendix A; `packages/control-plane/tests/ohttpGoInterop.test.ts`
  builds the binary and runs a signed boot-response poll through `.com`'s TS
  gateway. The three unlock calls (`GET /api/boot/lease/<d>`, `POST
  /api/boot/request`, `GET /api/boot/response/<d>/<nonce>`) keep their
  box-signed `Authorization: Flagship-Boot-v1` header inside the encrypted
  request; the gateway accepts exactly these paths on
  `boot.flagshipserver.com`.
- **Fallback, never a brick:** each call tries the relay (10 s timeout); on a
  timeout, network error, 402/403/5xx or an undecryptable answer it sends the
  same signed request directly with `x-flagship-relay-fallback: <reason>`, so
  unlock keeps working when the relay plan lapses. `.com` counts that, and
  /status/ shows the warning. The console `manual` passphrase escape is
  unchanged.
- **Polling cost:** the phone-approval poll runs every few seconds while it
  waits; through OHTTP each poll is one relay request. Lengthen the poll to
  ~5 s for proxy boxes (an approval rarely takes under a minute) so a boot
  costs ~10–40 relay requests; an auto-unlock boot costs one.
- **The Wi-Fi initramfs path** also uploads a bring-up log to `.com` with
  busybox wget on every boot (`userdata.ts`, `-wifi` late-log); a proxy
  recipe must leave it out (generation time, like the d-i beacons).
- The daemon rewrites `/boot/flagship-ohttp` (and runs `update-initramfs -u`)
  only if the relay or key ever changes for that box; key rotation keeps the
  old key valid on the gateway, so this is rare.

Why the script wiring is design only: it changes the initramfs unlock script
(and, for the appliance, needs a rebuilt base image carrying the new helper),
which reach a box only on a new burn, can't be exercised here (it needs a
Studio VM booting the real initramfs against a relay), and a mistake fails at
the one step with no daemon to report it. Until it ships,
**a proxy box's unlock request goes to `boot.flagshipserver.com` directly**,
once per boot; it is the largest remaining leak.

## OHTTP for the calls before the daemon (phase 2)

Owner decision, 2026-10-15: Oblivious HTTP (RFC 9458), **only for boxes with
a proxy set**, for the calls the proxy can't carry: the setup POSTs to `.com`
and the initramfs boot unlock. Once the daemon runs, the proxy carries
everything, heartbeats included. Boxes without a proxy keep talking directly
("if you don't set one, you're okay with us seeing your stuff").

How it works:

1. The box encrypts the request (method, URL, headers, body, as Binary HTTP)
   to `.com`'s gateway key (HPKE: X25519, HKDF-SHA256, AES-128-GCM) and POSTs
   the ciphertext to a **third-party relay**.
2. The relay forwards it to `.com`'s gateway. The relay sees the box's address
   and ciphertext; `.com` sees the request and the relay's address.
3. The gateway decrypts it, runs it against `.com`'s own router (never an
   outbound fetch, so it isn't an open proxy) and encrypts the answer back.

Pieces:

- **Protocol** (`packages/protocol/src/ohttp.ts`, `ohttpClient.ts`): HPKE base
  mode, the key configuration and `application/ohttp-keys` formats, request
  and response encapsulation, Binary HTTP known-length messages; pure JS so
  the Worker, the daemon and scripts share it. Reproduces RFC 9458 Appendix A
  byte for byte (`packages/protocol/tests/ohttp.test.ts`). `sendPrivately`
  is the client with the fallback rule.
- **Gateway in the `.com` Worker** (`packages/control-plane/src/ohttpGateway.ts`,
  `apps/com/src/ohttpRoutes.ts`), no dependency on Cloudflare's paid gateway:
  - `GET https://flagshipserver.com/.well-known/ohttp-keys`: the published
    key configurations (`application/ohttp-keys`, RFC 9540).
  - `POST https://flagshipserver.com/api/ohttp/gateway` (`message/ohttp-req`
    → `message/ohttp-res`): the relay's target.
  - Accepts only: on `flagshipserver.com`, `POST /api/server/register`,
    `POST /api/server/<domain>/sealed-luks-key`, `POST
    /api/order/<serial>/status`, `GET /api/ohttp/probe`; on
    `boot.flagshipserver.com`, `GET /api/boot/lease/<domain>`, `POST
    /api/boot/request`, `GET /api/boot/response/<domain>/<nonce>`. Anything
    else gets a 403 inside the encrypted answer. Spoofable headers
    (`cf-*`, `x-forwarded-*`, `host`, our fallback marker) are dropped from
    the inner request. 64 KiB cap.
  - Keys: Worker secret `OHTTP_GATEWAY_KEYS` = `<keyId>:<64 hex X25519
    private key>[,…]`, current key first; old keys stay listed during a
    rotation so boxes holding the old configuration keep working.
- **Relay** (owner): a well-known third-party OHTTP relay, **not Cloudflare**
  (`.com` is on Cloudflare, so a Cloudflare relay would put both halves with
  one company). Planned: Oblivious Network, $15/month tier (~2.6M requests).
  Swappable: boxes know only `relayUrl` + the gateway key configuration
  (`DEFAULT_OHTTP_RELAY` in `ohttpClient.ts`, null until provisioned; env
  `FLAGSHIP_OHTTP_RELAY_URL` / `FLAGSHIP_OHTTP_KEY_CONFIG` override it); the
  Worker knows `OHTTP_RELAY_URL` for its probe. An optional second relay
  later.
- **Fallback:** if the relay fails (timeout, unreachable, 402/403/5xx, a
  non-OHTTP or undecryptable answer), the client sends the same request
  directly with `x-flagship-relay-fallback: <reason>`. A lapsed plan costs
  privacy, never availability; unlock must keep working. An answer from the
  target itself (say a 409 from register) is the real answer and is never
  retried directly. Until the relay is provisioned, proxy boxes go direct
  marked `unconfigured`. A per-box strict mode (no fallback) is a later
  option; `sendPrivately` already takes `fallbackDirect: false`.
- **Which path each request took** (`relay_arrivals`, migration
  `0099_relay_health.sql`): `.com` counts arrivals per UTC day as `ohttp`
  (through the gateway) or `direct-fallback` (a direct request carrying the
  marker). No box, account or address is stored. `main` took 0098, so the
  branch holds 0099; `main` must skip 0099 while the branch is open.
- **/status/**: `/api/_status/probe` returns `privateRelay: {state, message,
  arrivals, lastProbe}`. The page shows **"Private relay down: servers are
  reaching Flagship directly"** when any direct fallback arrived today or
  yesterday, or the latest daily probe failed.
- **Daily probe**: the 00:00 UTC cron sends one OHTTP request through the
  relay to `GET /api/ohttp/probe` (no fallback), records the result
  (`relay_probes`) and, on failure, opens one GitHub issue ("Private relay
  down …", deduplicated while open), the same pager the CA lease uses.
- **Large files never go through OHTTP.** Code comes from GitHub, packages
  from npm and the registries, appliance images are downloaded by Studio on
  the owner's computer. OHTTP carries only small JSON setup and unlock calls
  (64 KiB cap); keep it that way.

Costs (Oblivious Network's $15 tier, ~2.6M requests/month): with these
decisions only setup and boot unlock use the relay, roughly **100–500
requests per proxy box per month** (setup ~15–30 once, ~1 per auto-unlock
boot, ~10–40 per phone-approved boot). Carrying the daemon's own calls
(heartbeats, pings) too would be ~10k–30k per box per month; not needed, the
proxy carries them.

Rate limiting: every OHTTP request reaches the Worker from the relay's
addresses, so IP-keyed limits would see all proxy boxes as one client. Key
the gateway's inner requests on the signed identity they carry instead.

**Launch item (later):** when proxying and paid features launch, use OHTTP for
**every** box during setup (cheap: setup is a few dozen requests), not only
proxy boxes.

## Pro only, and the branch

The outbound proxy is a **Pro** feature (owner, 2026-10-15), which is also
why it doesn't launch now. Per AGENTS.md, Pro features branch off
`feat/marketplace` (the payment rail), like `feat/custom-domains`.

- **Rebased onto `feat/marketplace` (2026-10-15)**, once marketplace was
  brought up to `main`. The pre-rebase tip is kept as
  `backup/outbound-proxy-pre-rebase-2026-10-15`.
- **How Pro is enforced.** The plan is the account's effective tier
  (`effectiveTierOf`: `free`, `hobby` = Pro, `maker` = Pro Max; a lapsed
  subscription counts as Free).
  - **The box:** `.com` returns `tier` in the daemon-status reply. Once the
    box has heard `free` it refuses a new or changed proxy order
    (`403 pro-required`, "An outbound proxy is part of Pro. You can still
    turn this one off.") and reports `available: false` in the proxy
    summary. Turning a proxy off always works. A proxy already set stays on
    when a plan lapses: dropping it would expose the box's address without
    the owner asking. Until `.com` has answered, the box refuses nothing,
    because a new box needs its proxy to reach `.com` at all.
  - **The create flow (all three apps):** the order is signed into the
    recipe on the phone and never passes `.com`, so nothing server-side can
    stop it. The apps read the plan from `GET /api/users/:u/allowance` (account
    read token) and show "An outbound proxy is part of Pro." with a link to
    the Pro page instead of the fields. An unknown plan (the read failed)
    shows the fields; the box's own check then applies to later changes.
  - **The server page (all three apps):** reads `available` from the box.
    `false` shows the Pro row; only "Turn off" remains, when a proxy is set.
  - **The OHTTP gateway doesn't check the plan** (it can't tell which box is
    asking, by design). Setup calls go through it only when the recipe
    carries a proxy, which the create flow allows only on Pro.
- **At launch of paid features:** OHTTP for every box during setup, free
  for everyone (see "Launch item" above), is not built.
- **Webapp shell version:** this branch uses **v93** (`feat/marketplace`
  v90, `feat/custom-domains` v91, `feat/custom-names` v92, `main` v89 at
  rebase time). Take the next free number whenever a parent passes it.

## Failure UX: the proxy stops working

What the box does:

- It keeps retrying through the proxy (the tunnel supervisor's backoff), and
  tracks `status`: `ok` → `failing` after the first failed connection to the
  proxy (with `since` and a plain reason: "Can't reach the proxy",
  "The proxy refused the connection", "The proxy refused the username or
  password", "The proxy couldn't reach <host>").
- With `fallbackDirect`, a connection the proxy can't make is made directly,
  and the status becomes `fallback` ("Using a direct connection: the proxy
  isn't answering"); it returns to the proxy on the next connection once the
  proxy answers again.
- Without it, the box stays offline to Flagship until the proxy is back. It
  never quietly goes direct: that's the owner's privacy choice.

What the owner sees and does:

- The server page shows the proxy (kind, host:port, "needs a password"), the
  status line, and **Change** / **Turn off**, each confirmed with biometrics.
- A box that is offline because of its proxy can still be reached **on the
  same network**: LAN-direct listens on the box's LAN addresses and never uses
  the proxy, so the owner's phone on that Wi-Fi opens the server page and
  changes or turns off the proxy (signed order over the LAN session).
- From anywhere else, nothing can reach a box that can reach nothing; that is
  the cost of "never go direct". The create flow and the edit sheet say so in
  one line under the fallback switch: "If this is off and the proxy stops
  working, the server goes offline until the proxy is back or you change it
  from the same network."
- Edits are tested before they apply (above), so a typo can't take the box
  offline.

## Threat model: what a proxy hides and what it doesn't

Hides:

- The box's IP from the hub, `.com`, Let's Encrypt, GitHub, npm, AI providers
  and app destinations (for the traffic in the phase 1 table).
- The hub logs' join of account and home address, retrospectively and going
  forward (the hub only ever sees the proxy's address).

Doesn't hide:

- **Which boxes belong to which account.** Hostnames are
  `<server>.<user>.flagship.services`, certificates are public in CT logs,
  and the hub routes by name. The proxy hides where a box is, not whose it is.
- **The proxy operator sees everything's metadata**: every destination host
  and port, timing and volume, and the box's real IP. TLS keeps content
  end to end (the hub tunnel, `.com`, ACME and app traffic are all TLS that
  terminates on the box or the destination), so a malicious proxy can read
  metadata and drop traffic, not read or change content. Choosing a proxy is
  choosing who learns your traffic pattern instead of Flagship.
- **Timing correlation.** Someone watching both the box's network and the
  hub can match connection timing. Tor resists this better than a single-hop
  proxy; nothing here defends against a global observer.
- **Remaining gaps**: every boot's unlock request until the initramfs OHTTP
  client ships, setup calls when the relay fails (marked and counted), Docker
  pulls (not Flagship), and the relay operator, who sees the box's address
  and the timing of its setup and unlock calls (not their content).
- **The box's LAN neighbours and the owner's ISP** still see that the box
  talks to the proxy (with SOCKS5/CONNECT the target host names also cross the
  local network in the clear, inside the CONNECT or SOCKS request; an HTTPS
  proxy, later, fixes that).
- **The phone.** Apps talk to the box through the hub; the phone's own IP
  reaching `.com` and the hub is untouched by a box setting.

Changes elsewhere:

- **LAN-direct**: unchanged (inbound on LAN addresses), and it becomes the
  recovery path for a box whose proxy is down. LAN-direct app copies between
  boxes stay direct (LAN addresses).
- **Egress fence**: unchanged policy; the gateway's upstream dial goes through
  the proxy by name after the same allow check and public-address check. An
  app never learns the proxy exists, can't reach it (apps have no route to
  the box's loopback bridge), and its approved hosts see the proxy's address.
- **AI privacy rule**: proxy settings and errors never enter a model's input;
  the AI's tool results carry only "the network is unavailable" style errors
  from the egress fence, as today.
- **The hub port.** The tunnel dials the hub on port 8443
  (`wss://flagship-services.fly.dev:8443/tunnel`). Many proxies (most
  corporate CONNECT proxies, some Tor exits) only allow 443. A box behind such
  a proxy can't open its tunnel. The test-before-apply catches this and says
  "Some proxies only allow port 443; Flagship's relay uses 8443". Kept on
  8443 for now (owner). **Recommended future work:** accept the tunnel on 443
  too, under a dedicated name such as `tunnel.flagship.services` that the
  hub's SNI router (which already peeks every :443 connection) sends to the
  tunnel hub; boxes behind 443-only proxies then use `wss://tunnel.flagship.services/tunnel`.

## Phase 1 (this branch) vs later

Phase 1, built:

- Protocol order, vectors, parity tests in TS, Swift, Kotlin and the webapp.
- Daemon: the connector (CONNECT, SOCKS5 with remote DNS and RFC 1929
  auth), the dispatcher/agents, the loopback bridge for child processes, the
  egress gateway's upstream dial, the store, first-boot adoption from the
  install blob, status tracking, and `GET`/`POST /api/screens/outbound-proxy`
  with test-before-apply.
- Recipe siblings passed through to `install-blob.json` (builders and engine).
- Apps: proxy fields in the create flow's Advanced section; the server page's
  Outbound proxy section with a biometric-confirmed edit.

Phase 2, built: OHTTP (protocol, client, `.com` gateway, arrival counting,
/status/ warning, daily probe and issue), the bootstrap's and specializer's
setup calls through it, silent d-i beacons for proxy recipes, the health
timer through the proxy.

Design only: wiring the (built) Go OHTTP client into the initramfs unlock
script and baking `/boot/flagship-ohttp` (above), the Wi-Fi initramfs log
upload left out for proxy recipes, Docker pulls via the bridge, the update
guard's `npm ci`, per-box strict mode, a second relay, OHTTP for every box's
setup at launch, the tunnel on 443.

Later: HTTPS proxies, WireGuard full tunnel, a Flagship-run Tor option
(`kind: tor` with an on-box tor daemon), per-destination rules.

## Owner decisions (recorded 2026-10-15)

1. **OHTTP** for proxy boxes' setup POSTs and boot unlock, through a
   non-Cloudflare third-party relay (Oblivious Network planned), with our own
   gateway in the Worker and a direct, counted fallback. Built except the
   initramfs script wiring (the Go client itself is built and tested).
2. **Pro only**; branches off `feat/marketplace`. Rebase deferred (above).
3. **Port 8443 only** for now; the 443 tunnel name is recommended future work.
4. **Password in the create flow** allowed, with the setup-file warning.
5. **"Connect directly if the proxy is down"** off by default.
6. **Never store a proxy password on `/boot`**; the initramfs uses OHTTP.
7. **Copy** on what a proxy doesn't hide stays as written above.

Still open: provisioning the relay (Oblivious Network account,
`OHTTP_RELAY_URL`, generating `OHTTP_GATEWAY_KEYS` and setting
`DEFAULT_OHTTP_RELAY` in a release); whether to add the second relay; when to
switch every box's setup to OHTTP.
