#!/usr/bin/env python3
"""The collaboration server kit (deploy/collab-server): both generated scripts are current, the launch
script stays under its byte limit, and each script's own unpack step, run under bash exactly as on a
server (WAFFLE_UNPACK_ROOT=dir stops it after unpacking), produces the helper (and the relay): from a
pristine copy and from copies mangled the way browser-terminal pastes mangle them (CRLF line ends,
trailing spaces, indented lines). An altered payload is reported with its expected SHA-256 and nothing
is unpacked. The packed helper passes `bash -n`, the packed (minified) relay passes the relay's own
test suite, and nothing but placeholders names a domain.

    python3 tests/project/collab-server-kit.py
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
KIT = ROOT / "deploy" / "collab-server"


def run_unpack(text, into, name):
    """Writes `text` as a script and runs it under bash with WAFFLE_UNPACK_ROOT; returns the result."""
    os.makedirs(into, exist_ok=True)
    script = Path(into).parent / (Path(into).name + "-" + name)
    script.write_bytes(text.encode())
    env = dict(os.environ, WAFFLE_UNPACK_ROOT=str(into))
    return subprocess.run(["bash", str(script), "collab.example.org"], env=env, capture_output=True, text=True, timeout=120)


def files_in(root):
    return sorted(str(p.relative_to(root)) for p in Path(root).rglob("*") if p.is_file())


def check_upgrade(helper, root, partial=False):
    """Run the packed migration with temporary directories and a recording systemctl."""
    old = root / "etc/atrium-collab"
    new = root / "etc/waffle-collab"
    fixture = {
        "etc/atrium-collab/config": "DOMAIN=collab.example.org\nACME_EMAIL=\nMODE=private\nTURN_MONTHLY_GB=42\n",
        "etc/atrium-collab/turn-secret": "synthetic-secret-for-upgrade",
        "etc/atrium-relay/hosts": "test-hash fixture-member\n",
        "var/lib/atrium-collab/usage": "fixture accounting data",
        "run/atrium-collab/turn-off": "1",
        "opt/atrium-collab/atrium_relay.py": "# installed relay",
        "etc/systemd/system/atrium-relay.service": "[Unit]",
        "etc/systemd/system/atrium-collab-certs.service": "[Unit]",
        "etc/systemd/system/atrium-collab-certs.timer": "[Timer]",
        "etc/systemd/system/coturn.service.d/atrium.conf": "[Service]",
    }
    for name, content in fixture.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    secret = old / "turn-secret"
    secret.chmod(0o600)
    inode = secret.stat().st_ino
    script = '''source "$1"
systemctl() { printf '%s\n' "$*" >> "$SERVICE_LOG"; }
SERVICE_LOG="$2/services"
migrate_legacy "$2"'''
    def migrate():
        return subprocess.run(["bash", "-c", script, "_", str(helper), str(root)],
                              text=True, capture_output=True, timeout=10)

    # Conflict detection precedes stopping services and never overwrites either credential.
    new.mkdir()
    (new / "turn-secret").write_text("second-install")
    assert migrate().returncode != 0 and not (root / "services").exists()
    assert (new / "turn-secret").read_text() == "second-install"
    assert secret.read_text() == fixture["etc/atrium-collab/turn-secret"]
    (new / "turn-secret").unlink()
    new.rmdir()
    if partial:
        # Resume after one of the independent directory moves completed.
        (root / "etc/atrium-relay").rename(root / "etc/waffle-relay")
    result = migrate()
    assert result.returncode == 0, result.stderr
    assert not old.exists() and (new / "turn-secret").stat().st_ino == inode
    assert (new / "turn-secret").stat().st_mode & 0o777 == 0o600
    for name, content in fixture.items():
        if "systemd" in name:
            assert not (root / name).exists()
        else:
            assert (root / name.replace("atrium", "waffle")).read_text() == content
    service_calls = (root / "services").read_text().splitlines()
    assert service_calls == ["stop atrium-collab-certs.timer", "disable atrium-collab-certs.timer",
                             "stop atrium-collab-certs.service", "stop atrium-relay.service", "disable atrium-relay.service"]
    assert migrate().returncode == 0
    assert (root / "services").read_text().splitlines() == service_calls
    assert (new / "turn-secret").stat().st_ino == inode


def main():
    assert subprocess.run([sys.executable, str(ROOT / "scripts" / "gen-collab-launch.py"), "--check"]).returncode == 0
    launch, setup = KIT / "launch-script.sh", KIT / "waffle-setup.sh"
    assert len(launch.read_bytes()) <= 13000, "launch script %d bytes" % len(launch.read_bytes())
    want = {launch: ["usr/local/sbin/waffle-collab"], setup: ["opt/waffle-collab/waffle_relay.py", "usr/local/sbin/waffle-collab"]}
    with tempfile.TemporaryDirectory() as tmp:
        for script in (launch, setup):
            assert subprocess.run(["bash", "-n", str(script)]).returncode == 0, script
            text = script.read_text()
            variants = {
                "pristine": text,
                "crlf": text.replace("\n", "\r\n"),
                "trailing-spaces": "\n".join(line + "  " for line in text.split("\n")),
                "crlf-and-indent": "\r\n".join(("  " + line + " ") if i % 3 else line for i, line in enumerate(text.split("\n"))),
            }
            for name, variant in variants.items():
                into = os.path.join(tmp, script.stem + "-" + name)
                r = run_unpack(variant, into, name)
                assert r.returncode == 0, (script.name, name, r.stdout[-1500:], r.stderr[-1500:])
                assert files_in(into) == want[script], (script.name, name, files_in(into))
            # One altered character in the payload: a clear message with the expected hash, nothing unpacked.
            lines = text.split("\n")
            i = next(n for n, line in enumerate(lines) if len(line) == 76 and " " not in line)
            lines[i] = ("0" if lines[i][10] != "0" else "1").join([lines[i][:10], lines[i][11:]])
            into = os.path.join(tmp, script.stem + "-altered")
            r = run_unpack("\n".join(lines), into, "altered")
            sha = re.search(r"' ([0-9a-f]{64}) <<'FILES'", text).group(1)
            assert r.returncode != 0 and "The paste was altered" in r.stderr + r.stdout and sha in r.stderr + r.stdout, (r.stdout, r.stderr)
            assert not files_in(into), "nothing is unpacked from an altered paste"
        packed = Path(tmp, "waffle-setup-crlf")
        assert subprocess.run(["bash", "-n", str(packed / "usr/local/sbin/waffle-collab")]).returncode == 0
        helper = packed / "usr/local/sbin/waffle-collab"
        check_upgrade(helper, Path(tmp) / "upgrade")
        check_upgrade(helper, Path(tmp) / "interrupted-upgrade", partial=True)
        env = dict(os.environ, ATRIUM_RELAY_DIR=str(packed / "opt/waffle-collab"))
        r = subprocess.run([sys.executable, str(ROOT / "tests/project/collab-relay.py")], env=env, capture_output=True, text=True, timeout=600)
        assert r.returncode == 0 and "collab-relay: ok" in r.stdout, r.stdout[-2000:] + r.stderr[-2000:]
    # Placeholders only: no real domain, address or mailbox in the kit.
    for path in KIT.iterdir():
        text = path.read_text()
        for host in re.findall(r"\b(?:[a-z0-9-]+\.)+(?:org|com|net|io|dev)\b", text):
            assert host.endswith(("example.org", "example.com")) or host in {
                "dl.cloudsmith.io", "checkip.amazonaws.com", "webrtc.github.io", "letsencrypt.org"}, (path.name, host)
    print("collab-server-kit: ok (scripts current; launch script %d bytes; real unpack under bash from pristine, CRLF, "
          "trailing-space and indented pastes; altered paste refused with its sha256; packed relay passes its tests)" % len(launch.read_bytes()))


if __name__ == "__main__":
    main()
