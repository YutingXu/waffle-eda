#!/usr/bin/env python3
"""Real repositories, linked worktrees and shell-free path handling for Git HEAD review."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HELPER = Path(__file__).resolve().parents[1] / "git_head.py"
spec = importlib.util.spec_from_file_location("atrium_git_head", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class GitBaseline(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="atrium-git-baseline-")
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name).resolve()
        self.repo = self.temp / "Main worktree"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Waffle test")
        self.git("config", "user.email", "test@example.invalid")
        self.file = self.repo / "电源 & [pins]" / "-Ana'log \"A\".waffle"
        self.file.parent.mkdir()
        self.original = json.dumps({"kind":"project","formatVersion":"2.0","id":"sensor","name":"电源"}, ensure_ascii=False,separators=(",",":")) + "\n"
        self.file.write_text(self.original, encoding="utf-8")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", str(cwd or self.repo), *args], capture_output=True, check=True).stdout

    def cli(self, path, *args):
        return subprocess.run([sys.executable, "-B", str(HELPER), "--project", str(path), *args], capture_output=True)

    def commit(self, message="fixture"):
        self.git("add", "--", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD").decode().strip()

    def test_explicit_new_branch_preserves_index_worktree_head_and_config(self):
        rev = self.commit()
        original = self.file.read_bytes()
        paths = [self.repo / ".git" / f for f in ("HEAD", "index", "config")]
        previous = [f.read_bytes() for f in paths]
        args = {"confirm": True, "name": "review/supply", "revision": rev}
        for changes in ({"confirm": False}, {"name": "bad..name"}, {"name": "-option"}, {"revision": "HEAD"}):
            with self.assertRaises(helper.BaselineError):
                helper.query(self.file, "createBranch", {**args, **changes})
        self.assertEqual(helper.query(self.file, "createBranch", args)["revision"], rev)
        self.assertEqual(self.git("rev-parse", "refs/heads/review/supply").decode().strip(), rev)
        with self.assertRaises(helper.BaselineError):
            helper.query(self.file, "createBranch", args)
        self.assertEqual([f.read_bytes() for f in paths], previous)
        self.assertEqual(self.file.read_bytes(), original)

    def test_committed_object_and_worktree(self):
        rev = self.commit()
        self.file.write_text(self.original.replace("电源", "Edited"), encoding="utf-8")
        self.git("add", ".")
        self.file.write_text(self.original.replace("电源", "Working"), encoding="utf-8")
        index = self.repo / ".git" / "index"
        index_before = (hashlib.sha256(index.read_bytes()).digest(), index.stat().st_mtime_ns)
        with mock.patch.dict(os.environ, {"GIT_DIR": str(self.temp / "wrong-repo")}):
            result = self.cli(self.file)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"text":self.original,"path": self.file.relative_to(self.repo).as_posix(),"revision":rev})
        self.assertEqual(index_before, (hashlib.sha256(index.read_bytes()).digest(), index.stat().st_mtime_ns))
        self.assertIn("Working", self.file.read_text(encoding="utf-8"))
        wt = self.temp / "linked"
        self.git("worktree", "add", "--detach", str(wt), rev)
        other = wt / self.file.relative_to(self.repo)
        with other.open("a") as out:
            out.write(" ")
        self.assertEqual(json.loads(self.cli(other).stdout), json.loads(result.stdout))

    def test_commit_selects_exact_staged_members_and_preserves_the_index(self):
        document = self.file.parent / "Circuit.wsch"
        project_path = document.relative_to(self.repo).as_posix()
        config = self.file.parent / "unrelated.txt"
        reference = {"docKind": "schematic", "id": "sch", "kind": "document", "path": document.name}
        self.file.write_text(self.original + json.dumps(reference, separators=(",", ":")) + "\n", encoding="utf-8")
        header = '{"formatVersion":"2.0","id":"sch","kind":"schematic"}\n'
        document.write_text(header, encoding="utf-8")
        config.write_text("baseline\n", encoding="utf-8")
        parent = self.commit()
        document.write_text(header + '{"value":"staged"}\n', encoding="utf-8")
        config.write_text("staged separately\n", encoding="utf-8")
        self.git("add", "--", project_path, str(config.relative_to(self.repo)))
        document.write_text(header + '{"value":"working"}\n', encoding="utf-8")
        index = self.repo / ".git" / "index"
        staged_index = index.read_bytes()
        plan = helper.query(self.file, "commitPlan")
        self.assertEqual(plan["head"], parent)
        self.assertEqual(plan["paths"], [{"path": project_path, "change": "modified"}])
        args = {"message": "Publish the circuit", "paths": [project_path], "plan": plan["plan"]}
        with self.assertRaisesRegex(ValueError, "confirm"):
            helper.query(self.file, "commitStaged", args)
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), parent)
        result = self.cli(self.file, "--query", "commitStaged", "--args=" + json.dumps({**args, "confirm": True}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["commit"], self.git("rev-parse", "HEAD").decode().strip())
        self.assertEqual(self.git("rev-parse", "HEAD^").decode().strip(), parent)
        self.assertIn(b'"staged"', self.git("show", "HEAD:" + project_path))
        self.assertIn('"working"', document.read_text(encoding="utf-8"))
        self.assertEqual(index.read_bytes(), staged_index)
        self.assertEqual(self.git("diff", "--cached", "--name-only", "-z"),
                         os.fsencode(config.relative_to(self.repo).as_posix()) + b"\0")

    def test_commit_requires_a_fresh_preview_of_the_staged_paths(self):
        original = self.commit()
        relative = self.file.relative_to(self.repo).as_posix()
        self.file.write_text(self.original.replace("电源", "First"), encoding="utf-8")
        self.git("add", "--", relative)
        plan = helper.query(self.file, "commitPlan")
        self.file.write_text(self.original.replace("电源", "Second"), encoding="utf-8")
        self.git("add", "--", relative)
        with self.assertRaisesRegex(ValueError, "Preview the commit again"):
            helper.query(self.file, "commitStaged", {"confirm": True, "message": "old contents", "paths": [relative], "plan": plan["plan"]})
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), original)
        plan = helper.query(self.file, "commitPlan")
        self.git("commit", "--allow-empty", "--only", "-qm", "Advance HEAD without consuming the stage")
        advanced = self.git("rev-parse", "HEAD")
        self.assertNotEqual(advanced.decode().strip(), original)
        with self.assertRaisesRegex(ValueError, "Preview the commit again"):
            helper.query(self.file, "commitStaged", {"confirm": True, "message": "old parent", "paths": [relative], "plan": plan["plan"]})
        self.assertEqual(self.git("rev-parse", "HEAD"), advanced)
        self.assertEqual(helper.query(self.file, "commitPlan")["paths"], [{"path": relative, "change": "modified"}])

    def test_invalid_paths_and_revisions(self):
        self.assertIn(b"no HEAD", self.cli(self.file).stderr)
        self.commit()
        untracked = self.repo / ":(glob)*.waffle"
        untracked.write_text(self.original)
        self.assertIn(b"no committed", self.cli(untracked).stderr)
        outside = self.temp / "outside.waffle"
        outside.write_text(self.original)
        self.assertIn(b"outside a Git worktree", self.cli(outside).stderr)
        self.assertNotEqual(self.cli("relative.waffle").returncode, 0)
        self.assertNotEqual(self.cli(self.repo).returncode, 0)
        link = self.repo / "linked.waffle"
        link.symlink_to(self.file)
        self.assertIn(b"original path", self.cli(link).stderr)
        self.file.write_text('{"name":"unknown"}')
        self.commit()
        self.assertIn(b"supported Waffle", self.cli(self.file).stderr)
        self.file.write_bytes(b'\xfe\x00')
        self.commit()
        self.assertIn(b"Waffle project", self.cli(self.file).stderr)

    def test_two_commits_history_scope_and_raw_transport(self):
        original = self.file.read_bytes()
        first = self.commit("Imported 电源 | 'board'")
        changed = self.original.replace("电源","Second").encode("utf-8-sig")
        self.file.write_bytes(changed)
        second = self.commit("Routed 'A' | B")
        (self.repo / "unrelated.txt").write_text("unrelated")
        self.commit("An unrelated file")
        self.file.write_text(self.original.replace("电源","Staged"))
        self.git("add", "--", ".")
        self.file.write_text(self.original.replace("电源","Dirty"))
        meta = json.loads(self.cli(self.file, "--history").stdout)
        self.assertEqual(meta["path"], self.file.relative_to(self.repo).as_posix())
        self.assertEqual([row["revision"] for row in meta["commits"]], [second,first])
        self.assertEqual([row["subject"] for row in meta["commits"]], ["Routed 'A' | B","Imported 电源 | 'board'"])
        self.assertTrue(all("T" in row["date"] for row in meta["commits"]))
        with mock.patch.object(helper,"HISTORY_LIMIT",1):
            self.assertEqual(len(helper.ProjectHistory(self.file).history()["commits"]),1)
        for commit, expected in [(first,original),(second,changed)]:
            packet = self.cli(self.file,"--desktop-stream","--revision",commit)
            self.assertEqual(packet.returncode,0,packet.stderr)
            frame, blob = packet.stdout.split(b"\n",1)
            self.assertEqual(json.loads(frame),{"revision":commit,"path":meta["path"],"size":len(expected)})
            self.assertEqual(blob,expected)
            self.assertEqual(helper.baseline(self.file,revision=commit)["text"],expected.decode("utf-8-sig"))
        self.assertIn("Dirty", self.file.read_text())
        self.assertIn(b"Staged", self.git("show",":"+meta["path"]))
        for target in ["HEAD","--help",":(glob)*",second[:8]]:
            self.assertIn(b"full commit",self.cli(self.file,"--revision="+target).stderr)
        blob = self.git("rev-parse", second+":"+meta["path"]).decode().strip()
        self.assertIn(b"not a commit",self.cli(self.file,"--revision",blob).stderr)
        tree = self.git("rev-parse","HEAD^{tree}").decode().strip()
        detached = self.git("commit-tree",tree,"-m","outside branch").decode().strip()
        self.assertIn(b"outside",self.cli(self.file,"--revision",detached).stderr)

    def test_altium_source_revision_includes_step_companions(self):
        manifest = self.file.parent / "Board.PrjPcb"
        manifest.write_text("[Document1]\nDocumentPath=Control.SchDoc\n"
                            "[Document2]\nDocumentPath=Enclosure.STP\n"
                            "[Document3]\nDocumentPath=Optional.step\n", encoding="utf-8")
        (manifest.parent / "Control.SchDoc").write_bytes(b"control\n")
        step = manifest.parent / "Enclosure.STP"
        step.write_bytes(b"first STEP fixture\n")
        before = self.commit("Original companion model")
        step.write_bytes(b"revised STEP fixture\n")
        after = self.commit("Changed only the model")
        snapshots = [helper.query(manifest, "sourceRevision", {"revision": revision}) for revision in (before, after)]
        for snapshot in snapshots:
            self.assertEqual([row["altiumPath"] for row in snapshot["files"]], [manifest.name, "Control.SchDoc", step.name])
            self.assertEqual(snapshot["missing"], [])
        self.assertNotEqual(snapshots[0]["blob"], snapshots[1]["blob"])
        self.assertNotEqual(snapshots[0]["files"][-1]["data"], snapshots[1]["files"][-1]["data"])

    def test_pre_release_revision_never_returns_bytes(self):
        original = self.file.read_bytes()
        old_bytes = b'{"format":"atrium","version":1,"documents":[],"private":"historic-design"}'
        self.file.write_bytes(old_bytes)
        first = self.commit("Retired pre-release format")
        self.file.write_bytes(original)
        head = self.commit("Install the current manifest")
        for arguments in [
            ["--revision", first, "--desktop-stream"],
            ["--query","read","--args",json.dumps({"revision":first}),"--desktop-stream"],
            ["--query","blameLog"], ["--query","patches","--args",json.dumps({"head":head,"revisions":[head]})],
            ["--query","folderRevisions","--args",json.dumps({"revisions":[first]})],
        ]:
            with self.subTest(arguments=arguments):
                proc = self.cli(self.file,*arguments)
                self.assertNotEqual(proc.returncode,0)
                self.assertEqual(proc.stdout,b"")
                self.assertEqual(proc.stderr.decode().strip(),str(helper.ObsoleteProject()))
        self.assertEqual(self.file.read_bytes(),original)
        # Supplying a cached historical object under a current revision cannot register it as current.
        forged = {"revision":head,"path":self.file.relative_to(self.repo).as_posix(),"text":old_bytes.decode()}
        self.assertEqual(helper.baseline(self.file,forged)["text"],original.decode())

    def test_blob_size_bound_and_missing_git(self):
        self.commit()
        previous = helper.baseline(self.file)
        with mock.patch.object(helper, "MAX_BYTES", 1):
            self.assertIs(helper.baseline(self.file, previous), previous)
            with self.assertRaisesRegex(helper.BaselineError, "size|limit"):
                helper.baseline(self.file)
            with self.assertRaisesRegex(helper.BaselineError, "size|limit"):
                helper.baseline(self.file, {**previous, "path":"another.waffle"})
        self.file.write_text(self.original.replace("电源", "Updated"), encoding="utf-8")
        self.commit()
        self.assertNotEqual(helper.baseline(self.file, previous)["revision"], previous["revision"])
        with mock.patch.dict(os.environ, {"PATH": str(self.temp)}):
            with self.assertRaisesRegex(helper.BaselineError, "Git is unavailable"):
                helper.baseline(self.file)


def project(items, name="Board"):
    """One real 2.0 per-member project setting per line, as seen in raw Git."""
    header = {"kind": "project", "formatVersion": "2.0", "id": "board", "name": name}
    rows = [{"kind": "projectSetting", "id": item["id"], "key": item["id"], "value": item} for item in items]
    priorities = {"kind":0, "formatVersion":1, "id":2}
    def canonical(value):
        if isinstance(value,dict):
            return {key:canonical(value[key]) for key in sorted(value,key=lambda key:(priorities.get(key,3),key))}
        if isinstance(value,list):
            return [canonical(item) for item in value]
        return value
    return "".join(json.dumps(canonical(row),ensure_ascii=False,separators=(",",":")) + "\n" for row in [header,*rows])



def parts(n=6, net="VIN"):
    return [{"id": "p%d" % i, "kind": "part", "ref": "R%d" % i, "def": "std-r", "x": 10 * i, "y": 0, "angle": 0,
             "pinNets": {"1": net, "2": "GND"}} for i in range(1, n + 1)] + \
           [{"id": "t1", "kind": "track", "net": net, "layer": "Top", "width": 250000, "points": [[0, 0], [10, 0]]}]


class GitQueries(unittest.TestCase):
    """git_head.query: the operations behind the revision picker, file history, blame and merge view."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="atrium-git-query-")
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name).resolve() / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Ana Tester")
        self.git("config", "user.email", "ana@example.invalid")
        self.file = self.repo / "Board.waffle"
        self.items = parts()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, check=True).stdout.decode()

    def save(self, message, **changes):
        for item in self.items:
            if item["id"] in changes:
                item.update(changes[item["id"]])
        self.file.write_text(project(self.items), encoding="utf-8")
        self.git("add", "--", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD").strip()

    def q(self, op, args=None):
        return helper.query(self.file, op, args)

    def test_log_search_matches_message_body_or_author_email_once(self):
        body = self.save("Initial board\n\nPart Match [R1].")
        self.git("config", "user.email", "match@example.invalid")
        self.git("commit", "--allow-empty", "-qm", "Unrelated subject")
        author = self.git("rev-parse", "HEAD").strip()
        self.git("commit", "--allow-empty", "-qm", "Match in both")
        both = self.git("rev-parse", "HEAD").strip()
        full = self.q("log", {"search": "mAtCH"})
        self.assertEqual({c["revision"] for c in full["commits"]}, {body, author, both})
        self.assertEqual(len(full["commits"]), 3)
        self.assertEqual([c["revision"] for c in self.q("log", {"search": "[R1]."})["commits"]], [body])
        first = self.q("log", {"search": "mAtCH", "limit": 1})
        rest = self.q("log", {"search": "mAtCH", "limit": 2, "skip": 1})
        self.assertTrue(first["more"])
        self.assertFalse(rest["more"])
        self.assertEqual(first["commits"] + rest["commits"], full["commits"])

    def test_refs_log_search_and_lanes_data(self):
        first = self.save("Initial board")
        second = self.save("Move R1", p1={"x": 11})
        (self.repo / "notes.txt").write_text("x")
        self.git("add", ".")
        self.git("commit", "-qm", "Notes only")
        self.git("tag", "-a", "v1", "-m", "release")
        self.git("checkout", "-qb", "feature", first)
        feature = self.save("Feature: move R2", p2={"y": 5})
        self.git("checkout", "-q", "main")
        refs = self.q("refs")
        self.assertEqual(refs["ref"], "refs/heads/main")
        names = {r["name"]: r for r in refs["refs"]}
        self.assertEqual(names["refs/heads/feature"]["revision"], feature)
        self.assertEqual(names["refs/tags/v1"]["kind"], "tag")
        self.assertEqual(names["refs/tags/v1"]["revision"], refs["head"], "annotated tags are peeled to their commit")
        log = self.q("log", {"limit": 50})
        revs = [c["revision"] for c in log["commits"]]
        self.assertEqual(set(revs), {first, second, feature, refs["head"]})
        touches = {c["subject"]: c["touches"] for c in log["commits"]}
        self.assertEqual(touches, {"Initial board": True, "Move R1": True, "Notes only": False, "Feature: move R2": True})
        self.assertTrue(all(c["author"] == "Ana Tester" and "T" in c["date"] for c in log["commits"]))
        self.assertEqual(next(c for c in log["commits"] if c["revision"] == second)["parents"], [first])
        only = self.q("log", {"refs": ["refs/heads/feature"]})
        self.assertEqual([c["revision"] for c in only["commits"]], [feature, first])
        self.assertEqual({c["subject"] for c in self.q("log", {"search": "move r"})["commits"]}, {"Move R1", "Feature: move R2"})
        self.assertEqual([c["revision"] for c in self.q("log", {"search": second[:9]})["commits"]], [second])
        self.assertEqual(len(self.q("log", {"search": "ana tester"})["commits"]), 4, "author search")
        self.assertEqual(self.q("log", {"search": ".*"})["commits"], [], "search text is not a pattern")
        page = self.q("log", {"limit": 2})
        self.assertTrue(page["more"])
        self.assertEqual(len(self.q("log", {"limit": 2, "skip": 2})["commits"]), 2)
        self.assertEqual([c["revision"] for c in self.q("fileLog")["commits"]], [second, first])
        self.assertEqual(self.q("mergeBase", {"a": feature, "b": refs["head"]})["base"], first)
        # A branch tip outside HEAD's history is readable (it is reachable from a ref)...
        self.assertIn('"y":5', self.q("read", {"revision": feature})["text"])
        # The desktop --revision read (gitRevision) takes branch tips too.
        cli = subprocess.run([sys.executable, "-B", str(HELPER), "--project", str(self.file), "--revision", feature], capture_output=True)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertIn('"y":5', json.loads(cli.stdout)["text"])
        # ...a dangling commit is not.
        tree = self.git("rev-parse", "HEAD^{tree}").strip()
        dangling = self.git("commit-tree", tree, "-m", "dangling").strip()
        with self.assertRaisesRegex(helper.BaselineError, "outside"):
            self.q("read", {"revision": dangling})

    def test_worktree_index_status_and_conflict_stages(self):
        self.save("Initial board")
        self.items[0]["x"] = 1
        self.file.write_text(project(self.items), encoding="utf-8")
        self.git("add", ".")
        self.items[0]["x"] = 2
        self.file.write_text(project(self.items), encoding="utf-8")
        st = self.q("status")
        self.assertFalse(st["conflicted"])
        self.assertEqual(len({st["headBlob"], st["indexBlob"], st["worktreeBlob"]}), 3)
        self.assertEqual(st["worktreeBlob"], self.git("hash-object", "--no-filters", str(self.file)).strip())
        self.assertIn('"x":2', self.q("read", {"revision": "worktree"})["text"])
        staged = self.q("read", {"revision": "index"})
        self.assertIn('"x":1', staged["text"])
        self.assertEqual(staged["blob"], st["indexBlob"])
        with self.assertRaisesRegex(helper.BaselineError, "not in a merge conflict"):
            self.q("read", {"revision": "theirs"})

    def test_blame_log_and_patches(self):
        first = self.save("Initial board")
        second = self.save("Move R1", p1={"x": 11})
        third = self.save("Move R3 and R4", p3={"x": 31}, p4={"y": 2})
        log = self.q("blameLog")
        self.assertEqual([c["revision"] for c in log["commits"]], [third, second, first])
        self.assertEqual(log["commits"][-1]["status"], "A")
        self.assertIsNone(log["commits"][-1]["oldBlob"])
        self.assertEqual(log["commits"][0]["oldBlob"], log["commits"][1]["blob"])
        patches = self.q("patches", {"head": third, "revisions": [third, second]})["patches"]
        self.assertEqual([p["revision"] for p in patches], [third, second])
        hunks = patches[0]["hunks"]
        self.assertEqual(len(hunks), 1, "R3 and R4 are adjacent lines: one hunk")
        old_start, old_count, new_start, new_count, removed, added = hunks[0]
        self.assertEqual((old_start, old_count, new_start, new_count), (4, 2, 4, 2))
        self.assertIn('"id":"p3"', added[0])
        self.assertIn('"x":30', removed[0])
        self.assertIn('"y":2', added[1])
        self.assertEqual(self.q("patches", {"head": third, "revisions": [second]})["patches"][0]["hunks"][0][4:],
                         [[project(parts()).splitlines()[1]], [project([dict(parts()[0], x=11)]).splitlines()[1]]])
        with self.assertRaisesRegex(helper.BaselineError, "HEAD moved"):
            self.q("patches", {"head": second, "revisions": [second]})
        with self.assertRaisesRegex(helper.BaselineError, "first-parent"):
            self.q("patches", {"head": third, "revisions": ["0" * 40]})

    def test_blame_and_patches_follow_first_parent_renames(self):
        first = self.save("First version")
        moved = self.save("Move R1 before the rename", p1={"x": 11})
        old = self.file
        self.file = self.repo / "Renamed [board].waffle"
        self.git("mv", "--", old.name, self.file.name)
        renamed = self.save("Rename and move R2", p2={"y": 22})
        # The old name may later designate someone else's design. Those bytes are outside this history.
        old.write_text("a different file\n")
        self.git("add", "--", old.name)
        self.git("commit", "-qm", "Reuse the previous name")
        old = self.file
        self.file = self.repo / "-third.waffle"
        self.git("mv", "--", old.name, self.file.name)
        same = self.save("Rename without editing")
        head = self.save("Move R3 after the rename", p3={"x": 33})
        rows = self.q("blameLog")["commits"]
        self.assertEqual([c["revision"] for c in rows], [head, same, renamed, moved, first])
        self.assertEqual([c["status"] for c in rows], ["M", "R", "R", "M", "A"])
        self.assertEqual(rows[1]["oldBlob"], rows[1]["blob"])
        self.assertEqual(rows[2]["oldBlob"], rows[3]["blob"])
        self.assertFalse(any("paths" in c for c in rows))
        patches = self.q("patches", {"head": head, "revisions": [head, same, renamed, moved]})["patches"]
        self.assertEqual(patches[1]["hunks"], [])
        for i, ref, key, expected in [(0, "p3", "x", 33), (2, "p2", "y", 22), (3, "p1", "x", 11)]:
            [hunk] = patches[i]["hunks"]
            [before], [after] = [[json.loads(line.strip().rstrip(",")) for line in lines] for lines in hunk[4:]]
            self.assertEqual((before["id"], after["id"], after["value"][key]), (ref, ref, expected))

    def test_queries_are_validated_and_read_only(self):
        self.save("Initial board")
        for op, args in [("push", {}), ("log", {"exec": "x"}), ("log", {"limit": -1}), ("log", {"limit": 1.5}), ("log", {"search": "a\nb"}),
                         ("log", {"search": {"x": 1}}), ("log", {"refs": ["refs/heads/nope"]}), ("log", {"refs": "--all"}),
                         ("patches", {"head": "HEAD", "revisions": ["HEAD"]}), ("read", {"revision": "HEAD"}), ("read", {"revision": "--output=x"}),
                         ("read", {"revision": "../x"}), ("installMergeDriver", {"confirm": "yes"}), ("installMergeDriver", {}), ("refs", [])]:
            with self.assertRaises(helper.BaselineError, msg=(op, args)):
                self.q(op, args)
        history = helper.ProjectHistory(self.file)
        with self.assertRaisesRegex(helper.BaselineError, "read-only"):
            history.git(["config", "core.hooksPath", "x"], "x")
        with self.assertRaisesRegex(helper.BaselineError, "read-only"):
            history.git(["-c", "x=y", "fetch"], "x")
        # Hooks, fsmonitor and textconv from the repository never run.
        marker = self.repo.parent / "ran"
        hooks = self.repo / ".git" / "hooks"
        for hook in ("post-checkout", "pre-commit", "reference-transaction", "post-index-change"):
            (hooks / hook).write_text("#!/bin/sh\ntouch '%s'\n" % marker)
            (hooks / hook).chmod(0o755)
        self.git("config", "core.fsmonitor", "%s" % (hooks / "pre-commit"))
        self.git("config", "diff.evil.textconv", "touch '%s'; cat" % marker)
        self.git("config", "core.pager", "touch '%s'; cat" % marker)
        (self.repo / ".gitattributes").write_text("*.waffle diff=evil filter=evil\n")
        self.git("config", "filter.evil.smudge", "touch '%s'; cat" % marker)
        self.git("config", "filter.evil.clean", "touch '%s'; cat" % marker)
        index = self.repo / ".git" / "index"
        before = index.read_bytes()
        self.items[0]["x"] = 5
        self.file.write_text(project(self.items), encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "filter.evil.clean=cat",
                        "commit", "-qam", "edit"], check=True, capture_output=True)
        marker.unlink(missing_ok=True)
        before = index.read_bytes()
        head = helper.ProjectHistory(self.file).head
        for op, args in [("refs", None), ("status", None), ("log", {"limit": 5}), ("fileLog", None), ("blameLog", None),
                         ("patches", {"head": head, "revisions": [head]}), ("read", {"revision": "worktree"}), ("read", {"revision": head}), ("read", {"revision": "index"})]:
            self.q(op, args)
        self.assertFalse(marker.exists(), "a hook, fsmonitor, pager, filter or textconv ran")
        self.assertEqual(index.read_bytes(), before, "queries never write the index")
        self.assertEqual(helper.validate_query("log", {"limit": 5.0, "refs": ["a"]}), {"limit": 5, "refs": ["a"]})


