"""First contact: what Studio reads from a hosted VM's server-code port and reports to .com."""
from __future__ import annotations

import json
import os
import stat
import threading
import time
from pathlib import Path

from pair_session import parse_pair_event
from vm import qemu_command_line, resource_plan, server_code_seen
from vm.config import VMConfig, VMNetworkMode
from vm.inventory import VMBundleLayout, VMInventoryStore
from vm.manager import VMManager

VECTORS = Path(__file__).resolve().parents[3] / "packages/protocol/test-vectors/enrollment/vectors.json"
KEY_HEX = "ab" * 32
DOMAIN = "home.alice.flagship.services"


def config(debug: bool = False) -> VMConfig:
    return VMConfig(
        name=DOMAIN,
        server_domain=DOMAIN,
        username="alice",
        server_name="home",
        cpu_count=2,
        memory_bytes=4 * resource_plan.GIB,
        main_disk_size_bytes=resource_plan.DEFAULT_MAIN_DISK_SIZE_BYTES,
        network_mode=VMNetworkMode.NAT,
        serial_console_enabled=debug,
        boot_unlock_mode="auto",
        disk_encrypted=True,
        provision_status_serial="FS-ABCD-1234",
    )


def test_the_mac_matches_the_shared_vectors():
    v = json.loads(VECTORS.read_text())
    key = bytes.fromhex(v["studioConfirmKeyHex"])
    for s in v["seen"]:
        assert server_code_seen.mac_hex(key, s["serverDomain"], s["stkPubHex"]) == s["macHex"]
    assert server_code_seen.mac_hex(b"\0" * 16, DOMAIN, KEY_HEX) is None


def test_only_this_servers_well_formed_line_counts():
    assert server_code_seen.parse(f"flagship-server-code Home.Alice.flagship.services 482913 {KEY_HEX}\n", DOMAIN) == server_code_seen.Sighting("482913", KEY_HEX)
    assert server_code_seen.parse(f"flagship-server-code home.bob.flagship.services 482913 {KEY_HEX}", DOMAIN) is None
    assert server_code_seen.parse(f"flagship-server-code {DOMAIN} 4829x3 {KEY_HEX}", DOMAIN) is None
    assert server_code_seen.parse(f"flagship-server-code {DOMAIN} 482913 {KEY_HEX.upper()}", DOMAIN) is None
    assert server_code_seen.pretty("482913") == "482 913"


def test_lines_split_across_reads_and_an_overlong_line_is_dropped():
    s = server_code_seen.ConsoleLineSplitter(max_line=32)
    assert s.feed(b"flagship-ser") == []
    assert s.feed(b"ver-code x\nnext") == ["flagship-server-code x"]
    assert s.feed(b"z" * 64) == []
    assert s.feed(b"ok\n") == ["ok"]


def test_every_vm_gets_an_output_only_server_code_port():
    layout = VMBundleLayout("/data/VMs")
    for debug in (False, True):
        args = qemu_command_line.build(config(debug), layout, "/c.fd", False, 4444, 0)
        joined = " ".join(args)
        assert "-device virtio-serial-pci,id=fsvs" in joined
        assert f"-chardev file,id=fscode,path={os.path.join(layout.bundle_dir(DOMAIN), 'server-code.log')}" in joined
        assert f"name={server_code_seen.PORT_NAME}" in joined


def test_the_pairing_done_event_carries_only_a_well_formed_key():
    ev = parse_pair_event('FLAGSHIP_PAIR {"event":"done","recipePath":"/tmp/r.json","studioConfirmKeyHex":"%s"}' % ("88" * 32))
    assert ev is not None and ev.studio_confirm_key_hex == "88" * 32
    bad = parse_pair_event('FLAGSHIP_PAIR {"event":"done","studioConfirmKeyHex":"xyz"}')
    assert bad is not None and bad.studio_confirm_key_hex is None


def test_the_key_is_kept_with_the_new_server_and_dropped_once_reported(tmp_path):
    store = VMInventoryStore(VMBundleLayout(str(tmp_path)))
    posts: list = []
    done = threading.Event()

    def seen_post(url, payload):
        posts.append((url, json.loads(payload)))
        done.set()
        return 200

    m = VMManager(store, None, "no qemu", seen_post=seen_post, code_watch_interval=0.01)
    key = b"\x88" * 32
    m.pending_studio_confirm_key = key
    m.create_server(config())
    assert m.pending_studio_confirm_key is None
    key_file = server_code_seen.key_path(store.layout, DOMAIN)
    assert stat.S_IMODE(os.stat(key_file).st_mode) == 0o600
    Path(server_code_seen.port_log_path(store.layout, DOMAIN)).write_text(
        "noise\n" f"flagship-server-code {DOMAIN} 482913 {KEY_HEX}\n"
    )
    m._watch_server_code(config())
    assert done.wait(5)
    (url, body), = posts
    assert url.endswith("/api/order/FS-ABCD-1234/server-seen")
    assert body == {"stkPubHex": KEY_HEX, "macHex": server_code_seen.mac_hex(key, DOMAIN, KEY_HEX)}
    for _ in range(100):
        if not os.path.exists(key_file):
            break
        time.sleep(0.01)
    assert not os.path.exists(key_file)
    assert m.server_codes[DOMAIN] == "482913"
