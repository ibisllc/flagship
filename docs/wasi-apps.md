# WebAssembly (WASI) apps

Status: built for release 0.3 (IMPLEMENTATION-PLAN.md §8.5, work package P04). Tested on a Mac
(Rust worker, daemon units over fakes) and designed to be drilled on a Debian 13 VM
(`docs/architecture-v2/drills/m7-runtime.md`) and the live gym (`wasi-apps`). Not yet run on a box.

A WASI app is an app like any other: it is installed by the owner's signed order, reached at its
address through the relay and the app proxy, gets the same identity headers, keeps its data in the
same quota-backed files folder, is held to the owner's egress list, is backed up, updated and
uninstalled the same way. Only its process differs: a `flagship-wasi@<instance>` systemd unit
running the Rust worker (`rust/crates/flagship-wasi`) instead of a gVisor container, so Docker and
Podman boxes run it the same way.

## Manifest

Schema 2 (`packages/protocol/src/manifestV2.ts`):

```json
{
  "schema_version": 2,
  "name": "notes",
  "version": "1.0.0",
  "runtime": { "kind": "wasi", "module": "dist/app.wasm", "world": "http-proxy", "port": 8080 },
  "data": { "stores": { "files": true, "postgres": true } },
  "network": { "subdomain": "notes", "egress": ["api.example.com"] },
  "resources": { "memoryMiB": 64, "cpuMillis": 500, "pids": 256 },
  "access": { "enabled": true },
  "migration": { "verification": "standard" }
}
```

- `module`: a WebAssembly **core module** for **WASI preview 1** (`wasm32-wasip1`), inside the
  app. Components and precompiled native code are refused.
- `world`: `http-proxy` (an HTTP app, below) or `command` (runs `_start` once; restart policy
  `restart`).
- The deploy pipeline stores the module by content digest and puts `runtime.digest`
  (`sha256:…`) in the install order it signs, so the order names the exact code that runs; an
  install without it is refused. A box without the pinned worker refuses WASI apps with "This
  server cannot run WebAssembly apps yet."
- `resources.memoryMiB` is the per-request linear-memory limit (≤ 1024); the unit's cgroup gets
  four times that plus 128 MiB.

## The `http-proxy` world (Flagship CGI profile, `flagship/wasi-http/v1`)

Preview 1 has no sockets and no HTTP interface, so one request is one run of `_start`, with a fresh
instance (nothing in memory survives between requests; keep state in `/data` or the database):

