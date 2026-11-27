#!/usr/bin/env python3
"""Inventory of UI element families: where the library implementation is used and where a feature
still builds its own (docs/ui-library.md, docs/ui-inventory.md).

    python3 scripts/ui-inventory.py            # print the Markdown inventory
    python3 scripts/ui-inventory.py --write    # rewrite docs/ui-inventory.md
    python3 scripts/ui-inventory.py --json     # machine-readable counts

For each family it counts
  library  files whose JS or markup use the library class or builder;
  ad hoc   feature classes that style the same kind of element, with the files that define them.
Ad hoc classes are found by name (for example *-chip, *-badge, *-empty), so the list is a census of
candidates, not proof that each one looks different. scripts/css-audit.py covers tokens.
"""
import json
import os
import re
import sys

from asset_files import APP_TOOLKIT_SOURCES, app_source_files

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
SKIP = {"worker-source.js", "engine-core.js", "engine-mvp.js", "engine-simd128.js"}
# The library itself: not counted as a site that uses it.
LIBRARY = {"app/ui/kit.js", "app/ui/gallery.js", "app/ui/gallery.css", "app/ui/components.css", "app/ui/controls.css"}

# family: (title, library implementation, library class/API patterns, ad hoc class pattern)
FAMILIES = [
    ("button", "Buttons (primary, secondary, quiet, danger)", "`.ui-button[data-variant]`, `AtriumUI.button`, `AtriumUIKit.button`",
     r"ui-button|AtriumUI\??\.button|actionButton\(", r"[a-z0-9]+-(?:btn|primary|secondary|action-button)"),
    ("icon-button", "Icon buttons", "`.ui-icon-button`, `AtriumUIKit.iconButton`", r"ui-icon-button|\.iconButton\(",
     r"(?:icon-button|tool|[a-z0-9]+-(?:icon-btn|tool|icon-button))"),
    ("close", "Close buttons", "`.ui-close`, `AtriumUIKit.closeButton`", r"ui-close|closeButton\(", r"[a-z0-9-]+-close"),
    ("field", "Text and number fields with units", "`.ui-field`, `.ui-field-measure`, `.ui-field-unit`", r"ui-field", r"[a-z0-9]+-(?:input|field|unit)"),
    ("select", "Selects", "every native single-line `<select>`; `ui/dialog.js` routes it to `AtriumSelectPopup`", r"AtriumSelectPopup|ui-select-list|[\"']select[\"']|<select", r"[a-z0-9]+-select"),
    ("switch", "Switches", "`label.ui-switch-row > input.ui-switch[role=switch]`", r"ui-switch", r"[a-z0-9]+-(?:switch|toggle)"),
    ("checkbox", "Checkboxes", "`.ui-checkbox`, `.ui-checkbox-row`", r"ui-checkbox", r"[a-z0-9]+-(?:check|checkbox)"),
    ("radio", "Radio buttons", "`.ui-radio`, `.ui-radio-row`, `.ui-radio-group`", r"ui-radio", r"[a-z0-9]+-radio"),
    ("segmented", "Segmented controls", "`.ui-segmented > .ui-segment`", r"ui-segment", r"[a-z0-9]+-(?:segment|seg|mode-switch)"),
    ("tabs", "Tabs", "`.ui-tabs > .ui-tab`", r"ui-tab\b", r"[a-z0-9]+-tabs?"),
    ("chip", "Chips and tags", "`.ui-chip`, `.ui-chips`, `AtriumUIKit.chip`", r"ui-chip", r"[a-z0-9]+-(?:chip|tag|pill)s?"),
    ("badge", "Badges, counts and dots", "`.ui-badge`, `.ui-count`, `.ui-dot`", r"ui-(?:badge|count|dot)\b", r"[a-z0-9]+-(?:badge|count|dot)"),
    ("search", "Search fields", "`.ui-search`, `AtriumUIKit.search`", r"ui-search", r"[a-z0-9]+-search(?:-box|-wrap)?"),
    ("row", "List rows and tree rows", "`.ui-row`, `.ui-tree-row`, `.ui-list`", r"ui-(?:row|tree-row|list)\b", r"[a-z0-9]+-(?:row|item|entry|twisty)"),
    ("table", "Tables and grids", "`.ui-table`; editable grids `ui/spreadsheet.css`", r"ui-table|ui-sheet-grid|AtriumWindowedTable", r"[a-z0-9]+-(?:table|grid)"),
    ("toolbar", "Toolbars", "`.ui-toolbar`, `.ui-toolbar-sep`", r"ui-toolbar", r"[a-z0-9]+-(?:toolbar|bar)"),
    ("menu", "Menus and context menus", "`AtriumContextMenu` (`.nav-menu`), menu bar `.menu-items`", r"AtriumContextMenu|actionMenu\(|nav-menu", r"[a-z0-9]+-menu"),
    ("popover", "Popovers and hover cards", "`.ui-popover`; tooltips and hover cards `AtriumTooltip`", r"ui-popover|AtriumTooltip|data-tooltip", r"[a-z0-9]+-(?:pop|popover|card|peek)"),
    ("dialog", "Dialogs and sheets", "`AtriumShell.dialog`, `adoptDialog`, `openDialog`", r"AtriumShell\??\.(?:dialog|adoptDialog|openDialog)|ui-dialog", r"[a-z0-9]+-dialog"),
    ("toast", "Toasts and status lines", "`AtriumToast.show`; `.ui-status-line`; `.ui-dialog-status`", r"AtriumToast|\.toast\(|ui-status-line|ui-dialog-status", r"[a-z0-9]+-(?:toast|status)"),
    ("notice", "Notices and banners", "`.ui-notice[data-tone]`", r"ui-notice", r"[a-z0-9]+-(?:notice|banner|alert|warning)"),
    ("empty", "Empty states", "`.ui-empty`, `AtriumUIKit.empty` (module `*-empty` aliases in polish.css)", r"ui-empty|empty-state", r"[a-z0-9]+-empty"),
    ("progress", "Progress and spinners", "`.ui-progress`, `.ui-spinner`, `.ui-skeleton`", r"ui-(?:progress|spinner|skeleton)", r"[a-z0-9]+-(?:progress|meter|spinner|busy)"),
    ("keycap", "Keycaps", "`AtriumShortcut.render`", r"AtriumShortcut\.render|ui-shortcut", r"[a-z0-9]+-(?:kbd|keycap|keys)"),
    ("section", "Section headers", "`.ui-section-head`, `AtriumUIKit.section`", r"ui-section", r"[a-z0-9]+-(?:head|heading|section-title|group-title)"),
    ("prop-row", "Property rows", "`.ui-prop-row` (Properties included); `.ui-field-row`", r"ui-prop-row|field-row", r"[a-z0-9]+-(?:prop|kv|field-row|form-row)"),
    ("panel", "Splitters and panels", "`.ui-panel`, `.ui-splitter`; dock sashes `dock.css`", r"ui-(?:panel|splitter)|pane-heading", r"[a-z0-9]+-(?:sash|splitter|resizer|gutter|panel-head)"),
    ("drag", "Drag handles and drop targets", "`.ui-drag-handle`, `.ui-drop-target[data-drop]`, `ui/spatial-motion` lift", r"ui-(?:drag|drop)", r"[a-z0-9]+-(?:grip|handle|drop|dropzone)"),
]

