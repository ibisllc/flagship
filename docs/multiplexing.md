# URL multiplexing — final design

> **The shape.** Pods declare what they serve. The .services tunnel hub
> uses that declaration as the only source of truth. Apps own their own
> consistency model. The harness is plumbing.

This doc replaces the v1 alias system that briefly shipped in commit
`3fe6854`. v1 used a D1 table at `.com` to mirror per-user URL claims
and per-alias SAN expansion on the daemon. v2 (this doc) collapses both
into the tunnel HELLO frame and a per-pod user-zone wildcard cert. There
is no D1 mirror.

## URL forms

| Tier | Form | Always reachable? |
|---|---|---|
| Canonical, self-authored | `<slug>.<server>.<user>.flagship.services` | Yes — pod-zone wildcard cert + base controlledDomains. |
| Canonical, cross-creator | `<slug>-<creator>.<server>.<user>.flagship.services` | Yes — same. |
| User-zone alias | `<slug>.<user>.flagship.services` | Only when an app explicitly claims it (or via a phone-driven `claim-url` order). |
| Custom domain | `<host>` | Same — explicit claim. |

## Runtime architecture

```
                phone
                  │
         ┌────────┼────────┐
         │ install │ orders │  (PSK-signed; verify-on-daemon)
         ▼        ▼        ▼
    ┌────────────────────────┐
    │      pod (daemon)      │  one wildcard cert per pod, SANs:
    │                        │   <user>.flagship.services
    │   urlController        │   *.<user>.flagship.services
    │   capabilityStore      │   *.<server>.<user>.flagship.services
    │   tunnel client ──┐    │
    │                   │    │
    └───────────────────┼────┘
                        │ WS
                ┌───────▼────────┐
                │  .services hub │   in-memory only:
                │  TunnelRegistry│   FQDN → tunnel
                │                │   last-HELLO-wins
                └───────┬────────┘
                        │ TCP passthrough
                        ▼
                  visitor browser
```

### Tunnel HELLO carries `controlledDomains`

Every pod's HELLO frame includes `controlledDomains: string[]` — the
explicit list of FQDNs the pod claims to serve right now. The hub's
TunnelRegistry maps each FQDN → tunnel and matches incoming SNI against
that map (exact, then one-label wildcard).

The hub enforces two invariants on every HELLO:

1. **Per-pod identity**: every claimed FQDN's middle label must equal
   the pod's username (extracted from `<server>.<user>.flagship.services`
   in `serverId`). A compromised STK can only ever claim FQDNs under
   its own user's zone.
2. **Last-HELLO-wins**: when a new HELLO claims an FQDN held by a
   different tunnel, the new tunnel wins atomically. The loser's
   `controlledDomains` shrinks; its SNI route is dropped. (The loser's
   WS stays open — sibling coordination is between pods, not at the
   hub.)

A subsequent HELLO on the same WS is a route-table update — `issuedAt`
must strictly advance per WS as replay defense, and the pod's
controlledDomains list is replaced atomically. When a HELLO leaves the
list empty, the hub schedules a clean close after `idleCloseMs`
(default 60s); a non-empty update cancels the timer.

### One wildcard cert per pod (user-zone level)

Issued via DNS-01 against the .com Worker. SAN list:

```
<user>.flagship.services
*.<user>.flagship.services
*.<server>.<user>.flagship.services
```

`*.<user>.flagship.services` covers single-label-deep names —
`<server>.<user>.flagship.services` AND any `<app>.<user>.flagship.services`
alias. `*.<server>.<user>.flagship.services` covers the canonical app
URLs `<app>.<server>.<user>.flagship.services`.

### One wildcard CNAME per user

The .com Worker writes A/AAAA records on every server registration:

- `<server>.<user>.flagship.services` → .services anycast IP
- `*.<server>.<user>.flagship.services` → .services anycast IP
- `<user>.flagship.services` → .services anycast IP
- `*.<user>.flagship.services` → .services anycast IP

Idempotent on re-register.

### Sibling coordination

Sibling-WS at `/.flagship/sibling-handshake` between pods. Mutual STK
auth on connect, then pods coordinate URL takeovers + relay opaque
app-payload frames.

Frame catalogue:

| Byte | Frame | Direction |
|---|---|---|
| `0x01` | `sibling-hello` | both — challenge + signed response |
| `0x02` | `sibling-takeover-request` | initiator → incumbent (carries cap) |
| `0x03` | `sibling-sync-frame` | incumbent → initiator (opaque) |
| `0x04` | `sibling-takeover-ack` | incumbent → initiator (ok/reason) |
| `0x05` | `sibling-sync-complete` | end of takeover |
| `0x06` | `sibling-app-message` | bidirectional — apps' messages |

When a pod receives a `claim-url` order for an FQDN currently held by a
sibling: open HTTPS to the FQDN → sibling answers → upgrade to
`/.flagship/sibling-handshake` → mutual auth → takeover handshake. The
old sibling drops the FQDN from its next HELLO; the new pod adds it.

If no sibling answers (the FQDN was unclaimed): the pod just adds the
FQDN to its HELLO update and `.services` accepts the claim.

### Disambiguation fallback

When a visitor's SNI hits .services for a FQDN that:

