# App runtimes: a standard substrate, small apps, one sandbox per app

Status: spec, 2026-10-12. Owner decisions: build it; breaking changes are fine
(no existing users); runtimes are pulled and cached by each box, not baked
into the install image.

## 1. Why

Today an app is a folder with `flagship.app.json`, a `Dockerfile`, its source
and `migrations/*.sql`, and the Dockerfile may start `FROM` any public image.
So every app carries its own OS and language runtime:

- a copy between two servers moves ~250 MB for a Node app whose own code is a
  few MB (docs/app-placement.md §5), over the owner's uplink;
- a marketplace listing would be an opaque image that has to be scanned whole;
- a security fix to Node has to be rebuilt into every app separately;
- the AI chooses `FROM` and writes every `RUN` step of the build, which run
  as root with docker's default build privileges.

The fix is a substrate the box owns: a few **runtimes**, pinned by the
endorsed release and shared by every app on the box, with the app reduced to
its own files.

## 2. The red lines this protects

From the owner (2026-10-12): the system must make sure that

1. no app can impact or spy on another app: not its files, database,
   processes, memory, environment, temp files or traffic;
2. no app can extract user data it wasn't given, or the box's own secrets;

and it does **not** try to protect an owner from their own app's code (what an
app does with its own data is the owner's business). From the box's point of
view every app is untrusted, including the owner's and the AI's.

## 3. Tiers

| Tier | What | Who | Sandbox |
|---|---|---|---|
| 1 | **Runtime app**: `runtime.base` + the app's files | the AI's builds, most marketplace apps | gVisor, non-root, locked down |
| 2 | **Runtime + vetted packages**: `runtime.packages` (e.g. `ffmpeg`) | apps that need a system tool | same as 1 |
| 3 | **Custom image**: `runtime.image` | vendor apps (Vaultwarden, Immich, …) the owner imports and approves, or a reviewed marketplace listing | same as 1, never the AI |

The AI never writes a Dockerfile again (§6). A Dockerfile only exists in tier 3,
written by a vendor, and only an owner-signed import (or marketplace review)
lets it onto a box.

## 4. Runtimes

### 4.1 The catalog

A runtime is a public upstream image pinned by its multi-arch index digest,
plus what the box needs to know to build on it. The catalog lives in the
daemon (`packages/server-daemon/src/runtimes/catalog.ts`) and therefore ships
with, and is endorsed by, each release. v1:

