# Publishing the rebuilt VM appliances (owner steps), 2026-10-18

The product fixes are on `main`. The images below are built from `main`; nothing is published until you run these steps (needs your wrangler login + R2 access, which the Windows agent does not have).

## Candidates
| Arch | Run | Built from | Image sha256 | Status |
|------|-----|-----------|--------------|--------|
| amd64 | `39153553427` | `main` (release = latest-endorsed) | `4093d4a86a874a423a80d179c31ce9e768e17acdafb95da5b6f799873297684d` | green; the previous main build `39142014433` was verified end to end on Windows against prod |
| arm64 | needs PR #6 first | | | the last arm64 run (39142016230) failed: `tar: ./var/lib/apt: file changed as we read it` under `pipefail`. Fix = https://github.com/ibisllc/flagship/pull/6 (draft). Test build on the fix branch: run `39153555449` (label = branch name, NOT publishable). After #6 is merged: `gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed` (about 3 h under TCG) |

## Order
1. **Endorse the newest release first** (a new server's first boot moves itself to the newest endorsed release, so one must exist): `node scripts/endorse-release.mjs --to <sha> --from <box commit> --sign` in a real terminal (YubiKey PIN).
2. (Optional, 10 min) Retest the exact image before publishing; on any machine with Studio:
   `gh run download 39153553427 --dir dl`, join the parts, check sha256 against `FlagshipVMAppliance-amd64.json`, write a `<base>.json` sidecar (`{"version":1,"arch":"amd64","installerGitRef":"main","sha256":"<sha>","sizeBytes":<n>,"virtualSizeBytes":8589934592}`) and start Studio with `FLAGSHIP_VM_APPLIANCE_BASE=<base.qcow2>`.
3. **Publish** (bash, from a clean checkout of `main`, with `gh` and a logged-in `wrangler` on PATH; ~3 GB of disk per image):
   ```sh
   git checkout main && git pull
   bash scripts/publish-vm-appliance.sh 39153553427          # add the arm64 run id once it exists
   git add apps/web/public/downloads/FlagshipVMAppliance-*.json
   git commit -m "Publish rebuilt VM appliance(s) (runs 39153553427 ...)"
   git push origin main
   ```
   The script downloads each run's artifact, checks every part against its manifest, uploads the parts to R2 `flagship-iso/` and copies the manifest into `apps/web/public/downloads/`.
4. **Deploy `.com`** (it serves the manifests that Studio reads): `npx tsc -b && (cd apps/com && npm run deploy)`; apply pending D1 migrations first, as always.
5. **Verify** with no overrides: `curl -s https://flagshipserver.com/downloads/FlagshipVMAppliance-amd64.json | head -5` shows sha256 `4093d4a8...`; then on Windows Studio (unset `FLAGSHIP_VM_APPLIANCE_BASE`) host a server: it downloads ~2.5 GB, specializes in ~1 min and shows "Waiting for you to unlock".
6. Servers made from the old (2026-10-13) image are stuck at their login prompt: delete and recreate them. The old R2 parts can be removed afterwards.

## Re-publish again at the GA freeze
The image holds only the OS, packages, Docker and the first-boot specializer; the server code is replaced by the newest endorsed release on first boot. Rebuild and republish both architectures if the specializer/bootstrap changes (for example the restart-unlock fix in INDEX item 1) or the Debian pin moves to 13.7.0.
