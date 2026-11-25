"""Verify the offline reader's reviewed upstream artefacts and attribution."""
from hashlib import sha256
from pathlib import Path

root = Path(__file__).resolve().parents[2]
package = root / "app/vendor/pdfjs"
pinned = {
    "pdf.min.mjs": "3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440",
    "pdf.worker.min.mjs": "1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa",
    "LICENSE": "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
}
assert {p.name for p in package.iterdir()} == set(pinned)
for name, digest in pinned.items():
    assert sha256((package / name).read_bytes()).hexdigest() == digest, name
assert "Apache License" in (package / "LICENSE").read_text()
notice = (root / "THIRD_PARTY_NOTICES.md").read_text()
for phrase in ["6.5.438", "Apache", "app/vendor/pdfjs/LICENSE", "mozilla/pdf.js"]:
    assert phrase in notice, phrase
assert "pdfjs" in (root / "app/editor/about.js").read_text().lower()
print("The three upstream PDF.js files and shipped credit match the reviewed Apache release.")
