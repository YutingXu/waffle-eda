"""Qualify every table command on CLI and real native stdio."""
import json
from pathlib import Path
import runpy
import sys
import unittest


def main():
    suite = (Path(__file__).resolve().parent / "../automation/mcp-butter-tables.py").resolve()
    sys.path.insert(0, str(suite.parent))
    tests = runpy.run_path(str(suite))
    case = tests["TablesMCP"]("test_all_through_an_actual_native_folder")
    case.acceptance = True
    result = unittest.TextTestRunner().run(unittest.TestSuite([case]))
    if not result.wasSuccessful() or set(case.coverage) != set(tests["COMMAND_KINDS"]):
        return 1
    print("BUTTER_COMMAND_COVERAGE " + json.dumps(case.coverage,sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
