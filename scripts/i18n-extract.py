#!/usr/bin/env python3
"""Extract Waffle's user-interface strings into app/locales/en.json, and check every locale.

English is the source. This script reads the shell's English text where it is written
(app/index.html, the keymap's command titles, the files and call patterns in SOURCES below,
and AtriumI18n.define({...}) tables in any app/*.js) and writes:

  app/locales/en.json        the English catalogue: "namespace.key": "English text"
  app/locales/en-XA.json     the pseudo-locale, generated from en.json (accents, ~35% longer, [brackets])
  app/locales/<id>.js        a loader per locale (the app loads scripts, not JSON, so it works from file://)
  app/editor/i18n-core.js           the AVAILABLE locale list between the "i18n-extract:" markers
  app/editor/i18n.js                REAL, the non-English locale ids the eager shim checks "System" against

Keys are "<namespace>.<slug of the English text>" for strings found in markup and literals
(app/editor/i18n-dom.js matches rendered text against them), "cmd.<id>[.<kind>|.short]" for command
titles, and the key as written for define() tables (used through t(key, params)).

Usage:
  scripts/i18n-extract.py               refresh command captions, the catalogue, locale list and loaders
  scripts/i18n-extract.py --assets      regenerate the lazy loaders and pseudo-locale only
  scripts/i18n-extract.py --check       exit 1 when en.json, en-XA.json, a loader or the locale list is out of
                                        date (a key is missing or unused), a define() key is never used, or a
                                        translation has a key English lacks or different {placeholders}
  scripts/i18n-extract.py --coverage [--json]   strings converted vs remaining, per module, and per locale
  scripts/i18n-extract.py --where TEXT|KEY      where a string comes from
"""
import glob
import html.parser
import json
import math
import os
import re
import sys
import zlib

from asset_files import app_source_files, app_source_name

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
LOCALES = os.path.join(APP, "locales")
PSEUDO = "en-XA"

