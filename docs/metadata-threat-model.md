# What each party can see (metadata)

Flagship protects **content** from the vendor: TLS ends on the user's box, so `.services` and
`.com` cannot read what passes through. It does not hide **who talks to whom, when, and how much**.
This page says what each party learns, so the privacy promise is worded as narrowly as it is true.
(Written 2026-10-20 from the code and docs; items marked *not checked* were not run against a live
system.)

## `.com` (Worker + D1)

Holds identity and state. It sees:

- Account names, account and device public keys, push tokens, and which devices are admin devices.
- Each server's registration: its name (`home.alice.flagship.services`), public keys, the addresses
  its heartbeat arrives from (Cloudflare shows the connecting IP), last-seen times, running commit,
  health reports, and the orders posted for it (update, backup policy, migration, decommission).
- Per account: egress bytes and AI tokens (metering), the plan, the audit events a person's devices post.
- Rate-limit counters: counts per endpoint and axis, with no caller identity stored.
- The anonymous notice fetch and the relay-address fetch: it sees an app contacted it, from an IP.
- Outbound AI hosts and per-host totals across all boxes (`docs/outbound-hosts.md`): no account or box.

It can: withhold or delay orders, recommend relay addresses (the echo check drops a forwarder),
serve a stale directory, refuse service. It cannot read app data, impersonate a box (the phone pins
the box's STK-signed certificate), or sign as the admin (orders are signed on the phone).

## `.services` (Fly)

A pipe for connections to boxes (it is **not** a general proxy, and does not forward anything else
except the box-initiated AI calls below). Per connection it sees:

- The client IP, the TLS server name (which box), the time, and the bytes each way. Bytes are metered
  per account for quotas.
- Which boxes hold a tunnel open now (online/offline), and tunnel traffic volumes.
- Peer-backup mailboxes: mailbox ids, envelope sizes and timing (the envelopes are sealed). Off at GA.
- **Box-initiated AI calls:** the destination host and the bytes. The hub knows which tunnel asked
  for the length of the connection (budgets are per box, in memory); it logs only totals, and `.com`
  stores the host and totals with no box.

It cannot read TLS content, and it keeps no per-connection log (totals every 15 minutes, in memory
counters since start: `npm run ops -- services`). A **missed redirection** (a name nobody serves)
shows the name asked for in the router's recent-misses list.

## DNS, certificates and networks

- **Certificate Transparency is public.** Each box's Let's Encrypt certificate names the box
  (`home.alice.flagship.services`), so anyone can list account and box names from CT logs. *Not
  mitigated.* A wildcard certificate per account would hide box names but not the account name.
- Cloudflare (authoritative DNS) and each user's resolver see lookups for box names.
- The TLS server name is sent in clear (no ECH), so a network on the path sees which box a phone or
  browser contacts, and its IP.
- `*.flagship.services` is one DNS-only wildcard to the relay: the zone does not say which names are
  real boxes.

## Apple, Google, Cloudflare

Push services see the token and wake times (content-free pushes). The stores see installs and
versions. Cloudflare terminates `.com` TLS, so it sees `.com` request metadata and bodies that
`.com` itself sees.

## On the phone

- The app opens loopback listeners for LAN-direct and (iOS only) the relay-address shim. A listener
  on 127.0.0.1 is reachable by other apps on the phone unless iOS blocks it (*not checked*). The
  shim serves only names under the data apex on port 443, at most 32 clients, with head and idle
  deadlines, and stops when the app goes to the background; the content it carries is TLS to a box
  that another app cannot read or impersonate.
- The relay-address hint can cost a user a few seconds, never a wrong identity: the box's pinned
  certificate decides who answers. A failed hint reads as an unresolved name; the real reason is kept
  in the diagnostics log (`relay-route-unverified`, `relay-pin-mismatch`).

## What we do not claim

- That the vendor cannot tell *that* an account exists, *when* its boxes are online, or *roughly how
  much* traffic they carry.
- That a network cannot see which box a phone talks to.
- Owner-independent server lifecycle: if `.com` is down, running boxes keep serving, but setup,
  certificate issuance, pairing, recovery and routing changes need it.
