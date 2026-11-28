#!/usr/bin/env python3
"""UI library guard (docs/ui-library.md). Run: python3 -B tests/maintenance/ui-library-lint.py [--update]

Fails when feature code adds an ad hoc control instead of using the library in app/ui/:
  face      a feature stylesheet paints a control's face (background, border, radius or shadow on
            button, select, input, summary, [role=button] or a class named like a control: *-btn,
            *-button, *-close, *-chip, *-badge, *-pill, *-tag, *-toggle, *-switch, *-segment, *-tab);
  elevation a drop shadow that is not --elev-1/2/3 (inset rings and focus shadows are fine);
  cursor    cursor:pointer or grab/grabbing on anything except a link (a[href], role=link, *-link);
  select    a select opts out of AtriumSelectPopup ([data-native-select]) or a stylesheet restyles
            a select's appearance;
  listbox   a script builds its own option list or dropdown (role "listbox") outside ui/select-popup.js.
            The library contract passes: the listbox element is a .ui-list (with .ui-row options) or a
            .ui-select-list (with .ui-select-option rows), created within the three lines before the role;
  raw-css   a script assigns a face (background, border, borderRadius, boxShadow) through .style, or sets one
            with .style.setProperty. A data colour (a net, layer, theme or authored colour) sets the --swatch
            custom property instead, and the stylesheet paints var(--swatch) (docs/ui-library.md › Data colours).
  menu      a script or index.html marks a button as opening a menu (aria-haspopup "menu" or "true") but does not
            open it through the shared menu helpers, AtriumContextMenu.dropdown or AtriumNavCommon.actionMenu
            (or, in index.html, a menu bar summary, a submenu trigger, the Projects menu buttons or an
            Active Bar tool group). The helpers make every menu button toggle: a second press closes the menu
            and it stays closed, in WebKit too (tests/editor/browser-menu-toggle.js). MENU_OK lists the few
            surfaces with their own reviewed menu, with the reason;
  titlebar  a stylesheet pins a fixed surface to the top of the window (top, inset, inset-block or
            inset-block-start at 0, at a small length under the 28-32 px macOS caption, or at a
            var() that falls back to one) without the window safe area: --window-safe-top,
            --dialog-safe-top, --window-caption-height or the .ui-fullwindow library part. The
            macOS window controls sit there (docs/ui-library.md, Window safe area). The few surfaces
            that are fine are listed in TITLEBAR_OK below with the reason; the list cannot go stale.
            tests/editor/browser-titlebar-safe-area.cjs checks the same at runtime.
  hover     an app stylesheet changes a border on hover or gives hover feedback a duration other
            than --motion-instant, including transitions on the corresponding resting rule.
Each existing site is listed once in tests/maintenance/ui-library-legacy.json. A listed entry that no longer
matches fails too, so the list only shrinks: delete the entry when the site moves to the library.
Its "settled" map labels the entries the user kept as settled exceptions (docs/ui-library.md › Settled
faces); each label must name a listed entry.
--update rewrites the list from the current tree (only for a reviewed, deliberate exception).
"""
import json
import re
import runpy
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from css_style_lint import CSS_STRING, NUMBER, VAR_REF, declarations

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"
LEGACY = ROOT / "tests/maintenance/ui-library-legacy.json"
DATASHEET_BUNDLE = "app/datasheet-worker-source.js"
# The library itself, theme token blocks and generated or vendored sources.
LIBRARY = {"ui"}
SKIP_FILES = {"theme.css", "worker-source.js", "engine-core.js", "engine-mvp.js", "engine-simd128.js"}
CONTROL_CLASS = re.compile(r"\.[\w-]+-(?:btn|button|close|chip|badge|pill|tag|toggle|switch|segment|tab)s?(?![\w-])")
CONTROL_ELEMENT = re.compile(r"(?:^|[\s>+~(,])(?:button|select|summary|input(?:\[type=(?:button|submit|reset)\])?)(?![\w-])|\[role=button\]")
FACE = re.compile(r"^(?:background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-(?:color|style|width))?|border-radius|box-shadow)$")
# A face painted from a data colour: var(--swatch) or var(--swatch-<edge>), with an optional border width and style.
SWATCH = re.compile(r"^(?:[\d.]+px\s+solid\s+)?var\(--swatch(?:-[\w-]+)?(?:\s*,(?:[^()]|\([^()]*\))*)?\)(?:\s*!important)?$")
SCRIPT_FACE = re.compile(r"""\.style\.(background(?:Color)?|border(?:Color|Radius)?|boxShadow)\s*=(?!=)|\.style\.setProperty\(\s*["'](background|border|box-shadow)""")
INVISIBLE = re.compile(r"^(?:none|0|0px|transparent|inherit|initial|unset|revert|currentcolor|0 0 0 0 transparent)(?:\s*!important)?$", re.I)


