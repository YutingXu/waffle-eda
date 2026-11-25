#!/usr/bin/env python3
"""Measure the checked-out revision and report paired-confirmed performance regressions."""

import argparse
from datetime import datetime, timezone
import fcntl
import hmac
import json
import os
from pathlib import Path
import platform
import re
import secrets
import statistics
import subprocess
import sys
import tempfile

from performance_benchmarks import BenchmarkError, COMMANDS, browser_path, collect, numeric, workload_id

SCHEMA = 1
HISTORY_LIMIT = 30
BASELINE_WINDOW = 5
MIN_HISTORY = 3
MIN_SAMPLES = 10
REGRESSION = 0.20
TIMER_FLOOR_MS = 0.02
ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"[a-f0-9]{64}")
METRIC = re.compile(r"[A-Za-z0-9 _./+-]{1,120}")
ACCEPTED = {"pass", "warmup", "unconfirmed"}
UNITS = {"ms", "bytes", "MiB", "count", "%", "Hz"}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def ancestry(root):
    return git(root, "rev-list", "--first-parent", "HEAD").splitlines()


def cohort(seed, runner, profile, workload):
    def digest(value):
        return hmac.digest(seed, json.dumps(value, sort_keys=True).encode(), "sha256").hex()
    return {"runner": digest(runner), "environment": digest(profile), "workload": workload}


def local_environment(chrome):
    seed_path = Path.home() / ".cache" / "atrium-ci" / "performance-runner-key"
    seed_path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(seed_path, os.O_CREAT | os.O_RDWR, 0o600), "r+", encoding="ascii") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        file.seek(0)
        key = file.read().strip()
        if not key:
            key = secrets.token_hex(32)
            file.write(key + "\n")
            file.flush()
        if not DIGEST.fullmatch(key):
            raise BenchmarkError("Invalid local performance runner key.")
    machine = [platform.system(), platform.release(), platform.machine(), os.cpu_count()]
    if platform.system() == "Darwin":
        machine += subprocess.check_output(
            ["sysctl", "-n", "hw.model", "hw.ncpu", "hw.memsize", "machdep.cpu.brand_string"],
            text=True, timeout=10).splitlines()
    elif Path("/proc/cpuinfo").is_file():
        # Linux local runs use a stable CPU model field and omit clocks and serial numbers.
        machine += sorted({line for line in Path("/proc/cpuinfo").read_text().splitlines()
                           if line.split(":")[0].strip() in ("model name", "CPU part")})
    profile = machine + [platform.python_version()]
    for executable in ("node", chrome):
        profile.append(subprocess.check_output([executable, "--version"], text=True, timeout=15).strip())
    return cohort(bytes.fromhex(key), os.environ.get("RUNNER_NAME", "local"), profile, workload_id(ROOT))


def valid_metric(row):
    if "p95" not in row:
        return set(row) == {"unit", "value"} and row["unit"] in UNITS and numeric(row["value"])
    return (row["unit"] == "ms" and type(row["n"]) is int and row["n"] > 0
            and all(name in {"p50", "p95", "p99", "min", "max"} and numeric(value)
                    for name, value in row.items() if name not in {"unit", "n"}))


def valid_history_record(record):
    try:
        fields = record["cohort"]
        if (type(record["schema"]) is not int or record["schema"] != SCHEMA or not SHA.fullmatch(record["commit"])
                or set(fields) != {"runner", "environment", "workload"}
                or not all(DIGEST.fullmatch(item) for item in fields.values())
                or record["status"] not in ACCEPTED or record.get("dirty")):
            return False
        if datetime.fromisoformat(record["measuredAt"].replace("Z", "+00:00")).utcoffset() != timezone.utc.utcoffset(None):
            return False
        return (isinstance(record["excluded"], list)
                and all(METRIC.fullmatch(name) for name in record["excluded"])
                and bool(record["metrics"])
                and all(METRIC.fullmatch(name) and valid_metric(row)
                    for name, row in record["metrics"].items()))
    except (KeyError, ValueError, TypeError, AttributeError, OverflowError):
        return False


def parse_history(data):
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise ValueError("Invalid performance history.")
    if type(data.get("schema")) is not int or data["schema"] != SCHEMA:
        return []
    keys = ("schema", "commit", "measuredAt", "cohort", "status", "metrics", "excluded")
    return [{key: record[key] for key in keys} for record in data["records"] if valid_history_record(record)]


