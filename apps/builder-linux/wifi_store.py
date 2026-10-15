"""Remembers the owner's Wi-Fi between burns (the Mac keeps it in UserDefaults
plus the Keychain, Windows with DPAPI).

The network name sits in $XDG_CONFIG_HOME/flagship-builder/wifi.json. The
password goes to the desktop keyring through libsecret when it is installed
and answering; otherwise into that same file, which only this user can read
(0600). This is the owner's own Wi-Fi on their own PC.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional, Protocol, Tuple


class SecretBackend(Protocol):
    def load(self) -> Optional[str]: ...

    def save(self, password: str) -> bool: ...


def default_path() -> str:
    config = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return str(Path(config) / "flagship-builder" / "wifi.json")


class LibsecretBackend:
    """The desktop keyring (GNOME Keyring, KWallet's Secret Service)."""

    def __init__(self) -> None:
        import gi

        gi.require_version("Secret", "1")
        from gi.repository import Secret  # type: ignore

        self._secret = Secret
        self._schema = Secret.Schema.new(
            "com.flagshipserver.Builder.wifi",
            Secret.SchemaFlags.NONE,
            {"purpose": Secret.SchemaAttributeType.STRING},
        )
        self._attrs = {"purpose": "wifi-password"}

    def load(self) -> Optional[str]:
        try:
            return self._secret.password_lookup_sync(self._schema, self._attrs, None) or ""
        except Exception:
            return None

    def save(self, password: str) -> bool:
        try:
            if password:
                return bool(self._secret.password_store_sync(
                    self._schema, self._attrs, self._secret.COLLECTION_DEFAULT,
                    "Flagship Studio Wi-Fi", password, None,
                ))
            self._secret.password_clear_sync(self._schema, self._attrs, None)
            return True
        except Exception:
            return False


def default_backend() -> Optional[SecretBackend]:
    try:
        return LibsecretBackend()
    except (ImportError, ValueError):
        return None


class WifiStore:
    def __init__(self, path: Optional[str] = None, keyring: Optional[SecretBackend] = None) -> None:
        self.path = path or default_path()
        self._keyring = keyring

    def _read(self) -> dict:
        try:
            with open(self.path, "rb") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def load(self) -> Tuple[str, str]:
        d = self._read()
        ssid = d.get("ssid") if isinstance(d.get("ssid"), str) else ""
        password = d.get("password") if isinstance(d.get("password"), str) else None
        if password is None and d.get("passwordInKeyring") and self._keyring is not None:
            password = self._keyring.load()
        return ssid, password or ""

    def save(self, ssid: str, password: str) -> None:
        ssid = ssid.strip()
        in_keyring = bool(password) and self._keyring is not None and self._keyring.save(password)
        if not password and self._keyring is not None:
            self._keyring.save("")
        if not ssid and not password:
            try:
                os.unlink(self.path)
            except OSError:
                pass
            return
        d: dict = {"ssid": ssid}
        if in_keyring:
            d["passwordInKeyring"] = True
        elif password:
            d["password"] = password
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        tmp = self.path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
