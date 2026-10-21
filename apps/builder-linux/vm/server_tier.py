"""The honest security-tier badge.

Bare metal stays the gold standard; a hosted VM is labeled as such — legible,
never silently equivalent. Mirrors apps/builder-windows/src/VM/ServerTier.cs.
"""
from __future__ import annotations

from i18n import tr

import enum


class ServerDestination(enum.Enum):
    BURN_TO_USB = "usb"
    HOST_HERE = "host-here"


class ServerTier(enum.Enum):
    HARDWARE = "hardware"
    HOSTED_VM = "hosted-vm"

    @property
    def badge_label(self) -> str:
        return {
            ServerTier.HARDWARE: tr("Appliance (hardware)"),
            ServerTier.HOSTED_VM: tr("Appliance (hosted VM)"),
        }[self]


def tier_for_destination(destination: ServerDestination) -> ServerTier:
    return {
        ServerDestination.BURN_TO_USB: ServerTier.HARDWARE,
        ServerDestination.HOST_HERE: ServerTier.HOSTED_VM,
    }[destination]
