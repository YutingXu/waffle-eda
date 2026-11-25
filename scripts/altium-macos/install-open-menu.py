#!/usr/bin/env python3
"""Connect Altium's installed File > Open and Quick Access Open to its Mac sheet."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import tempfile

ROOT = "AtriumMacIntegration"
IDS = ("PLWorkspaceManager:OpenAnything", "PLWorkspaceManager:QuickAccess_Open")
SCRIPT = "ShowMacOpenPanel.pas"


def replace(path, new):
    with tempfile.NamedTemporaryFile(prefix=path.name + ".", dir=path.parent, delete=False) as out:
        temp = Path(out.name)
        try:
            out.write(new)
            out.flush()
            if path.exists():
                os.chmod(temp, path.stat().st_mode & 0o777)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def configure(kit, app, restore=False):
    drive = kit / "volume/prefix/drive_c"
    resources = list((drive / "Program Files/Altium").glob("*/System/WorkspaceManager.rcs"))
    if len(resources) != 1:
        raise ValueError("Expected exactly one installed Altium WorkspaceManager.rcs.")
    resource = resources[0]
    directory = drive / ROOT
    backup = directory / "open-commands.json"
    script = directory / SCRIPT
    source = resource.read_bytes()
    original = json.loads(backup.read_bytes()) if backup.exists() else {}
    if restore and not original:
        return
    if not restore:
        with (app / "Contents/Info.plist").open("rb") as f:
            info = plistlib.load(f)
        event = info.get("AltiumOpenNotification", "")
        if (not re.fullmatch(r"local\.atrium\.altium\.open\.[a-f0-9]{16}", event)
                or not Path(info["AltiumFileOpener"]).is_dir()):
            raise ValueError("Install the Mac Dock app and file opener first.")
        directory.mkdir(exist_ok=True)
    params = rf"FileName=C:\{ROOT}\{SCRIPT}|ProcName=ShowMacOpenPanel"
    updated = source
    saved = {}
    for name in IDS:
        match = re.search(rb"^PL[ \t]+" + re.escape(name.encode()) + rb"[ \t]+[^\r\n]+", source, re.M)
        if not match:
            raise ValueError("Missing Altium Open command " + name)
        record = match.group().decode("latin-1")
        stock = original.get(name, record)
        if stock.count("Command='WorkspaceManager:OpenObject'") != 1:
            raise ValueError("Unrecognized Altium Open command " + name)
        action = f"Command='ScriptingSystem:RunScriptFile' Params='{params}'"
        changed = stock.replace("Command='WorkspaceManager:OpenObject'", action)
        changed = changed.replace("Params='Source=QuickAccess'", "")
        if record not in (stock, changed):
            raise ValueError("Altium’s Open command changed since installation. Review the local backup.")
        saved[name] = stock
        updated = updated.replace(match.group(), (stock if restore else changed).encode("latin-1"), 1)
    if not restore:
        pas = (
            "procedure ShowMacOpenPanel;\r\nbegin\r\n"
            rf"    RunApplication('C:\windows\system32\start.exe /unix /usr/bin/notifyutil -p {event}');"
            "\r\nend;\r\n"
        ).encode("ascii")
        if not backup.exists():
            replace(backup, json.dumps(saved, indent=2).encode())
        replace(script, pas)
    if updated != source:
        replace(resource, updated)
    if restore:
        backup.unlink()
        script.unlink(missing_ok=True)
    print(("Restored" if restore else "Configured") + " the File and Quick Access Open commands.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, required=True)
    parser.add_argument("--app", type=Path, default=Path.home() / "Applications/Altium Designer.app")
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    configure(args.kit.expanduser().resolve(), args.app.expanduser().resolve(), args.restore)
