# App groups: one app, several processes, one box

Status: built for release 0.3 (IMPLEMENTATION-PLAN.md §8.5, work package P05). Tested over fakes
(`tests/appGroups.test.ts`); to be drilled on a Debian 13 VM (`docs/architecture-v2/drills/
m7-runtime.md`, phase `groups`, on Docker and Podman) and in the live gym (`app-groups-db`).

An app that needs a web process, a worker and a private service declares them in its manifest
(schema 2, `components`). They are one app: one approval (the capability digest lists every
component), one trust boundary, one egress list, one database, one files folder. Grouping never
gives two apps anything in common. There is no cross-server placement, scheduling or cluster:
apps that need to coordinate across servers use the existing server chat.

```json
"runtime": { "base": "node-24", "start": ["node", "server.js"], "port": 8080 },
"components": [
  { "name": "cache", "image": "ghcr.io/me/cache@sha256:…", "port": 6379 },
  { "name": "queue", "base": "node-24", "start": ["node", "queue.js"], "port": 7000, "startAfter": ["cache"] },
  { "name": "worker", "base": "node-24", "start": ["node", "worker.js"], "startAfter": ["queue"], "resources": { "memoryMiB": 256 } }
]
```

A component with `base` runs the app's own build with its own `start`; one with `image` runs that
image. At most 8 components; names are DNS labels; `startAfter` must name components and may not
loop. A box that can't link processes (no egress gateway) refuses the install: "This server cannot
run an app made of several processes yet."

## How it runs (`appGroups/`, `appRuntimes.ts`)

- **Members**: each component is an ordinary hardened app container (gVisor, no capabilities,
  read-only root, its own `resources` within the box's ceilings) named
  `flagship-<serviceId>.<component>`, on the apps bridge; the routed main process is
  `flagship-<serviceId>` as for any app. Every member resolves to its app for egress approvals,
  the database route and backups (`owningServiceId`).
- **Links**: containers on the apps bridge can't reach each other. A component that declares a
  `port` gets a port in the gateway's owned range (`OWNED_PORT_RANGE`, kept in
  `<dataDir>/data/owned-ports.json`); the gateway forwards it to that member's loopback port for
  this app's containers only and cuts every other source. Members find it as `<component>:<port>`
  (`/etc/hosts` entry) and `FLAGSHIP_COMPONENT_<NAME>=<component>:<port>`.
- **Order**: components start in `startAfter` order (declared order otherwise), each confirmed
  running, and listening when it has a port, before the next; the main process starts last. Stops
  run in reverse.
- **Failure**: a member that won't start stops every member started so far and unlinks them; the
  install fails with that member's last output.
- **Update** (`PUT /api/services/<serviceId>`, the same owner-signed order as an install):
  every member of the old version stops, the new version starts in order; if any member fails,
  the new members are stopped and every member of the previous version is started again, in order
  ("every process of the previous version is back" in the daemon's journal). Data migrations keep
  their existing contract (one transaction per file, recorded as applied).
- **Backup**: every member is paused at once while its databases are dumped and its files folder
  is archived, then resumed in reverse, so a backup is one moment of the whole app.
- **Restart and restore**: the signed manifest is what is saved, so a daemon restart or a
  whole-server restore brings back every member in order.
- `GET /api/app-runtime/<serviceId>` (owner session) lists the members in start order with their
  state; there is no client screen for it yet.

## Not covered

Members can't be scaled or placed on other servers (by design). A component's own health check
(manifest `health`) and per-member restart policies are the main process's only. App copies between
servers carry the main image and the data, not component images pulled from elsewhere.
