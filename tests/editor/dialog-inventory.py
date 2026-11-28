#!/usr/bin/env python3
"""Check that app-owned dialog construction and shared factory use are inventoried."""
from collections import Counter
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "docs/dialog-inventory.md"
CONSTRUCTOR = re.compile(r"""(?<![\w$])(?:createElement|el|element|mk|node)\(\s*["']dialog["']""")
ROLE = re.compile(r"""setAttribute\(\s*["']role["']\s*,\s*["']dialog["']""")
STATIC = re.compile(r"^\s*(<dialog\b[^>]*>)", re.M)
SHELL = re.compile(r"""\b(?:AtriumShell|AtriumUI|Shell|S)\.dialog\(\s*\{""")
DOCK = re.compile(r"\bdialog\(\s*\{title:")
LIBRARY = re.compile(r"\b(?:ui|U)\.dialog\(")


PANEL_ELEMENT = re.compile(r"""\b(?:createElement|el|element|mk|node)\(\s*["']section["'](?:\s*,\s*null)?\s*,\s*["']([^"']+)["']""")
PANEL_HTML = re.compile(r"""<section\b[^>]*\bclass\s*=\s*["']([^"']+)["']""")
PANEL_CLASS = re.compile(r"""\.className\s*=\s*["']([^"']+)["']""")
PANEL_SPEC = re.compile(r"\{([^{}]+)\}")
DOCK_REGISTER = re.compile(r"\bAtriumDock(?:\?\.|\.)register(?:\?\.)?\(\s*(\{[^{}]+\}|[\w$]+)")


def location(source, kind, script, start, template=None):
    return {
        "source": source,
        "kind": kind,
        "line": script.count("\n", 0, start) + 1,
        "column": start - script.rfind("\n", 0, start),
        **({"template": template} if template else {}),
    }


def panel_id(classes):
    tokens = classes.split()
    if "panel" not in tokens:
        return None
    return next((token.removeprefix("panel-") for token in tokens if re.fullmatch(r"panel-[a-z][a-z0-9-]*", token)), None)


def string_property(spec, name):
    # The value runs to its own closing quote: a selector may hold the other quote ('[data-dock="x"]').
    match = re.search(rf"""\b{name}\s*:\s*(["'])((?:(?!\1).)+)\1""", spec)
    return match[2] if match else None


def dock_registrations(source, script):
    for match in DOCK_REGISTER.finditer(script):
        start_line = script.rfind("\n", 0, match.start()) + 1
        if script[start_line:match.start()].lstrip().startswith(("//", "*", "/*")):
            continue
        spec = match[1]
        if not spec.startswith("{"):
            assignment = re.compile(rf"\b(?:const|let|var)\s+{re.escape(spec)}\s*=\s*\{{([^{{}}]+)\}}")
            candidates = list(assignment.finditer(script, 0, match.start()))
            spec = candidates[-1][1] if candidates else ""
        panel = string_property(spec, "id")
        if not panel:
            raise SystemExit(f"{source}:{location(source,'panel',script,match.start())['line']} Dock registration needs a literal ID for field coverage.")
        action = string_property(spec, "action")
        yield {"id": panel, "selector": f'[data-dock-panel="{panel}"]', "action": action,
               **location(source, "panel", script, match.start())}