def css_rules(text):
    """(selector, [(prop, value)], line) for every style rule, through @media and @supports blocks."""
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    out, stack, start, i = [], [], 0, 0
    while i < len(text):
        c = text[i]
        if c == "{":
            stack.append((text[start:i].strip(), text.count("\n", 0, i) + 1))
            start = i + 1
        elif c == "}":
            body = text[start:i]
            if stack:
                sel, line = stack.pop()
                if not sel.startswith("@") and ":" in body:
                    decls = []
                    for d in body.split(";"):
                        if ":" in d:
                            p, v = d.split(":", 1)
                            decls.append((p.strip().lower(), v.strip()))
                    if not re.search(r"\{", body):
                        out.append((sel, decls, line))
            start = i + 1
        elif c == ";" and not stack:
            start = i + 1
        i += 1
    return out


# Fixed surfaces at the top of the window that are fine, and why. (file, selector) -> reason.
# Menu buttons that open a menu of their own, reviewed: file -> reason.
MENU_OK = {
    "app/editor/palette-view.js": "the command palette's Actions button switches the palette's own list to its actions view (Mod+K) and back",
}
MENU_HELPERS = {"context-menu.js", "nav-common.js"}
MENU_ATTR = re.compile(r"""aria-haspopup["']?\s*(?:,|=)\s*["'](?:menu|true)["']""")
HTML_MENU_OK = re.compile(r"""^<summary\b|submenu-trigger|action-menu-button|data-project-menu|has-flyout""")


def menu_findings(rel, text, html=False):
    """Menu buttons that do not open through the shared helpers (see the menu rule above)."""
    if html:
        for m in re.finditer(r"<[a-z]+\b[^>]*>", text):
            tag = m.group(0)
            if MENU_ATTR.search(tag) and not HTML_MENU_OK.search(tag):
                yield tag[:80]
        return
    name = rel.rsplit("/", 1)[-1]
    if name in MENU_HELPERS or rel in MENU_OK:
        return
    helper = re.search(r"\.dropdown\(|\bactionMenu\(", text)
    for m in MENU_ATTR.finditer(text):
        line = text[text.rfind("\n", 0, m.start()) + 1:text.find("\n", m.end())]
        if helper or re.search(r"""["']menuitem["']|submenu-trigger""", line):
            continue
        yield "line " + str(text.count("\n", 0, m.start()) + 1)


