#!/usr/bin/env python3
"""Inventory every menu and keyboard action in Waffle and its headless path.

Sources (no browser):
  - app/index.html          [data-action] buttons and named menu slots
  - first-party app/**/*.js AtriumNavCommon.menuItem(...) additions, registerAction(...)
                            handlers, dataset.action buttons, theme and preference items
                            and registerCommand / add({id: "...", title: "..."}) commands
  - app/editor/keymap.js           built-in keymap commands (BUILTIN), with their action
  - app/editor/editor.js           the act() and executeKey() switches
  - app/lazy.js             cold-start menu and command registration, replayed headlessly
Optionally --runtime FILE merges the action list of `scripts/click-through.sh --json`.

Each action is mapped by mcp/commands.py (COVERAGE) to one of:
  command      run_command{command: ...}, a DOM-free implementation (app/automation/commands-headless.js)
  tool         an existing MCP tool (possibly reached through run_command aliases)
  interactive  interactive-only, with the justification and the headless path that covers it

Usage:
  scripts/headless-inventory.py              write docs/headless-parity.md and docs/headless-parity.json
  scripts/headless-inventory.py --check      exit 1 when the docs are stale or an action is unmapped
  scripts/headless-inventory.py --json       print the inventory as JSON
"""
import argparse
import html
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import JavaScriptCore, load_jsc, safe_which  # noqa: E402
import commands as C  # noqa: E402  (mcp/commands.py)

DOC_MD = ROOT / "docs" / "headless-parity.md"
DOC_JSON = ROOT / "docs" / "headless-parity.json"
NON_EDITOR_DIRS = {"fab-presets", "locales", "node_modules", "vendor"}
EXTENSION_ASSETS = {("extensions", "bundled.js"), ("extensions", "manifests.js"), ("extensions", "packages")}
NON_EDITOR_SCRIPTS = {
    "command-catalog.js", "commands-headless.js", "legacy-command-contract.js", "engine-core.js", "engine-mvp.js", "engine-simd128.js",
    "extension-template.js", "getting-started-guide.js", "search-data.js", "translator-table.js",
    "translator-worker-modules.js", "worker-source.js",
}


def add(found, action, source, label=None, menu=None, command=None):
    row = found.setdefault(action, {"action": action, "labels": [], "menus": [], "sources": [], "commands": []})
    if label:
        label = html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
        if label and label not in row["labels"]:
            row["labels"].append(label)
    if menu and menu not in row["menus"]:
        row["menus"].append(menu)
    if source not in row["sources"]:
        row["sources"].append(source)
    if command and command not in row["commands"]:
        row["commands"].append(command)


def scan_html(found):
    text = (APP / "index.html").read_text(encoding="utf-8")
    menus = [(m.start(), m.group(1)) for m in re.finditer(r'data-menu="([\w-]+)"', text)]

    def menu_at(offset):
        return next((name for at, name in reversed(menus) if at < offset), None)

    for m in re.finditer(r'<button\b([^>]*)>(.*?)</button>', text, re.S):
        attrs = m.group(1)
        a = re.search(r'data-action="([^"]+)"', attrs)
        if not a or a.group(1) == "close-dialog":
            continue
        menu = None
        if re.search(r'role="menuitem(?:checkbox)?"', attrs):
            menu = menu_at(m.start())
        label = re.search(r'(?:aria-label|title)="([^"]+)"', attrs)
        add(found, a.group(1), "index.html", m.group(2) if menu else (label.group(1) if label else m.group(2)), menu or "toolbar")

    slots = []
    menubar = re.search(r'<nav class="menubar"[^>]*>(.*?)</nav>', text, re.S)
    if menubar:
        for m in re.finditer(r'<[\w-]+\b[^>]*\sdata-slot="([^"]+)"[^>]*>', menubar.group(1)):
            label = re.search(r'\sdata-label="([^"]+)"', m.group())
            slots.append((m.group(1), label.group(1) if label else None, menu_at(menubar.start(1) + m.start())))
    return slots


