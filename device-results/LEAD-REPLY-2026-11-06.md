# Lead reply to the Windows 0.3 acceptance (2026-11-06)

Answers `windows-0.3-acceptance-2026-11-05.md` up to b75f6ed80. All fixes are on `main`; nothing here is deployed yet
except as noted. Build the next Windows Studio from `main` at or after **78ce3bc55**.

| Item | Status | Commit | Notes |
|---|---|---|---|
| Failure 1: appliance first boot, empty release commit | FIXED | 02ee868e3 | The factory keeps `artifact-current.json`/`artifact-sequence`; the bootstrap Studio writes into the seed rebuilds them from `/opt/flagship-releases/<commit>/INSTALLED.json` when missing. So the PUBLISHED appliances (amd64 ecd620cb, arm64 08514894) work with a Studio built from this commit; no appliance republish is needed (your TODO 1 asked for one: not needed). Regression test `packages/flagship-builder/tests/applianceReleaseRecord.test.ts`. |
| Failure 2a: bundled xorriso can't read `/c/...` | FIXED | c43086141 | `/cygdrive/c/...` unless the tool sits in an MSYS2 tree with `etc/fstab`. Not yet proven on a real remaster: please verify. |
| Failure 2b: extracted cfg is read-only | FIXED | c43086141 | Attributes cleared before the edit. |
| Failure 3: a recipe refusal says nothing on the start screen | FIXED | c559bb080 | `RecipeError` shows under Load from file / Paste from clipboard, announced (LiveSetting assertive). Covers W5's older-app sentence. XAML compiled only in CI/Studio build (no WPF on the Mac). |
| Failure 4: Android 0.3 key file → webapp import 403 | IN PROGRESS | branch `fix/keyfile-import-and-remote-code` | Root cause being diagnosed across webapp/Android/iOS; a refused import will also roll back the half-signed-in browser and show a sentence. Store builds wait for it. |
| W18: camera-less computer can't join | IN PROGRESS | same branch | A typed code / link on Add a device, or a design if larger. |
| W19: Remote browser never shows the comparison code; Approve with no server says nothing | IN PROGRESS | same branch | |
| A11y: sidebar rows and log lines read as .NET type names | FIXED | 78ce3bc55 | `ToString` = "<server>.<user>, <state>" and the log text. |
| A11y: Delete confirmation Yes/No exposed as Pane | OPEN | | Not fixed in this round. |
| Info: "Setup failed" still reads "Installing…" and keeps the VM running; phone header still says "almost done" | OPEN | | Not fixed in this round (not a release blocker). |
| Info: window close once left the process running; offline start screen silent; ISO path waits for a click | OPEN | | Not fixed in this round. |
| W16: no Save installer in the Windows UI | NOTED | | By design for now (Simple/Advanced flash only); mark n/a. |
| W4 runbook: unreachable check needs FORCE_ISO | NOTED | | Use `FLAGSHIP_VM_FORCE_ISO=1` for that step. |

## Please rerun with the new build
W5, W6 (prebuilt host on production; expect it to come online), W8 (installer-ISO host with `FLAGSHIP_VM_FORCE_ISO=1`),
the rows they unblock (W9, W10 needs the owner, W11, W13, W14, W17), and W26's QEMU-kill half. W18, W19, W25 after
`fix/keyfile-import-and-remote-code` lands on main and `.com` is redeployed (I'll note it here).

## Also new in this build (for your awareness, test if convenient)
- The voi.ci page is now managed at the top of the Messages tab (webapp shell v202 after the next `.com` deploy):
  Public switch with a one-time warning, Home and Settings point there, the Messages tab icon sits in a teal circle.
- Sample accounts will show an example page (read-only) once the operator publishes it.

## Cleanup
Your end-of-round list is right; delete the UpCloud device-test server and ISO storage when the server-dependent rows
are done (they are labelled `flagship-env=device-test`).
