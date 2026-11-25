#!/usr/bin/env python3
"""Build integrations/vscode/dist/waffle-eda-<version>.vsix without Node or vsce.

    python3 integrations/vscode/scripts/package-vsix.py
    code --install-extension integrations/vscode/dist/waffle-eda-0.1.0.vsix

A .vsix is a ZIP holding [Content_Types].xml, extension.vsixmanifest and the extension
under extension/. This script checks the schema is current, bundles the viewer
(bundle-viewer.py), then writes the package with fixed timestamps so the bytes are
reproducible. `vsce package` from the same folder gives an equivalent package.
"""
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
EXT = HERE.parent
INCLUDE = ["package.json", "extension.js", "README.md", "LICENSE.txt", "lib/*.js", "bin/*.js", "media/*.js", "media/*.css", "media/app/**/*.js",
           "media/app/**/*.cjs", "media/app/**/*.json",
           "schema/waffle-folder-record.schema.json", "syntaxes/*.json"]


def run(script, *args):
    subprocess.run([sys.executable, str(HERE / script), *args], check=True)


def manifest(pkg):
    q = lambda s: escape(str(s), {'"': "&quot;"})
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{q(pkg['name'])}" Version="{q(pkg['version'])}" Publisher="{q(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{q(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{q(','.join(pkg.get('extensionKind', ['workspace'])))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"""


CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json" />
<Default Extension=".js" ContentType="application/javascript" />
<Default Extension=".cjs" ContentType="application/javascript" />
<Default Extension=".css" ContentType="text/css" />
<Default Extension=".md" ContentType="text/markdown" />
<Default Extension=".txt" ContentType="text/plain" />
<Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"""


def main():
    run("gen-schema.py", "--check")
    run("bundle-viewer.py")
    pkg = json.loads((EXT / "package.json").read_text(encoding="utf-8"))
    files = sorted({p for pattern in INCLUDE for p in EXT.glob(pattern) if p.is_file()})
    rel = [p.relative_to(EXT).as_posix() for p in files]
    for need in ("package.json", "extension.js", "README.md", "LICENSE.txt", "media/app/canvas/canvas.js", "schema/waffle-folder-record.schema.json"):
        if need not in rel:
            sys.exit("package-vsix: missing " + need)
    out = EXT / "dist" / f"{pkg['name']}-{pkg['version']}.vsix"
    out.parent.mkdir(exist_ok=True)

    def add(z, name, data):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, data)

    with zipfile.ZipFile(out, "w") as z:
        add(z, "[Content_Types].xml", CONTENT_TYPES)
        add(z, "extension.vsixmanifest", manifest(pkg))
        for p, r in zip(files, rel):
            add(z, "extension/" + r, p.read_bytes())
    print(f"package-vsix: wrote {out.relative_to(EXT.parents[1])} ({out.stat().st_size / 1024:.0f} KB, {len(files)} files)")


if __name__ == "__main__":
    main()