def scan_js(found):
    for path in sorted(APP.rglob("*.js")):
        relative = path.relative_to(APP)
        if any(part.startswith(".") or part in NON_EDITOR_DIRS for part in relative.parts[:-1]):
            continue
        if relative.parts[:2] in EXTENSION_ASSETS:
            continue
        if path.name in NON_EDITOR_SCRIPTS or path.name.endswith(("-worker.js", "-worker-source.js")):
            continue
        text = path.read_text(encoding="utf-8")
        name = relative.as_posix()
        for m in re.finditer(r'menuItem\??\.?\(\s*"([\w-]+)"\s*,\s*"([\w:-]+)"\s*,\s*"([^"]*)"', text):
            add(found, m.group(2), name + " menuItem", m.group(3), m.group(1))
        for m in re.finditer(r'registerAction\??\.?\(\s*"([\w:-]+)"', text):
            add(found, m.group(1), name + " registerAction")
        for m in re.finditer(r'(?:dataset\.action\s*=|elWithAttributes\(\s*"button"\s*,[^{}]*\{[^{}]*"data-action"\s*:)\s*"([\w-]+)"', text):
            add(found, m.group(1), name + " button")
        for m in re.finditer(r'(?:registerCommand\??\.?|\badd)\(\{\s*id\s*:\s*"([\w:.-]+)"\s*,\s*title\s*:\s*"([^"]+)"(?:\s*,\s*category\s*:\s*"(\w+)")?', text):
            add(found, m.group(1), name + " registerCommand", m.group(2), command=m.group(1))
        if name == "editor/theme.js":
            for m in re.finditer(r'^\s{4}(\w+):Object\.freeze\(\{id:"(\w+)",label:"([^"]+)"', text, re.M):
                add(found, "theme-" + m.group(2), name + " menu", "Theme: " + m.group(3), "view")
            for m in re.finditer(r'menuButton\("([\w-]+)",\s*"([^"]+)"', text):
                add(found, m.group(1), name + " menu", m.group(2), "view" if m.group(1).startswith("theme") else "file")
        if name == "editor/prefs.js":
            for m in re.finditer(r'\bitem\("([\w-]+)",\s*"([^"]+)"', text):
                add(found, m.group(1), name + " menu", m.group(2), "file")


_SHORTCUTS = None


