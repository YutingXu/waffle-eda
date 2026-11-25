"""Resolve publication pages by their real output job and PDF bookmarks."""
from collections import defaultdict
from statistics import median

from pypdf import PdfReader


LAYERS = {"TopLayer":"Top", "BottomLayer":"Bottom", "TopOverlay":"Silk", "BottomOverlay":"Bottom silk",
          "InternalPlane1":"Inner 1", "InternalPlane2":"Inner 2", "Mechanical2":"Mechanical 2"}


def bookmarks(doc, entries, prefix=()):
    name = None
    for item in entries:
        if isinstance(item, list):
            if name is not None:
                yield from bookmarks(doc, item, (*prefix, name))
        elif hasattr(item, "title"):
            name = item.title
            page = doc.get_destination_page_number(item)
            if page is not None and page >= 0:
                yield (*prefix, name), page + 1


def properties(text):
    return dict(field.split("=", 1) for field in text.split("|") if "=" in field)


def print_job(text, output):
    settings = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    title = settings[f"OutputName{output}"]
    paper = properties(settings[f"PageOptions{output}"])
    assert paper["PaperKind"] == "A4" and paper["Orientation"] == "1"
    assert paper["CenterHorizontal"] == paper["CenterVertical"] == "True"
    assert paper["XCorrection"] == paper["YCorrection"] == "1.00"
    assert paper["LeftOffset"] == paper["BottomOffset"] == "0"
    border = int(paper["BorderSize"]) * .00000254
    mode = paper["PrintScaleMode"]
    if mode == "0":
        scale = float(paper["PrintScale"])
    elif mode == "1" and paper.get("PrintScaleName") == "PrintFitPageWidth":
        scale = "fit-width"
    else:
        raise ValueError("Unrecognized publication scale")
    records = [properties(value) for key, value in settings.items() if key.startswith(f"Configuration{output}_Item")]
    assert any(record.get("PrintArea") == "DesignExtent" for record in records)
    pages = {}
    for record in records:
        if record.get("Record") == "PcbPrintOut":
            pages[record["Index"]] = {"title":record["Name"], "flip":record["Mirror"] == "True",
                                      "holes":record["ShowHoles"] == "True",
                                      "padNets":record["ShowPadNets"] == "True",
                                      "padNumbers":record["ShowPadNumbers"] == "True", "layers":[],
                                      "borderMm":border, "scale":scale}
    for record in records:
        if record.get("Record") == "PcbPrintLayer":
            pages[record["PrintOutIndex"]]["layers"].append(LAYERS[record["Layer"]])
    return title, pages.values()


def anchors(page):
    """Read unique invisible PDF text anchors without inheriting any visible ink."""
    positions = defaultdict(list)
    transform = None
    mode = None
    for args, operator in page.get_contents().operations:
        if operator == b"Tm":
            transform = args
        elif operator == b"Tr":
            mode = args[0]
        elif operator == b"Tj" and mode == 3 and transform:
            token = str(args[0]).strip()
            if token:
                positions[token].append(tuple(map(float, transform[4:6])))
    return {token:points[0] for token,points in positions.items() if len(points) == 1}


def fit_scale(fixed_page, fit_page):
    # The publication repeats the same invisible part and pin anchors on its fixed 1:1
    # and fit-width sheets. Estimate the latter's actual physical scale from the source
    # pages alone. The candidate artwork never supplies coordinates for this transform.
    fixed = anchors(fixed_page)
    fitted = anchors(fit_page)
    fixed_center = (float(fixed_page.mediabox.width) / 2, float(fixed_page.mediabox.height) / 2)
    fit_center = (float(fit_page.mediabox.width) / 2, float(fit_page.mediabox.height) / 2)
    pairs = [(a,b) for token in fixed.keys() & fitted.keys() for axis in (0, 1)
             for a,b in [(fixed[token][axis] - fixed_center[axis], fitted[token][axis] - fit_center[axis])]
             if abs(a) > 10]
    assert len(pairs) >= 20, "insufficient shared publication anchors"
    scale = median(b/a for a,b in pairs)
    assert 1 < scale < 10 and max(abs(b - scale*a) for a,b in pairs) < 4, "unstable publication scale"
    return round(scale, 3)


def resolve(fixture, files):
    """Return precise PCB views, available assembly views, or a known absent comparison."""
    selected = {}
    by_name = {path.name:path for _, path in files}
    jobs = [path for role, path in files if role == "print-setup"]
    for name, scope in fixture.get("pdfPageViews", {}).items():
        doc = PdfReader(by_name[name])
        paths = list(bookmarks(doc, doc.outline))
        views = {}
        for output in scope.get("printOutputs", ()):
            assert len(jobs) == 1
            title, pages = print_job(jobs[0].read_text(encoding="cp1252"), output)
            for page in pages:
                matches = [n for path,n in paths if path[0] == title and path[-1] == page["title"]]
                assert len(matches) == 1 and matches[0] not in views
                n = matches[0]
                reference = doc.pages[n-1]
                media, crop = reference.mediabox, reference.cropbox
                bounds = [float(crop.left - media.left), float(media.top - crop.top), float(crop.width), float(crop.height)]
                views[n] = {**page, "kind":"pcb", "mediaPt":[float(media.width), float(media.height)], "cropPt":bounds}
        fixed = next((n for n,p in views.items() if p["scale"] == 1 and not p["flip"]), None)
        fit = next((n for n,p in views.items() if p["scale"] == "fit-width"), None)
        physical_scale = fit_scale(doc.pages[fixed-1], doc.pages[fit-1]) if fixed and fit else None
        for page in views.values():
            if page["scale"] == "fit-width":
                assert physical_scale is not None
                page["physicalScale"] = physical_scale
            if any(layer.startswith("Inner ") for layer in page["layers"]):
                page["kind"] = "negative-plane"
            elif not any(page[key] for key in ("holes", "padNets", "padNumbers")) and all(
                    layer in ("Top", "Bottom") or layer.startswith("Mechanical ") for layer in page["layers"]):
                page["kind"] = "positive-copper"
        for number, page in scope.get("pages", {}).items():
            n = int(number)
            assert 1 <= n <= len(doc.pages) and n not in views
            if "bookmark" in page:
                assert any(path[-1] == page["bookmark"] and current == n for path,current in paths)
            if "text" in page:
                assert page["text"] in (doc.pages[n-1].extract_text() or "")
            views[n] = page
        selected[name] = views
    return selected
