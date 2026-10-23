# Broker, runtime adapter and core reconciler (B01, R01, R02)

Status: built and tested as libraries on branch `arch/broker`. Nothing is switched on, no unit
installs them and no TypeScript behaviour changed. This page is the contract the next packages
build against and the list of what must be true before a handover.

| Crate | Package | Runs as | Holds |
|---|---|---|---|
| `flagship-runtime` | R01 | library inside the broker | `ExecutionPlan`, `ResolvedWorkload`, the `Runtime` trait, Docker and Podman adapters, a containerd stub |
| `flagship-broker` | B01 | root (later: capabilities only) | privd v1 socket, typed v2 socket, capability verification, broker state DB, safe filesystem access |
| `flagship-core` | R02 | unprivileged controller user | journal DB, controller lock, reconciler, shadow mode, handover |

Tests: `cargo test -p flagship-broker -p flagship-runtime -p flagship-core` (run under
`export PATH=/opt/homebrew/opt/rustup/bin:$PATH` in `rust/`). Tests named `linux_*` are
`#[ignore]`d because they need Linux `SO_PEERCRED` or a real Docker with gVisor.

## 1. Framing (both sockets)

A frame is a 4-byte big-endian length, from 1 to 1 MiB, then that many bytes of UTF-8 JSON. It is
the same as `packages/privd/src/wire.ts`. A bad length or a body that is not JSON closes the
connection. At most 16 connections are served at once, each on its own thread, and each is
limited to 20 requests a second (the 21st is answered `slow down`).

The kernel identifies the peer before the first byte is read: `SO_PEERCRED` through
`rustix::net::sockopt::socket_peercred`. Each socket has its own allowlist of UIDs
(`PeerPolicy`). An unlisted UID is dropped without a reply and audited. Without `SO_PEERCRED`
(any non-Linux host) every connection is refused. A UID, device or app ID written in a request
grants nothing.

## 2. The v1 socket: privd, byte-compatible

`flagship_broker::privd` reimplements `packages/privd` rule for rule:

- Request `{id, op, args}`: unknown top-level fields are refused. `id` is a JSON number that
  JavaScript treats as a safe non-negative integer (`3.0` passes, `1.5` and `2^53` are refused).
  `args` that is missing or `null` becomes `{}`.
- Ops: `hello`, `power`, `systemd.restart`, `docker`, `nft.apply`. `hello` must carry `version`
  equal to 1, or the broker answers `unsupported-version` and closes. Any other op before
  `hello` is answered `not-hello`. A connection that has not said hello within 5 s is dropped.
- The validators and their refusal messages are ported exactly (`policy.rs`). That covers the
  closed unit list, docker subcommands and sub-subcommands, the forbidden-flag list, the
  `--security-opt=no-new-privileges` allowance, the files-volume and resolver mount patterns, the
  build-context rule, compose, and the `nft` line grammar.
  JavaScript semantics they depend on are reproduced in `js.rs`: string length counts UTF-16
  units, `trim` uses ECMAScript whitespace, `split("=")[1]`, and `\b` matches an ASCII word
  boundary.
- Responses: `{"id":…,"ok":true,"result":{"stdout":…,"stderr":…}}` and
  `{"id":…,"ok":false,"code":…,"message":…}`, with keys in the order `JSON.stringify` writes
  them. A failure reads `exited with code N: <last 4 stderr lines joined by " | ", at most 600
  units>`.
- Commands run from a fixed absolute path in `PINNED_BINARIES` (`/usr/bin/docker`,
  `/usr/bin/podman`, `/usr/bin/systemctl`, `/usr/sbin/nft`). The environment holds only
  `PATH=/usr/sbin:/usr/bin:/sbin:/bin` and `LANG=C`, the working directory is `/`, no shell is
  used, and time and output are bounded (256 KiB tail).
- Audit: one JSON line per decision, `{t, op, ok, code|exit, timedOut, what}`. It never carries
  bodies: `docker` logs its first 3 argv entries and `nft.apply` logs `nft script`.

Two divergences are deliberate. Both are refusals in TS as well, with a different code:

1. A docker subcommand that names an `Object.prototype` property (`constructor`, `__proto__`,
   `toString`, …) makes TS throw a `TypeError`, answered `bad-request`. Rust answers `forbidden`
   with `docker constructor is not allowed`.
2. privd has no peer-credential check (it relies on socket group permissions). The Rust broker
   adds one.

The docker passthrough is the v1 compatibility path for the TS daemon as it is today. B01's
release criterion is to remove Docker-socket access from Node; that is met only once the TS
callers move to the typed socket and the v1 `docker` op is turned off.

