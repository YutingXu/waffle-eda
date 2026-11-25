#!/usr/bin/env python3
"""Verify package member closure and resource-root exceptions."""
import importlib.util
import io
from pathlib import Path
import unittest
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_preview", ROOT / "scripts/release-preview.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PreviewPayload(unittest.TestCase):
    expected = {"app/index.html": b"<html></html>", "bridge.js": b"// current"}
    label = "Windows ZIP"

    def test_duplicate_root_bridge_in_zip_fails_before_read(self):
        reads = []
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as package, warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Duplicate name: 'bridge.js'")
            package.writestr("bridge.js", b"// stale")
            for name, data in self.expected.items():
                package.writestr(name, data)
        stream.seek(0)
        with zipfile.ZipFile(stream) as package:
            def read(name):
                reads.append(name)
                return package.read(name)

            with self.assertRaisesRegex(ValueError, "duplicate runtime file"):
                release.verify_payload(read, package.namelist(), self.expected, self.label)
        self.assertEqual(reads, [])

    def test_missing_root_bridge_fails_before_read(self):
        with self.assertRaisesRegex(ValueError, r"missing \['bridge\.js'\], unexpected \[\]"):
            release.verify_payload(self.fail, ["app/index.html"], self.expected, self.label)

    def test_unexpected_managed_file_fails_before_read(self):
        with self.assertRaisesRegex(ValueError, r"unexpected \['app/old\.js'\]"):
            release.verify_payload(self.fail, [*self.expected, "app/old.js"], self.expected, self.label)

    def test_unknown_root_member_is_allowed_without_read(self):
        reads = []

        def read(name):
            reads.append(name)
            return self.expected[name]

        release.verify_payload(read, [*self.expected, "Waffle.icns"], self.expected, "Waffle.app")
        self.assertEqual(reads, list(self.expected))


if __name__ == "__main__":
    unittest.main()
