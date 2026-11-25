#!/usr/bin/env python3
"""Build the architecture-independent Waffle EDA Debian package."""
import argparse
import gzip
import hashlib
from io import BytesIO
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath
import tarfile
from asset_files import staged_output
from package_payload import relative_companions

ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / "app/VERSION").read_text(encoding="ascii").strip()
PACKAGE_NAME = "waffle-eda"
PACKAGE = f"{PACKAGE_NAME}_{VERSION}_all.deb"


def archive(files, links, epoch):
    """Entries are (path, bytes, mode); links use relative targets."""
    output = BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=epoch) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            def entry(path, mode):
                item = tarfile.TarInfo("./" + str(path))
                item.mode, item.mtime = mode, epoch
                item.uid, item.gid = 0, 0
                item.uname, item.gname = "root", "root"
                return item

            directories = {parent for path in [*files, *links] for parent in PurePosixPath(path).parents if str(parent) != "."}
            for name in sorted(directories):
                item = entry(name, 0o755)
                item.type = tarfile.DIRTYPE
                tar.addfile(item)
            for name, (content, mode) in sorted(files.items()):
                item = entry(name, mode)
                item.size = len(content)
                tar.addfile(item, BytesIO(content))
            for name, target in sorted(links.items()):
                item = entry(name, 0o777)
                item.type, item.linkname = tarfile.SYMTYPE, target
                tar.addfile(item)
    return output.getvalue()


def ar_member(name, content, epoch):
    # Debian uses the common ar format, whose physical member headers are 60 bytes.
    header = f"{name:<16}{epoch:<12}{0:<6}{0:<6}{'100644':<8}{len(content):<10}`\n"
    assert len(header) == 60
    return header.encode("ascii") + content + (b"\n" if len(content) % 2 else b"")


def install_shared(root, install, base):
    """Install the shared companions, then the Linux host files."""
    linux_only = (
        "native/bridge.js", "native/external_tools.py", "native/linux/waffle.py",
        "native/linux/folder_project.py", "native/linux/notebook_media.py",
        "native/linux/lan_relay.py", "collab/relay/waffle_relay.py",
    )
    for name in (*relative_companions(root), *linux_only):
        install(name, base + name, executable=name in ("native/linux/waffle.py", "mcp/server.py"))


def build(output, epoch):
    subprocess.run([sys.executable, "-B", str(ROOT / "scripts/prepare-assets.py")], check=True)
    files = {}
    links = {}
    base = "usr/share/waffle/"

    def install(source, destination, executable=False):
        content = (ROOT / source).read_bytes()
        if executable and content.startswith(b"#!/usr/bin/env python3\n"):
            content = content.replace(b"#!/usr/bin/env python3\n", b"#!/usr/bin/python3\n", 1)
        files[destination] = (content, 0o755 if executable else 0o644)

    for source in sorted((ROOT / "app").rglob("*")):
        relative = source.relative_to(ROOT)
        if source.is_file() and not any(s.startswith(".") or s == "__pycache__" for s in relative.parts):
            install(relative, base + relative.as_posix())
    install_shared(ROOT, install, base)
    links["usr/bin/waffle"] = "../share/waffle/native/linux/waffle.py"
    links["usr/bin/waffle-mcp"] = "../share/waffle/mcp/server.py"

    desktop = "native/linux/desktop/org.waffle.editor"
    install(desktop + ".desktop", "usr/share/applications/org.waffle.editor.desktop")
    icon_theme = ROOT / "brand/linux/hicolor"
    for icon in sorted(icon_theme.glob("*/apps/waffle*")):
        theme_path = icon.relative_to(icon_theme)
        name = "org.waffle.editor" + theme_path.name.removeprefix("waffle")
        install(icon.relative_to(ROOT), "usr/share/icons/hicolor/" + theme_path.with_name(name).as_posix())
    install(desktop + ".xml", "usr/share/mime/packages/org.waffle.editor.xml")
    docs = f"usr/share/doc/{PACKAGE_NAME}/"
    install("mcp/README.md", docs + "MCP.md")
    install("README.md", docs + "README.md")
    install("LICENSE", docs + "copyright")
    install("THIRD_PARTY_NOTICES.md", docs + "THIRD_PARTY_NOTICES.md")

    manifest = "".join(hashlib.md5(content).hexdigest() + "  " + name + "\n"
                       for name, (content, _) in sorted(files.items()))
    installed_kib = sum((len(content) + 1023) // 1024 for content, _ in files.values()) + len(links)
    # The 0.5.0 Waffle preview used the same launcher, desktop entry and resources.
    control = f"""Package: {PACKAGE_NAME}
Source: {PACKAGE_NAME}
Version: {VERSION}
Section: electronics
Priority: optional
Architecture: all
Maintainer: Waffle EDA maintainers <waffle@localhost>
Installed-Size: {installed_kib}
Depends: python3 (>= 3.9), python3-gi, gir1.2-gtk-3.0, python3-gi-cairo, gir1.2-poppler-0.18, heif-gdk-pixbuf, libheif-plugin-libde265 | libheif1 (<< 1.16), webp-pixbuf-loader, gir1.2-webkit2-4.1 (>= 2.42) | gir1.2-webkit2-4.0 (>= 2.42), shared-mime-info, desktop-file-utils, hicolor-icon-theme
Recommends: git, libsecret-tools
Conflicts: waffle (= 0.5.0)
Replaces: waffle (= 0.5.0)
Description: Waffle EDA schematic and PCB editor
 Edit designs offline, import Altium documents and libraries, and inspect
 saved designs using the bundled Model Context Protocol server.
"""
    metadata = {"control": (control.encode(), 0o644), "md5sums": (manifest.encode(), 0o644)}
    output.parent.mkdir(parents=True, exist_ok=True)
    with staged_output(output) as stage:
        with stage.open("wb") as out:
            out.write(b"!<arch>\n")
            out.write(ar_member("debian-binary", b"2.0\n", epoch))
            out.write(ar_member("control.tar.gz", archive(metadata, {}, epoch), epoch))
            out.write(ar_member("data.tar.gz", archive(files, links, epoch), epoch))
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / PACKAGE)
    parser.add_argument("--filename", action="store_true", help="Print the default package filename.")
    args = parser.parse_args()
    if args.filename:
        print(PACKAGE)
    else:
        build(args.output, int(os.environ.get("SOURCE_DATE_EPOCH", "0")))
