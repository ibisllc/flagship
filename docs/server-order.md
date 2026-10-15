# Server order (who leads, and who's next)

The owner ranks their servers on Home by dragging them. The first server in
the list that is up is the **leader**; when it goes down the role passes to the
next one that is up, and it moves back up when the higher server returns. This
replaces the single "preferred server" vote (`flagship/set-leader/v1`, its
`.com` lane and the box's set-leader consumer are gone).

What the leader is: for every app, the box that serves it is the highest server
in the order that runs it and is up (per-app leadership, unchanged otherwise);
new apps are created on the leader; the apps open the leader by default.

## The order

`flagship/server-order/v1` (`packages/protocol/src/serverOrder.ts`; vectors in
`packages/protocol/test-vectors/server-order/`,
`scripts/gen-server-order-vectors.mjs`):

```
flagship/server-order/v1|<user lowercased>|<stk1>,<stk2>,…|<issuedAt ms>|<nonce>
```

- `stks`: the servers' STK public keys (lowercase hex), first = leader, 1–64
  entries, no repeats. Order matters (never sorted).
- `nonce`: 32 random bytes, lowercase hex.
- Wire form: `{ order: {user, stks, issuedAt, nonce}, signature }` (signature
  lowercase hex).
- Signed by the **sensitive-order authority**, exactly like the old vote: the
  admin master root when one is pinned, else the account IRK.

Servers not in the list (created after the last reorder) rank after every
listed one, oldest first (birth certificate date), then by domain
(`rankByServerOrder`). A deleted or revoked server in the list is skipped.

## Is reordering an attack vector? Yes, a mild one, so it stays signed

The leader receives the traffic of every app it runs and gets every new app.
Someone who could reorder could pull apps onto the box they can reach. Boxes
already treat the old vote as a sensitive order, and a box can only check an
order signed by the account key, so the order is signed. On an account
without an admin root that costs no extra prompt when the app already holds
the account key in this unlocked session. The admin root is never kept
unlocked between actions, so on accounts that have one (every new account)
each reorder asks once (Face ID / Touch ID / fingerprint, with the device
passcode as fallback) with "Confirm the new server order".

## `.com`

- D1 `server_orders` (migration 0096): one row per account, the newest order.
- `POST /api/accounts/<u>/server-order` with the wire form. `.com` checks the
  shape, `order.user == <u>`, `issuedAt` within 5 minutes, every STK belongs to
  a non-revoked server of `<u>`, and the signature under the sensitive-order
  authority (`authorizeSensitiveComOp`); stores it if newer than the stored one
  (an older or equal `issuedAt` is `409`). Returns `{ ok: true }`.
- `GET /api/users/<u>/pods` (read-token gated) returns `serverOrder` (the
  stored wire form, or `null`).
- The daemon-status heartbeat reply returns `serverOrder` too (the box already
  proved its STK; the order lists only the account's own servers).
- The heartbeat request carries `orderIssuedAt` (unsigned, advisory like
  `leadsServices`): the `issuedAt` of the order the box ranks by. `.com`
  keeps it with the report and returns it per pod on `/pods`.

## Boxes

- The box keeps the newest valid order in `server-order.json`. Sources: the
  heartbeat reply, and siblings' gossip frames. It adopts an order only if it
  verifies under the sensitive-order authority (`authorizeSensitiveOrder`, the
  config-pinned owner IRK / admin root) for this account and is newer than the
  one it holds.
- Gossip frames are `flagship/gossip/v2`: the vote fields are replaced by
  `orderDate` (the held order's `issuedAt`, 0 if none), and the frame JSON
  carries the signed order beside it, so a box that missed the heartbeat (or
  `.com` is down) still learns the order from a sibling.
- `POST /api/screens/server-order` (paired session; companions can read, not
  post) takes the same wire form straight from the owner's device and
  answers `{ ok, adopted, heldIssuedAt }` (`422` when it doesn't verify).
  `GET` answers `{ heldIssuedAt }`.
- Adopting a newer order (from any source) triggers a gossip tick and an
  immediate heartbeat, so the acknowledgement reaches `.com` at once.
- Election (`compareClout`): position in the order, then birth date, then
  domain, among live runners of the app. `/api/leads` adds `leader` (the first
  live one) but never the order: that endpoint is public, and the full list
  would name every server of the account.

## Delivery and acknowledgement

`.com` keeps one order per account and a newer one replaces it, so orders
never pile up and a box that was off simply gets the newest when it next
checks in. On top of that, after `.com` accepts a reorder the app hands the
same signed order to every server that is up (`POST /api/screens/server-order`);
the box's answer is its acknowledgement. Gossip spreads it to the rest within
a frame. Nothing depends on any one path: a box that misses the direct
delivery gets it from `.com` or a sibling; a missing leader drops out of the
live set (~2 minutes without gossip) and the next live server leads. While
two boxes briefly hold different orders the newer one wins as soon as it
spreads.

The apps keep, per server, the newest `issuedAt` it acknowledged (from its
direct answer or `/pods` `orderIssuedAt`, never moving backwards). The Leader
badge is gray until the leader acknowledges the order on screen; with no
order ever saved it is never gray (boxes and apps then both rank oldest
first).

## What `.services` learns

Gossip frames are sealed under the CGK, so the hub never reads the order.
It already knows which boxes belong to an account (every box's tunnel is
named `<server>.<user>.flagship.services` and presents its STK) and their
current IP addresses; the order adds no new linkage, and only `.com` (which
stores the signed order) learns the ranking.

## Apps (webapp, iOS, Android)

- **Home lists servers in the order** (from `/pods` `serverOrder`, falling back
  to `rankByServerOrder` with no order). Position is the order: no numbers.
  The first server that is online wears a **Leader** badge (gray until it
  acknowledges); when a higher one is offline, the leader's row says it is
  standing in for it.
- **Drag to reorder** by the handle on the left of each row (each row also
  shows a small gray server icon by its name; "Move up/down" accessibility
  actions, and up/down buttons on the webapp for keyboard users). When the
  list settles the app shows the new order, signs it (silently when the
  session holds the key, else one prompt), posts it, delivers it to the
  servers, and on failure puts the old order back with the reason. Make the
  leader the current server afterwards (new apps follow it,
  `docs/app-placement.md`).
- Server detail says where a server stands without numbers: "This server
  leads", "Takes over while A is down", or "First in line to lead".
- Server detail's "Set as preferred server" becomes **Make leader**: moves the
  server to the top of the order and signs it the same way. Home and server
  detail share one order state, so back on Home the server is already first
  with the Leader badge (and moves back if the signature or post fails).
- Demo accounts: reorder locally only (no keys, no post), and never prompt.
- Drop the old preferred-server memory and the set-leader deposit code.
