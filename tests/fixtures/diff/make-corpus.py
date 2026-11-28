#!/usr/bin/env python3
"""Build the design-diff corpus (tests/history/diff.cjs) from the sample design, and refresh its goldens.

    python3 tests/fixtures/diff/make-corpus.py            # write native frozen revisions and corpus.json
    python3 tests/fixtures/diff/make-corpus.py --golden   # also run the engine under JSC and store each expected change set

Every case pairs the checked-in native Sensor board with an edited copy
("after"). The edits are the ones engineers make between commits: move, re-route, swap pins, rename
a net, re-annotate, re-import with new ids, change a library footprint, merge nets, change values and
footprints, outline / rules / variants, delete and add parts, and pure re-serialisation noise. The
expected change set of each case is reviewed by hand after --golden and then kept as the golden.
"""
import copy
import json
import random
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NATIVE = HERE / "encode-native.cjs"


def load():
    return json.loads(subprocess.check_output(["node", str(NATIVE), "--base"], cwd=ROOT))


def docs(p):
    return {d["kind"]: d for d in p["documents"]}


def item(doc, **match):
    return next(i for i in doc["items"] if all(i.get(k) == v for k, v in match.items()))


CASES = []


def case(name, description, options=None):
    def wrap(fn):
        CASES.append((name, description, options or {}, fn))
        return fn
    return wrap


@case("reserialised", "Same design saved by another writer: keys and objects reordered, sub-tolerance float noise. Expect no changes.")
def _(p):
    rnd = random.Random(7)
    def noisy(v):
        if isinstance(v, float) or isinstance(v, int) and not isinstance(v, bool):
            return v + 1e-7 if isinstance(v, float) else v
        if isinstance(v, list):
            return [noisy(x) for x in v]
        if isinstance(v, dict):
            keys = list(v)
            rnd.shuffle(keys)
            return {k: (noisy(v[k]) if k not in ("id", "version") else v[k]) for k in keys}
        return v
    for d in p["documents"]:
        rnd.shuffle(d["items"])
    return noisy(p)


@case("move-rotate-flip", "Board placement: U1 moved, R2 rotated 90°, C1 flipped to the bottom; on the sheet R2 moved (cosmetic).")
def _(p):
    b, s = docs(p)["pcb"], docs(p)["schematic"]
    item(b, id="b-U1")["x"] += 2.5
    item(b, id="b-R2")["angle"] = 90
    item(b, id="b-C1")["layer"] = "Bottom"
    item(s, id="s-R2")["y"] -= 0.00001  # below tolerance and below the connection grid: not a change
    return p


@case("reroute", "VIN re-routed with a detour and a via; a GND stub deleted; BUF track widened.")
def _(p):
    b = docs(p)["pcb"]
    t = item(b, id="amwmqqymdz6qwm82446")
    t["points"] = [[3.8, 11], [5.5, 11], [6.5, 12], [8.1, 12], [9.1, 11]]
    b["items"].append({"id": "new-via-vin", "kind": "via", "x": 6.5, "y": 12, "diameter": 0.6, "drill": 0.3, "net": "VIN", "layer": "Multi"})
    b["items"] = [i for i in b["items"] if i["id"] != "amwmqqymddl64c9sdq1h"]
    item(b, id="amwmqqymdyrrm6cwmjo")["width"] = 0.4
    return p


@case("pin-swap", "Gate-equivalent pins swapped on the board: U1 pin 1 and 3 exchange BUF and FILTER, the tracks follow.")
def _(p):
    b = docs(p)["pcb"]
    u = item(b, id="b-U1")
    u["pinNets"]["1"], u["pinNets"]["3"] = u["pinNets"]["3"], u["pinNets"]["1"]
    return p


@case("rename-net", "Net VOUT renamed to VOUT_BUF everywhere: the sheet label, both parts' pin nets and the board track.")
def _(p):
    for d in p["documents"]:
        for i in d["items"]:
            if i.get("text") == "VOUT":
                i["text"] = "VOUT_BUF"
            if i.get("net") == "VOUT":
                i["net"] = "VOUT_BUF"
            for k, v in (i.get("pinNets") or {}).items():
                if v == "VOUT":
                    i["pinNets"][k] = "VOUT_BUF"
    return p


@case("reannotate", "Designators renumbered on both documents (R2 -> R5, C1 -> C7, R? -> R3); ids unchanged. Connectivity is equal.")
def _(p):
    names = {"R2": "R5", "C1": "C7", "R?": "R3", "R1": "R3"}
    for d in p["documents"]:
        for i in d["items"]:
            if i["kind"] == "part" and i["ref"] in names:
                i["ref"] = names[i["ref"]]
    return p


