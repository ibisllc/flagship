# Windows Studio 0.3 acceptance, 2026-11-05
Verdict: (in progress; Failure 1 blocks a PASS until the appliances are republished)
Build: studio-release run 42124941884, commit cd95fc57b (= deployed pin 1e1840f2c + release.sh/yubikey-sign.mjs/journal only), zip SHA-256 D7C82B24C60B0E760FD76D8B1C21B345E1D62E238B1B882472CE5FA2F378183E (76,423,759 bytes); exe 0.3.0+cd95fc57b, NotSigned
Backend: PRODUCTION per DEPLOYED-FINAL-2026-11-05 (0.3 is live; the runbook's gym target predates phase A)
Windows: Windows 11 Home 25H2 (build 26200), en-US (fr-FR installed); Smart App Control: off (0)
Windows 10 (W0b): pending (owner has a 22H2 PC)
Hardware: Intel i5-14400F, 15.7 GiB; QEMU (C:\Program Files\qemu) + WHPX; phone: Android 15 emulator, debug APK of 1e1840f2c (plain launch = production)
Waivers (owner): pending (W2 n/a on production; W13 no newer endorsed release on production)

## Contract check (DEPLOYED-FINAL-2026-11-05), 2026-11-05 ~22:20Z
All true: .com /api/health ok; flagship.services /api/health ok; webapp. and remote. SHELL_VERSION v200; /api/notices 204;
box artifact flagship-box-52c67f8848ee-amd64.manifest.json 200 (release/box-release.json commit 52c67f88, seq 2, arch-v2);
appliance manifests: amd64 commit 52c67f88 sha256 ecd620cb...9813b, arm64 commit 52c67f88 sha256 08514894...8c50;
random name under flagship.services resolves to 149.248.216.86 / 2a09:8280:1::110:d2b6:0; apex CAA = 0 issue + 0 issuewild "letsencrypt.org".

| Row | R/I | Result | Time | Evidence / notes |
|-----|-----|--------|------|------------------|
| W0  | I   | done | | Win 11 Home 10.0.26200, en-US+fr-FR, SAC 0 (off), QEMU present, .NET SDK 8.0.422. VMs folder empty; Appliances cache ~2.4 GB (older base). FLAGSHIP_CONTROL_HOST unset. Local build of 1e1840f2c: make.ps1 test 310/310, publish ok. |
| W3  | R   | partial: typed code pass; QR and offline steps pending | ~10 s code→SAS | Fresh throwaway `<account>` on the emulator (Skip-for-now backup). Create a server (defaults: name `home`, 6 h recipe, "No backup" picked; Continue does nothing until a backup choice is made, no hint shown) → Pair with the builder app → Enter the code instead (hint "like ABCD-EFGH", matches Studio's `XXXX-XXXX`) → typed `<code>` → Connect: phone and Studio both showed SAS `181 793`; Studio "Check that this code matches the Flagship app, then confirm on your phone." / "Waiting for you to confirm on your phone…". "They match — pair & send" → phone "Sent / You can put your phone away", Studio "Recipe verified — choose where this server should live." with Burn to USB / Host on this PC. No biometric was asked at send (the session was unlocked a minute earlier). Still to run: QR scan (the emulator camera can't see Studio's screen; needs the owner's phone or a decoded link), Wi-Fi off/on. |
| W6  | R   | **FAIL** (product, all Studios) | download 3:05, fail 2:48 after start | Studio took the PREBUILT path (production manifest names the recipe's commit 52c67f88): downloaded + verified the published amd64 appliance `ecd620cb…` (1,965,142,528 B, 23:06:18→23:09:23Z), "created the server's disk on the prebuilt image and wrote its one-use setup seed". First try refused at start: "Not enough free memory: this server needs 4 GiB. Close other apps and try again." (correct, W26 sentence; my build tools held the RAM). Retry 23:10:08Z: "Checking the server recipe" 23:10:29, "Giving this server its own disk encryption key" 23:10:44, then 23:12:56Z **"Setup failed: [flagship-bootstrap] FATAL: appliance release  does not match signed recipe commit 52c67f8848eeb878cc9f63e84786b81f6933d19c"** (the appliance commit is EMPTY). See Failure 1. |
| W26 | I   | pass (memory half) | | The 4 GiB sentence above appeared with ~3.4 GiB free; nothing created besides the VM folder. QEMU-kill half not run yet. |
| W1  | R   | pass (SmartScreen pending) | window 3.7 s | Data folders moved aside (`*.aside-20261105-235448`). Title "Flagship Studio (Experimental)"; About "Flagship Studio 0.3 Beta"; code `P54Q-LYNK` up with no click, dash-grouped; "Pair your phone to begin / In the Flagship app, scan the QR or type the code to pair"; no Windows 10 line. The zip came from `gh run download` (no Mark-of-the-Web), so SmartScreen could not trigger: to record it, re-run from a browser download with the owner at the screen. |

## Failures

### Failure 1 (R, blocks every prebuilt-appliance host on every Studio): the published 0.3 appliance can't specialize
- Symptom: `[flagship-bootstrap] FATAL: appliance release  does not match signed recipe commit 52c67f88...` ~2 min into first boot; the appliance commit read is the empty string.
- Cause (code reading, 1e1840f2c): the appliance factory installs the signed release with `install-box-artifact.sh`, which writes `/var/flagship/artifact-current.json` (`.commit`) and `artifact-sequence`; the generalize step then runs `rm -rf /var/flagship/*` (`packages/flagship-builder/src/appliance.ts:321`). The first-boot bootstrap under `FLAGSHIP_APPLIANCE_PREINSTALLED=1` reads `jq -r .commit /var/flagship/artifact-current.json` (`packages/flagship-builder/src/userdata.ts:701-702`) and gets "".
- When: the check came with the 0.3 security commit `cc5425c8a` (2026-10-23); the wipe has been in the factory since `fe16fc3c6` (2026-07-21). So every 0.3 appliance is affected, including both published 2026-11-05 images (amd64 `ecd620cb`, arm64 `08514894`, bake 52c67f88): Mac, Windows and Linux Studio "Host on this PC" on production all fail for 0.3 recipes. `vm-appliance.yml`'s boot smoke doesn't run a real recipe through the specializer, so CI couldn't see it.
- Suggested fix (release manager): keep the release record through generalization (e.g. exclude `artifact-current.json`/`artifact-sequence` from the wipe, or have the bootstrap read `/opt/flagship-releases/<commit>/INSTALLED.json` / `BUILD-INFO.json` through the `/opt/flagship` link), add a specializer test with a real seed, rebuild + republish both appliances. Workaround until then: `FLAGSHIP_VM_FORCE_ISO=1` (W8).
- Evidence: Studio log lines (verified appliance sha256, prebuilt disk created, both checkpoints, the FATAL line); VM folder kept at `%LOCALAPPDATA%\FlagshipBuilder\VMs\<server>` (config, 197 KB overlay, seed).

### Accessibility (I): Studio exposes .NET type names to screen readers
- The hosted-server sidebar rows' UI Automation name is `Flagship.Builder.VM.HostedServer` (no `AutomationProperties.Name` on the `ServerList` items, `apps/builder-windows/src/MainWindow.xaml:844`, and no `ToString`), and every log drawer line reads `LogLine { Stream = Stdout, Text = ... }` (record ToString). Visible text is fine; Narrator would read the class names.