- ends in `<user>.flagship.services` (a real user zone), and
- is not currently claimed by any tunnel,

…the SNI matches the `*.<user>` wildcard claim of whichever pod
currently holds it (last-HELLO-wins). That pod's daemon serves a small
disambiguation HTML page: "no app here right now."

Static fallback at `https://flagshipserver.com/disambiguate.html` exists
for the .services edge fallback path.

## Capabilities — security-load-bearing

Every URL claim must present a `ClaimUrlCapability` matching all three
of:

- **`appId`** — the app behind the calling FLAGSHIP_APP_TOKEN.
- **`siblingId`** — this specific pod's serverId.
- **`fqdn`** — the URL being claimed.

Capabilities are phone-issued, IRK-signed:

```ts
interface ClaimUrlCapability {
  username: string;
  appId: string;
  siblingId: ServerId;
  fqdn: string;
  issuedAt: number;
  expiresAt: number;  // default 90 days
}
```

Stored on the daemon (the cap's CapabilityStore is in-memory + on-disk
in production). `/api/url/claim` and `/api/url/release` both run
`checkCapability` — every component must match the calling instance.
Rejections are uniform 403 (no leaking which check failed).

Revocation: phone POSTs a signed list to `.com`; the daemon polls (60s
TTL) and refuses any cap whose id appears in the cached list. Replays
of older lists are rejected via monotonic `issuedAt`.

## App-facing API surface

All FLAGSHIP_APP_TOKEN gated.

```
GET  /api/sibling/list     [{siblingId, fqdns:[...], online, lastSeenMs}, ...]
POST /api/sibling/send     {toSiblingId, payloadHex}
GET  /api/sibling/poll     long-poll for inbound app-messages
                           (real WS endpoint at /api/sibling/subscribe
                           lands in N0e-2)

GET  /api/url              [{fqdn, kind, ownedBy, canClaim, capabilityExpiresAt}, ...]
POST /api/url/claim        {fqdn} — checks capability, claims via HELLO update
POST /api/url/release      {fqdn} — releases via HELLO update
GET  /api/url/owned        [{fqdn}, ...]
```

`kind`: `"canonical" | "alias" | "custom"`.
`ownedBy`: `"self" | "<siblingId>" | null`.

## Phone UX (per app)

```
This app: notes

Where should it run?
  ☑ home box
  ☑ office box
  ☐ garage box
  ☐ run on all current and future boxes

Let instances talk to each other?
  ● Yes  ○ No

[ Save ]
```

That is the whole UI. No "failover," no "leader," no "primary," no
"consistency mode." Past these two checkboxes, everything is between
the user and their app code.

## Vibe-code LLM workflow

- "home only" → LLM writes single-instance code. Standard CRUD.
- "home + office" + "let instances talk" → LLM gets the replication-
  patterns chapter (sibling + URL APIs, 2-3 worked patterns,
  consistency tradeoff guidance). LLM writes app-specific replication
  code.
- "multi-pod" + NOT "let them talk" → LLM writes per-pod independent
  state.
- Toggling "let them talk" later → phone offers to **regenerate** the
  app with sibling-aware code. The vibe-code session re-opens with
  existing files preloaded plus the system-prompt chapter. Not a
  runtime config change; the AI rewrites the app, asks the user about
  consistency tradeoffs if it matters for this domain, redeploys.

## What the harness explicitly does NOT do

- ❌ Postgres / MinIO / Redis replication (no streaming, no diff sync).
- ❌ Leader election (the URL holder is the leader by definition).
- ❌ Heartbeat-based auto-failover (apps decide via sibling-WS).
- ❌ Schema-migration coordination during replication (no replication).
- ❌ Auto-claiming the alias URL on multi-pod installs.
- ❌ Saying "primary" / "leader" / "failover" in any phone surface.
- ❌ Mirroring the URL-ownership state at .com.

Apps own consistency. The harness owns distribution fabric.

## Code map

| Layer | Source |
|---|---|
| Tunnel hub (FQDN → tunnel, last-HELLO-wins) | `apps/web/src/tunnel/{tunnelHub,registry}.ts` |
| Tunnel client (HELLO update, idle close) | `packages/server-daemon/src/tunnel/tunnelClient.ts` |
| HELLO frame protocol | `packages/protocol/src/auth.ts` (TunnelHello) |
| URL controller (per-pod claim state) | `packages/server-daemon/src/runtime.ts` |
| Capability store + checkCapability | `packages/server-daemon/src/capabilityStore.ts` |
| Sibling-WS protocol + handshake | `packages/server-daemon/src/sibling/{frames,handshake}.ts` |
| App-facing /api/sibling/* | `packages/server-daemon/src/sibling/httpHandlers.ts` |
| App-facing /api/url/* | `packages/server-daemon/src/sibling/urlHttpHandlers.ts` |
| Disambiguation fallback | `packages/server-daemon/src/runtime.ts` (`disambiguationResponse`) |

## Open follow-ups

- **N0d-2** Install-policy storage + push fan-out on new server.
- **N0e-2** Sibling-WS endpoint at `/.flagship/sibling-handshake` and
  the outbound client used during /api/url/claim takeovers.
- LE high-volume issuer allowlist before public launch.
