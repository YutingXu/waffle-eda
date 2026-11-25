#!/usr/bin/env python3
"""Check the emitted document with pypdf, PDFium, resvg, Pillow and fontTools.
Install these in a test environment: pypdf pypdfium2 resvg-py pillow fonttools.
Set PDFTOTEXT to a Poppler pdftotext executable for an additional exact-text check.
"""
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from unicodedata import normalize

from fontTools.ttLib import TTFont
from PIL import Image, ImageChops
from pypdf import PdfReader
import pypdfium2
import resvg_py

ROOT = Path(__file__).resolve().parents[2]


def visible(image):
    return image.convert("L").point(lambda x: 255 if x < 180 else 0)


def inspect(folder):
    path = folder / "math.pdf"
    pdf = PdfReader(path)
    font = pdf.pages[0]["/Resources"]["/Font"]["/M"].get_object()
    cid = font["/DescendantFonts"][0].get_object()
    assert font["/Subtype"] == "/Type0" and cid["/Subtype"] == "/CIDFontType2"
    assert str(font["/BaseFont"]).split("+", 1)[1] == "STIXTwoMath-Regular"
    program = cid["/FontDescriptor"]["/FontFile2"].get_data()
    source = TTFont(folder / "original.ttf")
    subset = TTFont(BytesIO(program), checkChecksums=2)
    expected = {0, *(c["gid"] for c in json.loads((folder / "used.json").read_text()))}
    mapping = cid["/CIDToGIDMap"].get_data()
    mapped = [int.from_bytes(mapping[i:i+2], "big") for i in range(0, len(mapping), 2)]
    assert set(mapped) == expected and len(mapped) > len(expected), "one GID has two semantic CIDs"
    kept = {subset.getGlyphName(i) for i in expected}
    work = list(kept)
    while work:
        glyph = source["glyf"][work.pop()]
        if glyph.isComposite():
            for component in glyph.components:
                if component.glyphName not in kept:
                    kept.add(component.glyphName)
                    work.append(component.glyphName)
    actual = {g for g in subset.getGlyphOrder() if subset["glyf"][g].numberOfContours}
    assert actual == kept and len(actual) < 30, "embedded outlines must be exactly the glyph closure"
    for name in actual:
        assert subset["glyf"][name].numberOfContours == source["glyf"][name].numberOfContours
    assert all(t in subset for t in ("fpgm", "cvt ", "prep"))
    assert len(program) < (folder / "original.ttf").stat().st_size // 4

    poppler = os.environ.get("PDFTOTEXT") or shutil.which("pdftotext")
    for name, text_name in [("math", "plain.txt"), ("tall", "tall-plain.txt"), ("line", "line-plain.txt")]:
        doc_path = folder / (name + ".pdf")
        wanted = (folder / text_name).read_text()
        with pypdfium2.PdfDocument(doc_path) as doc:
            got = doc[0].get_textpage().get_text_bounded()
        assert normalize("NFKC", got) == normalize("NFKC", wanted), (name, got, wanted)
        if poppler:
            extracted = subprocess.check_output([poppler, "-enc", "UTF-8", str(doc_path), "-"]).decode("utf-8")
            assert extracted.rstrip("\n\f") == wanted

    with pypdfium2.PdfDocument(path) as doc:
        bitmap = doc[0].render(scale=4)
        ink = visible(bitmap.to_pil())
    svg_ink = visible(Image.open(BytesIO(resvg_py.svg_to_bytes(svg_path=str(folder / "math.svg"), zoom=4))))
    assert ink.size == svg_ink.size
    delta = max(abs(a-b) for a,b in zip(ink.getbbox(), svg_ink.getbbox()))
    union = ImageChops.lighter(ink,svg_ink).histogram()[255]
    common = ImageChops.darker(ink,svg_ink).histogram()[255]
    assert delta <= 2 and common / union > .78, (delta, common / union)
    print(f"PASS PDFium selection, TrueType CID map and {len(kept)}-glyph closure, "
          f"resvg raster bounds within {delta} px, mask overlap {common / union:.3f}")


if __name__ == "__main__":
    with TemporaryDirectory() as temp:
        subprocess.run(["node", str(ROOT / "tests/notebook/math-pdf.cjs"), temp], check=True)
        inspect(Path(temp))
