#!/usr/bin/env python3
"""Independently typeset the schematic maths references with XeTeX and Poppler."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageOps
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures/math"
FONT_SHA = "49b22767985171bce579307b21d98f4d35012fa39e316acc4ffcab8644dfb69b"
FONT_COMMIT = "744a22a4dd626cd14d75728aef34fc8ad7c85db0"
FONT_NAME = "STIXTwoMath-Regular.ttf"
DPI = 192
TEX_POINT = 72.27
MATH_SIZE = 24
# The document's left margin, the red baseline marker and the following kern.
FORMULA_LEFT_MM = 6 + 2 + 4
BOX = re.compile(r"^WAFFLE-REF\|([a-z0-9-]+)\|([\d.]+)pt\|([\d.]+)pt\|([\d.]+)pt$", re.MULTILINE)
TEX = r"""
\documentclass[12pt]{article}
\usepackage[paperwidth=200mm,paperheight=55mm,left=6mm,right=6mm,top=4mm,bottom=4mm]{geometry}
\usepackage{amsmath,unicode-math,xcolor}
\setmainfont[Path=./]{STIXTwoMath-Regular.ttf}
\setmathfont[Path=./]{STIXTwoMath-Regular.ttf}
\pagestyle{empty}
\newbox\waffleformula
\newcommand{\wafflesample}[3]{%
  \setbox\waffleformula=\hbox{$#2 #3$}%
  \typeout{WAFFLE-REF|#1|\the\wd\waffleformula|\the\ht\waffleformula|\the\dp\waffleformula}%
  \noindent{\color{red}\rule{2mm}{0.7pt}}\kern4mm\copy\waffleformula\par\clearpage
}
\begin{document}
\fontsize{24}{30}\selectfont
"""


def fixtures():
    with (FIXTURES / "electronics.tsv").open(newline="", encoding="utf-8") as stream:
        engineering = list(csv.DictReader(stream, delimiter="\t"))
    assert len(engineering) == len({r["id"] for r in engineering}) == 100
    expressions = json.loads((FIXTURES / "katex-expressions.json").read_bytes())["cases"]
    upstream = [{"id": "katex-" + row["id"], "mode": "display" if row["display"] else "inline",
                 "tex": row["tex"]} for row in expressions if "errorAt" not in row]
    return engineering, upstream


def run(command, cwd):
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(result.stdout[-6000:])
    return result.stdout


def document(rows):
    examples = []
    for row in rows:
        assert re.fullmatch(r"[a-z0-9-]+", row["id"])
        assert "%" not in row["tex"] and "\n" not in row["tex"]
        style = r"\displaystyle" if row["mode"] == "display" else r"\textstyle"
        examples.append(r"\wafflesample{" + row["id"] + "}{" + style + "}{" + row["tex"] + "}")
    return TEX + "\n".join(examples) + "\n" + r"\end{document}" + "\n"


def ink(path):
    with Image.open(path) as page:
        image = page.convert("RGB")
    r, g, _ = image.split()
    mark = ImageChops.subtract(r, g).point(lambda p: 255 if p > 30 else 0).getbbox()
    if mark is None:
        raise ValueError("The reference raster has no baseline marker.")
    baseline = mark[3]
    anchor = FORMULA_LEFT_MM / 25.4 * DPI
    left = int(anchor) - 16
    assert left > mark[2] and image.width > left
    body = ImageOps.grayscale(image.crop((left, 0, image.width, image.height)))
    box = ImageOps.invert(body).point(lambda p: 255 if p > 12 else 0).getbbox()
    if box is None or box[0] < 3 or box[1] < 3 or box[2] > body.width - 3 or box[3] > body.height - 3:
        raise ValueError("Reference ink is missing or clipped.")
    l, t, r, b = box
    scale = TEX_POINT / (DPI * MATH_SIZE)
    extent = [(left + l - anchor) * scale, (t - baseline) * scale,
              (left + r - anchor) * scale, (b - baseline) * scale]
    return body.crop((l - 3, t - 3, r + 3, b + 3)), [round(x, 4) for x in extent]


def font_proof(file, pages):
    pdf = PdfReader(file)
    assert len(pdf.pages) == pages, "Tectonic split or omitted a sample page."
    available = set()
    for page in pdf.pages:
        fonts = page["/Resources"]["/Font"]
        for reference in fonts.values():
            font = reference.get_object()
            available.add(str(font.get("/BaseFont", "")))
            if "STIXTwoMath" in str(font.get("/BaseFont", "")):
                descendant = font["/DescendantFonts"][0].get_object()
                descriptor = descendant["/FontDescriptor"].get_object()
                assert descriptor.get("/FontFile2"), "STIX Two Math must be embedded as TrueType."
    assert available and all("STIXTwoMath" in name for name in available), available


def render(font, output):
    if hashlib.sha256(font.read_bytes()).hexdigest() != FONT_SHA:
        raise ValueError("Use the unmodified STIX Two Math v2.13b171 TrueType release.")
    engineering, upstream = fixtures()
    examples = engineering + upstream
    images = output / "ink"
    images.mkdir(parents=True, exist_ok=True)
    output = output.resolve()
    images = images.resolve()
    with tempfile.TemporaryDirectory(prefix="waffle-reference-maths-") as scratch:
        scratch = Path(scratch)
        shutil.copyfile(font, scratch / FONT_NAME)
        (scratch / "math.tex").write_text(document(examples), encoding="utf-8")
        run(["tectonic", "--keep-logs", "--outdir", ".", "math.tex"], scratch)
        font_proof(scratch / "math.pdf", len(examples))
        log = (scratch / "math.log").read_text(encoding="utf-8")
        matches = {i: [float(v) / MATH_SIZE for v in values] for i, *values in BOX.findall(log)}
        assert set(matches) == {r["id"] for r in examples}, "Tectonic omitted a formula's box."
        assert "Missing character:" not in log, "A reference glyph was missing."
        run(["pdftoppm", "-r", str(DPI), "-png", "math.pdf", "page"], scratch)
        rendered = sorted(scratch.glob("page-*.png"))
        assert len(rendered) == len(examples)
        records = []
        for case, png in zip(examples, rendered):
            picture, extent = ink(png)
            id = case["id"]
            advance, ascent, descent = (round(dim, 5) for dim in matches[id])
            record = {"id": id, "mode": case["mode"], "advance": advance, "ascent": ascent,
                      "descent": descent, "ink": extent}
            if "group" in case:
                target = images / (id + ".png")
                picture.save(target, optimize=True)
                record["image"] = "ink/" + target.name
                record["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
            records.append(record)
        receipt = {"reference": "XeTeX via Tectonic", "tectonic": run(["tectonic", "--version"], scratch).strip(),
                   "poppler": run(["pdftoppm", "-v"], scratch).splitlines()[0],
                   "font": FONT_NAME, "fontCommit": FONT_COMMIT, "fontSHA256": FONT_SHA,
                   "rasterDpi": DPI, "sourceEmPt": MATH_SIZE, "cases": records}
        (output / "layout.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(f"Measured {len(examples)} XeTeX boxes and wrote {len(engineering)} golden ink images.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True, help="Pinned STIX Two Math TTF")
    parser.add_argument("--output", type=Path, required=True, help="Directory for reference receipts and images")
    args = parser.parse_args()
    render(args.font, args.output)


if __name__ == "__main__":
    main()