TITLEBAR_OK = {
    ("app/ui/components.css", ":is(.ui-fullwindow)"): "the full-window library part; its .ui-fullwindow-bar takes the caption insets",
    ("app/formats/bom.css", ".bom-clip"): "an off-screen, transparent clipboard helper (left:-9999px)",
    ("app/history/history-artwork.css", ".history-art-stage"): "an off-screen, hidden render stage (left:-10000px)",
    ("app/project/view-config.css", ".vc-picker"): "a 1 px transparent anchor for the native colour picker",
    ("app/editor/dock.css", ".dock-ghost"): "drag feedback that a transform moves with the pointer",
    ("app/project/split-view.css", ".split-drop"): "a drop preview that script sizes and places over the target pane",
    ("app/style.css", ".window-controls"): "the window controls Waffle draws on Windows (native/windows/window-caption.js); the band is theirs",
    ("app/style.css", ".window-resize-edge"): "the top resizing edge Waffle draws on Windows; transparent, and hidden when maximised",
    ("app/pcb/board-shape.css", ".bsh-dialog[open]:not(:modal)"): "centred with margin:auto and at most 86vh tall, so it starts 7vh (35 px) down at the smallest window",
}
CAPTION_PX = 32
SAFE_TOP = re.compile(r"--(?:window-safe-top|dialog-safe-top|window-caption-height|macos-caption-height)\b")


def first_value(value):
    """The first space-separated value of a declaration, keeping parentheses together."""
    depth, out = 0, ""
    for c in value.replace("!important", "").strip():
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c.isspace() and depth == 0:
            break
        out += c
    return out


def pins_top(value):
    """True when a top edge sits at 0, at a length under the caption, or at a var() falling back to one."""
    v = first_value(value)
    if SAFE_TOP.search(value):
        return False
    m = re.fullmatch(r"var\(--[\w-]+,\s*(.+)\)", v)
    if m:
        return pins_top(m.group(1))
    m = re.fullmatch(r"(-?\d*\.?\d+)(px)?", v)
    return bool(m) and float(m.group(1)) < CAPTION_PX


def titlebar_findings():
    """(file, selector, declaration) for every fixed rule that pins a surface to the window top."""
    found = []
    for path in sorted(APP.rglob("*.css")):
        rel = str(path.relative_to(ROOT))
        if path.relative_to(APP).parts[0] == "vendor":
            continue
        for sel, decls, _ in css_rules(path.read_text(encoding="utf-8")):
            props = dict(decls)
            if not re.fullmatch(r"fixed(\s*!important)?", props.get("position", "")):
                continue
            for prop in ("top", "inset", "inset-block", "inset-block-start"):
                if prop in props and pins_top(props[prop]):
                    found.append((rel, " ".join(sel.split()), prop + ":" + props[prop]))
    return found


# The swatch shows an authored layer colour. Its edge provides hover feedback while the fill
# continues to show the exact colour the user is about to edit.
HOVER_OK = {("app/project/view-config.css", ".vc-swatch:hover", "border-color")}
HOVER = re.compile(r":hover(?![\w-])", re.I)
HOVER_BORDER = re.compile(r"border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?$")
HOVER_MOTION = re.compile(r"(?:-webkit-)?(?:transition|animation)(?:-(?:duration|delay))?$")
TIME = re.compile(rf"(?<![\w.-])({NUMBER})(?:ms|s)(?![\w-])", re.I)
SELECTOR_BOUNDARY = re.compile(rf"{CSS_STRING}|\\.|[(),\[\]>+~]|\s+")
HOVER_STATE = re.compile(r":hover(?![\w-])|:not\(:disabled\)")


def selector_targets(selector):
    """Yield each selector and its last compound, keeping selector functions and attributes together."""
    depth, start, target = 0, 0, 0
    for m in SELECTOR_BOUNDARY.finditer(selector):
        token = m[0]
        if token in ("(", "["):
            depth += 1
        elif token in (")", "]"):
            depth -= 1
        elif depth == 0 and token == ",":
            yield selector[start:m.start()], HOVER_STATE.sub("", selector[target:m.start()].strip())
            start = target = m.end()
        elif depth == 0 and (token in (">", "+", "~") or token.isspace()):
            if selector[m.end():].lstrip()[:1] not in ("", ","):
                target = m.end()
    yield selector[start:], HOVER_STATE.sub("", selector[target:].strip())


def instant_timing(value):
    return all(float(time) == 0 for time in TIME.findall(value)) and all(
        token in {"--motion-instant", "--motion-move", "--ease"} or token.startswith("--ease-")
        for token in VAR_REF.findall(value)
    )


