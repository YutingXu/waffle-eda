"""Deterministic coverage of history, paired confirmation and artifact restoration."""

import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler
import zipfile

import performance as perf
import performance_benchmarks as benches
import performance_history as artifacts
from performance_report import render

BOOT = "startup/boot"
BYTES = "startup/eagerJsBytes"
COHORT = perf.cohort(b"test key", "runner", ["hardware", "runtime"], "e" * 64)


def sha(i):
    return f"{i:040x}"


def time(ms, samples=20):
    return {"unit": "ms", "p95": ms, "n": samples}


def sample(i, ms, **changes):
    return {"schema": perf.SCHEMA, "commit": sha(i), "measuredAt": f"2026-11-{i:02}T12:00:00+00:00",
            "cohort": COHORT, "status": "pass", "excluded": [],
            "metrics": {BOOT: time(ms), BYTES: {"unit": "bytes", "value": 1_008_350}}, **changes}


class Comparisons(unittest.TestCase):
    def setUp(self):
        self.history = [sample(3, 102), sample(2, 100), sample(1, 98)]
        self.rerun = Mock(side_effect=AssertionError("a pair should not be needed"))

    def test_warmup_and_measurement_types(self):
        record = sample(4, 140, metrics={BOOT: time(140), BYTES: {"unit": "bytes", "value": 2_000_000},
                                        "drc/small-group": time(10, samples=2)})
        for history in ([], self.history[:2]):
            decisions = perf.compare(record, history, self.rerun)
            self.assertEqual(decisions, {BOOT: {"count": len(history), "status": "warmup"}})
            self.assertEqual(perf.decision_status(decisions), "warmup")
        self.rerun.assert_not_called()

    def test_exactly_twenty_percent_passes(self):
        decisions = perf.compare(sample(4, 120), self.history, self.rerun)
        self.assertEqual(decisions[BOOT]["status"], "pass")
        self.rerun.assert_not_called()

    def test_guarded_by_absolute_resolution_and_prior_spread(self):
        for stable, slow in [([.05, .05, .05], .066), ([80, 100, 120], 140)]:
            history = [sample(i, value) for i, value in enumerate(stable, 1)]
            decisions = perf.compare(sample(4, slow), history, self.rerun)
            self.assertEqual(decisions[BOOT]["status"], "within-noise")
        self.rerun.assert_not_called()

    def test_transient_slowdown_or_shared_runner_noise_passes(self):
        for reference, candidate in [(100, 107), (145, 150)]:
            rerun = Mock(return_value=({BOOT: time(reference)}, {BOOT: time(candidate)}))
            decisions = perf.compare(sample(4, 143), self.history, rerun)
            rerun.assert_called_once_with("startup", sha(2))
            self.assertEqual(decisions[BOOT]["status"], "unconfirmed")
            self.assertEqual(perf.decision_status(decisions), "unconfirmed")

    def test_independent_pair_confirms_slowdown_even_in_faster_time_window(self):
        rerun = Mock(return_value=({BOOT: time(50)}, {BOOT: time(66)}))
        decisions = perf.compare(sample(4, 137), self.history, rerun)
        rerun.assert_called_once_with("startup", sha(2))
        self.assertEqual(decisions[BOOT]["status"], "regression")
        self.assertEqual(decisions[BOOT]["pair"]["adjustedBaseline"], 50)
        self.assertEqual(perf.decision_status(decisions), "fail")

    def test_one_control_can_confirm_multiple_timings_in_a_suite(self):
        other = "startup/paint"
        for row, ms in zip(self.history, [68, 85, 82]):
            row["metrics"][other] = time(ms)
        record = sample(4, 137)
        record["metrics"][other] = time(117)
        rerun = Mock(return_value=({BOOT: time(98), other: time(82)}, {BOOT: time(139), other: time(117)}))
        decisions = perf.compare(record, self.history, rerun)
        rerun.assert_called_once_with("startup", sha(1))
        self.assertTrue(all(row["status"] == "regression" for row in decisions.values()))

    def test_rolling_order_and_duplicate_commits(self):
        good = [sample(i, 105 - i) for i in range(1, 10)]
        # A newer artifact for the same commit replaces the older sample. A measurement
        # excluded after an inconclusive pair cannot raise the future median.
        duplicate = sample(9, 800, measuredAt="2026-11-10T14:02:00+00:00", excluded=[BOOT])
        history = perf.ordered_history(good + [duplicate, sample(20, 1)], [sha(i) for i in range(9, 0, -1)])
        self.assertEqual(len(history), 9)
        self.assertEqual(history[0], duplicate)
        decisions = perf.compare(sample(11, 99), history, self.rerun)
        self.assertEqual(decisions[BOOT]["baseline"], 99)
        self.assertEqual(decisions[BOOT]["count"], 5)

    def test_true_startup_p95_and_static_bytes(self):
        source = {"chrome": {"bootMs": list(range(1, 21)), "heapMB": 3.5},
                  "static": {"eagerJsBytes": 1_008_350, "eagerCssBytes": 170_000, "inlineScriptBytes": 940},
                  "budgets": {"eagerJsBytes": 1_050_000}}
        metrics, _ = benches.measurements("startup", source)
        self.assertEqual(metrics[BOOT], {"unit": "ms", "n": 20, "p50": 10.5, "p95": 19, "max": 20})
        self.assertEqual(metrics[BYTES], {"unit": "bytes", "value": 1_008_350})


