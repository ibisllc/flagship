"""Reads the fields the host layer needs out of a recipe JSON document.

The Linux builder does NOT re-implement the phone-signature verification in
Python (that stays delegated to the Node `flagship-build verify` CLI, the trust
root). This module only extracts the plaintext fields VMConfig planning needs +
the UNSIGNED `debugGrant` sibling that gates the serial console.

Mirrors:
  * apps/builder-windows/src/VM/RecipeSiblings.cs  (debug_grant)
  * apps/builder-windows/src/Recipe.cs field reading + NormalizeEnvelope
    (read_recipe_fields), MINUS the Ed25519 verification.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class RecipeFields:
    server_domain: str
    username: str
    server_name: str
    auth_code_serial: Optional[str] = None
    # Raw phone-signed values; absence has a defined default below.
    boot_unlock_mode: Optional[str] = None
    disk_encryption: Optional[str] = None

    @property
    def effective_boot_unlock_mode(self) -> str:
        """The mode the box dispatches on (absence => "auto")."""
        return "approve" if self.boot_unlock_mode == "approve" else "auto"

    @property
    def encrypts_disk(self) -> bool:
        """Absence => encrypted; only an explicit "none" opts out (the
        Wi-Fi-only fallback). Mirrors Recipe.EncryptsDisk."""
        return self.disk_encryption != "none"


def _normalize_envelope(root: dict) -> dict:
    """Accept both the flattened recipe and the issued envelope the website
    hands out: { "blob": {…}, "blobSignature": "…" }. Returns the flattened
    field dict either way (matching RecipeLoader.NormalizeEnvelope)."""
    blob = root.get("blob")
    if isinstance(blob, dict) and isinstance(root.get("blobSignature"), str):
        return blob
    return root


def read_recipe_fields(recipe_json: bytes) -> RecipeFields:
    """Parse the plaintext addressing + policy fields. Raises ValueError on a
    document that isn't a recipe object."""
    try:
        root = json.loads(recipe_json)
    except (json.JSONDecodeError, ValueError) as e:
        raise ValueError(f"Not a valid recipe: {e}") from e
    if not isinstance(root, dict):
        raise ValueError("Not a valid recipe: top-level is not an object.")
    fields = _normalize_envelope(root)

    def req_str(name: str) -> str:
        v = fields.get(name)
        if not isinstance(v, str):
            raise ValueError(f'Not a valid recipe: missing field "{name}".')
        return v

    def opt_str(name: str) -> Optional[str]:
        v = fields.get(name)
        return v if isinstance(v, str) else None

    return RecipeFields(
        server_domain=req_str("serverDomain"),
        username=req_str("username"),
        server_name=req_str("serverName"),
        auth_code_serial=(
            fields.get("authCode", {}).get("serial")
            if isinstance(fields.get("authCode"), dict)
            and isinstance(fields.get("authCode", {}).get("serial"), str)
            else None
        ),
        boot_unlock_mode=opt_str("bootUnlockMode"),
        disk_encryption=opt_str("diskEncryption"),
    )


def debug_grant(recipe_json: bytes) -> Optional[str]:
    """The owner-IRK-signed flagship/debug-access/v1 grant, if the phone baked
    one in at mint time. Its PRESENCE is the only debug signal the host app may
    act on (consent-as-crypto). Absent => production => no console, ever.

    Matches the engine's asStr: a non-empty string is passed through; an object
    is stringified; anything else (missing/empty/other types) => None. The
    sibling lives at the TOP level of the raw document in BOTH shapes (flattened
    recipe and the issued envelope), so it is read from the raw root, not the
    normalized blob."""
    try:
        root = json.loads(recipe_json)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(root, dict):
        return None
    raw = root.get("debugGrant")
    if isinstance(raw, str):
        return raw if raw else None
    if isinstance(raw, dict):
        # Stringify with the compact separators the engine's JSON.stringify uses.
        return json.dumps(raw, separators=(",", ":"))
    return None
