#!/usr/bin/env python3
"""Inventory Waffle's stylesheets against the design system (docs/design-system.md).

Usage: scripts/css-audit.py [app-dir] [--json] [--top N]

Reports, per file and in total:
  * literal colours (hex, rgb/hsl, named) outside token definitions, split into bare
    literals and var(--x, #fallback) fallbacks
  * distinct font sizes, line heights, paddings, margins, radii, control heights,
    shadows and z-indexes (values written with a design token count as "token")
  * duplicate selectors (same selector text twice in one file, or in several files)
  * !important declarations
Token definitions are custom-property declarations (--name: value) anywhere; their
values are the palette, not drift. The script only reads; it never edits.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

NAMED = {"white", "black", "red", "green", "blue", "yellow", "orange", "gray", "grey", "silver", "maroon",
         "navy", "purple", "teal", "lime", "aqua", "fuchsia", "olive", "pink", "gold", "cyan", "magenta"}
COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)|\b(?:%s)\b" % "|".join(sorted(NAMED)))
CONTROL_SEL = re.compile(r"\b(button|input|select|textarea|summary)\b|\.(btn|tool|chip|tab)\b", re.I)
SIZE_PROPS = {
    "font-size": "font-size", "line-height": "line-height", "border-radius": "radius",
    "box-shadow": "shadow", "z-index": "z-index",
}


def strip_comments(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def rules(text):
    """Yield (selector, declarations, at-rule context) for every style rule."""
    text = strip_comments(text)
    stack, i, start, n = [], 0, 0, len(text)
    while i < n:
        c = text[i]
        if c == "{":
            head = text[start:i].strip()
            if head.startswith("@") and not head.startswith(("@font-face", "@page")):
                stack.append(head)
                start = i + 1
            else:
                depth, j = 1, i + 1
                while j < n and depth:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                    j += 1
                yield head, text[i + 1:j - 1], " ".join(stack)
                i, start = j, j
                continue
        elif c == "}":
            if stack:
                stack.pop()
            start = i + 1
        i += 1


def decls(body):
    for part in re.split(r";(?![^(]*\))", body):
        if ":" not in part:
            continue
        prop, _, value = part.partition(":")
        prop = prop.strip().lower()
        if prop and not prop.startswith(("{", "}")):
            yield prop, value.strip()


def colours(value):
    """Return (bare, fallback) colour literals in a value; url() and data: are skipped."""
    value = re.sub(r"url\([^)]*\)", "", value)
    fallback = []
    for m in re.finditer(r"var\(\s*--[\w-]+\s*,\s*([^()]*(?:\([^)]*\))?[^()]*)\)", value):
        fallback += COLOR_RE.findall(m.group(1))
    bare_value = re.sub(r"var\(\s*--[\w-]+\s*,\s*([^()]*(?:\([^)]*\))?[^()]*)\)", "var()", value)
    return COLOR_RE.findall(bare_value), fallback


def norm_len(value):
    """Canonical px for the measuring props: calc(12px*var(--fs-scale)) -> 12px."""
    v = value.replace("!important", "").strip()
    m = re.fullmatch(r"calc\(\s*([\d.]+px)\s*\*\s*var\(--fs-scale\)\s*\)", v)
    if m:
        return m.group(1)
    return re.sub(r"\s+", " ", v)


def audit(app):
    files = sorted(f for f in os.listdir(app) if f.endswith(".css"))
    out = {"files": {}, "totals": {}}
    selector_files = defaultdict(set)
    tallies = defaultdict(Counter)
    for name in files:
        text = open(os.path.join(app, name), encoding="utf8").read()
        f = {"lines": text.count("\n") + 1, "bytes": len(text.encode()), "colours": [], "fallbacks": [],
             "important": 0, "duplicates": []}
        seen = Counter()
        for sel, body, ctx in rules(text):
            seen[(ctx, sel)] += 1
            for s in sel.split(","):
                selector_files[re.sub(r"\s+", " ", s.strip())].add(name)
            for prop, value in decls(body):
                if "!important" in value:
                    f["important"] += 1
                if prop.startswith("--"):
                    continue
                bare, fb = colours(value)
                f["colours"] += [c.lower() for c in bare]
                f["fallbacks"] += [c.lower() for c in fb]
                key = SIZE_PROPS.get(prop)
                if prop.startswith("padding"):
                    key = "padding"
                elif prop.startswith("margin"):
                    key = "margin"
                elif prop in ("height", "min-height") and CONTROL_SEL.search(sel):
                    key = "control-height"
                if key:
                    v = norm_len(value)
                    tallies[key]["token" if v.startswith("var(--") else v] += 1
        f["duplicates"] = sorted(sel for (ctx, sel), k in seen.items() if k > 1)
        out["files"][name] = f
    allc = Counter(c for f in out["files"].values() for c in f["colours"])
    allfb = Counter(c for f in out["files"].values() for c in f["fallbacks"])
    cross = {s: sorted(fs) for s, fs in selector_files.items() if len(fs) > 1 and s}
    out["totals"] = {
        "files": len(files),
        "lines": sum(f["lines"] for f in out["files"].values()),
        "bytes": sum(f["bytes"] for f in out["files"].values()),
        "literal_colours": sum(allc.values()), "distinct_literal_colours": len(allc),
        "fallback_colours": sum(allfb.values()),
        "important": sum(f["important"] for f in out["files"].values()),
        "duplicate_selectors_in_file": sum(len(f["duplicates"]) for f in out["files"].values()),
        "selectors_in_several_files": len(cross),
        "distinct": {k: len([v for v in c if v != "token"]) for k, c in tallies.items()},
        "token_uses": {k: c.get("token", 0) for k, c in tallies.items()},
    }
    out["values"] = {k: c.most_common() for k, c in tallies.items()}
    out["top_colours"] = allc.most_common()
    out["cross_file_selectors"] = cross
    return out


def report(a, top):
    t = a["totals"]
    lines = [f"{t['files']} CSS files, {t['lines']} lines, {t['bytes']} bytes",
             f"literal colours: {t['literal_colours']} ({t['distinct_literal_colours']} distinct); var() fallbacks: {t['fallback_colours']}",
             f"!important: {t['important']}; duplicate selectors in a file: {t['duplicate_selectors_in_file']}; selectors in several files: {t['selectors_in_several_files']}"]
    for k in ("font-size", "line-height", "padding", "margin", "radius", "control-height", "shadow", "z-index"):
        vals = a["values"].get(k, [])
        lines.append(f"{k}: {t['distinct'].get(k, 0)} distinct literal values, {t['token_uses'].get(k, 0)} token uses; top: " +
                     ", ".join(f"{v} x{n}" for v, n in vals[:top]))
    lines.append("literal colours by file:")
    for name, f in sorted(a["files"].items(), key=lambda kv: -len(kv[1]["colours"])):
        if f["colours"]:
            lines.append(f"  {name}: {len(f['colours'])}  ({', '.join(f'{c} x{n}' for c, n in Counter(f['colours']).most_common(4))})")
    return "\n".join(lines)


if __name__ == "__main__":
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    app = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 10
    if "--top" in sys.argv:
        args = [x for x in args if x != str(top)]
    result = audit(app)
    print(json.dumps(result, indent=1) if "--json" in sys.argv else report(result, top))