class History(unittest.TestCase):
    def test_runner_hardware_runtime_workload_and_schema_changes(self):
        changed = [perf.cohort(b"other seed", "runner", ["hardware", "runtime"], "e" * 64),
                   perf.cohort(b"test key", "another runner", ["hardware", "runtime"], "e" * 64),
                   perf.cohort(b"test key", "runner", ["new hardware", "runtime"], "e" * 64),
                   perf.cohort(b"test key", "runner", ["hardware", "new runtime"], "e" * 64),
                   perf.cohort(b"test key", "runner", ["hardware", "runtime"], "d" * 64)]
        alternate = [sample(i, 1, cohort=key) for i, key in enumerate(changed, 1)]
        stale = sample(6, 1, schema=perf.SCHEMA + 1)
        good = sample(7, 100)
        records = perf.parse_history({"schema": perf.SCHEMA, "records": alternate + [stale, good]})
        self.assertEqual(len(records), len(alternate) + 1)
        self.assertEqual(perf.matching_history(good, records), [good])
        decisions = perf.compare(sample(8, 100), records, Mock(side_effect=AssertionError("foreign history")))
        self.assertEqual(decisions[BOOT], {"count": 1, "status": "warmup"})
        self.assertNotIn("hardware", json.dumps(changed))
        self.assertEqual(perf.parse_history({"schema": perf.SCHEMA + 1, "records": [good]}), [])

    def test_history_rejects_bad_units_regressions_and_dirty_measurements(self):
        bad_row = sample(1, 33, metrics={BOOT: {"unit": "bytes", "p95": 33, "n": 20}})
        wrong_number = sample(2, float("nan"))
        current = sample(3, 40)
        records = perf.parse_history({"schema": perf.SCHEMA, "records": [
            bad_row, wrong_number, sample(4, 50, status="fail"), sample(5, 60, dirty=True), current]})
        self.assertEqual(records, [current])

    def test_clean_runner_restores_available_trusted_ancestor_snapshots(self):
        def run(i, **changes):
            return {"id": i, "head_sha": sha(i), "event": "push", "head_branch": "main",
                    "run_attempt": 1, "conclusion": "success", **changes}

        def bundle(point):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as zip_file:
                zip_file.writestr("history.json", json.dumps({"schema": perf.SCHEMA, "records": [point]}))
            blob = buffer.getvalue()
            return blob, "sha256:" + hashlib.sha256(blob).hexdigest()

        payloads = {1: bundle(sample(1, 100)), 2: bundle(sample(2, 103))}
        calls = []

        def read(path, params=None):
            calls.append((path, params))
            if path == artifacts.WORKFLOW:
                self.assertEqual(params["status"], "success")
                return json.dumps({"workflow_runs": [
                    run(8), run(7, event="pull_request"), run(6, head_branch="feature"),
                    run(5, conclusion="failure"), run(4), run(3), run(2, event="workflow_dispatch"), run(1)]})
            if path.startswith("/runs/"):
                i = int(path.split("/")[2])
                self.assertIn(i, {1, 2, 3, 4})
                return json.dumps({"artifacts": [{"name": params["name"], "id": i,
                                                  "expired": i == 4, "digest": payloads.get(i, (None, ""))[1]}]})
            i = int(path.split("/")[2])
            if i == 3:
                raise HTTPError("https://example.invalid/", 410, "Expired", None, None)
            return payloads[i][0]

        known = [sha(i) for i in range(7, 0, -1)]
        records, archives = artifacts.restore(read, known, "main", 8)
        self.assertEqual(archives, 2)
        self.assertEqual([row["commit"] for row in records], [sha(2), sha(1)])
        self.assertEqual(artifacts.restore(read, [], "main", 8), ([], 0))
        with self.assertRaisesRegex(ValueError, "digest"):
            artifacts.archive_history(payloads[1][0], payloads[2][1])

    def test_artifact_redirect_leaves_the_actions_token_on_the_api_request(self):
        def response(request, timeout):
            self.assertEqual(request.get_header("Authorization"), "Bearer temporary-token")
            redirected = HTTPRedirectHandler().redirect_request(
                request, None, 302, "Found", {}, "https://example.invalid/signed-artifact")
            self.assertIsNone(redirected.get_header("Authorization"))
            return io.BytesIO(b"zip")

        with patch.object(artifacts.urllib.request, "urlopen", side_effect=response):
            self.assertEqual(artifacts.read_api("https://api.example.invalid", "temporary-token", "/archive"),
                             b"zip")

    def test_control_runs_on_a_fresh_checkout_followed_by_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                subprocess.run(["git", "-c", "user.name=Performance Test", "-c", "user.email=perf@example.invalid",
                                *args], cwd=root, check=True, capture_output=True)

            git("init", "-q")
            fixture = root / "fixture"
            fixture.write_text("before")
            git("add", "fixture")
            git("commit", "-qm", "reference")
            reference = perf.git(root, "rev-parse", "HEAD")
            fixture.write_text("after")
            seen = []

            def collect(checkout, chrome, suite):
                seen.append((checkout, (checkout / "fixture").read_text(), chrome, suite))
                return {}, {}

            with patch.object(perf, "ROOT", root), patch.object(perf, "collect", side_effect=collect):
                perf.benchmark_pair("startup", reference, "chrome-executable")
            self.assertEqual([(content, chrome, suite) for _, content, chrome, suite in seen],
                             [("before", "chrome-executable", "startup"), ("after", "chrome-executable", "startup")])
            self.assertFalse(seen[0][0].exists())

    def test_report_warmup_bytes_and_escaped_errors(self):
        record = sample(1, 40, status="warmup", matchingCommits=0, comparison={}, errors=[],
                        workloads={"startup": {"eagerJsBudgetBytes": 1_050_000}})
        document = render(record, [], perf.MIN_HISTORY, perf.BASELINE_WINDOW)
        self.assertIn("No matching history yet.", document)
        self.assertIn("1,008,350 bytes", document)
        self.assertIn("40.00 ms", document)
        failed = dict(record, status="error", errors=["<img>"])
        document = render(failed, [], perf.MIN_HISTORY, perf.BASELINE_WINDOW)
        self.assertIn("&lt;img&gt;", document)
        self.assertNotIn("<img>", document)


if __name__ == "__main__":
    unittest.main()
