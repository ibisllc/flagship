# Cloud-init direct provisioning (W13)

## Problem statement

W11/W12's `admin-snapshot-now` flow boots Hetzner in rescue mode, then
uses cloud-init in rescue to `wget` a custom Debian-netinst ISO + our
trailer, `dd` them onto `/dev/sda`, then reboot. The VM is supposed to
boot into the custom d-i + preseed which runs `late-command.sh` to
clone the repo, set up LUKS rotation, write systemd units, and POST to
`/api/server/register`. **The late-command's POSTs never reach `.com`**,
and the d-i side is opaque: no shell, no usable logs without serial
console access. After 90+ minutes the failure mode is still unknown —
could be d-i network config not coming up, preseed not running our
late_command, the trailer not parseable inside d-i's chroot, or a
hundred other things.

This doc designs **W13 — `admin-cloud-init-now`**: an alternative path
that skips the custom ISO entirely. Hetzner boots one of its own
well-tested `debian-12` images already-running cloud-init. The Worker
hands cloud-init a `user_data` script that does the same work the
late-command was supposed to do, but in a CLEAN Debian environment
with full network access — no partman, no preseed, no trailer parsing,
no d-i chroot mysteries.

## The new flow

```
phone (operator)                Worker (.com)              Hetzner             VPS (debian-12)
─────────────────                ─────────────              ───────             ───────────────
admin-cloud-init-now  ──►
                                derive userIrk / delegated / rck
                                mint AuthCode + InstallBlob (sign)
                                persist auth-code + build-ticket
                                (re-)mint primary device grant
                                build cloud-init user_data:
                                  - install-blob.json INLINED as
                                    base64 (no trailer, no R2)
                                  - apt install …
                                  - git clone /opt/flagship @ ref
                                  - npm ci + tsc -b
                                  - gen-identity
                                  - write systemd units
                                  - flagship-first-boot-register
                                POST /servers
                                {  image: "debian-12",
                                   user_data: <yaml>,
                                   labels: { flagship-demo:<u> } }
                                                       ──►
                                                                            cloud-init runs
                                                                            user_data at first boot
                                                                            -> apt install …
                                                                            -> git clone
                                                                            -> npm ci
                                                                            -> gen-identity
                                                                            -> /opt/flagship/.../install-blob.json
                                                                            -> systemd units
                                                                            -> flagship-first-boot-register
                                                                              POST /api/server/register
                                                                            -> POST /sealed-luks-key
                                                                            -> daemonStatus heartbeat
                                ◄─────────────────────────────────────────────  daemon registers
                                cron poller sees the row come 'up'
                                snapshots + destroys the temp VPS as before
```

### Key differences from W11

|                                 | W11 (admin-snapshot-now)            | W13 (admin-cloud-init-now)               |
| ------------------------------- | ----------------------------------- | ---------------------------------------- |
| Hetzner image                   | `ubuntu-22.04` in rescue mode       | `debian-12` (booted as-is)               |
| ISO involved                    | Custom Debian-12-netinst + trailer  | None                                     |
| Trailer used?                   | Yes (parsed by d-i late-command)    | No (install-blob inlined as base64)      |
| Where install ticket flows      | Trailer in R2 → wget → parse        | base64 in cloud-init user_data           |
| LUKS root                       | d-i atomic-LVM recipe + rotation    | (see "LUKS trade-off discussion" below)  |
| Boot count to register          | 2 (rescue → installed)              | 1 (debian-12 boots, cloud-init runs)     |
| Failure surface                 | d-i + preseed + late-command        | Just bash + apt + git + npm              |
| Debug story                     | Need serial console                 | `journalctl -u cloud-init` + ssh-key opt |

## Cloud-init user_data shape

The Worker hands Hetzner a single YAML file:

```yaml
#cloud-config
write_files:
  - path: /var/flagship/install-blob.json
    permissions: '0600'
    encoding: b64
    content: <base64(installBlobJsonShort)>
runcmd:
  - [ /bin/bash, /var/lib/cloud/instance/scripts/flagship-bootstrap.sh ]
```

…and `flagship-bootstrap.sh` is the heavy-lifter (embedded via a
second `write_files` entry). The script:

1. `apt-get update && apt-get install -y git curl jq nodejs npm
   ca-certificates docker.io docker-compose-v2 cryptsetup lvm2 xxd`
2. `git clone --depth 50 --branch <ref> https://github.com/ibisllc/flagship.git /opt/flagship`
3. `cd /opt/flagship && npm ci --omit=optional && npx tsc -b`
4. Generate the server identity via
   `npx tsx scripts/install-helper.ts gen-identity`
5. Write the three systemd units (`flagship-data-services`,
   `flagship-boot-stage`, `flagship-daemon`) — same shapes as the d-i
   late-command writes today.
