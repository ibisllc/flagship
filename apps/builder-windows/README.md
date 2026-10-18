# Flagship Studio — Windows

Flagship Studio is a .NET 8/WPF desktop application for pairing with a phone, verifying a signed server recipe, creating an unattended Debian or Ubuntu installer, writing it to USB, or hosting it locally with QEMU/WHPX. Published builds are self-contained and do not require Node.js or a separately installed .NET runtime.

## Security and runtime architecture

The Windows application keeps trust decisions native:

- `NativePairingCrypto.cs` and `PairSession.cs` implement relay pairing with native WebSocket and audited platform cryptography.
- `Recipe.cs` verifies the phone's Ed25519 signature before installer generation. An invalid, expired, or malformed recipe fails closed.
- `NativePreseedEngine.cs` executes the canonical `packages/flagship-builder/engine/preseed-engine.js` embedded as an application resource. Jint is pinned and constrained by memory, statement, and execution-time limits. No CLR, filesystem, network, process, or environment objects are exposed to the script.
- Shared `preseed-vectors.json` tests require byte-identical Debian preseed and Ubuntu user-data output across the canonical TypeScript engine and Windows.
- `NativeIsoRemaster.cs` detects Debian versus Ubuntu, patches GRUB/isolinux, and invokes xorriso with an argument list rather than a command shell. Cancellation kills the complete process tree and diagnostics are bounded.
- `NativeBuildPipeline.cs` re-verifies recipe bytes, generates both installer formats, remasters a temporary ISO, and calls the native `DiskWrite.cs` raw-device writer. Sensitive input buffers and temporary images are cleaned up.

The optional prebuilt-appliance shortcut is not used on Windows. Host Here follows the same native installer-ISO path as USB preparation.

## User flows

- Pair with phone: Studio shows a scannable QR and SAS confirmation. Recipe paste, browse, and drag-and-drop remain available as recovery paths.
- Simple USB: downloads and SHA-256 verifies the manifest-selected Debian base ISO, then remasters and writes it natively.
- Advanced USB: remasters a user-supplied stock Debian or Ubuntu ISO.
- Save installer: writes a personalized `.flagship.iso` without touching a disk.
- Host Here: creates and installs a QEMU/WHPX VM using the same personalized ISO.

Raw USB writes require elevation. `app.manifest` therefore requests administrator access and `DiskWrite` permanently rejects `PhysicalDrive0` and non-removable targets.

## xorriso

ISO remastering requires the native xorriso executable. Resolution order is:

1. `FLAGSHIP_XORRISO`, for an explicit executable path.
2. `tools\xorriso.exe` beside the published application.
3. `C:\msys64\usr\bin\xorriso.exe` for development machines using MSYS2.
4. `xorriso` on `PATH`.

Release packaging should place the approved Windows xorriso build at `tools\xorriso.exe`. Node.js, npm, and the repository checkout are not runtime dependencies.

## Build and test

```pwsh
powershell.exe -ExecutionPolicy Bypass -NoProfile -File apps/builder-windows/make.ps1
dotnet test apps/builder-windows/tests/FlagshipBuilder.Tests.csproj -c Release
dotnet build apps/builder-windows/FlagshipBuilder.csproj -c Release
dotnet publish apps/builder-windows/FlagshipBuilder.csproj -c Release -r win-x64 --self-contained true
```

The test project targets plain `net8.0`, so platform-independent parsing, cryptography, generator-vector, remaster-transform, and VM-core tests also run on Linux/macOS CI.

## Source layout

```
apps/builder-windows/
  FlagshipBuilder.csproj
  app.manifest
  src/
    App.xaml(.cs)              WPF application resources
    MainWindow.xaml(.cs)       window, pairing cover, drag/drop and VM actions
    Wizard.cs                  view model and native pipeline orchestration
    NativePairingCrypto.cs     X25519/HKDF/AES-GCM pairing primitives
    PairSession.cs             native relay pairing state machine
    Recipe.cs                  recipe parsing and Ed25519 verification
    NativePreseedEngine.cs     constrained embedded canonical generator
    NativeIsoRemaster.cs       xorriso discovery, detection and remastering
    NativeBuildPipeline.cs     verified recipe → prepared ISO → optional USB
    DiskEnumerator.cs          removable-drive discovery and safety filtering
    DiskWrite.cs               elevated raw-device writer
    IsoManifestClient.cs       base-image manifest contract
    IsoBaseCache.cs            verified base-image download/cache
    VM/                        QEMU/WHPX host implementation
  tests/                       portable xUnit suite and shared golden vectors
```

## Publishing and signing

`make.ps1 publish` produces the self-contained Windows output. `make.ps1 sign` signs it when `FLAGSHIP_SIGN_CERT_THUMBPRINT` and Windows `signtool.exe` are available. Release artifacts must include the approved xorriso tool directory and should be code-signed and timestamped.

## License

BUSL-1.1 — see the repository root.
