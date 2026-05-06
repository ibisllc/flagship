# URL multiplexing & app aliases

> **Goal.** When a user visits `game.john.flagship.services` and there's
> no ambiguity about which install they want, just take them there.
> When there *is* ambiguity, show a calm disambiguation page that lists
> the candidates.

This collapses Flagship's full-form URL (`<slug>.<server>.<user>.flagship.services`)
into a shorter form (`<slug>.<user>.flagship.services`) when it's
unambiguous, while leaving the long form always-resolvable for cases
that need the full address.

---

## 1. URL forms

| Tier | Form | When it appears |
|---|---|---|
| **Long, self-authored** | `<slug>.<server>.<user>.flagship.services` | Always — the canonical address. |
| **Long, cross-creator** | `<slug>-<creator>.<server>.<user>.flagship.services` | When `<user>` hosts an app `<creator>` made (and `<creator> !== <user>`). |
| **Short** (this doc) | `<slug>.<user>.flagship.services` | Granted when `<user>` has exactly one install of `<slug>`, regardless of creator and regardless of which server hosts it. |

The long form is **always** resolvable. The short form is a courtesy
that the user can release at any time, and that .com revokes
automatically when the user creates a second install of `<slug>` (so
`game.john` never silently flips to a different app).

### Examples

User `john` has servers `home` and `work`.

| Installs | Short URL `game.john` resolves to | Notes |
|---|---|---|
| `game` (self) on `home` only | `game.home.john.flagship.services` | Trivial collapse. |
| `game` (self) on `home` AND `work` | *(ambiguous → disambiguation page)* | John must pick one as the alias holder, or use replication (v2). |
| `game-peter` on `home` only, no other `game` | `game-peter.home.john.flagship.services` | Cross-creator collapse: short form drops the `-peter` segment too. |
| `game-peter` on `home` AND `game-anna` on `work` | *(ambiguous → disambiguation page)* | Two different creators, both want the `game` slot. |
| `game` (self) on `home` AND `game-peter` on `work` | *(ambiguous → disambiguation page)* | Same slug, two creators, two boxes. |

---

## 2. Data model

A new D1 table, `app_aliases`. One row per `(username, slug)` pair.

```sql
CREATE TABLE app_aliases (
  username       TEXT NOT NULL,
  slug           TEXT NOT NULL,
  -- The full label this alias resolves to:
  -- "<slug>" (self, single install) → CNAME → "<slug>.<server>.<user>"
  -- "<slug>-<creator>" → CNAME → "<slug>-<creator>.<server>.<user>"
  full_label     TEXT NOT NULL,
  -- Which of the user's servers hosts the (currently aliased) install.
  server_domain  TEXT NOT NULL,
  -- Replication v2: JSON array of secondary server FQDNs that also
  -- hold this app and can answer if the primary is offline. NULL in v1.
  replication_set TEXT,
  -- Last-write-wins on declare; phone signs both declare and release.
  declared_at    INTEGER NOT NULL,
  declared_by_irk_pub_hex TEXT NOT NULL,
  declared_irk_signature_hex TEXT NOT NULL,
  PRIMARY KEY (username, slug)
);
```

Conflicts on `(username, slug)` are not allowed:
- `declare-alias` returns 409 if a row already exists with a different
  `full_label`. The Worker returns the conflicting candidate so the
  client can render the disambiguation copy.
- `declare-alias` is idempotent if the same `full_label` is re-declared.
- The phone can `release-alias` first, then `declare-alias` to a
  different target.

---

## 3. Wire types (`@flagship/protocol`)

```ts
export interface AliasDeclareRequest {
  username: string;
  slug: string;
  fullLabel: string;        // "<slug>" or "<slug>-<creator>"
  serverDomain: string;     // "<server>.<user>.flagship.services"
  issuedAt: number;
}
// canonical-bytes tag: flagship/alias-declare/v1

export interface AliasReleaseRequest {
  username: string;
  slug: string;
  issuedAt: number;
}
// canonical-bytes tag: flagship/alias-release/v1
```

Both signed by IRK (the source of authorship truth for the username).

---

## 4. Worker routes

| Route | Method | Purpose |
|---|---|---|
| `/api/aliases/declare` | POST | IRK-signed; create or replace the alias for `(username, slug)`. 409 + `{ candidates }` on conflict. |
| `/api/aliases/release` | POST | IRK-signed; remove the alias. |
| `/api/aliases/resolve?host=<host>` | GET | Public resolver. Returns `{ kind: "single" | "ambiguous" | "missing", … }`. |
| `/api/aliases/by-user/<username>` | GET | Public listing of a user's active aliases (used by the marketplace + dashboards). |

`resolve` is the read path. Inputs:
- `host=game.john.flagship.services` → look up `(john, game)` in
  `app_aliases`. Return the long-form target if exactly one row;
  otherwise `ambiguous`.

---

## 5. DNS plumbing

Every alias creation/removal pokes Cloudflare DNS via the existing
`CloudflareDnsClient`:

| State | DNS records |
|---|---|
| **Single alias** | `<slug>.<user>.flagship.services` CNAME → `<slug>.<server>.<user>.flagship.services` |
| **Cross-creator alias** | `<slug>.<user>.flagship.services` CNAME → `<slug>-<creator>.<server>.<user>.flagship.services` |
| **Ambiguous / missing** | No CNAME; the wildcard `*.<user>.flagship.services` falls through to a Worker route that serves a disambiguation page |
| **Replication (v2)** | Two records with health-check failover, OR a Worker resolver that returns the live primary based on heartbeat data |

The `<slug>.<user>` zone is part of `flagship.services` so the
Worker already has the API token (`CLOUDFLARE_DNS_API_TOKEN`) to write
records.

