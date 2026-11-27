#!/usr/bin/env python3
"""Generate docs/shortcuts.md from the editor's live key map (app/editor/keymap.js).

The keymap is loaded in JavaScriptCore (macOS: the system jsc; Linux: jsc from
JavaScriptCoreGTK) or Node 18+, together with the modules that register extra
commands at load time (lazy stubs, multichannel, rooms, library). The script lists each preset's
effective bindings and the context in which each applies.

Usage:
  python3 scripts/gen-shortcuts.py            # write docs/shortcuts.md
  python3 scripts/gen-shortcuts.py --check    # exit 1 when docs/shortcuts.md is stale
  python3 scripts/gen-shortcuts.py --json     # print the raw data
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
OUT = os.path.join(ROOT, "docs", "shortcuts.md")
OUT_MODERN = os.path.join(ROOT, "docs", "keymap-modern-mac.md")
EXTRA_MODULES = ["editor/keymap-presets.js", "editor/keymap-editor.js", "lazy.js", "editor/theme.js", "editor/prefs.js", "schematic/multichannel.js", "pcb/rooms.js", "library/library-panel.js", "pcb/bus-route.js", "pcb/route-suggest.js"]

HARNESS = r"""
var APP = %(app)s, EXTRA = %(extra)s, FIXTURE = %(fixture)s;
globalThis.navigator = {platform: "Linux"};
var NOOP = new Proxy(function () {}, {
  get: function (t, k) { return k === Symbol.toPrimitive ? function () { return ""; } : k === "then" ? undefined : NOOP; },
  apply: function () { return NOOP; }
});
globalThis.setTimeout = function (f) { try { f(); } catch (e) {} return 0; };
globalThis.document = {readyState: "complete", addEventListener: function () {}, querySelector: function () { return null; },
  querySelectorAll: function () { return []; }, getElementById: function () { return null; }};
