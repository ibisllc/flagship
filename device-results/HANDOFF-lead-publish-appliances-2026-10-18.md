# Windows agent -> lead agent (Mac): please publish the rebuilt appliances and deploy, 2026-10-18

Owner preference: I push builds and instructions to git; you pull and deploy everything in place. Nothing below needs the Windows PC. Full background and the arm64 root cause: `PUBLISH-appliances-howto.md` in this folder.

## What is ready (all in GitHub, nothing deployed by me)
- **amd64 appliance, built from `main`:** workflow run `39153553427` (release = latest-endorsed, label `main`, image sha256 `4093d4a86a874a423a80d179c31ce9e768e17acdafb95da5b6f799873297684d`). The preceding main build (`39142014433`) was verified end to end on Windows against prod (first boot, phone approval, Online/Leader, Health, HTTPS 200); I will re-verify this exact image only if you ask.
- **arm64:** blocked by a `tar` race in the factory script, fix = draft PR #6 (`fix/appliance-factory-tar`, test included, tsc + vitest green). Please review and land it on `main`, then run:
  `gh workflow run vm-appliance.yml --ref main -f arch=arm64 -f git_ref=main -f release=latest-endorsed` (about 3 h under TCG). My proof build on the fix branch (run `39153555449`, not publishable: its label is the branch name) will tell you whether the fix works before you spend 3 h.
- **PR #5** (`fix/appliance-resize-key`) is superseded by your landing; close it.

## Your steps (Mac, owner's credentials)
1. Endorse the newest server release if not already (needs the YubiKey, so the owner must be present for that one): `node scripts/endorse-release.mjs --to <sha> --from <box commit> --sign`.
2. `bash scripts/publish-vm-appliance.sh 39153553427` (add the arm64 run id when it exists). Needs `gh` + logged-in `wrangler`.
3. Commit `apps/web/public/downloads/FlagshipVMAppliance-*.json`, push to `main`, then `npx tsc -b && (cd apps/com && npm run deploy)` (pending D1 migrations first).
4. Verify: `curl -s https://flagshipserver.com/downloads/FlagshipVMAppliance-amd64.json | head -5` shows `4093d4a8...`.
5. Write `device-results/APPLIANCE-PUBLISHED.md` (one line: commit + shell version + which arches). That is my cue to retest with NO overrides: unset `FLAGSHIP_VM_APPLIANCE_BASE`, host a server from the published image on Windows, approve on the phone, check Health/HTTPS, plus Stop and Restart.

## What I will do meanwhile (no action needed from you)
Installer-ISO fallback (`FLAGSHIP_VM_FORCE_ISO=1`), webapp + Remote walks, re-verification of the Android fixes that landed after eb08dcdc4, and the Restart unlock issue (INDEX item 1) once you say whether it is a missing deposit or wrong wording. I only see your replies when you commit them under `device-results/` on this branch or when the owner relays them.
