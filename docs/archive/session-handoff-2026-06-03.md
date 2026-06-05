# Session handoff — 2026-06-03 (cert model · recovery · pending servers · Alpine UEFI · bare-metal boot)

Durable cross-machine handoff (memory is machine-local; this doc travels). Read
top-to-bottom. Most of the app/web/cloud work shipped + **deployed**; the
hardware/burner thread is mid-investigation.

## Shipped + DEPLOYED to production this session
Worker `flagship-com` + Fly `flagship-services` both deployed (health 200 on both).
- **Cert model reworked** (iOS + webapp + Android): creation now asks a **binary**
  — "my devices renew it" (managed, default) vs "this server renews its own"
  (autonomous). The renewal **window moved to an account-wide "Certificate
  validity" setting** (default 30, presets 7/30/90; `CertValidityStore` on each
  surface). Managed blobs stamp `offlineWindowDays` from it — wire format
  unchanged. **LLM-preferences field removed** from creation. Backup phone-disk
  caveat added.
- **Recovery Phase B (backend)**: single-device re-pair grace **7d → 3d**
  (`rePair.ts`); the wrapped-UMK fetch now returns **`registeredIrkPubHex`**
  (`webauthnRecovery.ts`) for rotation detection. iOS captures it +
  `recoveredKeyMatchesRegistered()` helper + Mock parity (consumer wiring is
  still TODO — see Open #1).
- **`/og`** social-card mark flipped to teal; **`/ready`** rewritten (recommended
  = recipe + burner in one box; advanced = bring-your-own ISO; the website-built
  image path removed).
- **Webapp no-server states**: empty home instead of "couldn't load"; "please add
  your first server" on build-a-service; marketplace "coming soon".
- **iOS**: Apps→**Services** rename; settings cluster (dev menu gated on MOCK,
  removed the duplicate mock add-control-device + Face-ID gate on the real
  add-device, recovery copy phone→device); **pending servers persist** across
  app restart + cancel-from-list.

Gates: web 978 · apps/com+control-plane 1108 · iOS 755 · Android (CertValidity 4
+ InstallBlob 13) · `tsc -b` clean.

## Code done but NOT shipped
- **Alpine ISO builder UEFI fix** (`scripts/build-flagship-iso.sh`): the old
  build re-packed BIOS-only and **silently dropped Alpine's UEFI boot entry** —
  which is why a UEFI box never listed the stick. Replaced the extract+repack
  with `xorriso -boot_image any replay` → true BIOS+UEFI hybrid + apkovl injected.
  **Empirically verified** on a locally-built ISO (`xorriso -report_el_torito`
  shows both BIOS + UEFI; apkovl present). NOT yet: re-run the reproducible-build
  CI, rebuild + upload to R2, bump the burner's pinned sha (see Open #5).

## OPEN tasks (the to-do)
1. **Recovery Phase B — re-pair branch (needs on-device validation).** Wire
   `recoveredKeyMatchesRegistered` into the post-recovery completion: recovered
   IRK == registered → instant pair (Phase A); != → re-pair with
   `oldIrkPub = registeredIrkPubHex` + 3d grace. Also `KeyfileImportViewModel`
   instant skip-grace. Backend (the fetch field + 3d grace) is already deployed.
2. **Alpine bare-metal boot.** UEFI fix DONE + proven: the stick now appears in
   the UEFI boot menu and boots Alpine. BUT on the test box Alpine's initramfs
   USB stack doesn't come up — dead keyboard + "mounting boot media failed" →
   initramfs emergency shell → falls through to the internal Debian. Boot cmdline
   is stock `modules=loop,squashfs,sd-mod,usb-storage` (no host-controller
   modules). NEXT (blind-iterable, no shell needed): rebuild adding
   `xhci_pci`/`xhci_hcd`/`uas` to the cmdline, re-burn, observe how far it gets.
   May need a module Alpine's initramfs doesn't ship (real stopping point) or a
   different test box.
3. **Burner "Quick" mode points at the DEAD Alpine path** (`BurnerMode.swift`:
   quick → `AlpinePersonalize` + a base ISO that's BIOS-only / not rebuilt). Until
   Alpine boots on real hardware, retire/repoint Quick to the working
   Debian-preseed flow so it isn't the default.
4. **Debian preseed flakiness.** Earlier the bare-metal Debian burn landed in the
   manual partitioner ("No root file system defined" = preseed didn't run); a
   later boot reached `flagship-pod login:` (= the preseed DID run + installed +
   booted — `flagship-pod` is OUR preseed/cloud-init hostname). So the
   cmdline-injection may be per-ISO flaky. Trace `Remaster.swift`'s grub/isolinux
   patch vs the exact Debian ISO. (Possibly already working — verify the box
   registered + got a cert.)
5. **Ship the Alpine UEFI fix**: reproducible-build CI re-run → rebuild ISO →
   upload to R2 (`flagship-alpine-base.iso`) → bump `BaseIsoCache.version` +
   `sha256Hex` → rebuild + reinstall the signed Mac burner.
6. **`/ready` copy** still frames "the Flagship base image" (Alpine) as
   recommended — stale; the working recommended path is Debian-preseed. Update.

## Bare-metal box state (reference)
- Internal disk holds a half-installed Flagship-Debian under LUKS. If it was
  preseed-installed, the placeholder passphrase is
  `flagship-burn-time-luks-rekey-me-immediately` (Mac burner) or
  `flagship-firstboot-placeholder` (installer-netboot). It's still the
  placeholder ⇒ first-boot never completed (it re-keys on first boot). The disk
  gets wiped on the next install regardless — no passphrase needed to move on.

## DESIGN DECISIONS pending (home session — no hardware/sim needed)
- **Alpine vs Debian direction.** Alpine UEFI-boots but is blocked at the
  initramfs USB-driver layer on real hardware; Debian boots + autoinstalls + has
  reached a login. Decide: keep Debian as the shipping default and treat Alpine
  as a later footprint optimization, or invest in the Alpine initramfs USB work?
- **Burner UX.** Retire "Quick"/Alpine as the default until USB-driver is solved;
  make Debian-preseed the recommended path; reconcile recommended-vs-advanced on
  `/ready` and in the burner accordingly.
- **Personalized-ISO trailer vs GPT.** Appending the recipe trailer past the
  isohybrid backup-GPT may break strict UEFI. Decide: relocate the backup GPT
  after append (`sgdisk -e`) vs inject the recipe as an in-ISO file (needs the
  box-side trailer-finder to change).
