"""Workspace-scoped AI test provider. Only these existing read tools are callable."""
from board_runner import APP
from automation import ToolError


MODULES = {
    "ai-provider-mcp": (APP / "automation/ai-provider-mcp.js", ("links",), False),
}
CAP = 16


def selected_read(automation, request, document):
    server = automation.server
    name, args = request["tool"], request["args"]
    if name == "inspect_component":
        result = server.call(name, args)
        if result.get("document") != document:
            raise ToolError("The component is outside the selected document.", "permission_denied")
        item = result.get("component", {})
        return [dict({key: item[key] for key in ("id", "kind", "ref", "value", "x", "y", "angle") if key in item},
                     document_id=document)]
    if name == "run_drc":
        result = server.call(name, {"document_id": document, "limit": CAP, "max_per_rule": CAP})
        return [{"document_id": document, **{key: row[key] for key in ("id", "rule", "actual", "required") if key in row}}
                for row in result.get("items", [])]
    if name == "run_erc":
        result = server.call(name, {"document_id": document, "limit": CAP})
        if result.get("complete") is False:
            raise ToolError("The electrical rule check was incomplete.", "incomplete")
        groups = result.get("classes", {})
        rows = [{"document_id": document, "class": category, "rule": row.get("check"), "object_id": row.get("object_id")}
                for category, group in groups.items() for row in group.get("items", [])]
        return {"rows": rows[:CAP], "total": sum(group["total"] for group in groups.values())}
    if name == "compare_revisions":
        result = server.call("run_command", {"command": name, "mode": "read",
                                             "args": {**args, "format": "summary"}})
        return [{"kind": "revision-comparison", **{key: result[key] for key in ("identical",) if key in result}}]
    if name == "list_library":
        result = server.call(name, {**args, "limit": CAP})
        return [{key: row[key] for key in ("id", "name", "footprint") if key in row}
                for row in result.get("items", [])]
    if name == "project_history":
        result = server.call(name, {"limit": CAP})
        return [{"kind": "revision", "id": row.get("revision")}
                for row in result.get("commits", [])][:CAP]
    raise ToolError("This tool is unavailable for AI requests.", "permission_denied")


def invoke(automation, local_id, args, mode, run):
    if local_id == "providers":
        return run(native={"stub": True})
    if local_id != "ask" or mode != "write":
        return run()
    receipt = run(native={"stub": True, "stage": "consent"})
    consent = receipt.get("untrusted_design_text", {})
    if consent.get("status") != "consent":
        raise ToolError("No current AI read grant was obtained.", "permission_denied")
    revision = automation.server.digest
    request, document = consent["tool"], args["documentId"]
    failure = False
    try:
        rows = selected_read(automation, request, document) if request and request["tool"] not in (
            "query", "evaluate_calculation") else []
    except (LookupError, ToolError, ValueError):
        rows, failure = [], True
    if automation.server.digest != revision:
        raise ToolError("The saved project changed during the AI read.", "stale_source")
    version = (APP / "VERSION").read_text(encoding="utf-8").strip()
    return run(native={"stub": True, "documentId": document, "revision": consent["revision"], "version": version,
                       "read": request, "rows": rows, "failed": failure})
