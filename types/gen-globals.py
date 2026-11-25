#!/usr/bin/env python3
"""Generate member lists for Waffle's internal JavaScript globals, and check that types/globals.d.ts declares them all.

    python3 types/gen-globals.py OUT.d.ts   # write `interface AtriumGenerated {...}` to OUT.d.ts
    python3 types/gen-globals.py --check    # every globalThis.AtriumX in app/ is declared in globals.d.ts
    python3 types/gen-globals.py --add      # add the missing ones to globals.d.ts (as AtriumGen)
    python3 types/gen-globals.py --draft    # print a `declare var` line for every global (first draft)

Each app/*.js module is a "use strict" IIFE that ends `return {a, b, c: ..., d() {...}};` (or
`return Object.freeze({...})`). The member names of that object are read here, so a typed
caller that misspells `AtriumBOM.normaliseView` fails the type check. Members are typed `any`;
modules that matter get a hand-written interface in types/*.d.ts instead. A module whose
export cannot be read this way (a spread, a variable, Object.assign...) is left out and its
global stays `any` (see AtriumGen in globals.d.ts).

scripts/typecheck.sh runs this into a temporary folder on every check, so the lists can never
go stale and nothing is written into the repository.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
# Generated bundles that repeat other modules' globals.
SKIP = {"worker-source.js"}
# A global set at the top level (members read from its IIFE) or inside a function (declared only).
ASSIGN = re.compile(r'^([ \t]*)globalThis\.(Atrium\w*)\s*=(?!=)\s*(\(\s*\(\s*\)\s*=>\s*\{|\(function\s*\(\s*\)\s*\{)?', re.M)


def scan_globals():
    """[(name, file, start offset of the IIFE body or None)] for every top-level globalThis.AtriumX = ..."""
    out = []
    directories = ('', 'analysis', 'automation', 'canvas', 'checks', 'core', 'editor', 'extension-host', 'formats', 'history', 'library', 'native-bridge', 'notebook', 'pcb', 'project', 'schematic', 'ui', 'workers')
    paths = [path for folder in directories for path in glob.glob(os.path.join(APP, folder, "*.js"))]
    for path in sorted(paths):
        base = os.path.relpath(path, APP)
        if base in SKIP:
            continue
        src = open(path, encoding="utf-8").read()
        for m in ASSIGN.finditer(src):
            out.append((m.group(2), base, src, m.end() if m.group(3) and not m.group(1) else None))
    return out


def skip_string(src, i):
    q = src[i]
    i += 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if q == "`" and c == "$" and src[i + 1:i + 2] == "{":
            i = match_brace(src, i + 1) + 1
            continue
        if c == q:
            return i + 1
        if c == "\n" and q != "`":
            return i + 1
        i += 1
    return i


REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^") | {""}


def skip_regex(src, i):
    i += 1
    cls = False
    while i < len(src):
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            cls = True
        elif c == "]":
            cls = False
        elif c == "/" and not cls:
            i += 1
            while i < len(src) and (src[i].isalpha()):
                i += 1
            return i
        elif c == "\n":
            return i + 1
        i += 1
    return i


def prev_sig(src, i):
    j = i - 1
    while j >= 0 and src[j] in " \t\r\n":
        j -= 1
    if j < 0:
        return ""
    # keywords after which a slash starts a regex
    m = re.search(r'(\w+)$', src[max(0, j - 10):j + 1])
    if m and m.group(1) in ("return", "typeof", "case", "of", "in", "void", "delete", "throw", "else", "do", "yield", "await"):
        return "("
    return src[j]


def tokens(src, i, end=None):
    """Yield (index, char) of structural characters, skipping strings, comments and regexes."""
    n = len(src) if end is None else end
    while i < n:
        c = src[i]
        if c in "\"'`":
            i = skip_string(src, i)
            continue
        if c == "/" and src[i + 1:i + 2] == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and src[i + 1:i + 2] == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and prev_sig(src, i) in REGEX_PREV:
            i = skip_regex(src, i)
            continue
        yield i, c
        i += 1


def match_brace(src, i):
    """Index of the bracket closing the one at src[i]."""
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack = []
    for j, c in tokens(src, i):
        if c in pairs:
            stack.append(pairs[c])
        elif c in ")]}":
            if not stack or stack.pop() != c:
                return -1
            if not stack:
                return j
    return -1


def exported_object(src, body):
    """Source of the object literal the IIFE body returns at depth 0, or None."""
    close = match_brace(src, body - 1)
    if close < 0:
        return None
    depth, last = 0, None
    for j, c in tokens(src, body, close):
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
        elif depth == 0 and c == "r" and src.startswith("return", j) and not (src[j - 1].isalnum() or src[j - 1] in "_$."):
            last = j
    if last is None:
        return None
    rest = src[last + 6:close].lstrip()
    m = re.match(r'(?:Object\.freeze\s*\(\s*)?\{', rest)
    if not m:
        return None
    start = last + 6 + (len(src[last + 6:close]) - len(rest)) + m.end() - 1
    end = match_brace(src, start)
    return None if end < 0 else src[start + 1:end]


def members(obj):
    """Top-level member names of an object literal body, or None when it has a spread."""
    names, depth, seg_start, parts = [], 0, 0, []
    for j, c in tokens(obj, 0):
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(obj[seg_start:j])
            seg_start = j + 1
    parts.append(obj[seg_start:])
    for part in parts:
        p = re.sub(r'//[^\n]*|/\*.*?\*/', "", part, flags=re.S).strip()
        if not p:
            continue
        if p.startswith("..."):
            return None
        m = (re.match(r'(?:async\s+)?\*?\s*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:$|:|\()', p)
             or re.match(r'["\']([^"\']+)["\']\s*:', p))
        if not m:
            return None
        if m.group(1) not in names:
            names.append(m.group(1))
    return names


def generate():
    seen, lines = set(), []
    for name, base, src, body in scan_globals():
        if name in seen:
            continue
        seen.add(name)
        obj = exported_object(src, body) if body is not None else None
        names = members(obj) if obj is not None else None
        if names is None:
            continue
        fields = " ".join(f'"{n}": any;' if not re.match(r'^[A-Za-z_$][\w$]*$', n) else f"{n}: any;" for n in names)
        lines.append(f"  /** app/{base} */\n  {name}: {{{fields}}};")
    # A hand-typed global must name exactly the members its module exports: a member the module
    # gained or lost fails here even while the module itself is not type checked.
    checks = []
    for name, iface in sorted(hand_typed().items()):
        if name in seen and any(l.startswith(f"  {name}: ") for l in "\n".join(lines).split("\n")):
            checks.append(f'type AtriumExportCheck_{name} = [\n'
                          f'  AtriumExpectNone<"{name} exports members {iface} lacks", Exclude<keyof AtriumGenerated["{name}"], keyof {iface}>>,\n'
                          f'  AtriumExpectNone<"{iface} declares members {name} does not export", Exclude<AtriumKnownKeys<{iface}>, keyof AtriumGenerated["{name}"]>>];')
    # The native bridge (native/bridge.js) must not gain a member AtriumHostAPI lacks. Members only
    # some hosts provide (openURL, launchDiff...) are optional there, so the other direction is free.
    bridge = os.path.join(ROOT, "native", "bridge.js")
    if os.path.exists(bridge):
        bsrc = open(bridge, encoding="utf-8").read()
        m = re.search(r'window\.AtriumHost\s*=\s*Object\.freeze\(\{', bsrc)
        end = match_brace(bsrc, m.end() - 1) if m else -1
        names = members(bsrc[m.end():end]) if end > 0 else None
        if names:
            union = " | ".join(f'"{n}"' for n in names)
            checks.append(f'type AtriumExportCheck_AtriumHost = AtriumExpectNone<"native/bridge.js provides members AtriumHostAPI lacks", '
                          f'Exclude<{union}, keyof AtriumHostAPI>>;')
    # Globals not yet in globals.d.ts are declared here so a new module never breaks the check;
    # --check (a note in scripts/typecheck.sh) and --add list and add them.
    have = declared()
    missing = [f'declare var {n}: AtriumGen<"{n}">; // app/{b}, not yet in types/globals.d.ts'
               for n, b in sorted({(n, b) for n, b, _, _ in scan_globals() if n not in have})]
    return ("// Generated by types/gen-globals.py from the app/*.js exports. Do not edit.\n"
            + "\n".join(missing) + "\n"
            "interface AtriumGenerated {\n" + "\n".join(lines) + "\n}\n"
            "type AtriumKnownKeys<T> = keyof {[K in keyof T as string extends K ? never : number extends K ? never : K]: 0};\n"
            "type AtriumExpectNone<Message extends string, Keys extends never> = [Message, Keys];\n" + "\n".join(checks) + "\n")


def hand_typed():
    """{global: interface} for globals declared with their own interface rather than AtriumGen."""
    text = "\n".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(ROOT, "types", "*.d.ts")))
    return {n: t for n, t in re.findall(r'^\s*declare\s+var\s+(Atrium\w*)\s*:\s*(\w+)\s*;', text, re.M) if n != "AtriumHost"}


def declared():
    text = "\n".join(open(p, encoding="utf-8").read() for p in glob.glob(os.path.join(ROOT, "types", "*.d.ts")))
    return set(re.findall(r'^\s*(?:declare\s+)?var\s+(Atrium\w*)\s*:', text, re.M))


def main():
    args = sys.argv[1:]
    if args == ["--check"]:
        have = declared()
        globals_found = scan_globals()
        if not any(name == "Atrium" for name, _, _, _ in globals_found):
            sys.exit("gen-globals: could not find the core JavaScript namespace in app/core/model.js")
        missing = sorted({(n, b) for n, b, _, _ in globals_found if n not in have})
        for n, b in missing:
            print(f'types/globals.d.ts lacks app/{b}\'s global; add:  declare var {n}: AtriumGen<"{n}">;')
        if missing:
            sys.exit(1)
        print(f"gen-globals: every app global is declared ({len(have)})")
    elif args == ["--add"]:
        path = os.path.join(ROOT, "types", "globals.d.ts")
        text = open(path, encoding="utf-8").read().split("\n")
        have = declared()
        new = sorted({(n, b) for n, b, _, _ in scan_globals() if n not in have})
        if not new:
            print("gen-globals: nothing to add")
            return
        anchors = [(i, match[1].lower()) for i, line in enumerate(text)
                   if (match := re.match(r'declare var (Atrium\w*): .*// app/', line))]
        insertions = {}
        for name, source in sorted(new, key=lambda item: item[0].lower()):
            index = next((i for i, existing in anchors if existing > name.lower()), anchors[-1][0] + 1)
            insertions.setdefault(index, []).append(f'declare var {name}: AtriumGen<"{name}">; // app/{source}')
        for index, declarations in sorted(insertions.items(), reverse=True):
            text[index:index] = declarations
        open(path, "w", encoding="utf-8").write("\n".join(text))
        print("gen-globals: added " + ", ".join(n for n, _ in new))
    elif args == ["--draft"]:
        done = set()
        for n, b, _, _ in scan_globals():
            if n not in done:
                done.add(n)
                print(f'declare var {n}: AtriumGen<"{n}">; // app/{b}')
    elif len(args) == 1 and not args[0].startswith("-"):
        with open(args[0], "w", encoding="utf-8") as f:
            f.write(generate())
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
