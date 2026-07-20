"""Unit tests for cli_runner — argument-vector builders, locator
fallback logic, JSON parser. Mirrors CLIArgsTests + VerifyResultTests in
the Mac tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from cli_runner import (
    CLILocateError,
    args_prepare,
    args_user_data,
    args_verify,
    args_write,
    find_entry,
    find_node,
    parse_verify_json,
)


# ---- argument vectors ----


def test_args_verify_minimal():
    a = args_verify("/cli.ts", "/r.json")
    assert a == ["/cli.ts", "verify", "/r.json"]


def test_args_user_data_with_keep():
    a = args_user_data("/cli.ts", "/r.json", "/out", keep_recipe=True)
    assert a == ["/cli.ts", "user-data", "/r.json", "/out", "--keep-recipe"]


def test_args_user_data_without_keep():
    a = args_user_data("/cli.ts", "/r.json", "/out", keep_recipe=False)
    assert a == ["/cli.ts", "user-data", "/r.json", "/out"]


def test_args_prepare_with_keep():
    a = args_prepare("/cli.ts", "/r.json", "/iso.iso", "/out.iso", keep_recipe=True)
    assert a == ["/cli.ts", "prepare", "/r.json", "/iso.iso", "/out.iso", "--keep-recipe"]


def test_args_write_no_device_no_yes():
    a = args_write("/cli.ts", "/r.json", "/iso.iso", device=None, yes=False, keep_recipe=False)
    assert a == ["/cli.ts", "write", "/r.json", "/iso.iso"]


def test_args_write_device_yes():
    a = args_write("/cli.ts", "/r.json", "/iso.iso", device="/dev/sdb", yes=True, keep_recipe=False)
    assert a == ["/cli.ts", "write", "/r.json", "/iso.iso", "--device", "/dev/sdb", "--yes"]


def test_args_write_all_flags():
    a = args_write("/cli.ts", "/r.json", "/iso.iso",
                   device="auto", yes=True, keep_recipe=True)
    assert a == ["/cli.ts", "write", "/r.json", "/iso.iso",
                 "--device", "auto", "--yes", "--keep-recipe"]


# ---- find_node ----


def test_find_node_uses_env_override():
    paths = {"/opt/me/node"}
    node = find_node(fileexists=lambda p: p in paths,
                     environ={"FLAGSHIP_NODE_PATH": "/opt/me/node"})
    assert node == "/opt/me/node"


def test_find_node_skips_missing_env_override():
    # If override path doesn't exist, we move on to the candidate list.
    paths = {"/usr/bin/node"}
    node = find_node(fileexists=lambda p: p in paths,
                     environ={"FLAGSHIP_NODE_PATH": "/does/not/exist"})
    assert node == "/usr/bin/node"


def test_find_node_raises_when_nothing_found(monkeypatch):
    monkeypatch.setattr("cli_runner.shutil.which", lambda _: None)
    with pytest.raises(CLILocateError):
        find_node(fileexists=lambda _: False, environ={})


def test_find_node_falls_back_to_path(monkeypatch):
    monkeypatch.setattr("cli_runner.shutil.which", lambda _: "/somewhere/path/node")
    node = find_node(fileexists=lambda _: False, environ={})
    assert node == "/somewhere/path/node"


# ---- find_entry ----


def test_find_entry_uses_env_override(tmp_path):
    fake = tmp_path / "cli.ts"
    fake.write_text("// stub\n")
    e = find_entry(environ={"FLAGSHIP_BURN_ENTRY": str(fake)})
    assert e == str(fake)


def test_find_entry_skips_missing_env_override_then_falls_to_dev_path(tmp_path, monkeypatch):
    # Build the apps/builder-linux/../../packages/flagship-builder/src/cli.ts path
    # under a fake repo root.
    fake_repo = tmp_path / "flagship-fake"
    builder_dir = fake_repo / "apps" / "builder-linux"
    builder_dir.mkdir(parents=True)
    cli_src = fake_repo / "packages" / "flagship-builder" / "src" / "cli.ts"
    cli_src.parent.mkdir(parents=True)
    cli_src.write_text("// stub\n")

    e = find_entry(
        executable_dir=builder_dir,
        environ={"FLAGSHIP_BURN_ENTRY": "/does/not/exist"},
    )
    assert e == str(cli_src)


def test_find_entry_raises_when_no_candidate(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(CLILocateError):
        find_entry(executable_dir=empty, environ={})


# ---- parse_verify_json ----


def test_parse_verify_json_clean_object():
    text = """{
      "ok": true,
      "serverDomain": "alice.flagship.services",
      "expiresAt": "2026-06-01T00:00:00.000Z"
    }"""
    parsed = parse_verify_json(text)
    assert parsed is not None
    assert parsed["ok"] is True
    assert parsed["serverDomain"] == "alice.flagship.services"


def test_parse_verify_json_with_preamble():
    text = """+ node /cli.ts verify /r.json
