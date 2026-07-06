"""Unit tests for iso_manifest_client — POST shape + response parsing.

Mocks the HTTP layer via the `opener` seam so no network is touched.
"""
from __future__ import annotations

import io
import json

import pytest

from iso_manifest_client import (
    CurrentBase,
    DownloadDescriptor,
    ManifestHTTPError,
    ManifestOfflineError,
    ManifestParseError,
    fetch_manifest,
)


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _opener_for(body: dict, *, status: int = 200, capture: dict | None = None):
    payload = json.dumps(body).encode("utf-8")

    def _open(req):
        if capture is not None:
            capture["url"] = req.full_url
            capture["method"] = req.get_method()
            capture["body"] = json.loads(req.data.decode("utf-8"))
            capture["headers"] = {k.lower(): v for k, v in req.header_items()}
        return _FakeResponse(payload, status=status)

    return _open


# ---- request shape ----


def test_request_body_includes_platform_version_and_current():
    cap: dict = {}
    fetch_manifest(
        burner_version="1.2.3",
        current=CurrentBase(version="debian-12", sha256="ab" * 32),
        opener=_opener_for({"download": None}, capture=cap),
    )
    assert cap["method"] == "POST"
    assert cap["body"]["platform"] == "linux"
    assert cap["body"]["burnerVersion"] == "1.2.3"
    assert cap["body"]["current"] == {"version": "debian-12", "sha256": "ab" * 32}
    assert cap["headers"]["content-type"] == "application/json"


def test_request_current_null_when_no_cache():
    cap: dict = {}
    fetch_manifest(
        burner_version="1.0.0",
        current=None,
        opener=_opener_for({"download": None}, capture=cap),
    )
    assert cap["body"]["current"] is None


# ---- response parsing ----


def test_response_download_null_means_keep():
    res = fetch_manifest("1.0.0", None, opener=_opener_for({"download": None}))
    assert res.download is None


def test_response_download_parses_descriptor():
    body = {
        "download": {
            "url": "https://flagshipserver.com/base/debian.iso",
            "sha256": "cd" * 32,
            "version": "debian-12.5",
            "sizeBytes": 700 * 1024 * 1024,
            "attestation": "https://flagshipserver.com/base/debian.att",
        }
    }
    res = fetch_manifest("1.0.0", None, opener=_opener_for(body))
    assert isinstance(res.download, DownloadDescriptor)
    assert res.download.url == "https://flagshipserver.com/base/debian.iso"
    assert res.download.sha256 == "cd" * 32
    assert res.download.version == "debian-12.5"
    assert res.download.size_bytes == 700 * 1024 * 1024


def test_response_download_http_url_is_parse_error():
    body = {
        "download": {
            "url": "http://flagshipserver.com/base/debian.iso",  # not https
            "sha256": "cd" * 32,
            "version": "debian-12.5",
            "sizeBytes": 1,
            "attestation": "https://x/att",
        }
    }
    with pytest.raises(ManifestParseError, match="https"):
        fetch_manifest("1.0.0", None, opener=_opener_for(body))


def test_response_download_bad_sha_is_parse_error():
    body = {
        "download": {
            "url": "https://flagshipserver.com/base/debian.iso",
            "sha256": "not-a-sha",
            "version": "debian-12.5",
            "sizeBytes": 1,
            "attestation": "https://x/att",
        }
    }
    with pytest.raises(ManifestParseError, match="hex"):
        fetch_manifest("1.0.0", None, opener=_opener_for(body))


def test_response_download_sha_is_lowercased():
    body = {
        "download": {
            "url": "https://flagshipserver.com/base/debian.iso",
            "sha256": "CD" * 32,
            "version": "debian-12.5",
            "sizeBytes": 1,
            "attestation": "https://x/att",
        }
    }
    res = fetch_manifest("1.0.0", None, opener=_opener_for(body))
    assert res.download.sha256 == "cd" * 32


def test_response_missing_download_key_is_parse_error():
    with pytest.raises(ManifestParseError):
        fetch_manifest("1.0.0", None, opener=_opener_for({"nope": 1}))


def test_response_download_missing_field_is_parse_error():
    body = {"download": {"url": "https://x/y.iso", "sha256": "ab" * 32}}
    with pytest.raises(ManifestParseError):
        fetch_manifest("1.0.0", None, opener=_opener_for(body))


def test_invalid_json_body_is_parse_error():
    def _open(_req):
        return _FakeResponse(b"<html>not json</html>")

    with pytest.raises(ManifestParseError):
        fetch_manifest("1.0.0", None, opener=_open)


# ---- transport errors ----


def test_http_error_status_maps_to_http_error():
    from urllib.error import HTTPError

    def _open(_req):
        raise HTTPError("u", 503, "boom", hdrs=None, fp=io.BytesIO(b""))

    with pytest.raises(ManifestHTTPError) as ei:
        fetch_manifest("1.0.0", None, opener=_open)
    assert ei.value.code == 503


def test_url_error_maps_to_offline():
    from urllib.error import URLError

    def _open(_req):
        raise URLError("name resolution failed")

    with pytest.raises(ManifestOfflineError):
        fetch_manifest("1.0.0", None, opener=_open)


def test_non_2xx_status_in_body_maps_to_http_error():
    with pytest.raises(ManifestHTTPError):
        fetch_manifest(
            "1.0.0", None, opener=_opener_for({"download": None}, status=500)
        )