def hover_findings(stylesheets):
    rules = [(path, d) for path, source in stylesheets for d in declarations(source)
             if d.context and not d.context[-1].startswith("@")]
    border_tokens = {token for _, d in rules if HOVER_BORDER.fullmatch(d.prop) for token in VAR_REF.findall(d.value)}
    targets = {target for _, d in rules for branch, target in selector_targets(d.context[-1]) if HOVER.search(branch)}
    for path, d in rules:
        selector = d.context[-1]
        hovered = HOVER.search(selector)
        if hovered and (HOVER_BORDER.fullmatch(d.prop) or d.prop in border_tokens):
            yield path, selector, d.prop, d.line, "keep the resting border colour"
        if HOVER_MOTION.fullmatch(d.prop) and not instant_timing(d.value):
            transition = d.prop.startswith(("transition", "-webkit-transition"))
            if hovered or (transition and any(target in targets for _, target in selector_targets(selector))):
                yield path, selector, d.prop, d.line, "use --motion-instant for hover"


def feature_css():
    for path in sorted(APP.rglob("*.css")):
        rel = path.relative_to(APP)
        if rel.parts[0] in LIBRARY or rel.parts[0] == "vendor" or path.name in SKIP_FILES:
            continue
        yield path


def feature_js():
    directories = ('', 'analysis', 'automation', 'canvas', 'checks', 'core', 'editor', 'extension-host', 'formats', 'history', 'library', 'native-bridge', 'notebook', 'pcb', 'project', 'schematic', 'workers')
    assets = runpy.run_path(str(ROOT / "scripts/prepare-assets.py"))["APP_ASSETS"]
    paths = [p for folder in directories for ext in ("js", "mjs") for p in (APP / folder).glob("*." + ext)]
    for path in sorted(paths + [APP / "index.html"]):
        # The datasheet worker's authored modules are in this scan; its bundle also embeds pinned vendor code.
        if str(path.relative_to(ROOT)) == DATASHEET_BUNDLE and DATASHEET_BUNDLE in assets:
            continue
        if path.name not in SKIP_FILES:
            yield path


def findings():
    found = []
    for path in feature_css():
        rel = str(path.relative_to(ROOT))
        for sel, decls, line in css_rules(path.read_text(encoding="utf-8")):
            if sel.startswith(":root") and all(p.startswith("--") for p, _ in decls):
                continue
            control = CONTROL_CLASS.search(sel) or CONTROL_ELEMENT.search(sel)
            for prop, value in decls:
                v = value.strip()
                if control and FACE.match(prop) and not INVISIBLE.match(v) and not SWATCH.match(v) and not prop.startswith("--"):
                    # Placement-only values: removing a face, or keeping a library variable.
                    found.append(("face", rel, sel, prop + ":" + v))
                if prop == "box-shadow" and not INVISIBLE.match(v) and "inset" not in v and "--elev-" not in v and "--focus" not in v \
                        and "--chrome-rule" not in v and "--sel-bar" not in v and not re.match(r"^0 0 0 ", v):
                    found.append(("elevation", rel, sel, prop + ":" + v))
                if prop == "cursor" and re.search(r"\b(pointer|grab|grabbing)\b", v) and not all(re.search(r"(?<![\w-])a\[href\]|link", part) for part in sel.split(",")):
                    found.append(("cursor", rel, sel, prop + ":" + v))
                if prop in ("appearance", "-webkit-appearance") and re.search(r"(?<![\w-])select(?![\w-])", sel):
                    found.append(("select", rel, sel, prop + ":" + v))
    for path in feature_js():
        rel = str(path.relative_to(ROOT))
        text = path.read_text(encoding="utf-8")
        for m in re.finditer(r"data-native-select|nativeSelect\b", text):
            found.append(("select", rel, "line " + str(text.count("\n", 0, m.start()) + 1), m.group(0)))
        for _ in home_made_listboxes(text, static_html=path.suffix == ".html"):
            found.append(("listbox", rel, "", "role listbox"))
        for what in script_faces(text):
            found.append(("raw-css", rel, "", what))
        for what in menu_findings(rel, text, html=path.suffix == ".html"):
            found.append(("menu", rel, "", what))
    return found


