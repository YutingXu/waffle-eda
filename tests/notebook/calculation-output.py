"""Read a calculation through the existing MCP tools and inspect both exported sheets."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[2]


class CalculationOutput(unittest.TestCase):
    def test_read_only_and_static_fidelity(self):
        bindings = [{"id": "r", "name": "R5", "span": [0, 2],
                     "target": {"scope": "item", "itemId": "r5", "docId": "sheet", "field": "value"}}]
        def note(key, expression, inputs):
            return dict(kind="textframe", id=key, x=10, y=20 if key == "live" else 45, w=50, h=18,
                        text=expression, calculation=dict(languageVersion=1, bindings=inputs, assertions=[]))
        design = dict(format="atrium", version=1, formatVersion="1.4", name="Tolerance notebook",
                      library=[dict(id="resistor", name="Resistor", prefix="R", symbol=dict(shapes=[], pins=[]))],
                      documents=[dict(kind="schematic", id="sheet", name="Timing", grid=2.54, outline=[], notes=[],
                                      items=[dict(kind="part", id="r5", def_="resistor", ref="R5", value="10k", x=0, y=0),
                                             note("live", "R5 * 2", bindings), note("missing", "R404", [])])])
        part = design["documents"][0]["items"][0]
        part["def"] = part.pop("def_")
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "Timing.waffle"
            project.write_text(json.dumps(design), encoding="utf-8")
            original = project.read_bytes()
            revision = hashlib.sha256(original).hexdigest()
            def call(name, **args):
                p = subprocess.run(["python3", str(ROOT / "mcp/server.py"), "--project", str(project), "--cli", name,
                                    "--args", json.dumps(args)], capture_output=True, text=True)
                self.assertEqual(p.returncode, 0, p.stderr or p.stdout)
                return json.loads(p.stdout)
            expression = call("calculate", expression="R5 * 2", document_id="sheet")
            block = call("calculate", block_id="live", document_id="sheet")
            self.assertEqual(expression["result"]["display"], "20 kΩ")
            self.assertEqual(expression["result"], block["records"][0]["result"])
            self.assertEqual(revision, block["file_revision"])
            self.assertEqual(block["records"][0]["inputs"][0]["target"]["itemId"], "r5")
            self.assertIn("tolerance unknown", block["records"][0]["result"]["warnings"][0])
            broken = call("calculate", block_id="missing")["records"][0]["result"]
            self.assertFalse(broken["ok"])
            self.assertEqual(broken["diagnostic"]["span"], [0, 4])
            self.assertEqual(call("calculate", calculator="eseries", inputs={"value": 5000})["calculator"], "eseries")
            row = call("list_notebook", item_id="live")["rows"][0]
            self.assertEqual(row["evaluation"]["result"]["display"], "20 kΩ")
            self.assertEqual(row["evaluation"]["inputs"][0]["target"]["itemId"], "r5")
            printed = call("export_pdf", documents=["sheet"], date="2026-01-05T00:00:00Z")
            pdf = next(Path(temp).rglob("*.pdf")).read_bytes()
            self.assertEqual(printed["file_revision"], revision)
            streams = []
            for stream in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf, flags=re.S):
                try:
                    streams.append(zlib.decompress(stream))
                except zlib.error:
                    streams.append(stream)
            actual_text = ("FEFF" + "R5 * 2".encode("utf-16-be").hex()).upper().encode("ascii")
            self.assertIn(b"/ACTUALTEXT <" + actual_text + b">", b"\n".join(streams).upper())
            kicad = call("export_kicad", document_id="sheet")
            altium = call("export_altium")
            self.assertEqual({f["blockId"] for f in kicad["files"][0]["fidelity"]}, {"live", "missing"})
            self.assertEqual({f["blockId"]:f["status"] for f in altium["fidelity"]}, {"live":"static", "missing":"incomplete"})
            k = next(Path(temp).rglob("*.kicad_sch")).read_text()
            self.assertIn("20 kΩ", k)
            a = next(Path(temp).rglob("*.SchDoc")).read_bytes()
            self.assertIn("20 kΩ".encode("utf-8"), a)
            self.assertTrue(any("missing" in n and "live bindings" in n for n in altium["diagnostics"]))
            self.assertEqual(original, project.read_bytes())
            self.assertFalse(project.with_suffix(".waffle.bak").exists())


if __name__ == "__main__":
    unittest.main()

