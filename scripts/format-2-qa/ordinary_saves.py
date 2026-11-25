#!/usr/bin/env python3
"""Measure actual native Command-S and independently verify installed rows without Git."""

import argparse
import csv
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess

from desktop import measure, quantile
from gitmetrics import move_bytes, physical_digests, physical_members
from nativebuild import build


DESIGNS = {
    "pidp11-io-expander": "PiDP-11 I/O Expander",
    "snes-tap": "SNES-Tap",
    "midas-communication": "MIDAS Communication",
    "cm4-5-shim": "CM4–5 Shim",
    "esp32c3-haptic": "ESP32-C3 Haptic",
    "garganturam": "GargantuRAM",
    "corne": "Corne",
    "lily58": "Lily58",
    "synthetic": "Synthetic 25.6k board",
    "approved": "private-project-03 (approved aggregate)",
}
LIMIT_MS = 50


class SaveReadback:
    def __init__(self, folder, base):
        self.folder = folder
        self.base = base
        self.original = physical_digests(folder)
        if self.original != physical_digests(base):
            raise ValueError("The disposable Save checkout differs from the prepared fixture")
        self.members = physical_members(folder)
        self.path = None
        self.previous = None
        self.transactions = set()

    def checkpoint(self, number, observed):
        if number != len(self.transactions) + 1:
            raise ValueError("Physical Save checkpoints arrived out of order")
        if (self.folder / ".waffle/journal/active").exists() or (self.folder / ".git").exists():
            raise ValueError("The transaction remained active or produced Git state")
        tx, path = observed["transaction"], Path(observed["path"])
        if not isinstance(tx, str) or not tx or tx in self.transactions:
            raise ValueError("A Save lacked a distinct durable transaction receipt")
        if path.suffix != ".wpcb" or path not in self.original:
            raise ValueError("The acknowledged path is not an original PCB owner")
        members = physical_members(self.folder)
        changed = {relative for relative in self.members.keys() | members.keys()
                   if self.members.get(relative) != members.get(relative)}
        if changed != {path}:
            raise ValueError("The physical Save changed files outside the acknowledged owner")
        if self.path is None:
            self.path = path
        if path != self.path:
            raise ValueError("The repeated edit changed its target owner")
        installed = (self.folder / path).read_bytes()
        if self.previous is None:
            # The first checkpoint's before-image comes from the untouched fixture in the caller.
            self.previous = (self.base / path).read_bytes()
        move_bytes(self.previous, installed, expected=observed)
        self.previous, self.members = installed, members
        self.transactions.add(tx)

    def finish(self, expected):
        if len(self.transactions) != expected:
            raise ValueError("An acknowledged Save lacked an independent physical readback")
        current = physical_digests(self.folder)
        changed = {path for path in self.original.keys() | current.keys()
                   if self.original.get(path) != current.get(path)}
        if changed != {self.path}:
            raise ValueError("The whole checkout changed outside the active owner")
        if physical_digests(self.base) != self.original:
            raise ValueError("The read-only prepared fixture changed during measurement")
        return {"verified": expected, "distinctDurableReceipts": expected,
                "installedRowReplacements": expected, "otherAuthoredFilesChanged": 0,
                "descriptorClearedAtEachReadback": True, "preparedFixtureUnchanged": True,
                "gitRepositoryCreated": False}


def distribution(values):
    if not values or any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("Missing or invalid Save timings")
    return {"count": len(values), "median": statistics.median(values), "p95": quantile(values, .95),
            "max": max(values), "misses": sum(value >= LIMIT_MS for value in values)}


def resource_digest(folder):
    entries = [(str(path.relative_to(folder)), sha256(path.read_bytes()).hexdigest())
               for path in sorted(folder.rglob("*")) if path.is_file()]
    return sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def trial(exe, prepared, scratch, saves, private, overlay):
    config = json.loads((prepared / "options.json").read_text(encoding="utf-8"))
    settings = {key: config[key] for key in ("manifest", "items", "visiblePaths", "models", "assetBytes")}
    settings.update(mode="edits", edit="part", saves=saves, nativeSaveKey=True, verifySaves=True,
                    git=False, stockWriter=True, finalOverlay=overlay)
    base = prepared / "design"
    result = measure(exe, base, settings, scratch, private,
                     observe_save=lambda folder: SaveReadback(folder, base))
    if (result["fullValidationError"] or len(result["saves"]) != saves
            or result["physicalSaveChecks"]["verified"] != saves
            or any(not row["nativeKeyHandled"] or row["rowsEncoded"] != 1 or row["paths"] != 1 for row in result["saves"])):
        raise ValueError("The native editor, saved snapshot or per-edit verification failed")
    if overlay and not all(result["finalOverlay"][key] for key in ("active", "current", "visible", "exact")):
        raise ValueError("The visible PCB connectivity overlay differs from independent calculation")
    return result


