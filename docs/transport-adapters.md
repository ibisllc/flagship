# Transport adapters: a box serves on any network its host can reach

Status: DESIGN (2026-11-14, branch `0.4/transport-adapters`). Nothing below is built. Written for the owner's
request of 2026-11-14:

> The boxes should be willing and able to use any connection protocol possible to go online. [...] build an adapter
> that lets our servers join any sort of network available to their host machine. It should not only be
> internet/ipv6 - as long as you can connect a fshp server and plug the software adapter it will serve on anything.
> What does that mean for encryption? Sessions? HTTPS? (If a server owner decides to talk over an exotic channel,
> they should be aware and reminded that they take responsibility for that)

Read with: `direct-access-and-domains.md` (the owner's-infrastructure rule this generalises), `lan-direct.md` (the
listener, hint and failure rules reused here), `data-sovereignty.md` (key-bound hello, offline control, the threat
model T1-T5), `relay-addresses.md`, `architecture-v2/pq-suites.md` §13 (`flagship/pq-session/v1`) and §15 (strict),
§17 (authenticated time), §19 (boot unlock v2), `architecture-v2/relay-mesh.md`, `browser-extension.md`.

## 0. Decisions proposed, in one page

1. **A transport adapter only moves bytes.** It never holds a Flagship key, never sees plaintext, never decides who
   someone is. Identity, encryption and authorisation stay on the box (keyd, ingress, the daemon's gates) exactly as
   they are over the relay. An adapter is in the relay's position: it sees ciphertext and metadata.
2. **Two adapter shapes.** *Stream* adapters carry a reliable byte stream (anything that can carry TLS: IP of any
   kind, overlays, Tor, I2P, a serial line with a framing layer). *Message* adapters carry bounded, possibly delayed
   datagrams (LoRa, Reticulum/LXMF at low rates, satellite short-burst, sneakernet). Full apps need a stream; message
   adapters carry signed orders, status and short messages only.
3. **The name stays the identity, the adapter address is only a route.** The box is still
   `<box>.<user>.flagship.services`; TLS SNI, the WebPKI certificate, the STK pin and the PQ binding all name it. An
   onion, a Yggdrasil address or a Reticulum destination is a way to reach that identity, published in an
   STK-signed (hybrid under strict) endpoint record that goes to the owner's devices, never through `.com`.
4. **Trust has three tiers, picked per connection, strongest first:** (a) WebPKI TLS for the box name (works over
   any IP-shaped route if the client maps the name to the route); (b) key-bound TLS: any certificate, proven by an
   STK-signed hello naming the certificate hash (the rescue pattern, `data-sovereignty.md` §4.3), for when the
   certificate cannot be validated (expired, no DNS, no CA reach); (c) `pq-session/v1` inside either, mandatory
   whenever (a) is not available and whenever the server is strict. Message adapters use hybrid-sealed, hybrid-signed
   envelopes (no TLS at all).
5. **Most of "any network" is the host's own interfaces.** WireGuard, Tailscale, Headscale, ZeroTier, Nebula,
   Yggdrasil, cjdns, a Freifunk/B.A.T.M.A.N. or 802.11s mesh, a Starlink dish, a second ISP: each shows up on the
   host as an IP interface. One first-party adapter, **host-ip**, generalises the LAN-direct listener to
   owner-consented interfaces. This is the 0.4 candidate.
6. **Exotic channels need the owner's signed consent, and it is load-bearing.** A `flagship/transport-consent/v1`
   order (admin root, hybrid under strict, biometric) names the adapter, the adapter binary's hash, the scopes
   (owner control, visitors, box to box, unlock, messages), the hash of the warning text the owner saw, and an expiry.
   The box's adapter supervisor will not start an adapter, and ingress will not accept a stream tagged with it, without
   a verifying, unexpired consent. Renewal is the recurring reminder; a lapsed consent drops visitors first and keeps
   owner control so the owner can renew over the same channel.
7. **First-party adapters ship in the endorsed release; third-party adapters are carriers only.** A third-party
   adapter runs sandboxed, with no keyd socket and no data, and the consent pins its hash. Anything that would end a
   cryptographic layer (an onion service, for instance) runs inside the box's trust boundary and is first-party only.

## 1. Where we start from

Today a box is reached three ways, all carrying TLS that ends on the box:

| Path | Carrier | Who opens it | Doc |
|---|---|---|---|
| Relay | Fly relay, SNI passthrough, box-held tunnel | everyone | `relay-mesh.md`, `relay-transport.md` |
| LAN-direct | box listener on private addresses | owner's phones, box to box | `lan-direct.md` |
| Direct names | public IPv6/IPv4 on `fshp.app` | visitors and owner | `direct-access-and-domains.md` |
| Rescue / offline control | LAN, key-bound TLS, no `.com` | owner's phone | `data-sovereignty.md` |

Everything the owner asked for already has a precedent. The relay path proves "the carrier sees only ciphertext";
LAN-direct proves "a second listener that fails as a no-op"; direct access proves "the owner's infrastructure, the
owner's responsibility, records only from signed orders"; rescue proves "trust the box by key when the certificate
means nothing". Transport adapters turn these one-offs into one mechanism.

## 2. Survey of channels

Facts checked 2026-11-14 (sources at the end). "Features" uses these levels:

- **Full**: apps for visitors and owner, sync, app copies, everything a relay connection carries.
- **Owner**: owner control (the offline-control set from `data-sovereignty.md`, plus everything the owner's apps do
  over a stream), box-to-box access sync, backups if the bandwidth allows. No public visitors.
- **Messages**: signed orders, status, alerts, short text. No apps, no backups.
- **Unlock**: carries a boot-unlock v2 request and reply (§19 of `pq-suites.md`: a few KB each way).

### 2.1 IP channels (stream)

| Channel | Addressing | Bandwidth / latency | Features | Discovery and naming |
|---|---|---|---|---|
| Public IPv6 / IPv4 | global addresses | broadband / ms | Full | DNS (`flagship.services` via relay, `fshp.app` direct). Already built. |
| LAN only | RFC 1918, ULA, link-local | LAN / sub-ms | Owner (Full for local visitors with key-bound or WebPKI TLS) | mDNS opaque id (`rescueDiscoveryId`), signed hint. Built. |
| WireGuard (plain) | owner-assigned private addresses per peer | link-limited / +1 RTT | Full among peers | Static config; no names. The endpoint record carries the address. |
| Tailscale / Headscale | 100.64.0.0/10 and `fd7a:115c:a1e0::/48`, MagicDNS `*.ts.net` | near-native, DERP relay fallback | Full among tailnet members | The tailnet's own names. Headscale keeps the coordinator self-hosted. The coordinator (Tailscale Inc. or the owner's Headscale) decides who joins the network, not who is authorised on the box. |
| ZeroTier | virtual L2, private addresses | near-native | Full among members | Controller-assigned; the controller sees membership. |
| Nebula | owner CA, overlay addresses | near-native, lighthouses for discovery | Full among members | Lighthouse; the owner runs the CA. |
| Yggdrasil | `200::/7`, the /128 derived from the node's public key (self-certifying) | variable, multi-hop over peers | Full, globally on the Yggdrasil network | No DNS. Address is a key hash. Any Yggdrasil node can reach any other: a public overlay, not a private one. |
| cjdns | `fc00::/8`, derived from the node's key | variable, low adoption | Full | As Yggdrasil; few public peers today. |
| Community meshes: Freifunk (B.A.T.M.A.N. adv, Babel), 802.11s, NYC Mesh | local mesh addressing (often 10.x or fdxx, sometimes public IPv6), often an internet uplink | Wi-Fi mesh, degrades per hop | Full on the mesh; Full on the internet if the mesh gives a public route | Community DNS or none. To the box it is a LAN or an ISP. |
| Satellite: Starlink, OneWeb (LEO) | ISP addresses, IPv4 behind CGNAT, IPv6 native on Starlink | tens of Mbit/s / 25-60 ms | Full via relay; direct over IPv6 | Ordinary internet. |
| Satellite: GEO (VSAT) | ISP | Mbit/s / ~600 ms RTT, PEP proxies | Full but slow; TLS handshakes visibly slow | Ordinary internet. |