globalThis.AtriumNavHost = NOOP;
globalThis.AtriumNavCommon = {menuItem: function () {}, setChecked: function () {}, ready: function (f) { f(NOOP); }, host: NOOP};
var K, origin = {}, kindOf = {};
function note(source, registration) {
  K.commands().forEach(function (c) {
    if (origin[c.id]) return;
    origin[c.id] = source;
    kindOf[c.id] = c.builtin ? "builtin" : registration;
  });
}
LOAD(APP + "/editor/keymap.js");
K = globalThis.AtriumKeymap;
note("editor/keymap.js", "builtin");
var skipped = [];
for (var i = 0; i < EXTRA.length; i++) {
  try { LOAD(APP + "/" + EXTRA[i]); note(EXTRA[i], "computed"); }
  catch (e) { skipped.push(EXTRA[i] + ": " + e.message); }
}
var out = {presets: [], skipped: skipped, categories: K.categories()};
try { LOAD(APP + "/extensions/manifests.js"); }
catch (e) { skipped.push("extensions/manifests.js: " + e.message); }
if (globalThis.AtriumBuiltinExtensionManifests) {
  for (const {manifest} of globalThis.AtriumBuiltinExtensionManifests) {
    if (manifest.enabledByDefault === false) continue;
    const {commands = [], keybindings = []} = manifest.contributes || {};
    for (const cmd of commands) {
      const keys = keybindings.filter(k => k.command === cmd.command);
      if (keys.length) K.registerCommand({id: cmd.command, title: cmd.title, category: "Extensions", when: cmd.when, defaultKeys: keys});
    }
  }
  note("extensions/manifests.js", "extension");
}
for (var n = 0; n < FIXTURE.length; n++) {
  var spec = FIXTURE[n];
  K.registerCommand({id: spec.id, title: spec.title || spec.id, action: spec.action || spec.id,
    category: spec.category || "Edit", when: spec.when || "", defaultKeys: spec.key ? [spec.key] : (spec.defaultKeys || [])});
  origin[spec.id] = spec.source || "fixture";
  kindOf[spec.id] = spec.registration || "computed";
}
function bindingContext(commandWhen, bindingWhen) {
  if (!commandWhen || commandWhen === bindingWhen) return bindingWhen;
  if (!bindingWhen) return commandWhen;
  if (!/[()|]/.test(bindingWhen) && bindingWhen.split(/\s*&&\s*/).includes(commandWhen)) return bindingWhen;
  const group = when => when.includes("||") ? "(" + when + ")" : when;
  return group(commandWhen) + " && " + group(bindingWhen);
}
K.presets().forEach(function (p) {
  K.setPreset(p.id);
  var rows = K.commands().map(function (c) {
    var registration = kindOf[c.id] || (c.builtin ? "builtin" : "computed");
    return {id: c.id, title: c.title, category: c.category, when: c.when || "",
      action: c.action || c.id, source: origin[c.id] || "registerCommand", registration: registration,
      bindings: K.bindingsFor(c.id).map(function (b) {
        var ctx = bindingContext(c.when || "", b.when || "");
        return {key: b.key, when: ctx, words: K.describeWhen(ctx)};
      })};
  });
  out.presets.push({id: p.id, title: p.title, rows: rows});
});
out.decisions = (globalThis.AtriumKeymapPresets && globalThis.AtriumKeymapPresets.vscodeDecisions) || [];
var KP = globalThis.AtriumKeymapPresets || {};
out.allegro = KP.allegroDecisions || [];
out.modern = (KP.modern || []).map(function (r) {
  var command = K.command(r[1]) || {}, ctx = bindingContext(command.when || "", r[2] || "");
  return {key: K.normalize(r[0]), id: r[1], when: ctx, words: K.describeWhen(ctx),
    title: command.title || r[1], lead: !!(r[5] && r[5].lead)};
});
out.modernWhy = KP.modernWhy || {};
out.modernLeftOff = KP.modernLeftOff || [];
out.macReserved = KP.macReserved || [];
PRINT(JSON.stringify(out));
"""


def find_engine():
    jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
    if os.access(jsc, os.X_OK):
        return ("jsc", jsc)
    for name in ("jsc", "javascriptcoregtk-jsc"):
        p = shutil.which(name)
        if p:
            return ("jsc", p)
    for path in ("/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/jsc", "/usr/libexec/webkit2gtk-4.1/jsc"):
        if os.access(path, os.X_OK):
            return ("jsc", path)
    node = shutil.which("node")
    if node:
        return ("node", node)
    sys.exit("gen-shortcuts: no JavaScript engine found (jsc or node).")


_COLLECTED = {}


def collect(fixture=None):
    """Load registered commands through AtriumKeymap.commands and bindingsFor.

    Fixture rows supply extra aliases and computed registrations for inventory checks.
    """
    rows = list(fixture or [])
    key = json.dumps(rows, sort_keys=True)
    if key in _COLLECTED:
        return _COLLECTED[key]
    kind, engine = find_engine()
    src = HARNESS % {"app": json.dumps(APP), "extra": json.dumps(EXTRA_MODULES),
                     "fixture": json.dumps(rows)}
    if kind == "jsc":
        src = "var LOAD = load, PRINT = print;\n" + src
    else:
        src = ("var fs = require('fs'), vm = require('vm');\n"
               "var LOAD = function (f) { vm.runInThisContext(fs.readFileSync(f, 'utf8'), {filename: f}); };\n"
               "var PRINT = function (s) { process.stdout.write(s + '\\n'); };\n" + src)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(src)
        path = fh.name
    try:
        res = subprocess.run([engine, path], capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)
    lines = [l for l in res.stdout.splitlines() if l.startswith("{")]
    if res.returncode or not lines:
        raise RuntimeError("gen-shortcuts: the key map did not load:\n" + res.stdout + res.stderr)
    data = json.loads(lines[-1])
    _COLLECTED[key] = data
    return data


def command_rows(fixture=None):
    """Default-preset command records for importers. Each row has id, title, action, source, registration and bindings."""
    data = collect(fixture)
    try:
        return data["presets"][0]["rows"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("gen-shortcuts: the key map did not load") from exc


def fmt_key(key):
    # "Mod+Shift+P" -> `Mod+Shift+P`; "P W" (sequence) -> `P` `W`
    parts = key.split(" ")
    return " ".join("`%s`" % p.replace("|", "\\|") for p in parts)


WORDS = [("tool == place", "with the Place tool"), ("!pcb", "not on boards"), ("!schematic", "not on schematics"),
         ("pcb", "on boards"), ("schematic", "on schematics"), ("!routing", "not routing"), ("routing", "while routing"),
         ("!placing", "not placing"), ("placing", "while placing"), ("!dragging", "not dragging"), ("dragging", "while dragging"),
         ("!moving", "not moving"), ("moving", "while moving"), ("!selection", "nothing selected"), ("selection", "something selected"),
         ("!rotatable", "nothing to rotate"), ("rotatable", "selection can rotate"), ("!view3d", "outside 3D view"),
         ("view3d", "in 3D view"), ("!tuning", "not tuning"), ("tuning", "while length tuning"), ("canvas", "canvas focused")]


def words(text):
    """The app's describeWhen returns grouped expressions verbatim; put those into words too."""
    if "&&" not in text and "||" not in text and "(" not in text:
        return text
    import re
    out = text
    for k, v in WORDS:
        out = re.sub(r"(?<![\w!.])" + re.escape(k) + r"(?![\w.])", v, out)
    out = out.replace("&&", ",").replace("||", "or")
    out = re.sub(r"\s+,", ",", re.sub(r"\s+", " ", out)).strip()
    return out[:1].upper() + out[1:]


