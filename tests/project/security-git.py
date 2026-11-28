#!/usr/bin/env python3
"""Defensive Git integration checks using isolated local repositories.

Run with python3 -I -B tests/project/security-git.py. External transports use a test double.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "native" / "git_head.py"
MANIFEST = "Board.waffle"
LEGACY = '{"format":"atrium","version":1,"library":[],"documents":[]}'


def write_project(root, *, revision=0, note=""):
    header = {"kind":"project", "formatVersion":"2.0", "id":"fixture", "name":"Git review fixture"}
    binding = {"kind":"document", "id":"power", "docKind":"schematic", "name":"Power", "path":"Power.wsch"}
    setting = {"kind":"projectSetting", "id":"fixture/settings", "key":"projectExtensions",
               "value":{"org.example.fixture":{"note":note, "revision":revision}}}
    lines = [json.dumps(record, separators=(",", ":")) for record in (header, setting, binding)]
    (root / MANIFEST).write_text("\n".join(lines) + "\n", encoding="utf-8")
    (root / "Power.wsch").write_text('{"kind":"schematic","formatVersion":"2.0","id":"power","requires":[]}\n',
                                     encoding="utf-8")


def load_git_head():
    spec = importlib.util.spec_from_file_location("git_head_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GH = load_git_head()


def git(cwd, *args, check=True):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return subprocess.run(["git", "-c", "init.defaultBranch=main", *args], cwd=cwd, env=env, check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def run_cli(project, op, args=None):
    """As the macOS and Windows hosts do: python3 -I -B git_head.py --project P --query OP --args=JSON."""
    return subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), "--project", str(project), "--query", op,
                           "--args=" + json.dumps(args or {})], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)


class Scratch(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="waffle-secgit-")
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()

    def repo(self, name="repo", commits=1):
        root = self.tmp / name
        root.mkdir(parents=True)
        git(root, "init", "-q", "--template=")
        write_project(root)
        git(root, "add", MANIFEST, "Power.wsch")
        git(root, "commit", "-qm", "init")
        for n in range(1, commits):
            write_project(root, revision=n)
            git(root, "commit", "-qam", "c%d" % n)
        return root


# --------------------------------------------------------------------------- F1: LFS path (fixed)
class LfsQueriesRunNoRepositoryCode(Scratch):
    """F1 (fixed): lfs* queries go through the safe Git runner, run git-lfs by absolute path, keep
    repository config from running commands, and refuse server operations when it would."""

    def test_ok_lfs_status_overrides_fsmonitor(self):
        root = self.repo()
        git(root, "config", "core.fsmonitor", "true")
        original = (root / ".git" / "config").read_bytes()
        commands = []
        git_runner = GH._run_git

        def observe(argv, *args, **kwargs):
            commands.append(argv)
            return git_runner(argv, *args, **kwargs)

        with mock_attr(GH, "_run_git", observe):
            self.assertTrue(GH.query(root / MANIFEST, "lfsStatus")["git"])
        self.assertTrue(commands)
        self.assertTrue(all("core.fsmonitor=false" in argv for argv in commands))
        self.assertEqual((root / ".git" / "config").read_bytes(), original)

    def test_ok_lfs_status_never_resolves_alias_lfs(self):
        root = self.repo()
        git(root, "config", "alias.lfs", "status")
        out = run_cli(root / MANIFEST, "lfsStatus")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(json.loads(out.stdout)["git"])
        if not shutil.which("git-lfs"):
            self.assertFalse(json.loads(out.stdout)["lfs"])

    def test_ok_bare_repository_is_not_a_project_worktree(self):
        root = self.tmp / "metadata-only"
        root.mkdir()
        git(root, "init", "--bare", "-q", "--template=")
        write_project(root)
        self.assertNotEqual(run_cli(root / MANIFEST, "status").returncode, 0)
        self.assertIn("safe.bareRepository=explicit", GH.SAFE_CONFIG)

    def test_ok_lfs_network_ops_keep_the_safety_settings(self):
        """lfsLocks/lfsLock/lfsUnlock: git-lfs by absolute path, GIT_CONFIG_NOSYSTEM kept, safe settings
        for the Git commands git-lfs starts, and a refusal when repository config would run commands."""
        r = self.repo()
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "git-lfs"
        fake.write_text("#!/bin/sh\necho '[]'\n")
        fake.chmod(0o755)
        seen = []
        real = GH.subprocess.run

        def spy(argv, *a, **k):
            seen.append((list(argv), dict(k.get("env") or {})))
            return real(argv, *a, **k)
        old_path = os.environ.get("PATH", "")
        os.environ["PATH"] = str(bin_dir) + os.pathsep + old_path
        try:
            with mock_attr(GH.subprocess, "run", spy):
                GH.query(r / MANIFEST, "lfsLocks", {"confirm": True})
            lfs_calls = [(argv, env) for argv, env in seen if "locks" in argv]
            self.assertTrue(lfs_calls)
            for argv, env in lfs_calls:
                self.assertTrue(os.path.isabs(argv[0]) and os.path.basename(argv[0]) == "git-lfs", argv)
                self.assertEqual(env.get("GIT_CONFIG_NOSYSTEM"), "1")
                self.assertEqual(env.get("GIT_TERMINAL_PROMPT"), "0")
                for setting in ("core.fsmonitor=false", "core.hooksPath=" + os.devnull, "safe.bareRepository=explicit"):
                    self.assertIn(setting, env.get("GIT_CONFIG_PARAMETERS", ""))
            # Every Git process (not git-lfs) went through the safe runner.
            for argv, _ in seen:
                if argv and argv[0] == "git":
                    self.assertIn("core.fsmonitor=false", argv)
                    self.assertIn("safe.bareRepository=explicit", argv)
            for key, value in (("core.sshCommand", "ssh"), ("credential.helper", "cache"),
                               ("lfs.customtransfer.fixture.path", "fixture-transport"),
                               ("remote.origin.uploadpack", "git-upload-pack")):
                git(r, "config", key, value)
                before = len([argv for argv, _ in seen if os.path.basename(argv[0]) == "git-lfs"])
                with mock_attr(GH.subprocess, "run", spy), self.assertRaises(GH.BaselineError):
                    GH.query(r / MANIFEST, "lfsLock", {"confirm": True})
                self.assertEqual(len([argv for argv, _ in seen if os.path.basename(argv[0]) == "git-lfs"]), before)
                git(r, "config", "--unset", key)
        finally:
            os.environ["PATH"] = old_path

    def test_ok_bridge_and_hosts_agree_on_lfs_ops(self):
        def quoted(text):
            return set(re.findall(r'"(\w+)"', text))

        bridge = (ROOT / "native" / "bridge.js").read_text()
        generic = quoted(re.search(r"GIT_QUERIES\s*=\s*new Set\(\[(.*?)\]\)", bridge, re.S).group(1))
        source = quoted(re.search(r"sourceOps\s*=\s*new Set\(\[(.*?)\]\)", bridge, re.S).group(1))
        swift = (ROOT / "native" / "macos" / "main.swift").read_text()
        swift_ops = set(re.findall(r'"(\w+)":\s*\[', re.search(r"gitQueryKeys:.*?=\s*\[(.*?)\]\]", swift, re.S).group(1)))
        swift_source = quoted(re.search(r"sourceQueries:.*?=\s*\[([^\]]*)\]", swift, re.S).group(1))
        cs = (ROOT / "native" / "windows" / "src" / "Core" / "Policy.cs").read_text()
        cs_ops = set(re.findall(r'\{\s*"(\w+)",\s*new', cs.split("class GitQuery", 1)[1].split("static bool Text", 1)[0]))
        cs_source = quoted(re.search(r"HistoryQueries\s*=\s*Set\(([^)]*)\)", cs).group(1))
        self.assertEqual(source, {"projectLog", "projectBlobs", "sourceRevision", "sourceLog"})
        self.assertEqual(source - generic, {"sourceRevision", "sourceLog"})
        combined = generic | source
        for host, queries in (("Python helper", GH.QUERY_OPS), ("macOS", swift_ops), ("Windows", cs_ops)):
            self.assertEqual(combined, queries, host)
        for host, queries in (("Python helper", GH.SOURCE_QUERIES), ("macOS", swift_source), ("Windows", cs_source)):
            self.assertEqual(source, queries, host)
        self.assertIn('Self.sourceQueries.contains(op ?? "") && token == gitSource?.token', swift)
        windows_host = (ROOT / "native" / "windows" / "src" / "Core" / "Host.cs").read_text()
        self.assertIn("Policy.HistoryQueries.Contains(op) && token == gitSource?.Key", windows_host)
        # GTK shares the helper validator and checks its source subset against the open-file token.
        gtk = (ROOT / "native" / "linux" / "waffle.py").read_text()
        self.assertRegex(gtk, r"from git_head import [^\n]*\bvalidate_query\b[^\n]*\bSOURCE_QUERIES\b")
        self.assertIn("git_source and token == git_source[0] and op in SOURCE_QUERIES", gtk)
        self.assertTrue({"lfsStatus", "lfsLocks", "lfsLock", "lfsUnlock"} <= generic)
        self.assertIn('gitQuery(op, op === "lfsStatus"', (ROOT / "app/project/collab-presence.js").read_text())


class ReadOnlyQueries(Scratch):
    def test_ok_every_read_keeps_repository_data_and_uses_the_safe_policy(self):
        root = self.repo(commits=3)
        git(root, "config", "core.fsmonitor", "true")
        git(root, "config", "core.untrackedCache", "true")
        (root / ".gitattributes").write_text("*.waffle text eol=lf\n", encoding="utf-8")
        before = {name: (root / name).read_bytes() for name in (".git/config", ".git/index", ".gitattributes", MANIFEST)}
        commands = []
        git_runner = GH._run_git

        def observe(argv, *args, **kwargs):
            commands.append(argv)
            return git_runner(argv, *args, **kwargs)

        with mock_attr(GH, "_run_git", observe):
            head = GH.query(root / MANIFEST, "refs")["head"]
            log = GH.query(root / MANIFEST, "blameLog")["commits"]
            for op, args in [("status", {}), ("log", {"search": "c1"}), ("log", {"search": head[:7]}), ("fileLog", {}),
                             ("read", {"revision": head}), ("read", {"revision": "index"}), ("read", {"revision": "worktree"}),
                             ("mergeBase", {"a": head, "b": log[-1]["revision"]}), ("projectBlobs", {"revisions": [head]}),
                             ("patches", {"head": head, "revisions": [c["revision"] for c in log]})]:
                with self.subTest(op=op):
                    self.assertIsInstance(GH.query(root / MANIFEST, op, args), dict)
        self.assertTrue(commands)
        for command in commands:
            self.assertIn("core.fsmonitor=false", command)
            self.assertIn("core.hooksPath=" + os.devnull, command)
        self.assertEqual({name: (root / name).read_bytes() for name in before}, before)

    def test_ok_revision_and_search_input_boundaries(self):
        root = self.repo()
        tree = git(root, "write-tree").stdout.decode().strip()
        dangling = git(root, "commit-tree", "-m", "unreferenced draft", tree).stdout.decode().strip()
        for op, args in [("read", {"revision": dangling}), ("mergeBase", {"a": dangling, "b": dangling}),
                         ("log", {"refs": [dangling]}), ("read", {"revision": "HEAD"}),
                         ("log", {"search": "a\nb"}), ("log", {"limit": -1})]:
            with self.subTest(op=op, args=args), self.assertRaises(GH.BaselineError):
                GH.query(root / MANIFEST, op, args)
        self.assertEqual(GH.query(root / MANIFEST, "log", {"search": "-notes"})["commits"], [])

    def test_ok_retired_project_is_an_explicit_negative(self):
        root = self.repo()
        old = root / "old.atrium"
        old.write_text(LEGACY, encoding="utf-8")
        result = run_cli(old, "status")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Waffle", result.stderr)


class MergeDriverInstallScope(Scratch):
    def test_ok_merge_setup_rejects_separate_git_storage(self):
        root = self.tmp / "worktree"
        root.mkdir()
        storage = self.tmp / "separate-storage"
        git(root, "init", "-q", "--template=", "--separate-git-dir", str(storage))
        write_project(root)
        previous = (storage / "config").read_bytes()
        with self.assertRaisesRegex(GH.BaselineError, "Git directory"):
            GH.query(root / MANIFEST, "mergeDriverPlan")
        self.assertEqual((storage / "config").read_bytes(), previous)
        self.assertFalse((root / ".gitattributes").exists())

    def test_ok_merge_setup_rejects_inconsistent_top_level(self):
        root = self.repo()
        folder = self.tmp / "different-worktree"
        folder.mkdir()
        previous = (root / ".git" / "config").read_bytes()
        git_dir = root / ".git"

        class Metadata:
            def __init__(self, origin, top, common):
                self.origin, self.root, self.common = origin, top, common

            def git(self, args, *unused, **options):
                return os.fsencode(self.common) + b"\n"

        with mock_attr(GH, "_repository", lambda *args: Metadata(root, folder, git_dir)), self.assertRaisesRegex(GH.BaselineError, "Git directory"):
            GH.merge_driver_plan(root / MANIFEST)
        self.assertEqual((git_dir / "config").read_bytes(), previous)
        self.assertFalse((folder / ".gitattributes").exists())


class PatchReadBudget(Scratch):
    def test_ok_patch_and_blob_limits_are_enforced(self):
        root = self.repo()
        for n, character in enumerate("abc"):
            write_project(root, revision=n, note=character * 4096)
            git(root, "commit", "-qam", "Edit a design note")
        log = GH.query(root / MANIFEST, "blameLog")
        args = {"head": log["head"], "revisions": [row["revision"] for row in log["commits"] if row["oldBlob"]]}
        with mock_attr(GH, "PATCH_OUTPUT", 4096), self.assertRaisesRegex(GH.BaselineError, "exceeds"):
            GH.query(root / MANIFEST, "patches", args)
        with mock_attr(GH, "MAX_BYTES", 4096), self.assertRaisesRegex(GH.BaselineError, "64 MiB"):
            GH.query(root / MANIFEST, "patches", {**args, "revisions": args["revisions"][:1]})


# --------------------------------------------------------------------------- Windows merge driver runtime
class WindowsMergeDriverRuntime(unittest.TestCase):
    def test_ok_node_is_resolved_only_in_absolute_path_entries(self):
        spec = importlib.util.spec_from_file_location("board_runner_under_test", ROOT / "mcp" / "board_runner.py")
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            work, installed = root / "project", root / "runtime"
            work.mkdir()
            node = installed / "node.exe"
            searches = []

            def resolve(name, *, path):
                searches.append((name, path, os.environ.get("NoDefaultCurrentDirectoryInExePath")))
                return str(node) if path == str(installed) else None

            entries = os.pathsep.join(["", ".", "tools", str(installed)])
            with chdir(work), mock_env(PATH=entries, NoDefaultCurrentDirectoryInExePath="prior"), mock_attr(runner.shutil, "which", resolve):
                engine = runner.BoardRunner(backend="node")
                try:
                    self.assertEqual(searches, [("node", str(installed), "1")])
                    self.assertEqual(engine.node, str(node))
                    self.assertEqual(os.environ["NoDefaultCurrentDirectoryInExePath"], "prior")
                finally:
                    engine.close()
        self.assertTrue(GH.driver_command().endswith("--merge-driver %O %A %B -- %P"))


# --------------------------------------------------------------------------- host validators
class HostValidatorsAgree(unittest.TestCase):
    def test_ok_source_only_reads_require_an_original_source(self):
        # The helper also enforces the original-source role after native token validation.
        with tempfile.TemporaryDirectory() as folder:
            write_project(Path(folder))
            native = Path(folder) / MANIFEST
            for op, args in [("sourceLog", {"limit": 2}), ("sourceRevision", {"revision": "1" * 40})]:
                with self.subTest(op=op), self.assertRaisesRegex(GH.BaselineError, "Choose an Altium or KiCad source"):
                    GH.query(native, op, args)

    def test_ok_key_tables_match(self):
        swift = (ROOT / "native" / "macos" / "main.swift").read_text()
        cs = (ROOT / "native" / "windows" / "src" / "Core" / "Policy.cs").read_text()
        for op, keys in GH.QUERY_KEYS.items():
            m = re.search(r'"%s":\s*\[([^\]]*)\]' % op, swift)
            self.assertIsNotNone(m, op)
            self.assertEqual(set(re.findall(r'"(\w+)"', m.group(1))), keys, "swift " + op)
            m = re.search(r'\{\s*"%s",\s*new(?: string\[0\]|\[\]\s*\{([^}]*)\})' % op, cs)
            self.assertIsNotNone(m, op)
            self.assertEqual(set(re.findall(r'"(\w+)"', m.group(1) or "")), keys, "c# " + op)

    def test_ok_string_length_units_agree(self):
        """F10 fixed: Swift, C# and git_head.py all count Unicode code points (scalars)."""
        swift = (ROOT / "native" / "macos" / "main.swift").read_text()
        self.assertIn("s.unicodeScalars.count <= 256", swift)
        emoji = "\U0001F600" * 200
        self.assertEqual(GH.validate_query("log", {"search": emoji})["search"], emoji)  # 200 code points <= 256


# --------------------------------------------------------------------------- helpers
@contextlib.contextmanager
def mock_attr(obj, name, value):
    old = getattr(obj, name)
    setattr(obj, name, value)
    try:
        yield
    finally:
        setattr(obj, name, old)


@contextlib.contextmanager
def mock_env(**values):
    old = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextlib.contextmanager
def chdir(path):
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


if __name__ == "__main__":
    unittest.main(verbosity=2)
