#!/usr/bin/env python3
"""Edit flow: import -> edit through the MCP server -> save back into the source format -> equivalence.

The end-to-end suite (run.py) proves an unedited import against the source and the original
tool's outputs. This suite continues from there, the way a user does: it opens a foreign board,
drags, rotates, flips and places components, routes a connection, saves, and then checks what the
other tool would read.

  import      mcp/server.py import_design into a native project beside a scratch copy of the source
  clean       save back with no edits: the saved file must read the same as the original
  slide       drag one via through a script transaction, save back
  drag        move one footprint, save back
  rework      rotate, flip, duplicate (place) and route, save back
  sidecar     the project still opens with its .waffle folder deleted
  safety      the source files are byte-identical and nothing was created beside them

Every edit is a real tools/call over the server's stdio transport in write mode, each bound to the
revision the previous one returned. Each save-back target is one of the registered writers:

  kicad               the KiCad writer (from a KiCad source: the same format; from Altium: a conversion)
  altium-source-copy  the binary Altium writer, which patches the original records. It holds a
                      footprint translation and changes to existing tracks, arcs and vias; anything
                      else must be refused by name with nothing written.

tests/e2e/edit-flow.cjs reads every saved file with the independent oracles and never with the
importer it is checking. Results use the end-to-end suite's rows and report; edit-known-failures.json
lists the defects the flow shows today, each with the checks it turns red.

  python3 tests/e2e/edit-flow.py [--tier fast|full] [--fetch] [--only ID ...] [--mutations] [--json OUT] [--keep DIR]

fast (default) runs the vendored boards; full adds every project in tests/e2e/corpus.json.
Exit status 1 when a gating check fails that edit-known-failures.json does not list, or a listed
failure now passes.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "support"))
import run as full  # noqa: E402  (corpus, fixtures and the report of the end-to-end suite)
from native_sample import ensure_native_host  # noqa: E402

SERVER = ROOT / "mcp/server.py"
BOARD = (".pcbdoc", ".kicad_pcb")
VENDORED = [
    {"id": "demo-kicad", "translator": "kicad", "files": ["tests/fixtures/import/demo.kicad_pcb"]},
    {"id": "pidp11-io-expander-edit", "translator": "altium",
     "files": ["tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"]},
]
TARGETS = {"kicad": ("kicad",), "altium": ("altium-source-copy", "kicad")}
# What the binary Altium writer cannot hold. It must say so and write nothing ("lossless or ask").
REFUSALS = {"rework": {"altium-source-copy": "."}}
LOCKED = "Locked or grouped footprints"
COPPER_LOCKED = "locked copper"
SLIDE = """const vias = await api.items.list({doc: args.doc, kind: "via", fields: ["id", "net", "x", "y"]});
const via = args.id ? vias.find(v => v.id === args.id) : vias.filter(v => v.net).sort((a, b) => a.x - b.x || a.y - b.y)[0];
if (!via) return null;
await api.transaction("Slide via", tx => tx.move(via.id, args.dx, 0));
return {id: via.id, net: via.net};"""
DRAG = (1.27, -0.635)


def row(check, ok, metric=None, detail=(), gating=True):
    return {"id": check, "pass": bool(ok), "gating": gating, "metric": metric or {}, "detail": list(detail)[:6]}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(folder):
    return {p.relative_to(folder).as_posix(): digest(p.read_bytes()) for p in sorted(folder.rglob("*")) if p.is_file()}


class Flow:
    def __init__(self, project, files, work, node):
        self.project, self.node, self.work = project, node, work
        self.source_dir = work / "src"
        self.source_dir.mkdir(parents=True)
        for f in files:
            shutil.copyfile(f, self.source_dir / Path(f).name)
        names = [Path(f).name for f in files]
        self.board = next(n for n in names if n.lower().endswith(BOARD))
        self.companions = [n for n in names if n != self.board]
        self.before = snapshot(self.source_dir)
        self.results, self.timings = [], {}
        self.touched = {"refs": set(), "nets": set()}
        self.calls = 0

    # ---------------------------------------------------------------- the server
    def call(self, project, tool, args=None, flags=(), transport="cli"):
        """One tool call in its own server process. Returns (result, None) or (None, message)."""
        command = [sys.executable, "-B", str(SERVER), "--project", str(project), *flags]
        self.calls += 1
        if transport == "cli":
            p = subprocess.run([*command, "--cli", tool, "--args", json.dumps(args or {})], capture_output=True, text=True,
                               timeout=900, stdin=subprocess.DEVNULL, cwd=self.source_dir)
            if p.returncode:
                return None, (p.stderr.strip().splitlines() or ["the server stopped"])[-1][:400]
            return json.loads(p.stdout), None
        message = lambda seq, method, params: json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n"
        wire = message(1, "initialize", {"protocolVersion": "2025-11-25"}) + message(2, "tools/call", {"name": tool, "arguments": args or {}})
        p = subprocess.run(command, input=wire, capture_output=True, text=True, timeout=900, cwd=self.source_dir)
        if p.returncode or not p.stdout.strip():
            return None, (p.stderr.strip().splitlines() or ["the server stopped"])[-1][:400]
        reply = json.loads(p.stdout.splitlines()[-1])["result"]
        if reply["isError"]:
            error = reply["structuredContent"]["error"]
            return None, error["code"] + ": " + error["message"][:360]
        return json.loads(reply["content"][0]["text"]), None

    def edit(self, check, tool, args):
        """A write over the MCP transport, bound to the revision the last write returned."""
        result, error = self.call(self.manifest, tool, {**args, "mode": "write", "source_sha256": self.revision},
                                  flags=("--allow-write",), transport="mcp")
        if error is None and not result.get("written"):
            error = "the tool reported no write"
        if error is None:
            self.revision = result["file_revision"]
        if check:
            self.results.append(row(check, error is None, {"tool": tool, **({"error": error} if error else {"changes": result.get("changes")})}))
        return result, error

    def timed(self, name, fn):
        started = time.monotonic()
        try:
            return fn()
        finally:
            self.timings[name] = round((time.monotonic() - started) * 1000)

    # ---------------------------------------------------------------- stages
    def open(self):
        flags = [x for name in self.companions for x in ("--source-file", name)]
        imported, error = self.call(self.source_dir / self.board, "import_design",
                                    {"target_format": "2.0", "destination": "native", "source_rules": "use"}, flags=flags)
        self.results.append(row("import", error is None, {"error": error} if error else {"library": imported["library"], "retained": imported["retained_inputs"]}))
        if error:
            return False
        self.manifest = Path(imported["path"])
        self.native, self.revision = self.manifest.parent, imported["sha256"]
        documents, error = self.call(self.manifest, "list_documents", flags=("--read-only",))
        self.pcb = next((d["id"] for d in (documents or {}).get("documents", []) if d["kind"] == "pcb"), None)
        if not self.pcb:
            self.results.append(row("import.board", False, {"error": error or "the native project has no board"}))
            return False
        # The source-copy writer verifies an original the user selects inside the project folder.
        shutil.copyfile(self.source_dir / self.board, self.native / self.board)
        self.parts, offset = [], 0
        while offset is not None:
            page, error = self.call(self.manifest, "list_components", {"document_id": self.pcb, "offset": offset, "limit": 200}, flags=("--read-only",))
            if error:
                self.results.append(row("import.components", False, {"error": error}))
                return False
            self.parts += [c for c in page["items"] if c.get("ref") and not c.get("locked")]
            offset = page.get("next_offset")
        self.parts.sort(key=lambda c: c["ref"])
        return True

    def save_back(self, stage):
        saved = []
        for target in TARGETS[self.project["translator"]]:
            folder = stage + "-" + target
            if target == "kicad":
                result, error = self.call(self.manifest, "export_kicad", {"document_id": self.pcb, "output_dir": folder})
            else:
                result, error = self.call(self.manifest, "export_design", {"translator": target, "document_id": self.pcb,
                                                                           "source_path": self.board, "output_dir": folder})
            files = [{"name": Path(f["path"]).name, "path": f["path"]} for f in (result or {}).get("files", [])]
            saved.append({"target": target, "files": files, "error": error})
        return saved

    def check(self, stage, saved, mutation=None, outputs=True, refuse=None):
        out = self.work / (stage + (("-" + mutation) if mutation else "") + ".json")
        request = {"root": str(ROOT), "out": str(out), "fixture": {"id": self.project["id"]}, "stage": stage,
                   "original": {"name": self.board, "path": str(self.source_dir / self.board)},
                   "native": {"dir": str(self.native), "manifest": self.manifest.name}, "saved": saved, "outputs": outputs,
                   "touched": {k: sorted(v) for k, v in self.touched.items()}, "refuse": {**REFUSALS.get(stage, {}), **(refuse or {})}, "mutation": mutation}
        p = subprocess.run([self.node, "--max-old-space-size=3072", str(HERE / "edit-flow.cjs")], input=json.dumps(request), text=True,
                           capture_output=True, timeout=1800, env={**os.environ, "TZ": "UTC", "LC_ALL": "C"})
        if p.returncode or not out.exists():
            tail = " | ".join((p.stderr or p.stdout).strip().splitlines()[-3:])[:500]
            return {"results": [row(stage + ".checks", False, {"error": tail})], "mutationApplied": None}
        return json.loads(out.read_text())

    def clean(self):
        self.clean_saved = self.save_back("clean")
        self.results += self.check("clean", self.clean_saved)["results"]

    def protocol(self):
        """The server's own guarantees the flow depends on: a proposal writes nothing, a stale write is refused."""
        ref = self.parts[0]["ref"]
        result, error = self.call(self.manifest, "move_component", {"document_id": self.pcb, "component": ref, "dx": 1}, transport="mcp")
        summary, _ = self.call(self.manifest, "project_summary", flags=("--read-only",))
        unchanged = error is None and not result.get("written") and (summary or {}).get("file_revision") == self.revision
        self.results.append(row("mcp.proposal-writes-nothing", unchanged, {"error": error} if error else {"proposal": bool(result.get("proposal") or result.get("path"))}))
        for proposal in self.native.parent.glob("*.waffle-ai"):
            proposal.unlink()
        for proposal in self.native.glob("*.waffle-ai"):
            proposal.unlink()
        _, error = self.call(self.manifest, "move_component", {"document_id": self.pcb, "component": ref, "dx": 1, "mode": "write",
                                                               "source_sha256": "0" * 64}, flags=("--allow-write",), transport="mcp")
        self.results.append(row("mcp.stale-write-refused", bool(error) and error.startswith("stale_source"), {"reply": error or "the write was accepted"}))

    def slide(self):
        """Drag one via with a script transaction: the scripting surface, and an edit the binary Altium writer holds."""
        result, error = self.edit(None, "run_script", {"code": SLIDE, "args": {"doc": self.pcb, "dx": 0.254}})
        via = (result or {}).get("result")
        if error or not via:
            self.results.append(row("slide.edit.via", error is None, {"error": error} if error else {"reason": "the board has no via on a net"}, gating=error is not None))
            return
        self.touched["nets"].add(via["net"])
        self.results.append(row("slide.edit.via", True, {"net": via["net"], "dxMm": 0.254}))
        saved = self.save_back("slide")
        locked = {s["target"]: COPPER_LOCKED for s in saved if s["error"] and COPPER_LOCKED in s["error"]}
        for target in locked:  # as with footprints: Waffle moved copper its Altium source locks
            self.results.append(row("slide.%s.source-locks-copper" % target, False, {"net": via["net"]}, gating=False))
        self.results += self.check("slide", saved, refuse=locked)["results"]
        if locked:  # put it back, so the next stage asks the binary writer about its own edit only
            self.edit(None, "run_script", {"code": SLIDE, "args": {"doc": self.pcb, "dx": -0.254, "id": via["id"]}})

    def drag(self):
        """Translate one footprint. A footprint the Altium source locks or groups is put back and the next one tried."""
        tries = self.parts[:3]
        for index, part in enumerate(tries):
            _, error = self.edit(None, "move_component", {"document_id": self.pcb, "component": part["ref"], "dx": DRAG[0], "dy": DRAG[1]})
            if error:
                self.results.append(row("drag.edit.move", False, {"component": part["ref"], "error": error}))
                return
            saved = self.save_back("drag")
            locked = {s["target"]: LOCKED for s in saved if s["error"] and LOCKED in s["error"]}
            if not locked or index == len(tries) - 1:
                # Waffle moved a footprint its Altium source locks; the binary writer will not. Reported, not gated.
                for target in locked:
                    self.results.append(row("drag.%s.source-locks-footprints" % target, False, {"tried": [p["ref"] for p in tries]}, gating=False))
                self.dragged = part["ref"]
                self.touched["refs"].add(part["ref"])
                self.results.append(row("drag.edit.move", True, {"component": part["ref"], "dxMm": DRAG[0], "dyMm": DRAG[1]}))
                self.results += self.check("drag", saved, refuse=locked)["results"]
                return
            self.edit(None, "move_component", {"document_id": self.pcb, "component": part["ref"], "x": part["x"], "y": part["y"]})

    def rework(self):
        others = [p for p in self.parts if p["ref"] != getattr(self, "dragged", None)] or self.parts
        turn, flip = others[0], others[1 % len(others)]
        _, error = self.edit("rework.edit.rotate", "move_component", {"document_id": self.pcb, "component": turn["ref"],
                                                                     "rotation": (turn.get("angle", 0) + 30) % 360})
        if not error:
            self.touched["refs"].add(turn["ref"])
        _, error = self.edit("rework.edit.flip", "run_command", {"command": "flip_side", "args": {"document_id": self.pcb, "designators": [flip["ref"]]}})
        if not error:
            self.touched["refs"].add(flip["ref"])
        placed, error = self.edit("rework.edit.place", "run_command", {"command": "duplicate", "args": {
            "document_id": self.pcb, "designators": [others[-1]["ref"]], "dx": 2.54, "dy": 2.54}})
        for item in ((placed or {}).get("untrusted_design_text") or {}).get("items", []):
            self.touched["refs"].add(item["ref"])
        self.route()
        self.rework_saved = self.save_back("rework")
        self.results += self.check("rework", self.rework_saved)["results"]

    def route(self):
        """Route the shortest open pad-to-pad connections until one is committed."""
        page, error = self.call(self.manifest, "board_connectivity", {"document_id": self.pcb, "section": "airwires", "limit": 200}, flags=("--read-only",))
        pad = lambda label: dict(zip(("component", "pad"), label.rsplit(".", 1))) if "." in (label or "") else None
        wires = sorted((w for w in (page or {}).get("items", []) if pad(w.get("fromLabel")) and pad(w.get("toLabel"))
                        and w["fromLabel"].rsplit(".", 1)[0] != w["toLabel"].rsplit(".", 1)[0]), key=lambda w: w["distance"])
        tried = []
        for wire in wires[:6]:
            routed, error = self.edit(None, "route_connection", {"document_id": self.pcb, "from": pad(wire["fromLabel"]), "to": pad(wire["toLabel"]),
                                                                 "time_limit_ms": 5000})
            if not error:
                self.touched["nets"].add(routed.get("net", wire["net"]))
                self.results.append(row("rework.edit.route", True, {"net": wire["net"], "from": wire["fromLabel"], "to": wire["toLabel"], "changes": routed.get("changes")}))
                return
            tried.append(wire["fromLabel"] + "-" + wire["toLabel"] + ": " + error[:120])
        self.results.append(row("rework.edit.route", False, {"candidates": len(wires), "error": error or "the edited board has no open pad-to-pad connection"}, tried))

    def sidecar(self):
        """The project opens, and says the same design, without the parts of .waffle its .gitignore sets aside."""
        ignored = [line.strip("/") for line in (self.native / ".waffle/.gitignore").read_text().split() if line.strip("/")]
        bare = self.work / "bare"
        shutil.copytree(self.native, bare, ignore=shutil.ignore_patterns("*-outputs"))
        for name in ignored:
            shutil.rmtree(bare / ".waffle" / name, ignore_errors=True)
        manifest = bare / self.manifest.name
        summary, error = self.call(manifest, "project_summary", flags=("--read-only",))
        metric = {"removed": ignored, **({"error": error} if error else {"sameRevision": summary.get("file_revision") == self.revision})}
        if not error and getattr(self, "rework_saved", None):
            again, export_error = self.call(manifest, "export_kicad", {"document_id": self.pcb, "output_dir": "bare-kicad"})
            first = next((f for s in self.rework_saved if s["target"] == "kicad" for f in s["files"] if f["name"].lower().endswith(".kicad_pcb")), None)
            second = next((f for f in (again or {}).get("files", []) if f["path"].lower().endswith(".kicad_pcb")), None)
            metric["sameSave"] = bool(first and second and Path(first["path"]).read_bytes() == Path(second["path"]).read_bytes())
            if export_error:
                metric["exportError"] = export_error[:200]
        self.results.append(row("sidecar.local-data-removable", error is None and metric.get("sameRevision") and metric.get("sameSave", True), metric))
        # Edit in place asks for more (Atrium task 66, rule 3): delete the whole folder and the project still opens.
        # A native project keeps its retained sources there as members, so today this is reported, not gated.
        shutil.rmtree(bare / ".waffle")
        _, error = self.call(manifest, "project_summary", flags=("--read-only",))
        self.results.append(row("sidecar.whole-folder-removable", error is None, {"reason": error[:200]} if error else {}, gating=False))

    def safety(self):
        after = snapshot(self.source_dir)
        outside = {k: v for k, v in after.items() if not k.startswith("native/")}
        changed = sorted(k for k in self.before if outside.get(k) != self.before[k])
        created = sorted(k for k in outside if k not in self.before)
        self.results.append(row("safety.source-untouched", not changed and not created, {"files": len(self.before), "changed": len(changed), "created": len(created)},
                                ["changed " + k for k in changed] + ["created " + k for k in created]))

    def run(self):
        if self.timed("import", self.open) and self.parts:
            for name in ("clean", "protocol", "slide", "drag", "rework", "sidecar"):
                self.timed(name, getattr(self, name))
        self.safety()
        return {"id": self.project["id"], "results": self.results, "timings": self.timings, "calls": self.calls}

    def mutations(self, clean):
        """Damage the saved KiCad board as a writer bug would: the checks must turn red."""
        saved = [s for s in getattr(self, "rework_saved", []) if s["target"] == "kicad" and not s["error"]]
        names = json.loads((HERE / "mutations.json").read_text())["editFlow"]
        out = []
        for name in names if saved else []:
            mutated = self.check("rework", saved, mutation=name, outputs=False)
            out.append((name, mutated.get("mutationApplied"), full.newly_red(clean, mutated)))
        return out


