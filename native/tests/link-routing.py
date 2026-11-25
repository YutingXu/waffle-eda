#!/usr/bin/env python3
"""Exercise package declarations and the same Linux/Git inputs the desktop routes use."""
import argparse
from configparser import ConfigParser
import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native"
PROJECT = "01952010-a000-7000-8000-000000000001"
OBJECT = "01952010-a000-7000-8000-000000000003"
URL = f"waffle://{PROJECT}/{OBJECT}"

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

linux = load("waffle_links_linux", NATIVE / "linux/waffle.py")
assert linux.project_path(URL) == URL
assert linux.valid_link(URL + "#datasheet:page=1")
assert linux.valid_link(URL + "#datasheet:page=9007199254740991")
for url in (URL+"?path=../../x", URL+"%2F", URL+"\n", URL+"#datasheet:page=0", URL+"#datasheet:page=9007199254740992"):
    assert not linux.valid_link(url), url
    try:
        linux.project_path(url)
    except argparse.ArgumentTypeError:
        pass
    else:
        raise AssertionError(url)

def peer(path, identity=PROJECT):
    return {"scope": lambda: (Path(path), identity, "adopted-grant")}

owners = {"unrelated": peer("/other", OBJECT), "first": peer("/folder/Project.waffle"),
          "satellite": peer("/folder/Project.waffle")}
assert linux.link_windows(owners, URL) == (["first", "satellite"], False)
assert linux.link_windows(owners, URL + "?path=/tmp") == ([], False)
assert linux.link_windows({**owners, "copied":peer("/copy/Project.waffle")}, URL) == ([], True)
assert linux.link_windows({"picker": {"scope": lambda: None}}, URL) == ([], False)

desktop = ConfigParser(interpolation=None)
desktop.read(NATIVE / "linux/desktop/org.waffle.editor.desktop")
assert desktop["Desktop Entry"]["Exec"] == "waffle %u"
assert "x-scheme-handler/waffle" in desktop["Desktop Entry"]["MimeType"].split(";")
with (NATIVE / "macos/Info.plist").open("rb") as file:
    assert any("waffle" in item["CFBundleURLSchemes"] for item in plistlib.load(file)["CFBundleURLTypes"])
namespace = "http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
package = ET.parse(NATIVE / "windows/packaging/AppxManifest.xml")
protocol = package.find(f".//{{{namespace}}}Protocol")
assert protocol.attrib == {"Name":"waffle","Parameters":'"%1"'}
portable = (NATIVE / "windows/packaging/Register-WaffleDocumentTypes.ps1").read_text()
assert "SetValue('URL Protocol', '')" in portable
assert "CreateSubKey('shell\\open\\command')" in portable

sys.path.insert(0, str(NATIVE))
import git_head
sys.path.insert(0, str(ROOT / "mcp"))
from butter_links import git_page

with tempfile.TemporaryDirectory(prefix="waffle-record-links-") as work:
    folder = Path(work)
    manifest = folder / "Link Board.waffle"
    shutil.copy2(ROOT / "tests/fixtures/butter-acceptance/links" / manifest.name, manifest)
    assert linux.project_path(manifest.as_uri()) == manifest
    subprocess.run(["git", "init", "-q", work], check=True)
    subprocess.run(["git", "-C", work, "add", manifest.name], check=True)
    subprocess.run(["git", "-C", work, "-c", "user.name=Link Fixture", "-c", "user.email=links@example.invalid",
                    "commit", "-q", "-m", "Review the rail", "-m", f"See [{URL}]. Disregard {URL}?path=/tmp."], check=True)
    first = git_head.query(manifest, "projectLog", {"limit":1})
    assert "recordLinks" not in first["commits"][0]
    authorized = git_head.query(manifest, "projectLog", {"limit":1,"recordLinks":True})
    assert authorized["commits"][0]["recordLinks"] == [URL], authorized
    assert "message" not in authorized["commits"][0]
    assert git_page(manifest, {}) == {"status":"ready","more":False,"snapshot":authorized["snapshot"],
        "commits":[{"revision":authorized["commits"][0]["revision"],"subject":"Review the rail","recordLinks":[URL]}]}
    assert git_page(manifest, {"gitSnapshot":"0"*64}) == {"status":"unavailable"}
print("PASS native protocol declarations, Linux adopted-window routing and scoped Git link pages")
