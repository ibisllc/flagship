"""About shows the one product version (release/version.json): a release
number reads as '<major>.<minor> <label>', anything else is shown as is."""
from __future__ import annotations

import json
from pathlib import Path

import version


def test_a_release_reads_as_the_product_version_with_its_label():
    assert version.display_version("0.2.0") == f"0.2 {version.LABEL}"


def test_a_dev_build_and_a_patch_release_are_shown_as_is():
    assert version.display_version("0.0.0-dev") == "0.0.0-dev"
    assert version.display_version("0.2.1") == "0.2.1"


def test_the_label_is_the_shared_release_files():
    shared = json.loads((Path(__file__).resolve().parents[3] / "release" / "version.json").read_text())
    assert version.LABEL == shared["label"]
