"""Unit tests for the local Alpine personalize pipeline (alpine_personalize +
base_iso_cache). Mirrors apps/burner-mac AlpinePersonalizeTests.swift: trailer
wire-format structure + the trailer-at-volume-offset placement + sector
alignment. No boot needed — we check the bytes directly.

The JSON field order is additionally pinned byte-for-byte against the server's
TS installBlobToJson in the repo (see the dev note in the burner; not re-run
here so the suite stays dependency-free)."""
from __future__ import annotations

import json
import struct

import pytest

import alpine_personalize as ap
import base_iso_cache


# ---- sample recipe (matches AlpinePersonalizeTests.sampleRecipe) ----


def _sample_recipe() -> ap.Recipe:
    ac = ap.RecipeAuthCode(
        version=1,
        serial="CPSERIAL0001",
        username="dani",
        server_name="home",
        server_domain="home.dani.flagship.services",
        delegated_pub_key_hex="ab" * 32,
        user_pub_key_hex="cd" * 32,
        issued_at=1_780_276_747_131,
        expires_at=1_780_298_347_131,
    )
    return ap.Recipe(
        version=2,
        server_domain="home.dani.flagship.services",
        username="dani",
        server_name="home",
        phone_delegated_pub_key_hex="ab" * 32,
        registration_url="https://flagship.services/api/server/register",
        auth_code=ac,
        auth_code_user_signature_hex="11" * 64,
        installer_git_ref="main",
        rck_pub_key_hex="ef" * 32,
        blob_signature_hex="22" * 64,
        boot_unlock_mode=None,
    )


def _u32le(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]


# ---- trailer wire format ----


def test_trailer_wire_format_matches_server():
    r = _sample_recipe()
    t = ap.build_trailer(r)
    # MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json || sig(64) ||
    # MAGIC_FOOTER(16) || u32le(totalSize)
    assert t[:16] == b"FLAGSHIP-BOOT\x00\x00\x00"
    assert t[16] == 0x01
    json_len = _u32le(t, 17)
    obj = json.loads(t[21 : 21 + json_len])
    assert obj["serverDomain"] == "home.dani.flagship.services"
    assert obj["installerGitRef"] == "main"
    assert "bootUnlockMode" not in obj, "installBlobToJson omits bootUnlockMode"
    assert obj["authCode"]["serial"] == "CPSERIAL0001"
    # signature is the recipe's 64-byte blobSignature, verbatim
    sig = t[21 + json_len : 21 + json_len + 64]
    assert sig == bytes.fromhex(r.blob_signature_hex)
    # footer + self-describing totalSize at the very end
    total = len(t)
    assert t[total - 20 : total - 4] == b"\x00\x00\x00FLAGSHIP-END\x00"
    assert _u32le(t, total - 4) == total


def test_trailer_json_is_compact_and_lowercase_hex():
    t = ap.build_trailer(_sample_recipe())
    json_len = _u32le(t, 17)
    raw = t[21 : 21 + json_len].decode("utf-8")
    # JSON.stringify is compact — no ": " or ", " separators.
    assert ": " not in raw and ", " not in raw
    # hex fields lowercased to match the TS hex() output.
    assert "ABABAB" not in raw
    assert "abababab" in raw


def test_trailer_field_order_matches_install_blob_to_json():
    """The InstallBlobJson key order is load-bearing (the box re-serializes via
    JSON.parse but the signature is over canonical bytes; still, the trailer
    JSON must equal the server's verbatim so cached re-personalizes match)."""
    raw = ap.install_blob_json(_sample_recipe()).decode("utf-8")
    order = [
        '"version":', '"serverDomain":', '"username":', '"serverName":',
        '"phoneDelegatedPubKey":', '"registrationUrl":', '"authCode":',
        '"authCodeUserSignature":', '"installerGitRef":', '"rckPubKey":',
    ]
    positions = [raw.index(k) for k in order]
    assert positions == sorted(positions)
    # authCode inner order
    inner = raw[raw.index('"authCode":') :]
    inner_order = [
        '"version":', '"serial":', '"username":', '"serverName":',
        '"serverDomain":', '"delegatedPubKey":', '"userPubKey":',
        '"issuedAt":', '"expiresAt":',
    ]
    inner_positions = [inner.index(k) for k in inner_order]
    assert inner_positions == sorted(inner_positions)


