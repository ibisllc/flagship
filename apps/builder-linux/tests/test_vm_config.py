"""VMConfig.plan — the deterministic recipe+host -> spec function."""
from __future__ import annotations

import json

from vm import resource_plan
from vm.config import VMConfig, VMNetworkMode
from vm.host_resources import HostResources
from vm.recipe_info import read_recipe_fields

RECIPE = {
    "version": 2,
    "serverDomain": "home.harry.flagship.services",
    "username": "harry",
    "serverName": "home",
}
HOST = HostResources(8, 16 * resource_plan.GIB)


def plan(recipe: dict) -> VMConfig:
    raw = json.dumps(recipe).encode("utf-8")
    return VMConfig.plan(read_recipe_fields(raw), raw, HOST)


def test_plan_is_deterministic_and_sized_by_the_host():
    c = plan(RECIPE)
    assert c.name == "home.harry.flagship.services"
    assert c.server_domain == "home.harry.flagship.services"
    assert c.username == "harry"
    assert c.server_name == "home"
    assert c.cpu_count == 4
    assert c.memory_bytes == 6 * resource_plan.GIB
    assert c.main_disk_size_bytes == resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES
    assert c.network_mode == VMNetworkMode.NAT
    assert plan(RECIPE) == c


def test_debug_grant_presence_gates_the_serial_console():
    assert plan(RECIPE).serial_console_enabled is False
    assert plan({**RECIPE, "debugGrant": '{"v":1}'}).serial_console_enabled is True
    # Empty string = no grant (matches the engine's asStr).
    assert plan({**RECIPE, "debugGrant": ""}).serial_console_enabled is False


def test_sealed_boot_follows_disk_encryption():
    assert plan(RECIPE).disk_encrypted is True
    assert plan(RECIPE).awaits_phone_unlock_at_boot is True
    unencrypted = plan({**RECIPE, "diskEncryption": "none"})
    assert unencrypted.disk_encrypted is False
    assert unencrypted.awaits_phone_unlock_at_boot is False


def test_boot_unlock_mode_defaults_auto():
    assert plan(RECIPE).boot_unlock_mode == "auto"
    assert plan({**RECIPE, "bootUnlockMode": "approve"}).boot_unlock_mode == "approve"