| id | image (pinned by `@sha256:` index digest) | arm64 size | port | user |
|---|---|---|---|---|
| `node-24` | `docker.io/library/node:24-trixie-slim` | 83 MB | `$PORT` | 10001 |
| `python-3.13` | `docker.io/library/python:3.13-slim-trixie` | 43 MB | `$PORT` | 10001 |
| `static` | `docker.io/nginxinc/nginx-unprivileged:alpine` | 26 MB | 8080 | 101 (image's own) |

`node-24` and `python-3.13` share their Debian trixie base layer (30 MB), so a
box holding both stores it once. Later: our own images
(`ghcr.io/ibisllc/flagship-runtime-*`) built reproducibly in CI, once the
upstream ones are a limit; the catalog format doesn't change.

### 4.2 Pulled once, cached

- A box pulls a runtime the first time an app needs it (`docker pull
  <image>@<digest>`), and docker keeps it by digest; every later app reuses it.
- After the first unlock the box pulls the catalog's runtimes in the
  background, so the first app doesn't wait.
- Docker verifies every byte against the digest, so the registry (or anything
  between) can't substitute content.
- A copy target that lacks the runtime pulls it from the registry, never from
  the source server (§8).
- Pruning: the box keeps every runtime an installed app or the current catalog
  names, and removes the rest after each update.
- Privacy: the registry sees an IP fetching these images. Boxes already reveal
  as much by pulling Postgres at first boot; nothing more is learned.

### 4.3 Vetted packages (tier 2)

`runtime.packages` names Debian packages from a vetted list in the catalog
(v1: `ffmpeg`, `imagemagick`, `tesseract-ocr`, `poppler-utils`, `pandoc`,
`libreoffice-core`, `gdal-bin`, `fonts-noto`). The box builds `runtime +
sorted package set` once, as a derived image tagged by the hash of the set
and the runtime digest, and every app asking for the same set shares it.
Not for `static`.

## 5. Isolation (applies to every tier)

| Path one app could take | Wall | |
|---|---|---|
| A kernel exploit out of its container | **gVisor** (`runsc`): the app's syscalls go to a user-space kernel; the sandbox process itself runs unprivileged under seccomp | §5.1 |
| A root process meeting the host | fixed non-root user (`--user`), all capabilities dropped, `no-new-privileges` | today + §5.2 |
| Another app's container | `enable_icc=false` on every sandbox bridge, plus the egress firewall | **done** (`egress/networks.ts`) |
| Another app's files | per-app volume, no host paths, no docker socket | today |
| Another app's database | per-app role and database, connect only to its own | today |
| Starving the others | cgroup memory/CPU/pids limits; **per-app disk quotas**; Postgres limits per role | §5.3 |
| The box's keys and daemon | nothing of `/var/flagship` mounted; the host firewall admits only the gateway and data ports from app bridges | today |

What gVisor does not solve, and what covers it instead: wiring mistakes
(a mounted socket, host networking — refused by `serviceRunner.ts`), the shared
Postgres server (a Postgres bug or runaway query crosses apps: role limits,
§5.3), disk exhaustion (quotas), and CPU side channels (kernel and microcode
mitigations; accepted for a home box).

### 5.1 gVisor for every app

- Every app container (live and staging) runs with `--runtime=runsc`; Postgres
  and the data services stay on `runc` (our own pinned images).
- The box installs `runsc` from gVisor's release binaries, pinned by SHA-512 in
  the release (amd64 + arm64), and registers it in `/etc/docker/daemon.json`
  (`"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}`), then reloads
  dockerd. Platform `systrap`: works without KVM, so inside Studio's VMs too.
- Fail closed: if `runsc` isn't available, the box doesn't start apps, and says
  why on the app's page.
- Cost: roughly 10–30% on I/O-heavy work, little on typical web apps, tens of
  MB of memory per app. `io_uring` and some `/proc` details are unavailable;
  Node, Python and nginx don't need them.

### 5.2 Non-root

Runtime apps run as uid/gid 10001 (`static`: the image's own 101). The app's
files folder is created owned by that uid. Tier-3 images run as their declared
`USER`, and an image that declares root runs as 10001 unless the owner's import
approval says otherwise (some vendor images need to start as root and drop).

### 5.3 Disk and Postgres limits

**Built 2026-10-16** (`packages/server-daemon/src/appQuota/`). The limits
make the server's backup policy hold (docs/server-backup-and-clone.md,
"Backup policy"): with phone-side backups the server's app data can't grow
past the space the phone reserved; with peer backups it may use a third of
its own disk. `backupPolicy/cap.ts` turns the policy into a limit and the
limit into per-app budgets (what each app holds plus an equal share of the
room left); the quota manager (`appQuota/manager.ts`) holds every app to its
budget, every 2 minutes and at once when the policy changes.

Budgets: each app's Postgres + files budget is re-split between the stores
it has (`limits.ts splitStores`): growth follows what each store holds, but
no store gets less than a quarter of it (a new app's empty files folder next
to a database that starts with its extensions would otherwise get nothing).
A folder made before its app has a budget (an install, a copy or an import
arriving) may use all the room left under the limit until the next tick. The
owner setting per-app limits is for later.

**Files folder: its own disk image.** Every app's files volume is a Docker
volume bound to a folder inside a sparse ext4 image, loop-mounted by the box
(`appQuota/loopVolumes.ts`):

```
/var/lib/flagship-files/<volume>.img     sparse ext4 (4 KiB blocks, no reserved blocks)
/var/lib/flagship-files/<volume>/        mount point, chattr +i while unmounted
/var/lib/flagship-files/<volume>/data    what the volume binds at /data
/var/lib/flagship-files/<volume>/.flagship-ballast   outside data/, never seen by the app
```

- Why images: the box's root is ext4 on LUKS (the appliance and the USB
  installer alike) made without ext4's `quota`/`project` features, which
  can't be switched on while it's mounted, and xfs isn't used. Images need
  only e2fsprogs and util-linux, which every Debian has. A full folder is
  ENOSPC for that app alone; the box's disk is untouched.
- Size: the budget (64 MiB at least); with no limit, 90 % of the disk. The
  image is sparse (a 400 GB one allocates ~11 MB) and mounted with `discard`,
  so deleting files gives the room back to the box.
- A higher budget grows the image online (`truncate`, `losetup -c`,
  `resize2fs`; 64 MiB → 20 GiB tested). A lower one is held by the ballast: a
  preallocated file (`fallocate`, never written, costs the box nothing) sized
  to what's above the limit. It binds every writer, root included (ext4's
  reserved blocks don't, and `tune2fs` refuses more than half the
  filesystem). An app already over a lower limit gets the room it frees
  taken until it's down to it.
- Fail closed: the volume binds `<mount>/data`, which exists only inside the
  mounted image, so a container whose image isn't mounted doesn't start. The
  box mounts every image at boot before any app starts (no Docker needed),
  and checks again before each `docker run` of an app or staging copy
  (`setFilesVolumeGuard`); an image that's gone refuses the app with "this
  app's files folder is missing its disk image".