CLASS_DEF = re.compile(r"\.([a-zA-Z][\w-]*)")


def files(pattern):
    return [p for p in app_source_files(APP, pattern, include_toolkit=True)
            if p.relative_to(APP).as_posix() not in SKIP]


def strip_css(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def selectors(css):
    """Yield (selector, body) for every rule, including those inside @media."""
    for m in re.finditer(r"([^{}@;]+)\{([^{}]*)\}", css):
        yield m.group(1).strip(), m.group(2)


def census():
    css = {os.path.relpath(p, ROOT): strip_css(open(p, encoding="utf-8").read()) for p in files("*.css")}
    js = {os.path.relpath(p, ROOT): open(p, encoding="utf-8").read() for p in files("*.js")}
    js["app/index.html"] = open(os.path.join(APP, "index.html"), encoding="utf-8").read()
    out = []
    for key, title, impl, lib, adhoc in FAMILIES:
        lib_re, adhoc_re = re.compile(lib), re.compile(r"^(?:" + adhoc + r")$")
        lib_files = sorted({f for f, t in {**css, **js}.items() if f not in LIBRARY and lib_re.search(t)})
        classes = {}
        for f, text in css.items():
            if f.removeprefix("app/") in APP_TOOLKIT_SOURCES:
                continue
            for sel, body in selectors(text):
                if not body.strip():
                    continue
                for c in CLASS_DEF.findall(sel):
                    if not c.startswith("ui-") and adhoc_re.match(c):
                        classes.setdefault(c, set()).add(f)
        out.append({"family": key, "title": title, "library": impl, "libraryFiles": lib_files,
                    "adhoc": {c: sorted(v) for c, v in sorted(classes.items())}})
    return out


def markdown(rows):
    lines = ["# UI inventory", "",
             "Generated by `python3 scripts/ui-inventory.py --write`; do not edit by hand. "
             "[UI library](ui-library.md) explains each family. "
             "\"Library sites\" counts files that use the shared implementation. "
             "\"Ad hoc classes\" lists feature classes, matched by name, that style the same kind of element in feature CSS. "
             "Many of them only place a library control. Some draw their own face and still need migration. "
             "[Still to migrate](ui-library.md#still-to-migrate) lists the known differences.", "",
             "| Family | Library implementation | Library sites | Ad hoc classes |", "| --- | --- | --- | --- |"]
    for r in rows:
        lines.append(f"| [{r['title']}](ui-library.md#{r['family']}) | {r['library']} | {len(r['libraryFiles'])} | {len(r['adhoc'])} |")
    lines.append("")
    for r in rows:
        lines += [f"## {r['title']}", "", f"Library: {r['library']}. Used in {len(r['libraryFiles'])} files.", ""]
        if r["adhoc"]:
            lines.append("| Ad hoc class | Defined in |")
            lines.append("| --- | --- |")
            for c, fs in r["adhoc"].items():
                lines.append(f"| `.{c}` | " + ", ".join(f"`{os.path.relpath(f, 'app') if f.startswith('app/') else f}`" for f in fs) + " |")
        else:
            lines.append("No ad hoc classes found.")
        lines.append("")
    return "\n".join(lines)


def main():
    rows = census()
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=1))
        return
    text = markdown(rows)
    if "--write" in sys.argv:
        with open(os.path.join(ROOT, "docs", "ui-inventory.md"), "w", encoding="utf-8") as f:
            f.write(text)
        print("ui-inventory: wrote docs/ui-inventory.md")
    else:
        print(text)


if __name__ == "__main__":
    main()
