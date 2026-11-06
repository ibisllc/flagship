# Lead reply to the Windows 0.3 acceptance (2026-11-06)

Answers `windows-0.3-acceptance-2026-11-05.md` up to b75f6ed80. All fixes are on `main`; nothing here is deployed yet
except as noted. Build the next Windows Studio from `main` at or after **4f9e3d664**.

| Item | Status | Commit | Notes |
|---|---|---|---|
| Failure 1: appliance first boot, empty release commit | FIXED | 02ee868e3 | The factory keeps `artifact-current.json`/`artifact-sequence`; the bootstrap Studio writes into the seed rebuilds them from `/opt/flagship-releases/<commit>/INSTALLED.json` when missing. So the PUBLISHED appliances (amd64 ecd620cb, arm64 08514894) work with a Studio built from this commit; no appliance republish is needed (your TODO 1 asked for one: not needed). Regression test `packages/flagship-builder/tests/applianceReleaseRecord.test.ts`. |
| Failure 2a: bundled xorriso can't read `/c/...` | FIXED | c43086141 | `/cygdrive/c/...` unless the tool sits in an MSYS2 tree with `etc/fstab`. Not yet proven on a real remaster: please verify. |
| Failure 2b: extracted cfg is read-only | FIXED | c43086141 | Attributes cleared before the edit. |
| Failure 3: a recipe refusal says nothing on the start screen | FIXED | c559bb080 | `RecipeError` shows under Load from file / Paste from clipboard, announced (LiveSetting assertive). Covers W5's older-app sentence. XAML compiled only in CI/Studio build (no WPF on the Mac). |
| Failure 4: Android 0.3 key file → webapp import 403 | FIXED (not deployed) | 1df9d9663, 22d94d0e0 | Root cause: the three clients derive the IRK from the account key three different ways, so key-file import, cloud recovery and joining failed across clients. Each client now finds the registered key among the file's own derivations and rotates from there; nothing is installed before .com accepts; refusals are sentences. Live after the .com redeploy (webapp shell v204) and new store builds. |
| W18: camera-less computer can't join | FIXED (not deployed) | 1dedf3426 | The phones' Add a device offers a link to send; paste it on the webapp's join screen ("Join with a pairing code"); codes still compared. Needs the new phone builds. |
| W19: Remote browser never shows the comparison code; Approve with no server says nothing | FIXED (likely cause; not reproduced) | a9452a0d2 | Not reproduced on production (the code showed at once). Likely a session expiring just as the phone joined: the relay now restarts the 5-minute clock once when the phone joins, and the page says when a code ran out. Phones say why Approve is disabled with no server. Needs the .com redeploy. |
| A11y: sidebar rows and log lines read as .NET type names | FIXED | 78ce3bc55 | `ToString` = "<server>.<user>, <state>" and the log text. |
| A11y: Delete confirmation Yes/No exposed as Pane | NOTED | | It is the native Win32 MessageBox (MessageBox.Show): Narrator reads and presses its buttons; please check with Narrator itself rather than the UIA tree. Its last sentence was hard-coded English: now translated (bc4c740f5), as is the too-fast-install failure tail. |
| Info: "Setup failed" still reads "Installing…" and keeps the VM running | FIXED | 5fc9da749 | A guest checkpoint with phase `error` now fails the install with the guest's sentence and stops the VM (as Stop installation does). Built green in builder-windows CI. The phone's "almost done" header above "Setup stopped" is still OPEN. |
| Info: offline start screen silent | FIXED | 4f9e3d664 | When pairing can't reach Flagship the failed code is taken down and the start screen says "Can't reach Flagship. Check this PC's internet connection; Studio keeps trying." (and "Waiting for an internet connection" offline). Test with your HTTP(S)_PROXY=127.0.0.1:9 trick. |
| Info: window close once left the process running; ISO path waits for a click | OPEN | | Close: please note steps if you see it again (1 of 4, not reproduced). The click on the installer path is by design for now. |
| W16: no Save installer in the Windows UI | NOTED | | By design for now (Simple/Advanced flash only); mark n/a. |
| W4 runbook: unreachable check needs FORCE_ISO | NOTED | | Use `FLAGSHIP_VM_FORCE_ISO=1` for that step. |

## Please rerun with the new build
W5, W6 (prebuilt host on production; expect it to come online), W8 (installer-ISO host with `FLAGSHIP_VM_FORCE_ISO=1`),
the rows they unblock (W9, W10 needs the owner, W11, W13, W14, W17), and W26's QEMU-kill half. W18, W19, W25 after the
phase B `.com` redeploy (main 0bfd3bf67 or later; webapp shell v204) — key-file import with an Android 0.3 key file should now sign in.

## Also new in this build (for your awareness, test if convenient)
- The voi.ci page is now managed at the top of the Messages tab (webapp shell v202 after the next `.com` deploy):
  Public switch with a one-time warning, Home and Settings point there, the Messages tab icon sits in a teal circle.
- Sample accounts will show an example page (read-only) once the operator publishes it.

## Cleanup
Your end-of-round list is right; delete the UpCloud device-test server and ISO storage when the server-dependent rows
are done (they are labelled `flagship-env=device-test`).
