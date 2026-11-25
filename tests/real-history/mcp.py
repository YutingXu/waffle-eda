"""Check source History's measured worker results against the public MCP tool, page by page."""
import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))
from server import Server


def compare(design, expected_rows):
    server = Server(design)
    offset, token, checked, nonzero, differences = 0, {}, 0, 0, []
    try:
        while True:
            page = server.call("project_history", {"limit": 20, "offset": offset, **token})
            for row in page["commits"]:
                expected = expected_rows[checked]
                details = row["untrusted_design_text"]
                areas = details.get("regions", [])
                first = areas[0] if areas else {}
                actual = {"counts": row.get("counts"), "total": row.get("total"), "regions": len(areas)}
                for side in ("before", "after"):
                    tile = first.get(side) or {}
                    actual[side + "Ink"] = any(tile.values())
                    actual[side + "ChangedInk"] = bool(tile.get("changed"))
                if "revision" in expected:
                    actual["revision"] = row["revision"]
                    actual["summary"] = details.get("summary")
                fields = [field for field, value in actual.items() if field in expected and value != expected[field]]
                if "summary_error" in details or "error" in expected:
                    fields.append("source read")
                checked += 1
                nonzero += bool(row.get("total"))
                if fields:
                    # Anonymous ordinals and field names are sufficient to repeat a discrepancy locally.
                    differences.append({"row": checked, "fields": fields})
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
            token = {"snapshot": page["snapshot"]}
    finally:
        server.close()
    if checked != len(expected_rows):
        raise ValueError("Public API traversal returned a different number of history rows.")
    return {"rows": checked, "nonzero": nonzero, "differences": differences}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("design", type=Path)
    parser.add_argument("worker_results", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    expected = [json.loads(line) for line in args.worker_results.read_text().splitlines()]
    result = compare(args.design, expected)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"{result['rows']} rows, {len(result['differences'])} differences")
    sys.exit(bool(result["differences"]))