def script_faces(text):
    """The faces a script sets through .style: assigned (.style.background = …) or set (.style.setProperty("border-top", …)).
    Custom properties such as --swatch pass."""
    for m in SCRIPT_FACE.finditer(text):
        yield m.group(1) or "setProperty " + m.group(2)


LIBRARY_LIST = (("ui-list", "ui-row"), ("ui-select-list", "ui-select-option"))


def home_made_listboxes(text, *, static_html=False):
    """Offsets of "listbox" roles not built on the library list contract (docs/ui-library.md › Lists in lazy
    modules without eager bytes): a script names the library mount and builds its matching rows.
    Empty mounts in HTML may be wired to lazy renderers, but must have a role, name and stable ID."""
    static_mounts = set()
    lines = text.split("\n")
    if static_html:
        offsets = [0]
        for line in lines[:-1]:
            offsets.append(offsets[-1] + len(line) + 1)

        class MountParser(HTMLParser):
            def handle_starttag(self, tag, attrs):
                a = dict(attrs)
                classes = (a.get("class") or "").split()
                if a.get("role") != "listbox" or not a.get("id") or not (a.get("aria-label") or a.get("aria-labelledby")):
                    return
                if not any(box in classes for box, _ in LIBRARY_LIST):
                    return
                role = re.search(r"""(?<![\w-])role\s*=\s*(?P<value>["']listbox["'])""", self.get_starttag_text())
                if role:
                    line, column = self.getpos()
                    static_mounts.add(offsets[line - 1] + column + role.start("value"))

        MountParser().feed(text)
    for m in re.finditer(r"""["']listbox["']""", text):
        if m.start() in static_mounts:
            continue
        at = text.count("\n", 0, m.start())
        near = "\n".join(lines[max(0, at - 3):at + 1])
        if not any(re.search(r"(?<![\w-])" + box + r"(?![\w-])", near) and re.search(r"(?<![\w-])" + row + r"(?![\w-])", text)
                   for box, row in LIBRARY_LIST):
            yield m.start()


