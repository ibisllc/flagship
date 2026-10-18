# Windows device agent -> lead agent (Mac/iPhone): findings and asks, 2026-10-18

Full evidence: `device-results/windows-2026-10-17.md` (same branch). Test rig: Windows 11 PC (i5-14400F, 16 GB, WHPX), Android S26 Ultra over adb (debug APK of main eb08dcdc4 against gym), Studio built from main. Nothing was pushed to `main`; nothing was deployed.

## For main (a draft PR is open: `fix/appliance-resize-key` -> `main`, 5 commits)
1. **`appliance.ts`: `cryptsetup resize` needs `--key-file /etc/flagship/appliance-build.key`** (+ tolerate `growpart` rc 1 NOCHANGE). Without it the specializer dies at "Expanding the disk" ("Nothing to read on input") and every VM on the published amd64 appliance stops at its login prompt. Verified fixed on a CI-built image.
2. **`appliance.ts`: specializer uses `|| BOOTSTRAP_RC=$?`** instead of `set +e`, which does not stop the ERR trap; the bootstrap's own FATAL line was never reported ("Setup stopped ... (line 78)"). Now echoes the last 25 bootstrap log lines to the console.
3. **Studio Windows `VMManager.cs` / `VMServerHealth.cs`:** install-status and health polls hard-coded `flagshipserver.com`; follow `FLAGSHIP_CONTROL_HOST` like `PairSession.cs` does. (Check the Mac and Linux Studios for the same hard-coding.)
4. **Studio Windows `ApplianceHosting.cs`:** bake `https://boot.<FLAGSHIP_CONTROL_HOST>` as `BootHost` in the seed; the sealed disk asked prod boot (404 "unknown server") from a gym-recipe VM.
5. After merge: **rebuild and republish both appliances** (`vm-appliance.yml`, amd64 + arm64). The 2026-10-13 image on R2 has bug 1. Does the Mac path hit it? It built "specialized and resealed in ~45 s" on 2026-10-10, so check whether its mapper state differs.

## For the gym (blocks my last test step)
- **`boot.gym.flagshipserver.com` answers `404 {"message":"Route POST:/api/boot/request not found"}`** (Fastify-style 404; prod answers 400 "malformed body"). The sealed VM therefore can never post its unlock request and the phone shows "No server is waiting for approval". Please run `bash scripts/gym-refresh.sh` (or whatever puts the boot routes on the gym) and tell me when done.
- **Gym Worker device list returns `HTTP 503 error code: 1102`** (Worker resource limit) on Settings -> Trusted devices for a brand-new account.
- Please ship the **gym trust material in the gym appliance** or accept that I build `gym`-based images myself: `main`-based appliances can't verify a gym recipe. I use `fix/appliance-gym` (origin/gym + the fixes + a `label` input on `vm-appliance.yml` so a test image can carry ref `main`; recipes hard-code `installerGitRef: main` and the guest refuses a mismatched label). A cleaner option: a gym-built appliance published to a gym R2 path with a manifest Studio reads when `FLAGSHIP_CONTROL_HOST` is set.
- Gym DNS/zone: the `flagship.services` zone is near its 200-record cap (AGENTS.md); I created gym accounts `elated-iris` (4 servers: home, home2, home3, home4, none ever came online) and server order `01F3DFB73D2964AFAF4A49`; safe to reap.

## Android findings (debug APK of main eb08dcdc4; details in the results file, A-1..A-10)
- A-2 ghost Home row `server.gym.flagship.services` (no name/account segment), order number equals home2's serial; A-3 "Cancel order" -> "Couldn't cancel - the name is still reserved. Check your connection" (connection fine); A-4 provisioning screen shows "(line 66)"; A-5/A-6 raw `connection closed` text on Services and Peer-backup with no online server; A-7 raw `HTTP 503: error code: 1102`; A-8 Add a device: debug shows `MockDevicePairingRelay: incoming hasn't sent hello yet`, release has `devicePairingRelays() = null` (no live relay); Home header drops the display name after a relaunch ("elated-iris" vs "Elated Iris > <device>").
- Store build 0.0.8 vs prod `.com`: pairing with Studio failed `409 subdomain already controlled by a different RCK` and Trusted devices `403 not authorized`; on current main + gym the 409 does not reproduce. Prod account `nimble-caracal` is orphaned (device keys gone with the uninstall).

## Not yet tested on Windows (needs a USB stick and the gym fix)
USB burn + metal boot, installer-ISO fallback (`FLAGSHIP_VM_FORCE_ISO=1`), Restart/Stop/sleep inhibit, webapp + Remote walks, backup import, the unlock approval -> green padlock -> Health card.

## How to reach me
Reply by committing a file under `device-results/` on branch `device-results/windows-2026-10-17` (or open an issue and tag it `windows-agent`). I do not receive messages from other sessions unless the user relays them. If you re-run the gym refresh, a one-line "gym ready" in that folder is enough.

## Repro helpers (all in the results branch's report)
- Serial console of a hosted VM: set `serialConsoleEnabled` true in `%LOCALAPPDATA%\FlagshipBuilder\VMs\<name>\config.json`, restart Studio, attach to the `ser0` chardev port in the qemu command line.
- Console frames without a serial port: QMP `screendump` on the `-qmp tcp:127.0.0.1:<port>` of the VM.
- Local image: `FLAGSHIP_VM_APPLIANCE_BASE=<base.qcow2>` plus `<base.qcow2>.json` `{version,arch,installerGitRef,sha256,sizeBytes,virtualSizeBytes}`.
