"""Load the table model only for a numeric command addressed to a table cell."""

from board_runner import APP, _app

MODULES = {"table-data": _app("notebook/table-data", "source-file", optional=True)}


def invoke(_workspace, _command, args, _mode, run):
    target = args.get("target", {})
    path = target.get("path", [])
    cell = (target.get("scope") == "item" and len(path) == 4 and
            path[0] == "cells" and path[3] == "value" and
            all(isinstance(id, str) and 0 < len(id) <= 128 for id in path[1:3]))
    if cell and (APP / "notebook/table-data.js").is_file():
        return run(modules=("table-data",))
    return run()