def self_test():
    """The listbox rule: the library contract passes, a home-made list fails."""
    cases = [
        ('const l = el("div", null, "ui-list sets", {role: "listbox"});\nrow = el("div", null, "ui-row", {role: "option"});', 0),
        ('const o = el("div", "ui-select-list hints");\no.dataset.completion = "";\no.id = "x";\no.setAttribute("role", "listbox");\nb.className = "ui-select-option";', 0),
        ('const l = el("div", null, "my-list"); l.setAttribute("role", "listbox");\nrow.className = "my-item";', 1),
        ('const l = el("div", null, "ui-list");\n\n\n\n\nl.setAttribute("role", "listbox");\nrow.className = "ui-row";', 1),
        ('const l = el("div", null, "ui-list"); l.setAttribute("role", "listbox");\nrow.className = "my-item";', 1),
    ]
    for text, want in cases:
        got = len(list(home_made_listboxes(text)))
        assert got == want, f"ui-library-lint self-test: {got} home-made listbox(es), expected {want}, in: {text!r}"
    valid = '<div class="ui-list" id="menu" role="listbox" aria-label="Menu"></div>'
    private = '<div class="other" id="private" role="listbox" aria-label="Custom"></div>'
    assert len(list(home_made_listboxes(valid, static_html=True))) == 0
    assert len(list(home_made_listboxes(valid + private, static_html=True))) == 1
    assert len(list(home_made_listboxes(valid.replace(' id="menu"', ''), static_html=True))) == 1
    assert len(list(home_made_listboxes('<script>const role = "listbox";</script>' + valid, static_html=True))) == 1
    # The swatch rule: a data colour through --swatch passes, any other face set from script fails.
    scripts = [('sw.style.setProperty("--swatch", net.colour);', 0), ('sw.style.background = net.colour;', 1),
               ('sw.style.backgroundColor = fill;', 1), ('sw.style.setProperty("background", fill);', 1),
               ('cell.style.setProperty("border-" + edge, "2px solid red");', 1), ('cell.style.setProperty("--swatch-" + edge, c);', 0),
               ('if (a.style.background === b) x();', 0)]
    for text, want in scripts:
        got = len(list(script_faces(text)))
        assert got == want, f"ui-library-lint self-test: {got} script face(s), expected {want}, in: {text!r}"
    for value, ok in [("var(--swatch)", True), ("var(--swatch,var(--panel))", True), ("2px solid var(--swatch-top)!important", True),
                      ("var(--accent)", False), ("linear-gradient(var(--swatch),red)", False)]:
        assert bool(SWATCH.match(value)) == ok, f"ui-library-lint self-test: swatch value {value!r}"
    # The menu rule: a menu button opens through the shared helpers.
    for text, want in [('b.setAttribute("aria-haspopup", "menu"); b.onclick = () => M.dropdown(b, entries);', 0),
                       ('b.setAttribute("aria-haspopup", "menu"); b.onclick = () => myMenu.open(b);', 1),
                       ('t.setAttribute("role", "menuitem"); t.setAttribute("aria-haspopup", "menu");', 0),
                       ('b.setAttribute("aria-haspopup", "dialog");', 0), ('C.actionMenu(b, commands);', 0)]:
        got = len(list(menu_findings("app/x.js", text)))
        assert got == want, f"ui-library-lint self-test: {got} menu finding(s), expected {want}, in: {text!r}"
    for text, want in [('<summary aria-haspopup="menu">File</summary>', 0), ('<button class="x" aria-haspopup="menu">', 1),
                       ('<button class="layer-menu-button action-menu-button" aria-haspopup="menu">', 0)]:
        got = len(list(menu_findings("app/index.html", text, html=True)))
        assert got == want, f"ui-library-lint self-test: {got} menu finding(s), expected {want}, in: {text!r}"
    # The titlebar rule: pinned to the top fails; below the caption, auto, centred or the token passes.
    for value, want in [("0", True), ("0px", True), ("4px 8px auto", True), ("var(--math-top, 0px) 0 auto", True), ("-9999px", True),
                        ("44px", False), ("auto", False), ("50%", False), ("var(--import-save-y,50dvh)", False),
                        ("var(--dialog-safe-top) var(--dialog-margin)", False), ("max(var(--math-top,0px),var(--window-caption-height)) 0", False)]:
        assert pins_top(value) == want, f"ui-library-lint self-test: pins_top({value!r}) is {not want}"
    hover_cases = [
        (".a:hover {border-inline-end-color:var(--accent)}", {"border-inline-end-color"}),
        (".a {border:1px solid var(--edge)} .a:hover {--edge:var(--line)}", {"--edge"}),
        (".a {transition:opacity var(--motion-fast)} .row:is(:hover,:focus-within) .a {opacity:1}", {"transition"}),
        (".a {transition-duration:140ms} .a:hover:not(:disabled) {background:var(--hover)}", {"transition-duration"}),
        (".a:hover {transition:color var(--motion-instant),opacity 1s}", {"transition"}),
        (".a:hover {animation:fade var(--motion-fast)}", {"animation"}),
        (".a:hover {transition:color var(--motion-instant);transition-delay:0s}", set()),
        (".a:focus-visible {border-color:var(--focus);transition:color var(--motion-fast)}", set()),
    ]
    for source, want in hover_cases:
        got = {prop for _, _, prop, _, _ in hover_findings([("app/example.css", source)])}
        assert got == want, f"ui-library-lint self-test: hover findings {got!r}, expected {want!r}, in: {source}"


