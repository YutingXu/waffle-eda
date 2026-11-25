#!/usr/bin/env python3
"""Check palette presentation and editor work budgets for recorded cohorts."""

import argparse
import json
import math
from pathlib import Path


def percentile(ordered, fraction):
    return ordered[math.ceil(fraction * len(ordered)) - 1] if ordered else None


def assess(samples, refresh_hz):
    if type(refresh_hz) not in (int, float) or not math.isfinite(refresh_hz) or refresh_hz <= 0:
        raise ValueError("refreshHz must be a positive, finite rate.")
    if not samples:
        raise ValueError("A cohort must contain at least one input entry.")

    def values(key):
        observed = [sample[key] for sample in samples if sample.get(key) is not None]
        if any(type(ms) not in (int, float) or not math.isfinite(ms) or ms < 0 for ms in observed):
            raise ValueError(f"{key} must be a finite, non-negative duration or null.")
        return sorted(observed)

    presentation = values("presentedMs")
    work = values("waffleWorkMs")
    two = 2000 / refresh_hz
    three = 3000 / refresh_hz
    over_two = sum(ms > two for ms in presentation)
    over_three = sum(ms > three for ms in presentation)
    over_work = sum(ms > 8 for ms in work)
    missing_presentation = len(samples) - len(presentation)
    missing_work = len(samples) - len(work)
    return {
        "inputs": len(samples),
        "twoRefreshesMs": two,
        "threeRefreshesMs": three,
        "presentationP95Ms": percentile(presentation, .95),
        "presentationMaxMs": presentation[-1] if presentation else None,
        "overTwoRefreshes": over_two,
        "overThreeRefreshes": over_three,
        "missingPresentation": missing_presentation,
        "waffleWorkP95Ms": percentile(work, .95),
        "waffleWorkMaxMs": work[-1] if work else None,
        "overWaffleWorkBudget": over_work,
        "missingWaffleWork": missing_work,
        "meetsBudget": not (over_two or over_work or missing_presentation or missing_work),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path, help="JSON source and cohorts with observed refresh rate and per-input timing")
    args = parser.parse_args()
    try:
        receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
        if not receipt["source"] or not receipt["cohorts"]:
            raise ValueError("Specify the measured source and at least one cohort.")
        results = [{"name": cohort["name"], "refreshHz": cohort["refreshHz"],
                    **assess(cohort["samples"], cohort["refreshHz"])}
                   for cohort in receipt["cohorts"]]
    except (KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps({"source": receipt["source"], "cohorts": results}, indent=2))
    return 0 if all(result["meetsBudget"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