def projects(args):
    selected = [{**p, "files": [str(ROOT / f) for f in p["files"]]} for p in VENDORED]
    if args.tier == "full":
        for project in full.corpus():
            request = full.request_for(project, args.cache, offline=not args.fetch)
            selected.append({"id": project["id"], "translator": project["translator"],
                             "files": [f["path"] for f in request["files"] if f["role"] == "source"]})
    return [p for p in selected if not args.only or p["id"] in args.only]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tier", choices=("fast", "full"), default="fast")
    parser.add_argument("--cache", type=Path, default=full.fetch.DEFAULT_CACHE)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--fetch", action="store_true", help="download missing pinned fixtures (full tier; default: offline)")
    parser.add_argument("--only", nargs="*", help="project IDs to run")
    parser.add_argument("--mutations", action="store_true", help="also prove each saved-file mutation turns the suite red")
    parser.add_argument("--json", type=Path, help="write the full results here")
    parser.add_argument("--keep", type=Path, help="keep every project's working folder under this directory")
    args = parser.parse_args()
    full.prepare_modules()
    if not args.node:
        parser.error("Node.js 24 is required")
    ensure_native_host()
    # One entry per defect here, naming every check it turns red; the report wants one row per check.
    known = [{"project": k["project"], "check": check, "bug": k["bug"]}
             for k in json.loads((HERE / "edit-known-failures.json").read_text())["failures"] for check in k["checks"]]
    try:
        selected = projects(args)
    except Exception as error:  # a missing fixture is a failure of the full tier, not a skip
        print(f"FAIL  fixtures unavailable ({type(error).__name__}); run with --fetch")
        return 1
    status, reports = 0, []
    with tempfile.TemporaryDirectory(prefix="waffle-edit-flow-") as scratch:
        base = (args.keep or Path(scratch)).resolve()
        for project in selected:
            work = base / project["id"]
            shutil.rmtree(work, ignore_errors=True)
            started = time.monotonic()
            flow = Flow(project, project["files"], work, args.node)
            try:
                report = flow.run()
            except Exception as error:
                report = {"id": project["id"], "crash": f"{type(error).__name__}: {error}"[:600]}
            report["seconds"] = round(time.monotonic() - started, 1)
            reports.append(report)
            status |= full.summarise(report, known, project)
            if args.mutations and not report.get("crash"):
                for name, applied, red in flow.mutations(report):
                    verdict = "FAIL: could not evaluate mutation" if applied is None else "STILL GREEN" if applied and not red else "red" if red else "not applicable"
                    status |= verdict in ("FAIL: could not evaluate mutation", "STILL GREEN")
                    print(f"      mutation {name:<22} {verdict}" + (f"  ({', '.join(red[:5])})" if red else ""))
                    reports.append({"id": project["id"], "mutation": name, "applied": applied, "newFailures": red})
    if args.json:
        args.json.write_text(json.dumps(reports, indent=1))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
