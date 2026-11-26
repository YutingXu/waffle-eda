#!/usr/bin/env python3
"""Write and sign the release manifest that Help › Check for Updates… reads (app/editor/update-check.js,
docs/upgrading.md). Uses only the Python standard library and the openssl command (Ed25519).

  scripts/release-manifest.py keygen <private.pem>
      Make a signing key. Prints the public key (64 hex digits) to put in app/editor/update-check.js
      PUBLIC_KEY. Use create-update-signing-key.sh to put it in the build Mac's signing secrets folder.

  scripts/release-manifest.py build --version 0.7.0 --out waffle-release.json \\
        --url-base https://github.com/OWNER/REPO/releases/download/v0.7.0 \\
        [--notes "First line" --notes "Second line"] FILE...
      List each release file with its SHA-256 and size. The platform comes from the file name
      (macOS, windows, .deb). The format and extension API versions come from the native project codec and
      app/core/atrium-api.js, so the manifest states what the release reads and writes.
      Pass downloadable files only. Use --notes for the text the updater should show.

  scripts/release-manifest.py sign --key <private.pem> waffle-release.json
      Write waffle-release.json.sig (base64 Ed25519 signature of the exact manifest bytes).

  scripts/release-manifest.py verify --public <hex> waffle-release.json
      Check a signature with the public key, as the app does.

  scripts/release-manifest.py macos Waffle.app --version 0.8.1 --out dist --notes-file docs/release-notes.md
      Verify and package the stable-signed macOS app, then sign its manifest using the pinned release key.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import plistlib
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import textwrap

ROOT = Path(__file__).resolve().parents[1]
DER_PREFIX = bytes.fromhex("302a300506032b6570032100")  # SubjectPublicKeyInfo for a raw Ed25519 key
# Match AtriumUpdate.parseManifest before writing a manifest that will be signed.
ASSET_BASENAME = re.compile(r"[A-Za-z0-9_.+-]{1,120}")
MAX_ASSET_BYTES = 2_000_000_000
REPOSITORY = re.compile(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+")
SIGNING_KEY = Path.home() / "Library/Application Support/waffle-release-signing/update-ed25519.pem"


def trust():
    source = (ROOT / "app/editor/update-check.js").read_text(encoding="utf-8")
    def setting(name, pattern):
        match = re.search(rf'^  const {name} = "([^"]*)";$', source, re.M)
        if not match or not re.fullmatch(pattern, match[1]):
            raise ValueError(f"app/editor/update-check.js: invalid {name}")
        return match[1]
    leaf = (ROOT / "native/macos/signing-leaf.txt").read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", leaf):
        raise ValueError("native/macos/signing-leaf.txt: invalid certificate pin")
    return {"repository": setting("RELEASE_REPOSITORY", REPOSITORY),
            "publicKey": setting("PUBLIC_KEY", r"[0-9a-f]{64}"), "signingLeaf": leaf}


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def public_hex(private_pem):
    der = openssl("pkey", "-in", str(private_pem), "-pubout", "-outform", "DER")
    if len(der) != len(DER_PREFIX) + 32 or not der.startswith(DER_PREFIX):
        raise ValueError("Expected an Ed25519 signing key")
    return der[len(DER_PREFIX):].hex()


def platform_of(name):
    low = name.lower()
    if low.endswith(".deb") or "linux" in low:
        return "linux"
    if "windows" in low or low.endswith((".exe", ".msi")):
        return "windows"
    if "macos" in low or low.endswith(".dmg"):
        return "macos"
    return "source"


def versions():
    codec = (ROOT / "app" / "formats/format-2-codec.js").read_text(encoding="utf-8")
    fmt = re.search(r'^  const FORMAT = "(\d+\.\d+)";$', codec, re.M).group(1)
    api = int(re.search(r"VERSION\s*[:=]\s*(\d+)", (ROOT / "app" / "core/atrium-api.js").read_text()).group(1))
    return fmt, api


def build(args):
    fmt, api = versions()
    assets = []
    names = set()
    for f in args.files:
        path = Path(f)
        name = path.name
        if not ASSET_BASENAME.fullmatch(name):
            sys.exit(f"Cannot list {name!r} as an update download. Use 1 to 120 ASCII letters, digits, "
                     "periods, underscores, plus signs or hyphens. Use --notes for release note text.")
        if name in names:
            sys.exit(f"Multiple release files are named {name!r}.")
        names.add(name)
        size = path.stat().st_size
        if not 1 <= size <= MAX_ASSET_BYTES:
            sys.exit(f"Cannot list {name!r} as an update download. Its size must be 1 to {MAX_ASSET_BYTES} bytes.")
        sha = hashlib.sha256()
        count = 0
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1 << 20), b""):
                sha.update(block)
                count += len(block)
        if count != size:
            sys.exit(f"{name!r} changed while building the manifest.")
        assets.append({"platform": platform_of(name), "name": name, "url": args.url_base.rstrip("/") + "/" + name,
                       "sha256": sha.hexdigest(), "size": size})
    notes = list(args.notes or [])
    if args.notes_file:
        for line in args.notes_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                notes.extend(textwrap.wrap(line.lstrip("# ").removeprefix("- ").replace("**", ""), width=480))
    if any(len(note) > 500 for note in notes):
        sys.exit("Release notes must be at most 500 characters per line.")
    manifest = {"format": "atrium-release", "version": 1, "app": args.version,
                "published": args.date or datetime.date.today().isoformat(),
                "formats": {"writes": fmt, "reads": fmt}, "apiVersions": [api],
                "notes": notes, "assets": assets,
                "rollback": args.url_base.split("/releases/", 1)[0].rstrip("/") + "/blob/main/docs/upgrading.md#rolling-back"}
    payload = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    if len(payload) > 512 * 1024:
        sys.exit("Release manifest exceeds the app's 512 KiB limit.")
    Path(args.out).write_bytes(payload)
    print("wrote", args.out, "(%d assets, format %s, API %d)" % (len(assets), fmt, api))


def sign(args):
    manifest = Path(args.manifest)
    public = public_hex(args.key)
    signature = openssl("pkeyutl", "-sign", "-inkey", args.key, "-rawin", "-in", str(manifest))
    if len(signature) != 64:
        raise ValueError("Expected an Ed25519 signature")
    Path(str(manifest) + ".sig").write_text(base64.b64encode(signature).decode() + "\n")
    print("wrote", str(manifest) + ".sig", "(public key %s)" % public)


def verify(args):
    manifest = Path(args.manifest)
    signature = base64.b64decode(Path(str(manifest) + ".sig").read_text().strip(), validate=True)
    if len(signature) != 64 or not re.fullmatch(r"[0-9a-fA-F]{64}", args.public):
        raise ValueError("Expected a 64-byte Ed25519 signature and 32-byte public key")
    with tempfile.TemporaryDirectory() as tmp:
        pub, sig = Path(tmp) / "pub.der", Path(tmp) / "sig"
        pub.write_bytes(DER_PREFIX + bytes.fromhex(args.public))
        sig.write_bytes(signature)
        ok = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER", "-inkey", str(pub), "-rawin",
                             "-in", str(manifest), "-sigfile", str(sig)], capture_output=True).returncode == 0
    print("signature OK" if ok else "signature INVALID")
    return 0 if ok else 1



def verify_macos_bundle(app, version, pins):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if (info.get("CFBundleShortVersionString"), info.get("CFBundleIdentifier"), info.get("CFBundleExecutable")) != (
        version, "org.waffle.editor", "Waffle"
    ):
        raise ValueError(f"{app.name}: unexpected macOS version or identity")
    if json.loads((app / "Contents/Resources/update-trust.json").read_bytes()) != pins:
        raise ValueError(f"{app.name}: updater pins differ from the release source")
    expected = f'identifier "org.waffle.editor" and certificate leaf = H"{pins["signingLeaf"]}"'
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--deep", "--all-architectures",
                    "-R=" + expected, app], check=True)
    for arch in ("arm64", "x86_64"):
        report = subprocess.check_output(["/usr/bin/codesign", "--display", "--arch", arch, "-r-", app],
                                         stderr=subprocess.STDOUT, text=True)
        if [line for line in report.splitlines() if line.startswith("designated => ")] != ["designated => " + expected]:
            raise ValueError(f"{app.name} ({arch}): unexpected designated signing requirement")


def check_release_key():
    try:
        info = SIGNING_KEY.lstat()
    except FileNotFoundError:
        sys.exit("No Ed25519 release key. Run scripts/create-update-signing-key.sh on the build Mac.")
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        sys.exit("The release manifest key must be a regular mode-0600 file owned by the build user.")
    if public_hex(SIGNING_KEY) != trust()["publicKey"]:
        sys.exit("The Ed25519 release key does not match PUBLIC_KEY in app/editor/update-check.js.")


def macos(args):
    if sys.platform != "darwin":
        sys.exit("Building an update archive requires macOS.")
    pins = trust()
    check_release_key()
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}", args.version):
        raise ValueError("Expected the numeric macOS bundle version")
    if args.app.name != "Waffle.app":
        raise ValueError("The update archive requires Waffle.app")
    verify_macos_bundle(args.app, args.version, pins)
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out, prefix=".release-update-") as stage:
        folder = Path(stage)
        archive = folder / f"Waffle-{args.version}-macOS.zip"
        subprocess.run(["/usr/bin/ditto", "-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noqtn",
                        "--noacl", args.app, archive], check=True)
        extracted = folder / "roundtrip"
        extracted.mkdir()
        subprocess.run(["/usr/bin/tar", "-xkf", archive, "--no-xattrs", "--no-mac-metadata", "--no-acls",
                        "--no-fflags", "--no-same-owner", "--no-same-permissions", "-C", extracted], check=True)
        if [item.name for item in extracted.iterdir()] != ["Waffle.app"]:
            raise ValueError("Unexpected files in the macOS update archive")
        verify_macos_bundle(extracted / "Waffle.app", args.version, pins)
        manifest = folder / "waffle-release.json"
        build(argparse.Namespace(version=args.version, out=manifest,
              url_base=f'https://github.com/{pins["repository"]}/releases/download/v{args.version}',
              date=None, notes=None, notes_file=args.notes_file, files=[archive]))
        sign(argparse.Namespace(key=SIGNING_KEY, manifest=manifest))
        if verify(argparse.Namespace(public=pins["publicKey"], manifest=manifest)) != 0:
            raise ValueError("The staged manifest signature did not verify")
        for file in (archive, manifest, manifest.with_suffix(".json.sig")):
            file.replace(args.out / file.name)

def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("configure", help="set the signed release feed in a release checkout")
    c.add_argument("repository", help="GitHub owner/repository")
    pinned = sub.add_parser("write-trust", help="write the public updater pins into the macOS bundle")
    pinned.add_argument("out", type=Path)
    sub.add_parser("check-release-key", help="check the private release key against the app's Ed25519 pin")
    mac = sub.add_parser("macos", help="package a pinned-signed Waffle.app and sign its release manifest")
    mac.add_argument("app", type=Path)
    mac.add_argument("--version", required=True)
    mac.add_argument("--out", required=True, type=Path)
    mac.add_argument("--notes-file", required=True, type=Path)
    k = sub.add_parser("keygen")
    k.add_argument("out")
    b = sub.add_parser("build")
    b.add_argument("--version", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--url-base", required=True)
    b.add_argument("--date")
    b.add_argument("--notes", action="append")
    b.add_argument("--notes-file", type=Path)
    b.add_argument("files", nargs="+")
    s = sub.add_parser("sign")
    s.add_argument("--key", required=True)
    s.add_argument("manifest")
    v = sub.add_parser("verify")
    v.add_argument("--public", required=True)
    v.add_argument("manifest")
    args = parser.parse_args(argv)
    if args.cmd == "configure":
        if not REPOSITORY.fullmatch(args.repository):
            parser.error("expected a GitHub owner/repository")
        asset = ROOT / "app" / "editor/update-check.js"
        source, count = re.subn(r'^  const RELEASE_REPOSITORY = "[^"]*";$',
                                "  const RELEASE_REPOSITORY = " + json.dumps(args.repository) + ";",
                                asset.read_text(), flags=re.M)
        if count != 1:
            parser.error("release repository setting missing from update-check.js")
        asset.write_text(source)
        return 0
    if args.cmd == "write-trust":
        args.out.write_text(json.dumps(trust()) + "\n", encoding="utf-8")
        return 0
    if args.cmd == "check-release-key":
        check_release_key()
        return 0
    if args.cmd == "keygen":
        # O_EXCL and the initial mode also protect the key if another invocation races this one.
        key = openssl("genpkey", "-algorithm", "ed25519")
        try:
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            sys.exit(args.out + " exists; not replaced.")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(key)
        except OSError:
            Path(args.out).unlink()
            raise
        print("public key (app/editor/update-check.js PUBLIC_KEY):", public_hex(args.out))
        return 0
    return {"build": build, "sign": sign, "verify": verify, "macos": macos}[args.cmd](args) or 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release manifest: {error}")
