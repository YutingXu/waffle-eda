#!/usr/bin/env python3
"""Design-system guard (docs/design-system.md). Run: python3 tests/maintenance/css-tokens.py

Fails when
  1. an authored CSS declaration adds a literal colour, shadow or radius outside
     the design-token definitions. Includes static inline styles and CSS strings
     in editor sources. Existing declarations have individual legacy entries.
  2. a legacy entry is left behind when its declaration is removed.
  3. the design scale in style.css :root is missing a token.
  4. a preset or built-in library theme (resolved by the app in JavaScriptCore or Node)
     misses 4.5:1 for text or 3:1 for controls, status markers and focus indicators.
  5. a library theme's own copper layers are too alike: every pair of Top, Bottom and Inner 1-6 must be at least
     MIN_DELTA_E apart (CIE76, computed here independently), at least 3:1 on the board, and the
     colour-vision theme (Clearview) keeps MIN_DELTA_E_CVD under simulated deuteranopia.
  6. layers and resize handles break the rules in layer_lint.py (z-index scale, app-wide
     layers, element-owned decorations, one shared resize handle).
Warns (does not fail) on font sizes that bypass the type scale.
Prints "css-tokens: ok" on success; exits 1 with a list of problems otherwise.
"""
import importlib.util
import os
import re
import sys
from pathlib import Path

import css_style_lint
import layer_lint
import shortcut_lint

