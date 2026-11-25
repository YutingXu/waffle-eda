"""Compare a ReadSchematicOutputs receipt against the emitted Altium records."""
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys

RECORDS = {"1": "components", "27": "wires", "25": "net_labels", "17": "power_ports", "29": "junctions",
           "18": "ports", "15": "sheet_symbols", "4": "labels", "28": "text_frames", "30": "images"}
MM_PER_TICK = 0.00000254


def expected_paper(row):
    if row.get("USECUSTOMSHEET") == "T":
        return [position(row, key) for key in ("CUSTOMX", "CUSTOMY")]
    if row.get("SHEETSTYLE", "0") == "0":
        return [292.1, 193.04]
    raise ValueError("No expected paper for this exported fixture")


def position(row, key):
    return round(int(row.get(key, 0)) * 0.254 + int(row.get(key + "_FRAC", 0)) * MM_PER_TICK, 6)


def fields(raw):
    return dict(piece.split("=", 1) for piece in raw.decode("latin1").split("|") if "=" in piece)


def normal_text(value):
    return value.replace("~1", "\n").replace("\r\n", "\n").replace("\r", "\n")


def expected_text(row):
    utf8 = row.get("%UTF8%TEXT")
    return normal_text(utf8.encode("latin1").decode("utf8") if utf8 is not None else row.get("TEXT", ""))


def native_text(code):
    return normal_text(b"".join(int(code[i:i + 4], 16).to_bytes(2, "little") for i in range(0, len(code), 4)).decode("utf-16le"))


def close(a, b):
    return len(a) == len(b) and all(abs(x-y) <= .011 for x, y in zip(a, b))


def compare(stage, lines):
    values = defaultdict(lambda: defaultdict(list))
    for line in lines:
        case, doc, kind, *data = line.split("|")
        values[(case, doc)][kind].append(data)
    results, failures = {"sheets": {}, "projects": {}}, []

    for file in sorted(stage.glob("*/*.SchDoc")):
        case, name = file.parent.name, file.name
        rows = [fields(line) for line in file.read_bytes().splitlines()]
        native = values.get((case, name), {})
        key = case + "/" + name
        observed = {}
        results["sheets"][key] = observed
        def verify(condition, what):
            if not condition:
                failures.append(key + " " + what)
        verify(native.get("sheet") == [[name]], "sheet did not open")
        if not native:
            continue
        expected_counts = Counter(RECORDS.get(row.get("RECORD")) for row in rows)
        counts = {name: int(value) for name, value in native.get("count", [])}
        observed["counts"] = counts
        verify(all(counts.get(k) == expected_counts[k] for k in RECORDS.values()), "object counts")
        paper = [round(int(value) * MM_PER_TICK, 6) for value in next(iter(native.get("paper", [])), [])]
        observed["paperMm"] = paper
        verify(close(paper, expected_paper(next(row for row in rows if row.get("RECORD") == "31"))), "paper size")
        expected = sorted((RECORDS[row["RECORD"]], expected_text(row)) for row in rows if row.get("RECORD") in ("4", "25", "28"))
        texts = sorted((name, native_text(code)) for name, code in native.get("text", []))
        observed["text"] = [s for _, s in texts]
        verify(texts == expected, "native static text")
        comments = {row["OWNERINDEX"]: row.get("TEXT", "") for row in rows
                    if row.get("RECORD") == "41" and row.get("NAME") == "Comment"}
        components = sorted([row["TEXT"], comments.get(row["OWNERINDEX"], "")] for row in rows
                            if row.get("RECORD") == "34" and row.get("NAME") == "Designator")
        observed["components"] = sorted(native.get("component", []))
        verify(observed["components"] == components, "component identities/values")
        observed["children"] = sorted(name for [name] in native.get("child", []))
        children = sorted(row["TEXT"] for row in rows if row.get("RECORD") == "33")
        verify(observed["children"] == children, "child filenames")
        observed["ports"] = sorted(name for [name] in native.get("port", []))
        verify(observed["ports"] == sorted(row["NAME"] for row in rows if row.get("RECORD") == "18"), "port names")
        image_rows = [row for row in rows if row.get("RECORD") == "30"]
        observed["images"] = [{"file": row[0], "boundsMm": [round(int(v)*MM_PER_TICK, 6) for v in row[1:]]} for row in native.get("image", [])]
        for row, image in zip(image_rows, observed["images"]):
            box = [position(row, k) for k in ("LOCATION.X","LOCATION.Y","CORNER.X","CORNER.Y")]
            verify(image["file"] == row["FILENAME"] and close(image["boundsMm"], box), "image bounds/sidecar")
        verify(len(observed["images"]) == len(image_rows), "image count")
        verify(not native.get("failure"), "native query incomplete")

    for project in sorted(stage.glob("*/*.PrjPcb")):
        case = project.parent.name
        rows = values.get((case, ""), {})
        nets = {name: int(pins) for name, pins in rows.get("net", [])}
        members = sorted(name for name, kind in rows.get("member", []) if kind.upper() == "SCH")
        results["projects"][case] = {"members": members, "netPins": nets}
        if members != sorted(file.name for file in project.parent.glob("*.SchDoc")):
            failures.append(case + " project members")
        if rows.get("project") != [[project.name]]:
            failures.append(case + " native project open")
        if rows.get("nets") != [[str(len(nets))]] or rows.get("failure"):
            failures.append(case + " native compile incomplete")
        if case == "frames" and nets != {"SIGNAL": 2}:
            failures.append(case + " connected test points")
        if case != "frames" and nets:
            failures.append(case + " unexpected electrical nets")
    results["failedChecks"] = failures
    return results


def read_receipt(path):
    raw = path.read_bytes()
    return raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig").splitlines()


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    results = compare(folder, read_receipt(folder / "result.txt"))
    print(json.dumps(results, indent=2, ensure_ascii=False))
    sys.exit(bool(results["failedChecks"]))
