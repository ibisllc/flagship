"""Unit tests for iso_base_cache — manifest-driven keep vs download vs
sha-mismatch. Mocks both the manifest fetch and the HTTP download; uses a
temp XDG_CACHE_HOME so nothing touches the real cache.
"""
from __future__ import annotations

import hashlib

import pytest

import iso_base_cache
from iso_base_cache import (
    ChecksumMismatchError,
    ManifestFetchError,
    ensure,
    inspect_cache,
)
from iso_manifest_client import (
    CurrentBase,
    DownloadDescriptor,
    ManifestResult,
)


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    return tmp_path


def _write_base(version: str, data: bytes) -> tuple[str, str]:
    """Write a cached base ISO of `version`; return (path, sha256)."""
    path = iso_base_cache.cached_path_for(version)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path), hashlib.sha256(data).hexdigest()


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200, content_length: bool = True):
        self._body = body
        self.status = status

        class _H:
            def __init__(self, length):
                self._length = length

            def get(self, key, default=None):
                if key == "Content-Length":
                    return self._length
                return default

        self.headers = _H(str(len(body)) if content_length else None)

    def read(self, _n=-1) -> bytes:
        b, self._body = self._body, b""
        return b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ---- inspect ----


def test_inspect_empty_cache_returns_none():
    assert inspect_cache() is None


def test_inspect_logs_path_and_sha(tmp_path):
    path, sha = _write_base("debian-12", b"hello-base")
    logs: list[str] = []
    cached = inspect_cache(log=logs.append)
    assert cached is not None
    assert cached.version == "debian-12"
    assert cached.sha256 == sha
    assert any(path in line and sha in line for line in logs)


# ---- keep ----


def test_ensure_keep_when_manifest_returns_null():
    path, sha = _write_base("debian-12", b"keep-me")
    seen: dict = {}

    def fake_manifest(builder_version, current, arch="amd64"):
        seen["current"] = current
        return ManifestResult(download=None)

    out = ensure("9.9.9", manifest_fn=fake_manifest)
    assert str(out) == path
    # The builder reported its current cache; never decided by sha itself.
    assert isinstance(seen["current"], CurrentBase)
    assert seen["current"].version == "debian-12"
    assert seen["current"].sha256 == sha


def test_ensure_keep_logs_decision():
    _write_base("debian-12", b"keep-me")
    logs: list[str] = []
    ensure("1.0.0", log=logs.append, manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=None))
    assert any("keep cached base" in line for line in logs)


# ---- download ----


def test_ensure_downloads_when_ordered_and_verifies():
    data = b"a brand new debian base iso payload"
    sha = hashlib.sha256(data).hexdigest()
    descriptor = DownloadDescriptor(
        url="https://flagshipserver.com/base/debian.iso",
        sha256=sha,
        version="debian-12.5",
        size_bytes=len(data),
        attestation="https://flagshipserver.com/base/debian.att",
    )

    urls_seen: list[str] = []
    logs: list[str] = []

    def fake_open(_req):
        return _FakeResponse(data)

    out = ensure(
        "1.0.0",
        progress=lambda frac, url: urls_seen.append(url),
        log=logs.append,
        manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=descriptor),
        opener=fake_open,
    )
    assert out.read_bytes() == data
    assert out.name == "flagship-base-debian-12.5.iso"
    # URL surfaced to the progress callback (so the UI shows it under the bar).
    assert urls_seen and all(u == descriptor.url for u in urls_seen)
    # path + sha + url logged after download.
    assert any(str(out) in line and sha in line and descriptor.url in line for line in logs)


def test_ensure_sha_mismatch_deletes_and_raises():
    data = b"the real bytes"
    wrong_sha = "00" * 32
    descriptor = DownloadDescriptor(
        url="https://flagshipserver.com/base/debian.iso",
        sha256=wrong_sha,
        version="debian-12.5",
        size_bytes=len(data),
        attestation="https://x/att",
    )

    def fake_open(_req):
        return _FakeResponse(data)

    with pytest.raises(ChecksumMismatchError):
        ensure(
            "1.0.0",
            manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=descriptor),
            opener=fake_open,
        )
    # No partial / final file left behind.
    dest = iso_base_cache.cached_path_for("debian-12.5")
    assert not dest.exists()
    assert not dest.with_suffix(dest.suffix + ".partial").exists()


def test_ensure_cancel_event_aborts_and_removes_partial():
    import threading

    data = b"bytes that never finish"
    descriptor = DownloadDescriptor(
        url="https://flagshipserver.com/base/debian.iso",
        sha256=hashlib.sha256(data).hexdigest(),
        version="debian-12.5",
        size_bytes=len(data),
        attestation="https://x/att",
    )
    cancel = threading.Event()
    cancel.set()  # tripped before the first chunk — the tightest race

    with pytest.raises(iso_base_cache.CancelledError):
        ensure(
            "1.0.0",
            manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=descriptor),
            opener=lambda req: _FakeResponse(data),
            cancel_event=cancel,
        )
    dest = iso_base_cache.cached_path_for("debian-12.5")
    assert not dest.exists()
    assert not dest.with_suffix(dest.suffix + ".partial").exists()


def test_ensure_reports_current_on_download_path():
    _write_base("debian-12", b"old base")
    captured: dict = {}
    data = b"new base bytes"
    descriptor = DownloadDescriptor(
        url="https://flagshipserver.com/base/new.iso",
        sha256=hashlib.sha256(data).hexdigest(),
        version="debian-12.5",
        size_bytes=len(data),
        attestation="https://x/att",
    )

    def fake_manifest(builder_version, current, arch="amd64"):
        captured["current"] = current
        return ManifestResult(download=descriptor)

    started: list = []
    ensure(
        "1.0.0",
        on_download_start=lambda d: started.append(d),
        manifest_fn=fake_manifest,
        opener=lambda req: _FakeResponse(data),
    )
    assert captured["current"].version == "debian-12"
    assert started and started[0].version == "debian-12.5"


# ---- offline resilience ----


def test_ensure_manifest_error_falls_back_to_cache():
    from iso_manifest_client import ManifestOfflineError

    path, _sha = _write_base("debian-12", b"cached")

    def boom(v, c, arch="amd64"):
        raise ManifestOfflineError("no net")

    out = ensure("1.0.0", manifest_fn=boom)
    assert str(out) == path


def test_ensure_manifest_error_no_cache_raises():
    from iso_manifest_client import ManifestOfflineError

    def boom(v, c, arch="amd64"):
        raise ManifestOfflineError("no net")

    with pytest.raises(ManifestFetchError):
        ensure("1.0.0", manifest_fn=boom)


def test_ensure_null_download_no_cache_raises():
    with pytest.raises(ManifestFetchError):
        ensure("1.0.0", manifest_fn=lambda v, c, arch="amd64": ManifestResult(download=None))
