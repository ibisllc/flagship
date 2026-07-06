# Random username suggestion — queue + escalating throttle

Status: **design + build** (2026-06-22). Supersedes the batch
`GET /api/username/random` shuffle. Related: `docs/naming-recovery-and-name-change.md`
(§4 random-at-signup), `docs/service-addressing-double-dash.md` (dashed grammar).

## 1. What changes & why

At account creation the user is **handed one random username** and the *only* thing
they can do is accept it or tap **regenerate** for another. There is no typed-username
field at sign-up anymore (typing a name is reserved for the future paid name-change).
Subtext under the suggestion: *"You can change your username later."*

Three concrete shifts from today:

1. **Drop the number suffix.** `<adjective>-<noun>-<NNNN>` → `<adjective>-<noun>`
   (e.g. `happy-otter`). Adjective-noun alone is enough for the first wave of users;
   the word lists are widened to keep comfortable headroom (the `.com` exclusion below
   shrinks the usable pool, so headroom matters).
2. **Exclude existing `.com` properties.** A candidate is dropped if its name already
   exists as a registered `.com` (a DNS lookup of `<name>.com` *and* the de-dashed
   `<namewithoutdashes>.com`). This keeps the random pool clear of brand/domain names
   that a holder might later claim under the launch-dibs program — we never randomly
   hand someone `happy-otter` if `happyotter.com` is a live brand.
3. **A pre-generated queue + escalating per-device throttle.** Suggestions are served
   from a queue of pre-validated names (so the slow DNS work is amortized off the
   request path), and regenerating is rate-limited with an **increasing** cooldown,
   enforced backend-side per requesting device.

## 2. The queue (and the prediction attack it defeats)

A D1 table `username_suggestion_queue(name, enqueued_at)` holds names that have already
passed `validateUserLabel` (grammar + reserved) **and** the not-claimed **and** the
`.com` checks. A cron keeps it warm (DNS happens there, never on the request path).

A suggestion request **pops** the oldest queued name (delete-and-return), re-checks it
is still unclaimed (cheap), and returns it. **Popping deletes** — so:

- **A refused name is *lost*.** When the user taps regenerate, the name they were just
  shown is already gone from the queue (it was deleted when it was handed to them);
  regenerate simply pops the *next* one. The refused name is never re-queued — it can
  only re-appear if the generator randomly produces it again in the future.
- **Why this matters (the attack).** If refused names went back to a predictable place
  in the queue, an attacker could refuse a name and know it will be handed to the next
  person to sign up — enabling front-running / look-alike registration / targeting. With
  pop-deletes-and-reject-loses, an attacker can never *leave* a known name at the head
  for a victim, and can never *learn* an upcoming name without popping it (which deletes
  it, so the victim gets a different one). The queue order is random (generation order)
  and draining it is rate-limited (§4) and IP-capped.

The queue is **advisory**, not a reservation: the authoritative reservation is still
`handleUsernameClaim` at the end. A popped-but-abandoned name stays unclaimed and
claimable; it is simply no longer *in the queue* (regenerable later). On an empty queue
the handler falls back to generating one name inline (grammar + not-claimed only, DNS
skipped) so sign-up never blocks.

## 3. Generation & the `.com` exclusion

`randomCandidate()` → `<adjective>-<noun>` (no number). Replenishment generates
candidates and keeps those that pass, in order:

1. `validateUserLabel(name).ok` — grammar (dashed, ≤30) + reserved set + the test-env
   apex bans. (Already the single source of truth in `labels.ts`.)
2. **not claimed** — `usernames.get(name) == null`.
3. **not a `.com` property** — `comDomainExists(name)` is false. This is a
   DNS-over-HTTPS (DoH) `NS` query against Cloudflare's resolver for both
   `<name>.com` and `<name-without-dashes>.com`; a `NOERROR`/`Status:0` (the apex has
   NS records ⇒ registered) excludes the candidate, `NXDOMAIN` keeps it. DoH errors are
   treated as "exclude" during batch replenishment (skip the candidate) but are
   **skipped** in the rare empty-queue inline fallback (so a DNS outage can't block
   sign-up).

The `.com` check runs **only** in the queue/replenish path — i.e. it shapes what gets
*suggested*. Hard `.com`-blocking at claim time is the dibs feature's job
(`docs/naming-recovery-and-name-change.md`), out of scope here; at sign-up the only way
to get a name is a suggestion, so the suggestion-side filter is what users actually hit.

