# Networking vision: IPv6-native, any transport that connects

Status: owner vision (2026-11-16). Design for the release manager and agents; nothing here is built yet except
where it says so.

## The owner's words

"The vision is that our system should be natively IPv6 end to end (as well as support IPv4 and all forms of
networking, including Freenet, and any other technologies, as long as they can offer connection)."

## Principles

1. **IPv6 first, everywhere.** Every component speaks IPv6 natively and prefers it: boxes, relays, `.com`'s checks,
   the phones, the Studios, the installers, the gym. IPv4 is supported, never assumed. No code path may require an
   IPv4 address to work (today several do; see "Where we assume IPv4").
2. **Transport-agnostic.** Flagship's security never comes from the network: TLS ends on the box, every order is
   signed, every message sealed. So any channel that can carry bytes between two parties is acceptable: the
   relay mesh, a direct IPv6 path, the LAN (LAN-direct already exists), and overlay or alternative networks.
   Adding a transport must not weaken a guarantee; it only adds a way to reach.
3. **Honest about what each transport hides.** Owner rule against security cosplay: we list what each transport
   does and doesn't protect (metadata, location) and never claim more.
4. **No transport is a single point of failure.** A box or phone keeps working over whatever path still connects.

## Where we assume IPv4 today (found 2026-11-16)

- UpCloud boxes (demo cloud and gym) are created with IPv4 interfaces only (`apps/com/src/upcloud.ts`,
  `tools/live-e2e/lib/upcloudVm.ts`, `isoBox.ts`).
- `.com`'s zone-health, legacy DNS sweep and admin route-gc need `SERVICES_PASSTHROUGH_IPV4`.
- The gym's DNS (`*.gym`, `tunnel.gym`) has A records only on the IPv4 path the boxes use.
- The relay keeps one dedicated IPv4 so IPv4-only networks can reach it (keep this: it is support, not an assumption).
- To audit fully: the box daemon's tunnel dial, LAN-direct hints, the phones' relay-address fallback (`docs/relay-addresses.md`),
  Studio's VM NAT, installers' network setup.

## Transports worth supporting (survey, 2026-11-16)

| Transport | What it is | Fit for Flagship | Notes |
|---|---|---|---|
| Native IPv6 | Direct global addresses | Best path when both ends have it; no relay needed for reachability | Owner's earlier idea: our own ASN and IPv6 space so every box gets a reachable address |
| IPv4 + relay | Today's default | Keep as the fallback | One IPv4 on the relay |
| LAN-direct | Box on the local network | Built (`docs/lan-direct.md`) | |
| Freenet (the new, Rust one, 2023+) | Peer-to-peer platform: WebAssembly "contracts" for shared state, local "delegates" for private data, UDP transport with NAT traversal | Candidate for voi.ci pages and mailboxes without `.com` (a contract per page/mailbox), and box-to-box sync | Not anonymous by design. Different project from Hyphanet (the original Freenet, renamed 2023, Java, anonymous storage) |
| Hyphanet (original Freenet) | Anonymous, censorship-resistant data store | Possible for publishing in hostile networks; high latency, not for calls | |
| Tor onion services | Reach a box with no public address, hide the box's location | Reachability transport (not for hiding from Flagship, which already knows the endpoints) | High latency; fine for admin and messages, poor for calls |
| I2P, Yggdrasil, cjdns | Overlay networks (Yggdrasil/cjdns give every node an IPv6 address) | Yggdrasil fits "IPv6-native" directly | |
| Bluetooth, Wi-Fi Direct, NFC | Short range | Pairing (NFC retail exists), offline control near the box | |
| Satellite, mesh radio (LoRa) | Low bandwidth | Unlock requests and alerts only | |

## Shape of the work

