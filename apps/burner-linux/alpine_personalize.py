"""Local Alpine personalize — the burner-owns-the-ISO path (Python port).

Byte-for-byte port of apps/burner-mac/Sources/FlagshipBurnerCore/
AlpinePersonalize.swift, which is itself a port of the server's
packages/iso-personalizer/src/trailer.ts. Owning both ends lets us fix the
three seams the website-download path had:

  1. no per-server ~240 MB download (just the ~1 KB recipe),
  2. the output is padded to the device sector so the raw write is aligned,
  3. the trailer lands EXACTLY where the box's volume-size find reads it.

Trailer wire format (byte-identical to trailer.ts / the Swift port):

    MAGIC_HEADER(16) || version(1) || u32le(jsonLen) || json ||
    signature(64) || MAGIC_FOOTER(16) || u32le(totalSize)

`json` = `JSON.stringify(installBlobToJson(blob))` — built in the SAME field
order so the bytes match the server (see test_alpine_personalize.py's
structure assertions). The box parses it back via installBlobFromJson and
verifies the Ed25519 signature over the canonical InstallBlob bytes.

`signature` = the recipe's 64-byte blobSignature, verbatim.

This module is dependency-free (stdlib only) so it imports on any Python the
GUI runs under — no GTK, no third-party packages.
"""
from __future__ import annotations

import json as _json
import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union


# ---- recipe model (port of Recipe.swift's Recipe / RecipeAuthCode) ----


@dataclass(frozen=True)
class RecipeAuthCode:
    version: int
    serial: str
    username: str
    server_name: str
    server_domain: str
    delegated_pub_key_hex: str
    user_pub_key_hex: str
    issued_at: int
    expires_at: int


@dataclass(frozen=True)
class Recipe:
    version: int
    server_domain: str
    username: str
    server_name: str
    phone_delegated_pub_key_hex: str
    registration_url: str
    auth_code: RecipeAuthCode
    auth_code_user_signature_hex: str
    installer_git_ref: str
    rck_pub_key_hex: str
    blob_signature_hex: str
    # Phone-signed boot-unlock policy; None (absent) => treat as "auto".
    boot_unlock_mode: Optional[str] = None


class RecipeError(ValueError):
    """A recipe could not be parsed."""


def _normalize_envelope(obj: dict) -> dict:
    """Accept both the flattened recipe and the issued envelope the website
    hands out: `{ "blob": {...}, "blobSignature": "..." }`. The envelope is
    flattened (blob fields + blobSignatureHex) before parsing — mirrors
    RecipeLoader.normalizeEnvelope."""
    blob = obj.get("blob")
    sig = obj.get("blobSignature")
    if isinstance(blob, dict) and isinstance(sig, str):
        flat = dict(blob)
        flat["blobSignatureHex"] = sig
        return flat
    return obj


