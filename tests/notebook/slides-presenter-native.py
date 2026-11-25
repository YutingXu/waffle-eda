#!/usr/bin/env python3
"""Exercise the actual Slides command through AppKit's secondary project window."""

from pathlib import Path
from runpy import run_path


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parent
FIXTURE = HERE / "fixtures/butter-acceptance/slides"


def verify(design):
    for expected in FIXTURE.iterdir():
        assert (design / expected.name).read_bytes() == expected.read_bytes(), expected.name


if __name__ == "__main__":
    harness = run_path(str(HERE / "native-bridge/window-workspace-native.py"))
    harness["run_probe"](FIXTURE, "Slide study.waffle", ROOT / "native/tests/slides-presenter.swift", verify)
