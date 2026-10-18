# Device results: windows, 2026-10-17
Build: studio-release run 38844687451 (0.1.3, main, 2026-10-16) unzipped; repo at main 932fb603e   OS: Windows 11 Home 10.0.26200   Hardware: i5-14400F, 16 GB, hypervisor present

| # | Check | Result | Time | Notes / evidence |
|---|-------|--------|------|------------------|
| W1 | npm ci + npx tsc -b | pass | | exit 0 |
| W2 | make.ps1 test (.NET) | pass | 3 s | 269/269 |
| W2 | make.ps1 publish | pass | | dist\FlagshipBuilder.exe built |
| W2 | CI zip contents | pass | | `Flagship Studio.exe` + `tools\xorriso.exe` present |
| W-vt | vitest run on Windows | n/a (host noise) | 204 s | 92 files / 554 tests fail, all Windows-host test issues, see below |
| W2.1-2.8 | Studio pairing, hosting, restart, sleep, USB | blocked | | need Harry: phone, SmartScreen click-through, ~2.5 GB download, USB stick |
| W-web | Webapp walk (Edge/Chrome) | blocked | | needs phone approval |
| W-rem | Remote QR | blocked | | needs phone |
| W-bak | Backup to PC + import | blocked | | needs phone + disposable server |

## vitest failures on Windows (not product failures; the box runs Debian)
- `EPERM: operation not permitted, fsync` (directory fsync in `durableFile.ts` as used by tests): ~40 server-daemon test files (serviceAccess, appCopy, inviteTiers, memberRoles, accessSync ...).
- CRLF from git autocrlf vs expected LF: updateClient, canonicalBytesVectorsFresh, userdata, demoCloudConfig, dataLayerStack, serverShareAcceptAdmin vectors `--check`.
- POSIX-only: `bash -n`, `sleep`, `npx` spawn, symlink EPERM, `/var/...` path vs `\var\...`, file mode 438 vs 384.
- build-eval staticCheck python SyntaxError text differs (`/app\app.py`).
- Suggest: run the daemon suite in WSL/Linux CI only; add `.gitattributes` `eol=lf` for vectors/units if Windows checkouts matter.

## Runbook problems
None changed.
