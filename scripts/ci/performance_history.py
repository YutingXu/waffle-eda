#!/usr/bin/env python3
"""Restore performance history from this repository's successful default-branch runs."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from performance import ROOT, SCHEMA, ancestry, ordered_history, parse_history, write_json

ARTIFACT_PREFIX = "waffle-performance"
MAX_DOWNLOADS = 4
MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
WORKFLOW = "/workflows/performance.yml/runs"


def read_api(origin, token, path, params=None):
    url = origin + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                   "X-GitHub-Api-Version": "2022-11-28"})
    # GitHub sends ZIP downloads through a short-lived, presigned storage redirect.
    # urllib only copies ordinary headers to a redirected request.
    request.add_unredirected_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(MAX_ARTIFACT_BYTES + 1)
    if len(body) > MAX_ARTIFACT_BYTES:
        raise ValueError("Performance history exceeds its size limit.")
    return body


def archive_history(blob, digest):
    if "sha256:" + hashlib.sha256(blob).hexdigest() != digest:
        raise ValueError("Performance history artifact failed its digest check.")
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        if archive.getinfo("history.json").file_size > MAX_ARTIFACT_BYTES:
            raise ValueError("Performance history exceeds its size limit.")
        return parse_history(json.loads(archive.read("history.json")))


def restore(read, commits, branch, current_run):
    # Use several snapshots so a later finish or rerun cannot erase another series's
    # independently saved commit. Each snapshot carries its earlier rolling history.
    rank = {sha: index for index, sha in enumerate(commits)}
    workflow_runs = json.loads(read(WORKFLOW, {"branch": branch, "status": "success", "per_page": 100}))
    eligible = sorted(
        (run for run in workflow_runs["workflow_runs"]
         if run["id"] != current_run and run["head_sha"] in rank
         and run["head_branch"] == branch and run["event"] in {"push", "workflow_dispatch"}
         and run["conclusion"] == "success"),
        key=lambda run: (rank[run["head_sha"]], -run["id"]),
    )
    records, downloaded = [], set()
    for run in eligible:
        sha = run["head_sha"]
        if sha in downloaded:
            continue
        artifact_name = f"{ARTIFACT_PREFIX}-{sha}-{run['run_attempt']}"
        artifacts = json.loads(read(f"/runs/{run['id']}/artifacts", {"name": artifact_name}))
        artifact = next((item for item in artifacts["artifacts"]
                         if item["name"] == artifact_name and not item["expired"]), None)
        if not artifact:
            continue
        try:
            blob = read(f"/artifacts/{artifact['id']}/zip")
        except urllib.error.HTTPError as error:
            if error.code not in (404, 410):
                raise
            continue  # An expired or removed artifact can disappear between list and download.
        records.extend(archive_history(blob, artifact["digest"]))
        downloaded.add(sha)
        if len(downloaded) == MAX_DOWNLOADS:
            break
    return ordered_history(records, commits), len(downloaded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    origin = f"{os.environ['GITHUB_API_URL']}/repos/{os.environ['GITHUB_REPOSITORY']}/actions"
    token = os.environ["GITHUB_TOKEN"]
    try:
        history, sources = restore(lambda path, params=None: read_api(origin, token, path, params),
                                   ancestry(ROOT)[1:], os.environ["DEFAULT_BRANCH"], int(os.environ["GITHUB_RUN_ID"]))
    except urllib.error.HTTPError as error:
        parser.exit(2, f"Could not read performance history from GitHub (HTTP {error.code}).\n")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile):
        parser.exit(2, "Could not read a valid performance history artifact.\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.output, {"schema": SCHEMA, "records": history})
    print(f"Restored {len(history)} prior measurements from {sources} performance artifacts.")


if __name__ == "__main__":
    sys.exit(main())
