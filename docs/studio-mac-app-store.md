# Flagship Studio in the Mac App Store

Status: **proposed** (2026-10-13). Nothing here is built yet.

## Decision

Split the Mac desktop app in two:

| App | What it does | Where it ships | Sandbox |
| --- | --- | --- | --- |
| **Flagship Studio** | Pairs with the phone, downloads the server appliance, hosts servers on this Mac | Mac App Store, and the same build notarized on flagshipserver.com | Yes |
| **Flagship USB Writer** | Pairs with the phone (or takes a recipe from Studio), prepares the installer and writes a USB stick for a dedicated box | flagshipserver.com only (Developer ID, notarized) | No (root helper) |

Most owners will run their server on the Mac they already have; that is
Studio's default path today and the one a store install, store review and
automatic updates help most. Moving to dedicated hardware is the advanced step,
and a separate download is acceptable there.

Windows and Linux Studio are unchanged: one app, hosting and USB burning.

## App Store Connect: a separate app, not "Add Platform"

Studio is its **own app record** (New App → macOS, bundle ID
`com.flagshipserver.Builder`). It is not added as a platform on the
Flagship phone app's record (`com.flagshipserver.app`):

- **Add Platform** on a record means the same product, under the same bundle
  ID, built for another OS (universal purchase). Studio is a different product
  with its own bundle ID, listing, screenshots and review.
- The two apps have opposite roles. The Flagship app is the owner's trust
  root and holds the account keys; Studio hosts servers and holds none.
  Separate apps keep them in separate sandboxes and separate reviews.
- The phone app on a Mac is a separate question. Apple silicon Macs can run
  the iPhone/iPad build as-is ("Designed for iPad"); that is a checkbox in
  App Store Connect (Pricing and Availability → iPhone and iPad Apps on Apple
  Silicon Macs), not Add Platform. Add Platform → macOS on the phone app's
  record would only be for a native Mac build of it. Decide that separately,
  after trying the iPad build on a Mac.

## Why the split is needed

Mac App Store guideline 2.4.5:

- (i) the app must be sandboxed;
- (v) it may not download or install code or resources that add features;
- (vi) it may not ask for root.

Studio today is not sandboxed (`apps/builder-mac/entitlements.plist` sets
`app-sandbox` false) because of USB burning:

- the burn writes `/dev/rdiskN` through a root helper registered with
  `SMAppService.daemon` (`FlagshipBuilderHelper`, `HelperProtocol.swift`);
- `diskutil` enumerates and unmounts the drives (`DiskEnumerator`, `DiskWrite`);
- the installer remaster runs a bundled `xorriso` (`Remaster.swift`,
  `Makefile`), which is GPLv3. The App Store's terms are widely held to be
  incompatible with the GPL, so it can't go in a store build.

Hosting needs none of that. Virtualization.framework works in the sandbox with
the `com.apple.security.virtualization` entitlement Studio already has, and NAT
networking needs nothing more. UTM is in the Mac App Store on the same basis.

## Flagship Studio (sandboxed)

### Keeps

- Phone pairing and recipe delivery (`BuilderPairing*`, `BuilderSessionClient`).
- Hosting: `ApplianceCache`, `Qcow2Expander`, APFS clones per server, `VZHost`,
  `VMManager`, the specializer seed, the hosted-servers sidebar and menu bar
  extra, graceful Stop/Restart/Quit (`HostPower`, `applicationShouldTerminate`).
- The debug console for servers created debug-friendly (serial attach, or SSH to
  the VM's NAT address with the grant's credentials). Same guardrail as today:
  never mount a production VM's disk.

### Drops (moves to USB Writer)

- The burn wizard, `DiskEnumerator`, `DiskWrite`, `HelperClient`, the helper
  target and `HelperDaemon.plist`.
- `Remaster` and the bundled `xorriso`.
- `WifiCredentialStore` (Wi-Fi is only for a metal box).
- The **installer fallback for hosting.** Today, when no published appliance
  fits, Studio remasters the Debian installer and installs into the VM. The
  store build is appliance-only: if no appliance fits, it says "This version of
  Studio needs an update to host a server" and stops. Both arches' appliances
  are published, so that only happens if `.com` names a ref no appliance was
  built from; publishing appliances with every release that changes the
  installer ref keeps it from happening.

### Entitlements

```
com.apple.security.app-sandbox            true
com.apple.security.network.client         true   (pairing relay, .com, appliance download)
com.apple.security.virtualization         true
com.apple.security.files.user-selected.read-only  true   ("I have a recipe" file drop)
```

Removed: `cs.allow-jit`, `cs.allow-unsigned-executable-memory`,
`cs.disable-library-validation`. They date from when Studio ran the Node
CLI; it now runs the preseed engine in an in-process `JSContext`, which needs
none of them.