- An older plain volume is moved into an image (`cp -a`, labels kept) the
  next time its app starts with nothing holding it (if that fails, it stays
  plain and the app still starts); an image whose volume went missing is
  bound again, never replaced by an empty folder. Uninstall and self-delete
  drop the images. Backups, copies and archives mount the volume
  as before, so the image and its ballast never travel.
- `FLAGSHIP_FILES_QUOTA=0` keeps plain volumes (no limit of their own).

**Postgres: writes revoked at the limit** (`appQuota/pgQuota.ts`). Postgres
has no quota. The box sums `pg_database_size` over the app's databases and,
at its budget, takes the role's write privileges away: INSERT and UPDATE on
every table (and from PUBLIC if that's where they came from), CREATE on its
schemas (`public`'s comes through `pg_database_owner`, which the app role
is, so it's revoked there too), CREATE and TEMPORARY on its database. Reads,
DELETE and TRUNCATE still work, so the app can make room; existing sessions
feel it at once. Each tick re-blocks (tables made since). What was taken is
recorded (`<dataDir>/data/app-quota.json`) and given back exactly once the
database is 1 % under its budget. "Under" counts the room Postgres can reuse:
deleted rows leave space the next INSERT takes without growing the files,
and the size only falls after a VACUUM FULL, so while blocked the box runs a
plain VACUUM every 10 minutes and reads the free space map
(`pg_freespacemap`, in an admin-owned schema, dropped on unblock). The app
role owns its database and can grant itself the privileges back: an app
that grows by more than 64 MiB (or 10 %) past where it was blocked is
stopped (NOLOGIN, its sessions ended) until it's back under. The box's own
work runs as the admin and is never affected (backups, the owner's signed
database writes, copies, staging seeds); an app's own SQL migrations run as
its role and fail while it's blocked. Large objects aren't covered.

**The box's own disk: a brake that applies whatever the policy (`none`
included).** On the disk that holds Docker, Postgres and the images: at 90 %
used, every app's folder is frozen (the ballast takes all that's free) and
every database is blocked; at 95 % the folders are remounted read-only
(EROFS); under 88 % it lifts. Per-app limits stay as they were.