loading recipe...
{
  "ok": true,
  "serverDomain": "alice.flagship.services"
}
shredded recipe: /r.json
"""
    parsed = parse_verify_json(text)
    assert parsed is not None
    assert parsed["serverDomain"] == "alice.flagship.services"


def test_parse_verify_json_no_brace_returns_none():
    assert parse_verify_json("just a log line") is None


def test_parse_verify_json_unbalanced_returns_none():
    assert parse_verify_json("{ this is not json") is None


def test_parse_verify_json_handles_nested_objects():
    text = """noise
{"ok": true, "nested": {"a": 1, "b": {"c": 2}}}
trailer
"""
    parsed = parse_verify_json(text)
    assert parsed is not None
    assert parsed["nested"]["b"]["c"] == 2


def test_command_vector_wraps_in_pkexec_by_default():
    from cli_runner import CLIRunner

    r = CLIRunner(node_path="/usr/bin/node", arguments=["/cli.js", "write"], use_pkexec=True)
    assert r.command_vector == ["pkexec", "/usr/bin/node", "/cli.js", "write"]


def test_command_vector_honors_the_elevation_prefix():
    from cli_runner import CLIRunner

    r = CLIRunner(
        node_path="/usr/bin/node",
        arguments=["/cli.js", "write"],
        use_pkexec=True,
        elevation_prefix=["sudo", "-n"],
    )
    assert r.command_vector == ["sudo", "-n", "/usr/bin/node", "/cli.js", "write"]


def test_command_vector_ignores_the_prefix_without_pkexec():
    from cli_runner import CLIRunner

    r = CLIRunner(
        node_path="/usr/bin/node",
        arguments=["/cli.js", "verify"],
        elevation_prefix=["sudo", "-n"],
    )
    assert r.command_vector == ["/usr/bin/node", "/cli.js", "verify"]


def test_find_entry_prefers_the_built_dist_over_the_ts_source(tmp_path):
    from cli_runner import find_entry

    pkg = tmp_path / "packages" / "flagship-builder"
    (pkg / "src").mkdir(parents=True)
    (pkg / "dist").mkdir(parents=True)
    (pkg / "src" / "cli.ts").write_text("ts")
    (pkg / "dist" / "cli.js").write_text("js")
    exe_dir = tmp_path / "apps" / "builder-linux"
    exe_dir.mkdir(parents=True)
    # Plain `node` cannot execute the .ts (ERR_UNKNOWN_FILE_EXTENSION) — the
    # built dist must win whenever it exists.
    got = find_entry(executable_dir=exe_dir, environ={})
    assert got.endswith("dist/cli.js")


def test_find_entry_falls_back_to_the_ts_source_without_a_build(tmp_path):
    from cli_runner import find_entry

    pkg = tmp_path / "packages" / "flagship-builder"
    (pkg / "src").mkdir(parents=True)
    (pkg / "src" / "cli.ts").write_text("ts")
    exe_dir = tmp_path / "apps" / "builder-linux"
    exe_dir.mkdir(parents=True)
    got = find_entry(executable_dir=exe_dir, environ={})
    assert got.endswith("src/cli.ts")
