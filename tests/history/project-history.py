#!/usr/bin/env python3
"""Branched design fixture, native read-only checks and MCP/Compare parity. All Git writes are in a temporary fixture."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mcp"))
from server import Server
from git_head import BaselineError, query
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, make_sample, read_design, write_design
from obsolete_project import ObsoleteProject


def git(folder, *args, **kwargs):
    return subprocess.run(["git", "-C", str(folder), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                           "-c", "commit.gpgSign=false", *args], check=True, **kwargs)


def make_history(folder, count=8):
    if any(folder.iterdir()) or count < 8:
        raise ValueError("Use an empty synthetic fixture folder and at least eight commits.")
    path = folder / "Bench.waffle"
    git(folder, "init", "-q", "-b", "main")
    with tempfile.TemporaryDirectory(prefix="waffle-history-authoring-") as directory:
        scratch = Path(directory)
        base = read_design(make_sample(scratch / "source"))
        board_index = next(i for i, doc in enumerate(base["documents"]) if doc["kind"] == "pcb")
        board = base["documents"][board_index]
        board["items"] += [{"kind": "track", "id": "rail-" + str(i), "width": .2, "net": "SUPPLY", "layer": "Top",
                            "points": [[0, i], [8, i], [13, i + 5]]} for i in range(6)]
        board_branch = copy.deepcopy(base)
        for track in board_branch["documents"][board_index]["items"][-6:]:
            track["points"][1][1] += 2
        main = copy.deepcopy(base)
        regulator = next(item for doc in main["documents"] for item in doc["items"] if item["id"] == "s-R1")
        regulator["value"] = "New regulator"
        merged = copy.deepcopy(main)
        merged["documents"][board_index] = board_branch["documents"][board_index]
        staging = scratch / "staging"
        stream = bytearray()
        snapshots = {}

        def commit(n, branch, parents, subject, design=None):
            note = subject.encode()
            stream.extend(("commit refs/heads/%s\nmark :%d\ncommitter Test <test@example.invalid> %d +0000\ndata %d\n" %
                           (branch, n, 1700000000 + n, len(note))).encode() + note + b"\n")
            for i, parent in enumerate(parents):
                stream.extend(("%s :%d\n" % ("merge" if i else "from", parent)).encode())
            old = snapshots[parents[0]] if parents else {}
            if design is False:
                files = {}
            elif design is None:
                files = old
            else:
                write_design(staging / path.name, design)
                files = authored_files(staging)
            for name in sorted(old.keys() - files.keys()):
                stream.extend(("D " + json.dumps(name) + "\n").encode())
            for name, raw in sorted(files.items()):
                if old.get(name) != raw:
                    stream.extend(("M 100644 inline %s\ndata %d\n" % (json.dumps(name), len(raw))).encode() + raw + b"\n")
            stream.extend(b"\n")
            snapshots[n] = files

        commit(1, "main", [], "Start project")
        commit(2, "main", [1], "Add sensor interface", base)
        commit(3, "layout", [2], "Reroute supply", board_branch)
        commit(4, "main", [2], "Update regulator", main)
        commit(5, "main", [4, 3], "Merge supply routing", merged)
        commit(6, "main", [5], "Manufacturing notes")
        commit(7, "main", [6], "Remove design", False)
        commit(8, "main", [7], "Restore design", merged)
        for n in range(9, count + 1):
            merged["documents"][board_index]["items"][-1]["points"][1][0] = 7 + n % 23
            commit(n, "main", [n - 1], "Tune supply routing " + str(n), merged)
            del snapshots[n - 1]
        git(folder, "fast-import", "--quiet", input=stream)
        for name, data in snapshots[count].items():
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    git(folder, "read-tree", "HEAD")
    return path


class ProjectHistory(unittest.TestCase):
    def test_branched_history_is_read_only_and_agrees_with_compare(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            project = make_history(root)
            before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            server = Server(project)
            self.addCleanup(server.close)
            self.assertTrue(server.call("project_summary", {})["git"]["repository"])
            self.assertTrue(next(t for t in server.tool_list() if t["name"] == "project_history")["annotations"]["readOnlyHint"])
            listing = query(project, "projectLog", {})
            self.assertEqual(len(listing["commits"]), 8)
            self.assertIn("layout", [r["short"] for r in listing["refs"]])
            page = server.call("project_history", {"limit": 3})
            more = server.call("project_history", {"limit": 10, "offset": page["next_offset"], "snapshot": page["snapshot"]})
            rows = page["commits"] + more["commits"]
            self.assertEqual([r["revision"] for r in rows], [c["revision"] for c in listing["commits"]])
            by_subject = {r["untrusted_design_text"]["subject"]: r for r in rows}
            self.assertTrue(all("summary_error" not in r["untrusted_design_text"] for r in rows), rows)
            merge = by_subject["Merge supply routing"]
            self.assertEqual(merge["parents"], [by_subject[n]["revision"] for n in ("Update regulator", "Reroute supply")])
            self.assertIn("6 tracks rerouted", merge["untrusted_design_text"]["summary"])
            self.assertEqual(merge["before_blob"], by_subject["Update regulator"]["after_blob"])
            self.assertEqual(by_subject["Manufacturing notes"]["total"], 0)
            self.assertEqual(by_subject["Start project"]["counts"], {"electrical": 0, "mechanical": 0, "cosmetic": 0})
            for name, absent in [("Add sensor interface", "before"), ("Remove design", "after")]:
                row = by_subject[name]
                self.assertIsNone(row[absent + "_blob"])
                for region in row["untrusted_design_text"]["regions"]:
                    self.assertIsNone(region[absent])
                    self.assertTrue(region["after" if absent == "before" else "before"])
            tile = merge["untrusted_design_text"]["regions"][0]
            self.assertNotEqual(tile["before"]["changed"], tile["after"]["changed"])
            for row in rows:
                self.assertEqual(row["total"], sum(row["counts"].values()))
            report = server.call("diff_designs", {"before": merge["parents"][0], "after": merge["revision"]})
            self.assertEqual(report["summary"]["bySeverity"], merge["counts"])
            runner = server.automation.runner()
            with patch.object(runner, "call", wraps=runner.call) as execute:
                self.assertEqual(server.call("project_history", {"limit": 8})["commits"], rows)
                self.assertNotIn("AtriumProjectHistoryReport", [call.args[0] for call in execute.call_args_list])
            for args in ({"snapshot": "0" * 64}, {"mode": "write"}, {"limit": 21}):
                with self.assertRaises(ValueError):
                    server.call("project_history", args)
            for revs in ([], ["HEAD"], ["0" * 40], [merge["revision"]] * 3):
                with self.assertRaises(BaselineError):
                    query(project, "projectBlobs", {"revisions": revs})
            after = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(after.keys(), before.keys())
            self.assertTrue(all(after[k] == v for k, v in before.items()))

    def test_outside_and_unborn_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = make_sample(root, "Bench.waffle")
            server = Server(path)
            self.addCleanup(server.close)
            self.assertFalse(server.call("project_history", {})["repository"])
            self.assertFalse(server.call("project_summary", {})["git"]["repository"])
            git(root, "init", "-q")
            page = server.call("project_history", {})
            self.assertTrue(page["repository"])
            self.assertEqual(page["commits"], [])
            self.assertIsNone(page["head"])

    def test_shallow_history_reads_the_available_native_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            source, clone = root / "source", root / "shallow"
            source.mkdir()
            project = make_history(source)
            git(root, "clone", "-q", "--depth", "2", source.as_uri(), str(clone))
            server = Server(clone / project.name)
            self.addCleanup(server.close)
            history = server.call("project_history", {"limit": 8})
            restored, removed = history["commits"]
            self.assertIsNone(history["next_offset"])
            self.assertEqual(restored["parents"], [removed["revision"]])
            self.assertEqual(removed["parents"], [])
            self.assertIsNone(restored["before_blob"])
            self.assertEqual(restored["after_file_revision"], server.call("project_summary", {})["file_revision"])
            self.assertTrue(all("summary_error" not in entry["untrusted_design_text"] for entry in (restored, removed)))
            self.assertGreater(restored["total"], 0)

    def test_source_history_compares_real_kicad_revisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            project = root / "Bench.kicad_pcb"
            source = (ROOT / "tests/fixtures/import/demo.kicad_pcb").read_bytes()
            edited = source.replace(b'(property "Value" "10k"', b'(property "Value" "47k"', 1)
            self.assertNotEqual(edited, source)
            git(root, "init", "-q")
            for raw, subject in ((source, "Source board"), (edited, "Replace R1 value")):
                project.write_bytes(raw)
                git(root, "add", "--", project.name)
                git(root, "commit", "-qm", subject)
            server = Server(project)
            self.addCleanup(server.close)
            page = server.call("project_history", {"limit": 2})
            replaced, initial = page["commits"]
            self.assertEqual(replaced["before_blob"], initial["after_blob"])
            self.assertNotIn("summary_error", replaced["untrusted_design_text"])
            self.assertGreater(replaced["total"], 0)
            self.assertIn("47k", replaced["untrusted_design_text"]["summary"])
            self.assertEqual(project.read_bytes(), edited)

    def test_altium_source_history_accepts_configuration_and_library_before_drawings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            project, board, library = (root / name for name in ("Bench.PrjPcb", "Bench.PcbDoc", "Lab.SchLib"))
            design_only = "[Design]\nVersion=1.0\n"
            with_library = design_only + "[Document1]\nDocumentPath=Lab.SchLib\n"
            with_board = with_library + "[Document2]\nDocumentPath=Bench.PcbDoc\n"
            git(root, "init", "-q")
            project.write_text(design_only)
            git(root, "add", "--", project.name)
            git(root, "commit", "-qm", "Project configuration")
            project.write_text(with_library)
            library.write_bytes((ROOT / "tests/fixtures/library/Lab.SchLib").read_bytes())
            git(root, "add", "--", project.name, library.name)
            git(root, "commit", "-qm", "Library first")
            project.write_text(with_board)
            public_board = ROOT / "tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"
            board.write_bytes(public_board.read_bytes())
            git(root, "add", "--", project.name, board.name)
            git(root, "commit", "-qm", "First drawing")
            server = Server(project)
            self.addCleanup(server.close)
            drawing, definitions, configuration = server.call("project_history", {"limit": 3})["commits"]
            self.assertTrue(all("summary_error" not in row["untrusted_design_text"] for row in (drawing, definitions, configuration)))
            self.assertEqual(configuration["total"], 0)
            self.assertTrue("library" in definitions["untrusted_design_text"]["summary"].lower() or definitions["total"] > 0)
            self.assertGreater(drawing["total"], 0)
            self.assertTrue(any(region["kind"] == "pcb" and not region["before"] and region["after"]
                                for region in drawing["untrusted_design_text"]["regions"]))
            self.assertEqual(project.read_text(), with_board)
            self.assertEqual(board.read_bytes(), public_board.read_bytes())
            git(root, "rm", "-q", "--", board.name)
            git(root, "commit", "-qm", "Referenced drawing absent")
            missing = server.call("project_history", {"limit": 1})["commits"][0]
            self.assertIn("referenced drawings unavailable", missing["untrusted_design_text"]["summary_error"])

    def test_historical_pre_release_blobs_have_the_approved_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            project = make_sample(root, "Bench.waffle")
            native = project.read_bytes()
            git(root, "init", "-q")
            git(root, "add", "--", ".")
            git(root, "commit", "-qm", "Native base")
            fixtures = ROOT / "tests" / "fixtures" / "compat" / "projects"
            names = ["v1.3-inline-step-models.atrium", "v1.4-sample.atrium", "v1.5-newer-project-rules.atrium",
                     "v1.6-newer-schematic-canvas.waffle"]
            for name in names:
                project.write_bytes((fixtures / name).read_bytes())
                git(root, "add", "--", project.name)
                git(root, "commit", "-qm", name)
            project.write_bytes(native)
            git(root, "add", "--", project.name)
            git(root, "commit", "-qm", "Native restored")
            server = Server(project)
            self.addCleanup(server.close)
            rows = server.call("project_history", {"limit": 10})["commits"]
            by_subject = {row["untrusted_design_text"]["subject"]: row for row in rows}
            note = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
            for name in names:
                row = by_subject[name]
                self.assertEqual(row["error_code"], "pre-release-format")
                self.assertEqual(row["untrusted_design_text"]["summary_error"], note)
                with self.assertRaises(ObsoleteProject) as refused:
                    server.call("diff_designs", {"before": row["revision"], "after": "HEAD"})
                self.assertEqual(str(refused.exception), note)
            self.assertGreater(by_subject["Native base"]["total"], 0)
            self.assertEqual(server.call("compare_git_head", {})["total"], 0)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--fixture"]:
        print(make_history(Path(sys.argv[2]).resolve(), int(sys.argv[3])))
    else:
        unittest.main()
