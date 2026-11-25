#!/usr/bin/env python3
"""Run the shipping macOS folder editor in a fresh native process for every observation.

Supply an immutable combined production checkout and an isolated scratch directory. --suite scaling
balances order over 20 complete fresh-process blocks. The caller serializes CPU benchmarks with timed-slot.py.
"""
import argparse
import hashlib
from contextlib import nullcontext
import json
import math
import os
from pathlib import Path
import platform
import selectors
import shutil
import statistics
import struct
import zlib
import subprocess
import tempfile
import time

from accept import LIMITS
from gitmetrics import BatchedHistory, Repo, physical_digests
from nativebuild import build

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def ensure_bytes_cached(folder):
    # Both members of each pair use an identical warm filesystem-cache policy and a fresh
    # WebContent process. Include all cold bodies outside the timer on every trial.
    for path in sorted(folder.rglob("*")):
        if path.is_file():
            with path.open("rb") as member:
                while member.read(1 << 20):
                    pass


def selected_png():
    def chunk(name, data):
        return struct.pack(">I",len(data))+name+data+struct.pack(">I",zlib.crc32(name+data))
    return (b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">2I5B",2,1,8,6,0,0,0))+
            chunk(b"IDAT",zlib.compress(bytes([0,255,0,0,255,0,0,255,255])))+chunk(b"IEND",b""))


def measure(exe, base, options, parent, private=False, *, observe_save=None):
    with tempfile.TemporaryDirectory(prefix="trial-", dir=parent) as name:
        work = Path(name)
        folder = work / "design"
        if options["mode"] == "attachment":
            (work/"qa-selected.png").write_bytes(selected_png())
        source_members = physical_digests(base) if options.get("gitBatchSize") else None
        shutil.copytree(base, folder)
        if source_members is not None and physical_digests(folder) != source_members:
            raise ValueError("The disposable working copy differs from the prepared design")
        physical = observe_save(folder) if observe_save else None
        if physical and options.get("git"):
            raise ValueError("Use either the ordinary Save observer or the Git history observer")
        repo = None
        history = None
        batched = None
        if options.get("git"):
            repo = Repo(folder)
            repo.initialize(ignore_collaboration_lock=bool(options.get("gitBatchSize")))
            if options.get("gitBatchSize") or options.get("saves") == 100:
                history = repo.start_history(work / "packed-baseline")
            if options.get("gitBatchSize"):
                batched = BatchedHistory(repo, history, options["saves"], options["gitBatchSize"])
        ensure_bytes_cached(folder)
        (work / "trial.json").write_text(json.dumps(options))
        child_env = {**os.environ, "WAFFLE_FORMAT_PRIVATE": str(int(private)), "WAFFLE_FORMAT_TRIAL": str(work)}
        # Do not give AppKit a positional scratch directory. Finder delivers exactly the selected manifest.
        supports_env = (Path(exe).parents[1]/"Resources/format2-qa-env-root").is_file()
        executable = [str(exe)] if supports_env else [str(exe),str(work)]
        with (work / "stderr").open("w+b") as err:
            proc = subprocess.Popen(executable, stdout=subprocess.PIPE, stdin=subprocess.PIPE,
                                    stderr=err, env=child_env)
            reads = selectors.DefaultSelector()
            reads.register(proc.stdout, selectors.EVENT_READ)
            raw = b""
            final = None
            diffs = []
            deadline = time.monotonic() + (400 if history else 150)
            try:
                while True:
                    available = deadline - time.monotonic()
                    if available <= 0 or not reads.select(available):
                        raise TimeoutError("Native observation timed out")
                    incoming = os.read(proc.stdout.fileno(), 131072)
                    if not incoming:
                        break
                    raw += incoming
                    while b"\n" in raw:
                        line, raw = raw.split(b"\n", 1)
                        if not line:
                            continue
                        row = json.loads(line)
                        if "checkpoint" not in row:
                            final = row
                            continue
                        n = row["checkpoint"]
                        if physical:
                            physical.checkpoint(n, row["observation"])
                        else:
                            if not repo or n != len(diffs) + 1:
                                raise ValueError("Git checkpoint arrived out of order")
                            if (folder/".waffle/journal/active").exists():
                                raise ValueError("The Git observer reached a generation whose descriptor was still active")
                            if batched:
                                diffs.append(batched.observe(n, row["observation"]))
                            else:
                                counted, paths = repo.diff()
                                diffs.append(counted)
                                if len(paths) == 1:
                                    suffix = Path(paths[0]).suffix
                                    counted["activeKind"] = suffix if suffix in (".wpcb", ".wsch") else "other"
                                repo.commit(n)
                        proc.stdin.write(b"continue\n")
                        proc.stdin.flush()
                if proc.wait(timeout=8) or final is None or raw:
                    err.seek(0)
                    message = "The private native observation failed." if private else err.read().decode(errors="replace")[-2500:]
                    raise RuntimeError(message)
            finally:
                reads.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
            if options["mode"] == "attachment":
                expected=selected_png()
                digest=hashlib.sha256(expected).hexdigest()
                asset=folder/"assets"/digest
                refs=[]
                for owner in folder.rglob("*.wsch"):
                    rows=[json.loads(row) for row in owner.read_bytes().splitlines()]
                    refs.extend((owner,record["id"]) for record in rows[1:] if record.get("asset",{}).get("sha256")==digest)
                members=[json.loads(row) for row in (folder/options["manifest"]).read_bytes().splitlines()]
                child=next((row for row in members if row.get("kind")=="document" and row.get("name")=="New QA sheet"),None)
                final["physical"]={"savedPlacementCount":len(refs),"assetPresent":asset.is_file(),
                    "assetEqualsSource":asset.is_file() and asset.read_bytes()==expected,
                    "newChildInManifest":bool(child),"newChildOnDisk":bool(child and (folder/child["path"]).is_file())}
            if repo and len(diffs) != options["saves"]:
                raise ValueError("Some edits did not reach the whole-checkout Git observer")
            if repo:
                final["diffs"] = diffs
            if batched:
                if source_members != physical_digests(base):
                    raise ValueError("The prepared design changed during the history trial")
                final["preparedSourceUnchanged"] = True
                final["history"] = batched.finish()
                final["physicallySettledEdits"] = len(diffs)
            elif history:
                final["history"] = repo.finish_history(history)
                final["physicallySettledCommits"]=len(diffs)
            if physical:
                final["physicalSaveChecks"] = physical.finish(options["saves"])
            return final