def ordered_history(records, commits):
    """Use the first-parent order of the tested revision, deduplicated per runner series."""
    ranks = {sha: rank for rank, sha in enumerate(commits)}
    latest = {}
    for record in records:
        if record["commit"] not in ranks:
            continue
        key = (record["commit"], *sorted(record["cohort"].items()))
        if key not in latest or record["measuredAt"] > latest[key]["measuredAt"]:
            latest[key] = record
    return sorted(latest.values(), key=lambda row: ranks[row["commit"]])[:HISTORY_LIMIT]


def p95(row):
    if row.get("unit") == "ms" and row.get("n", 0) >= MIN_SAMPLES and row.get("p95", 0) > 0:
        return row["p95"]
    return None


def matching_history(record, history):
    return [old for old in history if old["cohort"] == record["cohort"] and old["schema"] == record["schema"]]


def controls(suspects, decisions):
    """Prefer one reference per suite and near-median controls for the timings it covers."""
    for suite, pending in suspects.items():
        while pending:
            coverage = {}
            for name, observations in pending.items():
                for previous, observed in observations:
                    coverage.setdefault(previous["commit"], {})[name] = observed

            def score(candidate):
                distance = sum(abs(ms / decisions[name]["baseline"] - 1)
                               for name, ms in candidate[1].items())
                return -len(candidate[1]), distance

            reference, observations = min(coverage.items(), key=score)
            yield suite, reference, observations
            for name in observations:
                del pending[name]


def compare(record, history, rerun):
    """Compare the five latest eligible commits and rerun only the suspicious suites."""
    history = matching_history(record, history)
    decisions, suspects = {}, {}
    for name, row in record["metrics"].items():
        current = p95(row)
        if current is None:
            continue
        observations = [(previous, p95(previous["metrics"].get(name, {}))) for previous in history
                        if name not in previous["excluded"]]
        observations = [(previous, ms) for previous, ms in observations if ms is not None][:BASELINE_WINDOW]
        decision = decisions[name] = {"count": len(observations), "status": "warmup"}
        if len(observations) < MIN_HISTORY:
            continue
        middle = statistics.median(ms for _, ms in observations)
        mad = statistics.median(abs(ms - middle) for _, ms in observations)
        guard = max(TIMER_FLOOR_MS, 3 * mad)
        decision.update(baseline=middle, deltaPct=100 * (current / middle - 1), noiseMs=guard,
                        status="pass")
        if current > middle * (1 + REGRESSION):
            if current - middle <= guard:
                decision["status"] = "within-noise"
            else:
                suite = name.split("/", 1)[0]
                suspects.setdefault(suite, {})[name] = observations
                decision["status"] = "pending"

    for suite, reference, metrics in controls(suspects, decisions):
        control, candidate = rerun(suite, reference)
        for name, previous_ms in metrics.items():
            decision = decisions[name]
            before = p95(control.get(name, {}))
            after = p95(candidate.get(name, {}))
            decision["pair"] = {"commit": reference, "controlP95": before, "candidateP95": after}
            if before is None or after is None:
                decision["status"] = "unconfirmed"
                continue
            # A slow or fast runner window affects both timings. Use the control's change
            # from its own historical value to calibrate the rolling median for this pair.
            factor = before / previous_ms
            adjusted_baseline = decision["baseline"] * factor
            guard = max(TIMER_FLOOR_MS, decision["noiseMs"] * factor)
            paired = after > before * (1 + REGRESSION) and after - before > TIMER_FLOOR_MS
            historical = after > adjusted_baseline * (1 + REGRESSION) and after - adjusted_baseline > guard
            decision["status"] = "regression" if paired and historical else "unconfirmed"
            decision["pair"].update(adjustedBaseline=adjusted_baseline, noiseMs=guard,
                                    deltaPct=100 * (after / before - 1))
    return decisions


