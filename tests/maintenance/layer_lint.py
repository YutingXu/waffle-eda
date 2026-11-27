"""Layer and resize-handle guard (docs/design-system.md › Layers). Called from css-tokens.py.

Fails when
  1. a z-index is a number above 9. Numbers only order neighbours inside one layer; the page's layers
     are the --z-* tokens (sticky, float, toast, popover, alert, top).
  2. --z-top or --z-alert is used outside the named app-wide surfaces below. Anything that belongs to
     one element (a thumb, ghost, hint, readout) joins its owner's layer (ui/owner-layer.js) instead.
  3. a selector gives an element a resize cursor without being one of the shared resize handles in
     ui/components.css (they all light the same way), or a handle sets its own hover background.
  4. a known element-owned decoration (thumb, ghost, hint, readout, flash, note editor) is placed
     without ui/owner-layer.js.
"""
import re
from pathlib import Path

import css_style_lint

# App-wide surfaces that may sit above everything else (tooltips, drag feedback, the switcher, the
# Windows caption controls) or at the alert level (Preferences, the recovery warning, full-window views).
TOP_SURFACES = {".dock-ghost", ".vsk-switch", ".window-controls", ".window-resize-edge", ".ui-tooltip"}
ALERT_SURFACES = {".recover-warning", ":is(.ui-fullwindow)", ".prf-dialog", ".prefs-sheet"}
# Resize cursors that are not panel or column handles: the window edge, the compare swipe handle (it draws
# its own grip) and the constraint grip (a drawn bar).
RESIZE_EXEMPT = {".window-resize-edge", ".dv-handle", ".cm-grip"}
# Element-owned decorations: the module, the class it creates and the variable that holds the node.
DECORATIONS = [("schematic/naming.js", "nm-ghost", "ghost"), ("pcb/pin-swap.js", "ui-popover pin-swap-hint", "chip"),
               ("pcb/timing-vision.js", "timing-hud", "hud"), ("schematic/connection-preview.js", "sheet-connection-flash", "node"),
               ("notebook/rich-text-editor.js", "rn-editor", r"s\.(?:root|tools|list)"), ("ui/overlay-scroll.js", "ui-scroll-thumb", "t")]
RESIZE_CURSOR = re.compile(r"\b(?:col|row|ew|ns)-resize\b")
HANDLES_RULE = re.compile(r":is\(([^)]*\.ui-splitter[^)]*)\):is\(:hover")


def classes(selector):
    return set(re.findall(r"\.[\w-]+", selector))


def handles(app):
    text = (app / "ui/components.css").read_text(encoding="utf8")
    match = HANDLES_RULE.search(text)
    return {part.strip() for part in match[1].split(",")} if match else set()


def css_files(app):
    for file in sorted(app.rglob("*.css")):
        rel = file.relative_to(app).as_posix()
        if rel.startswith(("vendor/", "extensions/packages/")):
            continue
        yield rel, file.read_text(encoding="utf8")


def check(root, app):
    problems = []
    shared = handles(app)
    if not shared:
        problems.append("ui/components.css: the shared resize-handle rule (:is(.ui-splitter,…):is(:hover,…)) is missing")
    shared_classes = set().union(*(classes(h) for h in shared)) if shared else set()
    for rel, text in css_files(app):
        for decl in css_style_lint.declarations(text):
            selector = next((b for b in reversed(decl.context) if not b.startswith("@")), "")
            where = f"app/{rel}:{decl.line} {selector[:70]}"
            value = decl.value.replace("!important", "").strip()
            if decl.prop == "z-index":
                if re.fullmatch(r"-?\d+", value) and int(value) > 9:
                    problems.append(f"{where}: z-index {value}: use a --z-* layer token (numbers above 9 are not layers)")
                for token, allowed in (("--z-top", TOP_SURFACES), ("--z-alert", ALERT_SURFACES)):
                    if f"var({token})" in value:
                        parts = [p.strip() for p in selector.split(",")]
                        if not all(any(p == s or p.startswith(s) or s in classes(p) for s in allowed) for p in parts):
                            problems.append(f"{where}: {token} is for app-wide surfaces only; join the owner's layer (ui/owner-layer.js) or use --z-float/--z-popover")
            if decl.prop == "cursor" and RESIZE_CURSOR.search(value):
                own = classes(selector)
                # A modifier of a shared handle (.dock-sash-left on a .dock-sash) is that handle.
                if not any(o == c or o.startswith(c + "-") for o in own for c in shared_classes | RESIZE_EXEMPT):
                    problems.append(f"{where}: a resize handle must be one of the shared handles in ui/components.css")
            if decl.prop in ("background", "background-color", "box-shadow", "opacity", "outline", "outline-color", "border-color") and rel != "ui/components.css" and ":hover" in selector:
                if classes(selector) & (shared_classes - {".ui-splitter"}):
                    problems.append(f"{where}: resize handles light through the shared rule in ui/components.css, not a local hover")
    # Element-owned decorations (a class drawn over one element) are placed through the owner layer and
    # never appended to the body (or a document's body) themselves.
    for rel, name, var in DECORATIONS:
        file = app / rel
        if not file.is_file() or f'"{name}"' not in (source := file.read_text(encoding="utf8")):
            continue
        if "AtriumLayer" not in source:
            problems.append(f"app/{rel}: {name} must join its owner's layer through AtriumLayer")
        if re.search(r"\b(?:document|doc|D)\.body\.(?:append|appendChild|prepend)\([^)]*\b" + var + r"\b", source):
            problems.append(f"app/{rel}: {name} is appended to the body; attach it to its owner's layer (ui/owner-layer.js)")
    return problems


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        app = Path(tmp) / "app"
        (app / "ui").mkdir(parents=True)
        (app / "ui/components.css").write_text(":is(.ui-splitter,.good-sash):is(:hover,.is-dragging) {background-color:var(--focus)}\n")
        (app / "a.css").write_text(
            ".x {z-index:40}\n.y {z-index:5}\n.thumb {z-index:var(--z-top)}\n.dock-ghost {z-index:var(--z-top)}\n"
            ".grip {cursor:col-resize}\n.good-sash {cursor:ew-resize}\n.good-sash:hover {background:red}\n")
        found = "\n".join(check(Path(tmp), app))
        for expected in ("z-index 40", ".thumb", "--z-top is for", ".grip", "not a local hover"):
            assert expected in found, (expected, found)
        for unexpected in ("z-index 5", ".dock-ghost {", "a.css:6"):
            assert unexpected not in found, (unexpected, found)
