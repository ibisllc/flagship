# iso-seed — the Flagship boot seed

The **seed** is a stock Debian netinst ISO with one published, reproducible
change: it auto-configures the installer from a partition labeled `FLAGSHIP`
that the burner (mobile app / desktop) appends after streaming the seed. This
lets a phone produce a working installer **without remastering an ISO
on-device** — it only writes a small partition.

Full design, trust model, and rationale:
[`docs/iso-seed-and-on-device-burn.md`](../docs/iso-seed-and-on-device-burn.md).
Public verification page: `https://flagshipserver.com/security/iso-seed.html`.

## Files

- `build-seed.sh` — derives the seed from a stock netinst ISO with `xorriso`
  only. Deterministic: pins all timestamps + the GPT disk GUID, so the output
  is byte-for-byte reproducible.
- `preseed.cfg` — the **generic** seed stub baked into the seed. Carries NO
  per-recipe data; its `early_command` mounts the `FLAGSHIP` partition and
  applies the real per-recipe preseed via `debconf-set-selections`.

## Build

```sh
# needs xorriso + mtools (apt install xorriso mtools)
iso-seed/build-seed.sh <stock-debian-netinst.iso> <out-seed.iso>
# prints the seed sha256 — must equal the value pinned in the design doc.
```

Re-run on the exact stock base the app pins (its url + sha are in the
`/api/iso-manifest` response, tied to Debian's official signed `SHA256SUMS`) and
compare the output sha256 to verify the published seed.

## Re-pinning on a Debian point release

1. Update the stock base pin (`FLAGSHIP_ISO_MANIFEST`).
2. Re-run `build-seed.sh` against the new stock base.
3. Update the seed sha256 in `docs/iso-seed-and-on-device-burn.md`, the
   `/security/iso-seed.html` page, and the `FLAGSHIP_ISO_SEED` env value, then
   publish the new seed as the GitHub release asset the manifest points at.
