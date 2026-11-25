#!/usr/bin/env python3
"""Real plain-Git and opted-in merges of the same native PCB document."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "native/git_head.py"
WORKSHOP = ROOT / "tests/fixtures/format-2/workshop"
DESIGN = Path("Design μ")
BOARD = (DESIGN / "Board.wpcb").as_posix()
CONFLICT_MARKERS = (b"<<<<<<<", b"=======", b">>>>>>>")
EXTENSIONS = ("waffle", "wsch", "wpcb", "wdraw", "wpanel", "wlib", "wblock")


def encode_board(header, records, newline=b"\n"):
    def line(record):
        return json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    return newline.join([line(header), *(line(records[id]) for id in sorted(records, key=str.encode))]) + newline


class DesignRepo:
    def __init__(self, root, environment, attributes=None, newline=b"\n"):
        self.root, self.env, self.newline = root, environment, newline
        self.board = root / BOARD
        self.manifest = root / DESIGN / "Reference.waffle"
        self.attrs = root / ".gitattributes"
        self.config = root / ".git/config"
        shutil.copytree(WORKSHOP, root / DESIGN)
        self.header, *records = map(json.loads, self.board.read_bytes().splitlines())
        self.header.setdefault("requires", [])
        self.base = {record["id"]: record for record in records}
        self.base["z-old-tail"] = self.track("z-old-tail", [[6_000_000, 5_000_000], [7_000_000, 6_000_000]], "t")
        self.write(self.base)
        if attributes is not None:
            self.attrs.write_bytes(attributes)
        self.git("init", "-q", "-b", "main", "--template=")
        self.git("config", "--local", "waffleFixture.marker", "retain me")
        self.git("add", ".")
        self.git("commit", "-qm", "Reference PCB")
        self.start = self.rev("HEAD")
        self.payloads = {p.relative_to(root).as_posix(): p.read_bytes() for p in (root / DESIGN).rglob("*")
                         if p.is_file() and p != self.board}

    def git(self, *args, check=True):
        return subprocess.run(["git", "-C", os.fspath(self.root), *args], env=self.env,
                              check=check, capture_output=True, timeout=30)

    def cli(self, *args, check=True):
        return subprocess.run([sys.executable, "-I", "-B", os.fspath(DRIVER), *args], env=self.env,
                              check=check, capture_output=True, timeout=30)

    def query(self, operation, args=None, check=True):
        return self.cli("--project", os.fspath(self.manifest), "--query", operation,
                        "--args=" + json.dumps(args or {}), check=check)

    def settings(self):
        return self.config.read_bytes(), self.attrs.read_bytes() if self.attrs.is_file() else None

    def board_bytes(self, rows, newline=None):
        return encode_board(self.header, rows, self.newline if newline is None else newline)

    def write(self, rows):
        self.board.write_bytes(self.board_bytes(rows))

    def track(self, id, points, order):
        return {**self.base["run"], "id": id, "points": points, "order": order}

    def attribute(self, name):
        path, attribute, value, end = self.git("check-attr", "-z", name, "--", BOARD).stdout.split(b"\0")
        if (path, attribute, end) != (BOARD.encode(), name.encode(), b""):
            raise AssertionError("unexpected Git attribute result")
        return value

    def rev(self, ref):
        return self.git("rev-parse", ref).stdout.decode().strip()

    def routing_and_tail(self, *, reroute=False):
        records = {**self.base}
        del records["z-old-tail"]
        records["zz-new-tail"] = self.track("zz-new-tail", [[6_000_000, 5_000_000], [8_000_000, 5_500_000]], "u")
        if reroute:
            records["run"] = {**self.base["run"], "points": [[2_540_000, 4_000_000], [6_000_000, 5_000_000]]}
        return records

    def moved_probe(self, position):
        return {**self.base["probe"], "at": position}

    def history(self, ours, theirs):
        self.git("switch", "-q", "-c", "routing")
        self.write(theirs)
        self.git("commit", "-qam", "Routing branch PCB edit")
        right = self.rev("HEAD")
        self.git("switch", "-q", "main")
        self.write(ours)
        self.git("commit", "-qam", "Main branch PCB edit")
        left = self.rev("HEAD")
        return left, right

    def merge(self):
        return self.git("merge", "--no-edit", "routing", check=False)


class RealDocumentMerge(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="waffle-document-merge-")
        self.addCleanup(temporary.cleanup)
        self.scratch = Path(temporary.name).resolve()
        self.global_config = self.scratch / "global.gitconfig"
        self.global_config.write_bytes(b"[waffleFixture]\n\tmarker = global untouched\n")
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.fspath(self.global_config),
                        GIT_AUTHOR_NAME="Waffle fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                        GIT_COMMITTER_NAME="Waffle fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
                        GIT_TERMINAL_PROMPT="0", LC_ALL="C")
        self.global_before = self.global_config.read_bytes()

    def tearDown(self):
        self.assertEqual(self.global_config.read_bytes(), self.global_before)

    def assert_source_unchanged(self, repo):
        self.assertEqual({p.relative_to(repo.root).as_posix(): p.read_bytes()
                          for p in (repo.root / DESIGN).rglob("*") if p.is_file() and p != repo.board}, repo.payloads)

    def assert_clean_merge(self, repo, result, left, right, expected):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(repo.git("rev-list", "--parents", "-n", "1", "HEAD").stdout.decode().split()[1:], [left, right])
        self.assertEqual(repo.git("status", "--porcelain=v1", "-z").stdout, b"")
        self.assertEqual(repo.git("diff", "--name-only", "-z", repo.start, "HEAD").stdout, BOARD.encode() + b"\0")
        working = repo.board.read_bytes()
        self.assertEqual(working, repo.board_bytes(expected))
        if repo.newline == b"\r\n":
            self.assertNotIn(b"\n", working.replace(b"\r\n", b""))
        first, *rows = map(json.loads, working.splitlines())
        self.assertEqual(first, repo.header)
        self.assertEqual([r["id"] for r in rows], sorted(expected, key=str.encode))
        self.assertEqual({r["id"]: r for r in rows}, expected)
        self.assert_source_unchanged(repo)

    def assert_conflict_stages(self, repo, result, left, right, ours, theirs):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(repo.rev("HEAD"), left)
        self.assertEqual(repo.rev("MERGE_HEAD"), right)
        self.assertEqual(repo.git("status", "--porcelain=v1", "-z").stdout, b"UU " + BOARD.encode() + b"\0")
        for stage, expected in enumerate((repo.base, ours, theirs), 1):
            stored = repo.git("show", f":{stage}:{BOARD}").stdout
            self.assertEqual(stored, repo.board_bytes(expected, b"\n"), f"exact stage {stage}")
        self.assert_source_unchanged(repo)

    def test_plain_git_merges_separated_move_add_and_delete_without_setup(self):
        repo = DesignRepo(self.scratch / "plain", self.env)
        original_settings = repo.settings()
        ours = {**repo.base, "probe": repo.moved_probe([3_000_000, 4_200_000])}
        theirs = repo.routing_and_tail()
        left, right = repo.history(ours, theirs)
        self.assert_clean_merge(repo, repo.merge(), left, right, {**theirs, "probe": ours["probe"]})
        self.assertEqual(repo.git("diff", "--numstat", repo.start, "HEAD", "--", BOARD).stdout.split(b"\t")[:2], [b"2", b"2"])
        self.assertEqual(repo.settings(), original_settings)
        self.assertIsNone(original_settings[1])

    def test_plain_git_reports_adjacent_different_records(self):
        repo = DesignRepo(self.scratch / "plain-adjacent", self.env)
        original_settings = repo.settings()
        ours = {**repo.base, "probe": repo.moved_probe([3_000_000, 4_200_000])}
        theirs = {**repo.base, "run": {**repo.base["run"], "width": 300_000}}
        left, right = repo.history(ours, theirs)
        self.assert_conflict_stages(repo, repo.merge(), left, right, ours, theirs)
        working = repo.board.read_bytes()
        for marker in CONFLICT_MARKERS:
            self.assertIn(marker, working)
        self.assertTrue(working.startswith(repo.board_bytes(repo.base).splitlines(keepends=True)[0]))
        self.assertEqual(repo.settings(), original_settings)

    def install(self, repo):
        original_settings = repo.settings()
        plan = json.loads(repo.query("mergeDriverPlan").stdout)
        self.assertEqual((plan["config"], plan["attributes"]), (str(repo.config), str(repo.attrs)))
        self.assertEqual(set(plan["attributeLines"]), {f"*.{extension} merge=waffle" for extension in EXTENSIONS})
        self.assertEqual(repo.settings(), original_settings, "the plan is read-only")
        for rejected in ({}, {"confirm": False, "plan": plan["plan"]},
                         {"confirm": True, "plan": "wrong plan"}):
            self.assertNotEqual(repo.query("installMergeDriver", rejected, check=False).returncode, 0)
            self.assertEqual(repo.settings(), original_settings)
        before = repo.git("config", "--local", "--null", "--list").stdout.split(b"\0")
        reply = json.loads(repo.query("installMergeDriver", {"confirm": True, "plan": plan["plan"]}).stdout)
        self.assertTrue(reply["installed"])
        self.assertTrue(reply["attributeAdded"])
        after = repo.git("config", "--local", "--null", "--list").stdout.split(b"\0")
        self.assertEqual([entry for entry in after if not entry.startswith(b"merge.waffle.")], before)
        self.assertIn(b"--merge-driver %O %A %B -- %P", repo.git("config", "--local", "merge.waffle.driver").stdout)
        attributes = repo.attrs.read_bytes()
        self.assertTrue(attributes.startswith(original_settings[1] or b""), "keep user attribute bytes verbatim")
        if b"\r\n" in (original_settings[1] or b""):
            self.assertNotIn(b"\n", attributes.replace(b"\r\n", b""))
        for extension in EXTENSIONS:
            self.assertEqual(attributes.splitlines().count(f"*.{extension} merge=waffle".encode()), 1)
        settings = repo.settings()
        again = json.loads(repo.cli("--install-merge-driver", str(repo.root)).stdout)
        self.assertFalse(again["attributeAdded"])
        self.assertEqual(repo.settings(), settings, "explicit setup is idempotent")
        repo.git("add", ".gitattributes")
        repo.git("commit", "-qm", "Share explicit Waffle attributes")
        repo.start = repo.rev("HEAD")
        return settings

    def test_opt_in_merges_adjacent_ids_with_crlf_and_applies_only_in_this_clone(self):
        original_attributes = b"# Existing team settings\r\n*.wpcb text eol=crlf\r\n*.wsch text eol=lf\r\n"
        repo = DesignRepo(self.scratch / "opt-in-crlf", self.env, original_attributes, b"\r\n")
        self.assertEqual(repo.attribute("merge"), b"unspecified")
        settings = self.install(repo)
        self.assertEqual(repo.attribute("merge"), b"waffle")
        self.assertEqual(repo.attribute("eol"), b"crlf")
        self.assertEqual(repo.git("show", f"{repo.start}:{BOARD}").stdout, repo.board_bytes(repo.base, b"\n"))
        ours = {**repo.base, "probe": repo.moved_probe([3_000_000, 4_200_000])}
        theirs = repo.routing_and_tail(reroute=True)
        left, right = repo.history(ours, theirs)
        # Clone shared attributes while the branches still diverge. The local driver is not cloned.
        clone = self.scratch / "ordinary-clone"
        repo.git("clone", "-q", "--local", "--no-hardlinks", os.fspath(repo.root), os.fspath(clone))
        snapshot = (clone / ".git/config").read_bytes()
        self.assertNotIn(b"[merge", snapshot)
        self.assertEqual((clone / ".gitattributes").read_bytes(), repo.attrs.read_bytes())
        plain = subprocess.run(["git", "-C", str(clone), "merge", "--no-edit", "origin/routing"], env=self.env,
                               capture_output=True, timeout=30)
        self.assertEqual(plain.returncode, 1, plain.stdout + plain.stderr)
        self.assertIn(b"<<<<<<<", (clone / BOARD).read_bytes())
        self.assertEqual((clone / ".git/config").read_bytes(), snapshot)
        self.assert_clean_merge(repo, repo.merge(), left, right, {**theirs, "probe": ours["probe"]})
        self.assertEqual(repo.settings(), settings)

    def test_opt_in_same_id_conflict_retains_ours_and_all_exact_git_stages(self):
        original_attributes = b"# Existing team settings\n*.wpcb text eol=lf\n"
        repo = DesignRepo(self.scratch / "opt-in-conflict", self.env, original_attributes)
        settings = self.install(repo)
        ours = {**repo.base, "probe": repo.moved_probe([3_000_000, 4_200_000])}
        theirs = {**repo.routing_and_tail(), "probe": repo.moved_probe([4_000_000, 4_500_000])}
        left, right = repo.history(ours, theirs)
        result = repo.merge()
        self.assert_conflict_stages(repo, result, left, right, ours, theirs)
        self.assertIn(b"waffle-merge: conflict:", result.stderr)
        self.assertEqual(repo.board.read_bytes(), repo.board_bytes(ours))
        self.assertEqual(repo.settings(), settings)

    def test_opt_in_composes_a_move_and_rotation_of_one_part(self):
        repo = DesignRepo(self.scratch / "opt-in-placement", self.env)
        settings = self.install(repo)
        ours = {**repo.base, "probe": repo.moved_probe([3_000_000, 4_200_000])}
        theirs = {**repo.base, "probe": {**repo.base["probe"], "angle": 270_000_000_000}}
        left, right = repo.history(ours, theirs)
        expected = {**ours, "probe": {**ours["probe"], "angle": theirs["probe"]["angle"]}}
        self.assert_clean_merge(repo, repo.merge(), left, right, expected)
        self.assertEqual(repo.settings(), settings)


if __name__ == "__main__":
    unittest.main(verbosity=2)
