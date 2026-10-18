# Windows agent -> lead: hosted VM works end to end on PROD with unedited main (2026-10-18)

Builds: Studio from `origin/main` 1b656fd24 (unedited, no FLAGSHIP_CONTROL_HOST), Android debug APK of the same commit (unedited, prod), appliance = CI run 39142014433 (main) via `FLAGSHIP_VM_APPLIANCE_BASE` + sidecar. Fresh throwaway prod account `peppy-elk` (never `playstore-test-0725`).

| Step | Result |
|------|--------|
| Create account, Home (no ghost row) | pass |
| Create a server -> Pair with builder (typed code, SAS 251 086 on both) | pass, no 409 |
| Studio "Host on this PC" (prebuilt appliance) | pass: first boot specializes, powers off, reboots sealed; Studio "Waiting for you to unlock" (~3 min) |
| Boot request reaches prod (initramfs: "posted unlock-key boot-request") | pass |
| Phone: Activity -> Server approvals shows `home.peppy-elk.flagship.services` -> approve | pass (took one Refresh/collapse-expand of the card; see A-11) |
| VM boots, daemon + data layer up | pass |
| Home: `home` shows Leader + Online | pass |
| Server page -> Health | pass: "Healthy - 2830 MB free of 3915 MB - disk 6% - up 13m" |
| HTTPS `https://home.peppy-elk.flagship.services/` (via `--resolve` to 149.248.216.86) | pass: HTTP 200, valid TLS, schannel raised no error (green padlock equivalent) |
| Server page -> Apps list | FAIL: "Couldn't reach the server. Check your connection and try again." (persisted >2 min; Health, the same server page, loaded) |

## New findings
- **A-11 (Android):** after approving, the approval card stays on screen; tapping it again gives a raw toast `Approval failed: HTTP 409: {"error":"already answered"}`. Expected: the card clears itself and a second tap is a no-op.
- **A-12 (Android):** server page Apps card says "Couldn't reach the server" while Health on the same page loaded and Home says Online. Not isolated. Possibly the app list goes box-direct via `<server>.<user>.flagship.services` and my LAN's resolver returns nothing for it (my PC's resolver also fails: `nslookup` on the router resolver gives no address, `nslookup ... 1.1.1.1` gives 149.248.216.86 and 2a09:8280:1::110:d2b6:0), so a negative-cached name on the home router's DNS could cause it. Worth checking whether the phone falls back to the relay path or LAN-direct when DNS fails.
- **W-1 (Studio Windows):** a second hosted VM start fails with `QEMU exited 3 ... WHPX: failed to map GPA range` when the PC has <~5 GB free RAM (a leftover 2.4 GB Gradle daemon). The message is the raw QEMU stderr (repeated APX/MPX CPUID warnings) in the sidebar; suggest a plain "Not enough free memory (needs 4 GiB)" before launching, and show only the last QEMU error line.
- **W-2 (Studio Windows):** `Create server on this PC` confirmation step is skipped on the default (published appliance) path in my first run but appears with `FLAGSHIP_VM_APPLIANCE_BASE`; fine, just noting the two flows differ.
- A-1..A-10 from the earlier report: A-2 (ghost row) and the retry 409 do not reproduce on main 1b656fd24; Home shows the display name correctly after the app starts.

## Cleanup
VM `home.peppy-elk.flagship.services` is still running on this PC (to allow follow-up tests); account `peppy-elk` can be wiped with the other pre-GA accounts. gym accounts from earlier are the live-gym agent's to reap. No UpCloud servers created; `playstore-test-0725` untouched.

## Still not done on Windows (needs a USB stick / owner)
USB burn + metal boot, installer-ISO fallback, Restart/Stop/sleep inhibit, webapp + Remote walks, backup import, the published (not CI) appliance once republished.
