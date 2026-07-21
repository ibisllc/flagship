# Flagship Studio — host a server in the app (encrypted, phone-gated VM appliance)

> **Status: SHIPPING, fast-provisioning redesign locked 2026-07-20.** Mac,
> Linux, and Windows host implementations exist. The current per-server Debian
> install remains a compatibility path while the generalized encrypted appliance
> image below is built and validated. The missing physical proof is a fresh image
> reaching sealed boot, phone approval, registration, and a green padlock.

## Vision

Let people run a **real Flagship server on hardware they already own** (a Mac mini,
a spare PC, a home Linux box) via a **signed desktop app**, not just by building a
dedicated USB-burned box — **without giving up the security promise**.

The desktop app is the builder **evolved**, not replaced. One app, one pairing flow,
one trust anchor, two destinations for the same recipe:

- **Burn to USB** → dedicated bare-metal appliance (today's flow).
- **Host here** → a managed, **encrypted, phone-gated Linux VM appliance** running on
  this machine (new).

Same recipe, same daemon, same phone-unlock — just written to a VM disk instead of a
USB. Rename the app from "the Builder"/"Builder" to **Flagship Studio** (build a
box *or* run one here).

## Decisions (and why)

1. **Level B — a managed VM appliance, not a native `curl | sh` install.** Running the
   daemon natively on the host (or via a `curl | sh` script) is easy but a security
   *downgrade*: keys sit in plaintext on a general-purpose OS, no phone-gated unlock.
   Running the **existing appliance image inside a managed, encrypted VM** keeps the
   security model — encrypted at rest + phone-gated unlock + full containment — so this
   is a **first-class, on-brand path**, not a watered-down trial tier.

2. **Signed native app, never `curl | sh`.** For a security brand, telling people to
   pipe curl into bash is off-brand and the security-literate recoil. A **notarized,
   code-signed** app is a far stronger trust story, is GUI-easy for a non-technical
   owner, and **visibly differentiates us from OpenClaw-style installers** (which are
   `curl | sh`). The current builder is already code-signed (Developer ID, notarizable,
   privileged helper) — we extend it.

3. **"The appliance, virtualized."** Maximal reuse: the builder already builds the
   Debian appliance image; the VM path writes that same image to a VM disk and boots
   it. The daemon runs **unmodified** (normal Linux env — no macOS launchd /
   `systemctl`-skip adaptation), and the phone-gated LUKS unlock runs **verbatim**
   inside the guest (VM boots → initramfs → phones home → phone approves; the host app
   never holds the key).

## Security model + honest tiering

The brand claim is **"the most built-in safety possible in software you run on your own
machine"** — with the dedicated box still the gold standard. Ordering:

> **bare-metal appliance  >  VM appliance on a clean host  >  native install on a shared host**

- The VM appliance is **far** more secure than any curl/native self-host: encrypted at
  rest (guest LUKS + host FDE/FileVault on top), phone-gated unlock, fully contained
  (its own network namespace → no host port clashes), one signed app.
- **Honest ceiling:** a VM runs on a general-purpose OS the owner also uses for
  everything else. Host-root malware could, in principle, read the *unlocked* VM's
  memory or keylog the approval. So it is not equal to the dedicated bare-metal box
  (where the host *is* the appliance, nothing untrusted underneath). State this plainly;
  it reinforces the appliance rather than cannibalizing it.
- **Per-server tier badge** in the app (and, later, optionally on the phone): "Appliance
  (hardware)" vs "Appliance (hosted VM)" — keep the security story *legible*, never
  silently equivalent.
- **Preserved on every tier:** TLS terminates on the user's box, `.services` stays a
  blind relay, phone-held routing (RCK) + recovery.

## Per-OS plan + sequencing

Achievable on all three, but **not with uniform effort or uniform security**. Sequence
**Mac → Linux → Windows**, post-launch.

- **macOS — clean, the flagship platform.** Apple **Virtualization.framework** (VZ) —
  first-party, what OrbStack/Docker Desktop use. A signed app (+ the virtualization
  entitlement) boots + manages a Linux VM, runs the appliance image, reuses the
  phone-gated unlock. Encrypted at rest = guest LUKS + FileVault (default-on on a Mac
  mini). This is the reference implementation.
- **Linux — straightforward on bare metal (KVM/QEMU/libvirt).** Full control (custom
  kernel, initramfs, LUKS, phone-unlock), best performance. Caveat: on a **VPS** without
  nested virtualization, the VM path won't run → fall back to native (weaker) or decline.
  Not the target (target is bare-metal home boxes).
- **Windows — feasible, the weak link for the FULL model.** WSL2 is easy but boots
  Microsoft's kernel with no custom initramfs → **cannot do the phone-gated LUKS-at-boot
  flow**. A **full bundled VM** (QEMU/WHPX or Hyper-V) can, but is heavier and varies by
  edition (Home lacks full Hyper-V; enabling virtualization features; hypervisor
  conflicts). Windows ships last and may launch a reduced tier initially.

The VM management is inherently per-OS (VZ / WHPX-Hyper-V / KVM); expect per-OS VM
backends behind a shared control/UI layer. The current builder is Mac-only Swift, so the
cross-platform desktop app is new surface.

## App UX / layout

- **Left (main, larger area):** starts with the **QR + short-code pairing cover exactly
  as today** — pair your phone, receive a recipe. From the delivered recipe the user
  chooses **Burn to USB** or **Host here**. During/after a host action this area shows
  the selected server's detail (status, bring-up progress, logs, controls).
- **Right sidebar:** lists the **servers hosted in this app** (the "servers on this
  machine" dashboard) — each with its name, tier badge, and live status
  (running / stopped / waiting-for-phone-unlock / coming-online / live). Selecting one
  opens its detail in the main area. A "＋ / pair a new server" entry returns the main
  area to the QR cover.

## Multi-server hosting

**Allowed** — VMs are independent appliances, so N-per-machine is natural and useful
(multiple identities; dev/test; **family hosting** on one always-on Mac mini). Rules:

- **Single is the default + encouraged**; multi is power-user/family framing.
- Each hosted server is its **own phone-gated appliance** with its own
  recipe/owner-IRK/unlock — even **different owners on different phones** work
  cryptographically (each VM phones its own owner).
- **Make the cost legible + cap it:** each VM + the full data stack
  (postgres/minio/redis/forgejo/chromium) is several GB RAM; show per-server resource
  use and cap total based on host specs so a modest box isn't oversubscribed.
- **Scope = self / people-who-trust-you.** The host (whoever has root on the machine)
  can read any *unlocked* guest VM, so this is host-your-own / family hosting, **not** a
  host-strangers business. State it.

## CLI / debug access

Click a hosted server → **"Open CLI/console" — only if it was created Debug-friendly**
(the owner-signed `flagship/debug-access/v1` grant is present). This falls straight out
of the debug-access lockdown already shipped:

- A **production (debug-off) VM has no usable console login** (no `debug` account,
  `flagship` password locked, root disabled). Even though the app hosts the VM and can
  attach to its serial console, a production guest just shows a locked prompt — no way
  in. **The appliance's internal security is identical whether metal or VM.**
- For a **debug-enabled** server, hosting makes it *lovely*: **one-click console**
  (attach to the VM serial, or auto-SSH to the VM's local IP with the debug creds the
  app already holds) — no LAN-IP hunting or password typing. Great for developers/
  tinkerers, **without weakening production**.
- **Hard guardrail:** the app must **never** mount a production VM's disk and inject a
  debug user to bypass the grant. "Production = no console, ever" must stay true on metal
  and VM alike. CLI access is gated on the phone-signed grant, period.
- **Optional later:** "enable debug on an existing hosted server" → the app asks the
  phone to sign a fresh debug-access grant, delivers it to the VM, console unlocks. Keeps
  it phone-authorized (no silent host backdoor).

## Recipe delivery

Reuse the existing **one-shot pairing relay**: the app shows a QR + code, the phone
pairs and delivers the recipe (a capability-bearing artifact — delivered, never
fetched-by-name). Identical to today's builder pairing; the only difference is the
recipe is applied to a VM instead of a USB.

## What this does NOT change

- **Phone/webapp clients:** no changes required. They pair + deliver a recipe exactly as
  for the USB flow, and the phone-gated unlock reuses the existing mechanism. (A tier
  badge on the phone server-detail is an optional later polish, not required.)
- **The daemon core:** runs unmodified inside the Linux guest.
- **The dedicated-appliance product:** unchanged and remains the gold standard / hero.

## Cost, dependencies, sequencing

- **Effort: large.** This is a **Docker-Desktop-class capability** across three OSes
  (hypervisor per OS, VM lifecycle/updates/networking/resource limits, encrypted-disk +
  phone-unlock-in-VM, a cross-platform desktop app). Ongoing maintenance surface (OS
  updates break VM backends).
- **Resource floor is real:** a VM + the full data stack ≈ several GB RAM — fine on a
  Mac mini, marginal on a cheap old box. "Reasonably specced" is a genuine requirement.
- **Sequence:** land + prove the core appliance and ship to the stores first; then build
  this. **Mac first** (cleanest + the stated target), Linux (KVM) next, Windows last
  (possibly reduced tier initially). Reuse hard: same image, same daemon, same unlock —
  the app is a VM host + control panel, not a reimplementation.

## Fast provisioning — replace install-per-VM with clone-and-specialize

The original implementation boots a remastered Debian netinst ISO and performs
a complete unattended OS install inside every new VM. That is correct for a USB
stick targeting unknown physical hardware, but it is the wrong abstraction for
a managed VM whose virtual hardware is known in advance.

The failure that forced the redesign was `ezra.jolly-quince` on an Apple-silicon
Mac: Debian 13.6 arm64 reached partitioning, entered base-system installation,
wrote about 2 GiB to its sparse disk, then stopped writing while the VZ guest
held one vCPU at 100%. The only surviving checkpoint was "Installing Debian base
system (0 min)". A prior 13.5 guest failed with the same disk/CPU signature, so
updating installation media did not address the underlying d-i/VZ failure.

### Chosen path: a Flagship generalized encrypted appliance

Build and publish one secret-free appliance base for each native guest
architecture (`amd64`, `arm64`):

1. Start from a pinned Debian cloud/raw build or a reproducible debootstrap
   pipeline. Debian publishes current 3 GiB raw and roughly 320–415 MiB qcow2
   images for both architectures at
   `https://cloud.debian.org/images/cloud/trixie/latest/`; those prove the size
   and boot model, but are not used unmodified because their root is not LUKS.
2. Produce the Flagship disk layout ahead of time: EFI + `/boot` + LUKS root,
   using the same disposable build-time key and phone rekey protocol as the
   installer path.
3. Preinstall the kernel/initramfs (including the VM NIC/storage drivers), Node,
   Docker, Caddy, the daemon release, systemd units, and first-boot specializer.
   A new server must not run apt, git clone, npm install, or TypeScript builds.
4. Generalize before publication: remove machine-id, host keys, random seeds,
   logs, network leases, Flagship identity, recipes, entitlements, certificates,
   and every other per-machine artifact. CI boots the image once and asserts
   those absences before signing its manifest.
5. Studio downloads and hash-verifies the compressed base once per architecture.
   macOS creates an APFS copy-on-write clone of the raw disk; Linux and Windows
   create a qcow2 overlay backed by the immutable cached base. Creation is then
   metadata-speed rather than a 30–60 minute OS install.
6. Attach a small owner-only seed disk carrying the verified recipe. First boot
   expands the data/root allocation, generates the unique box identity, replaces
   the disposable LUKS key with the phone-sealed key, registers, and starts the
   daemon. After an authenticated guest receipt, Studio detaches and deletes the
   seed. The host never receives the final disk key.

Expected user-visible flow: download/verify the base on first use, then
"Creating encrypted server" for clone + specialization; subsequent servers skip
the base download. Success is driven by signed/allowlisted guest checkpoints,
not elapsed-time guesses or a clean VM stop.

### Rejected/default-not-chosen paths

- **Official cloud image + ordinary cloud-init:** very fast, but the published
  root is unencrypted. Adding LUKS after first boot creates a plaintext window
  and changes the security promise, so it is useful only as an image-builder
  input.
- **Native daemon or containers on the host:** lightest and fastest, but removes
  phone-gated LUKS and weakens isolation. It remains intentionally below the VM
  appliance tier.
- **Install once locally, then clone that VM:** improves the second server but
  leaves every customer with one long/failure-prone first install and makes
  safe generalization/versioning harder than a CI-built base.
- **Keep optimizing d-i:** retain only as compatibility/fallback and for USB.
  More CPUs, a full DVD ISO, or fewer tasksel packages can reduce time but do not
  remove the installer state machine or its hang surface.
- **Alpine/Buildroot/microVM rewrite:** could make the smallest guest, but forks
  the production Debian appliance and revives the parked Alpine work. Revisit
  only after the Debian generalized image is proven.

### Compatibility-path observability

Until clone-and-specialize replaces it, all three desktop hosts show the same
privacy-safe installer stream: canonical phase, an allowlisted d-i stage, and
elapsed minutes. The detached guest watcher reports stage changes plus a
two-minute heartbeat; Studio logs each new checkpoint and warns after three
minutes without one. It never uploads raw syslog, package names/output, recipe
bytes, keys, network identifiers, or user content. Remastered installer/config/
disk artifacts are owner-only on Unix hosts. The random order-status capability
is validated before use, retained only through an incomplete/retryable install,
and erased from the VM record as soon as installation succeeds.

### Delivery order

1. Reproducible dual-arch image builder + generalization audit.
2. Signed appliance manifest and cache alongside the existing ISO manifest.
3. macOS APFS clone + seed-disk proof, including LUKS rekey and first green
   padlock.
4. Linux qcow2 overlay parity, then Windows qcow2/WHPX parity.
5. Switch Host-here to the image path; keep the installer behind an explicit
   recovery/compatibility action until the image path has physical validation.

## Open questions / follow-ups

- Can we trim the guest data stack for lighter hosts (e.g. optional chromium/forgejo)
  without forking the appliance image?
- Auto-start-on-host-boot + the "waiting for you to unlock" state UX (the VM boots with
  the host but stays sealed until the phone approves).
- Whether/how to surface the hosted-VM tier badge on the phone (optional polish).
- Whether the immutable base should carry a minimal recovery partition so a
  failed update can atomically roll back without downloading the full base.
