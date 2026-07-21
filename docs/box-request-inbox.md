# Box Request Inbox — one always-on channel for "a box is asking its owner"

Status: **SPEC (pre-build)**. Owner-directed 2026-06-22.

## Why

Today a box that needs an owner approval (unlock a disk, authorize itself to
serve) is surfaced through a sprawl of one-off mechanisms:

- Two hand-computed booleans on `/pods` — `awaitingUnlock` **and**
  `awaitingEntitlement` — each needing its own watcher, affordance, and copy
  on every client.
- A unlock-only `BootApprovalWatcher` (iOS) with **no equivalent for
  entitlement** (mobile has 0 references to `awaitingEntitlement` vs 83 to
  `awaitingUnlock`). So an entitlement-stuck box is invisible: it re-asks
  forever (daemon `process.exit(1)` → systemd restart → re-post), but nothing
  in the app turns that ask into a notification or a tappable card. The box is
  loud on the wire and silent to the human.
- Detection relies on pull-to-refresh; the authenticated request fetch is
  biometric, so it can't poll.
- Adding a third request type later means touching two booleans × three
  clients × watchers/copy/UI again.

The on-the-wire primitive is **already generic over type**. The box signs

```
flagship/secret-request/v1 | serverDomain | stkPubHex | purpose | nonceHex | issuedAt
```

and the reply is sealed bound to `(nonce, purpose)`. `purpose` *is* the type.
`unlock-key` and `entitlement` are already two values of one envelope. The
sprawl is entirely in the **client architecture and a backend projection**, not
the protocol.

## The model

**One inbox, one channel, one type registry**, riding the existing generic
secret-request/response protocol.

```
BoxRequest          a typed thing a box is asking its owner to approve
BoxRequestChannel   transport: "give me the pending requests for my boxes"
BoxRequestInbox     app-scope observable list; the UI reads only from this
BoxRequestRegistry  type → { title, detail, respond } — the per-type spec
```

A `BoxRequest`:

```
id           requestNonceHex (the response is keyed by (serverDomain, nonce))
serverDomain which box
type         === secret-request `purpose` ("unlock-key" | "entitlement" | …future)
issuedAt
expiresAt
```

The generic flow for **any** type:

1. **Detect** (cheap, unauthenticated, pollable) — the channel reads a digest
   of pending requests across the owner's boxes. No biometric.
2. **Render** — the inbox shows a card; title/detail come from the registry
   entry for `type`. Generic shell, type-specific strings.
3. **Satisfy** (authenticated, on tap) — fetch the full signed request, verify
   its signature against the **directory-resolved STK** (`.com` is not the
   trust anchor), run `registry[type].respond(verified)`, post the reply. One
   biometric, at the moment of action — never for detection.

New type later (transfer-confirm, content-wipe ack, service-cert mint, dead-man
challenge) = one registry entry per platform + one `purpose` string. No new
plumbing, no new boolean, no new watcher.

## Primary vs fallback (how this sits with deposits)

Two layers, cleanly separated:

- **Primary (proactive, no UI):** on a first-boot **unlock approval** the phone
  also deposits an owner-IRK `RootEntitlement` for the box's STK (consent to
  boot ⇒ consent to serve). The box claims it on boot and comes online with a
  single approval; the inbox stays empty. This covers every **encrypted** box
  (auto- or approve-unlock — the first boot always needs one approval, before
  any auto-lease exists).
- **Fallback (reactive, the inbox):** if no deposit is present — an
  **unencrypted** box (no unlock step at all), or a deposit that failed — the
  box posts a typed `BoxRequest`. The always-on inbox surfaces it as a one-tap
  card. **The "silent box" becomes structurally impossible.**

`unlock-key` is *only ever* the fallback layer (you cannot pre-deposit a key the
box must request live), so it is the same inbox, same registry — which is the
whole point.

**There is no create-time entitlement deposit.** The entitlement binds the
box's `podPubKey` (= its STK), which is generated at first-boot `gen-identity`
and is unknown at create time. The earliest the phone can mint it is when it
learns the STK — from the unlock request (the deposit-on-unlock path) or from
the directory once the box has registered (the inbox responder, which resolves
the STK from `/pods`). So: deposit-on-unlock is the optimization; the inbox is
universal.

## Transport: foreground poll now, abstracted for push/socket later

`BoxRequestChannel` is an interface. The only shipping implementation is a
**foreground sync loop**:

- every ~5s while the app is active; immediate first tick; silent re-ticks;
  per-tick error-swallow keeping the last-good list (the idiom already used by
  the companion-requests poll and the `awaitingUnlock` watcher).
- hits the **cheap unauthenticated digest** (extends `/pods`; see below). Same
  metadata exposure class as `/pods` today.
- drives the **pods list refresh too**, so this one loop replaces
  pull-to-refresh as the *detection* mechanism everywhere (manual refresh stays
  as a courtesy).

Behind the same interface, later and without touching feature code:

- an SSE/WebSocket implementation via a per-user Durable Object (instant
  delivery) — deferred; foreground polling already removes drag-to-refresh and
  it is the only piece that adds real infra.
- **push (APNs/FCM)** for the backgrounded/closed app — the genuinely additive
  win, blocked on TestFlight/Play regardless. The IRK is biometric, so push
  only brings the owner in to tap; it never auto-responds.

All implementations feed the **same** `BoxRequestInbox`.

## Backend contract