def load_options(prepared):
    return json.loads((prepared / "options.json").read_text())


def quantile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values)*fraction)-1)]


def paired(results, reference, test, median_cap, rss_cap):
    def delta(key):
        return [group[test][key] - group[reference][key] for group in results]
    paint = delta("firstPaintMs")
    rss = delta("firstRSS")
    p50 = statistics.median(paint)
    p95 = quantile(paint, .95)
    max_rss = max(group[test]["firstRSS"] for group in results) - max(group[reference]["firstRSS"] for group in results)
    # Also report worst directly paired growth, exposing allocator noise between fresh processes.
    return {"pairs":len(results), "medianPaintDeltaMs":p50, "p95PaintDeltaMs":p95,
            "maxPeakDeltaBytes":max_rss, "maxPairedRSSDelta":max(rss),
            "caps":{"medianMs":median_cap, "p95Ms":16.7, "peakBytes":rss_cap},
            "pass":p50 <= median_cap and p95 <= 16.7 and max_rss <= rss_cap and
                   all(group[test]["visibleIO"]["outsideOpens"] == 0 and group[test]["visibleIO"]["outsideBytes"] == 0
                       for group in results)}


def scaling(exe, args, save):
    names = ["one", "hundred", "thousand", "hundred-large"]
    rows = []
    for n in range(args.repeats):
        # Every condition appears once per block. Reverse alternate Latin cycles to balance drift.
        order = names[n % 4:] + names[:n % 4]
        if (n // 4) % 2:
            order = order[::-1]
        record = {}
        for name in order:
            out = measure(exe, args.prepared/name, {"mode":"scale","manifest":"Sensor Board.waffle",
                          "visiblePaths":["Sensor Board.waffle", "Power.wsch"]}, args.scratch)
            record[name] = out
        rows.append(record)
        save({"blocks":rows})
        print("scaling", n+1, "complete", flush=True)
    return {"blocks":rows, "contrasts":{target:paired(rows, control, target, ms, mib*1024**2)
            for control,target,ms,mib in [("one","hundred",8,8),("one","thousand",8,8),("hundred","hundred-large",5,4)]}}


def cases(exe, args, save):
    output={}
    batched = args.suite == "batched-history"
    available = list(LIMITS) if batched else sorted(p.name for p in args.prepared.iterdir() if (p/"options.json").exists())
    names = args.case or available
    if batched and any(name not in LIMITS or not (args.prepared / name / "options.json").is_file() for name in names):
        raise ValueError("The batched history requires a prepared fixture for every requested corpus case")
    for name in names:
        prepared=args.prepared/name
        meta=load_options(prepared)
        cfg={key:meta[key] for key in ("manifest","items","visiblePaths")}
        cfg["globalLabel"]=name=="lily58"
        cfg["models"]=meta["models"]
        cfg["assetBytes"]=meta["assetBytes"]
        rows=[]
        if args.suite=="designs":
            trials=[("edits","part",2),("edits","label",2),("edits","part",2),("edits","track",2),("edits","part",2),("open",None,0)]
        elif args.suite=="history" or batched:
            trials=[("edits","part",100)]
        elif args.suite=="idle":
            trials=[("idle",power,0) for power in (args.power or ["foreground","hidden","lowPower","rapid"])]
        elif args.suite=="access":
            trials=[("edits","part",1)]
        elif args.suite=="physical":
            trials=[("scale",None,0)]
        elif args.suite=="attachment":
            trials=[("attachment","existing",0),("attachment","child",0)]
        elif args.suite=="undo":
            trials=[("undo",None,0)]
        elif args.suite in ("smoke","save-memory"):
            trials=[("edits","part",2)]
        else:
            raise ValueError(args.suite)
        for mode, edit, count in trials:
            settings={**cfg,"mode":mode,"edit":edit,"saves":count,"git":bool(count),"power":edit,"switches":24,
                      "readAudit":args.suite=="access","saveRSS":args.suite=="save-memory",
                      "stockWriter":getattr(args,"stock_writer",False),"finalOverlay":getattr(args,"final_overlay",False)}
            try:
                if batched:
                    settings.update(gitBatchSize=20, nativeSaveKey=True, verifySaves=True)
                result=measure(exe,prepared/"design",settings,args.scratch,name=="approved")
                if batched:
                    if result["fullValidationError"] or any(not row["nativeKeyHandled"] or row["rowsEncoded"] != 1 for row in result["saves"]):
                        raise ValueError("The native closure or one-row Command-S witness failed")
                if args.suite=="physical":
                    trace=result.get("physicalVisibleIO") or {}
                    if trace.get("opens",0)<2 or trace.get("bytes",0)<result["visibleIO"]["bytes"]:
                        raise ValueError("Physical descriptor and read trace did not cover the visible request bytes")
                rows.append(result)
            except Exception as error:
                if args.suite != "designs" and not batched:
                    raise
                rows.append({"mode":mode,"edit":edit,"error":"The private trial failed." if name=="approved" else str(error)[-2000:]})
                output[name]=rows
                save(output)
                print(name,mode,"failed",flush=True)
                break
            output[name]=rows
            save(output)
            print(name,mode, len(rows),"complete",flush=True)
    return output


def ready_opens(exe, args, save):
    names = args.case or sorted(p.name for p in args.prepared.iterdir() if (p / "options.json").is_file())
    if not names or len(set(names)) != len(names) or args.repeats < 1:
        raise ValueError("Choose distinct ready-open cases and a positive repeat count")
    settings = {}
    for name in names:
        meta = load_options(args.prepared / name)
        settings[name] = {**{key:meta[key] for key in ("manifest", "items", "visiblePaths")},
                          "mode":"ready-open", "stockWriter":args.stock_writer,
                          "activeId":meta.get("activeId"), "itemsByDocument":meta.get("itemsByDocument"),
                          "activeKind":meta.get("activeKind"), "activeItems":meta["items"][0]}
    output = {name:[] for name in names}
    for repeat in range(args.repeats):
        shift = repeat % len(names)
        order = names[shift:] + names[:shift]
        if repeat % 2:
            order.reverse()
        for name in order:
            try:
                row = measure(exe, args.prepared / name / "design", settings[name], args.scratch, name == "approved")
                if row.get("mode") != "ready-open" or row["readyToEditMs"] != max(row["firstPaintMs"], row["liveGeometryMs"]) or not row["readyRSSSamples"]:
                    raise ValueError("The native observation did not include ready-to-edit and memory endpoints")
            except (ValueError, RuntimeError, KeyError, TimeoutError, subprocess.SubprocessError) as error:
                row = {"error":"The private trial failed." if name == "approved" else str(error)[-2000:]}
            output[name].append(row)
            save(output)
            print(name, repeat + 1, "failed" if "error" in row else "complete", flush=True)
    return output


def open_runtime(exe, source):
    resources = Path(exe).parents[1] / "Resources"
    hashes = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
    rows = [[p.relative_to(resources).as_posix(), p.stat().st_size, hashes(p)]
            for p in sorted((resources / "app").rglob("*")) if p.is_file()]
    source_names = {p.relative_to(source).as_posix() for p in (source / "app").rglob("*") if p.is_file()}
    if not rows or source_names != {path for path, _, _ in rows} or any(hashes(source / path) != digest for path, _, digest in rows):
        raise ValueError("The signed observer's app resources differ from the chosen product source")
    if hashes(resources / "bridge.js") != hashes(source / "native/bridge.js"):
        raise ValueError("The signed observer's native bridge differs from the chosen product source")
    if hashes(resources / "probe.js") != hashes(HERE / "desktop-probe.js"):
        raise ValueError("The signed observer contains a different Open probe")
    digest = lambda entries: hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()
    mac_source = [[p.relative_to(source).as_posix(), p.stat().st_size, hashes(p)]
                  for p in sorted((source / "native/macos").rglob("*")) if p.is_file()]
    head = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True)
    cpu, memory = subprocess.check_output(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string", "hw.memsize"], text=True).splitlines()
    return {"sourceParent":head.stdout.strip() if head.returncode == 0 else None,
            "architecture":platform.machine(), "macOS":platform.mac_ver()[0],
            "processor":cpu, "physicalMemoryBytes":int(memory),
            "macOSBuild":subprocess.check_output(["/usr/bin/sw_vers", "-buildVersion"], text=True).strip(), "resources":len(rows),
            "resourceLedgerSHA256":digest(rows), "nativeMacSourceLedgerSHA256":digest(mac_source),
            "nativeBridgeSHA256":hashes(resources / "bridge.js"), "probeSHA256":hashes(resources / "probe.js"),
            "executableSHA256":hashes(Path(exe)), "stockWriter":(resources / "format2-stock-writer").is_file()}


def warm(exe, args, save):
    ids=["pidp11-io-expander","synthetic"]
    all_rows=[]
    for n in range(args.repeats):
        pair={}
        for name in (ids if n%2==0 else ids[::-1]):
            prepared=args.prepared/name
            template=load_options(prepared)
            cfg={k:template[k] for k in ("manifest","items","visiblePaths")}
            out=measure(exe,prepared/"design",{**cfg,"mode":"edits","edit":"part","saves":2,"git":False,
                        "sheetPart":name==ids[0]},args.scratch)
            pair[name]=out["saves"][-1]
        all_rows.append(pair)
        save({"blocks":all_rows})
        print("matched moves", n+1,flush=True)
    return {"blocks":all_rows}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--product",type=Path,required=True)
    p.add_argument("--reuse-exe",type=Path,help="Identical signed private bundle previously compiled by this harness")
    p.add_argument("--stock-writer",action="store_true",help="Use the unchanged production transaction implementation for a matched history")
    p.add_argument("--final-overlay",action="store_true",help="Compare the last visible PCB overlay with the full calculation after every timed save has finished")
    p.add_argument("--prepared",type=Path,required=True)
    p.add_argument("--scratch",type=Path,required=True)
    p.add_argument("--suite",required=True,choices=("scaling","designs","ready-open","history","batched-history","smoke","idle","warm","undo","access","attachment","physical","save-memory"))
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--case",action="append")
    p.add_argument("--power",action="append",choices=("foreground","hidden","lowPower","rapid"))
    p.add_argument("--repeats",type=int,default=20)
    a=p.parse_args()
    a.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    def write(value):
        temporary=a.out.with_suffix(".tmp")
        temporary.write_text(json.dumps(value,indent=2)+"\n")
        os.replace(temporary,a.out)
    if a.stock_writer and a.suite not in ("history","batched-history","ready-open"):p.error("--stock-writer requires a history or ready-open observation")
    if a.final_overlay and (not a.stock_writer or a.case!=["garganturam"]):p.error("--final-overlay requires a stock Garg history")
    with (nullcontext(a.reuse_exe) if a.reuse_exe else build(a.product,observe_transactions=not a.stock_writer)) as exe:
        if a.stock_writer != (Path(exe).parents[1]/"Resources/format2-stock-writer").is_file():
            raise ValueError("The native writer in the private bundle differs from the requested observation")
        driver = {"scaling":scaling,"warm":warm,"ready-open":ready_opens}.get(a.suite,cases)
        runtime = open_runtime(exe, a.product) if a.suite == "ready-open" else None
        result = driver(exe,a,write)
        if runtime is not None:
            if open_runtime(exe, a.product) != runtime:
                raise ValueError("The ready-open product resources changed during the cohort")
            a.out.with_suffix(".runtime.json").write_text(json.dumps(runtime, indent=2) + "\n")
    write(result)
    if a.suite == "ready-open" and any("error" in row for rows in result.values() for row in rows):
        raise SystemExit("At least one native ready-open trial failed; see the partial receipts.")
    if a.suite == "batched-history" and any("error" in row for rows in result.values() for row in rows):
        raise SystemExit("One or more batched histories failed. See the per-case receipt.")


if __name__=="__main__":
    main()
