# flagship-keyd

The box's long-lived secret keys live in their own process, not in the Node daemon
(`SECURITY-HARDENING-PLAN.md` 5.1, key classes 5.2).

| Key | Where | What the daemon can do with it |
|---|---|---|
| Box identity (STK) | `/var/lib/flagship-keyd/identity.key`, 0400, user `flagship-keyd` | sign messages whose purpose is on the box's list (`packages/keyd/src/policy.ts`); open blobs sealed to the box |
| Workload key (SWK) | `swk.key` beside it | derive subkeys with a fixed set of labels; seal/open/chunk operations |
| Gossip key (CGK) | `cgk.key` beside it | seal/open gossip; derive the app-copy env key |

## How it is wired

- `flagship-keyd.service` (`packages/keyd/src/unit.ts`) runs as its own user with the maximum
  compatible systemd sandbox: no network (`AF_UNIX` only), no devices, no capabilities, no
  core dumps, memory that cannot be both writable and executable, a syscall filter.
  `installer/verify-keyd-unit.sh` checks the effective properties on the appliance.
- The daemon talks to it over `/run/flagship-keyd/keyd.sock` (group `flagship-keyd-clients`).
  The protocol (`packages/keyd/src/wire.ts`) is length-prefixed JSON, version 1, strict sizes,
  `hello` first, fails closed on any other version.
- Code written for `Keypair` / `swk: Bytes` keeps working: the daemon hands it an *opaque*
  stand-in (`packages/protocol/src/opaqueKey.ts`). `ed.sign`, `ed.getPublicKey`,
  `openSealedFromEd25519Recipient` and the SWK HKDF helpers route to keyd; any other use of the
  bytes throws, so a path that tries to read the key fails loudly.
- keyd never signs untagged bytes. A message must start with a purpose on the list; the
  boot-suspension and boot-auth purposes also carry their own rules (the box may only
  suspend, only as the box, only with its own key). Authority purposes (owner, admin,
  entitlement, update) are not on the list.
- Every request is rate limited per operation and written to a non-secret audit log
  (`audit.log`: time, operation, caller label, purpose, result; never a message or a key).

## Migration

`flagship-keyd migrate` (run by `ExecStartPre=+` on every start) moves
`/var/flagship/identity/identity.priv.hex`, `swk.hex` and `cgk.hex` into the keyd directory,
verifies each, removes the readable copy and strips the identity from
`/etc/flagship/daemon.env` and `/etc/flagship-bootstrap.env`. A daemon that finds no keyd
installs it (`keydInstall.ts`) and restarts. A box with keyd refuses to fall back to
in-process keys once its files have moved (they are no longer there).

## What this does not do (read before you rely on it)

- It is a **software** boundary. The daemon still runs as root today, and root can read
  another process's memory and its sandbox-free files. The boundary becomes real when the
  daemon runs unprivileged (plan Phase 1) and when keyd's key is hardware-sealed (Phase 4).
- Node cannot read `SO_PEERCRED`, so keyd authenticates callers by who can open the socket
  (directory and socket permissions), not by peer credentials. A native helper would add that.
- Node cannot lock pages out of swap. Mitigations: no core dumps, small key lifetime in
  memory (zeroed on shutdown), and encrypted swap on the appliance.
- TLS private keys are not in keyd yet (plan Phase 3).
- The SWK subkeys keyd derives (chunk, LLM, TLS-at-rest, manifest, peer-backup, app-secret
  labels) are returned to the daemon, as they are needed there today. The root workload key
  is not.