def esc(text):
    return text.replace("|", "\\|")


def render(data):
    out = []
    w = out.append
    w("# Keyboard shortcuts")
    w("")
    w("<!-- Generated by scripts/gen-shortcuts.py from app/editor/keymap.js. Do not edit by hand. -->")
    w("")
    w("Every Waffle command can be rebound in **Tools → Keyboard Shortcuts…** (record a chord or a "
      "sequence, detect conflicts, import or export your key map). **Help → Keyboard Shortcuts** "
      "(Shift+F1 or `?`) shows a live cheat sheet of the bindings in effect.")
    w("")
    w("How to read the tables:")
    w("")
    w("- `Mod` is **Ctrl** on Windows and Linux and **⌘ Cmd** on macOS (Ctrl also works there). `Ctrl` written explicitly is Ctrl everywhere.")
    w("- On macOS the **Altium-style** preset uses Command for commands such as duplicate (⌘D), find (⌘F), "
      "align left (⇧⌘L) and grid (⌘G). Use Control for wire or route (⌃W), measure (⌃M) and select net or find and replace (⌃H). "
      "macOS uses ⌘W, ⌘M and ⌘H for Close Window, Minimize and Hide. Control-click or Command-click highlights a board net. "
      "Double-click with the same modifier to cross-probe.")
    w("- Keys shown one after another, such as `P` `W`, are a **sequence**: press them one at a time, "
      "as in Altium Designer®. The status bar shows the possible next keys after a prefix.")
    w("- **Context** says where a binding applies (for example only on boards, or only while routing).")
    w("- Your bindings override preset bindings in the same context. A live sequence prefix still takes precedence "
      "over a single key. Keyboard Shortcuts flags both clashes and keys hidden by a sequence.")
    w("- Shortcuts contributed by bundled extensions apply while those extensions are enabled.")
    w("- Commands without a key are still reachable from the menus and the command palette "
      "(`Mod+Shift+P` or F1).")
    w("")
    w("Presets: " + ", ".join("[%s](#%s)" % (p["title"], anchor(p["title"])) for p in data["presets"]) + ".")
    w("")
    w("*Waffle Classic* keeps the defaults from before the Altium chord pass (R rotates, + and − zoom, Ctrl+D opens "
      "layer controls, no E, A, C or U prefixes). *KiCad-like* builds on Waffle Classic. *Allegro-like* builds on the "
      "default; *Modern (Mac)* has its own table (see [keymap-modern-mac.md](keymap-modern-mac.md)). Choose a preset in "
      "Preferences › Keyboard › Key preset or under Learn on the start page.")
    w("")
    w("The *Altium-style*, *KiCad-like* and *VS Code-like* presets are named after the tools whose key "
      "habits they approximate. Waffle is not affiliated with or endorsed by Altium LLC, the KiCad project, Cadence "
      "Design Systems, Apple, Figma or Microsoft; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).")
    w("")
    w("## Search")
    w("")
    w("There is one search surface, the palette. Each key opens it with a different starting filter, shown as a chip in its "
      "field; Backspace in the empty field or a click on the chip removes the filter and searches everything. The app bar has "
      "no search field (removed 2026-11-23).")
    w("")
    w("| Key (default) | Filter | Lists | Menu |")
    w("| --- | --- | --- | --- |")
    w("| `/` | none | Everything: objects across the project, documents, commands, settings, library parts, help. | View › Search Everything… |")
    w("| `Mod+Shift+P`, F1 | Commands | Commands and settings | View › Command Palette… |")
    w("| `Mod+F` | Project | Components (designators), pins and pads, nets, ports, labels and text in every document of the project | Edit › Find… |")
    w("| `Mod+P` | Documents | The project's documents and recent files (quick open) | View › Quick Open… |")
    w("| `J C`, `Mod+Shift+O` / `J L` | Jump to object / location | Typed `@` / `:` prefixes of the same palette | Edit › Jump to… |")
    w("")
    w("Find and Replace Text (`Ctrl+H` on sheets, `Mod+Shift+F`) and Find Similar Objects (`Shift+F`) keep their own dialogs. "
      "Panel filter fields filter only their panel. Before 2026-11-23 `Mod+F` was Find Text on sheets and Flip Board on boards "
      "(Flip Board stays on `V` `B` and View › Flip Board), `Mod+P` was Print (File › Print…) and `/` opened the notebook "
      "Insert palette at the pointer (Place › Insert or Search…).")
    w("")
    if data.get("decisions"):
        w("## VS Code keys")
        w("")
        w("VS Code habits that apply to a schematic and PCB editor. The policy, per key: the *Altium-style* default keeps "
          "Altium meanings where Altium users rely on them and adds the VS Code meaning where nothing clashes; the "
          "*VS Code-like* preset (built on the default) takes the VS Code meaning everywhere. Choose it as the **Key preset** in "
          "Preferences › Keyboard or under Learn on the start page. `Mod+1`…`Mod+9` stay selection memory.")
        w("")
        w("| Key | In VS Code | Altium-style (default) | VS Code-like preset | Notes |")
        w("| --- | --- | --- | --- | --- |")
        for k, vs, dflt, pre, note in data["decisions"]:
            w("| %s | %s | %s | %s | %s |" % (esc(k), esc(vs), esc(dflt), esc(pre), esc(note)))
        w("")
    if data.get("allegro"):
        w("## Allegro keys")
        w("")
        w("The *Allegro-like* preset builds on the Altium-style default and adds the function keys of the Allegro PCB Editor's "
          "stock env file. Typed coordinates use the command line: press `X` (or **Edit › Coordinate Entry…**), then "
          "`x 10 20`, `ix 5`, `iy -2` or `ixy 1 2` and Enter; the point snaps and commits like a click. Values are in the display "
          "unit unless they carry one (`10mil`, `0.5mm`); relative entries start from the last point clicked or entered. "
          "Some sites ship env files with other function keys (for example F7 next, F8 oops); rebind them in Tools › Keyboard Shortcuts….")
        w("")
        w("| Allegro | Allegro meaning | Key in this preset | Waffle command | Notes |")
        w("| --- | --- | --- | --- | --- |")
        for k, meaning, key, cmd, note in data["allegro"]:
            w("| %s | %s | %s | %s | %s |" % (esc(k), esc(meaning), esc(key), esc(cmd), esc(note)))
        w("")
    if data.get("modern"):
        w("## Modern (Mac) keys")
        w("")
        w("A ⌘-centred profile: macOS conventions first, one letter per tool as in Figma, hold Space to pan, no two-key "
          "Altium sequences, and rare commands on ⌘K chords (⌘K opens the command palette at once; press ⌘ and a second key "
          "to run a chord). The full table with the reason for each key, and what was left off, is in "
          "[keymap-modern-mac.md](keymap-modern-mac.md).")
        w("")
    base = {r["id"]: r for r in data["presets"][0]["rows"]}
    for i, p in enumerate(data["presets"]):
        w("## " + p["title"])
        w("")
        if i == 0:
            rows = [r for r in p["rows"] if r["bindings"]]
            w("%d of %d commands have a default key." % (len(rows), len(p["rows"])))
        else:
            rows = [r for r in p["rows"] if json.dumps(r["bindings"]) != json.dumps(base[r["id"]]["bindings"])]
            w("Only the commands this preset changes are listed (%d). Everything else is as in the "
              "default preset. An empty key cell means the preset removes the default key." % len(rows))
        w("")
        cats = data["categories"]
        order = {c: n for n, c in enumerate(cats)}
        groups = {}
        for r in rows:
            groups.setdefault(r["category"], []).append(r)
        for cat in sorted(groups, key=lambda c: order.get(c, 99)):
            w("### %s%s" % (cat, "" if i == 0 else " (" + p["title"] + ")"))
            w("")
            w("| Command | Keys | Context |")
            w("| --- | --- | --- |")
            for r in groups[cat]:
                if not r["bindings"]:
                    w("| %s | — | |" % esc(r["title"]))
                    continue
                for n, b in enumerate(r["bindings"]):
                    w("| %s | %s | %s |" % (esc(r["title"]) if n == 0 else "", fmt_key(b["key"]), esc(words(b["words"]) or "Always")))
            w("")
    if data.get("skipped"):
        w("<!-- Modules skipped while generating: %s -->" % "; ".join(data["skipped"]))
        w("")
    return "\n".join(out)


