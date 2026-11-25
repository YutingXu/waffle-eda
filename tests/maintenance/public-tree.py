#!/usr/bin/env python3
"""Exercise the public-tree lint on a disposable Git index."""

import gzip
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
LINT = Path("scripts/check-public-tree.py")


def zip_data(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return output.getvalue()


def gzip_data(name, payload):
    output = io.BytesIO()
    with gzip.GzipFile(filename=name, mode="wb", fileobj=output, mtime=0) as archive:
        archive.write(payload)
    return output.getvalue()


class PublicTreeTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="waffle-privacy-test.")
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.write(LINT, (ROOT / LINT).read_bytes())
        self.component_doc = Path("docs/example.md")
        self.component = b"ZX2417"
        self.component_data = b"Published synthetic component " + self.component + b"\n"
        self.write(self.component_doc, self.component_data)
        self.policy = {
            "schema": 1,
            "legacy_fingerprints": [sha256(b"zx2417").hexdigest(), sha256(b"sampleboard.pcbdoc").hexdigest()],
            "versioned_fingerprints": [
                sha256(value).hexdigest() for value in (b"fieldunit42v17board", b"fieldunit42v17")
            ],
            "public_component_lines": {
                self.component_doc.as_posix(): [sha256(self.component_data.strip()).hexdigest()]
            },
            "public_path_examples": {},
            "public_fixture_digests": {},
            "oversized_zip_fixtures": {},
        }
        self.policy_path = Path(temp.name).resolve() / "policy.json"
        self.policy_bytes = json.dumps(self.policy).encode()
        self.policy_path.write_bytes(self.policy_bytes)
        self.policy_path.chmod(0o600)
        self.env = {name: value for name, value in os.environ.items()
                    if not name.startswith("WAFFLE_PRIVACY_POLICY_")}

    def write(self, path, payload):
        destination = self.repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              capture_output=True)

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", str(LINT), *args], cwd=self.repo,
                              capture_output=True, env=self.env)

    def restricted_args(self):
        return ("--require-policy", "--policy-file", str(self.policy_path),
                "--policy-sha256", sha256(self.policy_bytes).hexdigest())

    def lint(self):
        self.git("add", "-A")
        return self.cli(*self.restricted_args())

    def test_strict_policy_fails_closed(self):
        self.git("add", "-A")
        self.assertEqual(self.cli().returncode, 0)
        self.assertEqual(self.cli("--require-policy").returncode, 2)
        args = self.restricted_args()
        self.assertEqual(self.cli(*args[:-1], "0" * 64).returncode, 2)
        self.assertEqual(self.cli("--policy-file", str(self.policy_path)).returncode, 2)
        self.policy_path.chmod(0o644)
        self.assertEqual(self.cli(*args).returncode, 2)
        self.policy_path.chmod(0o600)
        self.assertEqual(self.cli(*args).returncode, 0)
        symlink = self.policy_path.with_name("policy-link")
        symlink.symlink_to(self.policy_path)
        self.assertEqual(self.cli(*args[:2], str(symlink), *args[3:]).returncode, 2)
        self.policy_path.write_bytes(b'{"schema":1}')
        args = (*args[:-1], sha256(self.policy_path.read_bytes()).hexdigest())
        self.assertEqual(self.cli(*args).returncode, 2)

    def test_portable_paths_and_published_component(self):
        self.write("fixtures/Sensor Board.waffle", b"Public board example\n")
        self.write("reports/bench.tsv",
                   b"$SCRATCH/results.tsv\n~/work/waffle\n"
                   b"https://example.org/home/report\n"
                   b"../home/report\n"
                   b"private-mixed-signal-benchmark\n")
        result = self.lint()
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_board_label_in_generated_files_and_filenames(self):
        label = self.component.lower()
        slug = label[:2] + b"-" + label[2:]
        self.write("output/generated.tsv", b"benchmark\t" + slug + b"\n")
        self.write("output/source.bin", b"\0SampleBoard.PcbDoc\0")
        self.write(Path("output") / (label.decode() + ".txt"), b"\n")
        self.write(self.component_doc,
                   self.component_data + b"\nPrivate benchmark: " + self.component + b"\n")
        result = self.lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"'output/generated.tsv':1:", result.stderr)
        self.assertIn(b"'output/source.bin':1:", result.stderr)
        self.assertNotIn(b"SampleBoard.PcbDoc", result.stderr)
        self.assertIn(b"'docs/example.md':", result.stderr)
        self.assertIn(b"<redacted tracked filename>", result.stderr)
        self.assertNotIn(label, result.stderr.lower())

    def test_versioned_identifiers_in_index_and_archive(self):
        scanner = runpy.run_path(str(ROOT / LINT))
        policy = scanner["parse_private_policy"](self.policy_bytes)
        sample = b"FIELD_UNIT42-.V17+BOARD"
        self.write("forms/raw.bin", b"\0" + sample + b"\0")
        self.write("forms/utf16.txt", "FIELD_UNIT42\u2013V17+BOARD".encode("utf-16-le"))
        self.write("forms/Field.Unit42.V17.Board.txt", b"ordinary data")
        archive = zip_data([
            ("notes/Field_Unit42+V17-Board.md", b"ordinary data"),
            ("notes/public.txt", b"FieldUnit42V17Board"),
        ])
        with io.BytesIO(archive) as updated:
            with zipfile.ZipFile(updated, "a") as archive_writer:
                archive_writer.comment = sample
            self.write("forms/export.zip", updated.getvalue())
        self.write("forms/nearby.txt",
                   b"FieldUnit42V18Board\nOtherFieldUnit42V17Board\n"
                   b"FieldUnit42\nV17Board\nFieldUnit42\n")
        self.git("add", "-A")
        findings = {finding for finding in scanner["scan_repository"](self.repo, policy)
                    if not finding[0].startswith("'forms/export.zip':")}
        reason = "private project or workspace reference"
        self.assertEqual(findings, {
            ("'forms/raw.bin':1", reason),
            ("'forms/utf16.txt':1", reason),
            ("'forms/export.zip' (ZIP comment):1", reason),
            ("'forms/export.zip' (ZIP member 1 filename):1", reason),
            ("'forms/export.zip' (ZIP member 2):1", reason),
            ("<redacted tracked filename>", "private reference in filename"),
        })
        self.assertIn((0, len(sample)), scanner["versioned_references"](sample, policy.versioned_fingerprints))

    def test_blob_findings_redact_paths_and_archive_values(self):
        scanner = runpy.run_path(str(ROOT / LINT))
        policy = scanner["parse_private_policy"](self.policy_bytes)
        identifier = b"fieldunit42-v17-board"
        private_path = b"output/" + identifier + b"/export.zip"
        archive = zip_data([(identifier.decode() + ".txt", identifier)])
        self.assertEqual(list(scanner["blob_findings"](archive, private_path, policy)),
                         [("<redacted tracked filename>", "private reference in filename")])
        findings = list(scanner["blob_findings"](archive, b"output/export.zip", policy))
        self.assertTrue(findings)
        self.assertIn(("'output/export.zip' (ZIP member 1 filename):1",
                       "private project or workspace reference"), findings)
        self.assertNotIn(identifier.decode(), repr(findings))

    def test_home_and_scratch_paths_and_index_contents(self):
        paths = (
            b"/".join((b"", b"Users", b"fixture-account", b"Projects", b"board")),
            b"file:///" + b"/".join((b"home", b"fixture-account", b"project")),
            b"Q:" + b"\\\\".join((b"", b"Users", b"Fixture Account", b"Project")),
            b"/".join((b"", b"private", b"var", b"folders", b"ab", b"fixture", b"T")),
            b"/".join((b"", b"tmp", b"fixture-scratch", b"results.tsv")),
        )
        self.write("reports/paths.md", b"\n".join(paths) + b"\n")
        self.git("add", "-A")
        self.write("reports/paths.md", b"only the staged snapshot is checked\n")
        result = self.cli()
        self.assertEqual(result.returncode, 1)
        for line, path in enumerate(paths, 1):
            with self.subTest(line=line):
                self.assertIn(f"'reports/paths.md':{line}:".encode(), result.stderr)
                self.assertNotIn(path, result.stderr)


    def test_private_references_in_utf16_text(self):
        project = self.component.decode()
        scratch = "/".join(("", "tmp", "fixture-scratch", "results.tsv"))
        negative = f"Benchmark\n{project}\n{scratch}\n"
        for encoding in ("utf-16", "utf-16-le", "utf-16-be"):
            self.write(Path("reports") / f"{encoding}.txt", negative.encode(encoding))
        result = self.lint()
        self.assertEqual(result.returncode, 1)
        for encoding in ("utf-16", "utf-16-le", "utf-16-be"):
            for line in (2, 3):
                with self.subTest(encoding=encoding, line=line):
                    self.assertIn(f"'reports/{encoding}.txt':{line}:".encode(), result.stderr)
        self.assertNotIn(self.component, result.stderr)
        self.assertNotIn(scratch.encode(), result.stderr)

    def test_private_references_in_archived_names_and_contents(self):
        label = self.component.lower()
        filename = label.decode() + ".txt"
        source_path = b"/".join((b"", b"home", b"fixture-account", b"board"))
        self.write("reports/export.epro", zip_data([
            ("reports/" + filename, b"public text"),
            ("reports/bench.tsv", source_path + b"\n"),
        ]))
        self.write("reports/export.gz", gzip_data("first.txt", b"public text") +
                   gzip_data(filename, b"Private benchmark: " + self.component))
        result = self.lint()
        self.assertEqual(result.returncode, 1)
        for expected in (
            b"'reports/export.epro' (ZIP member 1 filename):1:",
            b"'reports/export.epro' (ZIP member 2):1:",
            b"'reports/export.gz' (gzip member 2 filename):1:",
            b"'reports/export.gz' (gzip member 2):1:",
        ):
            self.assertIn(expected, result.stderr)
        self.assertNotIn(label, result.stderr.lower())
        self.assertNotIn(source_path, result.stderr)

    def test_portable_archives_and_utf16_component_example(self):
        public_text = b"$SCRATCH/results.tsv\nhttps://example.org/home/report\n"
        self.write(self.component_doc, self.component_data.decode().encode("utf-16"))
        self.write("fixtures/portable.zip", zip_data([("notes/home/example.txt", public_text)]))
        self.write("fixtures/portable.gz", gzip_data("bench.tsv", public_text))
        result = self.lint()
        self.assertEqual(result.returncode, 0, result.stderr.decode())


if __name__ == "__main__":
    unittest.main()
