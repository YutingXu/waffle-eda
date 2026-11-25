#!/usr/bin/env python3
"""Fetch or verify the pinned, public Altium fidelity fixtures outside the checkout."""
import argparse
import hashlib
import io
import json
import os
import re
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "waffle" / "altium-fidelity"
MAX_FILE = 24 * 1024 * 1024
HOSTS = {"raw.githubusercontent.com", "github.com", "release-assets.githubusercontent.com", "gitlab.com"}


def safe_url(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in HOSTS or parts.username or parts.password or parts.port:
        raise ValueError("unexpected fixture download origin")
    return url


class PublicRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, safe_url(newurl))


# No proxy credentials, cookies, git configuration, referrer or user-agent header.
OPENER = build_opener(ProxyHandler({}), PublicRedirect())
OPENER.addheaders = [("Accept-Encoding", "identity")]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, expected, name):
    if len(data) > MAX_FILE or digest(data) != expected:
        raise ValueError(f"{name}: fixture SHA-256 or size check failed")
    return data


def fetch(url):
    for attempt in range(3):
        try:
            with OPENER.open(Request(safe_url(url)), timeout=30) as result:
                if int(result.headers.get("Content-Length", 0)) > MAX_FILE:
                    raise ValueError("fixture download exceeds the size limit")
                body = bytearray()
                deadline = time.monotonic() + 45
                while len(body) <= MAX_FILE and time.monotonic() < deadline:
                    chunk = result.read1(min(128 * 1024, MAX_FILE + 1 - len(body)))
                    if not chunk:
                        return bytes(body)
                    body.extend(chunk)
                raise ValueError("fixture download exceeded its byte or time budget")
        except HTTPError as exc:
            if attempt == 2 or exc.code not in (429, 500, 502, 503, 504):
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(attempt + 1)


def entries(asset):
    for item in asset.get("members", [asset]):
        name = item.get("path") or unquote(urlsplit(item["url"]).path)
        basename = PurePosixPath(name).name
        if not basename or basename in (".", "..") or "\\" in basename:
            raise ValueError("invalid cache file name")
        yield basename, item


def manifest():
    data = json.loads((HERE / "fixtures.json").read_text())
    if data["version"] != 1 or not 5 <= len(data["projects"]) <= 10:
        raise ValueError("unsupported fidelity manifest")
    projects = data["projects"]
    if len({p["id"] for p in projects}) != len(projects):
        raise ValueError("duplicate project ID")
    for p in projects:
        if not re.fullmatch(r"[a-z0-9-]+", p["id"]) or not re.fullmatch(r"[0-9a-f]{40}", p["revision"]):
            raise ValueError("invalid fixture ID or revision")
        if not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+", p["upstream"]):
            raise ValueError("invalid source repository")
        if p["license"] not in {"BSD-2-Clause", "BSD-3-Clause", "MIT", "Apache-2.0", "CERN-OHL-P-2.0", "CC-BY-4.0"}:
            raise ValueError("unexpected design licence")
        files = [e for a in p["assets"] for e in entries(a)]
        if len({n.casefold() for n, _ in files}) != len(files) or not any(f["role"] == "license" for _, f in files):
            raise ValueError("ambiguous cache names or missing licence")
    return projects


def verified(project, cache, offline):
    cache = cache.expanduser().resolve()
    if cache == ROOT or ROOT in cache.parents or any((p / ".git").exists() for p in (cache, *cache.parents)):
        raise ValueError("choose a fixture cache outside the checkout")
    directory = cache / project["id"] / project["revision"]
    if directory.resolve() != directory:
        raise ValueError("fixture directory is a symbolic link")
    directory.mkdir(parents=True, exist_ok=True)
    resources = []
    for asset in project["assets"]:
        files = list(entries(asset))
        missing = []
        for name, item in files:
            target = directory / name
            if target.is_symlink():
                raise ValueError("unexpected cache symlink")
            if not target.is_file() or target.stat().st_size > MAX_FILE or digest(target.read_bytes()) != item["sha256"]:
                missing.append(name)
            resources.append({"name": name, "role": item["role"]})
        if not missing:
            continue
        if offline:
            raise ValueError(f"{project['id']}: missing or changed {missing[0]}; run fetch.py")
        url = asset.get("url")
        if not url:
            repo = project["upstream"].removeprefix("https://github.com/")
            url = f"https://raw.githubusercontent.com/{repo}/{project['revision']}/{quote(asset['path'])}"
        data = checked(fetch(url), asset["sha256"], project["id"])
        with tempfile.TemporaryDirectory(dir=directory) as tmp:
            if "members" in asset:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    for name, item in files:
                        if name not in missing:
                            continue
                        info = archive.getinfo(item["path"])
                        if info.file_size > MAX_FILE:
                            raise ValueError("unpacked fixture exceeds the size limit")
                        with archive.open(info) as stream:
                            body = checked(stream.read(MAX_FILE + 1), item["sha256"], name)
                        (Path(tmp) / name).write_bytes(body)
            else:
                (Path(tmp) / files[0][0]).write_bytes(data)
            for name in missing:
                os.replace(Path(tmp) / name, directory / name)
    return directory, resources


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    for project in manifest():
        _, files = verified(project, args.cache, args.offline)
        print(f"{project['id']}: {len(files)} files verified", flush=True)