def persist(out, ledger):
    pending = out / ".save-observations.tmp"
    pending.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    os.replace(pending, out / "save-observations.json")
    with (out / "save-summary.tsv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(("design", "cohort", "saves", "median_ms", "p95_ms", "max_ms", "at_least_50_ms",
                         "installation_median_ms", "physical_rows_verified", "overlay_verified"))
        for case, row in ledger["designs"].items():
            if "error" in row:
                writer.writerow((DESIGNS[case], "failed", 0, "", "", "", "", "", "", ""))
                continue
            for cohort in ("first", "subsequent"):
                stats = row[cohort]
                writer.writerow((DESIGNS[case], cohort, stats["count"], stats["median"], stats["p95"], stats["max"],
                                 stats["misses"], stats["installationMedianMs"], row["physicalRowsVerified"], row["overlayVerified"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", type=Path, required=True)
    parser.add_argument("--pin", required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", action="append", choices=DESIGNS)
    parser.add_argument("--moves", type=int, default=100,
                        help="Number of subsequent saves in the same native process after its first Save")
    parser.add_argument("--first-runs", type=int, default=5,
                        help="Number of additional fresh native processes per design")
    args = parser.parse_args()
    if args.moves < 1 or args.first_runs < 1:
        parser.error("At least one subsequent Save and one separate first Save are required")
    args.scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.out.mkdir(parents=True, exist_ok=True)
    ledger = {"source": args.pin, "architecture": platform.machine(), "macOS": platform.mac_ver()[0], "limitMs": LIMIT_MS,
              "measurement": "AppKit Command-S delivered to the editor view through a trusted key event until the native receipt and clean editor state",
              "stockWriter": True, "cache": "deliberately warm fixture bytes, fresh AppKit and WebContent processes",
              "designs": {}}
    app_digest = resource_digest(args.product / "app")
    bridge_digest = sha256((args.product / "native/bridge.js").read_bytes()).hexdigest()
    with build(args.product, observe_transactions=False) as exe:
        resources = exe.parents[1] / "Resources"
        if not (resources / "format2-stock-writer").is_file():
            raise ValueError("The observer must compile the production writer without transaction counters")
        subprocess.run(["codesign", "--verify", "--strict", exe.parents[2]], check=True)
        if (resource_digest(resources / "app") != app_digest
                or sha256((resources / "bridge.js").read_bytes()).hexdigest() != bridge_digest):
            raise ValueError("The observer app resources do not match the requested product source")
        ledger["observerExecutableSha256"] = sha256(exe.read_bytes()).hexdigest()
        ledger["appResourcesSha256"] = app_digest
        ledger["nativeBridgeSha256"] = bridge_digest
        ledger["stockWriterSourceSha256"] = sha256((args.product / "native/macos/FolderTransactions.swift").read_bytes()).hexdigest()
        for case in args.case or DESIGNS:
            private = case == "approved"
            prepared = args.prepared / case
            try:
                sustained = trial(exe, prepared, args.scratch, args.moves + 1, private, overlay=True)
                first = [sustained["saves"][0]]
                for _ in range(args.first_runs):
                    first.append(trial(exe, prepared, args.scratch, 1, private, overlay=False)["saves"][0])
                subsequent = sustained["saves"][1:]
                row = {"physicalRowsVerified": args.moves + args.first_runs + 1, "overlayVerified": True,
                       "readback": sustained["physicalSaveChecks"], "clockBoundMs": sustained["clockBoundMs"],
                       "geometry": {"documents": sustained["documents"], "items": sustained["items"],
                                    "verifiedModels": sustained["verifiedModelMembers"]}}
                for name, samples in (("first", first), ("subsequent", subsequent)):
                    row[name] = distribution([s["savedMs"] for s in samples])
                    row[name]["installationMedianMs"] = statistics.median(s["observedSettleMs"] for s in samples)
                if not private:
                    row.update(firstObservations=first, subsequentObservations=subsequent,
                               finalOverlay=sustained["finalOverlay"])
                ledger["designs"][case] = row
                print(DESIGNS[case], "first", row["first"], "subsequent", row["subsequent"], flush=True)
            except (OSError, ValueError, RuntimeError, TimeoutError) as error:
                message = "Private aggregate verification failed" if private else str(error)
                ledger["designs"][case] = {"error": message}
                print(DESIGNS[case], message, flush=True)
            persist(args.out, ledger)
    return int(any("error" in row or row["first"]["misses"] or row["subsequent"]["misses"]
                   for row in ledger["designs"].values()))


if __name__ == "__main__":
    raise SystemExit(main())
