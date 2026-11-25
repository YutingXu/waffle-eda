#!/usr/bin/env python3
"""Write and sign the release manifest that Help › Check for Updates… reads (app/editor/update-check.js,
docs/upgrading.md). Uses only the Python standard library and the openssl command (Ed25519).

  scripts/release-manifest.py keygen <private.pem>
      Make a signing key. Prints the public key (64 hex digits) to put in app/editor/update-check.js
      PUBLIC_KEY. Keep the private key out of the repository (a GitHub Actions secret).

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

Upload waffle-release.json and waffle-release.json.sig to the GitHub Release with the builds.
"""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DER_PREFIX = bytes.fromhex("302a300506032b6570032100")  # SubjectPublicKeyInfo for a raw Ed25519 key
# Match AtriumUpdate.parseManifest before writing a manifest that will be signed.
ASSET_BASENAME = re.compile(r"[A-Za-z0-9_.+-]{1,120}")
MAX_ASSET_BYTES = 2_000_000_000


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout


def public_hex(private_pem):
    der = openssl("pkey", "-in", str(private_pem), "-pubout", "-outform", "DER")
    return der[-32:].hex()


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
    for f in args.files:
        path = Path(f)
        name = path.name
        if not ASSET_BASENAME.fullmatch(name):
            sys.exit(f"Cannot list {name!r} as an update download. Use 1 to 120 ASCII letters, digits, "
                     "periods, underscores, plus signs or hyphens. Use --notes for release note text.")
        data = path.read_bytes()
        if not 1 <= len(data) <= MAX_ASSET_BYTES:
            sys.exit(f"Cannot list {name!r} as an update download. Its size must be 1 to {MAX_ASSET_BYTES} bytes.")
        assets.append({"platform": platform_of(name), "name": name, "url": args.url_base.rstrip("/") + "/" + name,
                       "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    manifest = {"format": "atrium-release", "version": 1, "app": args.version,
                "published": args.date or datetime.date.today().isoformat(),
                "formats": {"writes": fmt, "reads": fmt}, "apiVersions": [api],
                "notes": args.notes or [], "assets": assets,
                "rollback": args.url_base.split("/releases/", 1)[0].rstrip("/") + "/blob/main/docs/upgrading.md#rolling-back"}
    Path(args.out).write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", args.out, "(%d assets, format %s, API %d)" % (len(assets), fmt, api))


def sign(args):
    manifest = Path(args.manifest)
    signature = openssl("pkeyutl", "-sign", "-inkey", args.key, "-rawin", "-in", str(manifest))
    Path(str(manifest) + ".sig").write_text(base64.b64encode(signature).decode() + "\n")
    print("wrote", str(manifest) + ".sig", "(public key %s)" % public_hex(args.key))


def verify(args):
    manifest = Path(args.manifest)
    signature = base64.b64decode(Path(str(manifest) + ".sig").read_text().strip())
    with tempfile.TemporaryDirectory() as tmp:
        pub, sig = Path(tmp) / "pub.der", Path(tmp) / "sig"
        pub.write_bytes(DER_PREFIX + bytes.fromhex(args.public))
        sig.write_bytes(signature)
        ok = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER", "-inkey", str(pub), "-rawin",
                             "-in", str(manifest), "-sigfile", str(sig)], capture_output=True).returncode == 0
    print("signature OK" if ok else "signature INVALID")
    return 0 if ok else 1


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("configure", help="set the signed release feed in a release checkout")
    c.add_argument("repository", help="GitHub owner/repository")
    k = sub.add_parser("keygen")
    k.add_argument("out")
    b = sub.add_parser("build")
    b.add_argument("--version", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--url-base", required=True)
    b.add_argument("--date")
    b.add_argument("--notes", action="append")
    b.add_argument("files", nargs="+")
    s = sub.add_parser("sign")
    s.add_argument("--key", required=True)
    s.add_argument("manifest")
    v = sub.add_parser("verify")
    v.add_argument("--public", required=True)
    v.add_argument("manifest")
    args = parser.parse_args(argv)
    if args.cmd == "configure":
        if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", args.repository):
            parser.error("expected a GitHub owner/repository")
        asset = ROOT / "app" / "editor/update-check.js"
        source, count = re.subn(r'^  const RELEASE_REPOSITORY = "[^"]*";$',
                                "  const RELEASE_REPOSITORY = " + json.dumps(args.repository) + ";",
                                asset.read_text(), flags=re.M)
        if count != 1:
            parser.error("release repository setting missing from update-check.js")
        asset.write_text(source)
        return 0
    if args.cmd == "keygen":
        if Path(args.out).exists():
            sys.exit(args.out + " exists; not replaced.")
        openssl("genpkey", "-algorithm", "ed25519", "-out", args.out)
        Path(args.out).chmod(0o600)
        print("public key (app/editor/update-check.js PUBLIC_KEY):", public_hex(args.out))
        return 0
    return {"build": build, "sign": sign, "verify": verify}[args.cmd](args) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
