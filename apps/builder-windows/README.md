# Flagship Studio — Windows app

WPF + .NET 8. The Windows sibling of `apps/builder-mac`, sharing the design
language (teal `#14B8A6`, the mark, the same information architecture). It has
grown from the USB builder into the full desktop appliance app; it now spans the
whole flow:

- **Pair with your phone** — the QR + short-code cover; the phone scans, both
  confirm a SAS, and the recipe is delivered over the live relay. Drives the
  shared `flagship-build pair` CLI (`--emit-events`); the drop-a-recipe-file
  path remains as a manual fallback.
- **Burn to USB** — write the recipe's unattended installer to a USB drive
  (the original builder; see the two modes below).
- **Host on this PC** — run the recipe as a phone-gated, encrypted Linux VM
  appliance under **QEMU + WHPX** (`src/VM/`): the pure VM core (mirrors the
  Mac slice, pinned by `apps/desktop-shared/golden/vm-core-vectors.json`), the
  QEMU+WHPX backend, a hosted-servers sidebar, and per-server start/stop.
- **SSH / console into a debug VM** — a VM created from a debug-grant recipe
  exposes a serial console and an "Open in SSH" affordance (a loopback
  hostfwd to the guest's `:22`). Reachable straight from the **sidebar**:
  right-click or the ⋯ menu on a hosted server → *Open in SSH* / *Open
  console*, or double-click the row to SSH in. This only ever wires up SSH to
  a VM this app is **hosting locally** (`127.0.0.1:<fwd>`) — it never relays
  SSH to a box deployed elsewhere. A production VM gets neither console nor SSH
  — the guardrail is the phone-signed grant, enforced in `QemuCommandLine`.

See `docs/desktop-vm-appliance.md` for the design and `e2e/README.md` for the
end-to-end VM-boot harness + what's proven vs. open.

## Burn-to-USB modes

Two modes, switchable via the link in the header:

- **Simple (default)** — bring only a recipe. The builder fetches the stock
  Flagship **Debian-netinst base ISO per the server manifest**
  (`POST /api/iso-manifest`), caches + sha256-verifies it, then runs the *same*
  remaster + flash path Advanced uses — the recipe preseed is baked into the
  fetched base, then flashed. No user ISO. The base is downloaded once and
  reused for every later server.
- **Advanced** — bring a stock Debian/Ubuntu ISO + a recipe; the builder shells
  out to the `@flagship/builder` Node CLI (`packages/flagship-builder/`) to
  remaster *your* ISO with the recipe preseed + flash it to USB.

### The base-ISO manifest (Simple mode)

The builder is a **dumb executor**. On a Simple bake it:

1. Inspects the cached base ISO (if any) and computes its SHA256 — logging the
   path + sha.
2. POSTs `{ platform: "windows", builderVersion, current: {version, sha256} |
   null }` to `https://flagshipserver.com/api/iso-manifest`.
3. The server replies with exactly one of `{ download: {url, sha256, version,
   sizeBytes, attestation} }` or `{ download: null }`.
4. If `download` is non-null → fetches `download.url` (the URL is shown under
   the progress bar), stream-verifies the bytes' SHA256 against
   `download.sha256` (mismatch → delete + error), caches the verified ISO under
   `%LOCALAPPDATA%\flagship-builder\flagship-base-<version>.iso`, and logs
   `downloaded <path> sha256=<hex> from <url>`.
5. If `download` is null → keeps the cached base.

The builder never decides "do I already have this?" by comparing shas itself —
it reports `current`, obeys the server's directive, and verifies the bytes it
downloads. Mirrors the macOS (`IsoManifestClient.swift` / `IsoBaseCache.swift`)
and Linux (`iso_manifest_client.py` / `iso_base_cache.py`) siblings.

## What it does

1. **Recipe** — drag in (or click and pick) the signed JSON the website
   produces after the phone scans the QR code. The GUI parses + verifies the
   Ed25519 signature **locally** and shows the server-domain + expiry.
2. **Ubuntu Server ISO** *(Advanced only)* — drop a stock Debian/Ubuntu ISO.
   The builder remasters it with the recipe preseed. In Simple mode this row is
   hidden; the base comes from the server manifest instead.
3. **USB Drive** — pick a USB drive from a read-only list. Only removable
   drives in the 500MB–500GB band appear; internal SSDs, NVMe boot drives,
   and oversized disks are hidden by design. `\\.\PhysicalDrive0` is the
   system disk on every Windows install and is permanently blocked.
4. **Bake** — Simple mode first runs a one-time base-image download phase (URL
   shown under the bar), then invokes the CLI's `write` subcommand (remaster +
   raw-write) on the cached base; Advanced mode runs `write` directly on the
   user ISO. Both stream stdout/stderr into the log drawer. The
   `requireAdministrator` UAC manifest lets the raw open succeed without a
   second prompt.

