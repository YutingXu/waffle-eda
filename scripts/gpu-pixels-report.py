#!/usr/bin/env python3
"""Report for the GPU pixel test (tests/canvas/gpu-pixels.js), shared by scripts/gpu-pixels.sh (Chrome) and
native/tests/macos-harness/gpu-pixels.sh (WKWebView): prints one line per board and view, writes the JSON and
the images, and returns the exit status (0 within budget or skipped, 1 a case over budget)."""
import base64, json, os, sys, tempfile


def report(o, outp, images, host, skip_ok=True):
    if o.get("skipped"):
        print("SKIP  gpu-pixels (%s): %s" % (host, o["skipped"]))
        return 0 if skip_ok else 2
    imgs = o.pop("images", None) or {}
    folder = images or (os.path.join(tempfile.gettempdir(), "atrium-gpu-pixels", host.lower()) if imgs else "")
    if imgs:
        os.makedirs(folder, exist_ok=True)
        for k, v in imgs.items():
            for kind, url in v.items():
                if url: open(os.path.join(folder, "%s.%s.png" % (k, kind)), "wb").write(base64.b64decode(url.split(",", 1)[1]))
    if outp:
        open(outp, "w").write(json.dumps(o, indent=1))
    b = o.get("budget", {})
    print("GPU vs 2D pixels in %s (%s), interior px over 24 levels / edge mean difference / solid px"
          % (host, o.get("renderer")))
    ratio = o.get("pixelRatio", {})
    if ratio:
        sizes = sorted({"%s×%s" % (r["backing"]["width"], r["backing"]["height"]) for r in o.get("boards", {}).values() if r.get("backing")})
        native = " (display %s)" % ratio["native"] if "native" in ratio else ""
        print("  Canvas backing DPR %s%s%s" % (ratio["effective"], native, ", " + "/".join(sizes) if sizes else ""))
    for name, r in o.get("boards", {}).items():
        if r.get("skipped"):
            print("  %-26s skipped: %s" % (name, r["skipped"])); continue
        views = {}
        for k, m in r["cases"].items():
            views.setdefault(k.split(".")[0], []).append((k.split(".", 1)[1], m))
        for view, cases in views.items():
            worst = max((m.get("solid", 0) for _, m in cases), default=0)
            row = "  ".join(("%s skipped" % c) if m.get("skipped") else "%s %s/%s/%s%s" % (c, m.get("interiorPx"), m.get("edgeMean"), m.get("solidPx"), "!" if m.get("fail") or m.get("error") else "") for c, m in cases)
            print("  %-12s %-7s %s" % (name[:12], view, row))
    if o.get("rasterCases"):
        print("  %d case(s) checked against fixed raster tiles" % len(o["rasterCases"]))
    for k, v in (o.get("robust") or {}).items():
        print("  robustness %-12s %s" % (k, v))
    for e in o.get("notes") or []:
        print("NOTE  %s" % e)
    for e in o.get("errors") or []:
        print("NOTE  page error: %s" % e)
    fails = o.get("failures", [])
    for f in fails:
        print("FAIL  %s" % f)
    if fails and folder:
        print("NOTE  images of the failing cases (2D, GPU, diff: white over 48 levels, grey over 8, red solid): %s" % folder)
    print("%s  GPU pixel test (%s): %d case(s) over budget" % ("FAIL" if fails else "PASS", host, len(fails)))
    return 1 if fails else 0


def calibrate(o, root, host):
    """Per-case budgets from this run (the real GPU output), written to tests/canvas/gpu-pixels-budgets.json under host:
    interiorPx, solidPx and each object class's interior count (c_*) 1.2 x measured + 6 px, edgeMean 1.1 x measured
    + 0.15 levels."""
    path = os.path.join(root, "tests", "canvas", "gpu-pixels-budgets.json")
    allb = json.load(open(path)) if os.path.exists(path) else {}
    mine = {}
    for b, x in o.get("boards", {}).items():
        for k, m in (x.get("cases") or {}).items():
            if "interiorPx" in m:
                lim = {"interiorPx": int(m["interiorPx"] * 1.2 + 6), "edgeMean": round(m["edgeMean"] * 1.1 + .15, 2), "solidPx": int(m["solidPx"] * 1.2 + 6)}
                # Per object class (c_hole, c_sel, c_top, ...): interior differences of that class's colour.
                lim.update({c: int(v * 1.2 + 6) for c, v in m.items() if c.startswith("c_")})
                mine[b + "." + k] = lim
    allb[host] = dict(sorted(mine.items()))
    allb["_about"] = ("Per-case budgets of tests/canvas/gpu-pixels.js by host, from a calibration run of the real GPU output "
                      "(CALIBRATE=1 scripts/gpu-pixels.sh, CALIBRATE=1 native/tests/macos-harness/gpu-pixels.sh): interiorPx, "
                      "solidPx and the per-object-class interior counts (c_hole, c_sel, c_top, c_bottom, c_inner, c_silk, c_conn, "
                      "c_other) 1.2 x measured + 6, edgeMean 1.1 x measured + 0.15. Every fault of FAULTS=all must exceed them.")
    open(path, "w").write(json.dumps(dict(sorted(allb.items())), indent=1) + "\n")
    print("NOTE  wrote %d %s budgets to %s" % (len(mine), host, path))


if __name__ == "__main__":
    o = json.load(open(sys.argv[1]))
    sys.exit(report(o, sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else "", sys.argv[4] if len(sys.argv) > 4 else "WKWebView"))
