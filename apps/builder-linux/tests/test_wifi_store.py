"""The Wi-Fi details survive a relaunch: the password in the keyring when one
answers, else only in a file this user alone can read; the burn passes the
password through a 0600 file, never on the command line."""
from __future__ import annotations

import json
import os
from pathlib import Path

from cli_runner import Resolved
from wifi_store import WifiStore
from wizard import WizardModel


class Keyring:
    def __init__(self, works: bool = True) -> None:
        self.works = works
        self.value = ""

    def load(self):
        return self.value

    def save(self, password: str) -> bool:
        if not self.works:
            return False
        self.value = password
        return True


def test_keeps_the_password_in_the_keyring_when_one_answers(tmp_path):
    keyring = Keyring()
    store = WifiStore(str(tmp_path / "cfg" / "wifi.json"), keyring)
    store.save(" Home ", "s3cret")
    raw = Path(store.path).read_text()
    assert "s3cret" not in raw and json.loads(raw)["ssid"] == "Home"
    assert keyring.value == "s3cret"
    assert WifiStore(store.path, keyring).load() == ("Home", "s3cret")


def test_falls_back_to_a_private_file(tmp_path):
    store = WifiStore(str(tmp_path / "cfg" / "wifi.json"), Keyring(works=False))
    store.save("Home", "s3cret")
    assert oct(os.stat(store.path).st_mode & 0o777) == "0o600"
    assert WifiStore(store.path, None).load() == ("Home", "s3cret")


def test_blank_values_forget_everything(tmp_path):
    keyring = Keyring()
    store = WifiStore(str(tmp_path / "wifi.json"), keyring)
    store.save("Home", "s3cret")
    store.save("", "")
    assert not os.path.exists(store.path)
    assert keyring.value == ""
    assert store.load() == ("", "")


def test_the_burn_passes_wifi_through_a_private_file(tmp_path, monkeypatch):
    m = WizardModel(
        locate_fn=lambda: Resolved(node_path="/usr/bin/node", entry_path="/cli.ts"),
        wifi_store=WifiStore(str(tmp_path / "wifi.json"), None),
    )
    m.set_wifi("Home", "p@ss word")
    seen = {}
    with m._wifi_flags() as flags:
        seen["flags"] = flags
        pw_file = flags[flags.index("--wifi-password-file") + 1]
        seen["mode"] = oct(os.stat(pw_file).st_mode & 0o777)
        seen["content"] = Path(pw_file).read_text()
    assert flags[:2] == ["--wifi-ssid", "Home"]
    assert "p@ss word" not in flags
    assert seen["mode"] == "0o600" and seen["content"] == "p@ss word"
    assert not os.path.exists(pw_file)
    m.set_wifi("", "")
    with m._wifi_flags() as flags:
        assert flags == []
