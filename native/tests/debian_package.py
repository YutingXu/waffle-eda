#!/usr/bin/env python3
"""Inspect and extract the packaged editor and exercise both user-facing commands."""
import argparse
import configparser
from contextlib import nullcontext
from email.parser import Parser
import hashlib
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "app/VERSION").read_text(encoding="ascii").strip()


def output(*args, **kwargs):
    return subprocess.check_output(args, **kwargs)


def verify(package, stage=None):
    # --stage is private. The caller owns that empty directory and reads this one extraction.
    held = None
    if stage is not None:
        held = Path(stage).resolve()
        if not held.is_dir() or any(held.iterdir()):
            raise ValueError("Debian stage must be an empty directory")
    assert output("ar", "-p", package, "debian-binary") == b"2.0\n"
    assert output("ar", "-t", package).decode().splitlines() == ["debian-binary", "control.tar.gz", "data.tar.gz"]
    with tarfile.open(fileobj=BytesIO(output("ar", "-p", package, "control.tar.gz")), mode="r:gz") as tar:
        fields = Parser().parsestr(tar.extractfile("./control").read().decode())
        assert fields["Package"] == fields["Source"] == "waffle-eda"
        assert fields["Architecture"] == "all" and fields["Version"] == VERSION
        version = fields["Version"]
        assert fields["Description"].splitlines()[0] == "Waffle EDA schematic and PCB editor"
        assert fields["Conflicts"] == fields["Replaces"] == "waffle (= 0.5.0)"
        assert fields["Provides"] is None
        assert all(dep in fields["Depends"] for dep in ("python3-gi", "gir1.2-webkit2-4.1", "gir1.2-gtk-3.0", "gir1.2-poppler-0.18",
                                                        "python3-gi-cairo", "heif-gdk-pixbuf", "libheif-plugin-libde265", "webp-pixbuf-loader"))
        # The editor's CSS needs WebKitGTK 2.42+ (color-mix(), :has()); 4.1 is preferred.
        assert "gir1.2-webkit2-4.1 (>= 2.42) | gir1.2-webkit2-4.0 (>= 2.42)" in fields["Depends"], fields["Depends"]
        checksums = dict(line.split("  ", 1)[::-1] for line in tar.extractfile("./md5sums").read().decode().splitlines())
    with (tempfile.TemporaryDirectory() if held is None else nullcontext(held)) as directory:
        root = Path(directory).resolve()
        with tarfile.open(fileobj=BytesIO(output("ar", "-p", package, "data.tar.gz")), mode="r:gz") as tar:
            for entry in tar:
                path = PurePosixPath(entry.name)
                assert not path.is_absolute() and ".." not in path.parts and path.parts[0] == "usr"
                assert entry.uid == entry.gid == 0
                assert entry.mode == (0o755 if entry.isdir() or path.name in ("waffle.py","server.py") else 0o777 if entry.issym() else 0o644)
                target = root.joinpath(*path.parts)
                if entry.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif entry.isreg():
                    contents = tar.extractfile(entry).read()
                    assert hashlib.md5(contents).hexdigest() == checksums.pop(str(path))
                    target.write_bytes(contents)
                    target.chmod(entry.mode)
                else:
                    assert entry.issym() and path.parent == PurePosixPath("usr/bin")
                    assert (target.parent / entry.linkname).resolve().is_relative_to(root)
                    target.symlink_to(entry.linkname)
            assert not checksums
        share = root / "usr/share"
        desktop = configparser.ConfigParser(interpolation=None)
        desktop.read(share / "applications/org.waffle.editor.desktop")
        entry = desktop["Desktop Entry"]
        assert entry["Name"] == "Waffle EDA" and entry["Icon"] == "org.waffle.editor"
        expected_mime = {"application/x-waffle-" + name: "*." + extension
                         for name, extension in (("project", "waffle"), ("board", "wpcb"), ("schematic", "wsch"),
                                                 ("library", "wlib"), ("drawing", "wdraw"), ("panel", "wpanel"))}
        assert entry["Exec"] == "waffle %u"
        assert set(entry["MimeType"].strip(";").split(";")) == expected_mime.keys() | {"x-scheme-handler/waffle"}
        assert (share / "doc/waffle-eda/copyright").is_file()
        mime = ET.parse(share/"mime/packages/org.waffle.editor.xml").getroot()
        assert {row.attrib["type"]: [e.get("pattern") for e in row if e.get("pattern")] for row in mime} == {
            name: [pattern] for name, pattern in expected_mime.items()}
        ET.parse(share / ("icons/hicolor/scalable/apps/" + entry["Icon"] + ".svg"))
        launcher = root / "usr/bin/waffle"
        server = root / "usr/bin/waffle-mcp"
        assert output(launcher, "--version", text=True).strip() == f"Waffle EDA {version}"
        assert "project" in output(launcher, "--help", text=True)
        # Exercise the same file decoding and read-only authority used at GTK startup.
        module = importlib.util.spec_from_file_location("packaged_launcher", launcher.resolve())
        app = importlib.util.module_from_spec(module)
        module.loader.exec_module(app)
        sample = root / "Analog front end.waffle"
        sample.write_text('{"kind":"project","formatVersion":"2.0","id":"package","name":"Package check"}\n')
        app.check_open_selection([app.project_path(str(sample))])
        old = root / "old"
        old.mkdir()
        for ext in ("waffle","atrium"):
            held = old / ("Legacy." + ext)
            held.write_bytes(b'{"format":"atrium","version":1,"documents":[],"library":[]}')
            before = held.read_bytes()
            proc = subprocess.run([launcher,"--browser",str(held)],capture_output=True,text=True)
            assert proc.returncode == 1 and proc.stderr.strip() == app.PRE_RELEASE_MESSAGE and not proc.stdout
            assert held.read_bytes() == before and not (old / ".waffle").exists()
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(root)}):
            assert app.data_dir() == root / "waffle"
        bad = subprocess.run([launcher, str(root / "missing.waffle")], capture_output=True)
        assert bad.returncode == 2 and b"does not exist" in bad.stderr
        request = {"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
        handshake = json.loads(output(server, "--project", sample, input=(json.dumps(request)+"\n").encode()))
        assert handshake["result"]["serverInfo"] == {"name": "waffle-eda", "title": "Waffle EDA", "version": version}
        # The shipped command loads its engine from the same SI package as the editor.
        si_package = share / "waffle/app/extensions/packages/waffle.si.js"
        assert si_package.is_file() and not (share / "waffle/extensions/si").exists()
        source = ROOT / "mcp/examples/sensor-interface"
        fixture = root / "Packaged SI test"
        shutil.copytree(source, fixture)
        before = {p: p.read_bytes() for p in fixture.rglob("*") if p.is_file()}
        simulate = {"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"si_simulate",
                    "arguments":{"net":"VIN","corners":["typ"],"crosstalk":False}}}
        messages = "".join(json.dumps(row) + "\n" for row in (request, simulate))
        replies = [json.loads(line) for line in output(server, "--project", fixture / "Board.waffle",
                   "--read-only", input=messages, text=True, cwd=root).splitlines()]
        outcome = replies[1]["result"]
        assert not outcome["isError"], outcome
        report = outcome.get("structuredContent") or json.loads(outcome["content"][0]["text"])
        assert report["net"] == "VIN" and report["metrics"], report
        assert {p: p.read_bytes() for p in fixture.rglob("*") if p.is_file()} == before
        if shutil.which("dpkg-deb"):
            assert output("dpkg-deb", "-f", package, "Architecture").strip() == b"all"
            subprocess.run(["dpkg-deb","-x",package,root/"dpkg-extracted"], check=True)
        print(f"Validated {package.name}: control, checksums, modes, MIME, desktop entry, project handoff, CLI, MCP handshake and SI simulation.")


