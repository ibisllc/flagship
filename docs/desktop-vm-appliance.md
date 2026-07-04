# Flagship for Desktop — host a server in the app (encrypted, phone-gated VM appliance)

> **Status: DESIGN LOCKED, build is POST-LAUNCH.** This records the decision + plan
> from the 2026-07-01 design discussion. No code yet. It is an upgrade to the
> **desktop app** (today's burner, `apps/burner-mac`) only — the phone/webapp
> clients and the daemon core are reused unchanged.

## Vision

Let people run a **real Flagship server on hardware they already own** (a Mac mini,
a spare PC, a home Linux box) via a **signed desktop app**, not just by building a
dedicated USB-burned box — **without giving up the security promise**.

The desktop app is the burner **evolved**, not replaced. One app, one pairing flow,
one trust anchor, two destinations for the same recipe:

- **Burn to USB** → dedicated bare-metal appliance (today's flow).
- **Host here** → a managed, **encrypted, phone-gated Linux VM appliance** running on
  this machine (new).

Same recipe, same daemon, same phone-unlock — just written to a VM disk instead of a
USB. Rename the app from "the Burner"/"Assembler" to **Flagship for Desktop** (build a
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
   `curl | sh`). The current burner is already code-signed (Developer ID, notarizable,
   privileged helper) — we extend it.

3. **"The appliance, virtualized."** Maximal reuse: the burner already builds the
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
backends behind a shared control/UI layer. The current burner is Mac-only Swift, so the
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
fetched-by-name). Identical to today's burner pairing; the only difference is the
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

## Open questions / follow-ups

- Which hypervisor building blocks per OS (raw VZ vs a thin wrapper; QEMU/WHPX vs
  Hyper-V on Windows; KVM/libvirt vs a lib on Linux) — spike on Mac first.
- Cross-platform desktop app stack (per-OS native vs Tauri/Electron shell over per-OS VM
  backends).
- Can we trim the guest data stack for lighter hosts (e.g. optional chromium/forgejo)
  without forking the appliance image?
- Auto-start-on-host-boot + the "waiting for you to unlock" state UX (the VM boots with
  the host but stays sealed until the phone approves).
- Whether/how to surface the hosted-VM tier badge on the phone (optional polish).