**Staging copies and builds**: a staging copy's files folder is 512 MiB and
its database 256 MiB (`DEV_*_QUOTA_BYTES`). A `docker build` writes to
Docker's own storage, which no image can hold, so the box watches the disk
while it runs and kills it once it has added 4 GB or the disk reaches the
brake ("the build wrote more than 4.0 GB to the server's disk, so it was
stopped").

**Visibility**: `server-detail.storage` (`disk`, `brake`, `capped`, and each
app's `files`/`postgres` with `usedBytes`, `limitBytes`, `full`) and
`app-detail.storage` (the app's own; `postgres.writesBlocked`, `stopped`).
When an app fills up, the box writes an Activity entry (`app.storage.full`,
`app.storage.room` when it has room again; `server.disk.full` /
`server.disk.room` for the brake), queues an `app-storage-full` phone alert
(serviceId + store) and sends a content-free push (category `generic`, at
most one per 10 minutes): the phone shows "An app on this server is full".

Tested: unit tests over fakes, the database limiter on a real Postgres 18
(CI runs the box's image), and the images on a Debian 13 arm64 VM as root
(CI runs them with sudo, plus a container on the volume). Still to do: the
clients don't show `storage` or the alert yet; per-app limits set by the
owner; the live gym group `quota` (fill a gym app's folder and database on a
real box, under gVisor) hasn't run yet.

Other limits, unchanged:

- `/tmp`: tmpfs, 64 MB.
- Postgres, per app role (not built yet): `CONNECTION LIMIT 20`,
  `statement_timeout 30s`, `idle_in_transaction_session_timeout 60s`,
  `temp_file_limit 1GB`.

## 6. Builds

### 6.1 The manifest

```json
"runtime": {
  "base": "node-24",
  "port": 8080,
  "start": ["node", "server.js"],
  "packages": ["ffmpeg"],
  "env": { "LOG_LEVEL": "info" }
}
```

`base` (tiers 1–2) or `image` (tier 3). A runtime app carries no `image`
until the box builds it; the box then sets `image` to its local tag beside
`base` (the installed manifest has both, and `base` decides the build).
`start` is the command (argv, no shell); `node-24` defaults to `npm start`,
`python-3.13` requires one, `static` takes none and has `root` (the folder to
serve, default the whole app). Parsed in `packages/protocol/src/manifest.ts`
(`RUNTIME_BASES`).

### 6.2 What the box builds

The box writes the build; the app has no say in `FROM` or `RUN`.

- **Install** (node, python): dependencies install in a locked-down container
  of the runtime (the app container's flags, the build bridge's registry-only
  egress, the app's working tree mounted read-only, an output folder
  writable): `npm ci --omit=dev` (needs `package-lock.json`) or
  `pip install --no-cache-dir --target /out/deps -r requirements.txt`. Install
  scripts run there, under the same walls as the app itself.
- **Assemble**: `FROM <runtime>@<digest>`, `COPY` the dependencies and the app's
  files, `USER`, `WORKDIR /app`, `ENV`, `CMD start`. No `RUN` step at all.
- Phase 1 (now) uses a box-written `docker build` with one fixed install `RUN`
  line in place of the separate install container; the AI still can't choose
  any of it.
- `.flagshipignore` (and `.gitignore`) keep `node_modules`, `.git`, `.env*`
  out of the context.

### 6.3 What the AI writes

Code, `flagship.app.json` (with `runtime.base`), `package.json` (and its lock)
/ `requirements.txt`, `migrations/*.sql`, optional `seed.sql`. Never a build
file (`Dockerfile`, `Containerfile`, `.dockerignore` at the app's root:
`isBuildFilePath`):

- every AI write goes through `BuildWorkspace.write`, which refuses them (the
  build agent's tools, git-import adaptation, IDE/MCP sessions);
- a chat's files are all the model's, so a chat must name `runtime.base` and
  any build file it emits is dropped;
- `validate` passes a manifest without `runtime.base` only when the workspace
  holds a Dockerfile, which can then only be the imported repo's own (tier 3,
  unchanged by the AI);
- a published repo adapter (an AI's changes, replayed on other boxes) can't add
  or change a build file (`repoAdapterProblems`);
- for a runtime app, `runDockerBuild` replaces whatever build file the context
  holds with the box's own (`runtimes/buildContext.ts`).

## 7. The app bundle

What an app *is*, for copies and the marketplace:

```
flagship.app.json     runtime, port, stores, access
app/                  the app's files + installed dependencies
migrations/*.sql      the schema, applied in order
seed.sql.gz           optional starter data (marketplace: never user data)
```

`app/` is content-hashed (SHA-256 over a sorted tar). The box assembles the
image from the runtime and `app/` with no network beyond pulling the runtime,
so what was hashed (and, in the marketplace, reviewed) is what runs.

## 8. Copies

A copy of a runtime app sends the bundle (`app/` gzipped, a few MB) instead of
`docker save`; the target pulls the runtime by digest if it lacks it and
assembles the same image. Data travels as today (Postgres dump, files
archive). Tier 3 keeps `docker save`. Wire: a new part `bundle` replaces
`image` when the manifest has `runtime.base`; a target that doesn't know it is
refused with "update this server first" (no compatibility needed yet).

## 9. Phases

1. **Done 2026-10-12**: catalog (`node-24`, `python-3.13`, `static`;
   `runtimes/catalog.ts`); manifest `runtime.base`/`start`/`root`; box-written
   build (`runtimes/buildFile.ts`); AI prompts and contract without
   Dockerfiles, and AI writes of build files refused; runtime apps run as the
   runtime's unprivileged `USER` (baked into the box's build; `--user` for
   tier 3 comes with phase 7); `enable_icc=false` on every sandbox bridge.
2. **Built 2026-10-12**: gVisor for every app and staging copy
   (`appSandbox/`). Release `20260921.0`'s `gvisor.tar.zstd` (both arches) is
   pinned by SHA-512, downloaded once into `/usr/local/lib/flagship-gvisor/`
   (zstd installed when missing), re-hashed every boot, registered in
   `/etc/docker/daemon.json` (other settings kept) with a `systemctl reload
   docker`, and proved with a locked-down `--runtime=runsc` container of the
   pinned helper image, run with an app's limits (and, if that fails under
   docker's systemd cgroup driver, again with `--systemd-cgroup`). Boot doesn't wait for it; `docker run` of an app does,
   and refuses without it (retried every 10 minutes; apps restart once it
   works). Server detail reports `appSandbox`; the server page warns while
   apps can't start. Helper containers (files archive, staging listing) and
   the data services stay on runc: pinned images that run no app code.
   Build `RUN` steps still use runc until phase 3.
3. Install in a locked-down container; COPY-only assembly; bundle hashing.
4. Copies send bundles (§8); runtime prefetch and pruning.
5. **Built 2026-10-16**: disk quotas (§5.3): files images, database write
   limits, the disk brake, staging and build limits. Postgres role limits
   (connections, timeouts) still to do.
6. Vetted packages (tier 2).
7. Tier 3 behind an owner-signed import approval; marketplace review on
   `feat/marketplace`.
