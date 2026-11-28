"""Guard authored shortcut presentation at DOM, HTML, and CSS render sites.

Menu commands name a keymap `action` and never their own key: a `{label, shortcut}` entry would show a
key that the keymap does not run, cannot rebind and docs/shortcuts.md does not list."""

from html.parser import HTMLParser
from pathlib import Path
import re

from css_style_lint import JS_PART, SCRIPT_ELEMENT, blank, declarations, js_text, sources

RENDERER = "app/ui/shortcut.js"
MOD = r"(?:Ctrl|Control|Cmd|Command|Meta|Super|Option|Opt|Alt|Shift|Win|Windows)"
KEY = r"(?:[A-Za-z0-9]+|[+./,;=\[\]\\'\x60_-]|[⇥↩⎋⌫⌦↑↓←→␣])"
PHYSICAL_KEY = r"(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Esc(?:ape)?|Enter|Return|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Left|Right|Up|Down)|[+./,;=\[\]\\'\x60_⇥↩⎋⌫⌦↑↓←→␣-])"
CHORD = rf"(?:(?:{MOD}\s*\+\s*)+{KEY}|[⌘⌃⌥⇧]+\s*{KEY})"
BINDING = re.compile(rf"{CHORD}(?:[\s,]+(?:{CHORD}|{PHYSICAL_KEY}))*", re.I)
SINGLE = re.compile(rf"(?:{PHYSICAL_KEY}|[⌘⌃⌥⇧])", re.I)
BADGE = re.compile(r"(?:^|\s)(?:[\w-]+-)?(?:shortcut|hotkey|keycap|keys?)(?:-[\w-]+)?(?:\s|$)", re.I)
BADGE_SITE = re.compile(r"""["'](?:[\w-]+-)?(?:shortcut|hotkey|keycap|keys?)(?:-[\w-]+)?(?=["'\s])""", re.I)
TAG = re.compile(r"<[a-z][\w:-]*(?:\s|/?>)", re.I)
CREATE_KBD = re.compile(r"""\b(?:createElement|createElementNS|el|element|mk|node|h)\s*\(\s*(?:["']http://www\.w3\.org/1999/xhtml["']\s*,\s*)?$""")
BRACKET_KBD = re.compile(r"""\[\s*["']createElement["']\s*\]\s*\(\s*$""")
DIRECT_OUTPUT = re.compile(r"""\b(?:textContent|innerText|outerText|innerHTML|outerHTML|title)\s*=(?!=)\s*(?:t\(\s*)?$""")
APPEND = re.compile(r"""\.\s*(?:append|prepend|insertAdjacentText)\(\s*(?:["']\w+["']\s*,\s*)?$""")
NODE_OUTPUT = re.compile(r"""\b(?:el|element|mk|node|h)\(\s*["'](?:span|label|small|b|em|div|button|p|a)["']\s*,\s*(?:t\(\s*)?$""")
ATTR_OUTPUT = re.compile(r"""\bsetAttribute\(\s*["']title["']\s*,\s*$""")
CSS_BADGE = re.compile(r"\.(?:[\w-]+-)?(?:shortcut|hotkey|keycap|key)(?![\w-])", re.I)
SPLIT_KBD = re.compile(r"(?<![\w.#-])kbd(?=$|[\s.#:\[>+~),])", re.I)
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP_TEXT = {"script", "style", "code", "pre", "textarea", "select"}
MENU_SHORTCUT = re.compile(r"(?<![\w$.])shortcut\s*:")
MENU_LABEL = re.compile(r"(?<![\w$.])label\s*:")
MENU_ADVICE = ("a menu command names its own key. Give it the keymap `action` instead "
               "(register a list's keys with AtriumKeymap.registerCommand `focus`, as app/lazy.js LIST_COMMANDS does)")


def handwritten(text, badge=False):
    text = text.strip()
    if not text:
        return False
    if BINDING.fullmatch(text):
        return True
    return badge and len(text) <= 20 and bool(SINGLE.fullmatch(text))


class Markup(HTMLParser):
    def __init__(self, first_line):
        super().__init__()
        self.first_line = first_line
        self.stack = []
        self.problems = []

    def handle_starttag(self, tag, attrs):
        if tag == "kbd":
            self.problems.append((self.first_line + self.getpos()[0] - 1, "handwritten <kbd>"))
        if tag not in VOID:
            self.stack.append((tag, bool(BADGE.search(dict(attrs).get("class") or ""))))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.stack and not any(tag in SKIP_TEXT or tag == "kbd" for tag, _ in self.stack):
            if handwritten(data, self.stack[-1][1]):
                self.problems.append((self.first_line + self.getpos()[0] - 1, "handwritten shortcut label " + repr(data.strip())))


def markup(source, line):
    parser = Markup(line)
    # HTMLParser's SGML-only marked sections can throw on source XML fragments.
    parser.feed(re.sub(r"<!\[[\s\S]*?\]>", blank, source))
    parser.close()
    return parser.problems


