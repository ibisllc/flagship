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

## Update: root cause of "Studio stays on Waiting for you to unlock" and (probably) the Apps list failure
- Studio decides a server is Running by fetching `https://<server domain>/` from the PC itself (`VMManager.cs:630`, `UnlockProbe`). It polls this name from the moment the VM boots, i.e. BEFORE the box has registered its DNS records. Home routers (mine: AT&T, `attlocal.net`) cache that NXDOMAIN for the zone's negative TTL: `flagship.services` SOA default TTL is 1800 s, so the PC's resolver keeps answering NXDOMAIN for up to ~30 min after the box is actually up (`nslookup home.peppy-elk.flagship.services` -> "Non-existent domain" on the router, `... 8.8.8.8` -> 149.248.216.86 and 2a09:8280:1::110:d2b6:0). Meanwhile the box was Online/Leader/Healthy on the phone and HTTPS answered 200 with a valid cert when resolved via 1.1.1.1.
- Result: Studio's card stays "Waiting for you to unlock - Taking longer than expected - the box may not have reached the network" for ~30 min on a healthy box, and the owner is told to power off and retry. Likely the same cause as A-12 (phone on the same Wi-Fi uses the router's DNS and the Apps list needs the server's name; Health goes through `.com`).
- Suggested fixes: (1) Studio should treat a fresh signed order-health report from `.com` (`/api/order/<serial>/health`, already polled for the Health card) as proof the box is up, not only the local HTTPS probe; (2) don't probe the name until the box has reported in (or use DoH, or probe the relay by IP with SNI) so the PC never seeds a negative cache; (3) consider a lower negative TTL on `flagship.services` (SOA minimum), e.g. 60 s; (4) apps: when the box name doesn't resolve, fall back to the relay path.
- I am watching for the router cache to expire (~12:06 local) to confirm: expected Studio -> Running and the phone's Apps list loads.