def render_modern(data):
    """docs/keymap-modern-mac.md: every Modern (Mac) binding with its reason, and what was left off."""
    out = []
    w = out.append
    why = data.get("modernWhy") or {}
    w("# Modern (Mac) key preset")
    w("")
    w("<!-- Generated by scripts/gen-shortcuts.py from app/editor/keymap-presets.js (MODERN, MODERN_WHY). Do not edit by hand. -->")
    w("")
    w("A profile for people who live in modern Mac apps (Figma, Linear, Xcode, Safari, VS Code) rather than in Altium. "
      "Choose **Modern (Mac)** in Preferences › Keyboard › Key preset or under Learn on the start page.")
    w("")
    w("## Design")
    w("")
    for line in (
            "**File and edit commands** use the familiar Mac shortcuts, including ⌘S for Save, ⇧⌘S for Save As, ⌘Z for Undo and ⇧⌘Z for Redo.",
            "**⌘K and ⇧⌘P open the command palette.** ⌘K also begins two-step shortcuts such as ⌘K, ⌘T. "
            "Once the palette opens, press Command with the next key to complete the shortcut, or type to search.",
            "**One letter per tool, as in Figma** (V select, H hand, R route, W wire, P place, N net label, T text, M measure, L layers, "
            "C comment). Hold **Space** to pan in any tool. The letters show in menus, toolbar tooltips and the cheat sheet (⌘?), whose "
            "*Single keys* group lists them first.",
            "**No two-key Altium sequences.** What Altium puts on P …, T …, D … sequences is on a letter, a ⌘ chord, a ⌘K chord, a menu or the palette.",
            "**Nothing macOS keeps for itself** (the list under *Left off* below; tests/editor/keymap.cjs checks every key of every binding against it). "
            "No ⌘ arrows either: on a PC they would be Ctrl arrows, which macOS uses for Spaces.",
            "**On Windows and Linux, Ctrl stands in for ⌘** (`Mod`), so the preset works there unchanged; it is not Mac-only. "
            "Ctrl+` (console) stays on Control everywhere because ⌘` cycles windows on macOS. Alt+letter (align) may open a menu "
            "on a Windows host with native menu mnemonics; Waffle's web menus have none.",
            "**Context, not modes.** One key can mean two things only in contexts that never overlap: R routes, but rotates while "
            "you place or move a part; V selects, but adds a via while routing; arrows nudge a selection, step the cursor while "
            "placing and pan otherwise. The preset has no conflicts on PC or Mac (tests/editor/keymap.cjs).",
    ):
        w("- " + line)
    w("")
    w("## Every binding")
    w("")
    w("| Key | Command | Context | Why |")
    w("| --- | --- | --- | --- |")
    for r in data["modern"]:
        note = why.get(r["key"]) or ""
        if r["lead"]:
            note = (note + " " if note else "") + "(Lead of the ⌘K chords.)"
        w("| %s | %s | %s | %s |" % (fmt_key(r["key"]), esc(r["title"]), esc(words(r["words"]) or "Always"), esc(note)))
    w("")
    w("Module commands keep their own keys, except that Interactive Bus Routing moves from `P` `M` to `Shift+B` and the room "
      "sequences (`D` `M` …) and the library editors' `T` … sequences are cleared, and the Library panel moves to `Mod+Alt+P`; "
      "all stay on their menus. Preferences… keeps ⌘,. Ask AI about Selection uses `Mod+Alt+Shift+I` so the Properties panel keeps `Mod+Alt+I`.")
    w("")
    w("## Left off on purpose")
    w("")
    w("| Key | Why |")
    w("| --- | --- |")
    for k, reason in data.get("modernLeftOff") or []:
        w("| %s | %s |" % (esc(k), esc(reason)))
    w("")
    w("Never bound (checked by tests/editor/keymap.cjs): " + ", ".join("`%s`" % k for k in data.get("macReserved") or []) + ".")
    w("")
    return "\n".join(out)


