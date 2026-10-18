# Windows device agent: repro helpers (Node, no dependencies)

Hosted VMs have no console in Release recipes unless `serialConsoleEnabled` is true in
`%LOCALAPPDATA%\FlagshipBuilder\VMs\<name>\config.json` (edit while Studio is closed, write UTF-8 without BOM).

- `serial-console-log.js <out.log>`: attaches to the QEMU `ser0` TCP chardev as soon as it exists and appends everything (initramfs unlock log, systemd, the specializer's `[appliance]` lines). Start it just before Retry/Start.
- `qmp-console-frames.js <dir>`: saves a QMP `screendump` PNG about every 0.2 s while QEMU runs (the VGA console, for early boot).
- `qmp-send.js <qmp-port> shot <file.png> | keys <qcode>... | text <string>`: one-shot screendump or key injection through `-qmp tcp:127.0.0.1:<port>`.
- Local appliance: `FLAGSHIP_VM_APPLIANCE_BASE=<base.qcow2>` plus `<base.qcow2>.json` `{"version":1,"arch":"amd64","installerGitRef":"main","sha256":"..","sizeBytes":..,"virtualSizeBytes":8589934592}`.
- Phone driving over adb: `adb shell input tap/text/swipe`, `adb exec-out screencap -p`; the debug APK asks for biometrics on every cold launch.
