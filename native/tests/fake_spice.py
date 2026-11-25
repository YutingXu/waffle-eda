#!/usr/bin/env python3
"""Generate synthetic raw/log output for the connector tests. No simulator or vendor files."""
import json
from pathlib import Path
import re
import struct
import sys


def simulate(args):
    ng = "-r" in args
    assert args == (["-n", "-b", "-r", "deck.raw", "deck.cir"] if ng else ["-b", "deck.cir"])
    lines = Path("deck.cir").read_text().splitlines()
    assert lines[-1] == ".end" and len(list(Path.cwd().iterdir())) == 1
    drive = next(line for line in lines if line.startswith("VJ1 VIN 0 DC "))
    voltage = float(drive.split()[4])
    if voltage < 0:
        # ngspice identifies a deck line. LTspice identifies a generated instance name and
        # can exit successfully despite reporting a failure in its UTF-16 log.
        if ng:
            print("Error on line %d: invalid source" % (1 + lines.index(drive)), file=sys.stderr)
            return 1
        Path("deck.log").write_bytes("Fatal Error: Invalid voltage in VJ1\r\n".encode("utf-16le"))
        return 0

    card = next(line for line in lines if re.match(r"^\.(op|tran|dc|ac)\b", line)).split()
    ac = card[0] == ".ac"
    plots = {".op": "Operating Point", ".tran": "Transient Analysis", ".dc": "DC transfer characteristic", ".ac": "AC Analysis"}
    columns = [("v(vin)", "voltage"), ("v(filter)", "voltage"), ("vj1#branch" if ng else "I(VJ1)", "current")]
    if card[0] == ".op":
        points = [[voltage, voltage / 2, -0.001]]
    else:
        scale = {".ac": ("frequency", "frequency"), ".tran": ("time", "time"), ".dc": ("v(v-sweep)", "voltage")}
        columns.insert(0, scale[card[0]])
        points = [[1, 1, 0.5, 0], [2, 2, 1, -0.001]]
    ascii_values = ng and card[0] == ".op"
    header = ["Title: Synthetic bench", "Plotname: " + plots[card[0]], "Flags: " + ("complex" if ac else "real"),
              "No. Variables: %d" % len(columns), "No. Points: %d" % len(points), "Variables:"]
    header.extend("\t%d\t%s\t%s" % (i, name, kind) for i, (name, kind) in enumerate(columns))
    header.append("Values:" if ascii_values else "Binary:")
    content = ("\r\n".join(header) + "\r\n").encode("ascii" if ng else "utf-16le")
    for row, values in enumerate(points):
        if ascii_values:
            content += ("%d\t" % row + "\n\t".join(str(v) for v in values) + "\n").encode("ascii")
        else:
            for i, v in enumerate(values):
                if ac:
                    content += struct.pack("<dd", v, -v if i == 2 else 0)
                elif ng or card[0] == ".op" or not i:
                    content += struct.pack("<d", v)
                else:
                    content += struct.pack("<f", v)
    Path("deck.raw").write_bytes(content)
    if not ng:
        Path("deck.log").write_bytes("Simulation completed.\r\n".encode("utf-16le"))
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--bridge"]:
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import external_tools

        checked = external_tools.check_run(json.load(sys.stdin))
        print(json.dumps(external_tools.Runner().run(str(Path(__file__).resolve()), checked)))
    else:
        sys.exit(simulate(sys.argv[1:]))
