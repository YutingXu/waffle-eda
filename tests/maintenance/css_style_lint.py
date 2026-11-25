"""Lint authored CSS declarations, including literal styles in editor markup and JS."""

from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from html import unescape
import json
from pathlib import Path
import re
import subprocess

CSS_STRING = r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"""
CSS_COMMENT = r"/\*[\s\S]*?\*/"
CSS_BOUNDARY = re.compile(rf"{CSS_COMMENT}|{CSS_STRING}|\\.|[()[\]{{}};]", re.S)
CSS_PROP = r"-?[a-zA-Z][\w-]*|--[\w-]+"
CSS_DECL = re.compile(rf"\s*(?P<prop>{CSS_PROP})\s*:\s*(?P<value>\S[\s\S]*)")
CSS_URL = rf"(?<![\w-])url\(\s*(?:{CSS_STRING}|(?:\\.|[^'\"()])*)\s*\)"
VALUE_TEXT = re.compile(rf"{CSS_URL}|{CSS_STRING}", re.I)
HEX = re.compile(r"(?<![\w-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])", re.I)
COLOUR_FORMATS = {"rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"}
COLOUR_NAMES = set(
    "white black red green blue yellow orange gray grey silver maroon navy purple teal lime aqua "
    "fuchsia olive pink gold cyan magenta".split()
)
VALUE_WORD = re.compile(r"(?<![\w-])[-a-zA-Z][\w-]*")
NUMBER = r"[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?"
LENGTH_UNITS = (
    r"cm|mm|q|in|pc|pt|px|em|ex|cap|ch|ic|rem|rex|rcap|rch|ric|lh|rlh|"
    r"(?:s|l|d)?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|%"
)
DIMENSION = re.compile(rf"(?<![\w.-])(?P<number>{NUMBER})(?:{LENGTH_UNITS})(?![\w-])", re.I)
RADIUS = re.compile(r"(?:^|-)radius$")
SHADOW = re.compile(r"(?:^|-)shadow$")
SHADOW_TOKEN = re.compile(r"^--(?:elev-|shadow-|.+-shadow(?:-|$))")
RADIUS_TOKEN = re.compile(r"^--(?:r-|radius(?:-|$)|.+-radius(?:-|$))")
VAR_REF = re.compile(r"(?<![\w-])var\(\s*(--[\w-]+)", re.I)
FILTERS = {"filter", "-webkit-filter", "backdrop-filter", "-webkit-backdrop-filter"}
THEME_SELECTOR = r""":root\[data-theme\s*=\s*(?P<quote>['"]?)(?:light|hc|classic)(?P=quote)\]"""
SEVERITY_TOKENS = {"--msg-fatal", "--msg-error", "--erc-none", "--erc-warning", "--erc-error", "--erc-fatal"}
PLOT_TOKENS = {f"--ext-plot-{index}" for index in range(8)}

JS_STRING = r"""(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`)"""
JS_PART = re.compile(rf"{CSS_COMMENT}|//[^\r\n]*|(?P<string>{JS_STRING})", re.S)
JS_ESCAPE = re.compile(r"\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\s\S]))")
JS_INTERPOLATION = re.compile(r"\$\{[^{}]*\}")
STYLE_ATTR = re.compile(
    r"""<(?P<tag>[a-z][\w:-]*)\b(?P<before>(?:[^<>'"]|"[^"]*"|'[^']*')*?)"""
    r"""\s+style\s*=\s*(?:"(?P<double>[^"]*)"|'(?P<single>[^']*)'|(?P<plain>[^\s>]+))""",
    re.I,
)
STYLE_ELEMENT = re.compile(r"<style\b[^>]*>(?P<css>.*?)</style\s*>", re.I | re.S)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
SCRIPT_ELEMENT = re.compile(r"<script\b[^>]*>(?P<js>.*?)</script\s*>", re.I | re.S)
CSS_RULE_START = re.compile(r"""\s*(?:[@.#:[&]|[a-z][\w-]*(?=[\s.#:{\[]))""", re.I)
INLINE_START = re.compile(
    r"(?:--[\w-]+|(?:-webkit-)?(?:background|border|color|outline|box-shadow|text-shadow|"
    r"filter|fill|stroke|width|height|display|padding|margin|position|font)[\w-]*)\s*:",
    re.I,
)
CSSOM = re.compile(
    rf"""(?P<target>[\w.$]+)\s*\.\s*style\s*(?:=(?!=)|"""
    rf"""\.\s*(?P<dotted>[\w$]+)\s*=(?!=)|"""
    rf"""\[\s*['"](?P<bracketed>[\w-]+)['"]\s*\]\s*=(?!=)|"""
    rf"""\.\s*setProperty\(\s*['"](?P<set>{CSS_PROP})['"]\s*,)\s*$"""
)
SET_STYLE = re.compile(r"""(?P<target>[\w.$]+)\.setAttribute\(\s*['"]style['"]\s*,\s*$""")
OBJECT_STYLE = re.compile(r"Object\.assign\(\s*(?P<target>[\w.$]+)\.style\s*,\s*\{[^{}]*$")
OBJECT_PROP = re.compile(r"""(?:[{,])\s*['"]?(?P<prop>[\w-]+)['"]?\s*:\s*$""")
STYLE_DATA_ATTR = re.compile(r"""(?:^|\s)(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))""", re.I)

# Only authored sources. These bundles are checked against their sources separately in CI.
GENERATED = {
    "app/calculation-worker-source.js",
    "app/engine-core.js",
    "app/extensions/bundled.js",
    "app/folder-copper-worker-source.js",
    "app/folder-project-worker-source.js",
    "app/ui/connection-card.js",
    "app/worker-source.js",
}
SOURCE_ROOTS = ("app/", "extensions/", "integrations/vscode/", "ui/")


@dataclass(frozen=True)
class Declaration:
    context: tuple
    prop: str
    value: str
    line: int


def blank(match):
    return re.sub(r"[^\n]", " ", match[0])


def collapse(text):
    return " ".join(text.split())


def css_property(prop):
    return prop if prop.startswith("--") else prop.lower()


def declarations(css, context=(), first_line=1):
    """Read CSS blocks and declaration lists without splitting quoted or functional values."""
    css = re.sub(rf"{CSS_STRING}|{CSS_COMMENT}", lambda m: blank(m) if m[0].startswith("/*") else m[0], css)
    blocks = list(context)
    depth, start = 0, 0
    for match in CSS_BOUNDARY.finditer(css):
        token = match[0]
        if token in ("(", "["):
            depth += 1
        elif token in (")", "]"):
            depth -= 1
        elif not depth and token in ("{", "}", ";"):
            item = css[start:match.start()]
            if token == "{":
                blocks.append(collapse(item))
            else:
                decl = CSS_DECL.fullmatch(item)
                if decl:
                    yield Declaration(tuple(blocks), css_property(decl["prop"]), decl["value"].strip(),
                                      first_line + css.count("\n", 0, start + decl.start("prop")))
                if token == "}" and len(blocks) > len(context):
                    blocks.pop()
            start = match.end()
    decl = CSS_DECL.fullmatch(css[start:])
    if decl:
        yield Declaration(tuple(blocks), css_property(decl["prop"]), decl["value"].strip(),
                          first_line + css.count("\n", 0, start + decl.start("prop")))


def functions(value):
    """Yield (function name, start, end, body) for balanced functions at any depth."""
    stack = []
    for match in re.finditer(r"(?<![\w-])([a-zA-Z][\w-]*)\(|[()]", value):
        if match[0] == ")":
            if stack:
                name, start, contents = stack.pop()
                if name:
                    yield name, start, match.end(), value[contents:match.start()]
        else:
            stack.append((match[1].lower() if match[1] else None, match.start(), match.end()))


def literal_geometry(value, is_shadow):
    if is_shadow:
        # Colour percentages in a shadow are independent of the shadow's geometry.
        masked = list(value)
        for fn, start, end, _ in functions(value):
            if fn in COLOUR_FORMATS or fn in {"color-mix", "light-dark"}:
                masked[start:end] = " " * (end - start)
        value = "".join(masked)
    return any(float(match["number"]) != 0 for match in DIMENSION.finditer(value))


def canonical_tokens(path, decl):
    if not decl.prop.startswith("--"):
        return False
    if path == "app/style.css":
        return decl.context == (":root",)
    if path == "app/editor/theme.css" and len(decl.context) == 1:
        selector = decl.context[0]
        if re.fullmatch(THEME_SELECTOR, selector):
            return True
        if decl.prop in SEVERITY_TOKENS and re.fullmatch(THEME_SELECTOR + r" :is\(\.msg-panel,\s*\.erc-options\)", selector):
            return True
    if path == "app/checks/erc.css" and decl.prop in SEVERITY_TOKENS:
        return decl.context == (".msg-panel,.erc-options",)
    return path == "app/extension-host/extensions.css" and decl.context == (":root",) and decl.prop in PLOT_TOKENS


def geometry_roles(prop):
    roles = set()
    if RADIUS.search(prop) or RADIUS_TOKEN.search(prop):
        roles.add("radius")
    if SHADOW.search(prop) or SHADOW_TOKEN.search(prop):
        roles.add("shadow")
    return roles


def geometry_aliases(decls):
    """Follow local aliases so a custom property cannot hide a literal radius or shadow."""
    definitions = defaultdict(list)
    pending = deque()
    for decl in decls:
        refs = VAR_REF.findall(decl.value)
        if not refs:
            continue
        if decl.prop.startswith("--"):
            definitions[decl.prop].extend(refs)
        for role in geometry_roles(decl.prop):
            pending.extend((ref, role) for ref in refs)
        if decl.prop in FILTERS:
            for name, _, _, body in functions(decl.value):
                if name == "drop-shadow":
                    pending.extend((ref, "shadow") for ref in VAR_REF.findall(body))
    aliases = defaultdict(set)
    while pending:
        prop, role = pending.popleft()
        if role not in aliases[prop]:
            aliases[prop].add(role)
            pending.extend((ref, role) for ref in definitions[prop])
    return aliases


def violations(path, decl, aliases):
    if canonical_tokens(path, decl):
        return ()
    value = VALUE_TEXT.sub(" ", decl.value)
    messages = []
    if HEX.search(value) or any(word[0].lower() in COLOUR_NAMES for word in VALUE_WORD.finditer(value)) or any(
        name in COLOUR_FORMATS and not re.match(r"\s*from\b", body, re.I) and "var(" not in body.lower()
        for name, _, _, body in functions(value)
    ):
        messages.append("literal colour; use a theme token")
    roles = geometry_roles(decl.prop) | aliases.get(decl.prop, set())
    if "radius" in roles:
        if literal_geometry(value, False):
            messages.append("literal radius; use a radius token")
    if "shadow" in roles:
        if literal_geometry(value, True):
            messages.append("literal shadow; use elevation or control tokens")
    if decl.prop in FILTERS:
        if any(name == "drop-shadow" and literal_geometry(body, True) for name, _, _, body in functions(value)):
            messages.append("literal drop shadow; use tokens")
    return tuple(messages)


def markup_declarations(source, first_line=1):
    source = HTML_COMMENT.sub(blank, source)
    for style in STYLE_ELEMENT.finditer(source):
        line = first_line + source.count("\n", 0, style.start("css"))
        yield from declarations(style["css"], ("<style>",), line)
    for style in STYLE_ATTR.finditer(source):
        key = next(name for name in ("double", "single", "plain") if style[name] is not None)
        attrs = [" ".join(v for v in m.groups() if v) for m in STYLE_DATA_ATTR.finditer(style["before"])]
        target = " ".join([style["tag"].lower(), *attrs])
        line = first_line + source.count("\n", 0, style.start(key))
        yield from declarations(unescape(style[key]), (f"<{target} style>",), line)


def js_text(token):
    def decode(match):
        for code in match.groups()[:3]:
            if code:
                return chr(int(code, 16))
        char = match[4]
        return {"n": "\n", "r": "\r", "t": "\t", "\n": "", "\r": "", "\r\n": ""}.get(char, char)

    text = JS_ESCAPE.sub(decode, token[1:-1])
    return JS_INTERPOLATION.sub("__dynamic__", text) if token[0] == "`" else text


def js_property(prop):
    if prop.startswith("--"):
        return prop
    prop = re.sub(r"[A-Z]", lambda m: "-" + m[0].lower(), prop)
    return "-" + prop if prop.startswith(("webkit-", "moz-", "ms-")) else prop


def js_declarations(source, first_line=1):
    parts = [m for m in JS_PART.finditer(source) if m["string"] is not None]
    index = 0
    while index < len(parts):
        part = parts[index]
        index += 1
        value = js_text(part["string"])
        # Static concatenations are common in the editor's generated HTML reports.
        end = part.end()
        while index < len(parts) and re.fullmatch(r"\s*\+\s*", source[end:parts[index].start()]):
            value += js_text(parts[index]["string"])
            end = parts[index].end()
            index += 1
        prefix = source[max(0, part.start() - 500):part.start()]
        if ".style" not in prefix and ".setAttribute" not in prefix and "#" not in value and not re.search(
            r"shadow|radius|\b(?:rgba?|hsla?|hwb|oklab|oklch|lab|lch|color)\(", value, re.I
        ):
            continue
        line = first_line + source.count("\n", 0, part.start())
        cssom = CSSOM.search(prefix)
        setter = SET_STYLE.search(prefix)
        object_style = OBJECT_STYLE.search(prefix)
        object_prop = OBJECT_PROP.search(prefix) if object_style else None
        prop = (cssom["dotted"] or cssom["bracketed"] or cssom["set"]) if cssom else None
        if cssom and prop and prop != "cssText":
            yield Declaration((f"{cssom['target']}.style",), js_property(prop), value, line)
        elif object_prop:
            yield Declaration((f"{object_style['target']}.style",), js_property(object_prop["prop"]), value, line)
        elif cssom or setter:
            target = (cssom or setter)["target"]
            yield from declarations(value, (f"{target}.style",), line)
        elif re.match(r"\s*<[a-z!/]", value, re.I):
            yield from markup_declarations(value, line)
            # A dynamic title or opening tag can separate the CSS from its <style> element.
            fragment = re.search(r"<style\b[^>]*>(.+)$", value, re.I | re.S)
            if fragment and not re.search(r"</style\s*>", fragment[1], re.I):
                yield from declarations(fragment[1], ("<style>",), line + value.count("\n", 0, fragment.start(1)))
        elif re.match(r"\s*style\s*=", value, re.I):
            yield from markup_declarations("<fragment " + value, line)
        elif "{" in value and CSS_RULE_START.match(value):
            yield from declarations(re.split(r"</style\s*>", value, maxsplit=1, flags=re.I)[0], ("JS stylesheet",), line)
        elif INLINE_START.match(value.lstrip()):
            yield from declarations(value, ("JS declaration list",), line)


def style_declarations(path, source):
    suffix = Path(path).suffix
    if suffix in {".css", ".scss", ".less"}:
        yield from declarations(source)
    elif suffix in {".html", ".svelte"}:
        source = HTML_COMMENT.sub(blank, source)
        for script in SCRIPT_ELEMENT.finditer(source):
            yield from js_declarations(script["js"], 1 + source.count("\n", 0, script.start("js")))
        yield from markup_declarations(SCRIPT_ELEMENT.sub(blank, source))
    else:
        yield from js_declarations(source)


def authored(path):
    suffix = Path(path).suffix
    if suffix in {".css", ".scss", ".less"}:
        return "/vendor/" not in path
    return (
        path.startswith(SOURCE_ROOTS)
        and suffix in {".js", ".mjs", ".cjs", ".html", ".svelte"}
        and path not in GENERATED
        and not path.startswith(("app/vendor/", "app/locales/", "app/extensions/packages/"))
    )


def sources(root, app):
    if app != root / "app":
        for file in sorted(app.rglob("*")):
            path = "app/" + file.relative_to(app).as_posix()
            if file.is_file() and authored(path):
                yield path, file.read_text(encoding="utf8")
        return
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root
    ).decode().split("\0")
    for path in sorted(set(paths)):
        if authored(path) and (root / path).is_file():
            yield path, (root / path).read_text(encoding="utf8")


def findings(path, source):
    decls = list(style_declarations(path, source))
    aliases = geometry_aliases(decls)
    for decl in decls:
        problems = violations(path, decl, aliases)
        if problems:
            yield (" / ".join(decl.context), decl.prop, collapse(decl.value)), decl.line, problems


def check_source(path, source, legacy):
    expected = Counter(map(tuple, legacy))
    problems = []
    for key, line, messages in findings(path, source):
        if expected[key]:
            expected[key] -= 1
        else:
            context, prop, value = key
            location = f"{context} " if context else ""
            problems.append(f"{path}:{line}: {location}{{{prop}: {value}}}: " + "; ".join(messages))
    for context, prop, value in expected.elements():
        problems.append(f"{path}: remove the obsolete legacy exception for {context} {{{prop}: {value}}}")
    return problems


def check(root, app, legacy_path):
    legacy = json.loads(legacy_path.read_text(encoding="utf8"))
    problems = []
    for path, source in sources(root, app):
        problems.extend(check_source(path, source, legacy.pop(path, [])))
    for path in legacy:
        if app == root / "app" or path.startswith("app/"):
            problems.append(f"{path}: remove its obsolete legacy style exceptions")
    return problems


def self_test():
    css = """
      /* .comment { background: #bad; border-radius: 8px } */
      :root { --panel: #abc; --r-md: 4px; --elev-1: 0 2px 8px var(--panel) }
      #abc { background: url("data:image/svg+xml;#abc"); content: "#abc"; color: var(--status-red);
        --motion-drag-shadow: 120ms;
        outline: 1px solid currentColor; border-radius: var(--r-md) 0 / calc(2 * var(--r-md)) 0%;
        box-shadow: var(--elev-1, none), 0 0 var(--focus-w) color-mix(in srgb, var(--focus) 40%, transparent);
        filter: drop-shadow(var(--elev-1)) brightness(125%); rx: 5px; }
      @supports selector(:has(> a)) {
        .card {
          background: linear-gradient(var(--panel), var(--strong, #ababcdff));
          outline: 1px solid #abc;
          border-end-end-radius: var(--r-md, .5rem);
          border-radius: 0 50%;
          box-shadow: var(--elev-2, 0 2vh 0 var(--panel));
          filter: brightness(120%) drop-shadow(0 1px var(--panel));
          & > a { color: #DADADA; text-shadow: 1px 0 currentColor }
        }
      }
      .card { --local: #abcd; --card-radius: 2px; --card-shadow: 1px 0 currentColor;
        --custom: var(--other); --other: 2px; border-radius: var(--custom);
        --depth: 0 1px currentColor; box-shadow: var(--depth); }
    """
    expect = Counter({
        "background": 1, "outline": 1, "border-end-end-radius": 1, "border-radius": 1, "box-shadow": 1,
        "filter": 1, "color": 1, "text-shadow": 1, "--local": 1, "--card-radius": 1, "--card-shadow": 1,
        "--other": 1, "--depth": 1,
    })
    assert Counter(key[1] for key, _, _ in findings("app/style.css", css)) == expect
    assert len(list(findings("app/editor/theme.css", ":root[data-theme=light] { --panel: #fff; color: #bbb }"))) == 1

    html = """<!-- <div style="color:#abc"></div> -->
      <style>.m { background-color: #abcd; }</style>
      <i aria-label="a > b" style="border-top-left-radius: 4px"></i>
      <button style="border-end-end-radius: 20%"></button>
      <svg><rect rx="5" fill="#fff" stroke="#123"></rect></svg>
    """
    assert [key[1] for key, _, _ in findings("app/index.html", html)] == [
        "background-color", "border-top-left-radius", "border-end-end-radius",
    ]
    js = r"""
      // node.style.borderRadius = "3px";
      const decorate = '<span class="x" style="color: #abc">label</span>';
      const css = ".c{outline:" + "1px solid #ABC}";
      node.style.borderRadius = "9px";
      node.style = "vertical-align: middle; border-radius: 2px";
      node.style["boxShadow"] = "0 2px var(--shadow-sm)";
      node.style["cssText"] = "border-radius: 1em";
      node.style.setProperty("border-top-left-radius", "3vh");
      node.style.setProperty("--depth", "3vw");
      node.style.boxShadow = "0 0 var(--depth) currentColor";
      node.setAttribute("style", "color:\x23abc");
      Object.assign(node.style, { textShadow: "0 1px currentColor" });
      node.style.color = layer.colour;
      ctx.fillStyle = "#abc";
      const pad = { colour: "#aabbcc", radius: 1.2 };
      draw({ style: "border-radius: var(--r-lg)" });
    """
    expect = Counter({"color": 2, "outline": 1, "border-radius": 3,
                      "box-shadow": 1, "border-top-left-radius": 1, "text-shadow": 1, "--depth": 1})
    assert Counter(key[1] for key, _, _ in findings("app/sample.js", js)) == expect

    css = ".card { border-radius: 2px; }"
    legacy = [(".card", "border-radius", "2px")]
    assert not check_source("app/sample.css", css, legacy)
    assert len(check_source("app/sample.css", css * 2, legacy)) == 1
    assert len(check_source("app/sample.css", "", legacy)) == 1
