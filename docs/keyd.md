# flagship-keyd

The box's long-lived secret keys live in their own process, not in the Node daemon
(`SECURITY-HARDENING-PLAN.md` 5.1, key classes 5.2).

| Key | Where | What the daemon can do with it |
|---|---|---|
| Box identity (STK) | `/var/lib/flagship-keyd/identity.key`, 0400, user `flagship-keyd` | sign messages whose purpose is on the box's list (`packages/keyd/src/policy.ts`); open blobs sealed to the box |
| Workload key (SWK) | `swk.key` beside it | derive subkeys with a fixed set of labels; seal/open/chunk operations |
| Gossip key (CGK) | `cgk.key` beside it | seal/open gossip, MAC a gossip announcement (nothing else); derive the app-copy env key and the one-list access-sync key |

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
- Tier-2 shared service certificates (`<service>.<user>` names whose key is sent between the
  account's boxes) are not issued while TLS runs through keyd: a key that never leaves one box
  cannot be replicated. They return with the shared-key design in plan 9.4.
- The SWK subkeys keyd derives (chunk, LLM, TLS-at-rest, manifest, peer-backup, app-secret
  labels) are returned to the daemon, as they are needed there today. The root workload key
  is not.

## TLS and Let's Encrypt (plan Phase 3)

```
daemon  --(order names)-->  KeydAcmeIssuer  --(sign by request kind)-->  keyd (ACME account key)
                                  |                                      keyd (TLS leaf key, CSR)
                                  +--> Let's Encrypt (DNS-01 via .com)
tunnel --> flagship-tlsd (Go, no key) --tls.sign--> keyd        decrypted --> daemon (Unix socket)
```

- keyd makes the TLS leaf key (P-256), the CSR for exactly the names the key was made for, and
  signs TLS handshake digests only once a certificate for that key is installed. The names a box
  may have (`<server>` and `*.<server>`) come from its own recipe through the migration step,
  never from a request. `tls.active` is what flagship-tlsd serves; a renewal is `tls.install`
  then `tls.activate`, picked up within seconds with no dropped connections.
- keyd holds the per-box ACME account key and builds each signed request itself, by kind
  (`newAccount`, `newOrder`, `postAsGet`, `challenge`, `finalize`, `revoke`): only to Let's
  Encrypt hosts over https, only for the box's names, only with a CSR keyd made, only to revoke
  the box's own certificates. The ACME client in the daemon (`acme/keydAcme.ts`) does the
  protocol and never sees a key.
- `flagship-tlsd` (`installer/tls-frontend`, Go standard library only) is a `crypto.Signer`
  whose signing is a keyd request. TLS 1.2+, `http/1.1`, `acme-tls/1` is not negotiated, and it
  serves only names the certificate covers. It listens on loopback for the tunnel and hands the
  daemon decrypted connections on `/run/flagship-tls/upstream.sock` behind one JSON header line.
- DNS-01 only in this mode (TLS-ALPN-01 would need a second key inside the frontend).
- Upgrade: keyd's migration takes over the box's existing certificate and key as a *legacy*
  key so serving never stops, the daemon orders a fresh keyd-made key at once, switches, and
  keyd removes the legacy key. The PEM key file and the old account key are deleted when the
  daemon first starts in this mode. Overwriting flash cannot be proven; the LUKS disk and the
  key rotation are the durable protection (plan 6.4).
- Units: `installer/verify-keyd-unit.sh` and `--tlsd` check both against `systemctl show`.