def field_surfaces():
    """Collect the shipped Dock surface IDs, including panels adopted when first opened."""
    source = "app/editor/dock.js"
    dock = (ROOT / source).read_text()
    known = re.search(r"\bconst KNOWN\s*=\s*\[(.*?)\];", dock, re.S)
    if not known:
        raise SystemExit("Cannot read AtriumDock.KNOWN for field coverage.")
    panels = {}
    selectors = set()
    for spec in PANEL_SPEC.finditer(known[1]):
        panel, selector = (string_property(spec[1], prop) for prop in ("id", "match"))
        if not panel or not selector or panel in panels or selector in selectors:
            raise SystemExit(f"A Dock panel needs a unique ID and selector for field coverage: {spec[0]}")
        selectors.add(selector)
        panels[panel] = {"id": panel, "selector": selector, "action": string_property(spec[1], "action"),
                         **location(source, "panel", dock, known.start(1) + spec.start())}
    if not panels:
        raise SystemExit("AtriumDock.KNOWN has no panels to exercise.")
    for file in sorted((ROOT / "app").rglob("*")):
        if file.suffix not in {".js", ".html"} or file.name.endswith("worker-source.js") or "vendor" in file.parts:
            continue
        source = file.relative_to(ROOT).as_posix()
        script = file.read_text()
        patterns = [PANEL_HTML] if file.suffix == ".html" else [PANEL_ELEMENT, PANEL_CLASS]
        for pattern in patterns:
            for match in pattern.finditer(script):
                panel = panel_id(match[1])
                if panel is None or panel in panels or f".panel-{panel}" in selectors:
                    continue
                selector = f".panel-{panel}"
                selectors.add(selector)
                panels[panel] = {"id": panel, "selector": selector, "action": None,
                                 **location(source, "panel", script, match.start())}
        if file.suffix == ".js":
            for registration in dock_registrations(source, script):
                previous = panels.get(registration["id"])
                if previous is None:
                    panels[registration["id"]] = registration
                elif registration["action"] and not previous["action"]:
                    previous["action"] = registration["action"]
    return sorted(panels.values(), key=lambda spec: spec["id"])


def main():
    if sys.argv[1:] == ["--field-surfaces"]:
        print(json.dumps(field_surfaces(), ensure_ascii=False))
        return
    documented = Counter()
    rows = []
    for source, kind, sites, name in re.findall(r"^\| (app/\S+) \| (\w+) \| (\d+) \| (.*?) \|$", INVENTORY.read_text(), re.M):
        mode = kind if kind in {"popover", "shell", "library"} else "element"
        documented[source, mode] += int(sites)
        rows.append({"source": source, "kind": kind, "count": int(sites), "name": name})

    found = Counter()
    locations = []
    missing = []
    for file in sorted((ROOT / "app").rglob("*")):
        if file.suffix not in {".js", ".html"} or file.name.endswith("worker-source.js"):
            continue
        source = file.relative_to(ROOT).as_posix()
        script = file.read_text()
        if file.suffix == ".html":
            declarations = list(STATIC.finditer(script))
            if declarations:
                found[source, "element"] = len(declarations)
            for match in declarations:
                declaration = match.group(1)
                template = re.search(r'\bid="([^"]+)"', declaration)
                locations.append(location(source, "element", script, match.start(1), template[1] if template else None))
                if not re.search(r'\bclass="[^"]*\bui-dialog\b', declaration):
                    missing.append(f"{source} is missing shared dialog styling in {declaration.strip()}.")
            continue
        shell = DOCK if source == "app/editor/dock.js" else SHELL
        for kind, pattern in (("element", CONSTRUCTOR), ("popover", ROLE), ("shell", shell), ("library", LIBRARY)):
            matches = list(pattern.finditer(script))
            if matches:
                found[source, kind] = len(matches)
                locations.extend(location(source, kind, script, match.start()) for match in matches)
                shared = {"element": r"ui-dialog|adoptDialog|AtriumShell\.dialog|Atrium(?:Shell|UI)\.openDialog",
                          "popover": r"ui-popover",
                          "shell": r"\bdialog\(" if source == "app/editor/dock.js" else r"\.dialog\(",
                          "library": r"\.show\("}
                if not re.search(shared[kind], script):
                    missing.append(f"{source} is missing shared {kind} styling or construction.")
    for key in sorted(documented.keys() | found.keys()):
        if documented[key] != found[key]:
            source, kind = key
            missing.append(f"{source} has {found[key]} {kind} sites and {documented[key]} documented.")
    by_line = Counter((site["source"], site["kind"], site["line"]) for site in locations if not site.get("template"))
    for (source, kind, line), count in sorted(by_line.items()):
        if count > 1:
            missing.append(f"{source}:{line} has {count} {kind} sites. Use distinct lines so browser coverage can distinguish them.")
    if missing:
        raise SystemExit("\n".join(missing))
    if sys.argv[1:] == ["--json"]:
        print(json.dumps({"rows": rows, "sites": locations}, ensure_ascii=False))
        return
    totals = Counter()
    for (_, kind), sites in found.items():
        totals[kind] += sites
    print(", ".join(f"{sites} {kind}" for kind, sites in sorted(totals.items())) + " dialog sites inventoried")


if __name__ == "__main__":
    main()