def keymap_commands(fixture=None):
    """Command id, label, action, source, registration and default bindings from the live keymap."""
    global _SHORTCUTS
    if _SHORTCUTS is None:
        spec = importlib.util.spec_from_file_location("gen_shortcuts", ROOT / "scripts" / "gen-shortcuts.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _SHORTCUTS = module
    return _SHORTCUTS.command_rows(fixture)


def scan_keymap(found, fixture=None):
    for row in keymap_commands(fixture):
        if row.get("registration") == "extension":
            continue
        add(found, row["action"], row["source"], row["title"], command=row["id"])


def scan_editor(found):
    text = (APP / "editor/editor.js").read_text(encoding="utf-8")
    for start in ("function act(", "function executeKey("):
        at = text.find(start)
        if at < 0:
            continue
        end = text.find("\n  function ", at + len(start))
        for m in re.finditer(r'case "([\w-]+)"', text[at:end]):
            if m.group(1) != "close-dialog":
                add(found, m.group(1), "editor/editor.js " + start.split("(")[0][9:])


def scan_lazy(found):
    # Run the same cold-start hook as the browser. Capture just the registrations so the
    # inventory also sees computed rows and the editor actions behind module-prefixed IDs.
    path = APP / "lazy.js"
    script = """
        "use strict";
        let boot;
        const menus = [], commands = [];
        globalThis.document = {readyState: "loading", addEventListener(type, callback) {
            if (type === "DOMContentLoaded") boot = callback;
        }};
        globalThis.AtriumIdle = {idle() {}};
        globalThis.AtriumKeymap = {registerCommand: ({id, action, title}) => commands.push([id, action, title])};
        globalThis.AtriumNavCommon = {menuItem: (menu, action, label) => menus.push([menu, action, label])};
    """
    report = "JSON.stringify({menus, commands})"
    lib = load_jsc()
    if lib:
        js = JavaScriptCore(lib, ("rule-scope-demand",))
        try:
            js.evaluate(script)
            js.evaluate(path.read_text(encoding="utf-8"), str(path))
            raw = js.value_text(js.evaluate("boot(); " + report))
        finally:
            js.close()
    else:
        node = safe_which("node")
        if not node:
            sys.exit("Headless inventory requires JavaScriptCore or Node to read lazy registrations.")
        # Load the real module so its relative requires resolve from app/lazy.js.
        entry = script + f"require({json.dumps(str(path))}); boot(); process.stdout.write({report});"
        run = subprocess.run([node, "-"], input=entry, text=True,
                             encoding="utf-8", stdout=subprocess.PIPE, check=True, timeout=10)
        raw = run.stdout

    registrations = json.loads(raw)
    # Keep the existing static row descriptions for actions with concrete declarations.
    declared = set(found)
    for menu, action, label in registrations["menus"]:
        if action not in declared:
            add(found, action, "lazy.js menuItem", label, menu)
    for cid, action, title in registrations["commands"]:
        if action not in declared:
            add(found, action, "lazy.js registerCommand", title, command=cid)


def merge_runtime(found, files):
    for f in files:
        raw = Path(f).read_text(encoding="utf-8")
        data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        for r in data.get("results", []):
            if r["a"] != "close-dialog":
                add(found, r["a"], "runtime " + data.get("kind", ""))


def inventory(runtime=(), fixture=None):
    found = {}
    slots = scan_html(found)
    scan_js(found)
    scan_keymap(found, fixture)
    scan_editor(found)
    scan_lazy(found)
    for action, label, menu in slots:
        if action not in found:
            add(found, action, "index.html slot", label, menu)
    merge_runtime(found, runtime)
    rows = []
    for action in sorted(found):
        row = found[action]
        row.update(C.coverage(action))
        rows.append(row)
    return rows


def summary(rows):
    counts = {"total": len(rows), "headless": 0, "command": 0, "tool": 0, "interactive": 0, "missing": 0}
    for r in rows:
        counts[r["status"]] += 1
        if r["status"] in ("command", "tool"):
            counts["headless"] += 1
    return counts


def markdown(rows):
    s = summary(rows)
    out = ["# Headless parity", "",
           "Generated by `scripts/headless-inventory.py` from the menus (`app/index.html` buttons and slots, `menuItem` additions), keymap commands "
           "(`app/editor/keymap.js`, `registerCommand`), lazy registrations, `registerAction` handlers and the editor's `act` switch. "
           "Regenerate these files with the script. `tests/automation/headless-parity.py` fails when an action has no mapping.", "",
           "| Actions | Headless | via `run_command` | via another MCP tool | Interactive only | Missing |",
           "| ---: | ---: | ---: | ---: | ---: | ---: |",
           "| %d | %d | %d | %d | %d | %d |" % (s["total"], s["headless"], s["command"], s["tool"], s["interactive"], s["missing"]), "",
           "Headless paths run in the MCP server (`python3 mcp/server.py --project X.waffle`) and the CLI "
           "(`--cli run_command --args '{\"command\": \"align\", \"args\": {...}}'`). Editing commands finish as an `.waffle-ai` proposal, "
           "or write in place only with `--allow-write` and `\"mode\": \"write\"`. `\"mode\": \"plan\"` reports the change without writing anything. "
           "Generated files stay under `<project>-outputs/`.", "",
           "## run_command commands", "",
           "| Command | Kind | Arguments | Description |", "| --- | --- | --- | --- |"]
    for name, spec in C.COMMANDS.items():
        args = ", ".join(("**%s**" % k if k in spec.get("required", ()) else k) for k in spec["props"]) or "—"
        out.append("| `%s` | %s | %s | %s |" % (name, spec["kind"], args, spec["description"].replace("|", "\\|")))
    for name, tool in C.ALIASES.items():
        out.append("| `%s` | alias | arguments of `%s` | Runs the `%s` tool. |" % (name, tool, tool))
    out += ["", "## Actions", "", "| Action | Label | Where | Headless path |", "| --- | --- | --- | --- |"]
    for r in rows:
        where = ", ".join(r["menus"]) or ("keymap" if any(x.startswith("keymap") for x in r["sources"]) else r["sources"][0])
        if r["status"] == "command":
            path = "`run_command` `%s`" % r["target"]
        elif r["status"] == "tool":
            path = "`%s`" % r["target"]
        elif r["status"] == "interactive":
            path = "interactive only: " + r["reason"]
        else:
            path = "**missing**"
        label = (r["labels"][0] if r["labels"] else "").replace("|", "\\|")
        out.append("| `%s` | %s | %s | %s |" % (r["action"], label, where, path.replace("|", "\\|")))
    out += ["", "Extension commands (`extensions.js`) run extension code in its sandboxed host and are not listed. "
            "Commands registered under a module prefix (`library:`, `rooms:`, `multichannel:`) dispatch the actions listed above.", ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="Fail when the docs are stale or an action is unmapped.")
    ap.add_argument("--json", action="store_true", help="Print the inventory as JSON.")
    ap.add_argument("--runtime", action="append", default=[], help="click-through.sh --json output to merge.")
    o = ap.parse_args()
    rows = inventory(o.runtime)
    doc_json = json.dumps({"summary": summary(rows), "commands": sorted(C.COMMANDS), "aliases": C.ALIASES, "actions": rows}, indent=1, sort_keys=True) + "\n"
    doc_md = markdown(rows)
    if o.json:
        sys.stdout.write(doc_json)
        return 0
    missing = [r["action"] for r in rows if r["status"] == "missing"]
    if o.check:
        stale = [p.name for p, t in ((DOC_MD, doc_md), (DOC_JSON, doc_json)) if not p.is_file() or p.read_text(encoding="utf-8") != t]
        if missing:
            print("Unmapped actions: " + ", ".join(missing))
        if stale and not o.runtime:
            print("Stale: " + ", ".join(stale) + " (run scripts/headless-inventory.py)")
        print(json.dumps(summary(rows)))
        return 1 if missing or (stale and not o.runtime) else 0
    DOC_MD.parent.mkdir(exist_ok=True)
    DOC_MD.write_text(doc_md, encoding="utf-8")
    DOC_JSON.write_text(doc_json, encoding="utf-8")
    print(json.dumps(summary(rows)))
    if missing:
        print("Unmapped actions: " + ", ".join(missing))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
