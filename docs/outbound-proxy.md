# Outbound proxy for a box

Status: phase 1 being built on `feat/outbound-proxy` (2026-10-14). Not on
`main`, not deployed, no box release endorsed.

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
- **Before the daemon exists: yes, but it needs a live drill first.** The
  first-boot bootstrap and the initramfs unlock both use `curl`, which
  supports `-x http://…` and `-x socks5h://…`. The plumbing is small (below);
  what makes it phase 1b is that it changes the signed install path and the
  initramfs, which reach a box only on a new burn and can't be tested here, and
  a mistake there leaves a box that can't unlock its disk.

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
   - Server detail (`/api/screens/server-detail`) carries the same `proxy`
     summary so the page can show it without a second call.

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
- The separate `flagship-health.service` timer (`healthReporter.ts`, curl to
  `.com`), which doesn't run under the daemon's environment. Phase 1b: give it
  the bridge too, or fold it into the daemon. **This one reaches `.com`.**
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

The default install path today is the VM appliance (Studio) or a USB stick
built from it, which skips apt/git/npm/go entirely; what's left before the
daemon is two `.com` POSTs and the status reports. So phase 1b for the
bootstrap is small: when `install-blob.json` has `outboundProxy`, write a
0600 curl config (`proxy = "socks5h://host:port"`, `proxy-user = …`) and add
`-K` to the bootstrap's `.com` curls; export `HTTPS_PROXY`/`ALL_PROXY` for the
installer-only steps; skip the busybox beacons. The bootstrap may use the
sibling without verifying it (whoever writes the install media already
controls the disk); the daemon verifies it before adopting it.

**Phase 1 behaviour, honestly:** a box created with a proxy registers with
`.com` and uploads its sealed disk key directly (two requests at setup), then
uses the proxy for everything from the daemon's first call on.

### Disk unlock at boot (the initramfs)

The unlock runs in the initramfs, before the root filesystem exists
(`userdata.ts:1790–2190`, script `local-top/flagship-unlock`). It talks to the
boot worker `boot.flagshipserver.com` (not `.services`) with the initramfs's
copied-in `curl`: `GET /api/boot/lease/<domain>` (auto mode), `POST
/api/boot/request` and polling `GET /api/boot/response/…` (phone approval,
every 120 s, for up to a year). The hook (1728–1783) copies curl, its NSS
libraries and the CA bundle, and bakes `/boot` facts (boot host, unlock mode).

Feasible: curl in the initramfs does `-x socks5h://` and `-x http://` as is.
Design (phase 1b):

- The proxy (kind, host, port, fallback; **no credentials**) is baked as
  `/boot/flagship-proxy` next to `/boot/flagship-boot-host` (bootstrap 1694)
  and copied by the hook; the daemon rewrites it and runs `update-initramfs -u`
  when the owner changes the proxy.
- **Credentials can't go there safely.** `/boot` is unencrypted, so a password
  in the initramfs is readable by anyone holding the disk. For a proxy with a
  password the unlock either goes direct (if `fallbackDirect`) or the owner
  opts in to "Store the proxy password on the boot partition" (a separate,
  explicit choice, never the default).
- **Proxy down at boot must not brick the box.** The unlock loop tries the
  proxy; with `fallbackDirect` it falls back to a direct request after three
  failed tries; without it, it keeps retrying (the relay loop already waits
  for the phone indefinitely) and logs the reason to
  `FLAGSHIP_BOOT:/flagship-unlock.log` so Studio's stalled-boot advisory can
  say "Can't reach the proxy". The console `manual` escape (Debian cryptroot
  passphrase prompt) is unchanged. Nothing about the disk key changes, so a
  proxy outage delays an unlock, never destroys one.
- Until 1b ships, **every boot's unlock goes to `boot.flagshipserver.com`
  directly**, i.e. Flagship's boot worker sees the box's IP once per boot.
  This is the largest remaining leak in phase 1 and the reason 1b matters.

Why 1b is not built in this pass: it changes the install-time bootstrap and the
initramfs, which only reach a box on a new burn, can't be exercised without a
real install (Studio VM plus a SOCKS/CONNECT proxy on the host), and a mistake
there fails at the one step that has no daemon to report it.

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
- **Phase 1 gaps**: the setup-time registration and sealed-key upload, every
  boot's unlock request, the health timer and Docker pulls (above).
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
  "The proxy won't connect to port 8443". Owner decision below.

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

Phase 1b: the bootstrap's `.com` curls and the initramfs unlock through the
proxy (designed above), the health timer, Docker pulls via the bridge.

Later: HTTPS proxies, WireGuard full tunnel, a Flagship-run Tor option
(`kind: tor` with an on-box tor daemon), per-destination rules.

## Owner decisions

1. **Port 8443.** Either accept that proxies limited to 443 can't carry the
   tunnel, or let the hub accept the tunnel on 443 too (the SNI router already
   peeks every :443 connection; a dedicated name such as
   `tunnel.flagship.services` could route to the hub).
2. **Credentials in the setup file** when the owner types them in the create
   flow (recommended, with the warning) versus refusing password proxies at
   creation.
3. **Default for "connect directly if the proxy is down"**: off (recommended:
   it's a privacy setting) or on.
4. **Phase 1b initramfs**: whether a proxy password may ever be stored on the
   boot partition (opt-in) or password proxies always unlock direct.
5. **Copy**: how strongly to say what a proxy doesn't hide (the account ↔
   servers link stays public).
