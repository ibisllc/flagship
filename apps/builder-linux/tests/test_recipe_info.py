"""Recipe-field reading for the host layer + the drift audit pinned in tests.

Drift finding (2026-07): the Linux builder never re-implemented the recipe
canonical bytes or signature verify in Python — the Node CLI (`flagship-build
verify`, backed by @flagship/protocol) is the single verifier, so the `de=`
(diskEncryption) canonical append and the removal of the old `ca=`
(certAutonomy) field can't drift here the way the C#/Swift ports could. What
Python DOES read for VM planning is pinned below: diskEncryption ("none" opts
out, absence => encrypted — the de= semantics), bootUnlockMode (absence =>
"auto"), the envelope shape, and the unsigned debugGrant sibling. A legacy
certAutonomy field must be ignored.
"""
from __future__ import annotations

import json

import pytest

from vm.recipe_info import RecipeFields, debug_grant, read_recipe_fields

FLAT = {
    "version": 2,
    "serverDomain": "home.harry.flagship.services",
    "username": "harry",
    "serverName": "home",
}


def as_bytes(d: dict) -> bytes:
    return json.dumps(d).encode("utf-8")


def test_reads_flattened_recipe():
    f = read_recipe_fields(as_bytes(FLAT))
    assert f.server_domain == "home.harry.flagship.services"
    assert f.username == "harry"
    assert f.server_name == "home"


def test_reads_issued_envelope():
    env = {"blob": dict(FLAT), "blobSignature": "aa" * 64}
    f = read_recipe_fields(as_bytes(env))
    assert f.server_domain == "home.harry.flagship.services"


def test_envelope_without_signature_is_treated_as_flat():
    env = {"blob": dict(FLAT)}
    with pytest.raises(ValueError):
        read_recipe_fields(as_bytes(env))


def test_missing_required_field_raises():
    d = dict(FLAT)
    del d["username"]
    with pytest.raises(ValueError):
        read_recipe_fields(as_bytes(d))


def test_not_json_raises():
    with pytest.raises(ValueError):
        read_recipe_fields(b"not json")
    with pytest.raises(ValueError):
        read_recipe_fields(b"[1,2,3]")


# ---- de= (diskEncryption) semantics — absence => LUKS; only "none" opts out ----


def test_disk_encryption_absent_means_encrypted():
    f = read_recipe_fields(as_bytes(FLAT))
    assert f.disk_encryption is None
    assert f.encrypts_disk is True


def test_disk_encryption_none_opts_out():
    f = read_recipe_fields(as_bytes({**FLAT, "diskEncryption": "none"}))
    assert f.encrypts_disk is False


def test_disk_encryption_luks_is_encrypted():
    f = read_recipe_fields(as_bytes({**FLAT, "diskEncryption": "luks"}))
    assert f.encrypts_disk is True


# ---- bootUnlockMode — absence => "auto"; only "approve" flips ----


def test_boot_unlock_mode_defaults_to_auto():
    assert read_recipe_fields(as_bytes(FLAT)).effective_boot_unlock_mode == "auto"
    assert (
        read_recipe_fields(as_bytes({**FLAT, "bootUnlockMode": "approve"})).effective_boot_unlock_mode
        == "approve"
    )
    assert (
        read_recipe_fields(as_bytes({**FLAT, "bootUnlockMode": "bogus"})).effective_boot_unlock_mode
        == "auto"
    )


def test_stale_cert_autonomy_field_is_ignored():
    f = read_recipe_fields(as_bytes({**FLAT, "certAutonomy": "managed"}))
    assert f == RecipeFields(
        server_domain="home.harry.flagship.services",
        username="harry",
        server_name="home",
    )


# ---- debugGrant sibling (matches the engine's asStr + top-level-in-both-shapes) ----


def test_debug_grant_absent_is_none():
    assert debug_grant(as_bytes(FLAT)) is None


def test_debug_grant_string_passes_through():
    grant = '{"v":1,"grant":{"sshAuthorizedKey":"ssh-ed25519 AAAA"}}'
    assert debug_grant(as_bytes({**FLAT, "debugGrant": grant})) == grant


def test_debug_grant_empty_string_is_none():
    assert debug_grant(as_bytes({**FLAT, "debugGrant": ""})) is None


def test_debug_grant_object_is_stringified_compact():
    got = debug_grant(as_bytes({**FLAT, "debugGrant": {"v": 1, "grant": {"a": "b"}}}))
    assert got == '{"v":1,"grant":{"a":"b"}}'


def test_debug_grant_other_types_are_none():
    assert debug_grant(as_bytes({**FLAT, "debugGrant": 7})) is None
    assert debug_grant(as_bytes({**FLAT, "debugGrant": [1]})) is None
    assert debug_grant(b"not json") is None


def test_debug_grant_read_from_the_raw_top_level_in_envelope_shape():
    env = {"blob": dict(FLAT), "blobSignature": "aa", "debugGrant": "g"}
    assert debug_grant(as_bytes(env)) == "g"