All of these show up on the host as interfaces (`wg0`, `tailscale0`, `ygg0`, `bat0`, `mesh0`, a second NIC). That is
why one adapter, host-ip (§3.4), covers the whole table.

### 2.2 Anonymity networks (stream)

| Channel | Addressing | Bandwidth / latency | Features | Discovery and naming |
|---|---|---|---|---|
| Tor onion services (v3) | 56-char base32 `.onion`, the service's Ed25519 key (self-certifying) | ~1-few Mbit/s / 0.5-3 s per round trip, TCP only | Full for apps and owner; no UDP (no calls) | No DNS; the address is the key. Restricted discovery (client authorisation) hides the service from anyone without a key. Tor Browser treats `.onion` as a secure context. |
| I2P | `.b32.i2p` destination hash | slower than Tor, tunnel build seconds | Owner; apps possible but painful | Address book or b32. Smaller network, fewer client tools. |

Notes. Arti (Tor in Rust) is at 2.5.x (August 2026); its onion-service *hosting* is usable but the Tor Project has
not called it production-equal to C tor, and the hosting side has had the fewest audits. Onion keys and Tor's
circuit handshakes are classical (X25519, Ed25519): a quantum adversary recording traffic could later strip the
onion layer, so Flagship's own PQ layer still matters inside it. WebPKI certificates for `.onion` exist (DigiCert EV,
HARICA DV, no ACME), so automated HTTPS on an onion name is not available to us.

### 2.3 Radio, mesh and delay-tolerant channels (mostly message)

| Channel | Addressing | Bandwidth / latency | Features | Discovery and naming |
|---|---|---|---|---|
| Reticulum (RNS) over LoRa (RNode), packet radio, serial, also over IP | 16-byte destination hashes from keys (self-certifying) | 5 bit/s minimum to Mbit/s; 500-byte MTU | over LoRa: Messages, slowly Unlock; over IP or a fast radio: Owner | Announces; LXMF for store-and-forward messages. Has its own encryption (X25519/Ed25519, classical). |
| Meshtastic (LoRa) | 32-bit node ids (not self-certifying) | ~0.2-20 kbit/s; ~237-byte payload; EU 868 sub-bands 0.1-1 % duty cycle | Messages only, and only tiny ones (§4.6) | Channel names and a shared channel key. MeshCore is similar. |
| Bluetooth LE / Bluetooth mesh | device addresses | ~100s of kbit/s / metres | Owner ceremonies at arm's length: pairing, unlock approval (as `lan-direct.md` "Bluetooth (later)" proposes) | Proximity; no naming. |
| Satellite short-burst (Iridium SBD and similar) | modem id via a provider gateway | ~340-byte messages / seconds to minutes, per-message cost | Messages, alerts, Unlock in several bursts | The provider's gateway sees every message. |
| Sneakernet / store-and-forward (USB stick, SD card, a courier) | none; a file | huge bandwidth / hours to weeks | Messages, backups (`.flagship` files already exist), signed orders, release updates | A file named by the box's opaque id. |
| Amateur radio bands (packet, HF, VARA, AX.25, Reticulum on ham frequencies) | callsigns | very low / seconds to hours | **None that Flagship can run** (below) | — |

**Licensing is not our call but it is our duty to say it.** In the US, Part 97 §97.113(a)(4) forbids messages
"encoded for the purpose of obscuring their meaning" on amateur frequencies; the FCC has said authentication-only
encoding is fine. Most countries have the same rule. Flagship cannot run with its encryption off, so an adapter whose
medium is declared amateur is refused, not warned about. LoRa on ISM bands (868, 915 MHz) is unlicensed and allows
encryption, but duty-cycle and dwell limits apply (EU 868: 0.1-1 % per sub-band), and the US 900 MHz rules are under
public discussion as of September 2026; the owner is responsible for the radio's configuration.

