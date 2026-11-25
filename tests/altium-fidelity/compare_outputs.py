"""Compare the assembly outputs and the text-bearing portions of the published PDFs."""
import csv
import io
import logging
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from html.parser import HTMLParser
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader

logging.getLogger("pypdf").setLevel(logging.ERROR)


def csv_rows(path):
    return list(csv.reader(io.StringIO(path.read_bytes().decode("utf-8-sig", errors="replace"))))


def xlsx_rows(path):
    # Read cells by their actual column address. Styles, links and formula evaluation aren't needed.
    with zipfile.ZipFile(path) as book:
        strings = ["".join(s.itertext()) for s in ET.fromstring(book.read("xl/sharedStrings.xml"))]
        rows = []
        for row in ET.fromstring(book.read("xl/worksheets/sheet1.xml")).findall(".//{*}row"):
            cells = []
            for cell in row.findall("{*}c"):
                col = 0
                for letter in re.match(r"[A-Z]+", cell.get("r")).group():
                    col = col * 26 + ord(letter) - ord("A") + 1
                cells.extend([""] * (col - len(cells)))
                value = cell.findtext("{*}v", "")
                cells[col - 1] = strings[int(value)] if value and cell.get("t") == "s" else value
            rows.append(cells)
    return rows


def column_table(rows):
    for i, cells in enumerate(rows):
        keys = [c.strip().casefold() for c in cells]
        if "designator" in keys or "quantity" in keys:
            return keys, [dict(zip(keys, row)) for row in rows[i+1:] if any(c.strip() for c in row)]
    raise ValueError("no column headings in assembly table")


def expand_refs(text):
    refs = []
    for part in re.split(r"\s*,\s*", text.strip()):
        m = re.fullmatch(r"([^\d]*)(\d+)-([^\d]*)(\d+)", part)
        if m and m[1] == m[3] and 0 <= int(m[4]) - int(m[2]) < 10000:
            refs.extend(m[1] + str(i) for i in range(int(m[2]), int(m[4]) + 1))
        elif part:
            refs.append(part)
    return refs


def bom_values(rows):
    headers, records = column_table(rows)
    with_refs = "designator" in headers
    refs, quantity, used = set(), 0, 0
    for row in records:
        ids = expand_refs(row.get("designator", ""))
        n = row.get("quantity", "")
        if not (n.isdigit() or ids):
            continue
        quantity += int(n) if n.isdigit() else len(ids)
        used += 1
        refs.update(ids)
    return {"rows": used, "parts": quantity, "refs": refs if with_refs else None}


def set_diff(ref, out):
    return {"reference": len(ref), "generated": len(out), "missing": len(ref - out), "extra": len(out - ref)}


def placements(rows):
    head, records = column_table(rows)
    x = next(k for k in head if k.startswith("center-x("))
    y = next(k for k in head if k.startswith("center-y("))
    scale = 0.0254 if "(mil)" in x else 1
    if "(mil)" not in x and "(mm)" not in x:
        raise ValueError("unknown pick-and-place units")
    return {r["designator"]: (float(r[x]) * scale, float(r[y]) * scale, float(r["rotation"]), r["layer"].lower())
            for r in records if r.get("designator")}