def parse_recipe(data: Union[bytes, str, dict]) -> Recipe:
    """Parse recipe JSON (envelope or flattened) into a Recipe. Mirrors
    RecipeLoader.parse — same field fallbacks, no signature/expiry check
    (the website already verified; the box re-verifies the trailer)."""
    if isinstance(data, dict):
        obj = data
    else:
        try:
            obj = _json.loads(data)
        except (ValueError, _json.JSONDecodeError) as e:
            raise RecipeError(f"not valid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise RecipeError("recipe is not a JSON object")
    obj = _normalize_envelope(obj)

    try:
        ac = obj["authCode"]
        if not isinstance(ac, dict):
            raise RecipeError("authCode is not an object")
        auth = RecipeAuthCode(
            version=int(ac.get("version", 1)),
            serial=str(ac["serial"]),
            username=str(ac.get("username", obj["username"])),
            server_name=str(ac.get("serverName", obj["serverName"])),
            server_domain=str(ac.get("serverDomain", obj["serverDomain"])),
            delegated_pub_key_hex=str(
                ac.get("delegatedPubKey", obj["phoneDelegatedPubKey"])
            ),
            user_pub_key_hex=str(ac["userPubKey"]),
            issued_at=int(ac["issuedAt"]),
            expires_at=int(ac["expiresAt"]),
        )
        return Recipe(
            version=int(obj["version"]),
            server_domain=str(obj["serverDomain"]),
            username=str(obj["username"]),
            server_name=str(obj["serverName"]),
            phone_delegated_pub_key_hex=str(obj["phoneDelegatedPubKey"]),
            registration_url=str(obj["registrationUrl"]),
            auth_code=auth,
            auth_code_user_signature_hex=str(obj["authCodeUserSignature"]),
            installer_git_ref=str(obj["installerGitRef"]),
            rck_pub_key_hex=str(obj["rckPubKey"]),
            blob_signature_hex=str(obj["blobSignatureHex"]),
            boot_unlock_mode=(
                str(obj["bootUnlockMode"])
                if obj.get("bootUnlockMode") is not None
                else None
            ),
        )
    except KeyError as e:
        raise RecipeError(f"missing field {e}") from e


# ---- trailer constants (must match trailer.ts exactly) ----

MAGIC_HEADER = b"FLAGSHIP-BOOT\x00\x00\x00"   # 16
MAGIC_FOOTER = b"\x00\x00\x00FLAGSHIP-END\x00"  # 16
FORMAT_VERSION = 0x01
SIG_LEN = 64
MAX_TRAILER_BYTES = 65_536

# ISO9660 Primary Volume Descriptor: sector 16 (byte 32768). The
# volume-space-size is a both-endian u32 at PVD offset 80; the logical block
# size a both-endian u16 at PVD offset 128.
PVD_OFFSET = 16 * 2048
VSS_OFFSET = 16 * 2048 + 80
LBS_OFFSET = 16 * 2048 + 128


class PersonalizeError(Exception):
    """ISO personalize failed — base too small / not ISO9660 / etc."""


def _js_string(value: str) -> str:
    """Encode a JSON string matching JSON.stringify for the characters that
    appear in recipe fields. Mirrors AlpinePersonalize.js — escapes ", \\, the
    named control escapes, and \\u00xx for other C0 controls. (Python's
    json.dumps escapes the same set with the same lowercase \\u form and does
    NOT add spaces, but we keep the explicit encoder so the byte output is
    provably identical to the Swift/TS path.)"""
    out = ['"']
    for ch in value:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def install_blob_json(r: Recipe) -> bytes:
    """`JSON.stringify(installBlobToJson(blob))` — same field order + compact
    (no spaces) so the bytes match trailer.ts. bootUnlockMode is deliberately
    omitted (installBlobToJson doesn't emit it — server parity)."""
    s = "{"
    s += '"version":%d,' % r.version
    s += '"serverDomain":%s,' % _js_string(r.server_domain)
    s += '"username":%s,' % _js_string(r.username)
    s += '"serverName":%s,' % _js_string(r.server_name)
    s += '"phoneDelegatedPubKey":%s,' % _js_string(r.phone_delegated_pub_key_hex.lower())
    s += '"registrationUrl":%s,' % _js_string(r.registration_url)
    s += '"authCode":{'
    s += '"version":%d,' % r.auth_code.version
    s += '"serial":%s,' % _js_string(r.auth_code.serial)
    s += '"username":%s,' % _js_string(r.auth_code.username)
    s += '"serverName":%s,' % _js_string(r.auth_code.server_name)
    s += '"serverDomain":%s,' % _js_string(r.auth_code.server_domain)
    s += '"delegatedPubKey":%s,' % _js_string(r.auth_code.delegated_pub_key_hex.lower())
    s += '"userPubKey":%s,' % _js_string(r.auth_code.user_pub_key_hex.lower())
    s += '"issuedAt":%d,' % r.auth_code.issued_at
    s += '"expiresAt":%d' % r.auth_code.expires_at
    s += "},"
    s += '"authCodeUserSignature":%s,' % _js_string(r.auth_code_user_signature_hex.lower())
    s += '"installerGitRef":%s,' % _js_string(r.installer_git_ref)
    s += '"rckPubKey":%s' % _js_string(r.rck_pub_key_hex.lower())
    s += "}"
    return s.encode("utf-8")


def _decode_hex(hex_str: str) -> Optional[bytes]:
    """Decode an even-length [0-9a-fA-F] string; None on any invalid input."""
    if len(hex_str) % 2 != 0:
        return None
    try:
        return bytes.fromhex(hex_str)
    except ValueError:
        return None


def build_trailer(recipe: Union[Recipe, dict, bytes, str]) -> bytes:
    """Build the trailer bytes for a verified recipe. Pure; unit-tested against
    the structure the box's parseTrailer expects.

    Accepts a Recipe, or raw recipe JSON (envelope/flattened) for convenience."""
    r = recipe if isinstance(recipe, Recipe) else parse_recipe(recipe)
    json_bytes = install_blob_json(r)
    json_len = len(json_bytes)
    total_size = (
        len(MAGIC_HEADER) + 1 + 4 + json_len + SIG_LEN + len(MAGIC_FOOTER) + 4
    )
    if total_size > MAX_TRAILER_BYTES:
        raise PersonalizeError(f"Recipe trailer too large ({total_size} bytes).")
    sig = _decode_hex(r.blob_signature_hex)
    if sig is None or len(sig) != SIG_LEN:
        raise PersonalizeError(
            f"Recipe blobSignature is not a 64-byte hex value "
            f"({len(r.blob_signature_hex)} hex chars)."
        )
    out = bytearray()
    out += MAGIC_HEADER
    out.append(FORMAT_VERSION)
    out += struct.pack("<I", json_len)
    out += json_bytes
    out += sig
    out += MAGIC_FOOTER
    out += struct.pack("<I", total_size)
    return bytes(out)


def personalize(
    base_path: Union[str, Path],
    recipe: Union[Recipe, dict, bytes, str],
    out_path: Union[str, Path],
    sector_size: int = 512,
) -> int:
    """Produce a flashable personalized image from the cached base ISO + recipe.

    Writes to `out_path`. The result = base bytes (with the PVD volume size
    patched so the trailer sits at the volume boundary) + trailer + zero pad to
    `sector_size`, so a raw-device write is block-aligned. Returns the output
    byte count.

    Port of AlpinePersonalize.personalize — same PVD inspect/patch, same trailer
    placement at fileSize (== volumeSpaceSize × lbs, where the box reads), same
    final-sector zero pad.
    """
    base_path = Path(base_path)
    out_path = Path(out_path)
    r = recipe if isinstance(recipe, Recipe) else parse_recipe(recipe)

    file_size = base_path.stat().st_size
    if file_size < 64 * 1024:
        raise PersonalizeError(f"Base ISO is too small ({file_size} bytes).")

    with open(base_path, "rb") as base:
        # ISO9660 PVD: descriptor type 1 + "CD001" identifier at sector 16.
        base.seek(PVD_OFFSET)
        pvd_head = base.read(8)
        if (
            len(pvd_head) < 6
            or pvd_head[0] != 0x01
            or pvd_head[1:6] != b"CD001"
        ):
            raise PersonalizeError("Cached base ISO isn't a valid ISO9660 image.")

        base.seek(LBS_OFFSET)
        lbs_bytes = base.read(2)
        lbs = struct.unpack("<H", lbs_bytes)[0] if len(lbs_bytes) >= 2 else 0
        block_size = lbs if lbs > 0 else 2048
        if file_size % block_size != 0:
            raise PersonalizeError(
                f"Base ISO size {file_size} isn't a multiple of its "
                f"{block_size}-byte logical block."
            )
        new_vss = file_size // block_size

        trailer = build_trailer(r)

        # Build the output: copy base, patch the PVD vss to new_vss (both-endian),
        # append the trailer at fileSize, pad to the sector size.
        os.makedirs(out_path.parent, exist_ok=True)
        with open(out_path, "wb") as out:
            base.seek(0)
            chunk = 4 * 1024 * 1024
            while True:
                data = base.read(chunk)
                if not data:
                    break
                out.write(data)

            # Patch volume-space-size in place: u32le at VSS_OFFSET, u32be next.
            out.seek(VSS_OFFSET)
            out.write(struct.pack("<I", new_vss))
            out.write(struct.pack(">I", new_vss))

            # Append the trailer at fileSize (== new_vss × lbs == box read offset).
            out.seek(file_size)
            out.write(trailer)

            # Pad the whole image to a sector multiple so the raw write aligns.
            total = file_size + len(trailer)
            pad = (sector_size - (total % sector_size)) % sector_size
            if pad > 0:
                out.write(b"\x00" * pad)
            out.flush()
            os.fsync(out.fileno())
            return total + pad
