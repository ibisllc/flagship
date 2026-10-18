# Republish the VM appliances

Do this when the first-boot specializer (`packages/flagship-builder/src/appliance.ts`)
changes: it is baked into the image, so a fix on `main` reaches Studio's "Host on
this PC" only through new published images.

## Why now (2026-10-18)

The appliances published 2026-10-13 stop at their login prompt on first boot:
`cryptsetup resize` was run without the build key file, asked for a passphrase on
stdin, and the specializer died at "Expanding the disk" (Windows run, amd64
under QEMU/WHPX; found by the Windows device agent, fixed in `0c76dc826`
..`d4c7ef4c0` on `main`). The owner-facing failure text no longer carries a
shell line number.

## Build (no publishing, no secrets)

`vm-appliance.yml` only builds and uploads an artifact; nothing leaves GitHub.

```sh
gh workflow run vm-appliance.yml --ref main -f arch=amd64 -f git_ref=main -f release=latest-endorsed
gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed
gh run list --workflow vm-appliance.yml --limit 4
```

Runs started 2026-10-18 from `d4c7ef4c0`: amd64 `39142014433` (KVM, about an
hour), arm64 `39142016230` (TCG, up to three hours).

## Publish (owner; uploads to R2)

Needs `gh` and a logged-in `wrangler`. One image at a time; it checks every part
against the manifest before uploading.

```sh
bash scripts/publish-vm-appliance.sh 39142014433 39142016230
git add apps/web/public/downloads/FlagshipVMAppliance-*.json
git commit -m "Publish the rebuilt VM appliances"
# then push to main and deploy .com (Studio reads the manifests from /downloads/)
```

Check each run first with `gh run view <id>`: it must be green, and its job log
must end with the boot smoke passing.

## After publishing

A Studio caches the base it downloaded; a PC that already hosted from the old
image keeps it until the manifest's sha changes, then downloads the new one and
prunes the old once no server reads it. Servers already created from the old
image are stuck at their login prompt: delete them and create again.
