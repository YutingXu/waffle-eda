"""Pinned format-baseline cohort table for preparation, archive, and sidecar QA."""
import csv
from pathlib import Path

def input_rows(table):
    with Path(table).open(encoding="utf-8") as stream:
        return list(csv.DictReader(stream, delimiter="\t"))


def input_table(table):
    return {row["case"]:row for row in input_rows(table)}


def first_matching_row(case, table):
    return next(row for row in input_rows(table) if row["case"]==case)
