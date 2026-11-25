"""Typed native Git adapter and lazy worker dependencies for Butter visual history."""
from board_runner import APP
from git_head import OutsideWorktree, ProjectHistory, query as git_query


def module(name, *requires):
    return APP / (name + ".js"), ("headless", *requires), False


MODULES = {
    "butter-history-undo": module("history/undo-store"),
    "butter-history-edits": module("history/history-edits"),
    "butter-history-list": module("history/history-panel", "butter-history-undo"),
    "butter-history-visual": module("history/visual-history"),
    "butter-history-nav": module("editor/nav-common", "model"),
    "butter-history-session": module("history/history-session", "butter-history-list", "butter-history-edits",
                                     "butter-history-visual", "butter-history-nav", "model", "proposal"),
    "butter-clipboard-selection": module("editor/selection-clipboard", "model"),
    "butter-clipboard-history": module("history/clip-history", "butter-clipboard-selection"),
    "butter-visual-history": (None, ("headless", "butter", "butter-history-session",
                               "edit-selection", "butter-clipboard-history"), False),
}


def invoke(automation, local_id, args, mode, run):
    server = automation.server
    if local_id == "git-list":
        try:
            history = ProjectHistory(server.path, need_head=False)
        except OutsideWorktree:
            return run(native={"commits": [], "more": False, "repository": False})
        options = {"limit": args.get("limit", 50), "skip": args.get("offset", 0)}
        if "snapshot" in args:
            options["snapshot"] = args["snapshot"]
        return run(native={**history.project_log(options), "repository": True})
    if local_id == "git-branch" and mode == "plan":
        return run()
    if local_id == "git-branch":
        if mode != "write" or not automation.allow_write or server.read_only or not server.folder or args["confirm"] is not True:
            raise ValueError("Confirm Git branch creation with write access to this native project.")
        allowed = {key: args[key] for key in ("name", "revision", "confirm")}
        return run(native=git_query(server.path, "createBranch", allowed))
    if local_id not in ("git-preview", "git-compare") or not server.folder:
        raise ValueError("Choose the bound native design with Git history.")
    history = ProjectHistory(server.path)
    snapshot = history.folder_snapshot(args["revision"])
    if not snapshot.exists:
        return run(native="null")
    _, data = server.folder.historical(snapshot, history.folder_objects)
    if data is None:
        raise ValueError("The design is unavailable at this commit.")
    return run(native=data.decode("utf-8") if isinstance(data, bytes) else data)