## 3. The typed socket (protocol 2)

Every request is self-describing; there is no hello.

```json
{
  "protocolVersion": 2,
  "requestId": "r-17",
  "op": "StartApprovedWorkload",
  "operationRef": "core-op-1234",
  "target": { "installation": "alice--notes", "generation": 3 },
  "expectedRevision": 7,
  "deadlineUnixMs": 1800000060000,
  "payload": { "plan": { "…": "ExecutionPlan" } },
  "capability": { "…": "see 4" }
}
```

- Unknown fields anywhere in the envelope are refused, so `"approved": true` is a `bad-request`.
- `requestId` must be a token of at most 64 characters and `operationRef` one of at most 128.
- A deadline in the past is `expired`; one more than 10 minutes ahead is `bad-request`.
- Answer: `{"requestId", "ok": true, "result": {…}}` or `{"requestId", "ok": false, "code",
  "message"}`. Codes: `bad-request`, `unknown-op`, `unsupported-version`, `expired`,
  `forbidden`, `bad-signature`, `revoked`, `replayed`, `stale`, `conflict`, `unsupported`,
  `failed`, `timed-out`.

| Op | Payload | Capability subject | Scope / generation rule | Effect |
|---|---|---|---|---|
| `PrepareAppVolume` | `{volumeId}` | `sha256("flagship/app-volume/v1\|<inst>\|<volumeId>\|flagship-files-<inst>")` | app; gen ≥ admitted | registers the ID (one volume per installation, one installation per ID); opens `<files_root>/<volume>` without following symlinks; requires it to be a mounted image (`st_dev` differs from the root's); creates `data/` and fchowns/fchmods it through its descriptor; `volume create` bound to it |
| `ApplyNetworkPolicy` | `{policy}` | `NetworkPolicy::digest()` | app; gen ≥ admitted; policy names the same installation and generation | writes `<state_dir>/egress/<inst>.json` atomically (O_EXCL temp, fsync, renameat, fsync dir); records the digest as installed |
| `StartApprovedWorkload` | `{plan}` | `ExecutionPlan::digest()` | app; gen > admitted, or the same gen with the same digest | requires the installed policy digest to be the plan's, every volume ID registered to this installation and ready, every secret handle owned by it; refuses (`conflict`) if another generation's workload exists; pull by digest, create, start |
| `StopWorkload` | `{remove}` | `sha256("flagship/stop-workload/v1\|<inst>\|<gen>\|remove\|keep")` | app; gen = admitted (0 for a TS-started container) | stop; optionally delete; a workload already gone is success |
| `ActivateRelease` | `{commit, releaseDigest}` | `sha256("flagship/activate-release/v1\|<gen>\|<commit>\|<digest>")` | host; gen > admitted | writes `<state_dir>/release/active.json` atomically, then `systemctl restart flagship-daemon.service` |
| `RequestShutdown` | `{action: poweroff\|reboot}` | `sha256("flagship/request-shutdown/v1\|<action>")` | host; gen = admitted release gen | `systemctl poweroff\|reboot` |
| `AdvanceRevocationEpoch` | `{statement}` | signed epoch statement (4.3) | | moves the epoch forward, never back |
| `Describe`, `ListWorkloads` | `{}` | none (read-only) | | scope revision, admitted generation and plan, policy digest, epoch, volume; engine observations |

## 4. Authority model

### 4.1 Capability

```json
{
  "v": 1,
  "id": "<32 lowercase hex, 128 random bits>",
  "op": "start-approved-workload",
  "installation": "alice--notes",
  "generation": 3,
  "expectedPriorRevision": 7,
  "subject": "sha256:…",
  "revocationEpoch": 4,
  "notBefore": 1800000000,
  "expiresAt": 1800000300,
  "signature": { "suite": "ed25519", "keyId": "authority-1", "value": "<128 hex>" }
}
```

Signed bytes:
`flagship/broker-capability/v1|<id>|<op>|<installation or ->|<generation>|<expectedPriorRevision>|<subject>|<revocationEpoch>|<notBefore>|<expiresAt>|<suite>|<keyId>`.
The suite and key ID are inside the signed bytes, so a signature can be moved neither to another
suite nor to another key. Host operations (`activate-release`, `request-shutdown`) must name no
installation, and every app operation must name one.

Verification goes through `trait CapabilityVerifier`. `Ed25519Authority` uses `verify_strict`
over pinned keys and refuses weak keys. A hybrid Ed25519+ML-DSA verifier (from
`flagship-crypto`) plugs in under a new suite name without changing any caller.

### 4.2 Checks, in order

1. The capability has the right shape, verifies under a trusted key, is for this op, and its
   installation, generation and expected revision equal the envelope's `target` and
   `expectedRevision`.
2. The subject is the digest the broker computes itself from the payload it parsed. For a plan,
   that means the broker's own canonical bytes; the caller's digest is never used.
3. Time: `notBefore - 60 s ≤ now < expiresAt`, and the lifetime is at most 15 minutes.
4. The op's own rules (table above): generation and revision against the broker's state, the
   installed policy, volume ownership, secret ownership, and the existing workload. All of these
   run before anything is consumed, so a refused request costs the caller nothing.
5. Admission, as one `BEGIN IMMEDIATE` transaction in the broker DB:
   - if the capability's epoch is below the current epoch, refuse it as `revoked`;
   - if the capability ID is already consumed, refuse it as `replayed`;
   - if the revision is not the expected one, refuse it as `stale`;
   - otherwise consume the ID, increment the revision, raise the epoch to the capability's if
     that is higher, record the admitted generation and plan, and record the effect as
     `admitted`.
6. The effect runs. Afterwards its outcome is recorded (`ok` or `failed: …`), along with what
   only a success may record (installed policy, volume ready).

The capability is consumed before the effect runs. If the broker crashes after step 5, the
capability is spent, and a retry needs a new one issued against the new revision. That is why a
replay can never apply an effect twice. Core is built for this: it re-observes the engine first
and only asks for a new effect when the old one is not visible.

### 4.3 Revocation

`EpochStatement {epoch, issuedAt, signature}` is signed over
`flagship/revocation-epoch/v1|<epoch>|<issuedAt>|<suite>|<keyId>`. The statement is what carries
the authority, so core can relay it but cannot forge it. A capability issued under a higher
epoch also raises the broker's epoch. Core could still withhold an epoch statement; short
capability lifetimes bound that window. Making withholding detectable needs a freshness rule
(open item 4 in section 9).

### 4.4 State

`<state_dir>/broker.db` uses SQLite with WAL, `synchronous=FULL` (checked after it is set) and
`locking_mode=EXCLUSIVE`, so only one broker process holds it. Tables:

- `scopes(scope, revision, admitted_generation, admitted_plan, policy_digest)`, where `scope` is
  `app:<installation>` or `host`;
- `consumed(id, expires_at)`, pruned 24 h after expiry;
- `epoch`;
- `volumes(volume_id, installation UNIQUE, name UNIQUE, ready)`;
- `effects(at, op, scope, capability, outcome)`.

This state must stay outside app backups and rollback snapshots (plan §4.3).

### 4.5 Filesystem

`SafeDir::open_root` opens an absolute broker-owned root one component at a time with
`O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`. The root must be owned by the broker's EUID and must not be
group- or world-writable. Children are single validated components opened the same way. Changes
go through the descriptor that was validated (`fchown`, `fchmod`, `renameat`); no path is
resolved a second time. Atomic writes use an `O_EXCL|O_NOFOLLOW` temp file.

## 5. ExecutionPlan and the Docker/Podman argv

`ExecutionPlan` (camelCase JSON, `deny_unknown_fields`, schema 1) holds:

- `installation` and `generation`;
- `image {repository, indexDigest, platformManifestDigest, platform}`;
- `manifestDigest`;
- `capabilities {network: apps|none, publish?, linuxCapabilities: [NET_BIND_SERVICE]?}`;
- `resources {memoryBytes, cpuMillis, pidsLimit, tmpfsBytes}`;
- `volumes [{id, readOnly}]` (at most one, mounted at `/data`);
- `networkPolicyDigest`;
- `environment`, which refuses duplicate keys;
- `secrets [{env, handle}]`;
- `health` (`http` or `none`);
- `restart` (`never` or `on-failure`);
- `deviceClaim?`.

The plan cannot express privileged mode, host namespaces, devices, a command line, mounts or
hooks. On top of that, a key that would ask for one (`privileged`, `command`/`entrypoint`/`args`,
`mounts`/`binds`/`hostPath`, `hooks`, `devices`/`cdi`, `pid`/`ipc`/`uts`/`userns`/`networkMode`,
`capAdd`, `securityOpt`, `sysctls`, `runtime`, `user`, …), anywhere outside `environment`, is
refused by name, and so is `network: "host"`. A device claim parses but the adapter answers
`unsupported` until the G02 claim journal exists.

The canonical bytes are
`flagship/execution-plan/v1|installation=…|generation=…|image.repository=…|image.index=…|image.manifest=…|image.platform=linux/<arch>|manifest=…|caps.network=…|caps.publish=…|caps.linux=…|res.memory=…|res.cpu=…|res.pids=…|res.tmpfs=…|volumes=…|netpolicy=…|env=NAME=<hex value>,…|secrets=NAME=handle,…|health=…|restart=…|device=…`.
Every field is present, lists are sorted, free-form values are hex, and no validated value can
contain `|`, `,` or `=`. The digest is the SHA-256 of those bytes.

`create_argv` is compared against fixtures of what `AppRunner.deploy` generates
(`crates/flagship-runtime/tests/fixtures/`). Two cases are covered: gVisor plus the egress
gateway, and the no-gateway path with overridden limits. After removing the deltas below, the
argv is identical, in the same order:

- `--runtime=runsc`;
- `--cap-drop=ALL`;
- `--security-opt=no-new-privileges`;
- `--network flagship-apps`;
- with the egress gateway: `--dns <gw>`, `--add-host host.flagship.internal:<gw>` and the
  resolver mount; without it: `--add-host host.flagship.internal:host-gateway`;
- `--memory`, `--cpus`, `--pids-limit`, then `--cap-add` for each re-added capability;
- `--read-only --tmpfs /tmp:rw,size=…`;
- `-e K=V`;
- `-p 127.0.0.1:<host>:<container>`;
- the files-volume mount.

The deliberate deltas:

- `create` then `start` instead of `run -d`, so each step is a journalled effect;
- `--label flagship.installation=…`, `flagship.generation=…` and `flagship.plan=sha256:…`;
- `--pull=never`, because images are fetched only by `prepare_image`, by digest;
- the image is `repository@<platform manifest digest>`;
- the read-only root is always on, where TS lets an operator turn it off;
- memory is written in MiB (`2048m` where TS passes `2g` through).

The workload is still named `flagship-<installation>`, so the engine itself refuses a second
copy, and containers the TS controller started are recognised by name.

Podman uses the same argv with `/usr/bin/podman`. Its `info` reports only the default OCI
runtime, so `runsc` counts as present only when it is the default. `host-gateway` needs Podman
5.3 or later. containerd answers `Unsupported` for everything until R03 picks an engine.

## 6. Core

- **Lock.** `<dir>/controller.lock` is held with a non-blocking exclusive `flock`, opened with
  `O_NOFOLLOW`. Each `Journal::open` also takes the next term, and every write transaction checks
  it. A writer that bypassed the lock gets `Fenced` (tested).
- **Journal.** `<dir>/journal.db` uses WAL with `synchronous=FULL`, checked after it is set.
  Tables:
  - `desired`: plan JSON plus digest, checked again on every read;
  - `ops(kind pull|create|start|stop|delete, state intent|done|failed|abandoned|needs-review, runtime_id, term)`;
  - `adopted`: legacy containers;
  - `checkpoints`;
  - `shadow`: shadow-mode decisions;
  - `meta`: term and `effects_enabled`.
- **Reconcile.** The controller observes the engine (labels and generation), settles intents
  left by an earlier life, then closes the gap one effect at a time. Each effect writes its
  intent first, makes the call, then writes what came back. After a crash an intent is settled
  this way:

  | Intent | After the crash |
  |---|---|
  | `pull`, `start` | Abandoned and decided again. |
  | `create` | Done if a workload labelled with that plan digest exists, otherwise abandoned. Create is name-unique, so redoing it never makes a second copy. |
  | `stop` | Done if the workload is gone or not running, otherwise `needs-review`. |
  | `delete` | Done if the workload is gone, otherwise `needs-review`. |

  A `needs-review` op blocks its installation and is never retried on its own;
  `resolve_review(op, AlreadyDone|Redo)` unblocks it. The same applies to a destructive effect
  that returned a timeout or a lost connection.

  An upgrade is stop, delete, pull, create, start. Removing an installation from `desired`
  stops and deletes its labelled workload. Unlabelled `flagship-*` containers that are not
  desired are reported as `unmanaged` and left alone.
- **Crash tests.** The fake engine panics before or after each mutating call. The tests drop the
  controller, reopen it and converge, for every boundary of a fresh install, an upgrade and an
  uninstall. They assert:
  - exactly one workload in the end;
  - zero name conflicts;
  - exactly one create of the new generation;
  - exactly one delete of the old generation;
  - a destructive effect cut off before it ran is blocked for review, with no engine call in the
    meantime.
- **Shadow mode** records decisions and makes no mutating call and no intent, even with
  `effects_enabled` set. In `Effects` mode, effects stay off until a handover enables them.
- **Handover** (`Controller::handover(TsCheckpoint)`) runs only while the controller lock is
  held. It requires `tsControllerPaused`. It records the checkpoint, observes the engine, and
  requires every listed workload to exist with the same running state, image and generation
  (label, or desired generation for a legacy container), and every observed workload to be
  listed. Unlabelled containers are recorded as adopted. Effects are enabled only if nothing
  differed; any mismatch leaves them off and is reported. An adopted container keeps running
  untouched until its desired generation changes (tested).

## 7. What still runs in TypeScript

All of it, in production. The daemon still calls `docker` itself (or through privd v1) and keeps
everything its `AppRunner`, `appSandbox` and `egress` code does today:

- the gVisor install and probe;
- the egress gateway, including the DNS gateway, the resolver files and the per-container IP
  view;
- the loop-image files volumes: mkfs, mount, resize, ballast and immutable mount points;
- the data services and Postgres roles;
- builds and the Dockerfile policy;
- update application and rollback;
- the start check;
- app copies, backups and restores.

The broker's `ApplyNetworkPolicy` writes the approved policy where the gateway can read it; the
TS gateway remains the enforcer. `PrepareAppVolume` needs the image already mounted by TS.
`ActivateRelease` records the pointer and restarts the unit, while the endorsed-release
verification and tree swap stay in `applyEndorsedUpdate`.

## 8. Known gaps in this slice

- No binary or systemd unit for the Rust broker or core, and no production `SecretStore`,
  `SandboxNetwork` or capability issuer. The security authority (keyd/N07) must mint short-lived
  capabilities from durable approvals.
- Core's production effect port, a client of the typed socket that fetches capabilities from the
  authority, is not written. `RuntimePort` drives an adapter directly; it serves tests and shadow
  comparisons and refuses plans with secrets.
- Env values (secrets included) are passed as `-e K=V` argv, as today, so they show in the docker
  CLI's `/proc/<pid>/cmdline` while it runs. Moving them to a stdin `--env-file` breaks
  multi-line values; this needs a decision.
- `prepare_image` trusts the engine's content addressing for the platform manifest. Checking
  that the manifest belongs to the signed index is P01's admission.
- Request deadlines are checked on arrival, not enforced in the middle of an effect.
- Podman's argv and output parsing are unit-tested only. No Linux, Docker or Podman run has
  happened, and neither has a root run of `fchown` or a mount check.
- Transitive dependency versions in `Cargo.lock` were not individually held to the two-week rule.
  Direct dependencies were: serde 1.0.229, serde_json 1.0.151, sha2 0.11.0, ed25519-dalek 3.0.0,
  rusqlite 0.40.2 (bundled), rustix 1.1.5, regex 1.13.0 and thiserror 2.0.20. `cargo deny` has
  not been run.

## 9. Before a handover is safe

1. The capability issuer exists, with key custody in keyd, minting from durable owner approvals.
   Its revocation epochs are persisted, and core cannot reach its signing key.
2. Core's typed-socket port is written, and the shadow run on real boxes shows Rust's decisions
   equal to what the TS controller did over a soak period.
3. The TS controller honours `controller.lock` (or is stopped by the unit ordering) and writes the
   `TsCheckpoint`, so two writers can never coexist. The fallback to the TS controller or to
   restricted management is drilled.
4. A freshness rule for revocation: the broker refuses effects if its newest epoch statement is
   older than N minutes, so a core that withholds epochs is caught.
5. The v1 `docker` op is turned off for the daemon's UID once its callers are migrated (the B01
   release criterion).
6. Run the `linux_*` tests and a gym run of the full app lifecycle against the Docker adapter
   with gVisor, the egress gateway and loop volumes. Then measure crash and reconcile against the
   30 s budget.
7. The broker and core units get systemd hardening and seccomp, and the effective properties are
   tested on the appliance, not just the unit text.

## 10. For security review

- **Capability shape and signed bytes (4.1).** Suite and key ID are inside the signature, and the
  maximum lifetime is 15 minutes with 60 s of skew.
- **Consume before effect (4.2).** It favours "never twice" over "never lost", which costs a
  fresh capability after a crash.
- **Epoch handling.** A signed capability raises the epoch; withholding is open (9.4).
- **`StopWorkload` at generation 0.** It may stop an unlabelled `flagship-<installation>`
  container (needed for handover). The name is derived from the validated installation ID, so it
  cannot reach another app.
- **Volume binding.** The broker derives the volume name from the installation; the caller
  supplies only an opaque ID, which the broker binds one-to-one.
- **Env values in argv**, as today (section 8).
- **`docker` passthrough on v1 for compatibility.** It is no safer than privd and must be retired
  (9.5).