## 4. Escalating per-device throttle

The CF edge rate-limiter is fixed-window and can't express an increasing cooldown, so a
small D1 table `username_suggest_throttle(device_key, count, window_start, last_at,
next_allowed_at)` carries the schedule. The **first** suggestion (auto-loaded when the
screen opens) is free; each subsequent regenerate must wait longer:

| regenerate # | wait before it is allowed |
|---|---|
| 1st | 2 s |
| 2nd | 5 s |
| 3rd | 10 s |
| 4th | 20 s |
| 5th+ | 30 s (cap) |

`count` resets after `WINDOW_RESET_MS` (10 min) of inactivity so a returning user starts
fresh. On a successful suggest the response carries `retryAfterMs` (time until the next
regenerate is allowed) so the client can disable the button and show a live countdown; a
throttled request returns **429** `{retryAfterMs}`.

**device_key.** A client-generated **ephemeral** hex id, fixed for the duration of one
sign-up session (NOT the account IRK — on native the IRK does not exist yet at the
suggestion screen). It is enough to throttle an honest device's regenerate spamming.
Because device keys (like account keys) are free to mint, the throttle is *not* an
anti-abuse boundary on its own — a coarse **per-IP** CF rate-limit bucket
(`username-suggest`) is the abuse backstop, and the throttle table is pruned by the same
cron that replenishes the queue.

The endpoint is therefore **unsigned**: it mutates only ephemeral/advisory state (a
queue pop + a throttle counter), so a signed envelope (and its three-language canonical
bytes) would be ceremony without a security gain the per-IP cap doesn't already provide.

## 5. API

`POST /api/username/suggest` — body `{ "deviceKey": "<hex, ≤128 chars>" }`.

- **200** `{ "name": "happy-otter", "retryAfterMs": 2000 }` — the suggestion + the
  cooldown until the next regenerate.
- **429** `{ "retryAfterMs": 7000 }` — regenerated too fast.
- **400** — missing/oversized `deviceKey`.
- **503** `{ "error": "no name available" }` — queue empty *and* inline fallback
  exhausted (namespace saturated / everything DNS-excluded; practically never).

Replaces `GET /api/username/random` (removed). Replenishment + throttle-prune run on the
existing `*/10` cron.

## 6. UI (all platforms)

One layout, mirrored on webapp / iOS / Android, sitting exactly where the typed
username screen used to be in the create flow (the chosen name is carried forward to the
existing open-account/claim step — identity is still minted there):

```
        Your handle

      ╭─────────────────────╮
      │     happy-otter     │      ← the suggestion, large
      ╰─────────────────────╯
         ↻  Try another            ← regenerate; disabled with a
                                      live "Try again in 5s" during cooldown
   You can change your username later.   ← subtext

      [   Continue   ]              ← claims the shown name
```

- On mount the client generates the ephemeral `deviceKey` and fetches the first
  suggestion.
- **Try another** calls `/api/username/suggest`; on **429** it disables itself and shows
  the countdown from `retryAfterMs`; on **200** it swaps in the new name and arms the
  next cooldown from `retryAfterMs`.
- **Continue** carries the shown name forward; the existing claim step mints identity and
  claims it. If the claim races and fails (name taken in the gap — rare for a random
  name), the client fetches a fresh suggestion and retries.

## 7. Build order (focused commits)

1. **Storage** — migration `0061` (queue + throttle tables) + interfaces + InMemory + D1
   + parity + `schemaStatus` `0061`.
2. **Control-plane** — generator (no number, widened lists) + `comDomainExists` (DoH) +
   replenish/pop + throttle schedule + `handleSuggestUsername`; drop `handleRandomUsername`.
3. **Wiring** — route swap (`/api/username/random` → `POST /api/username/suggest`),
   `username-suggest` IP bucket, cron replenish + throttle-prune.
4. **Webapp** — the suggestion step in `createAccount` (regenerate + cooldown + subtext).
5. **iOS** — `SuggestUsernameScreen` + VM + client `suggestUsername` (live + mock) + tests.
6. **Android** — mirror.
7. **Status/docs.**

## 8. Open / deferred

- Hard `.com`/dibs enforcement at **claim** time (here it only filters suggestions).
- The word lists are curated-benign; a tiny offensive-substring denylist guards
  accidental pairings. Expand lists further as the user base grows past the adj-noun pool.
- A signed suggest envelope if the per-IP backstop ever proves insufficient.
