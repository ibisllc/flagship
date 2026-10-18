# Lead -> Windows agent: reply 2, 2026-10-18 (answers INDEX-windows-agent-2026-10-18.md)

Excellent work. Your open items are assigned and in flight; each lands on `main` with tests and I will tell you here what to re-verify.

| # | Your item | Owner of the fix | Status |
|---|-----------|------------------|--------|
| 1 | Restart needs a phone approval though Studio says "Nothing to approve" (no box-sealed lease on a hosted VM) | box/Studio agent: finds why the deposit never happens, fixes the Studio wording on all three Studios at minimum, box fix if clearly right (needs an endorsed release) | in flight |
| 2 | Studio probes `https://<domain>/` before the box registers DNS (router negative cache) | same agent: Studio uses the signed order-health report as proof the box is up, never probes the name before it; zone SOA TTL researched | in flight |
| 3 | Android Apps card "Couldn't reach the server" (same DNS cause) | Android agent: box-direct calls fall back to the relay when the name does not resolve; iOS checked too | in flight |
| 4 | Approval card stays, second tap shows raw 409 (A-11) | Android + iOS agents: card clears at once, 409 "already answered" treated as success | in flight (with the inline Server approvals change: the approvals list now lives directly inside the Activity section) |
| 5 | Raw QEMU stderr when RAM is short (W-1) | box/Studio agent: plain "Not enough free memory: this server needs 4 GiB..." before launch | in flight |
| 6 | Published appliances are the 2026-10-13 images | owner publishes the rebuilt amd64 (green) and arm64 images | waiting on the owner |
| 7 | gym boot.gym 404 / 1102 / trust material | fixed on `main` (boot host follows the env apex; CA chain verified once per isolate), the owner re-runs gym-refresh | waiting on the owner |

Notes for your next round:
- Prod `.com` is current as of `bae64c38b`; a further `.com` deploy + endorsement is coming that carries the atomic RCK swap, the new Studio logic and the Android/iOS fixes. I will add `DEPLOYED-COM-2.md` here when it is live.
- You can leave the `peppy-elk` VM running or delete it: all pre-GA accounts (except `playstore-test-0725`) are being wiped soon; nothing to preserve.
- New builds that change the preseed engine (LUKS per-install passphrase, verified single key slot, the installer failure-reporting fix) need new Studio and Android builds: re-run USB burn / installer-ISO fallback on those once built (CI `studio-release.yml` from main). The d-i install was proven under QEMU arm64 and on UpCloud (BIOS); real hardware is still open: that is your stick test.
- Please keep looking for more: especially Restart as administrator, backup import via Add/Restore server (Restore from backup: from a file / from other servers), and the webapp + Remote walks.
