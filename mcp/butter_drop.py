"""Traditional interop command modules for the scoped Butter MCP broker."""
from board_runner import APP

MODULES = {
    "drop-receiver": (APP / "project/drop-receiver.js", (), False),
    "drop-data": (APP / "project/drop-data.js", (), False),
    "step-io": (APP / "formats/io.js", (), False),
}

def invoke(automation, local_id, args, mode, run):
    from automation import ToolError

    if local_id == "open-design":
        paths = args.get("files")
        if not paths:
            name = automation.server.path.name
            return run(native={"opened": {"kind": "workspace", "name": name}})
        from board_runner import translator_table
        accepted = tuple(dict.fromkeys(extension for desc in translator_table()
                         if desc["import"] and (desc.get("group") == "design" or desc["id"] == "waffle-library")
                         for extension in desc["extensions"]))
        if any(not path.lower().endswith(accepted) for path in paths):
            raise ToolError("Choose supported foreign inputs inside the workspace or bind the native project itself.", "invalid_arguments")
        receipt = automation.tool_import_design({"paths": paths, "mode": "preview", "time_limit_s": 30})
        return run(native={"opened": {"kind": "preview", "report": receipt["report"]}})

    choices = {"attach-model": ((".step", ".stp"), 32 << 20), "import-table": ((".csv",), 65536)}
    if local_id not in choices:
        return run()
    if automation.server.foreign_source:
        raise ToolError("Open an editable Waffle workspace before dropping a file.", "read_only")
    extensions, limit = choices[local_id]
    try:
        selected, size = automation.translation_input(args["file"], extensions, limit)
    except (OSError, ValueError) as error:
        raise ToolError("The selected drop file could not be read inside this workspace.", "ungranted_source") from error
    if not size:
        raise ToolError("The selected drop file is empty.", "invalid_payload")
    return run(native={"file": {"name": selected["name"], "data": selected["data"]}})
