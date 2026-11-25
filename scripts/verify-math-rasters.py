#!/usr/bin/env python3
"""Compare Canvas2D, SVG and PDF ink, and measure agreement with independent XeTeX goldens."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata

from PIL import Image, ImageChops, ImageFilter, ImageOps
from pypdf import PdfReader

REFERENCE = Path(__file__).resolve().parents[1] / "tests/fixtures/math/reference"
TEX_POINTS_PER_INCH = 72.27
GOLDEN_MARGIN_PX = 3


def mask(file):
    with Image.open(file) as image:
        rgba = image.convert("RGBA")
        page = Image.new("RGBA", rgba.size, "white")
        page.alpha_composite(rgba)
        return ImageOps.grayscale(page).point(lambda value: 255 if value < 207 else 0)


def size_normalized(a, b):
    size = (max(a.width, b.width), max(a.height, b.height))
    def pad(img):
        if img.size == size:
            return img
        page = Image.new("L", size, 0)
        page.paste(img)
        return page
    return pad(a), pad(b)


def measurement(left, right):
    left, right = size_normalized(left, right)
    a, b = left.getbbox(), right.getbbox()
    if not a or not b:
        raise ValueError("A rendering has no visible math ink.")
    # A one-pixel dilation absorbs rasterizer edge coverage at the same DPI,
    # while differences in font shape or glyph placement leave unmatched ink.
    def missing(source, other):
        dilated = other.filter(ImageFilter.MaxFilter(3))
        lost = ImageChops.subtract(source, dilated)
        return lost.histogram()[255] / source.histogram()[255]
    return {
        "boundDeltaPx": max(abs(x-y) for x, y in zip(a, b)),
        "inkOutsideOnePixel": max(missing(left, right), missing(right, left)),
    }


def reference_measurement(canvas, origin, golden, em_px):
    glyphs = mask(REFERENCE / golden["image"])
    x, y = (round(o + i * em_px - GOLDEN_MARGIN_PX) for o, i in zip(origin, golden["ink"][:2]))
    pad_x, pad_y = max(0, -x), max(0, -y)
    size = (max(canvas.width, x + glyphs.width) + pad_x, max(canvas.height, y + glyphs.height) + pad_y)
    product, reference = Image.new("L", size), Image.new("L", size)
    product.paste(canvas, (pad_x, pad_y))
    reference.paste(glyphs, (x + pad_x, y + pad_y))
    return measurement(product, reference)


def plain(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def check_pdf(pdf, rows):
    document = PdfReader(pdf)
    assert len(document.pages) == len(rows), "The PDF missed a reference equation."
    selected = []
    for row, page in zip(rows, document.pages):
        content = page.get_contents().get_data()
        mark = re.search(rb"/ActualText\s+<([a-fA-F0-9]+)>", content)
        text = bytes.fromhex(mark[1].decode()).decode("utf-16") if mark else ""
        assert plain(text) == plain(row["plain"]), "The PDF changed the semantic expression."
        assert b" Tj" in content and b"Tf 0 Tr" in content, "The PDF page lacks visible positioned text."
        assert page.extract_text().strip(), "An independent PDF reader could not select any formula text."
        for font in page["/Resources"]["/Font"].values():
            type0 = font.get_object()
            if type0.get("/Subtype") != "/Type0" or "STIX" not in str(type0.get("/BaseFont")):
                continue
            embedded = type0["/DescendantFonts"][0].get_object()["/FontDescriptor"].get_object().get("/FontFile2")
            if embedded and len(embedded.get_object().get_data()) < 1_518_116 and type0.get("/ToUnicode"):
                selected.append(row["id"])
                break
    assert len(selected) == len(rows), "The PDF failed to embed selectable Unicode STIX text."


def verify(directory):
    receipt = json.loads((directory / "surfaces.json").read_text())
    rows = receipt["cases"]
    reference = json.loads((REFERENCE / "layout.json").read_text())
    assert receipt["dpi"] == reference["rasterDpi"], "Capture at the golden image DPI."
    em_px = reference["rasterDpi"] * reference["sourceEmPt"] / TEX_POINTS_PER_INCH
    goldens = {row["id"]: row for row in reference["cases"] if "image" in row}
    pdf = directory / "math.pdf"
    check_pdf(pdf, rows)
    misses, worst = [], {"boundDeltaPx": 0, "inkOutsideOnePixel": 0.0}
    reference_results = []
    with tempfile.TemporaryDirectory(prefix="waffle-math-pdf-raster-") as scratch:
        subprocess.run(["pdftoppm", "-png", "-r", str(receipt["dpi"]), str(pdf), str(Path(scratch) / "page")],
                       check=True, capture_output=True)
        pages = sorted(Path(scratch).glob("page-*.png"))
        assert len(pages) == len(rows)
        for row, page in zip(rows, pages):
            a = mask(directory / "canvas" / (row["id"] + ".png"))
            b = mask(directory / "svg" / (row["id"] + ".png"))
            c = mask(page)
            d = mask(directory / "standalone-svg" / (row["id"] + ".png"))
            if row["id"] in goldens:
                value = reference_measurement(a, row["origin"], goldens[row["id"]], em_px)
                reference_results.append({"id": row["id"], **value})
            results = {"canvas-svg": measurement(a, b), "canvas-pdf": measurement(a, c),
                       "svg-pdf": measurement(b, c), "canvas-standalone-svg": measurement(a, d)}
            for surface, value in results.items():
                for key in worst:
                    worst[key] = max(worst[key], value[key])
                if value["boundDeltaPx"] > 2 or value["inkOutsideOnePixel"] > .025:
                    misses.append({"id": row["id"], "pair": surface, **value})
    differences = [row for row in reference_results if row["inkOutsideOnePixel"]]
    return {"pages": len(rows), "selectable": len(rows), "worst": worst, "misses": misses,
            "reference": {"formulas": len(reference_results), "matchedWithinOnePixel": len(reference_results) - len(differences),
                          "maxBoundDeltaPx": max((row["boundDeltaPx"] for row in reference_results), default=0),
                          "differences": differences}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    report = verify(args.directory)
    print(json.dumps(report, indent=2))
    if report["misses"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