---

## 6. Cert plumbing

The daemon's wildcard cert covers `*.<server>.<user>.flagship.services`
— that is, the long form. The short form is a level shallower and the
wildcard does not match it (Let's Encrypt wildcards are exactly one
label deep).

When an alias is granted, the daemon hosting the install adds the
short FQDN to its SAN list and re-runs ACME via DNS-01. The .com
Worker's existing DNS-01 publish/delete handlers serve the
`_acme-challenge.<short>.flagship.services` TXT records.

Per-app short FQDNs add 1 cert SAN per active alias on the daemon's
single cert. With Let's Encrypt's 100-name SAN limit per cert, that's
plenty for a household. We can spread across multiple certs if a power
user's box ever serves >50 aliased apps.

---

## 7. Lifecycle

### Declare
1. Phone signs `AliasDeclareRequest{ username, slug, fullLabel, serverDomain, issuedAt }`.
2. POST to `/api/aliases/declare`.
3. Worker:
   - Verify IRK signature against the username's registered IRK.
   - Atomic upsert: if `(username, slug)` exists with same `fullLabel`,
     return 200 idempotent; else return 409 + `{ candidates }`.
   - On success: write/replace the CNAME in CF DNS.
4. Worker fans out to the daemon at `serverDomain` via the existing
   `/.flagship/runtime-pubkey` channel (or via a new alias-notify hook)
   so the daemon adds the short FQDN to its cert.
5. Daemon re-runs ACME, adds the new SAN to its live cert.

### Release
1. Phone signs `AliasReleaseRequest{ username, slug, issuedAt }`.
2. POST to `/api/aliases/release`.
3. Worker removes the row + CNAME. Daemon shrinks its cert SAN list at
   next renewal (no need to force-renew immediately — extra SANs are
   harmless).

### Conflict (auto-revoke)
When the phone installs a SECOND app with the same `slug` on a different
server, the install order also carries an `aliasIfFree: true` flag. The
Worker checks the table:
- If alias exists for the same target → no-op.
- If alias exists for a different target → silently leave it. The
  install still completes; the user just doesn't get the short URL
  this time. The phone shows a banner "the short URL game.john is
  taken; tap to manage."

---

## 8. Disambiguation page (Worker fallback)

A wildcard CNAME at `*.<user>.flagship.services` (or a default DNS
record) routes `game.john.flagship.services` to the Worker when no
specific CNAME exists. The Worker:

1. Parses the host.
2. Looks up `(<user>, <slug>)` in `app_aliases`.
3. If exactly one row: serves a 308 redirect to the long form (defense
   in depth — the CNAME should already have done this, but if DNS is
   stale / the record was deleted seconds ago, the redirect catches it).
4. If zero or multiple rows: serves an HTML disambiguation page with:
   - A short, plain explanation.
   - Each candidate as a clickable card showing the long URL, the
     creator, and the server.
   - A "What's happening?" link to /docs/multiplexing.

---

## 9. Replication (v2 sketch)

Out of v1 scope. Notes for future:
- A user marks an app as "replicate across {home, work}" in the phone.
- Each daemon installs the app; data layer is local to each box.
- Periodic sync (every 5 min by default) via a daemon-pair WebSocket
  on the existing tunnel: pg_dump diff + S3 mirror sync + Redis SET
  diff. Best-effort; LWW on object store, sequence-id on Postgres
  rows. Conflicts surface as a phone alert.
- The alias holds `replication_set`; the Worker's DNS resolver returns
  the live primary based on heartbeat data the daemons publish to .com.
- Failover: 5-minute window. Hard cutover via a phone-issued
  `promote-replica` order if the primary is dead longer.

---

## 10. UX implications

- App creation in the phone shows the **proposed URL** in real time,
  collapsed when possible. Tooltip explains what changed.
- App detail screen shows "URLs that point here" as a list, with the
  short form crossed out + tappable when taken by another install.
- Marketplace listings always link to the **long** form (stable; never
  silently changes meaning even if the user juggles aliases).

---

## 11. Tests we ship

| Test | What it asserts |
|---|---|
| `aliases.test.ts` (control-plane) | declare → resolve returns single; second declare different target → 409 + candidates; release → resolve returns missing; verify-IRK rejects wrong sig. |
| `aliasResolveDisambiguation.test.ts` (Worker) | Catch-all serves the HTML disambiguation page when host has zero or multiple aliases. |
| `aliasCertExpansion.test.ts` (daemon) | Adding an alias adds to the SAN list at next ACME run. |
| `aliasD1.test.ts` | D1 storage round-trips. |

---

## 12. Open questions

- **Username-as-app-slug collision.** A user's username is a label at the
  same depth as a slug (`john.flagship.services` is the user's "page";
  `game.john.flagship.services` is an app). We need to forbid app slugs
  that collide with reserved labels (e.g. `www`, `mail`, `admin`,
  `_acme-challenge`). Existing slug validator in
  `services-zone/validation.ts` already rejects most of these, but we
  should add a public-suffix-list-style reserved-labels list.
- **DNS propagation lag.** New aliases propagate in seconds at CF, but
  some recursive resolvers cache old NXDOMAINs for ≤ TTL. The 308
  redirect catches the stragglers.
- **Multiple boxes share a username.** All collapsed names live under
  the username's zone, not per box. So aliases are user-level, not
  box-level. The phone is the natural arbiter.
- **PSL listing.** When `flagship.services` is on the PSL, browsers
  treat each user's subdomain as a distinct origin. The collapse keeps
  that origin boundary at `<user>.flagship.services`, which is what we
  want.
