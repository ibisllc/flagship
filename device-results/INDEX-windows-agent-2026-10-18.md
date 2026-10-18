# Windows device agent: findings index (2026-10-17 / 18)

Read in this order. Everything is on branch `device-results/windows-2026-10-17`.

1. `ASKS-for-lead-windows-2026-10-18.md`: first findings and asks (appliance resize bug, specializer reporting, Studio polls, gym boot host, Android A-1..A-10). Mostly landed on `main` by the lead.
2. `RESULT-hosted-vm-on-prod-windows-2026-10-18.md`: end-to-end hosted VM on PROD with unedited main, then updates 1 and 2 (DNS negative-cache root cause, sleep inhibit, Stop, Restart).
3. `windows-2026-10-17.md`: the raw log (first Windows run, Android phone run, hosted-VM root causes).
4. `tools/`: repro helpers.

## Open items for the lead (status 2026-10-18 ~12:30 local)
| # | Item | Where | Status |
|---|------|-------|--------|
| 1 | **Restart needs a phone approval** though Studio says "Nothing to approve"; first boot logs `no box-sealed lease (HTTP 404)` so the post-boot unlock deposit never exists for a hosted VM | box + Studio wording + Android "unlock at boot" opt-in | OPEN |
| 2 | **Studio probes `https://<domain>/` before the box registers DNS, so routers cache NXDOMAIN (~30 min, SOA TTL 1800)**: card stuck on "Waiting for you to unlock ... taking longer than expected" on a healthy box | `VMManager.cs:630`, SOA minimum, Android Apps list (A-12) | OPEN (fix suggestions in RESULT file) |
| 3 | Android Apps card "Couldn't reach the server" while Health loads (same DNS cause; phone resolver says `unknown host`) | Android | OPEN |
| 4 | Approval card stays after approving; 2nd tap shows raw `HTTP 409 already answered` (A-11) | Android | OPEN |
| 5 | QEMU raw stderr in the sidebar when RAM is short (`WHPX: failed to map GPA range`) | Studio Windows | OPEN (W-1) |
| 6 | Published appliances still the 2026-10-13 images (bug 1: cryptsetup key file) | owner publish | waiting on owner |
| 7 | gym `boot.gym` route 404, device list 503 / 1102, gym trust material in appliance | gym | lead's gym agent |
| 8 | Android: ghost Home row, cancel-order toast, raw errors, 409 on retry, header name | Android | landed on main (cc682dff2, 3ead3f4c5, 66902924b, d3874827e): to re-verify |

## Verified PASS on Windows 11 (i5-14400F, WHPX)
Pairing phone <-> Studio (typed code, SAS match), host on this PC (CI appliance of main), first boot to sealed boot, phone approval, Online/Leader on Home, Health card, HTTPS 200 + valid TLS, sleep inhibit (powercfg SYSTEM request), graceful Stop (~5 s).

## Not yet run on Windows
Installer-ISO fallback, USB burn + metal boot (no stick), webapp + Remote walks, backup import, Restart as administrator, the published (not CI) appliance, re-verify of Android fixes landed after eb08dcdc4.
