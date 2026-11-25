"""Read commit addresses from the repository of the selected design."""

from git_head import BaselineError, OutsideWorktree, query


def git_page(project_path, args):
    options = {"limit": 100, "skip": args.get("gitOffset", 0), "recordLinks": True}
    if "gitSnapshot" in args:
        options["snapshot"] = args["gitSnapshot"]
    try:
        page = query(project_path, "projectLog", options)
    except OutsideWorktree:
        return {"status": "not-repository"}
    except (BaselineError, OSError):
        return {"status": "unavailable"}
    return {"status": "ready", "more": page["more"], "snapshot": page["snapshot"],
            "commits": [{key: row[key] for key in ("revision", "subject", "recordLinks", "recordLinksTruncated") if key in row}
                        for row in page["commits"]]}