### Detect (cheap, unauthenticated) — extend `/api/users/:u/pods`

Per pod, add:

```ts
pendingRequests: Array<{
  id: string;        // requestNonceHex
  type: string;      // secret-request purpose: "unlock-key" | "entitlement" | …
  issuedAt: number;  // requestIssuedAt
  expiresAt: number;
}>
```

Computed from the *same* `secretMailbox.listPendingForUser` scan that exists
today (it already returns only un-consumed/un-expired/un-answered request lanes
— deposit lanes never surface). The client inbox is the `flatMap` of
`pendingRequests` across the owner's pods.

**Compat:** keep `awaitingUnlock` / `awaitingEntitlement` for one release,
**derived** from `pendingRequests` (`some(r => r.type === …)`), so the deployed
webapp and not-yet-rebuilt apps keep working. Clients migrate to read
`pendingRequests`; the booleans are removed once all surfaces are cut over.

### Satisfy (authenticated) — unchanged

The IRK-signed `POST /api/secret-requests` (full signed request + `deviceInfo`)
and the reply endpoints stay exactly as they are — already generic over
`purpose`:

- `unlock-key` reply → boot worker (`/api/boot/response`, owner/delegate
  `Flagship-Boot-v1` gate; the initramfs polls there pre-OS).
- `entitlement` reply → secret mailbox response lane.

The registry's responder encapsulates *which* endpoint a type posts to, so the
inbox never branches on type.

## Client contract (identical on iOS / Android / webapp)

```
BoxRequestChannel
  poll(): BoxRequest[]              // digest across the owner's boxes
  start() / stop()                 // foreground lifecycle

BoxRequestInbox                    // app-scope observable (mirrors ToastCenter /
  requests: [BoxRequest]           //   ActiveOperationsCenter already on all 3)
  refresh()                        // ← channel pushes here
  satisfy(request)                 // tier-2 fetch+verify → registry.respond → post

BoxRequestRegistry: type → {
  title(req): string               // e.g. "Unlock device and authorize it to join your cloud"
  detail(req): string              // what approving does
  respond(verified, deps): void    // crypto + post to the type's transport
}
```

`respond` for the two launch types is the **existing crypto, relocated**:

- `unlock-key` → `confirmAndRespond`'s current unlock body: seal the LUKS key
  for the box STK bound to `(nonce, purpose)`, post to the boot worker, **then
  deposit the entitlement** (the primary-layer optimization stays here), and
  the auto-lease when in auto mode.
- `entitlement` → the current `.entitlement` branch: mint the owner-IRK
  `RootEntitlement` for the box STK, post to the mailbox.

So `confirmAndRespond` becomes a thin dispatcher: `registry[purpose].respond(…)`.
The inbox's `satisfy` calls the same path. The webapp's `bootApproval.js`
already does fetch→verify→respond for `unlock-key`; it gains the `entitlement`
responder and the generic shell.

### What each surface DELETES (the simplification payoff)

- `BootApprovalWatcher` (iOS) + the unlock-only server-card watcher → replaced
  by `BoxRequestChannel` + `BoxRequestInbox`.
- Direct consumers of the two booleans → read `pendingRequests` via the inbox.
- pull-to-refresh-as-detection → the foreground loop.
- The entitlement gap closes for free: entitlement stops being a special case
  and becomes registry entry #2.

### Surfaces

- **Inbox view** — the canonical list of "things your boxes are asking you to
  approve" (generalizes the iOS approvals screen / webapp boot-approval view).
- **Contextual cards** (optional) — Home / server-detail can show a card that
  simply reads the inbox filtered to that pod (so an approval is one tap from
  where the box is shown). It is *not* a second mechanism — same inbox.

## Migration & rollout

1. Backend: add `pendingRequests`, keep booleans derived. Deploy. (Safe:
   additive; old clients ignore the new field, new clients ignore the old
   booleans.)
2. Clients per surface: add channel + inbox + registry; cut the inbox view and
   contextual cards over to `pendingRequests`; delete the per-type watchers.
3. Once all three surfaces read `pendingRequests`, drop the two booleans from
   `/pods` (a later, separate change).

## Tests

- **Backend:** `pendingRequests` is populated per pod from the mailbox scan;
  `awaitingUnlock`/`awaitingEntitlement` still derive identically (regression);
  deposit lanes never appear; an unowned/expired/answered row never appears.
- **Clients (each surface):** the channel maps a `/pods` digest to
  `BoxRequest[]`; the inbox de-dups + clears a satisfied request; the registry
  routes `unlock-key` vs `entitlement` to the right responder; the unlock
  responder still deposits the entitlement (regression on the one-approval
  path). Crypto round-trips stay pinned by the existing
  `confirmAndRespond` / `bootApproval` tests.

## Parity checklist

| | iOS | Android | webapp |
|---|---|---|---|
| `BoxRequestChannel` (foreground poll) | ☐ | ☐ | ☐ |
| `BoxRequestInbox` (observable) | ☐ | ☐ | ☐ |
| `BoxRequestRegistry` (unlock + entitlement) | ☐ | ☐ | ☐ |
| Inbox view reads the inbox | ☐ | ☐ | ☐ |
| Contextual card reads the inbox | ☐ | ☐ | ☐ |
| `confirmAndRespond` → dispatcher | ☐ | ☐ | ☐ |
| Delete `BootApprovalWatcher` / booleans consumers | ☐ | ☐ | ☐ |