def assembly(refs, scratch, outputs):
    generated = bom_values(csv_rows(scratch / "bom.csv"))
    assert generated["parts"] == outputs["bomParts"] and generated["rows"] == outputs["bomRows"]
    pnp = placements(csv_rows(scratch / "pnp.csv"))
    assert len(pnp) == outputs["pickPlaceRows"]
    differences = {"bom": None, "pickPlace": None}
    if "bom" in refs:
        path = refs["bom"]
        ref = bom_values(xlsx_rows(path) if path.suffix.lower() == ".xlsx" else csv_rows(path))
        differences["bom"] = {"referenceParts":ref["parts"], "referenceRows":ref["rows"],
                              "quantityDelta":abs(ref["parts"] - generated["parts"]),
                              "designators":set_diff(ref["refs"], generated["refs"]) if ref["refs"] is not None else None}
    if "pnp" in refs:
        ref = placements(csv_rows(refs["pnp"]))
        matched = pnp.keys() & ref.keys()
        distances = [math.dist(pnp[k][:2], ref[k][:2]) for k in matched]
        differences["pickPlace"] = {**set_diff(set(ref), set(pnp)),
            "centresOver10um":sum(d > .01 for d in distances),
            "maxCentreErrorMm":round(max(distances), 4) if distances else None,
            "rotationsOverPoint1deg":sum(abs((ref[k][2] - pnp[k][2] + 180) % 360 - 180) > .1 for k in matched),
            "sideChanges":sum(ref[k][3] != pnp[k][3] for k in matched)}
    return differences, generated["refs"]


def thumbnail(doc, page_number):
    # Map the whole page to the unit square. Sample the PDFium grayscale render on a
    # fixed 128 × 128 lattice; this measures print differences, including page layout.
    size = 128
    page = doc[page_number]
    try:
        bitmap = page.render(scale=(size * 3) / max(page.get_size()), grayscale=True)
        try:
            assert bitmap.n_channels == 1
            return sample_thumbnail(bytes(bitmap.buffer), bitmap.width, bitmap.height, bitmap.stride)
        finally:
            bitmap.close()
    finally:
        page.close()


def sample_thumbnail(pixels, width, height, stride):
    size = 128
    xs = [min(width-1, int((x+.5)*width/size)) for x in range(size)]
    ys = [min(height-1, int((y+.5)*height/size)) * stride for y in range(size)]
    return bytes(pixels[row+x] for row in ys for x in xs)


def schematic_bookmarks(reader):
    sheets = {}
    def visit(entries):
        for entry in entries:
            if isinstance(entry, list):
                visit(entry)
            elif hasattr(entry, "title"):
                match = re.match(r"(.+)\.SchDoc(?:\(|$)", entry.title, re.I)
                if match:
                    sheets[reader.get_destination_page_number(entry) + 1] = match[1].casefold()
    visit(reader.outline)
    return sheets