def js_engine():
    sys.path.insert(0, str(HELPER.parent.parent / "mcp"))
    try:
        import board_runner
        board_runner.BoardRunner().close()
        return True
    except (ImportError, ValueError, OSError):
        return False


@unittest.skipUnless(js_engine(), "no JavaScript engine for the merge driver (JavaScriptCore or Node)")
class MergeDriver(unittest.TestCase):
    """Branch scenarios through `git merge` with the driver registered by --install-merge-driver."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="waffle-merge-")
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name).resolve() / "design repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "T")
        self.git("config", "user.email", "t@example.invalid")
        self.file = self.repo / "Board.waffle"
        self.write(parts())
        result = subprocess.run([sys.executable, "-B", str(HELPER), "--install-merge-driver", str(self.repo)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("*.waffle merge=waffle", (self.repo / ".gitattributes").read_text())
        self.assertIn("--merge-driver %O %A %B -- %P", self.git("config", "--local", "merge.waffle.driver").stdout)
        self.git("add", ".")
        self.git("commit", "-qm", "base")

    def git(self, *args, check=True):
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, check=check, text=True)

    def write(self, items):
        self.file.write_text(project(items), encoding="utf-8")

    def items(self):
        return {row["id"]: row["value"] for row in map(json.loads,self.file.read_text().splitlines()[1:])}

    def branch(self, name, edit):
        self.git("checkout", "-q", "-b", name, "main")
        items = parts()
        edit(items)
        self.write(items)
        self.git("commit", "-qam", name)
        self.git("checkout", "-q", "main")

    def on_main(self, edit):
        items = list(self.items().values())
        edit(items)
        self.write(items)
        self.git("commit", "-qam", "main edit")

    def test_different_parts_auto_merge(self):
        # Independent rows in the canonical manifest merge using standard Git text semantics.
        self.branch("side", lambda items: items[1].update(x=99))
        self.on_main(lambda items: items[4].update(y=42))
        result = self.git("merge", "--no-edit", "side", check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        merged = self.items()
        self.assertEqual((merged["p2"]["x"], merged["p5"]["y"]), (99, 42))

    def test_same_part_conflicts_for_the_merge_view(self):
        self.branch("side", lambda items: items[0].update(x=50))
        self.on_main(lambda items: items[0].update(x=70))
        result = self.git("merge", "--no-edit", "side", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict: project manifest", result.stderr)
        self.assertEqual(self.items()["p1"]["x"], 70, "the worktree keeps a valid project with our side")
        st = helper.query(self.file, "status")
        self.assertTrue(st["conflicted"])
        self.assertEqual(st["stages"], ["base", "ours", "theirs"])
        texts = {stage: helper.query(self.file, "read", {"revision": stage})["text"] for stage in ("base", "ours", "theirs")}
        self.assertEqual([json.loads(texts[stage].splitlines()[1])["value"]["x"] for stage in ("base", "ours", "theirs")], [10.0, 70, 50])

    def test_source_and_sheet_merge_independently(self):
        sheet = self.repo / "Power.wsch"
        header = '{"kind":"schematic","formatVersion":"2.0","id":"zpower"}\n'
        sheet.write_text(header)
        with self.file.open("a") as stream:
            stream.write('{"kind":"document","id":"zpower","docKind":"schematic","name":"Power","path":"Power.wsch"}\n')
        self.git("add","."); self.git("commit","-qm","declare owner")
        self.git("switch","-qc","sheet")
        label = '{"kind":"netlabel","id":"sense","text":"SENSE"}\n'
        sheet.write_text(header + label)
        self.git("commit","-qam","change the sheet"); self.git("switch","-q","main")
        self.file.write_text(self.file.read_text().replace('"name":"Board"','"name":"Renamed"'))
        self.git("commit","-qam","rename the project")
        self.git("merge","--no-edit","sheet")
        self.assertIn('"name":"Renamed"',self.file.read_text())
        self.assertEqual(sheet.read_text(),header + label)
        head = self.git("rev-parse","HEAD").stdout.strip()
        snap = helper.query(self.file,"folderRevisions",{"revisions":[head]})["revisions"][0]
        self.assertEqual(set(snap["files"]),{self.file.name,sheet.name})

    def test_registered_driver_refuses_obsolete_without_writing(self):
        base, ours, theirs = (self.repo.parent / n for n in ("b","o","t"))
        base.write_text('{"format":"atrium","version":1,"documents":[]}'); ours.write_text(project(parts())); theirs.write_text(project(parts()))
        held = ours.read_bytes()
        result = subprocess.run([sys.executable,"-I","-B",str(HELPER),"--merge-driver",str(base),str(ours),str(theirs)],capture_output=True)
        self.assertEqual(result.returncode,2)
        self.assertEqual(result.stderr.decode().strip(),helper.ObsoleteProject().args[0])
        self.assertEqual(ours.read_bytes(),held)

    def test_driver_refuses_bad_input_and_leaves_ours(self):
        base, ours, theirs = (self.repo.parent / n for n in ("b", "o", "t"))
        base.write_text(project(parts()))
        ours.write_text("not json")
        theirs.write_text(project(parts()))
        result = subprocess.run([sys.executable, "-B", str(HELPER), "--merge-driver", str(base), str(ours), str(theirs), "Board.waffle"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(ours.read_text(), "not json")

    def test_option_like_merge_path_is_a_path(self):
        base, ours, theirs = (self.repo.parent / n for n in ("b2", "o2", "t2"))
        for f in (base, ours, theirs):
            f.write_text(project(parts()))
        for name in ("--install-merge-driver=x.atrium", "--args=x.atrium"):
            result = subprocess.run([sys.executable, "-B", str(HELPER), "--merge-driver", str(base), str(ours), str(theirs), "--", name],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


class SetUpAndLimits(unittest.TestCase):
    """The Set Up dialog plan, refusals and streaming."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="atrium-git-setup-")
        self.addCleanup(temp.cleanup)
        self.tmp = Path(temp.name).resolve()

    def repo(self, name):
        r = self.tmp / name
        r.mkdir(parents=True)
        subprocess.run(["git", "-C", str(r), "init", "-q"], check=True)
        (r / "Board.waffle").write_text(project(parts()), encoding="utf-8")
        return r

    def test_plan_then_install_with_the_token(self):
        r = self.repo("design")
        plan = helper.query(r / "Board.waffle", "mergeDriverPlan")
        self.assertEqual((plan["config"], plan["attributes"]), (str(r / ".git" / "config"), str(r / ".gitattributes")))
        self.assertNotIn("history", plan)
        self.assertFalse((r / ".gitattributes").exists(), "the plan writes nothing")
        with self.assertRaisesRegex(helper.BaselineError, "confirmation"):
            helper.query(r / "Board.waffle", "installMergeDriver", {"confirm": True})
        with self.assertRaisesRegex(helper.BaselineError, "changed"):
            helper.query(r / "Board.waffle", "installMergeDriver", {"confirm": True, "plan": "0" * 32})
        done = helper.query(r / "Board.waffle", "installMergeDriver", {"confirm": True, "plan": plan["plan"]})
        self.assertEqual(done["config"], plan["config"])
        self.assertIn("merge=waffle", (r / ".gitattributes").read_text())
        self.assertIn("-- %P", subprocess.run(["git", "-C", str(r), "config", "merge.waffle.driver"], capture_output=True, text=True).stdout)

    def test_refuses_redirected_repositories_and_odd_attribute_files(self):
        home = self.tmp / "home"
        r = home / "Downloads" / "design"
        r.mkdir(parents=True)
        subprocess.run(["git", "-C", str(home), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(r), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(r), "config", "core.worktree", "../../.."], check=True)
        (r / "Board.waffle").write_text(project(parts()))
        with self.assertRaisesRegex(helper.BaselineError, "Git directory"):
            helper.query(r / "Board.waffle", "mergeDriverPlan")
        other = self.repo("other")
        g = self.tmp / "gitfile"
        g.mkdir()
        (g / ".git").write_text("gitdir: %s\n" % (other / ".git"))
        subprocess.run(["git", "-C", str(other), "config", "core.worktree", str(g)], check=True)
        (g / "Board.waffle").write_text(project(parts()))
        with self.assertRaisesRegex(helper.BaselineError, "Git directory"):
            helper.install_merge_driver(g / "Board.waffle")
        self.assertNotIn('[merge "atrium"]', (other / ".git" / "config").read_text())
        fifo = self.repo("fifo")
        if hasattr(os, "mkfifo"):
            os.mkfifo(fifo / ".gitattributes")
            with self.assertRaisesRegex(helper.BaselineError, "not a regular file"):
                helper.query(fifo / "Board.waffle", "mergeDriverPlan")
        # A linked worktree of a normal repository is fine: its config is the main repository's.
        main = self.repo("main")
        subprocess.run(["git", "-C", str(main), "add", "."], check=True)
        subprocess.run(["git", "-C", str(main), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], check=True)
        subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "--detach", str(self.tmp / "linked")], check=True, capture_output=True)
        plan = helper.query(self.tmp / "linked" / "Board.waffle", "mergeDriverPlan")
        self.assertEqual(plan["config"], str(main / ".git" / "config"))

    def test_output_is_streamed_and_cut_at_the_limit(self):
        r = self.repo("big")
        (r / "Board.waffle").write_text("x" * (2 << 20))
        history = helper.ProjectHistory.__new__(helper.ProjectHistory)
        history.env, history.until, history.root = helper._clean_env(), time.monotonic() + 30, r
        subprocess.run(["git", "-C", str(r), "add", "."], check=True)
        blob = subprocess.run(["git", "-C", str(r), "rev-parse", ":Board.waffle"], capture_output=True, text=True).stdout.strip()
        with self.assertRaisesRegex(helper.BaselineError, "exceeds"):
            history.git(["cat-file", "blob", blob], "x", max_output=100000)
        budget = helper._Budget(150000)
        history.git(["cat-file", "blob", blob], "x", max_output=1 << 22, budget=helper._Budget(1 << 22))
        with self.assertRaisesRegex(helper.BaselineError, "exceeds"):
            history.git(["cat-file", "blob", blob], "x", max_output=1 << 22, budget=budget)
        self.assertEqual(history.git(["cat-file", "--batch-check=%(objectsize)"], "x", input=(blob + "\n").encode()).strip(), str(2 << 20).encode())


if __name__ == "__main__":
    unittest.main()