@case("reimport-new-ids", "The same design re-imported: every document, object, link and library id regenerated. Matching falls back to designators and geometry; expect no changes.")
def _(p):
    rnd = random.Random(11)
    fresh = lambda: "x" + "".join(rnd.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(18))  # noqa: E731
    lib = {d["id"]: fresh() for d in p["library"]}
    for d in p["library"]:
        d["id"] = lib[d["id"]]
    for d in p["documents"]:
        d["id"] = fresh()
        for i in d["items"]:
            i["id"] = fresh()
            if "def" in i:
                i["def"] = lib[i["def"]]
            if "link" in i:
                i["link"] = "relink-" + i.get("ref", "")
    return p


@case("library-footprint", "Library edit: the resistor footprint's pads grow from 0.9 x 0.95 to 1.0 x 1.1 mm. Affects every placed resistor.")
def _(p):
    r = next(d for d in p["library"] if d["id"] == "std-r")
    for pad in r["footprint"]["pads"]:
        pad["w"], pad["h"] = 1.0, 1.1
    return p


@case("values-footprints", "C1 value 10 nF -> 22 nF on both documents; R2 re-assigned to the test-point footprint on the board; U1 gains an MPN parameter.")
def _(p):
    s, b = docs(p)["schematic"], docs(p)["pcb"]
    item(s, id="s-C1")["value"] = "22 nF"
    item(b, id="b-C1")["value"] = "22 nF"
    item(b, id="b-R2")["def"] = "std-tp"
    item(b, id="b-R2")["pinNets"] = {"1": "BUF"}
    item(s, id="s-U1")["parameters"] = {"MPN": "OPA350AIDBVR"}
    return p


@case("merge-nets", "On the sheet the FILTER label is renamed BUF: nets FILTER and BUF merge.")
def _(p):
    s = docs(p)["schematic"]
    item(s, text="FILTER")["text"] = "BUF"
    return p


@case("outline-rules-variants", "Board outline 36 x 22 -> 40 x 22 mm and an assembly variant added (Lite: C2 not fitted).")
def _(p):
    b = docs(p)["pcb"]
    b["outline"] = [[x + (4 if x > 18 else 0), y] for x, y in b["outline"]]
    p["variants"] = [{"id": "v-lite", "name": "Lite", "parts": {"link-C2": {"dnp": True}}}]
    return p


@case("delete-add", "C2 deleted from both documents with its board copper; R9 added (unwired on the sheet; on the board by ECO with pins on VOUT and a new net SENSE).")
def _(p):
    s, b = docs(p)["schematic"], docs(p)["pcb"]
    s["items"] = [i for i in s["items"] if i["id"] != "s-C2"]
    b["items"] = [i for i in b["items"] if i["id"] not in ("b-C2", "amwmqqymdhabd293oswa")]
    s["items"].append({"id": "s-R9", "kind": "part", "def": "std-r", "ref": "R9", "value": "1 kΩ", "link": "link-R9", "x": 200, "y": 100, "angle": 0,
                       "pinNets": {"1": "VOUT", "2": "SENSE"}})
    b["items"].append({"id": "b-R9", "kind": "part", "def": "std-r", "ref": "R9", "value": "1 kΩ", "link": "link-R9", "x": 28, "y": 14, "angle": 0,
                       "pinNets": {"1": "VOUT", "2": "SENSE"}})
    return p


def build():
    base = load()
    corpus, frozen = [], []
    for name, description, options, fn in CASES:
        after = fn(copy.deepcopy(base))
        frozen.append({"name": name, "project": after})
        corpus.append({"name": name, "description": description, "before": None, "after": name, "options": options})
    subprocess.run(["node", str(NATIVE)], input=json.dumps({"base": base, "cases": frozen}), text=True, check=True, cwd=ROOT)
    return corpus


def main():
    corpus = build()
    path = HERE / "corpus.json"
    old = {c["name"]: c for c in json.loads(path.read_text(encoding="utf-8"))["cases"]} if path.exists() else {}
    for c in corpus:
        if "expected" in old.get(c["name"], {}):
            c["expected"] = old[c["name"]]["expected"]
    if "--golden" in sys.argv[1:]:
        path.write_text(json.dumps({"cases": corpus}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        # The JavaScriptCore runner supplies the app inventory the suite resolves its modules with.
        out = subprocess.run([str(ROOT / "scripts/test-jsc.sh"), "diff", "--", "--print-golden"], capture_output=True, text=True, cwd=ROOT)
        line = next((l for l in out.stdout.splitlines() if l.startswith("GOLDEN ")), None)
        if not line:
            sys.exit("could not compute goldens:\n" + out.stdout[-2000:] + out.stderr[-2000:])
        golden = json.loads(line[len("GOLDEN "):])
        for c in corpus:
            c["expected"] = golden[c["name"]]
    path.write_text(json.dumps({"cases": corpus}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("wrote %d cases to %s" % (len(corpus), path.relative_to(ROOT)))


if __name__ == "__main__":
    main()
