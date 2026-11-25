#!/usr/bin/env python3
"""Build the native Open in Altium file picker for a configured altium-wine kit."""
import argparse
import os
from pathlib import Path, PureWindowsPath
import plistlib
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
APP_NAME = "Open in Altium"
BUNDLE_ID = "local.atrium.open-in-altium"
EXTENSIONS = ["prjpcb", "pcbdoc", "schdoc", "pcblib", "schlib", "libpkg", "prjscr", "outjob"]
LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, default=Path.home() / "Applications/Altium Designer.app")
    parser.add_argument("--destination", type=Path, default=Path.home() / "Applications")
    args = parser.parse_args()
    kit, launcher, dest = [p.expanduser().resolve() for p in (args.kit, args.launcher, args.destination)]
    prefix = kit / "volume/prefix"
    drive = prefix / "drive_c"
    wine = kit / "wine-patched/Wine Staging.app/Contents/Resources/wine/bin/wine"
    editors = list((drive / "Program Files/Altium").glob("*/X2.EXE"))
    if len(editors) != 1 or not wine.is_file() or not launcher.is_dir():
        parser.error("This helper needs a configured kit, one installed X2.EXE and its Mac launcher.")
    dest.mkdir(parents=True, exist_ok=True)
    installed = dest / (APP_NAME + ".app")
    if installed.exists():
        with (installed / "Contents/Info.plist").open("rb") as old:
            if plistlib.load(old).get("CFBundleIdentifier") != BUNDLE_ID:
                parser.error("Another application has this name at the destination.")

    with tempfile.TemporaryDirectory(prefix=".altium-finder-", dir=dest) as temp:
        work = Path(temp)
        app = work / installed.name
        resources = app / "Contents/Resources"
        executables = app / "Contents/MacOS"
        resources.mkdir(parents=True)
        executables.mkdir()
        for name in ("OpenFiles.pas", "open_files.py"):
            shutil.copyfile(HERE / name, resources / name)
        info = {
            "CFBundleIdentifier": BUNDLE_ID, "CFBundleName": APP_NAME, "CFBundleDisplayName": APP_NAME,
            "CFBundleExecutable": "OpenInAltium", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1", "NSHighResolutionCapable": True,
            "LSUIElement": True, "NSPrincipalClass": "NSApplication",
            "AltiumWineRoot": str(kit), "AltiumMacLauncher": str(launcher),
            "AltiumWindowsExecutable": str(PureWindowsPath("C:/", editors[0].relative_to(drive))),
            "CFBundleDocumentTypes": [{
                "CFBundleTypeName": "Altium design files", "CFBundleTypeRole": "Editor",
                "LSHandlerRank": "Default", "CFBundleTypeExtensions": EXTENSIONS,
                "LSItemContentTypes": ["local.atrium.altium." + ext for ext in EXTENSIONS]
                                      + ["org.atrium.import.prjpcb"],
            }],
            "UTImportedTypeDeclarations": [{
                "UTTypeIdentifier": "local.atrium.altium." + ext, "UTTypeConformsTo": ["public.data"],
                "UTTypeTagSpecification": {"public.filename-extension": ext},
            } for ext in EXTENSIONS],
            "NSServices": [{
                "NSMenuItem": {"default": "Open Mac File in Altium"}, "NSMessage": "chooseForAltium",
                "NSPortName": APP_NAME,
                "NSRequiredContext": {"NSApplicationIdentifier": ["local.altium-wine.runtime.ad26", "com.apple.finder"]},
            }],
        }
        icon = launcher / "Contents/Resources/AppIcon.icns"
        if icon.is_file():
            shutil.copyfile(icon, resources / icon.name)
            info["CFBundleIconFile"] = icon.name
            info["CFBundleDocumentTypes"][0]["CFBundleTypeIconFile"] = icon.name
            for declaration in info["UTImportedTypeDeclarations"]:
                declaration["UTTypeIconFile"] = icon.name
        with (app / "Contents/Info.plist").open("wb") as out:
            plistlib.dump(info, out)
        subprocess.run(["/usr/bin/xcrun", "swiftc", "-O", "-module-cache-path", work / "swift-cache",
                        HERE / "OpenInAltium.swift", "-o", executables / "OpenInAltium"], check=True)
        with tempfile.TemporaryDirectory(prefix="AtriumPickerBuild-", dir=drive) as stage:
            src = HERE.parent.parent / "tests/altium-wine/RunDesigner.cs"
            shutil.copyfile(src, Path(stage) / src.name)
            subprocess.run([wine, r"C:\windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
                            "/nologo", "/platform:x64", "/out:RunDesigner.exe", src.name],
                           cwd=stage, env=dict(os.environ, WINEPREFIX=str(prefix), WINEDEBUG="-all"),
                           stdin=subprocess.DEVNULL, check=True, timeout=30)
            shutil.copyfile(Path(stage) / "RunDesigner.exe", resources / "RunDesigner.exe")
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(app)], check=True)
        previous = work / "previous.app"
        if installed.exists():
            installed.rename(previous)
        try:
            app.rename(installed)
            subprocess.run([LSREGISTER, "-f", str(installed)], check=True)
        except BaseException:
            if installed.exists():
                installed.rename(app)
            if previous.exists():
                previous.rename(installed)
            raise
    print(installed)


if __name__ == "__main__":
    main()
