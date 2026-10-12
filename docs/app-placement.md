# Where an app runs: choosing, listing and copying

**Status:** owner request 2026-10-12; being built.

## The bugs this replaces

- The apps keep two pod pointers: `leaderPodId` (the preferred server) and
  `currentPodId` (the box the screens client talks to). "Make leader" changed
  only the first, and every app-creation path follows the second, so new apps
  kept landing on the old box.
- The app page's "runs on" checkboxes were seeded from the leader, never from
  where the app actually is, and Save sent a `service-policy/v1` order nothing
  consumes (the box answers 503).

## 1. The leader is the default target

Making a server leader also makes it the current server. `currentPod` prefers
the leader whenever the leader is online and this device has a session for it.

## 2. Choosing where a new app runs

Every creation flow (chat "vibe" start, git import, IDE/MCP connect) shows
**Runs on: <server>** with a picker of the account's servers, defaulting to the
leader. The request goes to the chosen box through a screens client bound to it
(its own base URL and session token). Started from a server's page, the server
is fixed and not asked again. The address preview shows the chosen box.

## 3. A server's apps

A server's page lists the apps installed on it (name, address, status), each
opening the app's page, plus **Create app here** (goes into the creation flow
pinned to that server). While a copy onto that server is underway the app is
listed greyed out with "Copying…" and its progress.

## 4. Runs on, honestly

The app page asks each of the account's servers whether it has the app (its
apps list), and ticks exactly those. A server that can't be reached shows as
unknown, never as ticked.

- **Tick a server** = copy the app there.
- **Untick a server** = remove the app from that server (the existing signed
  uninstall). The last copy can't be unticked here (use Remove).
- The broken `service-policy/v1` Save is removed.

## 5. Copying an app to another server

A copy is a snapshot: code, its built image, database and files as they are
at that moment. Afterwards the two copies are independent (each has its own
data), like any sibling.

- The phone signs `flagship/app-copy/v1|sourceServer|targetServer|serviceId|issuedAt`
  with the sensitive-order key (vectors: `packages/protocol/test-vectors/app-copy/vectors.json`)
  and sends it to the **target** box:
  `POST /api/screens/services/copy {grant:{sourceServer, targetServer, serviceId, issuedAt}, signature}`
  → 202 `{copyId}`; 400 malformed, 403 bad signature / not this box / stale,
  409 already there or already copying.
- `GET /api/screens/services/copies` → `{copies:[{copyId, serviceId, appName,
  sourceServer, state:"copying"|"installing"|"done"|"failed", progress?, reason?,
  startedAt}]}`; the target's apps list also carries the app with
  `copying:{state, progress}` while underway.
- The target fetches the bundle from the source box over HTTPS, presenting the
  owner's grant and proving it is the named target box (its server key, checked
  by the source against the account directory). The source verifies the grant
  (owner/admin authority, freshness, its own name as source) and streams: the
  manifest, the image (`docker save`), a consistent Postgres dump and files
  archive (the same dump the backups use), the app's member allow-list, and its
  owner env values only if both boxes can seal them under the account's shared
  key (otherwise the names come as pending env requests).
- The target installs it under the same service id, with fresh data stores
  restored from the dump and archive, and starts it (start check).
- Access list and API keys are per server (they're signed for a server name):
  the target turns the source's access list into a **draft** for the owner to
  approve (docs/ai-privacy-and-staging.md §3a), and API keys are not copied.
- A failure leaves nothing half-installed on the target and the source untouched.