def test_build_trailer_rejects_bad_signature():
    r = _sample_recipe()
    bad = ap.Recipe(**{**r.__dict__, "blob_signature_hex": "22" * 10})  # 10 bytes
    with pytest.raises(ap.PersonalizeError):
        ap.build_trailer(bad)


def test_build_trailer_accepts_raw_recipe_json():
    r = _sample_recipe()
    envelope = {
        "blob": {
            "version": 2,
            "serverDomain": r.server_domain,
            "username": r.username,
            "serverName": r.server_name,
            "phoneDelegatedPubKey": r.phone_delegated_pub_key_hex,
            "registrationUrl": r.registration_url,
            "authCode": {
                "version": 1,
                "serial": r.auth_code.serial,
                "username": r.auth_code.username,
                "serverName": r.auth_code.server_name,
                "serverDomain": r.auth_code.server_domain,
                "delegatedPubKey": r.auth_code.delegated_pub_key_hex,
                "userPubKey": r.auth_code.user_pub_key_hex,
                "issuedAt": r.auth_code.issued_at,
                "expiresAt": r.auth_code.expires_at,
            },
            "authCodeUserSignature": r.auth_code_user_signature_hex,
            "installerGitRef": r.installer_git_ref,
            "rckPubKey": r.rck_pub_key_hex,
        },
        "blobSignature": r.blob_signature_hex,
    }
    t_envelope = ap.build_trailer(json.dumps(envelope).encode())
    t_direct = ap.build_trailer(r)
    assert t_envelope == t_direct


# ---- recipe parsing ----


def test_parse_recipe_flattened():
    flat = {
        "version": 2,
        "serverDomain": "home.dani.flagship.services",
        "username": "dani",
        "serverName": "home",
        "phoneDelegatedPubKey": "ab" * 32,
        "registrationUrl": "https://x/y",
        "authCode": {
            "version": 1, "serial": "S1", "userPubKey": "cd" * 32,
            "issuedAt": 1, "expiresAt": 2,
        },
        "authCodeUserSignature": "11" * 64,
        "installerGitRef": "main",
        "rckPubKey": "ef" * 32,
        "blobSignatureHex": "22" * 64,
    }
    r = ap.parse_recipe(json.dumps(flat))
    assert r.server_domain == "home.dani.flagship.services"
    # authCode falls back to top-level username/serverName/serverDomain.
    assert r.auth_code.username == "dani"
    assert r.auth_code.server_name == "home"
    assert r.boot_unlock_mode is None


def test_parse_recipe_missing_field_raises():
    with pytest.raises(ap.RecipeError):
        ap.parse_recipe('{"version": 2}')


# ---- personalize: placement + alignment ----


def _synthetic_iso(vol_blocks: int = 100, pad_blocks: int = 10, lbs: int = 2048) -> bytes:
    """ISO9660: 16 system sectors + a PVD + trailing 'xorriso padding' blocks,
    so file > volume — exactly the shape that broke the download path (box reads
    at the volume offset, not file-end). Mirrors the Swift test fixture."""
    file_blocks = vol_blocks + pad_blocks
    iso = bytearray(file_blocks * lbs)
    pvd = 16 * lbs
    iso[pvd] = 0x01
    iso[pvd + 1 : pvd + 6] = b"CD001"
    # vss (both-endian u32) at PVD+80
    struct.pack_into("<I", iso, pvd + 80, vol_blocks)
    struct.pack_into(">I", iso, pvd + 84, vol_blocks)
    # lbs (both-endian u16) at PVD+128
    struct.pack_into("<H", iso, pvd + 128, lbs)
    struct.pack_into(">H", iso, pvd + 130, lbs)
    return bytes(iso)