### Behaviour inside the sandbox

- **Files.** `~/Library/Application Support/FlagshipBuilder/` resolves inside
  the container (`~/Library/Containers/com.flagshipserver.Builder/Data/...`),
  so `ApplianceCache` and the per-server disks move there with no code change.
  The `/tmp/flagship-builder-*.log` paths in `WizardModel` become
  `FileManager.default.temporaryDirectory`. There are no existing users, so no
  container migration is needed (if there were: `container-migration.plist`).
- **Running servers.** Servers run while Studio runs, as today. "Open at login"
  uses `SMAppService.mainApp`, only after the owner turns it on (2.4.5(iv)
  allows a login item with the user's consent). Quit still shuts the servers
  down before exiting.
- **Downloads.** The appliance is the guest's disk image, run inside the VM.
  It is not code that adds features to Studio (2.4.5(v)). Say so in the review
  notes.

### Two ways to get it, one build

The store build and the site download are the same sandboxed app with the same
bundle ID, signed for the store and with Developer ID respectively. Install one
or the other. Keeping a non-sandboxed "full" Studio on the site would mean
maintaining two Mac Studios; with the burn in USB Writer it has no reason to
exist.

## Flagship USB Writer (direct download)

This is today's Studio minus hosting: the burn wizard, Wi-Fi settings, the
remaster with bundled `xorriso` (shipped with its license and source offer, as
now), and the root helper.

- New bundle ID `com.flagshipserver.USBWriter`, and its own helper Mach name.
  The helper pins its caller's code signature to USB Writer's bundle ID
  (`kFlagshipAppBundleID` in `HelperProtocol.swift`) instead of Studio's.
- It pairs with the phone exactly as Studio does, so it works on its own.
- It is notarized, distributed from `/download/mac-usb`, and updated the same
  way Studio is today (`scripts/release-studio.sh` gains a second product).

Both apps build from the same Swift package. `FlagshipBuilderCore` stays
shared; the `FlagshipBuilder` executable target splits into two thin app
targets, each with only the views and services it uses, so the store build
contains no disk-writing or helper code at all.

## Handoff from Studio to USB Writer

Studio shows **Burn a USB stick for a dedicated box** next to Host here:

1. If USB Writer is installed
   (`NSWorkspace.urlForApplication(withBundleIdentifier:)`), Studio opens it
   with `flagship-usb-writer://burn#recipe=<base64url signed recipe>`.
   Opening another app by URL is allowed in the sandbox.
2. Otherwise it opens `https://flagshipserver.com/studio/usb` in the browser.
   Studio never downloads or installs USB Writer itself.

The recipe is secret-free and phone-signed
(`docs/recipe-delivery-and-remote-install.md`), so passing it in a URL exposes
nothing. USB Writer verifies its signature exactly as when the phone delivers
it and trusts nothing else in the URL. The Wi-Fi password is entered in USB
Writer, never passed in.

There is no XPC between the two apps, no shared app group and no
`temporary-exception` entitlement. A store app that talks to a helper
outside the store invites a 2.4.5 rejection, and the URL handoff needs none of it.

## Review

- **A reviewer can't pair without a phone.** The review notes give the demo
  account (`playstore-test-0725`, already shared with App Review) and the steps:
  install the Flagship iPhone app, sign in to the demo account, scan Studio's
  QR, Host here. Check that the demo account can host one more server.
- **Notes to include:** Studio runs Linux servers in Apple's virtualization
  framework; the downloaded file is the guest's disk image; Studio itself runs
  no downloaded code; USB Writer is an optional companion for people who want
  a dedicated box, and Studio is complete without it.
- **Risk:** low. The two most likely objections are the link to a
  download outside the store (precedent: Amphetamine and its Enhancer) and the
  phone requirement (answered by the demo account).

## Work, in order

1. Split the Swift package: two app targets on a shared core; Studio's target
   without the helper, disk, remaster or Wi-Fi code.
2. Sandbox Studio: entitlements above, temp paths, appliance-only hosting, and
   an "Open at login" setting. Run the whole host flow (pair → host → phone unlock →
   green padlock → quit with a server running) from a sandboxed build.
3. USB Writer: new bundle ID, helper re-pinned, URL handler, download page.
4. Release tooling: a store build (App Store Connect record, provisioning
   profile, `xcodebuild -exportArchive` with `app-store-connect` export) next
   to the notarized builds of both apps.
5. Submit with the review notes above.

## Open questions

- Should the site keep offering the sandboxed Studio, or send Mac users to the
  store only? Recommendation: keep both; some Macs are managed without the
  App Store.
- Minimum macOS: Studio is macOS 14. Review it under the minimum-OS rule
  before submitting (`AGENTS.md`, Conventions).
- Name: "Flagship USB Writer" is a placeholder.
