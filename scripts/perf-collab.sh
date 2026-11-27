#!/bin/zsh
# Live-session performance and resilience baseline on the 25,600-object benchmark board
# (tests/pcb/dense-board.js), two editors on this computer. Prints numbers; --budgets enforces the
# per-edit budgets below on the median of the runs' p95 (exit 3 when one is missed).
#
#   Stage 1  scripts/bench-collab-edits.cjs (Node, no browser): the CRDT alone, a scoped local
#            commit and a remote receive + patch, with the bytes they stringify.
#   Stage 2  scripts/perf-collab.cjs (headless Chrome, playwright-core): per transport (local =
#            BroadcastChannel; relay = collab/relay/waffle_relay.py on 127.0.0.1 with WebRTC
#            direct; relay-only = the same relay with "Always through the relay server"):
#            per-edit-kind cost on both editors, edit-to-guest latency, join time and bytes, idle
#            wake-ups and CPU, and what happens to edits when the relay drops, stalls and returns,
#            and when a guest falls behind the bounded CRDT log.
#   Stage 3  scripts/bench-collab-editor.cjs (only with EDITOR_BENCH=1): the nudge publication bench.
#
# Each stage runs RUNS times (default 3); the summary gives the median and the [min–max] spread of
# every run's p50 and p95. Machines shared with other work give noisy numbers: treat them as provisional.
#
# Budgets (--budgets; the live-session targets in docs/collaboration.md, on the cost pass's transport):
#   guest receive + view + patch of a remote edit, any kind   p95 <= 4 ms
#   host publication of a local add, delete or paste           p95 <= 4 ms
#   host publication of an in-place edit (incl. verification)  p95 <= 1 ms
#   host personal undo (the editor command)                    p95 <= 16 ms
#   a remote move, property, add or delete: no full Undo-journal sync on the guest and online DRC
#   over at most 2,000 items (the board has 25,600)
#
# Usage: scripts/perf-collab.sh [--json] [--out file.json] [--skip-if-no-browser] [--budgets] [-- driver args]
#   driver args go to perf-collab.cjs, e.g. -- --transports relay --reps 12 --idle 60 --insights
# Env: RUNS=3  CHROME=/path/to/chrome  EDITOR_BENCH=1
root=${0:A:h:h}
json=0 skip=0 out="" driver=() budgets=0
while (( $# )); do
  case $1 in
    --json) json=1;; --skip-if-no-browser) skip=1;; --budgets) budgets=1;; --out) shift; out=$1;;
    --) shift; driver=("$@"); break;;
    *) print -u2 "unknown argument $1"; exit 2;;
  esac; shift
done
# Node and playwright-core as scripts/perf-view-feel.sh finds them.
node=${commands[node]:-}
[[ -z $node ]] && for n in $HOME/.cache/atrium-ci/node-*/bin/node(N); do node=$n; done
paths=()
for d in $root/node_modules $root/scripts/ci/node_modules $HOME/.cache/atrium-ci/ci-node-*/node_modules(N) ${(s.:.)NODE_PATH}; do
  [[ -d $d/playwright-core ]] && paths+=$d
