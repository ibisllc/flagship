"""Pure VM-appliance host core for the Linux builder.

This package brings the Linux app to parity with the Mac (Apple VZ) and
Windows (QEMU + WHPX) desktop apps: it can host the user's server as a local
phone-gated QEMU/KVM VM, not just burn a recipe to a USB stick.

The layering mirrors apps/builder-windows/src/VM (the closest analog — both are
QEMU-based):

  * PURE CORE (fully unit-testable, no QEMU/KVM/filesystem):
      lifecycle.py       — the VMState/VMEvent/VMEffect state machine + the
                           hard-won duration-gated install verdict
      resource_plan.py   — per-VM CPU/RAM sizing + host VM-count cap
      server_tier.py     — the honest hardware-vs-hosted-VM tier badge
      config.py          — the deterministic VMConfig spec for one VM
      recipe_info.py     — recipe-field + debug-grant-sibling readers
      inventory.py       — on-disk VM records + FQDN name validation
      qemu_command_line.py — the qemu-system-x86_64 argv builder (KVM/OVMF)
      ssh_launch.py      — the `ssh … debug@127.0.0.1` argv + terminal picker
      host_resources.py  — a snapshot of host CPU/RAM
      qmp_client.py      — the QMP protocol (parsing is pure + tested)
      kvm_probe.py       — /dev/kvm accelerator availability (pure classifier)

  * IMPURE ADAPTERS (exercised by a live boot, not unit tests):
      qemu_locator.py    — find qemu + OVMF on this machine
      qemu_host.py       — spawn/stop the qemu process
      manager.py         — the runtime orchestrator (thin threading; its
                           HostedServer display mapping IS pure + tested)

Phone pairing (pair_session.py) lives beside cli_runner.py at the app root —
it drives the shared `flagship-build pair --emit-events` CLI, not a VM.

The pure core is pinned to the SAME cross-language contract the Mac and
Windows cores obey: apps/desktop-shared/golden/vm-core-vectors.json.
"""
