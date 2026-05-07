# App developer guide

A "Flagship app" is a containerized service that runs on a user's pod
and reaches the daemon for identity, data, browser automation, and
sibling coordination. Most apps are vibe-coded — the user describes
what they want and the LLM emits the manifest + code. This guide is
for the small population of humans who hand-write Flagship apps.

For the manifest schema field-by-field, see
[the manifest reference](manifest.md).
For the URL-multiplexing model + sibling-WS protocol, see
[multiplexing](multiplexing.md).

## What you ship

Every app's git repo has at the root:

```
flagship.app.json   # the manifest (schema_version=1)
Dockerfile          # OCI image build (or a prebuilt image referenced from the manifest)
README.md           # human-readable description
src/, etc.          # whatever your runtime needs
```

The manifest's `runtime.image` is the OCI ref the daemon pulls. You
can build it yourself and push to a registry, or include a Dockerfile
that the daemon's build pipeline (when the user vibe-codes the app)
runs in-place.

## Identity injection

The daemon terminates TLS and injects per-request headers before
forwarding the request to your container:

| Header | Meaning |
|---|---|
| `X-Flagship-User` | The visitor's stable id (`anonymous` for public routes). |
| `X-Flagship-Role` | One of `owner` / `admin` / `member` / `viewer` or your `custom_roles[]` value. |
| `X-Flagship-Timestamp` | ms since epoch — bind your reads + writes to this if you care about freshness. |
| `X-Flagship-Signature` | hex Ed25519 signature over `flagship/inject/v1|<appId>|<user>|<role>|<timestamp>`. |

Verifying the signature is optional but recommended in production. The
daemon's pubkey is at `GET /.flagship/runtime-pubkey` (relative to
your app's URL). Cache it.

## App-facing daemon API

Your container's environment includes `FLAGSHIP_APP_TOKEN`. Every call
to the daemon's app-facing API uses
`Authorization: Bearer <FLAGSHIP_APP_TOKEN>`. The daemon resolves the
token to your app id and uses it as the scoping key for everything
below.

The daemon is reachable from inside the container at the local
loopback (the Docker network exposes `host.flagship.local` or similar
— production wires this).

### Browser feature

```
POST /api/browser/tabs            { url } → opens a tab against your
                                   manifest's browser.domains allowlist
GET  /api/browser/tabs            list YOUR tabs (cross-tenant tab ids
                                   return 404)
POST /api/browser/screenshot      take a screenshot of a tab
…                                 see `packages/server-daemon/src/browser/`
```

Your `browser.domains` list in the manifest is the gate — the daemon
hard-blocks navigation outside that set. The user is the keyholder for
any login the browser needs (passwords flow phone → daemon → CDP).

### URL claiming (multiplexing)

```
GET  /api/url               list all URLs you can interact with
POST /api/url/claim         { fqdn } — claim a non-canonical URL
POST /api/url/release       { fqdn } — drop a claim
GET  /api/url/owned         what THIS instance currently holds
```

