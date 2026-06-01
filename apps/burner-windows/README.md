# Flagship Burner — Windows GUI

WPF + .NET 8. UX matches `apps/burner-mac/` and `apps/burner-linux/` 1:1:
one window, drop-rows, big Bake button, collapsed log drawer. Two flows,
toggled in the header:

- **Quick (default)** — the burner OWNS the Alpine pipeline. It caches the
  stock Flagship Alpine base ISO ONCE under
  `%LOCALAPPDATA%\flagship-burner`, appends the phone-signed recipe as a
  trailer LOCALLY (byte-identical to the server's
  `iso-personalizer/streamPersonalize`), and raw-writes the result to USB.
  No per-server 240 MB download, no user-supplied ISO, **no Node** — recipe
  verify (Ed25519) + personalize + flash are all native C#.
- **Advanced** — bring a stock Ubuntu/Debian ISO + a recipe; the burner
  shells out to the `@flagship/burner` Node CLI (`packages/flagship-burner/`)
  to remaster + flash, exactly as before.

## What it does (Quick mode)

1. **Recipe** — drag in (or click and pick) the signed JSON the website
   produces after the phone scans the QR code. The GUI parses + verifies the
   Ed25519 signature **locally** and shows the server-domain + expiry.
2. **USB Drive** — pick a USB drive from a read-only list. Only removable
   drives in the 500MB–500GB band appear; internal SSDs, NVMe boot drives,
   and oversized disks are hidden by design. `\\.\PhysicalDrive0` is the
   system disk on every Windows install and is permanently blocked.
3. **Bake** — runs three phases with a live progress bar:
   - **download** (first run only) — the base ISO is fetched + sha256-verified.
     The bar fills **orange** with a "won't happen again" caption; every
     server after this reuses the cache.
   - **personalize** — the recipe trailer is appended to a copy of the base;
     the ISO9660 PVD volume-size is patched so the box's
     `volumeSpaceSize × logicalBlockSize` find lands exactly on the trailer.
   - **write** — the prepared, sector-aligned image is locked + dismounted
     off its volumes and raw-written to `\\.\PhysicalDriveN`; the bar fills
     in the accent color. The `requireAdministrator` UAC manifest lets the
     raw open succeed without a second prompt.

   In **Advanced** mode, Bake instead invokes the CLI's `write` subcommand
   and streams its stdout/stderr into the log drawer.

## Requirements

- **.NET 8 SDK** (build only — runtime is bundled in published builds).
- **Node.js 20+** — only for **Advanced** mode (the CLI remaster path).
  Quick mode is fully native C# and needs no Node. When present, the
  locator finds `node.exe` in `%ProgramFiles%\nodejs\`,
  `%LocalAppData%\Programs\nodejs\`, or on `PATH`.
- **Internet** on the first Quick-mode bake (one-time base-ISO download;
  cached thereafter under `%LOCALAPPDATA%\flagship-burner`).
- **Windows 10 1809+** or **Windows 11**. The manifest declares both.
- **`wmic.exe`** (every Win10/Win11 install) or **PowerShell 5.1+**
  with `Get-PhysicalDisk` (fallback when wmic is removed in some
  Win11 SKUs). The disk enumerator tries wmic first then falls back.

## Build + run

```pwsh
# Build (Debug) + run tests in one shot:
pwsh apps/burner-windows/make.ps1

# Just build:
dotnet build apps/burner-windows/FlagshipBurner.csproj

# Just tests (works on macOS/Linux too — tests target net8.0, no WPF):
dotnet test apps/burner-windows/tests/FlagshipBurner.Tests.csproj
```

Or via the batch wrapper:

```bat
apps\burner-windows\build.bat
apps\burner-windows\build.bat test
apps\burner-windows\build.bat publish
```

To override the CLI entry during development (e.g. for testing against
a checked-out branch):

```pwsh
$env:FLAGSHIP_BURN_ENTRY = "C:\path\to\packages\flagship-burner\src\cli.ts"
$env:FLAGSHIP_NODE_PATH  = "C:\Program Files\nodejs\node.exe"
dotnet run --project apps/burner-windows/FlagshipBurner.csproj
```

## Publish (self-contained .exe)

```pwsh
pwsh apps/burner-windows/make.ps1 publish
# → apps/burner-windows/dist/FlagshipBurner.exe (single-file, ~70MB)
```

This produces a self-contained, ReadyToRun, single-file `.exe`. No
.NET runtime install required on the target machine.

## Sign

`make.ps1 sign` is wired but no-ops without a cert. To sign for real:

1. Acquire an EV or OV code-signing certificate (DigiCert, SSL.com,
   Sectigo).
2. Install the Windows SDK (ships `signtool.exe`).
3. Set the thumbprint env var:
   ```pwsh
   $env:FLAGSHIP_SIGN_CERT_THUMBPRINT = "ABCD1234..."
   pwsh apps/burner-windows/make.ps1 sign
   ```

The script signs with SHA-256 + RFC 3161 timestamp from DigiCert.

## UAC manifest

`app.manifest` declares `requireAdministrator`. The OS shows the
yellow-shield consent dialog on launch instead of failing later with
cryptic ACCESS_DENIED errors from `\\.\PhysicalDrive*`. Same approach
Rufus and balenaEtcher use.

If you'd rather elevate per-write (asInvoker default + a `runas`
wrapper around the CLI), drop the `requireAdministrator` line and
spawn `node` via `Process.Start` with `Verb = "runas"` — the CLI
itself doesn't need admin for the `verify` / `prepare` paths.

## Architecture

```
FlagshipBurner.csproj   net8.0-windows + WPF
app.manifest            UAC requireAdministrator + DPI awareness
src/
  App.xaml(.cs)         WPF resource dictionary (FB design tokens)
  MainWindow.xaml(.cs)  single window + drag/drop wiring + converters
  Wizard.cs             view-model (INotifyPropertyChanged)
  CliRunner.cs          spawn Node CLI, stream stdout/stderr lines
  CliLocator.cs         find node.exe + the @flagship/burner CLI entry
  DiskEnumerator.cs     wmic + PowerShell parser + safety classifier
  VerifyResult.cs       decode CLI verify JSON (tolerant of prefix noise)
tests/
  FlagshipBurner.Tests.csproj  xunit; net8.0 (no WPF) → portable
  DiskEnumeratorTests.cs  classifier rules + wmic/PS parser smoke
  VerifyResultTests.cs    JSON tolerance
  CliLocatorTests.cs      env override + parent-climb discovery
  CliArgsTests.cs         argv-vector shapes (must match cli.ts vocab)
  WizardStateMachineTests.cs  readiness / CanBake rules
  CliArgsShim.cs          mirror of Wizard.cs::CliArgs (kept in sync by hand)
```

The split keeps every CLI-driving and wmic-parsing function in source
files that compile against net8.0 (no WPF), so `dotnet test` runs on
any OS the SDK supports.

## License

BUSL-1.1 — see repo root.