def javascript(source, first_line):
    literals = [part for part in JS_PART.finditer(source) if part["string"] is not None]
    index = 0
    while index < len(literals):
        match = literals[index]
        index += 1
        value, end = js_text(match["string"]), match.end()
        while index < len(literals) and re.fullmatch(r"\s*\+\s*", source[end:literals[index].start()]):
            value += js_text(literals[index]["string"])
            end = literals[index].end()
            index += 1
        if "<" not in value and "+" not in value and not (
            value.lower() == "kbd" or any(glyph in value for glyph in "⌘⌃⌥⇧") or SINGLE.fullmatch(value)
        ):
            continue
        prefix = source[max(0, match.start() - 160):match.start()]
        line = first_line + source.count("\n", 0, match.start())
        if value.lower() == "kbd" and (CREATE_KBD.search(prefix) or BRACKET_KBD.search(prefix)):
            yield line, "handwritten kbd constructor"
        if TAG.search(value):
            yield from markup(value, line)
        if not any(sink.search(prefix) for sink in (DIRECT_OUTPUT, APPEND, NODE_OUTPUT, ATTR_OUTPUT)):
            continue
        adjacent = source[end:end + 130]
        if handwritten(value, bool(BADGE_SITE.search(prefix + adjacent))):
            yield line, "handwritten shortcut label " + repr(value)


def code_only(source):
    """Blank comments and string contents, keeping offsets and quotes."""
    def keep(match):
        if match["string"] is None:
            return blank(match)
        text = match[0]
        return text[0] + re.sub(r"[^\n]", " ", text[1:-1]) + text[-1]
    return JS_PART.sub(keep, source)


def enclosing_object(code, at):
    """The object literal around offset `at`, or None when the nearest open bracket is not a brace."""
    depth, start = 0, None
    for i in range(at - 1, -1, -1):
        if code[i] in ")]}":
            depth += 1
        elif code[i] in "([{":
            if depth:
                depth -= 1
                continue
            start = i if code[i] == "{" else None
            break
    if start is None:
        return None
    depth = 0
    for j in range(start, len(code)):
        if code[j] in "([{":
            depth += 1
        elif code[j] in ")]}":
            depth -= 1
            if not depth:
                return code[start:j + 1]
    return code[start:]


def menu_shortcuts(source):
    """Lines of menu command objects (they have a `label`) that also name a `shortcut`."""
    code = code_only(source)
    for match in MENU_SHORTCUT.finditer(code):
        obj = enclosing_object(code, match.start())
        if obj is not None and MENU_LABEL.search(obj):
            yield 1 + code.count("\n", 0, match.start())


def problems(path, source):
    if not path.startswith("app/") or path == RENDERER:
        return
    suffix = Path(path).suffix
    if suffix == ".js":
        yield from javascript(source, 1)
    elif suffix == ".html":
        for script in SCRIPT_ELEMENT.finditer(source):
            yield from javascript(script["js"], 1 + source.count("\n", 0, script.start("js")))
        yield from markup(SCRIPT_ELEMENT.sub(blank, source), 1)
    elif suffix == ".css":
        selectors = set()
        for row in declarations(source):
            if row.context and SPLIT_KBD.search(row.context[-1]) and row.context not in selectors:
                selectors.add(row.context)
                yield row.line, "style the shared .ui-shortcut class instead of a kbd tag"
            if row.prop == "content" and row.value[:1] in {'"', "'"}:
                badge = bool(row.context and CSS_BADGE.search(row.context[-1]))
                if handwritten(row.value[1:-1], badge):
                    yield row.line, "handwritten shortcut label in CSS content"


def check(root, app):
    out = []
    for path, text in sources(root, app):
        out += [f"{path}:{line}: {message}. Use AtriumShortcut.render." for line, message in problems(path, text)]
        if path.startswith("app/") and path.endswith(".js"):
            out += [f"{path}:{line}: {MENU_ADVICE}." for line in menu_shortcuts(text)]
    return out


def self_test():
    bad = r"""
      const badge = el("kbd", "F10");
      other.textContent = "Ctrl+Shift+S";
      pane.append("⌘S");
      element["createElement"]("KBD");
      pane.innerHTML = "<span>Alt+F4</span>";
      pane.innerHTML = "<span class='hint-key'>Esc</span>";
      pane.innerHTML = "<span>" + "Ctrl+K" + "</span>";
    """
    good = r"""
      // createElement("kbd");
      const key = "Escape";
      const bindings = [["Ctrl+S", "save"], ["⌘S", "save"]];
      const query = document.querySelector("kbd");
      if (event.key === "Enter") cancel();
      node.textContent = "Press Ctrl+S to save";
      node.setAttribute("aria-keyshortcuts", "Control+S");
      button.append(AtriumShortcut.render("Escape"));
    """
    assert len(list(problems("app/example.js", bad))) == 7
    assert not list(problems("app/example.js", good))
    assert not list(problems(RENDERER, bad))
    assert len(list(problems("app/index.html", "<kbd>F1</kbd><span>⇧⌘S</span>"))) == 2
    assert len(list(problems("app/example.css", 'kbd.key{padding:0}.x::after{content:"Ctrl+S"}'))) == 2
    menus_bad = r"""
      M.popup(ctx, [{label: "Rename", run: () => { rename(); }, shortcut: "F2"},
        {shortcut: "Mod+D", enabled: ok, label: "Duplicate"}]);
    """
    menus_good = r"""
      M.popup(ctx, [{label: "Rename", action: "views-rename", run: () => { rename(); }}]);
      const [before, after] = t(id, {shortcut: marker}).split(marker);
      // {label: "Rename", shortcut: "F2"}
      const doc = "{label: 'Rename', shortcut: 'F2'}";
    """
    assert list(menu_shortcuts(menus_bad)) == [2, 3]
    assert not list(menu_shortcuts(menus_good))
