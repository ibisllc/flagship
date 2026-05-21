# `@flagship/burner` — flash a Flagship pod onto a USB drive

Single tool a real user installs. Takes the signed recipe the phone produces +
a stock Ubuntu Server ISO, writes a bootable USB. The freshly-booted box
registers itself with `.com` and is live in minutes.

## Architecture (v1)

```
phone (trust root) ──QR sign── webapp ──QR-pipe / file download── Burner ──dd──> USB
                                                                    │
                                                                    └ verifies blob locally; never calls .com
```

The Burner never reaches `flagshipserver.com`. The phone's signature on the
`InstallBlob` is the sole trust root. Tampered ISOs are rejected before write
via the pinned distro allowlist (SHA-256, sizes).

## Install

Phase 1 ships the CLI only — `node` 20+ is a runtime prereq. Phase 2 ships
a standalone binary + Mac / Windows / Linux native GUIs. The Mac GUI exists
at `apps/burner-mac/` and shells out to this CLI.

```sh
# From the repo root, once:
npm install --workspaces

# Then the CLI is available via:
node packages/flagship-burner/src/cli.ts <subcommand> [args]
# (or symlink that into your PATH as `flagship-burn`)
```

## Subcommands

### `verify <recipe.json>`

Sanity-check a signed recipe without burning anything. Prints the
`serverDomain`, `username`, `installerGitRef`, expiry timestamp.

```sh
flagship-burn verify ~/Downloads/flagship-recipe-*.json
```

Errors with stable codes:
- `expired` — past `authCode.expiresAt`
- `bad-signature` — phone signature doesn't verify
- `missing-field` / `malformed-json` — structural problems
- `io` — file read failed

### `verify-iso <iso-path>`

Hash an ISO + compare against the pinned distro allowlist. Exit 0 = match.

```sh
flagship-burn verify-iso ~/Downloads/ubuntu-22.04.5-live-server-amd64.iso
```

### `user-data <recipe.json> <out-path>`

Emit a cloud-init `user-data` YAML for the recipe. Useful if you're going to
combine it with the ISO via your own tooling (`hdiutil`, `mkisofs`,
`balenaEtcher` w/ Cloud-Init, etc.).

```sh
flagship-burn user-data ~/Downloads/recipe.json ./user-data
```

After a successful emit, the recipe file is **auto-shredded**. Pass
`--keep-recipe` to skip.

### `prepare <recipe.json> <iso> <out.iso>`

Bake a single flashable ISO — source ISO bytes with a CIDATA FAT partition
appended carrying the cloud-init `user-data` + `meta-data`. The user can then
write the output ISO to USB with `dd`, `balenaEtcher`, Rufus, or any tool of
choice — that's the "burn elsewhere" path.

```sh
flagship-burn prepare ~/recipe.json ~/ubuntu-22.04.iso ~/flagship-ready.iso
sudo dd if=~/flagship-ready.iso of=/dev/diskN bs=4M status=progress
```

### `write <recipe.json> <iso> [--device /dev/diskN|auto] [--yes]`

Full one-step burn. Verifies the recipe + ISO, picks a removable USB target
(interactive picker by default), gets a typed-yes confirmation, raw-writes
the ISO bytes + appended CIDATA FAT image, then fsyncs.

```sh
sudo flagship-burn write ~/recipe.json ~/ubuntu-22.04.iso
# Or non-interactive:
sudo flagship-burn write ~/recipe.json ~/ubuntu-22.04.iso --device /dev/disk6 --yes
# Or auto-pick when there's exactly one eligible USB:
sudo flagship-burn write ~/recipe.json ~/ubuntu-22.04.iso --device auto --yes
```

Defense in depth: `/dev/disk0`, drives > 500 GB (probably internal), drives
< 500 MB, internal-flagged, and virtual disks are all hard-refused EVEN
with `--device` and `--yes`. The check does not bend to a flag.

`--device auto` requires `--yes` (CI-friendly, never prompts) and refuses
if there are 0 or > 1 eligible removable-usb devices.

### `distros`

List the pinned distro allowlist (Ubuntu Server 22.04 as of v1).

## Phase-2 roadmap

- Native single-binary distribution (Rust port via Tauri or Bun bundle) —
  no Node prereq.
- Windows GUI.
- Linux GUI.
- GPG verification of upstream ISO signing keys (additional to SHA pinning).

## Threat model

- **Recipe at rest** (e.g. in `~/Downloads/`): bounded by `authCode.expiresAt`
  (5min–24h). Stealing the file authorizes one install at the user's
  `serverDomain` until expiry. Mitigations:
  - copy-paste path on same-device flows (no file at rest)
  - auto-shred after successful consume
  - phone can revoke the auth-code via `/api/auth-code/<serial>/revoke`
- **Tampered ISO**: refused via pinned SHA-256 allowlist.
- **Tampered Burner binary**: covered by reproducible builds + signed releases
  (Phase 2). Today this CLI ships from-source in the repo.
- **Compromised `.com`**: irrelevant to the burn step. The phone's signature
  is the trust root; `.com` is at most a delivery mechanism for the recipe.

## Code map

| File | Responsibility |
|---|---|
| `src/cli.ts` | argv parsing, dispatcher |
| `src/loadBlob.ts` | parse + Ed25519-verify the recipe |
| `src/verifyIso.ts` | hash an ISO, match against `PINNED_DISTROS` |
| `src/userdata.ts` | emit cloud-init YAML w/ embedded blob |
| `src/writeIsoWithCidata.ts` | append CIDATA partition to output ISO |
| `src/distros.ts` | the allowlist itself |
| `tests/*.test.ts` | vitest |

## License

BUSL-1.1 — see repo root.