ROOT = Path(__file__).resolve().parents[2]
APP = Path(os.environ.get("ATRIUM_APP") or ROOT / "app").resolve()
spec = importlib.util.spec_from_file_location("css_audit", os.path.join(ROOT, "scripts", "css-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

SCALE = ["s-2", "s-4", "s-6", "s-8", "s-12", "s-16", "s-24",
         "fs-10", "fs-11", "fs-12", "fs-13", "fs-14", "fs-16", "fs-20",
         "fw-regular", "fw-medium", "fw-semibold", "lh-tight", "lh", "lh-loose",
         "r-sm", "r-md", "r-lg", "r-pill", "elev-1", "elev-2", "elev-3",
         "z-sticky", "z-float", "z-toast", "z-popover", "z-alert", "z-top",
         "ctl-h-sm", "ctl-h", "ctl-h-lg", "ctl-px", "focus-w", "focus-ring",
         "surface", "overlay", "text", "success", "error",
         "tint-danger", "tint-warning", "tint-success", "tint-info", "tint-accent", "icon-close", "sel-bar",
         "accent-text", "accent-strong", "on-accent-strong", "chrome-menu-height", "chrome-tab-height", "chrome-row-height",
         "chrome-icon-width", "chrome-icon-height", "chrome-control-radius", "chrome-chip-height", "chrome-layer-height",
         "chrome-layer-swatch", "chrome-pill-height"]

def rgba(color):
    functional = re.fullmatch(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", color)
    if functional:
        *channels, alpha = functional.groups()
        return [float(v) / 255 for v in channels] + [float(alpha) if alpha else 1]
    value = color.lstrip("#")
    if len(value) in (3, 4):
        value = "".join(c * 2 for c in value)
    if not re.fullmatch(r"[\da-fA-F]{6}(?:[\da-fA-F]{2})?", value):
        raise ValueError(f"invalid theme colour {color}")
    return [int((value + "ff")[i:i + 2], 16) / 255 for i in (0, 2, 4, 6)]


def rgb(hex_color):
    return rgba(hex_color)[:3]


def lin(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4


def lum(colors):
    r, g, b = map(lin, rgb(colors) if isinstance(colors, str) else colors)
    return .2126 * r + .7152 * g + .0722 * b


def contrast(a, b):
    x, y = lum(a), lum(b)
    return (max(x, y) + .05) / (min(x, y) + .05)


MIN_DELTA_E, MIN_DELTA_E_CVD, MIN_ON_BOARD = 25.0, 25.0, 3.0
COPPER = ["Top", "Bottom"] + ["Inner %d" % i for i in range(1, 7)]
CVD_THEMES = {"clearview"}
HARNESS = r"""
LOAD(APP + "/editor/theme.js"); LOAD(APP + "/editor/theme-library.js");
var T = globalThis.AtriumTheme, L = globalThis.AtriumThemes, out = {pairs: L.TEXT, presets: {}, themes: {}};
T.PRESET_IDS.forEach(function (id) { out.presets[id] = T.tokensFor({...T.DEFAULTS, preset:id, followSystem:false}); });
L.BUILTIN_IDS.forEach(function (id) { var r = L.resolved(id), d = L.get(id).doc;
  out.themes[id] = {tokens: r.tokens, layers: r.canvas.pcb.layers, board: r.canvas.pcb.system.board, ownLayers: !!(d.canvas && d.canvas.pcb && d.canvas.pcb.layers),
    syntax: r.syntax, field: r.tokens.field, warnings: r.report.warnings}; });
PRINT(JSON.stringify(out));
"""


def library_themes():
    gen = importlib.util.spec_from_file_location("gen_shortcuts", os.path.join(ROOT, "scripts", "gen-shortcuts.py"))
    g = importlib.util.module_from_spec(gen)
    gen.loader.exec_module(g)
    kind, engine = g.find_engine()
    import json, subprocess, tempfile
    src = "var APP = %s;\n" % json.dumps(os.path.abspath(APP)) + HARNESS
    if kind == "jsc":
        src = "var LOAD = load, PRINT = print;\n" + src
    else:
        src = ("var fs = require('fs'), vm = require('vm');\nvar LOAD = function (f) { vm.runInThisContext(fs.readFileSync(f, 'utf8'), {filename: f}); };\n"
               "var PRINT = function (s) { process.stdout.write(s + '\\n'); };\n" + src)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(src)
    try:
        res = subprocess.run([engine, fh.name], capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(fh.name)
    lines = [l for l in res.stdout.splitlines() if l.startswith("{")]
    if res.returncode or not lines:
        raise SystemExit("css-tokens: the theme library did not load:\n" + res.stdout + res.stderr)
    return json.loads(lines[-1])


def lab(h, cvd=False):
    r, g, b = (lin(v) for v in rgb(h))
    if cvd:  # deuteranopia, Machado et al. 2009 (severity 1)
        r, g, b = (min(1, max(0, x)) for x in (.367322 * r + .860646 * g - .227968 * b, .280085 * r + .672501 * g + .047413 * b, -.01182 * r + .04294 * g + .968881 * b))
        r, g, b = (lin(round(255 * (12.92 * v if v <= .0031308 else 1.055 * v ** (1 / 2.4) - .055)) / 255) for v in (r, g, b))
    f = lambda t: t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116
    x, y, z = f((.4124 * r + .3576 * g + .1805 * b) / .95047), f(.2126 * r + .7152 * g + .0722 * b), f((.0193 * r + .1192 * g + .9505 * b) / 1.08883)
    return 116 * y - 16, 500 * (x - y), 200 * (y - z)


def delta_e(a, b, cvd=False):
    p, q = lab(a, cvd), lab(b, cvd)
    return sum((p[i] - q[i]) ** 2 for i in range(3)) ** .5


ALTIUM = {"Top": "#ff0000", "Bottom": "#0000ff", "Inner 1": "#bc8e00", "Inner 2": "#70dbfa", "Inner 3": "#00cc66", "Inner 4": "#9b9bff", "Inner 5": "#00ffff", "Inner 6": "#800081"}


def opaque(color, under):
    *channels, alpha = rgba(color)
    return [c * alpha + u * (1 - alpha) for c, u in zip(channels, under)]


def check_pairs(problems, where, tokens, pairs):
    worst = {4.5: 99, 3: 99}
    for fg, bg, need in pairs:
        missing = [k for k in (fg, bg) if k not in tokens]
        if missing:
            problems.append(f"{where}: missing " + ", ".join(f"--{k}" for k in missing))
            continue
        back = opaque(tokens[bg], rgb(tokens["panel"]))
        r = contrast(opaque(tokens[fg], back), back)
        worst[need] = min(worst[need], r)
        if r < need - 1e-9:
            problems.append(f"{where}: --{fg} on --{bg} is {r:.2f}:1 (needs {need}:1)")
    return f"{where:11} text ≥ {worst[4.5]:.2f}:1  UI ≥ {worst[3]:.2f}:1"


def check_library(problems, report):
    data = library_themes()
    for pid, t in data["presets"].items():
        report.append(check_pairs(problems, pid, t, data["pairs"]))
    for tid, th in data["themes"].items():
        t = th["tokens"]
        result = check_pairs(problems, tid, t, data["pairs"])
        for k, v in th["syntax"].items():
            if contrast(v, th["field"]) < 4.5 - 1e-9:
                problems.append(f"theme-library {tid}: syntax {k} on --field is {contrast(v, th['field']):.2f}:1")
        for w in th["warnings"]:
            problems.append(f"theme-library {tid}: {w}")
        layers = {k: th["layers"].get(k, ALTIUM[k]) for k in COPPER}
        pairs = [(a, b) for i, a in enumerate(COPPER) for b in COPPER[i + 1:]]
        de = min((delta_e(layers[a], layers[b]), a, b) for a, b in pairs)
        cvd = min((delta_e(layers[a], layers[b], True), a, b) for a, b in pairs)
        board = min(contrast(layers[k], th["board"]) for k in COPPER)
        if th["ownLayers"]:
            if de[0] < MIN_DELTA_E:
                problems.append(f"theme-library {tid}: copper {de[1]} and {de[2]} are only ΔE {de[0]:.1f} apart (needs {MIN_DELTA_E})")
            if board < MIN_ON_BOARD:
                problems.append(f"theme-library {tid}: a copper layer is {board:.2f}:1 on the board (needs {MIN_ON_BOARD}:1)")
        if tid in CVD_THEMES and cvd[0] < MIN_DELTA_E_CVD:
            problems.append(f"theme-library {tid}: with deuteranopia {cvd[1]} and {cvd[2]} are ΔE {cvd[0]:.1f} apart (needs {MIN_DELTA_E_CVD})")
        report.append(f"{result}  copper ΔE ≥ {de[0]:.1f} ({de[1]}/{de[2]})  deuteranopia ΔE ≥ {cvd[0]:.1f}  on board ≥ {board:.2f}:1")


def main():
    css_style_lint.self_test()
    shortcut_lint.self_test()
    layer_lint.self_test()
    problems = css_style_lint.check(ROOT, APP, ROOT / "tests/maintenance/css-style-legacy.json")
    problems += shortcut_lint.check(ROOT, APP)
    problems += layer_lint.check(ROOT, APP)
    warnings = []
    for name in sorted(f for f in os.listdir(APP) if f.endswith(".css")):
        text = (APP / name).read_text(encoding="utf8")
        for sel, body, ctx in audit.rules(text):
            s = re.sub(r"\s+", " ", sel.strip())
            for prop, value in audit.decls(body):
                if prop == "font-size" and re.fullmatch(r"\d+(\.\d+)?px(\s*!important)?", value.strip()) and name != "print.css":
                    warnings.append(f"{name}: {s[:60]} font-size:{value} (use var(--fs-N))")
    css = open(os.path.join(APP, "style.css"), encoding="utf8").read()
    root = css[css.index(":root {"):css.index("}", css.index(":root {"))]
    have = set(re.findall(r"--([\w-]+)\s*:", root))
    for k in SCALE:
        if k not in have:
            problems.append(f"style.css :root lacks the design token --{k}")
    report = []
    check_library(problems, report)
    if "-v" in sys.argv:
        print("\n".join(report))
    for w in warnings:
        print("warn:", w)
    if problems:
        print("\n".join("FAIL " + p for p in problems))
        sys.exit(1)
    print("css-tokens: ok")


if __name__ == "__main__":
    main()