# ---------------------------------------------------------------------------------------- sources
# Files whose string literals are UI text (mode "literals": every literal that looks like prose,
# see ui_like(); "a" + b concatenation fragments are counted as remaining instead), or call patterns
# whose first group is UI text. Add your module here, and its DOM root with AtriumI18n.scope().
STR = r'"((?:[^"\\\n]|\\.)*)"'
MENU_ITEM = r'menuItem\??\.?\(\s*(?:"[\w-]+"|\w+)\s*,\s*(?:"[\w-]+"|\w+)\s*,\s*' + STR
SOURCES = [
    # (glob, namespace, pattern, "literals" or "status-choices")
    ("app/editor/prefs.js", "prefs", "literals"),
    ("app/editor/prefs-controls.js", "prefs", r'(?:\bstatus\(|\bhost\?\.info\?\.\()\s*' + STR),
    ("app/editor/prefs-routing.js", "prefs", "literals"),
    ("app/editor/start-page.js", "start", "literals"),
    ("app/editor/welcome.js", "start", "literals"),
    ("app/project/templates.js", "start", "literals"),
    ("app/*.js", "menu", MENU_ITEM),
    ("app/lazy.js", "menu", r'\[\s*"[a-z]+"\s*,\s*"[\w-]+"\s*,\s*' + STR + r'\s*,\s*\{'),
    ("app/editor/nav-common.js", "shell", r'"nav-command-centre", ' + STR),
    ("app/editor/nav-common.js", "shell", r'cc\.append\(svg, el\("span", ' + STR + r'\)'),
    ("app/editor/editor.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/project/editor-files.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/formats/design-reader.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/pcb/rigid-flex.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    # The full-board pour and the drawing tool share this outline prerequisite.
    ("app/pcb/polygon-pour.js", "status", r'if \(!doc\.outline\?\.length\) \{ info\(\s*' + STR + r'\s*\)'),
    ("app/pcb/length-tuning.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/pcb/route-feel.js", "status", "status-choices"),
    # Length Manager and interactive pattern properties, including their accessible names.
    ("app/pcb/length-tuning.js", "tuning", r'(?:\b(?:field|labelled|button)\(|setAttribute\("aria-label", |\.title = |el\("(?:h2|button|span)", )' + STR),
    ("app/pcb/length-tuning.js", "tuning", r'(?:\b(?:accordion|trombone|sawtooth|mitered|arcs|rounded|label): |\["(?:1|2|target|tolerance|distance|amplitude|gap)", )' + STR),
    ("app/pcb/length-tuning.js", "tuning", r'button\(timed \? ' + STR + ' : ' + STR),
    ("app/editor/editor.js", "status", r'const overview=\(\)=>pcb\(\)\?' + STR + ':' + STR),
    ("app/editor/editor.js", "status", r'u\.textContent=' + STR),
    ("app/editor/workbench.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/editor/shell.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    # menus/i18n pass (2026-11-19): object context menus; status messages first so they land in "status".
    ("app/editor/context-menu.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/editor/context-menu.js", "menu", "literals"),
    # menus/i18n pass: HDI via setup, update check, extension developer mode (compat.js uses define() only).
    ("app/pcb/hdi.js", "hdi", "literals"),
    ("app/pcb/hdi.js", "status", r'\binfo\?\.\(\s*' + STR + r'\s*\)'),
    ("app/editor/update-check.js", "update", "literals"),
    ("app/editor/update-check.js", "update", r'\bError\(\s*' + STR + r'\s*\)'),
    ("app/extension-host/extension-dev.js", "prefs", "literals"),
    # energy: Preferences › Energy (power.js registers the page).
    ("app/core/power.js", "prefs", r'(?:api\.el\("(?:label|small)", "prf-(?:label|help)", |api\.group\(c, |\["(?:auto|always|off)", |textContent = efficient\(\) \? |: )' + STR),
    ("app/extension-host/extension-dev.js", "prefs", r'\bError\(\s*' + STR + r'\s*\)'),
    # menus/i18n pass: themes (picker, editor, library names, presets) and VS Code keys.
    ("app/editor/theme-picker.js", "themes", "literals"),
    ("app/editor/theme-editor.js", "themes", "literals"),
    ("app/editor/theme-library.js", "themes", r'\{id: "[\w-]+", name: ' + STR + r', type: "[\w-]+", description: ' + STR),
    ("app/editor/theme.js", "themes", r'\blabel:' + STR),
    ("app/editor/vscode-keys.js", "keys", "literals"),
    # menus/i18n pass: compare view, diff report (all T()), review annotations; diff-model labels the view shows.
    ("app/history/diff-view.js", "diff", "literals"),
    ("app/library/component-match.js", "diff", "literals"),
    ("app/history/diff-props.js", "diff", "literals"),
    ("app/native-bridge/external-tools.js", "prefs", "literals"),
    ("app/history/diff-view.js", "status", r'\b(?:say|info)\??\.?\(\s*' + STR + r'\s*\)'),
    ("app/history/diff-model.js", "diff", r'\b\w+: ' + STR),
    ("app/history/review-annotate.js", "review", "literals"),
    ("app/history/review-annotate.js", "status", r'\bhost\.info\(\s*' + STR + r'\s*\)'),    # ECAD-MCAD exchange: the MCAD panel (proposals, enclosure, clearance) and its status messages.
    ("app/formats/mcad-panel.js", "mcad", "literals"),
    # preview polish (2026-11-19): dialogs and panels of the last wave. Their DOM roots are scoped in
    # app/editor/i18n-dom.js (SCOPES), which loads only for other locales, so English pays nothing.
    ("app/formats/fab-presets.js", "fab", "literals"),
    ("app/formats/fab-presets-start.js", "fab", "literals"),
    ("app/checks/dfm.js", "dfm", "literals"),
    ("app/analysis/thermal-view.js", "thermal", "literals"),
    ("app/analysis/thermal.js", "thermal", "literals"),
    ("app/analysis/si.js", "si", "literals"),
    ("extensions/si/main.js", "si", "literals"),
    ("app/library/generic-parts-ui.js", "generic", "literals"),
    ("app/library/generic-parts.js", "generic", r'\{title: ' + STR),
    ("app/library/generic-parts.js", "generic", r'\[' + STR + r', ' + STR + r', (?:\w+|\[|null)'),
    # footprint wizard (2026-11-19): the dialog, and the package families' titles, field labels and choices.
    ("app/library/footprint-wizard.js", "fpwizard", "literals"),
    ("app/library/footprint-packages.js", "fpwizard", r'\b(?:fam|termFamily|connectorFamily)\(\s*"[\w-]+",\s*' + STR),
    ("app/library/footprint-packages.js", "fpwizard", r'\b(?:tol|num|int)Field\(\s*"[\w.]+",\s*' + STR),
    ("app/library/footprint-packages.js", "fpwizard", r'\["[\w.-]+", ' + STR + r'(?:\]|, \[\[|, "text"\])'),
    ("app/editor/command-bar.js", "cmdbar", "literals"),
    ("app/checks/rule-sets.js", "rules", "literals"),
    ("app/checks/rule-groups.js", "rules", "literals"),
    ("app/library/related-parts.js", "related", "literals"),
    ("app/pcb/route-habits.js", "prefs", "literals"),
    ("app/canvas/canvas-gpu-pref.js", "prefs", r'(?:now\.textContent = .*? \? |actual\.startsWith\("2D:"\) \? )' + STR),
    ("app/canvas/camera.js", "prefs", r'(?:title: |group\(|(?:select|range|check)\(\w+, "[\w.]+", )' + STR),
    ("app/canvas/camera.js", "prefs", r'check\(\w+, "[\w.]+", "[^"\n]+", ' + STR),
    ("app/project/collab-presence.js", "prefs", r'(?:api\.group\(c, |title: |(?:check|field)\(PREF_\w+, )' + STR),
    ("app/project/collab-presence.js", "prefs", r'(?:render\(PREF_NAME, label, input, |check\(PREF_\w+, "[^"\n]+", |field\(PREF_\w+, "[^"\n]+", (?:input|path), )' + STR),
    *((source, "prefs", r'(?:title: |api\.group\(c, |api\.el\("(?:label|small)", "prf-(?:label|help)", )' + STR) for source in
      ("app/canvas/canvas-gpu-pref.js", "app/history/clip-history.js", "app/history/history-panel.js")),
    ("app/editor/messages.js", "messages", "literals"),
    ("app/editor/editor.js", "props", r'\bsection\(\s*panel\s*,\s*(?:pcb\(\)\s*\?\s*' + STR + r'\s*:\s*)?' + STR + r'\s*\)'),
    ("app/editor/editor.js", "props", r'\b(?:disclosure|documentControls)\(\s*\w+\s*,\s*' + STR),
    *((source, "props", r'\b(?:row|field)\(\s*s\s*,\s*' + STR) for source in
      ("app/editor/editor.js", "app/*-inspector.js")),
    ("app/*-inspector.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
    ("app/editor/editor-workflows.js", "status", r'\binfo\(\s*' + STR + r'\s*\)'),
]
# Shared dialog buttons: every scope, every dialog.
COMMON = ["OK", "Cancel", "Apply", "Close", "Yes", "No", "Save", "Don’t Save", "Done", "Reset", "Back", "Next", "Continue",
          "Browse…", "Add", "Remove", "Delete", "Edit", "Help", "Retry", "Discard"]
# index.html: element ids whose text is data, numbers or units (replaced at runtime).
HTML_SKIP_IDS = {"project-name", "doc-name", "coords", "zoom-value", "grid-value", "unit-toggle", "tool-value", "part-count"}
HTML_NS_BY_ID = {"status": "status", "doc-kind": "status"}
HTML_ATTRS = ("title", "aria-label", "placeholder", "data-label")
SKIP_TEXT = {"mm", "mil", "LS", "Waffle"}
# Modules whose literals are counted for the coverage report (not extracted): the rest of app/*.js.
NOT_UI = {"i18n.js", "i18n-core.js", "i18n-dom.js", "lazy.js", "theme.js"}


def rel(p):
    return os.path.relpath(p, ROOT)


# ---------------------------------------------------------------------------------------- JS literals
def js_literals(src):
    """Yield (value, start, end) for each '...' / "..." / `...` (without ${}) literal outside comments."""
    i, n = 0, len(src)
    prev = ""
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c == "/" and prev in "(,=:[!&|?{};+-*%<>~^" :
            # a regular expression literal: skip to its closing slash
            j, cls = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\": j += 2; continue
                if src[j] == "[": cls = True
                elif src[j] == "]": cls = False
                elif src[j] == "/" and not cls: break
                j += 1
            i = j + 1; prev = "x"; continue
        if c in "\"'`":
            j, buf, dyn = i + 1, [], False
            while j < n and src[j] != c:
                if src[j] == "\\" and j + 1 < n:
                    e = src[j + 1]
                    buf.append({"n": "\n", "t": "\t", '"': '"', "'": "'", "\\": "\\", "`": "`"}.get(e, "\\" + e)); j += 2; continue
                if c == "`" and src.startswith("${", j): dyn = True
                if c != "`" and src[j] == "\n": break
                buf.append(src[j]); j += 1
            if not dyn:
                v = "".join(buf)
                v = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), v)
                yield v, i, j + 1
            i = j + 1; prev = "x"; continue
        if not c.isspace(): prev = c
        i += 1


CAMEL = re.compile(r"^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$")
NOT_PROSE = re.compile(r"^(?:[\w.-]+\.(?:js|css|json|md|html|svg|png|atrium|atrlib|zip|txt)|[.#\[][\w-]|\w+:\S|[A-Z_]{2,}[\w]*$)")


def ui_like(s):
    t = s.strip()
    if len(t) < 2 or not re.search(r"[A-Za-z]", t) or "\n" in t:
        return False
    first = re.search(r"[A-Za-z]", t).group(0)
    if not first.isupper() or not re.search(r"[a-z]", t):
        return False
    if CAMEL.match(t) or NOT_PROSE.match(t) or "=>" in t or re.search(r"[{}<>]", t):
        return False
    if " " not in t and ("/" in t or "." in t[:-1] or "_" in t or "+" in t):
        return False
    if re.match(r"^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$", t) and re.search(r"\d", t):  # SVG path data
        return False
    return True


SKIP_BEFORE = re.compile(r"(?:===|!==|==|!=|\bcase|\b(?:querySelector(?:All)?|getElementById|createElement(?:NS)?|getItem|setItem|removeItem|"
                         r"getAttribute|setAttribute|hasAttribute|removeAttribute|closest|matches|need|register|require|startsWith|endsWith|includes|"
                         r"addEventListener|dispatchEvent|Error|warn)\s*\(\s*)\s*$")


def literal_context(src, a, b):
    """'skip' (not UI), 'fragment' (part of a concatenation) or 'text'."""
    before, after = src[max(0, a - 60):a], src[b:b + 4]
    line = src[src.rfind("\n", 0, a) + 1:src.find("\n", b) if src.find("\n", b) >= 0 else len(src)]
    if "i18n-ignore" in line:
        return "skip"
    if SKIP_BEFORE.search(before) or re.match(r"\s*(?:===|!==|==|!=)", after) or re.match(r"\s*:(?!:)", after) and re.search(r"[{,]\s*$", before):
        return "skip"
    if re.search(r"(?<!\+)\+\s*$", before) or re.match(r"\s*\+(?!\+)", after):
        return "fragment"
    return "text"


# ---------------------------------------------------------------------------------------- keys
def slug(text):
    s = text.replace("…", " more").replace("&", " and ").replace("%", " pct ").replace("’", "")
    s = s.translate(str.maketrans("ÀÁÂÄÅàáâäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÖòóôöÙÚÛÜùúûüÇçÑñ", "AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOooooUUUUuuuuCcNn"))
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()
    return (s[:48].rstrip("_")) or "x"


def crc(text):
    return "%06x" % (zlib.crc32(text.encode("utf-8")) & 0xFFFFFF)


class Catalogue:
    def __init__(self):
        self.texts = {}      # ns -> {text: [locations]}
        self.fixed = {}      # key -> (text, [locations])  structural keys (cmd.*, define tables)
        self.remaining = {}  # file -> [(text, line, why)]
        self.converted = {}  # file -> count

    def add(self, ns, text, where):
        text = text.strip()
        if not text or text in SKIP_TEXT or not re.search(r"[A-Za-z]", text):
            return
        self.texts.setdefault(ns, {}).setdefault(text, []).append(where)
        self.converted[where.split(":")[0]] = self.converted.get(where.split(":")[0], 0) + 1

    def put(self, key, text, where):
        if key in self.fixed and self.fixed[key][0] != text:
            raise SystemExit("i18n-extract: %s is defined twice with different English (%s)" % (key, where))
        self.fixed.setdefault(key, (text, []))[1].append(where)
        self.converted[where.split(":")[0]] = self.converted.get(where.split(":")[0], 0) + 1

    def messages(self):
        out = {k: v[0] for k, v in self.fixed.items()}
        for ns, texts in self.texts.items():
            by = {}
            for t in texts:
                by.setdefault(slug(t), []).append(t)
            for s, ts in by.items():
                for t in ts:
                    key = ns + "." + (s if len(ts) == 1 else s + "_" + crc(t))
                    out[key] = t
        return dict(sorted(out.items()))

    def where(self):
        w = {k: v[1] for k, v in self.fixed.items()}
        for ns, texts in self.texts.items():
            for t, locs in texts.items():
                w.setdefault((ns, t), locs)
        return w


def line_of(src, pos):
    return src.count("\n", 0, pos) + 1


# ---------------------------------------------------------------------------------------- harvest
class Shell(html.parser.HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

    def __init__(self, cat, path):
        super().__init__(convert_charrefs=True)
        self.cat, self.path, self.stack, self.body = cat, path, [], False

    def skipping(self, text=True):
        return any(t in ("svg", "script", "style", "head") or (text and a.get("id") in HTML_SKIP_IDS) or a.get("translate") == "no"
                   or "data-power-net" in a for t, a in self.stack)

    def ns(self):
        for t, a in reversed(self.stack):
            if a.get("id") in HTML_NS_BY_ID:
                return HTML_NS_BY_ID[a["id"]]
        return "menu" if any("work-menu" in (a.get("class") or "").split() for t, a in self.stack) else "shell"

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "body":
            self.body = True
        if tag in self.VOID:
            self.stack.append((tag, a)); self.attrs(a); self.stack.pop(); return
        self.stack.append((tag, a)); self.attrs(a)

    def attrs(self, a):
        if not self.body or self.skipping(text=False):
            return
        for k in HTML_ATTRS:
            if a.get(k):
                self.cat.add(self.ns(), a[k], "%s:%d" % (self.path, self.getpos()[0]))

    def handle_endtag(self, tag):
        for k in range(len(self.stack) - 1, -1, -1):
            if self.stack[k][0] == tag:
                del self.stack[k:]; break

    def handle_data(self, data):
        if self.body and data.strip() and not self.skipping():
            self.cat.add(self.ns(), data, "%s:%d" % (self.path, self.getpos()[0]))


def harvest_keymap(cat):
    p = os.path.join(APP, "editor/keymap.js"); src = open(p, encoding="utf-8").read(); r = rel(p)
    a = src.index("const BUILTIN=["); b = src.index("const CATEGORIES=", a)
    block = src[a:b]
    titles, ids = {}, set()
    # Skip quoted option values before looking for the row's closing bracket.
    extra_object = r'''\{(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^"'\]])*?\}'''
    for m in re.finditer(r'\["([\w-]+)",' + STR + r',"(\w+)"(?:,(' + extra_object + r'|nudge\([^)]*\)))?\]', block):
        cid, title, extra = m.group(1), m.group(2), m.group(4) or ""
        where = "%s:%d" % (r, line_of(src, a + m.start()))
        if cid in ids:
            raise SystemExit("i18n-extract: duplicate built-in command %s (%s)" % (cid, where))
        ids.add(cid)
        action = re.search(r"\baction:\s*" + STR, extra)
        cat.put("cmd." + cid, title, where)
        t = re.search(r"titles:\{([^}]*)\}", extra)
        routed = extra.startswith("nudge(") or re.search(r"\bparam:\s*", extra) or (action and action.group(1) != cid)
        if not t and not routed:
            titles[cid] = json.loads('"' + title + '"')
        for k, v in re.findall(r"(\w+):" + STR, t.group(1) if t else ""):
            cat.put("cmd.%s.%s" % (cid, k), v, where)
        s = re.search(r"short:" + STR, extra)
        if s:
            cat.put("cmd.%s.short" % cid, s.group(1), where)
    c = re.search(r"const CATEGORIES=\[([^\]]*)\]", src)
    for v in re.findall(STR, c.group(1)):
        cat.add("category", v, "%s:%d" % (r, line_of(src, c.start())))
    return titles


# A define({...}) table up to its closing "})": strings (either quote, with escapes) and comments are
# skipped whole, so "Filters ({count})" or a "}" inside a value does not end the table (tests/maintenance/i18n-extract.py).
DEFINE = re.compile(r"AtriumI18n\??\.define\??\.?\(\s*\{((?:\"(?:[^\"\\\n]|\\.)*\"|'(?:[^'\\\n]|\\.)*'|//[^\n]*|/\*.*?\*/|[^\"'}/]|/(?![/*]))*)\}\s*\)", re.S)


def project_command_labels(source, titles):
    """Share identical built-in captions and preserve the rest of each menu button."""
    def label(match):
        attrs, content = match.groups()
        menu = re.search(r'\srole="menuitem(?:checkbox|radio)?"', attrs)
        action = re.search(r'\sdata-action="([\w-]+)"', attrs)
        title = titles.get(action.group(1)) if menu and action and "<" not in content else None
        marked = re.search(r'\sdata-command-label(?:\s|$)', attrs)
        if marked and title is None:
            raise SystemExit("i18n-extract: data-command-label needs a built-in menu action and a plain-text caption: " + attrs)
        if not marked:
            if title is None or html.unescape(content) != title:
                return match.group()
            attrs += " data-command-label"
        return "<button" + attrs + ">" + html.escape(title, quote=False) + "</button>"

    return re.sub(r'<button\b([^>]*)>(.*?)</button>', label, source, flags=re.S)


def harvest(cat):
    titles = harvest_keymap(cat)
    html_path = os.path.join(APP, "index.html")
    with open(html_path, encoding="utf-8") as f:
        shell = project_command_labels(f.read(), titles)
    Shell(cat, rel(html_path)).feed(shell)
    for t in COMMON:
        cat.add("common", t, "scripts/i18n-extract.py:COMMON")
    claimed = {}  # file -> set of literal start offsets harvested by a pattern
    files = app_source_files(APP, "*.js")
    for pattern_glob, ns, pattern in SOURCES:
        candidates = (app_source_files(APP, pattern_glob.split("/", 1)[1])
                      if pattern_glob.startswith("app/") and pattern_glob.count("/") == 1 and "*" in pattern_glob
                      else sorted(glob.glob(os.path.join(ROOT, pattern_glob))))
        for p in candidates:
            src = open(p, encoding="utf-8").read(); r = rel(p)
            if pattern == "literals":
                for v, s, e in js_literals(src):
                    if ui_like(v) and literal_context(src, s, e) == "text":
                        cat.add(ns, v, "%s:%d" % (r, line_of(src, s))); claimed.setdefault(r, set()).add(s)
                continue
            matches = status_choices(src) if pattern == "status-choices" else re.finditer(pattern, src)
            for m in matches:
                for gi in range(1, (m.lastindex or 0) + 1):
                    v = m.group(gi)
                    if v is not None and ui_like(v):
                        cat.add(ns, json.loads('"' + v + '"'), "%s:%d" % (r, line_of(src, m.start(gi))))
                        claimed.setdefault(r, set()).add(m.start(gi) - 1)
    uses = {}
    for p in files:
        src = open(p, encoding="utf-8").read(); r = rel(p)
        for m in DEFINE.finditer(src):
            if src[src.rfind("\n", 0, m.start()) + 1:m.start()].lstrip().startswith(("//", "*")):
                continue  # an example in a comment
            for k, v in re.findall(r'"([\w.-]+)"\s*:\s*' + STR, m.group(1)):
                cat.put(k, json.loads('"' + v + '"'), "%s:%d" % (r, line_of(src, m.start())))
            claimed.setdefault(r, set()).update(s + m.start(1) for _, s, _ in js_literals(m.group(1)))
        uses[r] = src
        harvest_plurals(cat, src, r, claimed)
    # Remaining: UI-like literals nothing above claimed (and concatenation fragments anywhere).
    keymap = rel(os.path.join(APP, "editor/keymap.js"))
    fixed_texts = {v[0] for v in cat.fixed.values()}
    for p in files:
        r = rel(p); name = app_source_name(APP, p)
        if name in NOT_UI or name.endswith(".min.js"):
            continue
        src = uses[r]
        for v, s, e in js_literals(src):
            if not ui_like(v) or s in claimed.get(r, ()):
                continue
            why = literal_context(src, s, e)
            if why == "skip" or (r == keymap and v in fixed_texts):
                continue
            cat.remaining.setdefault(r, []).append((v, line_of(src, s), why))
    return uses, shell


# Local plural helpers that route through AtriumI18n.plural (i18n-core.js): each call with literal
# words becomes "plural.<slug>": "{count, plural, one {# word} other {# words}}". The slug matches
# the JS one in i18n-core.js (lower case, runs of other characters become "_").
PLURAL_HELPER = re.compile(r"(?:const|let)\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*globalThis\.AtriumI18n\?\.plural\?\.")


def plural_key(one):
    s = re.sub(r"[^a-z0-9]+", "_", one.lower()).strip("_")
    return "plural." + (s[:48].rstrip("_") or "x")


def plural_icu(one, many):
    return "{count, plural, one {# %s} other {# %s}}" % (one, many)


def call_args(src, i, separators=","):
    """Top-level spans split at separators inside the call whose "(" is at src[i], or None."""
    depth, j, start, out, n = 0, i, i + 1, [], len(src)
    while j < n:
        c = src[j]
        if c in "\"'`":
            k = j + 1
            while k < n and src[k] != c:
                k += 2 if src[k] == "\\" else 1
            j = k + 1; continue
        if c in "([{": depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                out.append((start, j)); return out
        elif depth == 1 and c in separators:
            out.append((start, j)); start = j + 1
        j += 1
    return None


def status_choices(src):
    """Literal host.info messages, including complete branches of conditional statuses."""
    literal = re.compile(r'\s*' + STR + r'\s*')
    for call in re.finditer(r'\bhost\.info\s*\(', src):
        for start, end in call_args(src, call.end() - 1, "?:") or ():
            if src[end] != "?":  # a condition itself is not a displayed result
                match = literal.fullmatch(src, start, end)
                if match:
                    yield match


def harvest_plurals(cat, src, r, claimed):
    helpers = [(d.group(1), '.replace(/(s|x|ch)$/, "$1e")' in d.group(2)) for d in PLURAL_HELPER.finditer(src)]
    # The selection inspector receives pcb-edit's plural function from its host.
    if r == "app/pcb/pcb-selection-inspector.js":
        helpers.append(("plural", False))
    for name, es in helpers:
        for m in re.finditer(r"(?<![\w.])" + name + r"\(", src):
            args = call_args(src, m.end() - 1)
            if not args or len(args) < 2:
                continue
            lit = [re.fullmatch(r"\s*" + STR + r"\s*", src[a:b]) for a, b in args[1:3]]
            if not lit[0] or (len(lit) > 1 and not lit[1]):
                continue
            one = json.loads('"' + lit[0].group(1) + '"')
            many = json.loads('"' + lit[1].group(1) + '"') if len(lit) > 1 else re.sub(r"(s|x|ch)$", r"\1e", one) + "s" if es else one + "s"
            cat.put(plural_key(one), plural_icu(one, many), "%s:%d" % (r, line_of(src, m.start())))
            for (a, b), l in zip(args[1:3], lit):
                claimed.setdefault(r, set()).add(a + l.start(1) - 1)


# ---------------------------------------------------------------------------------------- ICU
def close(s, i):
    d = 0
    for k in range(i, len(s)):
        if s[k] == "{": d += 1
        elif s[k] == "}":
            d -= 1
            if d == 0: return k
    raise ValueError("unbalanced braces in: " + s)


def icu_parts(msg):
    """[(kind, value)]: ('text', s) | ('arg', name, type, style, options{sel: body})."""
    out, i, buf = [], 0, []
    while i < len(msg):
        c = msg[i]
        if c == "{":
            if buf: out.append(("text", "".join(buf))); buf = []
            e = close(msg, i); body = msg[i + 1:e]
            parts = body.split(",", 2)
            name = parts[0].strip(); typ = parts[1].strip() if len(parts) > 1 else ""; style = parts[2] if len(parts) > 2 else ""
            opts = None
            if typ in ("plural", "select", "selectordinal"):
                opts, j = [], 0
                while j < len(style):
                    b = style.find("{", j)
                    if b < 0: break
                    ee = close(style, b); opts.append((style[j:b].strip(), style[b + 1:ee])); j = ee + 1
            out.append(("arg", name, typ, style, opts)); i = e + 1; continue
        if c == "}":
            raise ValueError("unbalanced braces in: " + msg)
        buf.append(c); i += 1
    if buf: out.append(("text", "".join(buf)))
    return out


def placeholders(msg):
    names = set()
    for p in icu_parts(msg):
        if p[0] == "arg":
            names.add(p[1])
            for _, body in p[4] or []:
                names |= placeholders(body)
    return names


ACCENT = str.maketrans("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                       "åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ")
FILLER = " ļöŕéɱ îþšûɱ ðöļöŕ šîţ åɱéţ çöñšéçţéţûŕ åðîþîšçîñĝ éļîţ šéð ðö éîûšɱöð ţéɱþöŕ"


def visible(msg):
    n = 0
    for p in icu_parts(msg):
        if p[0] == "text": n += len(p[1].replace("#", "00"))
        elif p[4]: n += max(visible(b) for _, b in p[4]) if p[4] else 0
        else: n += 4
    return n


def accent(msg, in_plural=False):
    out = []
    for p in icu_parts(msg):
        if p[0] == "text":
            out.append(p[1].translate(ACCENT))
        elif p[4] is not None:
            opts = " ".join("%s {%s}" % (sel, accent(b, p[2] != "select")) for sel, b in p[4])
            out.append("{%s, %s, %s}" % (p[1], p[2], opts))
        else:
            out.append("{" + ", ".join(x for x in (p[1], p[2], p[3].strip()) if x) + "}")
    return "".join(out)


def pseudo(msg):
    pad = math.ceil(visible(msg) * 0.35)
    fill = (FILLER * (1 + pad // len(FILLER)))[:pad]
    if fill.endswith(" "): fill = fill[:-1] + "·"
    return "[" + accent(msg) + fill + "]"


# ---------------------------------------------------------------------------------------- files
META = {"en": {"@name": "English", "@native": "English"},
        PSEUDO: {"@name": "Pseudo-locale (testing)", "@native": "[Þšéûðö-ļöçåļé]", "@pseudo": True}}


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def loader(lid, data):
    msgs = {k: v for k, v in data.items() if not k.startswith("@")}
    return ('"use strict";\n// Generated by scripts/i18n-extract.py from %s.json: edit the JSON (or, for English, the source) and run the script.\n'
            "globalThis.AtriumI18n?.add(%s, %s);\n" % (lid, json.dumps(lid), json.dumps(msgs, ensure_ascii=False, indent=0)))


def available(locales):
    rows = []
    for lid in sorted(locales, key=lambda x: (x != "en", locales[x].get("@pseudo", False), x)):
        d = locales[lid]
        row = {"id": lid, "name": d.get("@name", lid), "native": d.get("@native", d.get("@name", lid))}
        if d.get("@pseudo"): row["pseudo"] = True
        if d.get("@dir") == "rtl": row["dir"] = "rtl"
        rows.append(row)
    js = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    js = re.sub(r'"(\w+)":', r"\1:", js)
    return "  const AVAILABLE = " + js + ";\n"


def generate():
    cat = Catalogue(); uses, shell = harvest(cat)
    en = cat.messages()
    files = {os.path.join(APP, "index.html"): shell}
    locales = {}
    for p in sorted(glob.glob(os.path.join(LOCALES, "*.json"))):
        lid = os.path.basename(p)[:-5]
        if lid in ("en", PSEUDO):
            continue
        try: locales[lid] = json.load(open(p, encoding="utf-8"))
        except ValueError as e: raise SystemExit("i18n-extract: %s is not valid JSON: %s" % (rel(p), e))
    en_full = {**META["en"], "@locale": "en", **en}
    xa = {**META[PSEUDO], "@locale": PSEUDO, **{k: pseudo(v) for k, v in en.items()}}
    locales["en"], locales[PSEUDO] = en_full, xa
    for lid, data in locales.items():
        files[os.path.join(LOCALES, lid + ".json")] = dump(data)
        files[os.path.join(LOCALES, lid + ".js")] = loader(lid, data)
    core = os.path.join(APP, "editor/i18n-core.js"); src = open(core, encoding="utf-8").read()
    a = src.index("// i18n-extract:available"); a = src.index("\n", a) + 1; b = src.index("  // i18n-extract:end", a)
    files[core] = src[:a] + available(locales) + src[b:]
    shim = os.path.join(APP, "editor/i18n.js"); src = open(shim, encoding="utf-8").read()
    real = " ".join(sorted(lid for lid, d in locales.items() if lid != "en" and not d.get("@pseudo")))
    files[shim] = re.sub(r'REAL = "[^"]*"', lambda m: 'REAL = "%s"' % real, src, count=1)
    return cat, en, locales, files, uses


def problems(cat, en, locales, uses):
    out = []
    # define() keys must be used somewhere other than their table.
    for key, (text, locs) in cat.fixed.items():
        if key.startswith(("cmd.", "plural.")):
            continue
        n = sum(src.count('"' + key + '"') for src in uses.values())
        if n < 2:
            out.append("unused define() key %s (%s): call t(%r)" % (key, locs[0], key))
    for lid, data in locales.items():
        if lid in ("en", PSEUDO):
            continue
        for k, v in data.items():
            if k.startswith("@"): continue
            if k not in en:
                out.append("%s.json: unused key %s (English no longer has it; remove or rename it)" % (lid, k)); continue
            try:
                if placeholders(v) != placeholders(en[k]):
                    out.append("%s.json: %s has placeholders %s, English has %s" % (lid, k, sorted(placeholders(v)), sorted(placeholders(en[k]))))
            except ValueError as e:
                out.append("%s.json: %s: %s" % (lid, k, e))
    for k, v in en.items():
        try: icu_parts(v)
        except ValueError as e: out.append("en: %s: %s" % (k, e))
    return out


def coverage(cat, en, locales):
    mods = {}
    for f, n in cat.converted.items():
        mods.setdefault(f, {"converted": 0, "remaining": 0, "fragments": 0})["converted"] += n
    for f, rows in cat.remaining.items():
        m = mods.setdefault(f, {"converted": 0, "remaining": 0, "fragments": 0})
        for _, _, why in rows:
            m["fragments" if why == "fragment" else "remaining"] += 1
    loc = {}
    for lid, data in locales.items():
        have = sum(1 for k in en if k in data)
        loc[lid] = {"translated": have, "keys": len(en), "percent": round(100.0 * have / max(1, len(en)), 1)}
    return {"keys": len(en), "modules": mods, "locales": loc}


def main(argv):
    from asset_files import write_asset
    cat, en, locales, files, uses = generate()
    if "--where" in argv:
        q = argv[argv.index("--where") + 1]
        hits = [k for k, v in en.items() if k == q or v == q or q.lower() in v.lower()]
        w = cat.where()
        for k in hits[:40]:
            ns = k.split(".", 1)[0]
            print("%s = %s" % (k, json.dumps(en[k], ensure_ascii=False)))
            for loc in (w.get(k) or w.get((ns, en[k])) or [])[:8]:
                print("    " + loc)
        return 0 if hits else 1
    if "--coverage" in argv:
        c = coverage(cat, en, locales)
        if "--json" in argv:
            print(json.dumps(c, indent=2)); return 0
        print("English catalogue: %d keys" % c["keys"])
        print("%-34s %9s %9s %9s" % ("module", "converted", "remaining", "fragments"))
        rows = sorted(c["modules"].items(), key=lambda kv: (-kv[1]["converted"], -kv[1]["remaining"] - kv[1]["fragments"], kv[0]))
        tot = [0, 0, 0]
        for f, m in rows:
            tot[0] += m["converted"]; tot[1] += m["remaining"]; tot[2] += m["fragments"]
            if m["converted"] or "--all" in argv:
                print("%-34s %9d %9d %9d" % (f, m["converted"], m["remaining"], m["fragments"]))
        others = [kv for kv in rows if not kv[1]["converted"]]
        print("%-34s %9d %9d %9d" % ("(%d modules not started)" % len(others), 0, sum(m["remaining"] for _, m in others), sum(m["fragments"] for _, m in others)))
        print("%-34s %9d %9d %9d" % ("total", *tot))
        for lid, l in sorted(c["locales"].items()):
            print("locale %-8s %5d / %d keys (%.1f%%)" % (lid, l["translated"], l["keys"], l["percent"]))
        return 0
    old_loaders = sorted(set(glob.glob(os.path.join(LOCALES, "*.js"))) - files.keys())
    if "--assets" in argv:
        for p in old_loaders:
            os.unlink(p)
        for p, text in files.items():
            if p.startswith(LOCALES + os.sep) and (p.endswith(".js") or p == os.path.join(LOCALES, PSEUDO + ".json")):
                write_asset(p, text)
        return 0
    if "--check" in argv:
        bad = problems(cat, en, locales, uses)
        bad.extend("%s has no source locale" % rel(p) for p in old_loaders)
        old = {}
        try: old = {k: v for k, v in json.load(open(os.path.join(LOCALES, "en.json"), encoding="utf-8")).items() if not k.startswith("@")}
        except (OSError, ValueError): pass
        missing, unused = sorted(set(en) - set(old)), sorted(set(old) - set(en))
        changed = sorted(k for k in set(en) & set(old) if en[k] != old[k])
        for k in missing[:30]: bad.append("en.json is missing %s = %s" % (k, json.dumps(en[k], ensure_ascii=False)))
        for k in unused[:30]: bad.append("en.json has unused key %s" % k)
        for k in changed[:30]: bad.append("en.json has old English for %s" % k)
        for p, text in files.items():
            try: cur = open(p, encoding="utf-8").read()
            except OSError: cur = None
            if cur != text and not p.endswith("en.json"):
                bad.append("%s is out of date" % rel(p))
        if bad:
            print("i18n-extract --check: %d problem(s); run scripts/i18n-extract.py to regenerate" % len(bad))
            for b in bad: print("  " + b)
            return 1
        print("i18n-extract --check: OK (%d keys; %s)" % (len(en), ", ".join("%s %d" % (l, sum(1 for k in en if k in d)) for l, d in sorted(locales.items()))))
        return 0
    bad = problems(cat, en, locales, uses)
    os.makedirs(LOCALES, exist_ok=True)
    for p in old_loaders:
        os.unlink(p)
    for p, text in files.items():
        try: cur = open(p, encoding="utf-8").read()
        except OSError: cur = None
        if cur != text:
            write_asset(p, text); print("wrote " + rel(p))
    for b in bad: print("warning: " + b)
    print("%d keys" % len(en))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
