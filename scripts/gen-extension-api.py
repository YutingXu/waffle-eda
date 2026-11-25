#!/usr/bin/env python3
"""Generate docs/extension-api.md from the AtriumAPI registry.

    python3 scripts/gen-extension-api.py           # write docs/extension-api.md
    python3 scripts/gen-extension-api.py --check   # CI: fail if it is stale or a call is undocumented

From the source it reads:
  app/core/atrium-api.js   the facade an extension sees (`api.*`), permission names and descriptions,
                      every handler with its permission and parameters, and the transaction and storage limits;
  app/extension-host/extensions.js   the host limits (time, rate,
                      message, panel, dialog, network, CPU, Messages rows);
  app/automation/proposal.js     the proposal size limit.
Words (summaries, parameter descriptions, returns, examples) come from scripts/extension_api_notes.py.
--check fails when a call has no note, a note names a call that no longer exists, a parameter count
differs from the handler's signature, or the generated file differs from docs/extension-api.md.
Pure Python: no JavaScript runtime is needed.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "extension-api.md"
API_JS, EXT_JS, PROPOSAL_JS = ROOT / "app" / "core/atrium-api.js", ROOT / "app" / "extension-host/extensions.js", ROOT / "app" / "automation/proposal.js"

spec = importlib.util.spec_from_file_location("extension_api_notes", ROOT / "scripts" / "extension_api_notes.py")
N = importlib.util.module_from_spec(spec)
spec.loader.exec_module(N)

PERM_CODES = {"MR": "read:motion", "R": "read:project", "E": "propose:edits or write:edits", "F": "outputs:write", "U": "ui:panel or ui:command",
              "UP": "ui:panel", "UC": "ui:command", "UD": "ui:decorations", "X": "run:external", "N": "none"}


class SourceError(Exception):
    pass


# ------------------------------------------------------------------ JS scanning
def skip(text, i):
    """If text[i] starts a string, comment or regex literal, the index just past it; else None."""
    c, n = text[i], len(text)
    if c in "\"'`":
        j = i + 1
        while j < n and text[j] != c:
            j += 2 if text[j] == "\\" else 1
        return j + 1
    if text.startswith("//", i):
        j = text.find("\n", i)
        return n if j < 0 else j
    if text.startswith("/*", i):
        return text.find("*/", i) + 2
    if c == "/":
        k = i - 1
        while k >= 0 and text[k] in " \t\n":
            k -= 1
        if k < 0 or text[k] in "(,=:[!&|?{};+-*%<>~^" or text[max(0, k - 5):k + 1] == "return":
            j, in_class = i + 1, False
            while j < n and (in_class or text[j] != "/"):
                if text[j] == "\\":
                    j += 1
                elif text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                j += 1
            j += 1
            while j < n and text[j].isalpha():
                j += 1
            return j
    return None


def block(text, start):
    """The text of the {...} or (...) starting at text[start], skipping strings, regexes and comments."""
    depth, i, n = 0, start, len(text)
    while i < n:
        j = skip(text, i)
        if j is not None:
            i = j
            continue
        c = text[i]
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    raise SourceError("unbalanced block at offset %d" % start)


def split_top(body):
    """Split an object body or parameter list on top-level commas."""
    parts, depth, start, i, n = [], 0, 0, 0, len(body)
    while i < n:
        j = skip(body, i)
        if j is not None:
            i = j
            continue
        c = body[i]
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(body[start:i].strip())
            start = i + 1
        i += 1
    if body[start:].strip():
        parts.append(body[start:].strip())
    return [re.sub(r"^(//[^\n]*\n\s*)+", "", p).strip() for p in parts]


def const_object(fn_text, name):
    m = re.search(r"\bconst %s = \{" % re.escape(name), fn_text)
    return block(fn_text, m.end() - 1) if m else None


def facade_calls(src):
    """Map of public call name -> handler method (or None for calls that run in the worker)."""
    m = re.search(r"function facade\(invoke, env\) \{", src)
    if not m:
        raise SourceError("facade() not found in app/core/atrium-api.js")
    fn = block(src, m.end() - 1)
    am = re.search(r"\n    const api = \{", fn)
    if not am:
        raise SourceError("the facade's api object was not found")
    out = {}

    def walk(obj_text, prefix):
        for entry in split_top(obj_text[1:-1]):
            km = re.match(r"(\w+)\s*(?::\s*(.*))?$", entry, re.S)
            meth = re.match(r"(\w+)\s*\(", entry)
            if km and km.group(2) is None:            # shorthand: `units`, `transaction`, `commands`, …
                name = km.group(1)
                obj = const_object(fn, name)
                if obj:
                    walk(obj, prefix + name + ".")
                elif re.search(r"\bconst %s = m\(\"([\w.]+)\"\);" % name, fn):
                    out[prefix + name] = re.search(r"\bconst %s = m\(\"([\w.]+)\"\);" % name, fn).group(1)
                    for x in re.finditer(r"\b%s\.(\w+) = m\(\"([\w.]+)\"\);" % name, fn):
                        out[prefix + name + "." + x.group(1)] = x.group(2)
                elif re.search(r"\b(function %s\(|const %s = )" % (name, name), fn):
                    out[prefix + name] = None            # a local function or helper
                else:
                    raise SourceError("cannot resolve facade entry " + prefix + name)
            elif km:
                name, value = km.group(1), km.group(2).strip()
                if value.startswith("{"):
                    walk(value, prefix + name + ".")
                elif re.fullmatch(r'm\("([\w.]+)"\)', value):
                    out[prefix + name] = re.fullmatch(r'm\("([\w.]+)"\)', value).group(1)
                else:
                    out[prefix + name] = None           # a local function or value
            elif meth:
                out[prefix + meth.group(1)] = None      # method shorthand inside a local object
            else:
                raise SourceError("unexpected facade entry: " + entry[:60])
    walk(block(fn, am.end() - 1), "")
    return out


def handlers(src):
    """Handler method -> (permission code, [parameter names])."""
    m = re.search(r"\n    const handlers = \{", src)
    if not m:
        raise SourceError("handlers table not found in app/core/atrium-api.js")
    body = block(src, m.end() - 1)
    out = {}
    for entry in split_top(body[1:-1]):
        hm = re.match(r'"([\w.]+)":\s*\[(\w+),\s*(.*)\]$', entry, re.S)
        if not hm:
            raise SourceError("unexpected handler entry: " + entry[:60])
        method, perm, fn = hm.group(1), hm.group(2), hm.group(3).strip()
        if perm not in PERM_CODES:
            raise SourceError("unknown permission code %s for %s" % (perm, method))
        if fn.startswith("("):
            params = block(fn, 0)[1:-1]
        else:
            am = re.match(r"(\w+)\s*=>", fn)
            if am:
                params = am.group(1)
            else:
                fm = re.match(r"(\w+)$", fn)
                if not fm:
                    raise SourceError("cannot read the parameters of " + method)
                dm = re.search(r"\bfunction %s\(([^)]*)\)" % fm.group(1), src)
                if not dm:
                    raise SourceError("function %s (for %s) not found" % (fm.group(1), method))
                params = dm.group(1)
        names = [re.match(r"\s*(\.\.\.)?(\w+)", p).group(2) for p in split_top(params) if p.strip()]
        out[method] = (perm, names)
    return out


def number(text, pattern, what):
    m = re.search(pattern, text)
    if not m:
        raise SourceError("limit not found: " + what)
    return float(m.group(1))


def limits(api, ext, proposal):
    lim = re.search(r"const LIMITS = \{([^}]*)\}", ext)
    view = re.search(r"const VIEW_LIMITS = \{([^}]*)\}", ext)
    cpu = re.search(r"const CPU = \{([^}]*)\}", ext)
    if not (lim and view and cpu):
        raise SourceError("LIMITS, VIEW_LIMITS or CPU not found in app/extension-host/extensions.js")
    kv = lambda t: {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.e]+)", t)}
    L, V, C = kv(lim.group(1)), kv(view.group(1)), kv(cpu.group(1))
    frozen = lambda name: re.search(r"const %s = Object\.freeze\(\{([^}]*)\}\)" % name, api)
    if not (frozen("DECORATION_LIMITS") and frozen("EXTERNAL_LIMITS") and frozen("PROPOSE_LIMITS")):
        raise SourceError("DECORATION_LIMITS, EXTERNAL_LIMITS or PROPOSE_LIMITS not found in app/core/atrium-api.js")
    D, X, P = kv(frozen("DECORATION_LIMITS").group(1)), kv(frozen("EXTERNAL_LIMITS").group(1)), kv(frozen("PROPOSE_LIMITS").group(1))
    g = lambda pat, what, src=ext: number(src, pat, what)
    n = lambda v: f"{int(v):,}" if v == int(v) else str(v)
    mb = lambda v: n(v / 1e6) + " MB"
    s = lambda ms: n(ms / 1000) + " s"
    T = {
        "DEFAULT_TIMEOUT": g(r"DEFAULT_TIMEOUT = (\d+)", "DEFAULT_TIMEOUT"), "MAX_TIMEOUT": g(r"MAX_TIMEOUT = (\d+)", "MAX_TIMEOUT"),
        "LONG_TIMEOUT": g(r"LONG_TIMEOUT = (\d+)", "LONG_TIMEOUT"), "IDLE_STOP": g(r"IDLE_STOP = (\d+)", "IDLE_STOP"),
        "MAX_PACKAGE": g(r"MAX_PACKAGE = ([\d.e]+)", "MAX_PACKAGE"), "MAX_QUEUED_PROMPTS": g(r"MAX_QUEUED_PROMPTS = (\d+)", "MAX_QUEUED_PROMPTS"),
        "MAX_DISMISSALS": g(r"MAX_DISMISSALS = (\d+)", "MAX_DISMISSALS"), "DISMISS_WINDOW": g(r"DISMISS_WINDOW = (\d+)", "DISMISS_WINDOW"),
        "MAX_NET_BYTES": g(r"MAX_NET_BYTES = ([\d.e]+)", "MAX_NET_BYTES"), "NET_OPEN": g(r"p\.nets\.size >= (\d+)", "open responses"),
        "MAX_REPORT": g(r"MAX_REPORT = (\d+)", "MAX_REPORT"),
        "MAX_ITEMS": number(api, r"MAX_ITEMS = (\d+)", "MAX_ITEMS"), "STORAGE": number(api, r"JSON\.stringify\(value\)\.length > (\d+)", "storage value"),
        "OPS": number(api, r"ops\.length > (\d+)", "transaction operations"), "PROPOSAL_OPS": number(proposal, r"MAX_OPS = (\d+)", "MAX_OPS"),
    }
    rows = {
        "TIME": ("Command time", s(T["DEFAULT_TIMEOUT"]) + " by default; manifest `timeoutMs` up to " + s(T["MAX_TIMEOUT"]) + ", or " + n(T["LONG_TIMEOUT"] / 60000) + " min with `\"worker\": \"dedicated\"`. At the limit the worker is terminated."),
        "CPU_BUDGET": ("Background CPU", s(C["budgetMs"]) + " of processor time per " + n(C["window"]) + " s outside a running command, and a heartbeat every " + s(C["beatMs"]) + " (silence for " + s(C["silenceMs"]) + " stops the worker)."),
        "IDLE": ("Idle", "An active extension with nothing open or pending stops after " + n(T["IDLE_STOP"] / 60000) + " min and restarts on demand."),
        "callsPerSecond": ("API calls", n(L["callsPerSecond"]) + " per second per extension."),
        "messageChars": ("Message size", mb(L["messageChars"]) + " per message."),
        "MAX_ITEMS": ("Objects per read", n(T["MAX_ITEMS"]) + "; page with `limit` and `offset`, or narrow the filter."),
        "MAX_OPS_TRANSACTION": ("Operations per transaction", n(T["OPS"]) + "."),
        "MAX_OPS_PROPOSAL": ("Operations per proposal", n(T["PROPOSAL_OPS"]) + "."),
        "viewChars": ("Panel view", mb(L["viewChars"]) + " of data per view."),
        "VIEW_NODES": ("Panel elements", n(V["nodes"]) + " rendered nodes per view (long tables are cut with a note), " + n(V["columns"]) + " columns, " + n(V["fields"]) + " form fields, " + n(V["buttons"]) + " buttons, nesting depth " + n(V["depth"]) + "."),
        "MAX_REPORT": ("Messages rows", n(T["MAX_REPORT"]) + " per `ui.showMessage` call."),
        "STORAGE_VALUE": ("Storage", n(T["STORAGE"] / 1024) + " KB per JSON value."),
        "logsPerSecond": ("Log lines", n(L["logsPerSecond"]) + " per second; the rest of that second is dropped."),
        "DIALOGS": ("Dialogs", "One per extension at a time and " + n(T["MAX_QUEUED_PROMPTS"]) + " queued consent prompts; an extension whose dialogs are dismissed " + n(T["MAX_DISMISSALS"]) + " times in " + s(T["DISMISS_WINDOW"]) + " is disabled."),
        "NET_OPEN": ("Network", n(T["NET_OPEN"]) + " open responses per extension."),
        "NET_BYTES": ("Network response", mb(T["MAX_NET_BYTES"]) + " per response."),
        "PACKAGE": ("Package", mb(T["MAX_PACKAGE"]) + " per package."),
        "PROPOSE": ("Proposed edits", n(P["edits"]) + " per proposal, paths up to " + n(P["depth"]) + " fields deep, " + mb(P["valueChars"]) + " per value and " + mb(P["totalChars"]) + " in all."),
        "DECORATIONS": ("Decorations", n(D["items"]) + " per document, " + n(D["text"]) + " characters of text each, " + n(D["chars"] / 1024) + " KB per call, " + n(D["docs"]) + " documents, " + n(D["callsPerSecond"]) + " calls per second."),
        "EXTERNAL": ("External runs", n(X["args"]) + " arguments of up to " + n(X["argChars"]) + " characters, " + n(X["files"]) + " input files (" + mb(X["fileBytes"]) + "), " + n(X["outputs"]) + " output patterns; timeout " + s(X["defaultTimeoutMs"]) + " by default, at most " + n(X["timeoutMs"] / 60000) + " min; stdout, stderr and output files capped at " + mb(X["defaultOutputBytes"]) + " by default, at most " + mb(X["outputBytes"]) + "; 4 runs at a time per extension."),
    }
    return rows


def permissions(api):
    m = re.search(r"const PERMISSION_DESCRIPTIONS = Object\.freeze\((\{.*?\n  \})\);", api, re.S)
    if not m:
        raise SourceError("Permission descriptions not found in app/core/atrium-api.js")
    return json.loads(m.group(1)).items()


# ------------------------------------------------------------------ rendering
def md_cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def area_of(name):
    first = name.split(".")[0]
    return "features" if first in N.FEATURES else first


def generate():
    api, ext, proposal = API_JS.read_text(encoding="utf-8"), EXT_JS.read_text(encoding="utf-8"), PROPOSAL_JS.read_text(encoding="utf-8")
    calls, table, L = facade_calls(api), handlers(api), limits(api, ext, proposal)
    problems = []
    # A local call (transaction, commands.register, events.on) reaches its handler through invoke().
    reached = {m for m in calls.values() if m} | {N.NOTES[n]["via"] for n in calls if n in N.NOTES and N.NOTES[n].get("via")}
    for name, note in N.NOTES.items():
        if note.get("via") and '"%s"' % note["via"] not in api:
            problems.append("api.%s: %s is no longer called in app/core/atrium-api.js" % (name, note["via"]))
    for method in table:
        if method not in reached and method not in N.INTERNAL:
            problems.append("handler %s is not reached by any api.* call and is not listed in INTERNAL" % method)
    for name in calls:
        if name not in N.NOTES:
            problems.append("api.%s has no note in scripts/extension_api_notes.py" % name)
    for name in N.NOTES:
        if name not in calls:
            problems.append("note %s names a call that is not in the facade (app/core/atrium-api.js)" % name)
    for name, method in calls.items():
        note = N.NOTES.get(name)
        if not note:
            continue
        if method:
            if method not in table:
                problems.append("api.%s calls %s, which has no handler" % (name, method))
                continue
            got, want = len(note["params"]), len(table[method][1])
            if got != want:
                problems.append("api.%s: the note lists %d parameters, the handler takes %d (%s)" % (name, got, want, ", ".join(table[method][1])))
        elif not note.get("local"):
            problems.append("api.%s runs in the worker: mark its note local=True" % name)
        for key in note.get("limits", []):
            if key not in L:
                problems.append("api.%s: unknown limit %s" % (name, key))
    if problems:
        raise SourceError("\n".join(problems))

    def perm(name):
        method = calls[name] or N.NOTES[name].get("via")
        if method and method in table:
            code = table[method][0]
            p = PERM_CODES[code]
            if name == "events.on":
                return "read:project for design events; none for panelShown, panelHidden, settingsChanged"
            return p
        return "none (runs in the worker)"

    def signature(name):
        note = N.NOTES[name]
        if note.get("value"):
            return "api." + name
        if note.get("sig"):
            sig = note["sig"]
            return "api." + (name.rsplit(".", 1)[0] + "." if "." in name else "") + sig
        return "api." + name + "(" + ", ".join(p[0] for p in note["params"]) + ")"

    order = [a[0] for a in N.AREAS]
    titles = {}
    for key, title, intro in N.AREAS:
        titles.setdefault(title, []).append((key, intro))
    grouped = {}
    for name in calls:
        grouped.setdefault(area_of(name), []).append(name)
    unknown = [a for a in grouped if a not in order]
    if unknown:
        raise SourceError("no AREAS entry for " + ", ".join(unknown))

    out = []
    w = out.append
    w("# AtriumAPI v1 reference")
    w("")
    w("_Generated by `scripts/gen-extension-api.py` from `app/core/atrium-api.js` and `app/extension-host/extensions.js`. Do not edit: change the source or `scripts/extension_api_notes.py`, then run `python3 scripts/gen-extension-api.py` (CI runs it with `--check`)._")
    w("")
    w("Extensions, console scripts and MCP `run_script` all program against this one object, `api`. "
      "In an extension every call is a message from its sandboxed worker to the editor, which checks the extension's permissions on every call, so **every call returns a Promise**: write `await`. "
      "Reads return copies. Lengths are millimetres, points are `[x, y]`. "
      "Calls marked *runs in the worker* need no permission and send no message.")
    w("")
    w("New to extensions? Start with [extensions.md](extensions.md) (a first extension in 15 minutes), the examples in `extensions/examples/`, and `scripts/new-extension.py`. Console scripts: [scripting.md](scripting.md).")
    w("")
    w("## Permissions")
    w("")
    w("Declare capabilities under `permissions` in `waffle-extension.json`. Browse Extensions and direct package installation use this same list. Revoking a permission takes effect on the next call. [API version compatibility](upgrading.md#extensions)")
    w("")
    w("| Permission | What it allows (as the install prompt says it) |")
    w("| --- | --- |")
    for p, text in permissions(api):
        w("| `%s` | %s |" % (p, md_cell(text)))
    w("| `network:<host>` | Contact `https://<host>` through the host-mediated `fetch` (off until the user allows it) |")
    w("| `network:localhost` | Contact servers on this computer (localhost, any port; off until the user allows it) |")
    w("")
    w("Console scripts can read and edit the design, export files and show dialogs. MCP `run_script` reads a project copy. Persisting an edit requires an explicitly writable server and write mode. [Headless scripting](scripting.md#headless-mcp-and-the-command-line)")
    w("")
    w(N.PALETTE_CONTRIBUTIONS)
    w(N.WIDGET_CONTRIBUTIONS)
    w("## Limits")
    w("")
    w("| Limit | Value |")
    w("| --- | --- |")
    for key in ["TIME", "CPU_BUDGET", "IDLE", "callsPerSecond", "messageChars", "MAX_ITEMS", "MAX_OPS_TRANSACTION", "MAX_OPS_PROPOSAL", "viewChars", "VIEW_NODES",
                "MAX_REPORT", "STORAGE_VALUE", "logsPerSecond", "DIALOGS", "NET_OPEN", "NET_BYTES", "PACKAGE"]:
        w("| %s | %s |" % L[key])
    w("")
    w("Users can stop everything with **Ctrl/⌘+Shift+Esc**, **Esc** three times while extension work runs, or **Pause all** in Tools › Extensions.")
    w("")
    w("## Index")
    w("")
    w("| Call | Permission |")
    w("| --- | --- |")
    seen_titles = []
    for key in order:
        for name in grouped.get(key, []):
            w("| [`%s`](#%s) | %s |" % (signature(name).split("(")[0], anchor(name), md_cell(perm(name))))
    w("")
    for title, keys in titles.items():
        names = [n for k, _ in keys for n in grouped.get(k, [])]
        if not names:
            continue
        w("## " + title)
        w("")
        intro = " ".join(i for _, i in keys if i)
        if intro:
            w(intro)
            w("")
        for name in names:
            note = N.NOTES[name]
            w('<a id="%s"></a>' % anchor(name))
            w("### `%s`" % signature(name))
            w("")
            w(note["summary"])
            w("")
            w("- **Permission:** " + perm(name))
            if note["params"]:
                w("- **Parameters:**")
                for pname, ptype, pdesc in note["params"]:
                    w("  - `%s` (%s)%s" % (pname, ptype, (": " + pdesc) if pdesc else ""))
            w("- **Returns:** " + note["returns"])
            for key in note.get("limits", []):
                w("- **Limit:** %s: %s" % L[key])
            if note.get("notes"):
                w("")
                w(note["notes"])
            w("")
            w("```js")
            w(note["example"])
            w("```")
            w("")
    w("## Globals in the worker")
    w("")
    w("| Global | Permission | |")
    w("| --- | --- | --- |")
    for g, p, text, lim in N.GLOBALS:
        extra = "".join(" %s: %s." % (L[k][0], L[k][1].rstrip(".")) for k in lim)
        w("| `%s` | %s | %s%s |" % (g, p, md_cell(text), md_cell(extra)))
    w("")
    w("There is no `document`, `window`, `localStorage`, `indexedDB`, `importScripts`, `XMLHttpRequest`, `WebSocket` or editor global: the worker runs in a sandboxed iframe with the CSP `default-src 'none'`.")
    w("")
    w("## `activate(api, context)`")
    w("")
    w("`main.js` exports `activate(api, context)` (and optionally `deactivate()`).")
    w("")
    w("| `context` | |")
    w("| --- | --- |")
    for k, text in N.CONTEXT:
        w("| `%s` | %s |" % (k, md_cell(text)))
    w("")
    w("_%d calls._" % len(calls))
    w("")
    return "\n".join(out)


def anchor(name):
    return "api-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    check = "--check" in sys.argv[1:]
    try:
        text = generate()
    except SourceError as e:
        sys.exit("gen-extension-api: " + str(e))
    current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
    if check:
        if current != text:
            sys.exit("docs/extension-api.md is stale: run python3 scripts/gen-extension-api.py")
        print("docs/extension-api.md is current")
        return
    if current != text:
        OUT.write_text(text, encoding="utf-8")
        print("wrote docs/extension-api.md")
    else:
        print("docs/extension-api.md is current")


if __name__ == "__main__":
    main()
