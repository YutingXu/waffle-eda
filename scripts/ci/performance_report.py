"""Render a self-contained report from a measurement and its comparable history."""

from datetime import datetime
from html import escape
from pathlib import Path
from string import Template

TEMPLATE = Path(__file__).with_name("performance-report.html")
HIGHLIGHTS = {
    "pour/editToScreen": ("Copper pour", "Edit to repoured copper on screen"),
    "schematic/sheetSwitchWarm": ("Schematic", "Warm switch in a 100-sheet project"),
    "routing/push +clicks": ("Interactive routing", "Push routing with clicks"),
    "diff/firstPaint": ("Visual diff", "Both PCB revisions painted"),
    "startup/boot": ("Startup", "Fresh Chrome session"),
    "drc/dense-netted/nudge part 0.1/online": ("Online DRC", "Part nudge on the 25.6k-object PCB"),
    "clearance/fullClearance": ("Clearance check", "Full pass on the same PCB"),
    "erc/live": ("Live ERC", "Wire edit on the PiDP-11 schematic"),
}
STATUS = {
    "pass": "Within the threshold",
    "warmup": "Baseline warm-up",
    "unconfirmed": "Paired check passed",
    "fail": "Performance regression",
    "error": "Benchmark run incomplete",
}
METRIC_STATUS = {
    "pass": "Within threshold",
    "warmup": "Warming up",
    "within-noise": "Within noise guard",
    "unconfirmed": "Passed fresh pair",
    "regression": "Regression confirmed",
}


def ms(value):
    return "—" if value is None else f"{value:,.2f} ms"


def delta(decision):
    return f"{decision['deltaPct']:+.1f}%" if "deltaPct" in decision else "—"


def bars(name, current, history):
    samples = [old["metrics"].get(name, {}).get("p95") for old in reversed(history[:9])]
    samples = [sample for sample in samples if sample is not None]
    if current is None:
        return "—"
    samples.append(current)
    high = max(samples) or 1
    description = "Oldest to newest, " + ", ".join(ms(sample) for sample in samples)
    marks = "".join(f'<i style="height:{100 * sample / high:.1f}%"></i>' for sample in samples)
    return f'<span class="bars" role="img" aria-label="{escape(description)}">{marks}</span>'


def render(record, history, minimum, window):
    status = record["status"]
    metrics = record["metrics"]
    comparison = record["comparison"]
    when = datetime.fromisoformat(record["measuredAt"]).strftime("%d %b %Y, %H:%M UTC")
    metadata = f'{when} · <code>{escape(record["commit"][:10])}</code>'
    if record.get("dirty"):
        metadata += " · Local edits included"
    earlier = record["matchingCommits"]
    descriptions = {
        "pass": "The comparable p95 timings stayed within the regression threshold.",
        "warmup": f"{earlier} earlier matching commits. The check needs {minimum} qualifying commits per timing.",
        "unconfirmed": "The fresh pair stayed within the regression threshold.",
        "fail": "A fresh pair confirmed a p95 increase above 20%. See All measurements for the affected timings.",
        "error": "Some measurements could not be completed. Available results appear below.",
    }
    if status == "warmup" and not history:
        descriptions["warmup"] = f"No matching history yet. This run starts the baseline. The check needs {minimum} earlier commits."
    errors = ("<ul>" + "".join(f"<li>{escape(error)}</li>" for error in record["errors"]) + "</ul>"
              if record["errors"] else "")
    rows = []
    for name, (label, fixture) in HIGHLIGHTS.items():
        measurement = metrics.get(name, {})
        decision = comparison.get(name, {})
        rows.append(
            f'<tr><th scope="row">{escape(label)}<span class="fixture">{escape(fixture)}</span></th>'
            f'<td class="number current">{ms(measurement.get("p95"))}</td>'
            f'<td class="number">{ms(decision.get("baseline"))}</td>'
            f'<td class="number {decision.get("status", "")}">{delta(decision)}</td>'
            f'<td>{bars(name, measurement.get("p95"), history)}</td></tr>'
        )
    details = []
    for name, measure in sorted(metrics.items()):
        decision = comparison.get(name, {})
        if "p95" in measure:
            current = f'{ms(measure["p95"])} p95 · {measure["n"]} samples'
            verdict = METRIC_STATUS.get(decision.get("status"), "Recorded")
        else:
            current = f'{measure["value"]:,} {measure["unit"]}'
            verdict = "Recorded"
        pair = decision.get("pair")
        if pair and pair["candidateP95"] is not None and pair["controlP95"] is not None:
            verdict += f' · {ms(pair["candidateP95"])} vs {ms(pair["controlP95"])}'
        details.append(
            f'<tr><th scope="row">{escape(name.replace("/", " / "))}</th>'
            f'<td class="number">{current}</td><td class="number">{ms(decision.get("baseline"))}</td>'
            f'<td class="number {decision.get("status", "")}">{delta(decision)}</td>'
            f'<td>{escape(verdict)}</td></tr>'
        )
    size = metrics.get("startup/eagerJsBytes", {}).get("value")
    budget = record["workloads"].get("startup", {}).get("eagerJsBudgetBytes")
    return Template(TEMPLATE.read_text(encoding="utf-8")).substitute(
        metadata=metadata, status=status, verdict=STATUS[status], description=descriptions[status],
        errors=errors, window=window, trend_header="Recent commits" if history else "This commit",
        rows="".join(rows), size=f"{size:,} bytes" if size is not None else "—",
        size_budget=f"{budget:,} byte budget" if budget is not None else "",
        count=len(metrics), details="".join(details),
    )
