"""Toolchain + OVMF discovery — fully injected, no filesystem."""
from __future__ import annotations

import pytest

from vm.qemu_locator import (
    ENV_IMG,
    ENV_OVMF_CODE,
    ENV_OVMF_VARS,
    ENV_SYSTEM,
    QemuLocatorError,
    locate,
)

OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.fd"


def which_map(m: dict):
    return lambda name: m.get(name)


def exists_set(paths: set):
    return lambda p: p in paths


def test_finds_everything_on_a_standard_debian_layout():
    tc = locate(
        env={},
        which=which_map(
            {"qemu-system-x86_64": "/usr/bin/qemu-system-x86_64", "qemu-img": "/usr/bin/qemu-img"}
        ),
        exists=exists_set(
            {"/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img", OVMF_CODE, OVMF_VARS}
        ),
    )
    assert tc.system_binary == "/usr/bin/qemu-system-x86_64"
    assert tc.img_binary == "/usr/bin/qemu-img"
    assert tc.uefi_code_path == OVMF_CODE
    assert tc.uefi_vars_template == OVMF_VARS


def test_env_overrides_win():
    tc = locate(
        env={
            ENV_SYSTEM: "/opt/q/qemu-system-x86_64",
            ENV_IMG: "/opt/q/qemu-img",
            ENV_OVMF_CODE: "/opt/fw/code.fd",
            ENV_OVMF_VARS: "/opt/fw/vars.fd",
        },
        which=which_map({}),
        exists=exists_set(
            {"/opt/q/qemu-system-x86_64", "/opt/q/qemu-img", "/opt/fw/code.fd", "/opt/fw/vars.fd"}
        ),
    )
    assert tc.system_binary == "/opt/q/qemu-system-x86_64"
    assert tc.uefi_code_path == "/opt/fw/code.fd"


def test_missing_qemu_is_actionable():
    with pytest.raises(QemuLocatorError, match="apt install qemu-system-x86"):
        locate(env={}, which=which_map({}), exists=exists_set(set()))


def test_missing_qemu_img_is_actionable():
    with pytest.raises(QemuLocatorError, match="qemu-img"):
        locate(
            env={},
            which=which_map({"qemu-system-x86_64": "/usr/bin/qemu-system-x86_64"}),
            exists=exists_set({"/usr/bin/qemu-system-x86_64"}),
        )


def test_missing_ovmf_is_actionable():
    with pytest.raises(QemuLocatorError, match="ovmf"):
        locate(
            env={},
            which=which_map(
                {"qemu-system-x86_64": "/usr/bin/qemu-system-x86_64", "qemu-img": "/usr/bin/qemu-img"}
            ),
            exists=exists_set({"/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img"}),
        )


def test_stale_env_ovmf_paths_error_rather_than_silently_scan():
    with pytest.raises(QemuLocatorError, match="unreadable"):
        locate(
            env={ENV_OVMF_CODE: "/gone/code.fd", ENV_OVMF_VARS: "/gone/vars.fd"},
            which=which_map(
                {"qemu-system-x86_64": "/usr/bin/qemu-system-x86_64", "qemu-img": "/usr/bin/qemu-img"}
            ),
            exists=exists_set({"/usr/bin/qemu-system-x86_64", "/usr/bin/qemu-img"}),
        )


def test_ovmf_pairs_stay_matched():
    # Only the pair whose BOTH halves exist is picked — never a code from one
    # build with vars from another.
    tc = locate(
        env={},
        which=which_map(
            {"qemu-system-x86_64": "/usr/bin/qemu-system-x86_64", "qemu-img": "/usr/bin/qemu-img"}
        ),
        exists=exists_set(
            {
                "/usr/bin/qemu-system-x86_64",
                "/usr/bin/qemu-img",
                OVMF_CODE,  # 4M code present but its vars half missing
                "/usr/share/edk2/ovmf/OVMF_CODE.fd",
                "/usr/share/edk2/ovmf/OVMF_VARS.fd",
            }
        ),
    )
    assert tc.uefi_code_path == "/usr/share/edk2/ovmf/OVMF_CODE.fd"
    assert tc.uefi_vars_template == "/usr/share/edk2/ovmf/OVMF_VARS.fd"