def pdf_comparisons(fixture, files, scratch, detail, bom_refs, views):
    generated = PdfReader(scratch / "generated.pdf")
    assert len(generated.pages) == len(detail["pages"])
    # Count only the imported project's exact designators. Net names and substrings in
    # part numbers are not independent component labels.
    pattern = "|".join(map(re.escape, sorted(set(detail["refs"]), key=lambda x: (-len(x), x))))
    regex = re.compile(r"(?<![A-Za-z\d_])(?:" + pattern + r")(?![A-Za-z\d_])")
    def designators(text):
        return set(regex.findall(text))
    out_text = {}
    for info, page in zip(detail["pages"], generated.pages):
        out_text.setdefault(info["kind"], set()).update(designators(page.extract_text() or ""))
    out_text["bom"] = bom_refs
    with pdfium.PdfDocument(scratch / "generated.pdf") as doc:
        thumbnails = [thumbnail(doc, i) for i in range(len(doc))]
    if detail["sourceViews"]:
        with pdfium.PdfDocument(scratch / "published-views.pdf") as doc:
            assert len(doc) == len(detail["sourceViews"])
            published_views = {(p["name"], p["n"]):thumbnail(doc, i) for i,p in enumerate(detail["sourceViews"])}
    else:
        published_views = {}
    plane_views = {}
    for i, plane in enumerate(detail["planeViews"]):
        pixels = (scratch / f"published-plane-{i}.gray").read_bytes()
        w,h = plane["width"], plane["height"]
        assert len(pixels) == w*h
        plane_views[plane["name"], plane["n"]] = sample_thumbnail(pixels, w, h, w)
    def ink_difference(left, right):
        return round(100 * sum(abs(a-b) for a,b in zip(left, right)) / (255 * len(left)), 1)
    results = {}
    kinds = {"board":"composite", "assembly":"assembly-top", "fabrication":"drill"}
    for role, path in files:
        ref = PdfReader(path)
        kind = role.split(":")[1]
        if kind == "mixed":
            scopes = fixture["pdfSections"]
        else:
            scopes = {kinds.get(kind, kind): list(range(1, len(ref.pages) + 1))}
        assert sorted(i for group in scopes.values() for i in group) == list(range(1, len(ref.pages) + 1))
        bookmarks = schematic_bookmarks(ref)
        groups = {}
        with pdfium.PdfDocument(path) as ref_doc:
            images = [thumbnail(ref_doc, i) for i in range(len(ref_doc))]
        for key, pages in scopes.items():
            text = "\n".join(ref.pages[i-1].extract_text() or "" for i in pages)
            tokens = designators(text)
            if key == "3d":
                groups[key] = {"designators":None, "reason":"3D presentation"}
            elif not tokens:
                groups[key] = {"designators":None, "reason":"no extractable reference designators"}
            else:
                groups[key] = {"designators":set_diff(tokens, out_text[key])}
            if key in ("3d", "bom"):
                continue
            candidates = [i for i, info in enumerate(detail["pages"]) if info["kind"] == key]
            deltas = []
            for n in pages:
                if len(candidates) == 1:
                    target = candidates[0]
                else:
                    matches = [i for i in candidates if detail["pages"][i]["name"].casefold() == bookmarks.get(n)]
                    if len(matches) != 1:
                        raise ValueError("ambiguous schematic page correspondence")
                    target = matches[0]
                deltas.append(ink_difference(images[n-1], thumbnails[target]))
            groups[key]["pageInkDifferencePct"] = {str(n):delta for n,delta in zip(pages,deltas)}
        results[path.name] = {"referencePages":len(ref.pages), "sections":groups}
        if path.name in views:
            comparable = {}
            for n, view in views[path.name].items():
                kind = view["kind"]
                if kind == "unavailable":
                    comparable[str(n)] = {"reason":view["reason"], "inkDifferencePct":None}
                    continue
                reference = images[n-1]
                if kind in ("pcb", "negative-plane", "positive-copper"):
                    is_plane = kind != "pcb"
                    candidate = (plane_views if is_plane else published_views)[(path.name, n)]
                    identity = {"view":view["title"], "layers":view["layers"], "scale":view.get("physicalScale", view["scale"]),
                                "mirrored":view["flip"]}
                    if is_plane:
                        reference = bytes(0 if v < 245 else 255 for v in reference)
                        identity["polarity"] = "negative plane artwork" if kind == "negative-plane" else "positive copper artwork"
                else:
                    matches = [i for i, page in enumerate(detail["pages"]) if page["kind"] == kind]
                    assert len(matches) == 1
                    candidate = thumbnails[matches[0]]
                    identity = {"view":view["bookmark"]}
                comparable[str(n)] = {**identity, "inkDifferencePct":ink_difference(reference, candidate)}
            results[path.name]["sourcePageViews"] = comparable
    return results


class Cells(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cells = []
    def handle_data(self, data):
        if data.strip():
            self.cells.append(data.strip())


def check_reports(paths, out):
    results = {}
    for role, path in paths:
        parser = Cells()
        parser.feed(path.read_bytes().decode("cp1252"))
        text = parser.cells
        if role == "check:erc":
            if not any("Successful Compile; No Violations Found" in line for line in text):
                raise ValueError("unrecognised reference ERC summary")
            errors = sum(out["erc"][k] for k in ("Fatal", "Error", "Warning"))
            results["erc"] = {"reference":0, "difference": errors}
        else:
            table = text[text.index("Rule Violations"):text.index("Waived Violations")]
            count = int(table[table.index("Total") + 1])
            results["drc"] = {"reference":count, "difference":abs(count - out["drc"]["total"])}
    return results
