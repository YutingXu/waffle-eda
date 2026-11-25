#!/usr/bin/env python3
"""Unit tests for scripts/i18n-extract.py's parsing. Run: python3 tests/maintenance/i18n-extract.py

  * DEFINE reads a whole AtriumI18n.define({...}) table: a "}" or "})" inside a string value, a
    comment, or an apostrophe-quoted string does not end the table early (it used to stop at the
    first "})", so "Filters ({count})" silently dropped every later key).
  * the key/value pairs come out with their placeholders intact.
  * keymap extraction accepts closing brackets inside quoted command options.
Prints "i18n-extract tests: ok" and exits 0, or lists the failures and exits 1.
"""
import importlib.util
import os
import re
import sys
import tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)
spec = importlib.util.spec_from_file_location("i18n_extract", os.path.join(SCRIPTS, "i18n-extract.py"))
X = importlib.util.module_from_spec(spec)
spec.loader.exec_module(X)

failures = []


def table(src):
    """[(key, English)] of every define() table in src, as the extractor reads them."""
    out = []
    for m in X.DEFINE.finditer(src):
        out += [(k, v) for k, v in re.findall(r'"([\w.-]+)"\s*:\s*' + X.STR, m.group(1))]
    return out


def check(name, got, want):
    if got != want:
        failures.append("%s:\n  got  %r\n  want %r" % (name, got, want))


check("placeholder before a closing parenthesis",
      table('const t = AtriumI18n.define({"a.filters": "Filters ({count})", "a.more": "{n} more"});'),
      [("a.filters", "Filters ({count})"), ("a.more", "{n} more")])
check("braces and parentheses inside values",
      table('AtriumI18n?.define?.({\n  "b.one": "Use {x}) or })",\n  // a comment with "quotes" and })\n  "b.two": "Two"\n})'),
      [("b.one", "Use {x}) or })"), ("b.two", "Two")])
check("escaped quotes and a block comment",
      table('globalThis.AtriumI18n.define({"c.q": "Say \\"hi\\" ({who})", /* } */ "c.r": \'ignored}\', "c.s": "S"})'),
      [("c.q", 'Say \\"hi\\" ({who})'), ("c.s", "S")])
check("two tables in one file stay separate",
      table('AtriumI18n.define({"d.a": "A ({x})"}); f(); AtriumI18n.define({"d.b": "B"});'),
      [("d.a", "A ({x})"), ("d.b", "B")])
check("an unterminated table matches nothing",
      table('AtriumI18n.define({"e.a": "A"'), [])

catalogue = X.Catalogue()
X.harvest_keymap(catalogue)
check("the shipped closing bracket tuning command is harvested",
      catalogue.messages().get("cmd.length-rounding-up"), "Length tuning: sawtooth rounding +")

with tempfile.TemporaryDirectory() as folder:
    app = os.path.join(folder, "app")
    editor = os.path.join(app, "editor")
    os.makedirs(editor)
    with open(os.path.join(editor, "keymap.js"), "w", encoding="utf-8") as f:
        f.write(r'''const BUILTIN=[
  ["right","Right","Routing",{param:"]",titles:{pcb:"Board ]"},short:"Go ]"}],
  ["single","Single","Routing",{param:']'}],
  ["escaped","Escaped","Routing",{param:"\" ] \\"}],
  ["nudge","Nudge","Routing",nudge("right",1)],
  ["after","After","Routing"],
];
const CATEGORIES=["Routing"];
''')
    old_root, old_app = X.ROOT, X.APP
    X.ROOT, X.APP = folder, app
    try:
        catalogue = X.Catalogue()
        direct_titles = X.harvest_keymap(catalogue)
        check("a parameterized command does not provide a caption for its routed action",
              direct_titles.get("nudge"), None)
        keymap = os.path.join(editor, "keymap.js")
        with open(keymap, encoding="utf-8") as f:
            src = f.read()
        with open(keymap, "w", encoding="utf-8") as f:
            f.write(src.replace('["after","After","Routing"]', '["after","After","Routing"],["after","After","Routing"]'))
        try:
            X.harvest_keymap(X.Catalogue())
        except SystemExit as error:
            check("an identical duplicate command ID is rejected", "duplicate built-in command after" in str(error), True)
        else:
            failures.append("the caption authority accepted a duplicate command ID")
    finally:
        X.ROOT, X.APP = old_root, old_app
    check("closing brackets in quoted options preserve this and later command rows",
          catalogue.messages(), {
              "category.routing": "Routing",
              "cmd.after": "After",
              "cmd.escaped": "Escaped",
              "cmd.nudge": "Nudge",
              "cmd.right": "Right",
              "cmd.right.pcb": "Board ]",
              "cmd.right.short": "Go ]",
              "cmd.single": "Single",
          })

menu = '<button role="menuitem" data-action="right" data-command-label data-scope="pcb">Old caption</button>'
check("an existing shared caption follows the command while preserving placement",
      X.project_command_labels(menu, {"right": "Board < right & up"}),
      '<button role="menuitem" data-action="right" data-command-label data-scope="pcb">Board &lt; right &amp; up</button>')
unmarked = menu.replace(" data-command-label", "")
check("a menu can supply its own context-specific label",
      X.project_command_labels(unmarked, {"right": "Different wording"}), unmarked)
check("an identical unmarked caption starts sharing the command title",
      X.project_command_labels(unmarked, {"right": "Old caption"}),
      '<button role="menuitem" data-action="right" data-scope="pcb" data-command-label>Old caption</button>')
try:
    X.project_command_labels(menu, {})
except SystemExit:
    pass
else:
    failures.append("menu projection accepted an unknown command ID")

statuses = '''
    host.info("Ready.");
    host.info(first ? "First choice." : second ? "Second choice." : "Last choice.");
    host.info(count ? "Changed " + count + (count === 1 ? " step" : " steps")
                    : "No changes (yet): continue?");
    host.info(message("Helper argument."));
    other.info("Other destination.");
'''
check("routing statuses use complete messages, including conditional branches",
      [m.group(1) for m in X.status_choices(statuses)],
      ["Ready.", "First choice.", "Second choice.", "Last choice.", "No changes (yet): continue?"])

if failures:
    print("i18n-extract tests: %d failure(s)" % len(failures))
    for f in failures:
        print(" ", f)
    sys.exit(1)
print("i18n-extract tests: ok")