### 2.4 What each channel means for discovery and naming

- **Self-certifying addresses** (onion, I2P, Yggdrasil, cjdns, Reticulum): the address is a hash of a key the adapter
  holds. A route to it reaches whoever holds that key, which is the box's adapter, so a phone that has the endpoint
  record will not be misrouted. It still authenticates the *box* above that (TLS/pq-session); the adapter key is not a
  Flagship identity and is never signed as one.
- **Assigned addresses** (WireGuard, Tailscale, ZeroTier, Nebula, community meshes, LANs): whoever runs the overlay's
  coordinator can move the address to another machine. Harmless for confidentiality (the impostor cannot show the
  box's key), but it is how a dial can land on the wrong machine, so the client treats a handshake failure as "route
  bad", exactly as LAN-direct does.
- **No naming service is trusted.** MagicDNS, community DNS, Yggdrasil's lack of DNS, Tor's lack of DNS: none of it
  matters, because the client gets the route from the box's own signed endpoint record and names the box by its
  Flagship name in SNI and in the session.
- **`.com` stays out of exotic routes.** Like the LAN hint, the endpoint record goes box to the owner's devices only.
  `.com` learns that a box has adapters (so it can say "this server is also reachable another way" without saying
  how) only if the owner chooses; by default it learns nothing. Reason: an onion or overlay address in `.com`'s
  database is a link between a Flagship account and a location or a pseudonymous identity, which is exactly what the
  owner picked the channel to avoid. It also keeps the data-sovereignty promise: a channel that `.com` does not know
  about cannot be withdrawn by `.com`.
- **Visitors** learn an exotic route only when the owner publishes it for one app (an onion link on the voi.ci page,
  a QR code, a printed card). Per-app identity (owner rule) is unaffected, since visitor keys are per app whatever
  the carrier; but one onion for the whole box makes all its public apps visibly co-located, so §5.4 recommends one
  onion per published app.

## 3. Adapter architecture

### 3.1 The interface

Rust trait in a new crate `rust/crates/flagship-transport` (ingress and the boot client are Rust; the TS daemon gets
the same contract over the adapter socket, §3.3). Sketch:

```rust
pub enum Shape { Stream, Message }

pub enum LatencyClass { Lan, Broadband, Slow /* ≤ 5 s RTT */, Narrowband /* minutes */, DelayTolerant /* hours+ */ }

pub struct Capabilities {
    pub shape: Shape,
    pub mtu: u32,                  // stream: largest write it carries well; message: max payload bytes
    pub latency: LatencyClass,
    pub bandwidth_bps: Option<u64>,// a measured or declared estimate, for client route choice
    pub duty_cycle_permille: Option<u16>, // radio budget the adapter enforces, if any
    pub udp: bool,                 // can carry datagrams (calls); false for Tor, LoRa
    pub regulatory: Regulatory,    // Unlicensed | Licensed | Amateur (refused) | Unknown
    pub self_certifying: bool,     // address is a key hash
    pub metadata: MetadataProfile, // what the carrier's operators and neighbours learn (§4.7)
}

pub trait TransportAdapter {
    fn id(&self) -> AdapterId;               // "host-ip", "tor", "reticulum", ...
    fn capabilities(&self) -> Capabilities;
    fn local_addresses(&self) -> Vec<Endpoint>; // what goes in the endpoint record
    fn reachability(&self) -> Reachability;  // Up | Degraded{why} | Down{why}; never "trusted"
    // Stream:
    fn listen(&self, on_accept: impl Fn(Inbound /* opaque byte stream + carrier metadata */));
    fn dial(&self, to: &Endpoint) -> Result<Outbound, DialError>;
    // Message:
    fn send(&self, to: &Endpoint, payload: &[u8], ttl: Duration) -> Result<SendTicket, SendError>;
    fn on_receive(&self, f: impl Fn(Received /* bytes, from-endpoint, received-at */));
}
```

What the interface deliberately lacks: no "peer identity", no "authenticated" flag, no key material, no access to
the box's names or certificates, no hook into HTTP. An adapter cannot tell ingress who a caller is; it can only hand
bytes over. `Inbound` carries carrier metadata (adapter id, the far endpoint if any) used for logs, rate limits and
the consent scope check, never for authorisation.

### 3.2 Where adapters plug into the box

```
                       ┌──────────── box trust boundary (keyd, ingress, daemon) ────────────┐
 relay tunnel  ──────► │ flagship-ingress: SNI gate → TLS (keyd-held key) → pq-session →   │
 LAN listener  ──────► │   daemon handler chain (owner sessions, app proxy, access gate)   │
 host-ip adapter ────► │                                                                    │
 tor (in-boundary) ──► │   message endpoint: open hybrid-seal → verify hybrid-sig →         │
 carrier adapters ───► │   same order verifiers as offline control                         │
  (sandboxed, socket)  └─────────────────────────────────────────────────────────────────────┘
```

- **Stream adapters feed ingress the way the relay tunnel does.** Ingress already accepts streams from the relay
  tunnel and from the LAN listener and runs the same SNI gate and TLS on both. An adapter stream enters at the same
  point, tagged with its adapter id. TLS (and pq-session where required) ends in ingress with keyd-held keys.
- **Message adapters feed a new message endpoint** in the daemon that accepts only sealed envelopes (§4.6) and passes
  the opened order to the existing verifiers (offline-control orders, sensitive orders, `admitUpdateOrder`, ...).
  Nothing in a message envelope is acted on before its signature verifies under a key the box already trusts.
- **Outbound** (box to box access sync, app copies, the box's own `.com` calls) asks a route chooser for a route to a
  sibling or to `.com`: relay, LAN, direct, then adapters the consent scopes allow for `box-to-box` or `control`.
  The far end is still checked by name (WebPKI) or by pinned key (sibling `box-stk` binding, `pq-suites.md` §16.1).
- **Broker and sandbox.** Adapters are processes started by the broker (arch-v2) from the release (first-party) or
  from an owner-supplied file whose hash the consent names (third-party). Each gets: its own user, its own state
  directory, the network capabilities its medium needs (a TUN device, a serial port, a USB radio), the adapter
  socket. It gets no keyd socket, no data directory, no app network, no `/boot`. The box's nft rules allow traffic on
  an adapter's interface only to ingress's listener and the adapter's own needs; nothing else on the box listens
  there (Postgres, the egress gateway, app bridges stay unreachable).
- **Two adapter kinds by trust:**
  - *Carrier adapters* (sandboxed, can be third-party): they see ciphertext. Examples: a serial-line framer, a
    Reticulum bridge carrying TLS records or sealed envelopes, a WireGuard userspace daemon.
  - *In-boundary adapters* (first-party only, compiled into ingress or keyd-adjacent, reviewed, in the endorsed
    release): they end a cryptographic layer themselves. The one we need is Tor: an onion service decrypts the onion
    layer, and for Tor Browser visitors (§4.3) what is inside may be plain HTTP, so the onion must end inside the same
    process that ends TLS. Arti is Rust, so it can be linked into `flagship-ingress`. An owner cannot plug in an
    in-boundary adapter; if one were possible, "adapters never see plaintext" would be a promise we could not keep.
- **Host-provided networks need no adapter process at all.** If the host already has `tailscale0` or `ygg0`, the
  host-ip adapter only binds ingress to it (§3.4). Running the overlay daemon itself (tailscaled, yggdrasil) is either
  the owner's own host setup or, for appliances, a first-party carrier adapter package. Owner rule
  "plug-and-play boxes": the appliance should offer the common overlays as switches, not shell work.

### 3.3 The adapter socket (third-party carriers)

A Unix socket at `/run/flagship/adapters/<id>.sock`, one framed protocol (reuse the relay's v1 frame format,
`u32 streamId | u8 type | u32 len | payload`, with OPEN/DATA/CLOSE and the credit extension from `relay-transport.md`
§1, plus SEND/RECEIVE for messages). The adapter is the client; ingress is the server and treats every stream like a
relay stream. Reusing the relay frames means the conformance suite for the relay covers most of the socket, and a
hostile adapter is no worse than a hostile relay, which the design already assumes.

### 3.4 host-ip: the first adapter

host-ip generalises the LAN-direct listener:

- The owner's consent names interfaces or prefixes (`tailscale0`, `200::/7` on `ygg0`, `10.42.0.0/16` on `bat0`).
  The box binds ingress's listener (port 443, and the LAN caps: 256 connections, 5 s first bytes, 5 min idle) on the
  addresses it finds there and nowhere else. Public addresses stay the direct-access order's business: host-ip refuses
  a global unicast address outside the overlay ranges the consent names, so the two orders never overlap.
- It serves an STK-signed endpoint record (`flagship/endpoints/v1`, §3.5) to paired devices, generalising
  `lan-hint/v2`.
- Clients dial the overlay address with SNI = the box name and the same probe-then-prefer rules as LAN-direct
  (background probe, pin, fall back to the relay at the first failure, never send to an address that hasn't proved
  itself). Phones use whatever overlay the phone's OS already has (the Tailscale app, a Yggdrasil VPN app): iOS and
  Android each allow one VPN at a time, and Flagship should not take that slot in 0.4.
- Box to box: siblings that share an overlay prefer it, as app copies prefer the LAN today.
- Yggdrasil and cjdns are *public* overlays: binding ingress there exposes the box to every node on that network,
  much like a public IPv6 address. The consent screen says so, and the class is `visitors-exposed` (§5.2).

### 3.5 The endpoint record

```
flagship/endpoints/v1|<serverDomain>|<certSha256>|<consentSha256s>|<endpoints>|<issuedAt>|<expiresAt>
endpoint = <adapterId>:<shape>:<latencyClass>:<address>[:<port>]
```

STK-signed; hybrid-signed when the server is strict. Canonical sorting and address spelling follow
`directAccess.ts`. Each endpoint must sit inside a consent it names (by SHA-256 of the consent's canonical bytes); a
device verifies those consents under the account's sensitive-order key before dialing (the rule hint v2 already uses
for `direct`). `certSha256` voids the record on certificate rotation, as with the LAN hint. Delivered over any working
path (relay, LAN, the adapter itself) and kept by the phone with the server's other pins, so that it survives `.com`
going away (`data-sovereignty.md` §4.9 server list).

### 3.6 How clients reach a box

| Client | Stream over IP overlays | Tor | Message adapters |
|---|---|---|---|
| iOS / Android app | yes: dial the overlay address through the OS's VPN; same CONNECT/socket factory path as LAN-direct | phase 2: embedded Arti client on both (Arti builds for iOS and Android) | phase 3: through a companion device (an RNode over Bluetooth, a Meshtastic radio over BLE) the app drives |
| Studio (desktop) | yes, through the host OS | phase 2, embedded Arti | phase 3, a USB radio |
| Webapp | **no**: it lives on `webapp.flagshipserver.com`, needs `.com`, and a page cannot choose routes or pin keys | no | no |
| Firefox extension | later: `proxy.onRequest` can send a paired box's names through a local SOCKS proxy (an overlay or Tor), and its pin check stays as it is | later, same way | no |
| A visitor's browser | if the visitor's machine resolves the box name to the overlay address (their own DNS, hosts file, MagicDNS split DNS), WebPKI TLS just works | Tor Browser with Alt-Svc (§4.3) | no |
| Another box | yes | phase 2 | phase 3 |

Route choice on owner devices, first that proves itself: LAN → direct → host-ip overlays → relay → Tor → message.
The owner can mark the relay "never" for a server (like direct names, this is their call); then the box is reachable
only by their own routes and the apps say so.

### 3.7 Coexistence with the relay and direct access

- The relay tunnel is conceptually just the first-party "relay" adapter; nothing about it changes. A box may hold a
  relay tunnel and any number of adapters at once.
- Adapters never get a `flagship.services` or `fshp.app` record. Those zones keep their rules (`wildcard-dns.md`,
  direct access §5).
- Quota: only relay bytes are metered. Adapter traffic is free of relay quota, as direct traffic is.
- The serving lease / dead-man (`serving-wiring.md`) is enforced by the relay and `.com` today, so it does not reach
  adapter traffic. Whether the box itself should refuse visitors on every route when its owner's dead-man lapses is
  an owner question (§9, Q5).

### 3.8 What is not allowed

- An adapter never gets a key: no keyd socket, no STK, no TLS key, no CGK, no session keys, no sealed blobs.
- An adapter never gets plaintext: carriers see TLS records or sealed envelopes only; the one in-boundary adapter
  (Tor) is first-party code in ingress.
- An adapter never authenticates anyone and never makes a request "trusted" (no "it came over the tailnet, so it is
  the owner" shortcut). Overlay membership is not Flagship authorisation; Tailscale ACLs or Nebula groups are an extra
  fence the owner may add, never a replacement.
- An adapter never writes DNS, never talks to `.com` on the box's behalf with credentials, and never changes the
  endpoint record (the daemon signs it).
- No adapter on amateur frequencies (refused, §2.3).
- No adapter is ever handed to an AI session or exposed to a staging copy; endpoint records, onion addresses and
  overlay addresses are owner-identifying and go through `buildModelRedactor` (owner rule: an AI never learns who or
  where the owner is).
- An adapter cannot disable or downgrade the strict PQ gate: a strict server requires pq-session on adapter streams
  just as on the relay.

## 4. Encryption, sessions, HTTPS

### 4.1 The rule

End-to-end stays at the box. Every byte an adapter carries is either TLS that ends in ingress, an onion stream that
ends in ingress, or a hybrid-sealed envelope that only keyd-held keys open. The carrier's own encryption (WireGuard,
Tor, Reticulum, Meshtastic's channel key) is a bonus for metadata and for the hop, never something Flagship relies on
for confidentiality or authentication. That matters: most of those layers are classical (X25519/Ed25519), some use a
shared key (Meshtastic channels), and their operators (a Tailscale coordinator, a ZeroTier controller, a Headscale
server) can add a peer.

### 4.2 When WebPKI HTTPS works, and when it can't

A Let's Encrypt certificate names `<box>.<user>.flagship.services` (or `<label>.fshp.app`), not an address. So it is
valid over *any* route as long as the client asks for that name and the certificate is current:

| Situation | WebPKI | What we use |
|---|---|---|
| IP overlay, client resolves the box name to the overlay address (phone app via endpoint record, a visitor with split DNS, the extension via proxy) | works | WebPKI TLS (+ pq-session if strict) |
| Tor Browser visitor arriving through Alt-Svc on the box name | works | WebPKI TLS inside the onion |
| Onion-only, Tor Browser typing the `.onion` | no (no ACME for `.onion`; HARICA DV is manual and per name) | onion layer only, ending in ingress (§4.3) |
| Box cut off from the internet for weeks (no renewal; LE lifetimes are falling to 45 days by 2028; 6-day certs exist) | the certificate expires | apps: key-bound TLS + pq-session; browsers: break |
| Mesh-only box that never reached a CA | never had one | apps: key-bound TLS (self-signed, proven by STK) + pq-session |
| Message adapters | not applicable | hybrid-seal + hybrid-sig envelopes |

Renewal needs the box to reach the issuance service (DNS-01 through `.com`). On a censored network the box can reach
`.com` *as a client* over Tor or another overlay's exit: so the Tor adapter's outbound side is also the way a box
keeps its certificates and leases when its ISP blocks us (T3/T4 in `data-sovereignty.md`), while TLS still ends on
the box.

### 4.3 Browsers

- **Tor Browser.** Two modes. *Alt-Svc mode* (preferred): the box serves `Alt-Svc: h2="<onion>:443"` on its normal
  names (per published app); Tor Browser then reaches the box through the onion and validates the box's WebPKI
  certificate, so TLS still ends in ingress, and the onion hides the visitor and the box's location. *Onion-only
  mode*: plain HTTP inside the onion, which Tor Browser accepts as a secure context; the onion's Ed25519 key is then
  the only authentication, and it is classical. Allowed only because the onion ends inside ingress (in-boundary), and
  shown to the owner as "classical, not quantum-safe" in the consent. A strict app refuses onion-only browsers, the
  same rule as other browsers under strict (`browser-without-pq-authentication`).
- **Ordinary browsers** cannot pin keys, cannot choose routes and cannot run pq-session. Over an overlay they work
  only with a valid WebPKI certificate and a resolver that maps the name. When that is not possible the box serves
  apps to native clients only, and its pages say so in the visitor's language.
- **Firefox extension.** Later: `proxy.onRequest` routes a paired box's names through a local SOCKS proxy (Tor's, or
  an overlay helper) while the pin check stays exactly as in `browser-extension.md`. It cannot accept a certificate
  Firefox rejects, so an expired or self-signed certificate still fails; the extension narrows trust, never widens it.
- **The webapp** stays an internet product. It is not a client for exotic channels.

### 4.4 Sessions over slow and intermittent links

`pq-session/v1` (§13) has numbers chosen for the internet: hello/accept fresh within 5 minutes, a pending handshake
lives 60 s, a session idles out at 15 minutes and lives at most 12 hours, a replay window of 1024, records up to
16 MiB. Over Tor and GEO satellite they are fine. For narrowband and delay-tolerant links:

- **A latency profile per adapter class**, signed into the hello (`latencyClass`) so the box applies a matching rule
  and an attacker cannot ask for a looser one on a fast link: Narrowband allows a 30-minute pending handshake and
  freshness against the box's trusted clock with a 30-minute skew; DelayTolerant does not run interactive sessions
  at all (envelopes only).
- **Handshake size.** One pq-session handshake is about 10 KB (X-Wing public key 1,216 B, ciphertext 1,120 B, two
  ML-DSA-65 + Ed25519 signatures ~3.4 KB each, plus fields). Over Reticulum on LoRa (~1-5 kbit/s) that is tens of
  seconds to minutes: usable for owner control. Over Meshtastic (≈237-byte payloads, a 1 % duty cycle in the EU) it is
  about 45 packets and, with the duty cycle, over an hour: not usable.
- **Channel keys for tiny links.** Over a good link (LAN, relay, overlay), the phone and box run a pq-session and
  derive a narrowband channel key from it (`X("narrowband-channel", th4)`, a new label), stored on both with a
  counter. Messages on Meshtastic-class links are then AES-256-GCM records with a hash ratchet per message (forward
  secrecy per step, about 40 bytes of overhead), authenticated by the channel key, so a 200-byte status or order fits
  one packet and stays quantum-safe (symmetric). The channel key is scoped to `messages` (it can carry only the order
  types listed in the consent), expires with the consent, and is re-derived over a good link. Sensitive orders still
  need the admin root's hybrid signature, so they are multi-packet and slow by design.
- **Resumption.** TLS 1.3 session resumption is fine; 0-RTT stays off on every adapter (a replayed early-data
  request over a store-and-forward carrier is easy). pq-session gets a resumption ticket later if measurements on
  Tor show the full handshake hurting; not in the first phases.
- **Replay.** Streams: TLS and pq-session sequence numbers (already). Envelopes: each carries a sender, a
  monotonic counter per sender and a single-use nonce kept by the box (the `app-env-used-nonces.json` pattern), and an
  explicit `expiresAt` the signer chose (hours to weeks for delay-tolerant links). The box refuses anything past
  `expiresAt`, any counter at or below the newest it saw, and any nonce it has.
- **Ordering and idempotence.** Messages may arrive late, twice or out of order. Every message-adapter order must be
  idempotent or carry the state it expects (`ifRevision`), and the box answers with a signed receipt the phone keeps.
  Orders that cannot be made safe this way (account changes, recovery, transfer) are not accepted over message
  adapters.
- **Time.** A box without `.com` cannot refresh signed time (§17); it runs on its floor plus the monotonic clock. An
  owner-signed order may carry the signer's time as a hint that can only *raise* the floor and only by a bounded step
  per order (so a compromised device cannot push the clock years ahead to expire everything at once). Freshness for
  message adapters uses `expiresAt` rather than a 5-minute window.
- **Revocation lag.** A box reachable only over adapters learns of a removed device, a rotated admin root or a
  revoked share only when that news reaches it. The owner's devices carry the signed device-book and rotation records
  over any adapter (they are already self-verifying). The consent screen states the lag plainly.

### 4.5 Boot unlock over adapters

Unlock v2 messages are already hybrid-signed and hybrid-sealed and do not care what carries them (§19). Today they
travel through `boot.flagshipserver.com`. Carrying them over an adapter needs the adapter in the initramfs: feasible
for a WireGuard or Yggdrasil interface (small kernel module or static binary), a serial or LoRa radio later, not for
Tor in the first phases (size and boot time). This is the "offline boot unlock" (D2) that `data-sovereignty.md` left
open, and it should be designed there, with the `unlock` consent scope from §5 gating it. Not in 0.4.

### 4.6 Message envelopes

```
envelope = { v:1, to: <serverDomain or opaque id>, from: <subject>, counter, nonce, expiresAt,
             body: hybrid-seal(box PQ key, signed order bytes) }       # or channel-key record (§4.4)
```

The signed order inside is the same canonical bytes the order already has over HTTPS (offline-control orders,
sensitive orders), so no second verifier exists. The answer is a box-signed receipt sealed to the sender's key.
`to` is the opaque discovery id (`rescueDiscoveryId`), not the server name, on any broadcast medium. Sneakernet uses
the same envelopes in a file.

### 4.7 What each channel leaks

| Channel | Who sees what |
|---|---|
| Relay (today) | Fly and we: box name (SNI), timing, sizes, the visitor's IP. |
| Direct / public IP | The ISP and the world: the box's address (public, and in passive DNS forever), the name, timing. |
| WireGuard / Nebula (owner-run) | The owner's own infrastructure; the underlying ISP sees encrypted UDP to the peer endpoints. |
| Tailscale / ZeroTier | The coordinator sees membership, node names, endpoints and when nodes are online; DERP relays see encrypted packets and timing. Headscale moves that to the owner. |
| Yggdrasil / cjdns | Peers and any node on the path see source and destination addresses (stable key hashes, so linkable across time and places) and sizes. The address is global on that network. |
| Community mesh | Mesh operators and neighbours see addresses and traffic volume; often physically near the owner. |
| Tor (Alt-Svc or onion) | Location-hiding for both sides; guards see the client's IP but not the destination. A long-lived onion address is a stable pseudonym; the box name inside Alt-Svc mode is visible to the box only. |
| Reticulum / LoRa / Meshtastic | Anyone in radio range sees that a transmitter is active, its timing, sizes and (Meshtastic) node id; direction finding can locate the box. Destination hashes are stable. |
| Bluetooth | People within metres; the device address (randomised on modern phones). |
| Satellite SBD | The provider sees every message's size and time and the modem's location. |
| Sneakernet | Whoever holds the medium sees an opaque file; its size and the fact of carrying it. |

The SNI is unencrypted in TLS today (no ECH on the box); over overlays it is visible to the overlay's path. Where that
matters (Yggdrasil, community meshes), ingress can accept connections without SNI on an adapter that serves only one
box name, and clients may omit it there.

## 5. The owner's responsibility: consent

### 5.1 The order

```
flagship/transport-consent/v1|<serverDomain>|<adapterId>|<adapterSha256>|<riskClass>|<scopes>|<bindings>
                             |<warningsSha256>|<locale>|<issuedAt>|<expiresAt>
```

- Signed with the sensitive-order key (admin root; IRK only on a box that pins none), hybrid under strict, after a
  biometric (the `authorizeSensitiveOrder` path). Load-bearing: the box's supervisor starts an adapter only with a
  consent that verifies, names this server, names the adapter's binary hash (first-party: the hash in the endorsed
  release; third-party: the owner's file) and is unexpired; ingress tags each stream with the adapter and refuses a
  request whose scope the consent does not list (for example, a public app request over an adapter consented for
  `owner-control` only).
- `scopes`: any of `owner-control`, `visitors` (per listed app, or all), `box-to-box`, `control-plane` (the box's own
  outbound calls to `.com`), `unlock`, `messages` (with the order types allowed).
- `bindings`: what the adapter may bind or use (interfaces, prefixes, a serial device, a radio's frequency plan and
  regulatory class).
- `warningsSha256`: SHA-256 of the exact warning text shown, in the language shown (`locale`). The box keeps the
  text with the consent and Activity shows it back. It proves which warning the owner accepted, the way strict's
  signed loss codes prove what the owner gave up.
- `expiresAt`: proposed 90 days (Q2). "off" is the same order with no scopes; it is the replay floor, as for direct
  access.

Turning an adapter on for visitors on an app with Members only is allowed; the box's access gate still applies.

### 5.2 Risk classes and what the screen says

| Class | Channels | Screen says (summary; real text through i18n) |
|---|---|---|
| `private-overlay` | WireGuard, Nebula, Headscale, owner-run ZeroTier | "Anyone you let into this network can reach this server's front door. Flagship still checks who they are. The network's operator can add machines to it." |
| `hosted-overlay` | Tailscale (hosted), ZeroTier Central | as above, plus "Tailscale/ZeroTier (a company) sees which of your devices are online and where." |
| `public-overlay` | Yggdrasil, cjdns, a community mesh | "This server becomes reachable by everyone on <network>, like being on the internet. Its address there is permanent and can be linked over time." |
| `anonymity` | Tor, I2P | "Visitors and this server hide their locations. The onion address is a lasting pseudonym. Tor's own encryption is not quantum-safe; Flagship's is. Some countries block or punish Tor use." |
| `radio` | Reticulum on LoRa, Meshtastic, packet radio on ISM bands | "Anyone nearby can see that this box transmits and can locate it. You are responsible for your radio's licence, power and duty cycle. Only messages and orders, no apps." Amateur bands: refused. |
| `custodial-link` | Satellite short-burst, any paid gateway | "The provider sees every message's time, size and location and may charge per message." |
| `offline-media` | Sneakernet | "Anyone holding the stick can read its size and copy it; they cannot open or change it." |

Common to all: "Flagship cannot help if this channel fails, is slow, or is blocked. Its traffic does not use your
relay quota. We cannot see it, measure it or switch it off for you." And, for any visitor scope: "If someone abuses an
app reachable this way, we cannot suspend the route; only you can."

### 5.3 Reminders

- At enable time: the screen above, then the biometric.
- Recurring: a quiet Activity entry and a server-page line 14 days before expiry ("<adapter> is on for this server;
  renew or turn it off"), renewal one tap + biometric (a new order with a fresh warning hash if the text changed).
  A push only if the owner allows that category; content-free like every push.
- On lapse: the box drops `visitors`, `box-to-box` and `control-plane` for that adapter, keeps `owner-control` and
  `messages` for 30 more days so the owner can renew over the same channel (an off-grid box must not lock its owner
  out), then stops it. Activity records each step.
- When something changes the risk: a new release changes the adapter's hash or its metadata profile, or a third-party
  adapter's file changes: the old consent no longer matches and the adapter stays off until the owner re-consents.

### 5.4 What Flagship still guarantees, and what it doesn't

**Still guaranteed on every channel:** content stays encrypted from the client to the box with Flagship's keys
(hybrid, quantum-safe where pq-session or hybrid-seal is used); the box verifies every owner order itself; app access
gating and ranks apply; visitor identity stays per app; no adapter can read data or impersonate the box or the owner;
an adapter's failure never stops the relay path.

**Not guaranteed:** availability, speed, delivery or ordering; hiding that the box exists, where it is or when it is
used (except what Tor/I2P give); WebPKI HTTPS for browsers; timely revocation when the box cannot hear the owner's
devices; abuse handling or takedown by us; legal compliance of the channel; push notifications; `.com` services
(free AI, new invites, issuance, backups to `.com`) unless the box also reaches `.com`.

**Recommendations shown, not enforced:** one onion per published app (no visible co-location of apps); Headscale over
hosted Tailscale for owners who care about the coordinator; restricted discovery (client authorisation) on onions
used only for owner control.

## 6. Phased plan

| Phase | Ships | Rough cost |
|---|---|---|
| **0.4a: host-ip** | `flagship-transport` crate (trait, classes), `transport-consent/v1` and `endpoints/v1` canonicals with vectors (TS, Rust, Swift, Kotlin), the supervisor and consent gate, host-ip binding owner-chosen interfaces with the LAN caps and nft rules, phones dialing overlay addresses (reusing LAN-direct's probe/fallback code), the consent screen (classes `private-overlay`, `hosted-overlay`, `public-overlay`), box to box over overlays, i18n strings, gym group with two VMs on a WireGuard link. | 3-5 weeks across box, two phones, protocol and gym. No `.com` change. |
| **0.4b, if time: key-bound TLS for apps on any route** | generalise the rescue hello (STK-signed certificate hash) to every native client route, so an expired or self-signed certificate on an adapter route does not end owner control. | 1-2 weeks; mostly reuse. |
| **0.5: Tor** | Arti linked into `flagship-ingress` (onion service, restricted discovery for owner-only onions), Alt-Svc mode for published apps, onion-only mode behind its own warning, Arti client in iOS/Android/Studio, the box's outbound to `.com` over Tor when its ISP blocks us. External review of the in-boundary code. | 5-8 weeks; binary size +15-25 MB; memory; an Arti hosting maturity check before shipping. |
| **0.5/0.6: messages** | envelopes, receipts, the narrowband channel key, the message endpoint; sneakernet first (no radio, easy to test), then Reticulum (an RNS daemon as a carrier adapter; a Rust RNS stack would avoid shipping Python on the box), then a Meshtastic/MeshCore companion radio through the phone. | 6-10 weeks; radio hardware for the gym; regulatory text per region. |
| **Later** | Unlock over adapters (initramfs WireGuard/Yggdrasil; ties to data-sovereignty D2), BLE ceremonies, I2P, the Firefox extension's proxy routing, a Flagship-owned overlay option (a phone VPN profile) if owners ask. | each a project |

Risks:

- **Exposure surprise.** Yggdrasil and community meshes make a box public on that network; owners may read
  "mesh" as "private". The class names and warnings carry that, and the gym must show the box answering nothing but
  ingress on an adapter interface.
- **Support load.** Exotic channels fail in exotic ways. "The owner's infrastructure, the owner's problem" (direct
  access) only works if the apps report adapter health clearly and never blame the relay path.
- **In-boundary code.** Arti inside ingress is large Rust code in the most sensitive process. It needs its own
  sandboxing thought (a separate in-boundary process with keyd-signed TLS like flagship-tlsd, rather than literally the
  same process) and review.
- **Legal.** Tor in some countries; radio rules everywhere; we must refuse amateur bands and not configure radios for
  the owner beyond declared plans.
- **Abuse.** We cannot take down an onion. Publishing an onion for a visitor app should go through the same abuse
  page language ("we can suspend Flagship names and relay routes; routes you run yourself we cannot").
- **Store review.** Apple and Google accept Tor clients (Onion Browser, Orbot exist), but an app embedding Tor and a
  radio bridge will get questions; keep both off by default and behind the consent.
- **PQ claims.** Onion-only browser mode and carrier encryption are classical. The UI must never call such a route
  quantum-safe; the custody/assurance labels from strict apply per route.

## 7. Tests (when built)

Forged, expired or other-server consents refused; an adapter binary with another hash refused; scope enforcement
(owner-only adapter refuses a visitor request); an adapter that sends garbage, floods, or replays frames treated like
a hostile relay (reuse the relay conformance suite over the socket); no listener but ingress on an adapter interface
(nmap from the overlay in the gym); a rogue node at the overlay address fails the probe and the client falls back;
endpoint record bound to the consents it names and void on certificate rotation; lapse sequence (visitors off, owner
control kept, then off); envelopes: replay, counter regress, expired, wrong recipient, reordered delivery; the
narrowband channel key cannot carry a sensitive order; strict servers refuse adapter streams without pq-session;
nothing about adapters reaches `.com` or a model prompt (redactor test).

## 8. Open items this doc does not settle

- Exact latency-profile numbers per class (need measurements over Tor, GEO and a LoRa RNode).
- Whether a third-party carrier adapter needs any signature beyond the owner's hash pin (for example a community
  maintainers' endorsement), or whether the owner's consent is enough.
- How endpoint records reach a *second* owner device that pairs while the box is reachable only over an adapter
  (pairing today goes through `/qr-pipe` on `.com`).

## 9. Questions for the owner

1. **Scope of 0.4.** Ship host-ip (overlays and community meshes the host already has) in 0.4 and leave Tor and radio
   for later, as proposed? Or is Tor the priority (censorship, T3/T4)?
2. **Consent lifetime.** 90 days with a 14-day reminder and a 30-day owner-control grace after lapse? Longer for
   off-grid boxes?
3. **`.com` knowledge.** Keep `.com` fully unaware of adapters (proposed), or let the owner choose to tell `.com`
   "this server also has other routes" so the apps can show it on a fresh device?
4. **Third-party adapters.** Allow owner-supplied carrier adapters at all in the first phases, or first-party only
   until the socket protocol has been reviewed?
5. **Dead-man on adapters.** Should the owner's serving dead-man (`serving-wiring.md`) also stop visitors on adapter
   routes (the box enforces it on itself), or is it, like direct names, outside it?
6. **Onion-only browser mode.** Offer it at all (classical, plain HTTP inside the onion, ends in ingress), or only
   Alt-Svc mode, which keeps WebPKI TLS to the box?
7. **The phone's VPN slot.** Should the Flagship app ever bring its own overlay (taking the phone's single VPN slot),
   or always rely on the owner's existing overlay app?
8. **Radio.** Is LoRa (Reticulum/Meshtastic) a product goal (emergency/off-grid owner control) or a research item?
   It sets whether we buy radios for the gym and write per-region regulatory text.

## Sources (checked 2026-11-14)

- Arti 2.5.0 / 2.5.1 release notes: https://blog.torproject.org/arti_2_5_0_released/ ,
  https://blog.torproject.org/arti_2_5_1_released/ ; restricted discovery stable since Arti 1.7.0:
  https://forum.torproject.org/t/arti-1-7-0-released-onion-service-restricted-discovery-experimental-http-proxy-relay-development-and-more/20746
- TLS for onion services (DigiCert EV, HARICA DV, no ACME):
  https://community.torproject.org/onion-services/advanced/https/ , https://www.harica.gr/en/posts/post-3209 ,
  https://acmeforonions.org
- Reticulum MTU 500 bytes, 5 bit/s minimum, LXMF: https://reticulum.network/manual/whatis.html ,
  https://github.com/markqvist/Reticulum
- Yggdrasil addressing (`200::/7`, key-derived): https://github.com/yggdrasil-network/yggdrasil-network.github.io/blob/67c46d5b6a8324c60cdc5c043e7a08b98d6a2276/whitepaper.md
- Let's Encrypt lifetimes (45 days by February 2028), 6-day and IP certificates GA:
  https://letsencrypt.org/docs/cert-lifetimes/ , https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
- Meshtastic `DATA_PAYLOAD_LEN` 237: https://js.meshtastic.org/enums/Protobuf.Mesh.Constants.html ; EU 868 duty cycle:
  https://www.thethingsnetwork.org/docs/lorawan/regional-parameters/eu868/
- US 900 MHz ISM discussion: https://hackaday.com/2026/09/17/fcc-ism-rules-may-shatter-lora-mesh-communities/
- Amateur encryption rule §97.113(a)(4) and the FCC's authentication note:
  https://www.arrl.org/news/fcc-dismisses-encryption-petition , https://docs.fcc.gov/public/attachments/DA-13-1918A1_Rcd.pdf