6. Write `flagship-first-boot-register.service` that POSTs to
   `/api/server/register` and uploads the sealed-LUKS-key.
7. `systemctl daemon-reload && systemctl enable --now …`.

The script is byte-for-byte mirrored from `installer-netboot/late-command.sh`,
but it runs in a real Debian rootfs at first boot instead of in d-i's
post-install chroot, so the failure modes are far more diagnosable.

The whole user_data is plain UTF-8 ≤ 16 KB (Hetzner's hard limit is
~64 KB). Pre-computed by the Worker; no R2 round-trip needed.

## LUKS trade-off discussion

The original design encrypts root with a phone-delegated unlock key.
With a pre-built `debian-12` image, the root filesystem is already
unencrypted. Three options:

### (a) Skip LUKS for now — DEMO ONLY [recommended for W13 demo path]

The first-boot script generates a random 64-byte file at
`/var/flagship/luks.key`, seals it for the phone (so the contract with
`.com`/`sealed-luks-key` is preserved), but does NOT mount anything
behind it. The data-services compose stack lives on the unencrypted
root.

**Pros:**
- Zero install-time complexity. Works on every Hetzner image.
- The cloud demo path is ephemeral anyway: the VPS gets snapshotted and
  destroyed within minutes. Disk-at-rest encryption is irrelevant.

**Cons:**
- Doesn't match the home-server threat model (a stolen disk reads as
  plaintext).
- The sealed-key story becomes ceremonial — the key gates nothing.

### (b) Attach + LUKS-encrypt a SECOND volume

`POST /servers` with a `volumes:[...]` array. The first-boot script
creates a LUKS container on `/dev/sdb`, mounts it at
`/var/flagship/data`, points the data-services compose stack at it.

**Pros:**
- Real LUKS-encrypted data without re-keying root.
- Phone-mediated unlock pattern stays meaningful.

**Cons:**
- +1 Hetzner volume per server = ~€0.04/mo extra (negligible).
- Snapshot semantics: Hetzner snapshots are root-disk only; the volume
  isn't part of the image. For our demo flow this is fine — the
  snapshot captures the OS + the cloned repo + the systemd units, then
  per-user state on `/dev/sdb` is empty at re-provision time anyway.
- First boot is +30s for the LUKS format + filesystem create.

### (c) Full disk re-key via rescue (back to W11)

Skip — defeats the entire purpose.

### Decision

**Ship (a) for the W13 demo path.** The first-boot script generates
the LUKS key, seals it, posts it — but `/var/flagship/data` lives on
the unencrypted root. (b) is the right *production* answer; we'll do
it as a follow-up when the demo path is green end-to-end. The
contract surface stays the same in both: `sealed-luks-key` is uploaded
either way, so swapping (a)→(b) is a script change in one file.

## Migration plan

`admin-cloud-init-now` and `admin-snapshot-now` BOTH live on the
Worker. The operator picks per-request via the endpoint:

- `POST /api/dev/sample-user/<u>/admin-snapshot-now`  → W11/W12 ISO+dd
- `POST /api/dev/sample-user/<u>/admin-cloud-init-now` → W13 cloud-init

The two endpoints share `handleAdminClaimAndIssue` as the prerequisite
(both need the usernames row + IRK derivation). The D1
`demo_users.state` machine is identical (`none → provisioning → up`),
so the 10-minute cron poller picks up either path uniformly.

The W11 path stays around because:
- It's the only path that exercises the trailer-parsing + LUKS-rotation
  code that bare-metal installs eventually need.
- Removing it would require committing to (b) for LUKS, which we'd
  rather sequence after the demo path is provably green.

When W13 is verified live, the **default** sample-user CLI command
should switch to `admin-cloud-init-now`; W11 stays as an opt-in flag
(`--use-iso`) for the bare-metal smoke test.

## Open questions / TODO

- The `installer/data-services/init.sh` script Daemon-side needs to
  work against an *unencrypted* `/var/flagship/data` mount point. The
  current script assumes the LUKS mapper is already open; confirm it
  still works when the path is just a plain directory. (Likely yes —
  it just `docker compose`s from there.)
- Confirm Hetzner's `debian-12` image has `cloud-init` ≥ 22.x with the
  `runcmd` module. (`debian-12` ships cloud-init 22.4 by default per
  Hetzner's image notes — sufficient.)
- `flagship-first-boot-register.service` should be `ConditionPathExists=!
  /var/flagship/registered.flag` so a second boot after a manual
  reboot doesn't double-register. Already handled in the W12
  late-command shape; carry it over.
- E2E test using a fake Hetzner client + cloud-init script
  introspection (no actual VM) is in scope for the unit tests; an
  honest live test on a paid Hetzner VPS is the irreducible operator
  follow-up.
