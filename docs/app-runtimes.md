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

- Files folder: `data.stores.files.quota` (default 2 GiB, owner can raise),
  enforced with ext4 project quotas on `/var/lib/docker/volumes` (the box's
  data filesystem is ext4; `prjquota` mount option added by the installer and
  the update).
- `/tmp`: tmpfs, 64 MB (today).
- Postgres, per app role: `CONNECTION LIMIT 20`, `statement_timeout 30s`,
  `idle_in_transaction_session_timeout 60s`, `temp_file_limit 1GB`. Database
  size has no native limit: the box measures it with `pg_database_size` every
  10 minutes and, over the app's quota, revokes the role's write privileges until
  the owner raises it or the app shrinks.

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

Exactly one of `base` (tiers 1–2) or `image` (tier 3). `start` is the command
(argv, no shell); default for `node-24` is `npm start` when package.json has a
`start` script, for `python-3.13` none (required); `static` takes none and
`root` (the folder to serve, default `.`).

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

Code, `flagship.app.json` (with `runtime.base`), `package-lock.json` /
`requirements.txt`, `migrations/*.sql`, optional `seed.sql`. Never a
Dockerfile: `validate` rejects one in a runtime app, and the contract and
prompts stop asking for it.

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

1. **Now**: catalog (`node-24`, `python-3.13`, `static`); manifest
   `runtime.base`/`start`; box-written build; AI contract without Dockerfiles;
   non-root `--user` for runtime apps; `enable_icc=false` (done).
2. gVisor for every app (`runsc` install + `--runtime=runsc`, fail closed).
3. Install in a locked-down container; COPY-only assembly; bundle hashing.
4. Copies send bundles (§8); runtime prefetch and pruning.
5. Disk quotas and Postgres role limits (§5.3).
6. Vetted packages (tier 2).
7. Tier 3 behind an owner-signed import approval; marketplace review on
   `feat/marketplace`.