1. **A transport layer.** One interface on the box, phones and Studios ("reach this peer; here are the paths I know;
   pick the best working one"), with today's relay, IPv6-direct and LAN-direct as its first three providers.
   Every provider carries the same end-to-end TLS or sealed frames.
2. **IPv6-native pass (0.4 if the owner confirms):** remove every IPv4 assumption listed above, give UpCloud boxes
   IPv6, make `.com`'s checks work with IPv6 only, prefer IPv6 in the phones, run the gym IPv6-first, and test an
   IPv6-only network end to end.
3. **Overlay transports (after 0.4, one at a time):** Yggdrasil first (cheapest: it is IPv6), then Tor onion
   reachability, then a Freenet prototype for voi.ci pages and mailboxes. Each needs a design note covering what
   it hides, latency, and the store rules (iOS limits background networking and bundled daemons).
4. **Own IPv6 space:** cost out an ASN, a registry membership and an upstream that announces it (open since
   2026-10-20 in `AGENTS.md`, "Make Fly redundant").

## Sources

- Freenet components: https://docs.freenet.org/components/overview.html
- Freenet whitepaper: https://freenet.org/pdf/freenet-whitepaper.pdf
- Freenet renamed to Hyphanet: https://www.hyphanet.org/freenet-renamed-to-hyphanet.html

## The overlay (owner, 2026-11-16: agreed; starts in 0.5, not 0.4)

Flagship becomes an IPv6 overlay network with the public relay as a core part, not a fallback. Shaped by an outside
proposal (Tailscale-like overlay) and adjusted for Flagship:

1. **Addresses from keys, not from a registry.** One fixed Flagship ULA /48 (RFC 4193, inside fd00::/8); a server's
   (and a device's) overlay address is derived from its public key, as in Yggdrasil and cjdns. An address proves its
   owner; nobody allocates them; `.com` only helps peers find each other's current endpoints (discovery, never
   ownership). No ARIN space or ASN needed for the overlay; an ASN stays a later option for anycast relays.
2. **Privacy decides the path.** A direct (peer-to-peer, hole-punched or native IPv6) connection shows each side the
   other's IP address. Direct is the default only between parties that already trust each other: the account's own
   devices and servers, co-managers, invited members. Strangers (anonymous callers, voi.ci visitors, anyone not
   approved) are relayed by default; direct for them is an explicit owner opt-in with the warning that they see the
   network address. Calls follow the same rule.
3. **Security stays where it is.** TLS still ends on the box (or the phone); the overlay transport adds no trust. If
   a WireGuard-style transport is used, it gets a quantum-safe key exchange (Rosenpass-style PSK or our X-Wing
   `pq-session`); nothing drops below what calls and server access already guarantee.
4. **One relay mesh.** The overlay's relays are the relay mesh (AGENTS.md "Make Fly redundant"): the same machines
   serve the public HTTPS/SNI gateway for people without the app (most voi.ci visitors and callers) and relay overlay
   traffic between peers that can't connect directly.
5. **Stages.**
   1. App-layer overlay (0.5): the apps' own traffic (app browser, calls, server access) reaches overlay addresses
      over QUIC/UDP with hole punching, relay fallback. No VPN permission.
   2. Desktop and boxes: a real network interface on the Studios and servers, so any program there can use overlay
      addresses.
   3. Phones: an optional VPN mode (iOS NEPacketTunnelProvider, Android VpnService) for people who want every app on
      the phone to reach Flagship addresses. Costs: iOS runs only one VPN at a time (conflicts with work VPNs), tight
      extension memory, Apple's VPN entitlement (fine for IBIS LLC).
6. **Public addresses stay opt-in.** A server's ISP IPv6 in public DNS reveals the home's address; it is published
   only through the direct-access consent (the `fshp.app` names, below).

### What 0.4 already ships toward this
- **Direct access with `fshp.app` names** (`docs/direct-access-and-domains.md`, all steps built and merged): an owner
  whose server has a public address opts in (address, reachability probe, privacy warning, biometric confirm), and
  each service gets its own `fshp.app` name that points straight at the box, with its own certificate, never through
  the relay. Not yet run on a real box: that live run is the 0.4 item.
- LAN-direct, the quantum-safe session (`pq-session`), and `.com` as the discovery point.