def key(f):
    return " | ".join(f)


def main():
    self_test()
    if (ROOT / DATASHEET_BUNDLE).is_file() and subprocess.run(
        [sys.executable, "-B", str(ROOT / "scripts/bundle-datasheet.py"), "--check"]
    ).returncode:
        return 1
    found = findings()
    counts = {}
    for f in found:
        counts[key(f)] = counts.get(key(f), 0) + 1
    if "--update" in sys.argv:
        settled = json.loads(LEGACY.read_text(encoding="utf-8")).get("settled", {}) if LEGACY.exists() else {}
        LEGACY.write_text(json.dumps({"comment": "Existing ad hoc UI sites (tests/maintenance/ui-library-lint.py). Remove an entry when its site moves to the UI library (docs/ui-library.md); never add one without the user's approval.",
                                      "settled": {k: v for k, v in sorted(settled.items()) if k in counts},
                                      "sites": dict(sorted(counts.items()))}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"ui-library-lint: wrote {len(counts)} entries")
        return 0
    legacy = json.loads(LEGACY.read_text(encoding="utf-8"))["sites"] if LEGACY.exists() else {}
    problems = []
    for k in sorted(json.loads(LEGACY.read_text(encoding="utf-8")).get("settled", {}) if LEGACY.exists() else {}):
        if k not in legacy:
            problems.append(f"FAIL settled label names no allow-list entry (tests/maintenance/ui-library-legacy.json): {k}")
    for k, n in sorted(counts.items()):
        if n > legacy.get(k, 0):
            kind, rel, sel, what = k.split(" | ", 3)
            problems.append(f"FAIL {rel}: {kind}: {sel} {what} — use the UI library (docs/ui-library.md)")
    for k, n in sorted(legacy.items()):
        if counts.get(k, 0) < n:
            problems.append(f"FAIL stale allow-list entry (site moved or changed; lower or delete it in tests/maintenance/ui-library-legacy.json): {k}")
    pinned = titlebar_findings()
    for rel, sel, what in pinned:
        if (rel, sel) not in TITLEBAR_OK:
            problems.append(f"FAIL {rel}: titlebar: {sel} {what} — the macOS window controls sit there; start at var(--window-safe-top) "
                            "or use .ui-fullwindow (docs/ui-library.md, Window safe area)")
    for rel in MENU_OK:
        text = (ROOT / rel).read_text(encoding="utf-8") if (ROOT / rel).exists() else ""
        if not MENU_ATTR.search(text):
            problems.append(f"FAIL stale MENU_OK entry in tests/maintenance/ui-library-lint.py (the menu button moved or changed): {rel}")
    for rel, sel in sorted(set(TITLEBAR_OK) - {(r, s) for r, s, _ in pinned}):
        problems.append(f"FAIL stale TITLEBAR_OK entry in tests/maintenance/ui-library-lint.py (the rule moved or changed): {rel} {sel}")
    authored_css = ((path.relative_to(ROOT).as_posix(), path.read_text(encoding="utf-8"))
                    for path in sorted(APP.rglob("*.css")) if "vendor" not in path.relative_to(APP).parts)
    hover = set()
    for rel, sel, prop, line, why in hover_findings(authored_css):
        entry = (rel, sel, prop)
        hover.add(entry)
        if entry not in HOVER_OK:
            problems.append(f"FAIL {rel}:{line}: hover: {sel} {prop} — {why} (docs/ui-library.md)")
    for rel, sel, prop in sorted(HOVER_OK - hover):
        problems.append(f"FAIL stale HOVER_OK entry in tests/maintenance/ui-library-lint.py: {rel} {sel} {prop}")
    if problems:
        print("\n".join(problems))
        return 1
    print(f"ui-library-lint: ok ({sum(counts.values())} legacy sites allow-listed in {len(counts)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