def test_personalize_places_trailer_at_volume_offset_and_aligns(tmp_path):
    lbs, vol_blocks, pad_blocks = 2048, 100, 10
    file_blocks = vol_blocks + pad_blocks
    base = tmp_path / "base.iso"
    out = tmp_path / "out.iso"
    base.write_bytes(_synthetic_iso(vol_blocks, pad_blocks, lbs))

    ap.personalize(base, _sample_recipe(), out, sector_size=512)
    data = out.read_bytes()
    file_size = file_blocks * lbs
    pvd = 16 * lbs

    # PVD volume-space-size patched to fileSize/lbs so the box's
    # `volumeSpaceSize × lbs` lands on the trailer (not in the padding).
    assert _u32le(data, pvd + 80) == file_blocks
    # both-endian: the BE copy at PVD+84 is patched too.
    assert struct.unpack_from(">I", data, pvd + 84)[0] == file_blocks
    # The trailer header sits at that offset (== fileSize).
    assert data[file_size : file_size + 16] == b"FLAGSHIP-BOOT\x00\x00\x00"
    # Output padded to the device sector so the raw write is aligned.
    assert len(data) % 512 == 0
    assert len(data) >= file_size + 16


def test_personalize_pads_to_custom_sector(tmp_path):
    base = tmp_path / "base.iso"
    out = tmp_path / "out.iso"
    base.write_bytes(_synthetic_iso())
    ap.personalize(base, _sample_recipe(), out, sector_size=4096)
    assert out.stat().st_size % 4096 == 0


def test_personalize_rejects_non_iso9660(tmp_path):
    base = tmp_path / "base.iso"
    out = tmp_path / "out.iso"
    base.write_bytes(bytes(200 * 1024))  # 200 KB of zeros, no PVD
    with pytest.raises(ap.PersonalizeError):
        ap.personalize(base, _sample_recipe(), out)


def test_personalize_rejects_too_small(tmp_path):
    base = tmp_path / "base.iso"
    out = tmp_path / "out.iso"
    base.write_bytes(bytes(1024))  # < 64 KB floor
    with pytest.raises(ap.PersonalizeError):
        ap.personalize(base, _sample_recipe(), out)


def test_personalize_trailer_roundtrips_via_volume_size(tmp_path):
    """End-to-end: the trailer the box would read (at volumeSpaceSize × lbs)
    parses back to the same install blob."""
    base = tmp_path / "base.iso"
    out = tmp_path / "out.iso"
    base.write_bytes(_synthetic_iso())
    ap.personalize(base, _sample_recipe(), out)
    data = out.read_bytes()
    pvd = 16 * 2048
    vss = _u32le(data, pvd + 80)
    lbs = struct.unpack_from("<H", data, pvd + 128)[0]
    offset = vss * lbs
    trailer = data[offset:]
    assert trailer[:16] == b"FLAGSHIP-BOOT\x00\x00\x00"
    json_len = _u32le(trailer, 17)
    obj = json.loads(trailer[21 : 21 + json_len])
    assert obj["serverDomain"] == "home.dani.flagship.services"


# ---- base_iso_cache ----


def test_cache_dir_honours_xdg(monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", "/tmp/xdg-cache-test")
    assert str(base_iso_cache.cache_dir()) == "/tmp/xdg-cache-test/flagship-burner"


def test_cache_dir_falls_back_to_home(monkeypatch):
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    monkeypatch.setenv("HOME", "/home/tester")
    assert str(base_iso_cache.cache_dir()) == "/home/tester/.cache/flagship-burner"


def test_cached_filename_is_pinned():
    assert base_iso_cache.CACHE_FILENAME == "flagship-base-alpine-3.21.0.iso"


def test_cached_path_uses_filename(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    p = base_iso_cache.cached_path()
    assert p.name == "flagship-base-alpine-3.21.0.iso"
    assert p.parent.name == "flagship-burner"


def test_ensure_returns_cached_without_download(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    dest = base_iso_cache.cached_path()
    dest.write_bytes(b"already here")
    started = []
    got = base_iso_cache.ensure(on_download_start=lambda: started.append(1))
    assert got == dest
    assert started == []  # no download when cache hit


def test_pinned_sha_and_url_unchanged():
    assert (
        base_iso_cache.SHA256_HEX
        == "f63e57b0ad4a94444f3141bf29877dbe4502553725b7c883900215ad4d3c08cd"
    )
    assert base_iso_cache.URL == (
        "https://flagshipserver.com/build/iso/flagship-alpine-base.iso"
    )