def anchor(title):
    s = "".join(ch for ch in title.lower() if ch.isalnum() or ch in " -")
    return s.replace(" ", "-")


def main():
    args = sys.argv[1:]
    unknown = [a for a in args if a not in ("--check", "--json")]
    if unknown:
        # Never regenerate the file on a flag this script does not know (such as --help).
        print(__doc__.strip())
        return 0 if unknown in (["--help"], ["-h"]) else 2
    try:
        data = collect()
    except RuntimeError as exc:
        sys.exit(str(exc))
    if data["skipped"]:
        print("gen-shortcuts: could not load all shortcut modules", file=sys.stderr)
        print("\n".join(data["skipped"]), file=sys.stderr)
        return 2
    if "--json" in args:
        print(json.dumps(data, indent=2))
        return 0
    text = render(data)
    modern = render_modern(data) if data.get("modern") else None
    if "--check" in args:
        cur = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if cur != text:
            print("docs/shortcuts.md is stale: run python3 scripts/gen-shortcuts.py")
            return 1
        cur_m = open(OUT_MODERN, encoding="utf-8").read() if os.path.exists(OUT_MODERN) else ""
        if modern is not None and cur_m != modern:
            print("docs/keymap-modern-mac.md is stale: run python3 scripts/gen-shortcuts.py")
            return 1
        print("docs/shortcuts.md is current")
        return 0
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    if modern is not None:
        with open(OUT_MODERN, "w", encoding="utf-8") as fh:
            fh.write(modern)
    n = sum(1 for r in data["presets"][0]["rows"] if r["bindings"])
    print("wrote docs/shortcuts.md (%d presets, %d bound commands)" % (len(data["presets"]), n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