done
if [[ -z $node ]] || (( ! $#paths )) || [[ -z ${CHROME:-} && ! -d "/Applications/Google Chrome.app" && -z ${commands[google-chrome]:-} ]]; then
  print -u2 "perf-collab: needs node, playwright-core and Google Chrome (set PATH, NODE_PATH or CHROME)"
  (( skip )) && { print "perf-collab: SKIPPED"; exit 0; }
  exit 2
fi
export NODE_PATH=${(j.:.)paths}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-perf-collab.XXXXXX"); trap 'rm -rf $tmp' EXIT
runs=${RUNS:-3}
for n in {1..$runs}; do
  print -u2 "perf-collab: run $n/$runs: CRDT bench"
  $node $root/scripts/bench-collab-edits.cjs > $tmp/edits$n.json || { print -u2 "perf-collab: bench-collab-edits failed"; exit 2; }
  print -u2 "perf-collab: run $n/$runs: two editors"
  $node $root/scripts/perf-collab.cjs --json $driver > $tmp/live$n.json || { print -u2 "perf-collab: perf-collab.cjs failed"; cat $tmp/live$n.json >&2; exit 2; }
  if [[ ${EDITOR_BENCH:-0} == 1 ]]; then
    print -u2 "perf-collab: run $n/$runs: nudge bench"
    $node $root/scripts/bench-collab-editor.cjs > $tmp/editor$n.json || { print -u2 "perf-collab: bench-collab-editor failed"; exit 2; }
  fi
done
python3 - "$tmp" "$runs" "$json" "$out" "$budgets" <<'PY'
import json, os, statistics, sys
tmp, runs, asjson, outpath, checkBudgets = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4], sys.argv[5] == "1"
load = lambda name: [json.load(open(os.path.join(tmp, "%s%d.json" % (name, n)))) for n in range(1, runs + 1) if os.path.exists(os.path.join(tmp, "%s%d.json" % (name, n)))]
edits, live, editor = load("edits"), load("live"), load("editor")
def spread(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals: return None
    return {"median": round(statistics.median(vals), 2), "min": round(min(vals), 2), "max": round(max(vals), 2), "runs": len(vals)}
def walk(o, prefix=""):
    # Leaves: {n, p50, p95} quantile records, and plain numbers.
    if isinstance(o, dict) and "p50" in o and "p95" in o: yield prefix, o; return
    if isinstance(o, dict):
        for k, v in o.items(): yield from walk(v, prefix + "." + k if prefix else k)
    elif isinstance(o, (int, float)) and not isinstance(o, bool): yield prefix, o
def combine(results):
    keys, out = [], {}
    for r in results:
        for k, v in walk(r):
            if k not in out: out[k] = []; keys.append(k)
            out[k].append(v)
    summary = {}
    for k in keys:
        vals = out[k]
        if isinstance(vals[0], dict): summary[k] = {"p50": spread([v.get("p50") for v in vals]), "p95": spread([v.get("p95") for v in vals]), "n": vals[0].get("n")}
        else: summary[k] = spread(vals)
    return summary
report = {"runs": runs, "provisional": True, "crdt": combine(edits), "editors": combine(live), "nudgeBench": combine(editor) if editor else None,
          "raw": {"edits": edits, "live": live, "editor": editor}}
# Outcomes that are not numbers (paths, which edits arrived) per run.
report["outcomes"] = [{m: {k: t.get(k) for k in ("drop", "stall", "trim") if k in t} | {"paths": t.get("join", {}).get("paths"), "error": t.get("error"), "pageErrors": t.get("pageErrors")}
                       for m, t in r["transports"].items()} for r in live]
if outpath: open(outpath, "w").write(json.dumps(report, indent=1))
def budgets():
    # The same table as scripts/perf-collab.cjs BUDGETS, on the median of the runs' p95.
    B = {"remote": 4, "structural": 4, "inPlace": 1, "undo": 16, "drcItems": 2000}
    failed, lines, ed = [], [], report["editors"]
    def p95(k):
        v = ed.get(k)
        return v["p95"]["median"] if isinstance(v, dict) and v.get("p95") else None
    for k in [k for k in ed if ".cost." in k and k.endswith(".guestRemoteTotalMs")]:
        pre, kind = k[:-len(".guestRemoteTotalMs")], k.split(".")[-2]
        checks = [("guest remote", p95(k), B["remote"])]
        if kind in ("add", "delete", "paste"): checks.append(("publish", p95(pre + ".publishMs"), B["structural"]))
        if kind in ("move", "vertex", "property", "table"): checks.append(("publish", p95(pre + ".publishMs"), B["inPlace"]))
        if kind == "undo": checks.append(("undo command", p95(pre + ".editMs"), B["undo"]))
        if kind in ("move", "property", "add", "delete"):
            full, drc = (ed.get(pre + ".guestFullSyncs") or {}).get("max"), p95(pre + ".guestDrcItems")
            if full: failed.append("%s: %s full journal syncs on the guest" % (pre, full))
            if drc is not None and drc > B["drcItems"]: failed.append("%s: online DRC over %s items" % (pre, drc))
        for what, v, limit in checks:
            lines.append("  %-30s %-14s p95 %8s ms  budget %5s ms  headroom %s" % (pre.split(".cost.")[-1], what, v, limit, "-" if v is None else "%.0f%%" % (100 * (limit - v) / limit)))
            if v is None or v > limit: failed.append("%s %s p95 %s ms > %s ms" % (pre, what, v, limit))
    return failed, lines
if checkBudgets:
    failed, lines = budgets()
    report["budgets"] = {"lines": lines, "failed": failed}
if asjson:
    print(json.dumps(report, indent=1))
    sys.exit(3 if checkBudgets and report["budgets"]["failed"] else 0)
fmt = lambda s: "-" if not s else ("%8.2f [%s–%s]" % (s["median"], s["min"], s["max"]))
print("Live-session baseline (PROVISIONAL: %d runs; median [min–max] of each run's value; ms unless named)" % runs)
for title, summary in (("CRDT alone (bench-collab-edits.cjs, Node)", report["crdt"]), ("Two editors (perf-collab.cjs, headless Chrome)", report["editors"]),
                       ("Nudge bench (bench-collab-editor.cjs)", report["nudgeBench"] or {})):
    if not summary: continue
    print("\n" + title)
    for k, v in summary.items():
        if k.startswith(("raw", "reps", "idleSeconds")) or v is None: continue
        if isinstance(v, dict) and "p50" in v: print("  %-62s p50 %-26s p95 %s" % (k, fmt(v["p50"]), fmt(v["p95"])))
        else: print("  %-62s     %s" % (k, fmt(v)))
print("\nOutcomes per run (drop, stall, trim):")
for i, o in enumerate(report["outcomes"], 1): print("  run %d: %s" % (i, json.dumps(o)))
if checkBudgets:
    print("\nBudgets (median of the runs' p95):")
    for line in report["budgets"]["lines"]: print(line)
    for f in report["budgets"]["failed"]: print("perf-collab: over budget: " + f, file=sys.stderr)
    if report["budgets"]["failed"]: sys.exit(3)
    print("perf-collab: all budgets met")
PY