def decision_status(decisions):
    statuses = {row["status"] for row in decisions.values()}
    if "regression" in statuses:
        return "fail"
    if "unconfirmed" in statuses:
        return "unconfirmed"
    return "pass" if statuses.intersection({"pass", "within-noise"}) else "warmup"


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def action_summary(record):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with Path(path).open("a", encoding="utf-8") as summary:
        summary.write(f"## Performance · `{record['commit'][:10]}`\n\n")
        if record["status"] == "warmup":
            summary.write(f"Baseline warm-up. Found {record['matchingCommits']} earlier matching commits. "
                          f"The check needs {MIN_HISTORY} qualifying commits per timing.\n\n")
        else:
            summary.write(f"Performance result **{record['status']}**.\n\n")
        for name, row in record["comparison"].items():
            if row["status"] == "regression":
                summary.write(f"- `{name}` increased {row['deltaPct']:+.1f}% versus history "
                              f"and {row['pair']['deltaPct']:+.1f}% in the fresh pair.\n")
        summary.write("\nOpen `trend.html` in this run’s performance artifact.\n")


def benchmark_pair(suite, reference, chrome):
    print(f"Confirming {suite} against {reference[:10]} on this runner.", flush=True)
    with tempfile.TemporaryDirectory(prefix="waffle-control-") as tmp:
        directory = Path(tmp)
        archive = directory / "control.tar"
        control = directory / "checkout"
        control.mkdir()
        subprocess.run(["git", "archive", "--output", str(archive), reference], cwd=ROOT, check=True)
        subprocess.run(["tar", "-xf", str(archive), "-C", str(control)], check=True)
        before, _ = collect(control, chrome, suite)
    after, _ = collect(ROOT, chrome, suite)
    return before, after


def main():
    from performance_report import render

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="Directory for result.json, history.json and trend.html")
    parser.add_argument("--history", type=Path, help="history.json from earlier performance jobs")
    args = parser.parse_args()
    commits = ancestry(ROOT)
    record = {"schema": SCHEMA, "commit": commits[0],
              "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "dirty": bool(git(ROOT, "status", "--porcelain", "--untracked-files=no")),
              "metrics": {}, "workloads": {}, "errors": []}
    try:
        chrome = browser_path()
        record["cohort"] = local_environment(chrome)
        prior = parse_history(json.loads(args.history.read_text())) if args.history else []
    except (BenchmarkError, ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(2, f"Performance setup failed. {exc}\n")

    prior = ordered_history(prior, commits[1:])
    same_runner = matching_history(record, prior)
    decisions = {}
    for suite in COMMANDS:
        print(f"Measuring {suite}.", flush=True)
        try:
            metrics, workload = collect(ROOT, chrome, suite)
            record["metrics"].update(metrics)
            record["workloads"][suite] = workload
        except (BenchmarkError, OSError) as exc:
            record["errors"].append(str(exc) if isinstance(exc, BenchmarkError) else f"{suite} could not start.")
    if not record["errors"]:
        try:
            decisions = compare(record, prior, lambda suite, sha: benchmark_pair(suite, sha, chrome))
        except (BenchmarkError, OSError, subprocess.CalledProcessError):
            record["errors"].append("A paired benchmark could not be completed.")
    status = "error" if record["errors"] else decision_status(decisions)
    record.update(status=status, comparison=decisions, matchingCommits=len(same_runner),
                  excluded=[name for name, result in decisions.items()
                            if result["status"] in {"within-noise", "unconfirmed"}])
    args.output.mkdir(parents=True, exist_ok=True)
    write_json(args.output / "result.json", record)
    history = prior
    if status in ACCEPTED and not record["dirty"]:
        sample = {key: record[key] for key in ("schema", "commit", "measuredAt", "cohort",
                                                "status", "metrics", "excluded")}
        history = ordered_history([sample, *prior], commits)
    write_json(args.output / "history.json", {"schema": SCHEMA, "records": history})
    (args.output / "trend.html").write_text(render(record, same_runner, MIN_HISTORY, BASELINE_WINDOW),
                                            encoding="utf-8")
    action_summary(record)
    print(f"Performance: {status} ({len(same_runner)} earlier matching commits).", flush=True)
    for name, result in decisions.items():
        if result["status"] == "regression":
            print(f"{name} is {result['deltaPct']:+.1f}% versus history and "
                  f"{result['pair']['deltaPct']:+.1f}% in the fresh pair.", flush=True)
    for error in record["errors"]:
        print(error, file=sys.stderr)
    return int(status in {"fail", "error"})


if __name__ == "__main__":
    sys.exit(main())
