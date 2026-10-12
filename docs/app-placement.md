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
  → 202 `{copyId}`; 400 malformed (also: source and target the same server),
  403 bad signature / not this box / source not a server of this account /
  stale (more than 10 minutes from the box clock), 409 already there, already
  copying, or this signed order already used. Owner sessions only: a companion
  gets 403 on both copy endpoints.
- `GET /api/screens/services/copies` → `{copies:[{copyId, serviceId, appName,
  sourceServer, state:"copying"|"installing"|"done"|"failed", progress?, reason?,
  startedAt, pendingEnv?}]}`, newest first. `progress` (0..1, over the whole
  copy) is present only while underway; `pendingEnv` lists the env names whose
  values couldn't come along (see below). A copy a daemon restart cut off is
  `failed` with reason "interrupted: the server restarted during the copy".
- While underway the target's apps list (`GET /api/screens/apps-list`) carries
  the app as `{serviceId, creator, slug, name, urlLabel, url, status:"unknown",
  installedAt, copying:{state:"copying"|"installing", progress}}`
  (`installedAt` = when the copy started); once installed it is an ordinary row.
- The target fetches the bundle from the source box over HTTPS:
  `POST https://<sourceServer>/api/app-copy/export {from, grant, signature, part, offset, issuedAt, auth}`,
  where `auth` is the target's identity-key signature over
  `flagship/app-copy-fetch/v1|from|to|serviceId|grant.issuedAt|signature|part|offset|issuedAt`
  (at most 5 minutes old). The source checks that key against `.com`'s server
  directory (a revoked server has none), that the caller is the grant's target
  and a server of the same account, and the grant (owner/admin authority, its
  own name as source, at most 15 minutes old when the export opens, one export
  per grant). `part:"meta"` answers 202 while the source makes the bundle, then
  its description; the data parts (`image` from `docker save`, `db:<store>` a
  `pg_dump` of each of the app's databases as the app's own role, `files` the
  backups' archive of its files folder, the app paused meanwhile; `source` its
  working tree when it was built there, so it stays editable) are read in
  8 MiB chunks and checked against their SHA-256 on arrival; `part:"done"`
  lets the source delete it. The description also carries the members (the
  membership list and the service-access mode + allow-list), the source's
  signed access list, and the owner env: its values only sealed under a key
  both boxes derive from the account's shared gossip key (CGK), otherwise (or
  when the target can't open them) the names alone, which the target reports
  as `pendingEnv`.
- The target installs it under the same service id, with fresh data stores
  restored from the dumps and archive before the container first starts, and
  starts it (start check).
- Access list and API keys are per server (they're signed for a server name):
  the target turns the source's access list into a **draft** for the owner to
  approve (docs/ai-privacy-and-staging.md §3a), and API keys are not copied.
- A failure leaves nothing half-installed on the target and the source untouched:
  the install drops the stores it made, and the copy removes the image it
  loaded (one already on the box stays), the env it wrote and its downloads.
  After a restart the target removes what an interrupted copy held, or marks it
  done when its install had finished.

## 6. An app's status pill

The box's apps list used to hard-code `status: "unknown"`, and the apps read
anything but `running` as "Stopped", so every app looked stopped.

**Box** (`GET /api/screens/apps-list`, and the `app` in app-detail):
- `status`: `"running" | "starting" | "stopped" | "unknown"` from the app's
  real container state, read once per request for all apps (one `docker ps`,
  not one call per app). `unknown` only when Docker can't be asked.
- `activity?`: `{kind: "deploying" | "copying" | "editing"}` when something is
  working on the app on this box: `deploying` while an install, rebuild,
  redeploy or AI "finish" is putting a new version live; `copying` while a copy
  is arriving (the existing in-progress row); `editing` while an AI or IDE
  session is open on it (its staging copy).

**Services list pill**, combining every server the app is on:
1. any server says `deploying` or `copying` → **Deploying**
2. else any says `editing` → **Editing**
3. else N servers say `running` (or `starting`) → **On 1 server** / **On N servers**
4. else N servers say `unknown` (an older box that lists the app but can't
   tell its state) → **On N servers**, even if others say `stopped`
5. else every server that answered says `stopped` → **Stopped**
6. else (no server answered) → **Can't reach**

The app's own page shows the same for the server it's opened on (Running,
Starting, Stopped, Deploying, Copying, Editing), and each Runs-on row shows
that server's state.
