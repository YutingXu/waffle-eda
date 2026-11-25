#!/usr/bin/env python3
"""Run tsc over the checked files and judge the result against types/baseline.json.

    python3 types/typecheck.py TSC [--update]

TSC is the command that runs TypeScript's compiler (scripts/typecheck.sh finds or installs it).
Nothing is written into the repository: the generated module member lists
(types/gen-globals.py) and the tsconfig that adds them go to a temporary folder.

types/baseline.json is the ratchet:
  checked       the files under type checking. The list may only grow.
  expected      per file, per error code: how many errors are tolerated. Counts may only fall.
                These are known false positives of checking untyped JavaScript (an eager
                module cannot carry JSDoc) and things judged not worth a code change; each
                file's "why" says which.
  ignoredCodes  error codes never counted, with the reason.

The check fails when:
  * a checked file has more errors of a code than `expected` allows (a new error);
  * types/tsconfig.json "files" and baseline "checked" differ;
  * tests/types-model.py finds model.d.ts out of step with app/model.js or the JSON schema;
  * compared with the baseline at git REF (TYPECHECK_BASE_REF, default HEAD; skipped when git
    or the file at REF is unavailable), a file left `checked` or an `expected` count grew.
It prints a note when a file has fewer errors than expected, so the count can be lowered, and
when a global is missing from types/globals.d.ts (the generated file declares it meanwhile).
--update rewrites `expected` to the current counts (it never removes a checked file); use it
only after reading every new error.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = os.path.join(ROOT, "types")
BASELINE = os.path.join(TYPES, "baseline.json")
TSCONFIG = os.path.join(TYPES, "tsconfig.json")
ERROR = re.compile(r'^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$')


def load_jsonc(path):
    text = open(path, encoding="utf-8").read()
    # tsconfig allows // comments; strip them outside strings.
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\":
                out.append(text[i + 1]); i += 2; continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True; out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        else:
            out.append(c)
        i += 1
    return json.loads("".join(out))


def baseline_at(ref):
    try:
        out = subprocess.run(["git", "-C", ROOT, "show", f"{ref}:types/baseline.json"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except ValueError:
        return None


def main():
    args = sys.argv[1:]
    update = "--update" in args
    args = [a for a in args if a != "--update"]
    if len(args) != 1:
        sys.exit(__doc__)
    tsc = shlex.split(args[0])
    base = json.load(open(BASELINE, encoding="utf-8"))
    checked = base["checked"]
    expected = base.get("expected", {})
    ignored = set(base.get("ignoredCodes", {}))
    problems, notes = [], []

    # tsconfig "files" must name exactly the checked files (plus the declaration files).
    cfg = load_jsonc(TSCONFIG)
    listed = [os.path.normpath(os.path.join("types", f)) for f in cfg.get("files", [])]
    js = sorted(f for f in listed if not f.endswith(".d.ts"))
    if js != sorted(checked):
        problems.append("types/tsconfig.json \"files\" and types/baseline.json \"checked\" differ: "
                        f"only in tsconfig {sorted(set(js) - set(checked))}, only in baseline {sorted(set(checked) - set(js))}")
    dts = [f for f in listed if f.endswith(".d.ts")]
    for f in dts:
        if not os.path.exists(os.path.join(ROOT, f)):
            problems.append(f"{f} is listed but does not exist")
    # A module that was deleted (or merged into another) cannot be checked; that is not a regression.
    gone = [f for f in checked if not os.path.exists(os.path.join(ROOT, f))]
    if gone:
        notes.append("checked files that no longer exist (remove them from types/baseline.json and types/tsconfig.json): " + ", ".join(gone))
    present = [f for f in checked if f not in gone]

    model = subprocess.run([sys.executable, os.path.join(ROOT, "tests", "maintenance", "types-model.py")], capture_output=True, text=True)
    if model.returncode != 0:
        problems.append("tests/maintenance/types-model.py (model.d.ts vs model.js and the JSON schema):\n" + (model.stdout + model.stderr).strip())

    gen = subprocess.run([sys.executable, os.path.join(TYPES, "gen-globals.py"), "--check"], capture_output=True, text=True)
    if gen.returncode != 0:
        # Not a failure: the generated file declares them. A new module should still get its line.
        notes.append("globals not yet in types/globals.d.ts (run python3 types/gen-globals.py --add):\n  " +
                     gen.stdout.strip().replace("\n", "\n  "))

    # The ratchet against the committed baseline.
    ref = os.environ.get("TYPECHECK_BASE_REF", "HEAD")
    old = baseline_at(ref)
    if old is None:
        notes.append(f"ratchet: no types/baseline.json at {ref} (or no git); list and counts not compared")
    else:
        relocated = base.get("sourceRelocations", {})
        old["checked"] = [relocated.get(path, path) for path in old.get("checked", [])]
        old["expected"] = {relocated.get(path, path): counts for path, counts in old.get("expected", {}).items()}
        dropped = sorted(f for f in set(old.get("checked", [])) - set(checked) if os.path.exists(os.path.join(ROOT, f)))
        if dropped:
            problems.append(f"files left the checked list (compared with {ref}): {dropped}. The list may only grow.")
        for f, codes in expected.items():
            for code, n in codes.items():
                if isinstance(n, int) and n > old.get("expected", {}).get(f, {}).get(code, 0) and f in old.get("checked", []):
                    problems.append(f"{f}: expected {code} count grew from {old.get('expected', {}).get(f, {}).get(code, 0)} to {n} "
                                    f"(compared with {ref}). Fix the new errors instead.")

    with tempfile.TemporaryDirectory(prefix="atrium-types.") as tmp:
        gen_path = os.path.join(tmp, "globals.gen.d.ts")
        subprocess.run([sys.executable, os.path.join(TYPES, "gen-globals.py"), gen_path], check=True)
        conf = {"extends": TSCONFIG,
                "files": [os.path.join(ROOT, f) for f in dts] + [gen_path] + [os.path.join(ROOT, f) for f in present]}
        conf_path = os.path.join(tmp, "tsconfig.json")
        json.dump(conf, open(conf_path, "w"))
        t0 = time.time()
        run = subprocess.run(tsc + ["-p", conf_path, "--pretty", "false"], capture_output=True, text=True, cwd=ROOT)
        elapsed = time.time() - t0
        gen_lines = open(gen_path, encoding="utf-8").read().splitlines()
    output = run.stdout + run.stderr
    errors = defaultdict(Counter)
    lines_by_file = defaultdict(list)
    last = None
    for line in output.splitlines():
        m = ERROR.match(line)
        if not m:
            if line.startswith(" ") and last is not None:
                last.append(line)  # the indented detail lines of the previous error
            continue
        path = os.path.relpath(os.path.join(ROOT, m.group(1)), ROOT)
        code = m.group(4)
        last = None
        if code in ignored:
            continue
        text = line.replace(ROOT + os.sep, "")
        if path.endswith("globals.gen.d.ts"):
            path = "types/gen-globals.py output"
            n = int(m.group(2))
            text = f"generated line {n}: {m.group(5)}\n    " + "\n    ".join(gen_lines[max(0, n - 2):n + 1])
        errors[path][code] += 1
        last = lines_by_file[(path, code)]
        last.append(text)
    if run.returncode not in (0, 1, 2) or (run.returncode and not errors and not any(ERROR.match(l) for l in output.splitlines())):
        problems.append(f"tsc failed to run (exit {run.returncode}):\n" + output[-3000:])

    new_expected = {}
    for path in sorted(set(errors) | set(expected)):
        allowed = expected.get(path, {})
        for code in sorted(set(errors.get(path, {})) | set(k for k in allowed if k.startswith("TS"))):
            have, ok = errors.get(path, Counter())[code], allowed.get(code, 0)
            if have:
                new_expected.setdefault(path, {})[code] = have
            if path not in checked and have:
                problems.append(f"{path}: {have} {code} error(s) in a declaration file:\n  " +
                                "\n  ".join(lines_by_file[(path, code)][:20]))
            elif have > ok:
                problems.append(f"{path}: {have} {code} error(s), {ok} expected:\n  " + "\n  ".join(lines_by_file[(path, code)][:40]))
            elif have < ok:
                notes.append(f"{path}: {code} now {have}, baseline allows {ok}; lower it in types/baseline.json")
        if path in expected and "why" in expected[path]:
            new_expected.setdefault(path, {})["why"] = expected[path]["why"]

    if update:
        base["expected"] = {k: v for k, v in sorted(new_expected.items()) if k in checked and any(c.startswith("TS") for c in v)}
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump(base, f, indent=2)
            f.write("\n")
        print("typecheck: wrote types/baseline.json expected counts")

    total = sum(sum(c.values()) for c in errors.values())
    lines = sum(sum(1 for _ in open(os.path.join(ROOT, f), encoding="utf-8")) for f in present)
    for n in notes:
        print("note: " + n)
    for p in problems:
        print("FAIL  " + p)
    print(f"typecheck: {len(present)} files ({lines} lines) checked in {elapsed:.1f}s; {total} known error(s) within the baseline"
          if not problems else f"typecheck: {len(problems)} problem(s)")
    sys.exit(1 if problems and not update else 0)


if __name__ == "__main__":
    main()
