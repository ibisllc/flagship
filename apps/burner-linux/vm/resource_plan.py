"""Pure resource-cap math for hosted VMs.

Each VM + the full data stack (postgres/minio/redis/forgejo/chromium) is
several GB of RAM, so the plan keeps the cost legible and caps the total by
host specs — a modest box must never be oversubscribed by the default path.

Mirrors apps/burner-windows/src/VM/VMResourcePlan.cs byte-for-byte; pinned by
apps/desktop-shared/golden/vm-core-vectors.json.
"""
from __future__ import annotations

from .host_resources import HostResources

GIB = 1 << 30

# Comfortable per-VM allotment for the full data stack.
DEFAULT_VM_MEMORY_BYTES = 6 * GIB
# The floor below which the stack isn't viable — a host that can't spare this
# hosts zero VMs.
MINIMUM_VM_MEMORY_BYTES = 4 * GIB
# RAM always left to the host OS + the user's own apps.
HOST_RESERVE_BYTES = 4 * GIB
# Sparse main-disk size (the guest LUKS/ext4 root grows into it).
DEFAULT_MAIN_DISK_SIZE_BYTES = 64 * GIB
# Hard ceiling regardless of host size — family hosting, not a datacenter.
ABSOLUTE_MAX_VMS = 8


def vm_memory_bytes(host: HostResources) -> int:
    """Memory for ONE VM on this host: the comfortable default, clamped down to
    what the host can spare above the reserve, never below the floor."""
    spare = host.memory_bytes - HOST_RESERVE_BYTES if host.memory_bytes > HOST_RESERVE_BYTES else 0
    return max(MINIMUM_VM_MEMORY_BYTES, min(DEFAULT_VM_MEMORY_BYTES, spare))


def vm_cpu_count(host: HostResources) -> int:
    """vCPUs for one VM: 2-4, leaving two host cores free, never more than the
    host actually has."""
    return max(1, min(host.cpu_count, max(2, min(4, host.cpu_count - 2))))


def max_vm_count(host: HostResources) -> int:
    """How many VMs this host may run at once. 0 => the host can't spare even
    the minimum for one VM."""
    spare = host.memory_bytes - HOST_RESERVE_BYTES if host.memory_bytes > HOST_RESERVE_BYTES else 0
    if spare < MINIMUM_VM_MEMORY_BYTES:
        return 0
    # At least one fits (at the clamped floor); beyond that, count at the
    # comfortable per-VM default so N VMs are never squeezed below it.
    by_memory = max(1, spare // DEFAULT_VM_MEMORY_BYTES)
    return min(ABSOLUTE_MAX_VMS, by_memory)
