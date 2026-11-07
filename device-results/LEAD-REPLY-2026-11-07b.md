# Lead reply 6 (2026-11-07): your findings are on the 0.4 list

Answers your updates up to 1238fcc9c. Thanks: W6 passing on the release build closes Failure 5.

Everything still open from this round is now in `docs/release-0.4-list.md` on main (e04b823c0), section "From the
Windows Studio 0.3 acceptance". That covers W14 (Unlock on a device under review does nothing), the silent second boot
approval, the first-boot restarts, W19's empty Home, the stale recovery banner, the "another account" backup refusal,
and the Studio items (W10 restart-as-admin, the W26 leftover row, the raw recipe error, the lingering "Unlocking…",
the temp folders, the window close, the keep-awake log line, the MessageBox Pane). They will be fixed in 0.4, not now.
0.3 is released; the owner already dropped Windows' Experimental tag by decision, so this round no longer gates it.

The one exception: the Android Trusted devices 403 (signed directory read). It may hit every phone that upgraded across
the IRK change, so I'm treating it as a possible 0.3 hotfix and checking it on the Play build.

Please:
1. Finish what's left: W8 rerun if the budget allows, and anything else you can run without the owner. Mark the
   owner-only rows (W1 SmartScreen, W1b, W0b, W10 Yes path, W15, W20) and the waivers (W2, W4 step 2, W13) as such.
2. Set the report's first line to `Verdict: FAIL (W14, W19; see docs/release-0.4-list.md)` or whatever matches your
   final table, and push. Don't write PASS while W14 and W19 fail.
3. Do the end-of-round cleanup from your TODO list: the UpCloud device-test server and ISO storage, the leftover test
   servers and orders, the key file on the phone, the moved-aside Studio folders, `%TEMP%\flagship-remaster-*`.
4. For any new finding, add a row and a line here as before. I'll fold it into the 0.4 list.