- request line and headers arrive as CGI/1.1 variables (RFC 3875): `REQUEST_METHOD`, `PATH_INFO`,
  `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `HTTP_*` (hop-by-hop headers and `Proxy` are
  dropped). The proxy's identity headers arrive as `HTTP_X_FLAGSHIP_VISITOR`, `…_USER`, `…_ROLE`.
- the body is on stdin;
- the answer is a CGI response on stdout: header lines (`Status: 201 Created`, `Content-Type: …`),
  a blank line, the body. The worker frames it (`Content-Length`, `Connection: close`) and refuses
  bad header lines.

Per request, the worker enforces a fuel budget, a wall-clock deadline (which also cancels a host
call), the memory and table limits, and a bound on concurrent runs; past one the answer is a 503
("The app ran out of fuel/wall-time/memory on this request.") and the app keeps serving. The HTTP
front is strict: origin-form targets only, no obsolete folding, one framing, bounded head and body.

Platform variables: `FLAGSHIP_APP_ID`, `FLAGSHIP_CREATOR`, `FLAGSHIP_SLUG`, `FLAGSHIP_HOST`, and
`FLAGSHIP_FILES_DIR=/data` with files. The owner's env reaches the worker over its socket at start,
never in a file. Database URLs and the daemon API token are never given to a WASI guest.

## Capability SDK (host calls)

A guest may import functions from the `flagship_v1` module, each behind a manifest capability. A
module importing one its manifest doesn't declare is refused before it runs ("module imports
flagship_v1.db_query, and its manifest does not declare data.stores.postgres").

| Call | Capability | What the box does |
|---|---|---|
| `http_fetch(req, req_len, out, out_cap, out_len) -> status` | `network.egress` | An HTTP(S) request to a declared host, made by the daemon, only if the owner's signed access list allows it (an unlisted declared host raises the same access request as a container's). Public addresses only, checked at connect time; no redirects; 1 MiB request body, 4 MiB answer. |
| `db_query(...)` | `data.stores.postgres` | One SQL statement (`$1…` params) on one of the app's own databases, as the app's own role, 30 s timeout, 1000 rows. |
| `last_response(out, out_cap, out_len) -> status` | either | The full answer when `out_cap` was too small. |

Requests and answers are JSON; status `0` ok, `1` denied, `2` bad request, `3` failed, `4` timed out.
The worker checks the declaration and the host itself; the daemon checks again behind a Unix socket
in the app's own folder (`wasi/broker.ts`), so which app is asking is the socket, not the guest's
word. At most 256 host calls per run.

The Rust SDK is `rust/wasi-sdk` (no dependencies): `Request::from_env()`, `Response::…send()`,
`host::http_fetch`, `host::db_query`. `rust/wasi-sdk/examples/` are the fixture apps the tests and
the gym install; `rust/wasi-sdk/build-fixtures.sh` rebuilds them (`rustup target add
wasm32-wasip1`), and a test checks the committed `.wasm` against `FIXTURES.sha256`.

## The worker's fences (`wasi/unit.ts`)

One unit per app, from the template `/etc/systemd/system/flagship-wasi@.service`, instance = 16 hex
of a hash of the service id:

- its own dynamic user, no capabilities, `NoNewPrivileges`, `ProtectSystem=strict`, private
  `/tmp`, devices and IPC, namespaces and real-time refused, a system-call allow list;
- an empty `/var` with only its folder (`/var/app/pkg`: config, module, socket, read-only) and its
  files folder (`/var/app/data`); the daemon's, broker's, keyd's and engine's sockets inaccessible;
- `IPAddressDeny=any`, `IPAddressAllow=localhost`: it can only listen for the proxy;
- its cgroup's memory (no swap), task and CPU limits; restart on failure.

`MemoryDenyWriteExecute` is off for the worker alone: Cranelift maps the code it compiled. The
worker never loads native code it didn't compile (`Module::deserialize` is `unsafe`, and the crate
forbids `unsafe`), keeps compiled code only in its own memory, and a compiled module is bound to one
app id, one digest and one engine. Errors carry no host paths.

The worker binary ships in the signed box artifact (`installer/rust/flagship-wasi-worker`, pinned in
`PINS.json`); the daemon installs it to `/usr/local/lib/flagship-wasi/` only when its SHA-256
matches (`wasi/install.ts`). Without systemd, the pin or the binary, WASI is unavailable and says why.

## Lifecycle, backups, owner surface

- install/update/restore/uninstall go through `ServicePlatform` like any app (`appRuntimes.ts`
  routes by kind); an update can change the module; the start check waits for the worker to answer
  and reports its last log lines when it doesn't; uninstall removes the unit's folder.
- backups hold the worker still with the cgroup freezer while the files folder and databases are
  read; whole-server backups carry the module itself (`module.wasm`, checked against the digest on
  restore).
- `POST /api/wasi/modules` (owner session) stores a module so a signed install can name it;
  `GET /api/wasi/status`; `GET /api/app-runtime/<serviceId>` says how an app runs.

## Not supported yet

The component model and WASI preview 2/3 (`wasi:http/proxy` components); AI-built WASI apps (the
AI's test copy is a container); app copies of a WASI app between servers; the unprivileged daemon
(privd must allow `systemctl start|stop|reset-failed|show|freeze|thaw flagship-wasi@*.service`,
`daemon-reload`, and writing the template and the `/run/systemd/system` drop-ins).