def verify_upgrade(package):
    """Exercise apt's plan and dpkg's file ownership rules in disposable roots on Linux."""
    package = package.resolve()
    installed = Path("/var/lib/dpkg/status").read_text()
    # Reuse the installed dependencies in the container. Resolve only against that status and
    # this local archive, with system sources and caches disabled.
    stanzas = [s for s in installed.split("\n\n") if s.strip() and
               Parser().parsestr(s)["Package"] not in ("waffle", "waffle-eda")]
    env = {**os.environ, "LC_ALL": "C"}

    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        for old_version in ("0.5.0", "99.0"):
            fixture = base / ("fixture-" + old_version)
            control = fixture / "DEBIAN/control"
            control.parent.mkdir(parents=True)
            control.write_text(f"""Package: waffle
Version: {old_version}
Architecture: all
Maintainer: Package Test <test@example.invalid>
Description: Fixture sharing the Waffle launcher path
""")
            binary = fixture / "usr/bin/waffle"
            binary.parent.mkdir(parents=True)
            binary.write_text("Old launcher fixture\n")
            old_deb = base / ("waffle_" + old_version + "_all.deb")
            output("dpkg-deb", "--root-owner-group", "--build", fixture, old_deb, env=env)

            root = base / ("root-" + old_version)
            status = root / "var/lib/dpkg/status"
            status.parent.mkdir(parents=True)
            status.touch()
            dpkg = ["dpkg", f"--root={root}", "--force-not-root", "--force-depends", "--no-triggers", "--install"]
            output(*dpkg, old_deb, env=env)
            apt_status = base / ("apt-" + old_version)
            apt_status.write_text("\n\n".join([*stanzas, status.read_text().strip()]) + "\n")
            plan = output("apt-get", "--simulate", "--no-install-recommends", "-o", f"Dir::State::status={apt_status}",
                          "-o", "Dir::Etc::sourcelist=/dev/null", "-o", "Dir::Etc::sourceparts=-",
                          "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache=",
                          "install", package, text=True, env=env)
            assert "Inst waffle-eda " in plan, plan
            upgrade = old_version == "0.5.0"
            assert ("Remv waffle " in plan) == upgrade, plan

            result = subprocess.run([*dpkg, package], text=True, capture_output=True, env=env)
            if upgrade:
                assert result.returncode == 0, result.stderr
                assert (root / "usr/bin/waffle").is_symlink() and (root / "usr/bin/waffle-mcp").is_symlink()
                assert "Package: waffle-eda\nStatus: install ok installed" in status.read_text()
            else:
                assert result.returncode != 0 and "trying to overwrite" in result.stderr, result.stderr
                assert (root / "usr/bin/waffle").read_bytes() == binary.read_bytes()
        print("Verified offline apt replacement of the Waffle 0.5.0 preview and refusal to overwrite an unrelated package.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--stage", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--upgrade", action="store_true", help="Exercise package rename and ownership on Debian/Ubuntu.")
    args = parser.parse_args()
    if args.upgrade:
        verify_upgrade(args.package)
    else:
        verify(args.package, args.stage)