The canonical URL `<your-subdomain>.<server>.<user>.flagship.services`
is always reachable; you can't claim or release it. Aliases like
`<your-subdomain>.<user>.flagship.services` and custom domains require
a phone-issued capability (the user's phone mints them when the user
toggles "claim this URL" in your app's detail screen). See
[multiplexing](multiplexing.md) for the full model.

### Sibling coordination (multi-pod apps)

When the user installs your app on multiple pods AND enables "let
instances talk to each other," your code can use:

```
GET  /api/live_siblings/list      list of {siblingId, fqdns, online, lastSeenMs}
POST /api/live_siblings/send      {toSiblingId, payloadHex} — route to peer
GET  /api/live_siblings/poll      long-poll for inbound app-messages
```

`live_siblings` is the deliberate name: the harness gives you only
peers it can currently see (live WS or just-gossiped). There is no
persisted history. Pods come and go as the user adds and removes
boxes — write your code so it tolerates a peer disappearing
mid-conversation.

The harness does NOT replicate Postgres / MinIO / Redis for you. If
your app needs cross-pod consistency, you implement it on top of these
primitives. Three patterns the LLM is taught to use (see N0k):

1. **Eventual-consistency LWW**: every write broadcasts to siblings
   with a wall-clock timestamp + sibling-id; receivers apply if newer.
2. **Leader-only writes**: gate writes on URL ownership. The pod
   holding the alias FQDN is the leader by definition; reads work
   everywhere; writes route via `/api/live_siblings/send` to the holder.
3. **Per-pod independent state** (default when "let them talk" is
   off): each pod has its own data, no coordination.

Apps own consistency. The harness owns distribution fabric.

### Update-pack distribution

The canonical-home pod (the creator's pod) serves
`/.flagship/update?since=<sha>` as the update channel. Subscriber
pods (anyone hosting your app cross-creator) pull this every 6 hours
via a daemon-side scheduler. You don't need to do anything special —
the harness handles fetch + verify + apply + lineage check.

If your manifest sets `distribution.public: true`, anyone can pull;
otherwise the canonical-home's subscriber list is the gate.

## Hooks the daemon offers

| Hook | What it does |
|---|---|
| `X-Flagship-Signature` verify | Confirm the request really came from the daemon. |
| `X-Flagship-User` | Stable per-user id; key your data on this. |
| Anonymous `public_routes` | Add a route to `access.public_routes` to expose it without membership. |
| `queryable_by` allowlist | Let a sibling app discover whether you're installed. Direction is target-controlled. |
| Browser API | High-level Puppeteer-style only — no raw CDP, no cookies, no localStorage. |
| Sibling API | Frame routing for app-defined replication strategies. |

## Hooks the daemon explicitly does NOT offer

- ❌ Postgres / MinIO / Redis replication.
- ❌ Leader election (the URL holder is the leader).
- ❌ Heartbeat-based auto-failover.
- ❌ Schema-migration coordination during replication.
- ❌ Auto-claiming alias URLs on multi-pod installs.
- ❌ Cookie-level browser access.

## Testing locally

The daemon ships with a vitest suite under `packages/server-daemon/tests`
that mocks the data layer + browser + sibling routing. To smoke an app
locally:

1. Build the image: `docker build -t my-app:dev .`
2. Use the dev pod compose (instructions in `installer/`) to point at
   your local image.
3. The dev pod registers with `flagshipserver.com` as a normal pod;
   you'll get a real Let's Encrypt cert.

## Publishing to the marketplace

The marketplace is a directory of public apps. To list yours:

1. Make sure your manifest is complete (schema_version=1, network,
   access, migration all set).
2. Push to `https://flagshipserver.com/marketplace` with the IRK-signed
   listing payload (the phone UI handles this — there's no human
   path to type out the signature).
3. Listing is published instantly; the static-analysis scan runs
   asynchronously and updates the listing's `scanGrade`.

## Versioning

Bump `version` in the manifest on every release. The daemon's
update-pack lineage check refuses to apply an update whose lineage
anchor doesn't match the previous tip — it's how we detect repo
rewrites and split-history attacks. If you accidentally rewrite
history, the user gets a phone alert and can either accept (re-anchor)
or reject (stop pulling).

## Where to look in the code

| Topic | Source |
|---|---|
| Manifest validation | `packages/protocol/src/manifest.ts` |
| App platform (install / uninstall) | `packages/server-daemon/src/appPlatform.ts` |
| Identity injection | `packages/server-daemon/src/identityInjector.ts`, `appProxy.ts` |
| Browser API | `packages/server-daemon/src/browser/` |
| Sibling API | `packages/server-daemon/src/sibling/` |
| Update-pack server | `packages/server-daemon/src/updateServer.ts` |
| Data layer | `packages/server-daemon/src/dataLayer/` |
