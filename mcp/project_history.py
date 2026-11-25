"""Read-only, paged project history. Native and headless clients use the same Git reader and JS summary."""
import json
import time

from board_runner import APP, MODULES
from obsolete_project import ObsoleteProject
from git_head import BaselineError, OutsideWorktree, ProjectHistory, SOURCE_EXTENSIONS, TIMEOUT, query

MODULES.setdefault("project-history-summary", (APP / "history/project-history-summary.js", ("diff",), False))
MODULES.setdefault("history-catalogue", (APP / "library/parts.js", ("model",), False))
MODULES.setdefault("history-assemble", (APP / "workers/import-worker-client.js", ("import-formats", "history-catalogue"), False))
MODULES.setdefault("history-source", (APP / "history/project-history-source.js", ("history-assemble", "project-history-summary", "obsolete-project"), False))
LIMIT = 20


def detect(path):
    try:
        return ProjectHistory(path, need_head=False, source=True)
    except OutsideWorktree:
        return None


def repository_info(path):
    try:
        history = detect(path)
        return {"repository": history is not None, "head": history.head if history else None}
    except (BaselineError, OSError):
        # Project inspection remains available on machines without the Git executable.
        return {"repository": None, "head": None}


def summary(server, parent, revision, before, after):
    # The engine and options are fixed for the lifetime of this server. The ordered keys also
    # distinguish a missing file from an unreadable blob and the two sides of a revert.
    key = (before, after) if before != after else ("unchanged",)
    cache = server.history_cache
    if key in cache:
        cache.move_to_end(key)
        return cache[key]


    def read(rev, blob):
        if blob is None or before == after:
            return b""
        item = query(server.path, "sourceRevision", {"revision": rev})
        if item["blob"] != blob:
            raise ValueError("Git returned a different project blob. Refresh project history.")
        return json.dumps(item, separators=(",", ":")).encode("utf-8")

    timeout, memory = server.automation.limits("diff_designs")
    result = server.automation.runner().call("AtriumProjectHistoryReport", ("history-source" if before != after else "project-history-summary",),
        {"before": before, "after": after, "same": before == after, "sources": True}, read(parent, before), read(revision, after),
        timeout=timeout, retry=True, memory=memory)
    value = json.loads(result)
    cache[key] = value
    if len(cache) > 80:
        cache.popitem(last=False)
    return value


def project_history(server, args):
    offset, limit = args.get("offset", 0), args.get("limit", 5)
    if type(offset) is not int or not 0 <= offset <= 1000000 or type(limit) is not int or not 1 <= limit <= LIMIT:
        raise ValueError("Choose a history offset and a page size from 1 to 20.")
    if "snapshot" in args and not isinstance(args["snapshot"], str):
        raise ValueError("Use the history snapshot returned by the preceding page.")
    if server.folder:
        with server.folder_files.snapshot() as (read, _):
            server.folder.start(read)
            history = detect(server.path)
    else:
        history = detect(server.path)
    return history_page(server, history, args, offset, limit)


def folder_summary(server, history, parent, revision):
    history.until = time.monotonic() + TIMEOUT
    def snapshot(rev):
        if rev is None:
            return None, None, None
        saved = history.folder_snapshot(rev)
        identity = saved.identity()
        if identity is None:
            return None, None, None
        cache = server.history_cache
        marker = ("folder-project", identity)
        if marker in cache:
            cache.move_to_end(marker)
            return identity, *cache[marker]
        meta, body = server.folder.historical(saved, history.folder_objects)
        value = (meta["source_sha256"], body)
        cache[marker] = value
        while len([key for key in cache if key[0] == "folder-project"]) > 3:
            cache.pop(next(key for key in cache if key[0] == "folder-project"))
        return identity, *value

    before, left_version, left = snapshot(parent)
    after, right_version, right = snapshot(revision)
    key = ("folder-summary", left_version, right_version)
    cache = server.history_cache
    if key not in cache:
        timeout, memory = server.automation.limits("diff_designs")
        result = server.automation.runner().call("AtriumProjectHistoryReport", ("project-history-summary",),
            {"before": left_version, "after": right_version, "same": left_version == right_version, "nativeFolder": True},
            left or b"", right or b"", timeout=timeout, retry=True, memory=memory)
        cache[key] = json.loads(result)
        if len(cache) > 80:
            cache.popitem(last=False)
    else:
        cache.move_to_end(key)
    return before, after, left_version, right_version, cache[key]


def history_page(server, history, args, offset, limit):
    if history is None:
        return {"repository": False, "commits": [], "next_offset": None}
    page = history.project_log({"skip": offset, "limit": limit, **({"snapshot": args["snapshot"]} if "snapshot" in args else {})})
    blobs, rows = {}, []
    for c in page["commits"]:
        revision, parent = c["revision"], next(iter(c["parents"]), None)
        text = {"subject": c["subject"], "author": c["author"]}
        row = {"revision": revision, "parents": c["parents"], "date": c["date"], "untrusted_design_text": text}
        try:
            if server.folder:
                before, after, left, right, result = folder_summary(server, history, parent, revision)
                row.update(before_file_revision=left, after_file_revision=right)
            else:
                missing = [rev for rev in (revision, parent) if rev and rev not in blobs]
                if missing:
                    blobs.update(query(server.path, "projectBlobs", {"revisions": missing})["blobs"])
                before, after = blobs.get(parent), blobs[revision]
                result = summary(server, parent, revision, before, after)
            row.update(before_blob=before, after_blob=after, total=result["total"], counts=result["counts"])
            text.update(summary=result["text"], regions=result["regions"])
            if result.get("unavailableLibraries"):
                row["unavailable_libraries"] = result["unavailableLibraries"]
        except (ValueError, RuntimeError) as e:
            # A bad historical file cannot hide the surrounding, valid revisions.
            text["summary_error"] = str(e)
            if isinstance(e, ObsoleteProject):
                row["error_code"] = e.code
        rows.append(row)
    return {"repository": True, "head": page["head"], "snapshot": page["snapshot"],
            "commits": rows, "next_offset": offset + len(rows) if page["more"] else None,
            "untrusted_design_text": {"path": page["path"], "ref": page["ref"], "refs": page["refs"]}}
