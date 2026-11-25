#!/usr/bin/env python3
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from import_export import command, key, write_export


class Exports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.parent = pathlib.Path(self.tmp.name).resolve()
        self.source = self.parent / "board.kicad_pcb"
        self.source.write_bytes(b"original")
        self.project = [("Main.kicad_pro", b"project"), ("sheets/Child.kicad_sch", b"first")]

    def write(self, **opts):
        return write_export(self.parent, "Board export", self.project, [self.source], **opts)

    def test_directory_exchange_and_collision(self):
        first = self.write()
        self.assertEqual(self.write()["name"], "Board export (2)")
        self.project[1] = ("sheets/Child.kicad_sch", b"edited")
        second = self.write(receipt=first)
        self.assertNotEqual(first["entries"], second["entries"])
        dest = pathlib.Path(second["path"])
        self.assertEqual((dest / "sheets/Child.kicad_sch").read_bytes(), b"edited")
        (dest / "new.txt").write_text("external")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.write(receipt=second)
        self.assertEqual((dest / "new.txt").read_text(), "external")
        self.assertEqual(self.source.read_bytes(), b"original")

    def test_strict_names_cancel(self):
        self.write()
        with self.assertRaises(FileExistsError):
            self.write(strict=True)
        self.project = [("A/file.sch", b""), ("a/Other.sch", b"")]
        with self.assertRaises(ValueError):
            self.write()
        self.project = [("safe.sch", b"abc")]
        with self.assertRaisesRegex(ValueError, "canceled"):
            self.write(before_publish=lambda: (_ for _ in ()).throw(ValueError("canceled")))
        self.assertEqual(sorted(p.name for p in self.parent.iterdir()), ["Board export", self.source.name])

    def test_parent_barrier_failure_restores_old_target(self):
        from unittest.mock import patch
        from import_export import fsync_dir
        initial = self.write()
        self.project[1] = ("sheets/Child.kicad_sch", b"next")
        def barrier(path):
            if pathlib.Path(path) == self.parent:
                raise OSError("storage did not acknowledge update")
            fsync_dir(path)
        with patch("import_export.fsync_dir", barrier):
            with self.assertRaisesRegex(OSError, "acknowledge"):
                self.write(receipt=initial)
            with self.assertRaisesRegex(OSError, "acknowledge"):
                self.write()
        self.assertEqual((self.parent / "Board export/sheets/Child.kicad_sch").read_bytes(), b"first")
        self.assertFalse((self.parent / "Board export (2)").exists())

    def test_source_alias_and_remember(self):
        import base64
        import hashlib
        import os
        inputs = {"sources": [str(self.source)], "single": True, "files": [{"name":"card.kicad_pcb","data":base64.b64encode(b"x").decode()}],
                  "support":str(self.parent / "support"), "key": key(self.source, hashlib.sha256(b"original").hexdigest())}
        alias = self.parent / "alias.kicad_pcb"
        os.link(self.source, alias)
        for target in (alias, self.source):
            with self.assertRaisesRegex(ValueError, "separate"):
                command("writeExport", dict(inputs, selected=str(target)))
        out = self.parent / "card.kicad_pcb"
        initial = command("writeExport", dict(inputs, selected=str(out)))["receipt"]
        self.assertFalse((self.parent / "support").exists())
        command("rememberExport", dict(inputs, receipt=initial))
        self.assertEqual(command("recallExport", inputs)["receipt"], initial)
        inputs["files"][0]["data"] = base64.b64encode(b"next").decode()
        updated = command("writeExport", dict(inputs,receipt=initial))["receipt"]
        self.assertEqual(command("recallExport", inputs)["receipt"], updated)
        from unittest.mock import patch
        with patch("import_export.remember", side_effect=PermissionError("private profile is read-only")):
            result = command("writeExport", dict(inputs, receipt=updated))
        self.assertEqual(result["receipt"]["name"], out.name)
        self.assertIn("export was saved", result["preferenceError"])
        out.write_bytes(b"other")
        self.assertIsNone(command("recallExport", inputs)["receipt"])
        with self.assertRaisesRegex(ValueError, "changed"):
            command("writeExport", dict(inputs,receipt=updated))
        command("forgetExport", inputs)
        self.assertEqual(out.read_bytes(), b"other")


if __name__ == "__main__":
    unittest.main()
