#!/usr/bin/env python3
"""Build and verify all local preview downloads from one committed source tree."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from package_payload import companion_paths


def require(test, message):
    if not test:
        raise ValueError(message)


def run(*args, cwd=ROOT, env=None, capture=False):
    result = subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=capture)
    return result.stdout if capture else None


def script(source, path, *args, capture=False):
    return run(sys.executable, "-B", path, *args, cwd=source, capture=capture)


def archive_source(source, revision):
    with subprocess.Popen(["git", "archive", revision], cwd=ROOT, stdout=subprocess.PIPE) as git:
        # Stream the commit into the staging tree without writing into the source checkout.
        result = subprocess.run(["tar", "-xf", "-", "-C", source], stdin=git.stdout,
                                env={**os.environ, "COPYFILE_DISABLE": "1"})
        git.stdout.close()
        require(git.wait() == 0 and result.returncode == 0, "Could not export the committed preview source")


def digest(path):
    with path.open("rb") as stream:
        sha = hashlib.sha256()
        for block in iter(lambda: stream.read(1 << 20), b""):
            sha.update(block)
        return sha.hexdigest()


def payload(source):
    files = sorted(p for p in (source / "app").rglob("*") if p.is_file())
    files += companion_paths(source)
    paths = [p.relative_to(source).as_posix() for p in files]
    paths += ["bridge.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]
    return {name: (source / ("native/bridge.js" if name == "bridge.js" else name)).read_bytes() for name in paths}


def verify_payload(read, members, expected, label, debian=False):
    # Require every declared path exactly once, including the hoisted bridge.
    # Reject stale files in managed trees while allowing other package metadata.
    managed = ("app/", "mcp/", "native/")
    wanted = set(expected)
    names = [name for name in members if name in wanted or name.startswith(managed)]
    require(len(names) == len(set(names)), f"{label}: duplicate runtime file")
    found = set(names)
    require(found == wanted, f"{label}: missing {sorted(wanted - found)}, unexpected {sorted(found - wanted)}")
    for name, data in expected.items():
        if debian and name in ("mcp/server.py", "native/linux/waffle.py"):
            data = data.replace(b"#!/usr/bin/env python3\n", b"#!/usr/bin/python3\n", 1)
        require(read(name) == data, f"{label}: payload differs from the source: {name}")


def verify_signature(path, bundle=False):
    run("codesign", "--verify", "--strict", *(("--deep",) if bundle else ()), path)
    info = subprocess.run(["codesign", "--display", "--verbose=2", path],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, text=True).stdout
    identity = os.environ.get("WAFFLE_SIGN_IDENTITY")
    if not identity:
        require("Signature=adhoc" in info, f"{path.name}: expected an ad hoc signature")
        return
    # The stable self-signed identity: the same certificate requirement in every release.
    require(f"Authority={identity}\n" in info, f"{path.name}: expected the {identity} signature")
    requirement = subprocess.run(["codesign", "--display", "-r-", path], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, check=True, text=True).stdout
    leaf = os.environ.get("WAFFLE_SIGN_LEAF") or (ROOT / "native/macos/signing-leaf.txt").read_text().strip()
    require(f'certificate leaf = H"{leaf}"' in requirement,
            f"{path.name}: expected the pinned signing certificate in the designated requirement")
    if bundle:
        require('identifier "org.waffle.editor"' in requirement, f"{path.name}: expected the Waffle identifier")


def verify_app(app, source, version, flavour, expected):
    contents = app / "Contents"
    info = plistlib.loads((contents / "Info.plist").read_bytes())
    original = plistlib.loads((source / "native/macos/Info.plist").read_bytes())
    for key in ("CFBundleIdentifier", "CFBundleExecutable", "CFBundleDisplayName",
                "CFBundleVersion", "CFBundleIconFile", "LSMinimumSystemVersion"):
        require(info[key] == original[key], f"{app.name}: unexpected {key}")
    require(info["CFBundleShortVersionString"] == version, "macOS bundle version differs from app/VERSION")
    verify_signature(app, bundle=True)
    executable = contents / "MacOS" / info["CFBundleExecutable"]
    arches = set(run("xcrun", "lipo", "-archs", executable, capture=True).split())
    require(arches == {b"arm64", b"x86_64"}, "macOS bundle must contain arm64 and x86_64")
    for arch in sorted(arches):
        build = run("xcrun", "vtool", "-arch", arch.decode(), "-show-build", executable, capture=True).decode()
        minimum = re.search(r"^\s+minos\s+(\S+)", build, re.MULTILINE)
        require(minimum and minimum[1] == info["LSMinimumSystemVersion"], f"macOS {arch.decode()} minimum differs from the plist")
    resources = contents / "Resources"
    files = (p.relative_to(resources).as_posix() for p in resources.rglob("*") if not p.is_dir())
    verify_payload(lambda name: (resources / name).read_bytes(), files, expected, app.name)
    icon = "Waffle-" + flavour.lower().replace(" ", "-") + ".icns"
    assets = {"Waffle.icns": icon,
              "WaffleTemplate.png": "WaffleTemplate.png", "WaffleTemplate@2x.png": "WaffleTemplate@2x.png"}
    for installed, supplied in assets.items():
        require((resources / installed).read_bytes() == (source / "brand/macos" / supplied).read_bytes(),
                f"macOS bundle: {installed} differs from the release asset")


def verify_dmg(dmg, source, version, release_name, flavour, expected):
    verify_signature(dmg)
    run("hdiutil", "verify", "-quiet", dmg)
    with tempfile.TemporaryDirectory(prefix="waffle-preview-mount-") as directory:
        volume = Path(directory)
        run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", volume, "-plist", dmg, capture=True)
        try:
            installer = plistlib.loads(run("diskutil", "info", "-plist", volume, capture=True))
            require(installer.get("VolumeName") == "Waffle EDA Installer", "Disk image: installer volume name is incorrect")
            require((volume / "Applications").readlink() == Path("/Applications"), "Disk image: Applications link is incorrect")
            readme = (volume / "Read Me First.txt").read_text(encoding="utf-8")
            require(readme.splitlines()[0] == f"Waffle EDA {version} · {release_name}",
                    "Disk image: Read Me First release identity differs from About")
            require("Open Anyway" in readme and "not notarised" in readme,
                    "Disk image: Read Me First needs the first-launch steps")
            for item, name in ((".DS_Store", "installer-layout.dsstore"), (".background.tiff", "installer-background-preview.tiff")):
                require((volume / item).read_bytes() == (source / "native/macos" / name).read_bytes(),
                        f"Disk image: installer asset differs from the source: {item}")
            verify_app(volume / "Waffle.app", source, version, flavour, expected)
        finally:
            run("hdiutil", "detach", volume, capture=True)


def pe(data, label):
    """Return the PE machine, data directories, and a reader for section-relative bytes."""
    require(data[:2] == b"MZ", f"{label}: missing the PE DOS header")
    offset, = struct.unpack_from("<I", data, 0x3C)
    require(data[offset:offset + 4] == b"PE\0\0", f"{label}: missing the PE header")
    machine, sections = struct.unpack_from("<HH", data, offset + 4)
    size, = struct.unpack_from("<H", data, offset + 20)
    optional = offset + 24
    magic, = struct.unpack_from("<H", data, optional)
    require(magic in (0x10B, 0x20B), f"{label}: unsupported PE optional header")
    start = optional + (96 if magic == 0x10B else 112)
    table = [struct.unpack_from("<IIII", data, optional + size + 40 * i + 8) for i in range(sections)]

    def read(rva, length):
        for _, address, raw_size, raw_offset in table:
            if address <= rva and rva + length <= address + raw_size:
                at = raw_offset + rva - address
                require(at + length <= len(data), f"{label}: truncated PE section")
                return data[at:at + length]
        raise ValueError(f"{label}: invalid PE section address")

    def directory(index):
        return struct.unpack_from("<II", data, start + 8 * index)

    return machine, directory, read


def pe_resources(directory, read):
    base, size = directory(2)
    table = read(base, size)

    def entries(offset):
        named, ids = struct.unpack_from("<HH", table, offset + 12)
        for i in range(named + ids):
            yield struct.unpack_from("<II", table, offset + 16 + i * 8)

    def resources(kind):
        for key, types in entries(0):
            if key != kind:
                continue
            for _, names in entries(types & 0x7fffffff):
                for _, leaf in entries(names & 0x7fffffff):
                    rva, length = struct.unpack_from("<II", table, leaf)
                    yield read(rva, length)

    return resources


def verify_windows(path, source, version, expected):
    with zipfile.ZipFile(path) as package:
        damaged = package.testzip()
        require(damaged is None, f"Windows ZIP: {damaged} failed its CRC check")
        files = (info.filename for info in package.infolist() if not info.is_dir())
        verify_payload(package.read, files, expected, "Windows ZIP")
        machine, directory, read = pe(package.read("Waffle.exe"), "Waffle.exe")
        clr, _ = directory(14)
        flags, = struct.unpack("<I", read(clr + 16, 4))
        require(machine == 0x14C and flags & 1 and not flags & 0x20002, "Windows host must be AnyCPU without a 32-bit preference")
        resources = pe_resources(directory, read)
        manifest, = resources(24)
        identity = ET.fromstring(manifest).find("{urn:schemas-microsoft-com:asm.v1}assemblyIdentity")
        expected_identity = ET.parse(source / "native/windows/app.manifest").getroot().find(identity.tag)
        require(identity.get("version") == f"{version}.0" and identity.attrib == expected_identity.attrib,
                "Windows executable: embedded application manifest differs from the release identity")
        version_info, = resources(16)
        fixed = version_info.index(b"\xBD\x04\xEF\xFE")
        file_ms, file_ls, product_ms, product_ls = struct.unpack_from("<IIII", version_info, fixed + 8)
        file_version = (file_ms >> 16, file_ms & 0xffff, file_ls >> 16, file_ls & 0xffff)
        require(".".join(map(str, file_version)) == f"{version}.0" and (file_ms, file_ls) == (product_ms, product_ls),
                "Windows executable: embedded file and product versions disagree")
        icon = (source / "brand/windows/waffle.ico").read_bytes()
        images = []
        for i in range(struct.unpack_from("<H", icon, 4)[0]):
            length, offset = struct.unpack_from("<II", icon, 14 + 16 * i)
            images.append(icon[offset:offset + length])
        require(images and sorted(resources(3)) == sorted(images), "Windows executable: embedded icon differs from the release asset")
        pe(package.read("Microsoft.Web.WebView2.Core.dll"), "WebView2 .NET assembly")
        ET.fromstring(package.read("Waffle.exe.config"))
        for name, expected_machine in (("win-x64", 0x8664), ("win-arm64", 0xAA64)):
            loader = f"runtimes/{name}/native/WebView2Loader.dll"
            require(pe(package.read(loader), loader)[0] == expected_machine, f"{loader}: incorrect architecture")


def verify_debian(path, source, expected, mac_app):
    # The Linux folder implementation is only selected on Linux. For this macOS
    # cross-check, let the extracted package use the signed host from this build.
    env = {**os.environ, "WAFFLE_FOLDER_MCP_HOST": str(mac_app / "Contents/MacOS/Waffle")}
    with tempfile.TemporaryDirectory() as stage:
        run(sys.executable, "-B", "native/tests/debian_package.py", path, "--stage", stage, cwd=source, env=env)
        installed = dict(expected)
        installed["native/bridge.js"] = installed.pop("bridge.js")
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            installed.pop(name)
        for name in ("native/linux/waffle.py", "native/linux/folder_project.py", "native/linux/notebook_media.py",
                     "native/external_tools.py", "native/linux/lan_relay.py", "collab/relay/waffle_relay.py"):
            installed[name] = (source / name).read_bytes()
        root = Path(stage)
        prefix = root / "usr/share/waffle"
        files = (item.relative_to(prefix).as_posix() for item in prefix.rglob("*") if item.is_file())
        verify_payload(lambda name: (prefix / name).read_bytes(), files, installed, "Debian package", debian=True)
        for asset in sorted((source / "brand/linux/hicolor").glob("*/apps/*")):
            theme_dir = asset.parent.parent.name
            suffix = "-symbolic.svg" if theme_dir == "symbolic" else asset.suffix
            staged = root / "usr/share/icons/hicolor" / theme_dir / "apps" / f"org.waffle.editor{suffix}"
            require(staged.is_file() and staged.read_bytes() == asset.read_bytes(),
                    f"Debian package: incorrect {theme_dir} icon")


def write_preview_checksums(source, products, dmg, windows, deb, *extras):
    notes = products / "Release-Notes.md"
    notes_source = script(source, "scripts/release-version.py", "--notes", capture=True).decode().strip()
    shutil.copyfile(source / notes_source, notes)
    sums = {p.name: digest(p) for p in (dmg, windows, deb, notes, *extras)}
    require((products / f"{dmg.name}.sha256").read_text().split() == [sums[dmg.name], dmg.name],
            "Disk image checksum does not match the verified image")
    (products / "SHA256SUMS").write_text("".join(f"{sha}  {name}\n" for name, sha in sums.items()), encoding="ascii")


def deliver(products, destination):
    # A caller can use a pre-created empty directory. rename() refuses to replace a directory
    # containing a previous preview or other files, including one populated during the build.
    if destination.is_symlink() or destination.exists() and not destination.is_dir():
        raise ValueError(f"Choose a new or empty preview folder: {destination}")
    try:
        products.rename(destination)
    except OSError as error:
        raise ValueError(f"Could not publish into {destination}: {error.strerror}") from error


def main():
    parser = argparse.ArgumentParser(prog="scripts/release-preview.sh", description=__doc__)
    parser.add_argument("output", nargs="?", type=Path,
                        help="New or empty output directory (default: dist/preview-<version>)")
    args = parser.parse_args()
    require(sys.platform == "darwin", "The complete preview needs macOS with Xcode for the universal app and disk image")
    revision = run("git", "rev-parse", "HEAD", capture=True).decode().strip()
    if args.output is None:
        committed_version = run("git", "show", f"{revision}:app/VERSION", capture=True).decode().strip()
        require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", committed_version), "Invalid committed app/VERSION")
        destination = ROOT / "dist" / f"preview-{committed_version}"
    else:
        destination = args.output.expanduser().absolute()
    require(not destination.is_symlink(), f"Choose a preview folder without a symbolic link: {destination}")
    if destination.exists():
        require(destination.is_dir() and not any(destination.iterdir()), f"Choose a new or empty preview folder: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Building the preview from {revision}", flush=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".waffle-preview-") as staging:
        source, products = Path(staging) / "source", Path(staging) / "products"
        source.mkdir()
        products.mkdir()
        archive_source(source, revision)
        version = script(source, "scripts/release-version.py", "--check", capture=True).decode().strip()
        name = script(source, "scripts/release-version.py", "--name", capture=True).decode().strip()
        flavour = script(source, "scripts/release-version.py", "--flavour", capture=True).decode().strip()
        stable_update = bool(os.environ.get("WAFFLE_SIGN_IDENTITY"))
        if stable_update:
            script(source, "scripts/release-manifest.py", "check-release-key")
        script(source, "scripts/prepare-assets.py")
        script(source, "scripts/prepare-assets.py", "--check")
        script(source, "scripts/gen-shortcuts.py", "--check")
        run("xcrun", "--find", "swiftc", capture=True)
        dotnet = os.environ.get("DOTNET") or run("scripts/ci/install-dotnet.sh", cwd=source, capture=True).decode().strip()
        env = {**os.environ, "ATRIUM_SIGN_IDENTITY": "-", "ATRIUM_NOTARY_PROFILE": "",
               "WAFFLE_RELEASE_FLAVOUR": flavour, "DOTNET": dotnet, "COPYFILE_DISABLE": "1"}
        run("scripts/build-mac.sh", products, cwd=source, env=env)
        app = products / "Waffle.app"
        run("scripts/build-dmg.sh", app, products, cwd=source, env=env)
        run("scripts/build-windows.sh", products, cwd=source, env=env)
        deb = products / script(source, "scripts/build-deb.py", "--filename", capture=True).decode().strip()
        script(source, "scripts/build-deb.py", "--output", deb)
        expected = payload(source)
        dmg = products / f"Waffle-{version}.dmg"
        windows = products / f"Waffle-{version}-windows.zip"
        print("Verifying the macOS bundle and disk image, Windows ZIP, and Debian package", flush=True)
        verify_app(app, source, version, flavour, expected)
        verify_dmg(dmg, source, version, name, flavour, expected)
        verify_windows(windows, source, version, expected)
        verify_debian(deb, source, expected, app)
        shutil.rmtree(products / "Waffle-windows")
        extras = []
        if stable_update:
            notes = script(source, "scripts/release-version.py", "--notes", capture=True).decode().strip()
            script(source, "scripts/release-manifest.py", "macos", app, "--version", version,
                   "--out", products, "--notes-file", source / notes)
            extras = [products / name for name in (f"Waffle-{version}-macOS.zip", "waffle-release.json", "waffle-release.json.sig")]
        write_preview_checksums(source, products, dmg, windows, deb, *extras)
        deliver(products, destination)
    print(f"Verified Waffle EDA {version} ({name}) at {destination}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, struct.error, ET.ParseError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(errors="replace"), file=sys.stderr, end="")
        sys.exit(f"Preview build failed: {error}")