## Requirements

- **.NET 8 SDK** (build only — runtime is bundled in published builds).
- **Node.js 20+** — required (the CLI remaster path). The locator finds
  `node.exe` in `%ProgramFiles%\nodejs\`, `%LocalAppData%\Programs\nodejs\`,
  or on `PATH`.
- **Windows 10 1809+** or **Windows 11**. The manifest declares both.
- **`wmic.exe`** (every Win10/Win11 install) or **PowerShell 5.1+**
  with `Get-PhysicalDisk` (fallback when wmic is removed in some
  Win11 SKUs). The disk enumerator tries wmic first then falls back.

## Build + run

```pwsh
# Build (Debug) + run tests in one shot:
powershell.exe -ExecutionPolicy Bypass -NoProfile -File apps/builder-windows/make.ps1

# Just build:
dotnet build apps/builder-windows/FlagshipBuilder.csproj

# Just tests (works on macOS/Linux too — tests target net8.0, no WPF):
dotnet test apps/builder-windows/tests/FlagshipBuilder.Tests.csproj
```

Or via the batch wrapper:

```bat
apps\builder-windows\build.bat
apps\builder-windows\build.bat test
apps\builder-windows\build.bat publish
```

To override the CLI entry during development (e.g. for testing against
a checked-out branch):

```pwsh
$env:FLAGSHIP_BURN_ENTRY = "C:\path\to\packages\flagship-builder\src\cli.ts"
$env:FLAGSHIP_NODE_PATH  = "C:\Program Files\nodejs\node.exe"
dotnet run --project apps/builder-windows/FlagshipBuilder.csproj
```

## Publish (self-contained .exe)

```pwsh
powershell.exe -ExecutionPolicy Bypass -NoProfile -File apps/builder-windows/make.ps1 publish
# → apps/builder-windows/dist/FlagshipBuilder.exe (single-file, ~70MB)
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
   powershell.exe -ExecutionPolicy Bypass -NoProfile -File apps/builder-windows/make.ps1 sign
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
FlagshipBuilder.csproj   net8.0-windows + WPF
app.manifest            UAC requireAdministrator + DPI awareness
src/
  App.xaml(.cs)         WPF resource dictionary (FB design tokens)
  MainWindow.xaml(.cs)  single window + drag/drop wiring + converters
  Wizard.cs             view-model (INotifyPropertyChanged)
  CliRunner.cs          spawn Node CLI, stream stdout/stderr lines
  CliLocator.cs         find node.exe + the @flagship/builder CLI entry
  DiskEnumerator.cs     wmic + PowerShell parser + safety classifier
  VerifyResult.cs       decode CLI verify JSON (tolerant of prefix noise)
  IsoManifestClient.cs  POST /api/iso-manifest (the locked wire contract)
  IsoBaseCache.cs       manifest-driven base-ISO cache + sha256-verified download
tests/
  FlagshipBuilder.Tests.csproj  xunit; net8.0 (no WPF) → portable
  DiskEnumeratorTests.cs  classifier rules + wmic/PS parser smoke
  VerifyResultTests.cs    JSON tolerance
  CliLocatorTests.cs      env override + parent-climb discovery
  CliArgsTests.cs         argv-vector shapes (must match cli.ts vocab)
  WizardStateMachineTests.cs  readiness / CanBake rules (Simple + Advanced)
  IsoManifestClientTests.cs   request/response contract + stubbed round trip
  IsoBaseCacheTests.cs        keep / download+verify / sha-mismatch (temp dir)
  CliArgsShim.cs          mirror of Wizard.cs::CliArgs (kept in sync by hand)
```

The split keeps every CLI-driving and wmic-parsing function in source
files that compile against net8.0 (no WPF), so `dotnet test` runs on
any OS the SDK supports.

## License

BUSL-1.1 — see repo root.
