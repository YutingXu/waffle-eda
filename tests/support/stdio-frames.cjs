"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {readFrame, writeExact} = require("../../mcp/pipe-frames.js");

const root = path.resolve(__dirname, "../..");
const probe = ["😀", "", "café"];
const sibling = ["alpha", "", "beta"];
const probeHex = "040000000000000005000000f09f9880636166c3a9";

function encode(parts) {
  assert.equal(parts.length, 3);
  const bodies = parts.map(part => Buffer.from(part, "utf8"));
  const header = Buffer.alloc(12);
  bodies.forEach((body, index) => header.writeUInt32LE(body.length, index * 4));
  return Buffer.concat([header, ...bodies]);
}

function withStream(stream, chunk, run) {
  const savedRead = fs.readSync;
  let pos = 0;
  const reads = [];
  fs.readSync = function(fd, buffer, offset, length) {
    assert.equal(arguments.length, 4);
    assert.equal(fd, 0);
    if (pos >= stream.length || length === 0) return 0;
    const count = Math.min(length, chunk, stream.length - pos);
    stream.copy(buffer, offset, pos, pos + count);
    pos += count;
    reads.push(count);
    return count;
  };
  try {
    return {value: run(), reads};
  } finally {
    fs.readSync = savedRead;
  }
}

assert.equal(Buffer.byteLength(probe[0], "utf8"), 4);
assert.equal(Buffer.byteLength(probe[2], "utf8"), 5);
assert.equal(encode(probe).toString("hex"), probeHex);
assert.equal(encode(sibling).toString("hex"), "050000000000000004000000616c70686162657461");

for (const parts of [probe, sibling, ["alpha", "beta", "gamma"], ["", "beta", ""], ["", "", ""]]) {
  const wire = encode(parts);
  for (const chunk of [1, 5, 7]) {
    const {value, reads} = withStream(wire, chunk, () => readFrame());
    assert.deepEqual(value.slots, parts);
    assert.deepEqual(value.lengths, parts.map(part => Buffer.byteLength(part, "utf8")));
    assert.equal(value.large, false);
    assert.ok(reads.length > 1, "header was not split");
    assert.ok(reads.every(count => count <= chunk));
  }
}

assert.equal(withStream(Buffer.alloc(0), 1, () => readFrame()).value, null);
const blank = withStream(Buffer.alloc(12), 1, () => readFrame()).value;
assert.deepEqual(blank.slots, ["", "", ""]);
assert.equal(blank.large, false);

const shortHeader = probeHex.slice(0, 14);
assert.throws(() => withStream(Buffer.from(shortHeader, "hex"), 5, () => readFrame()), /Incomplete request\./);
const shortBody = Buffer.concat([encode(probe).subarray(0, 14), Buffer.from("xx")]);
assert.throws(() => withStream(shortBody, 7, () => readFrame()), /Incomplete request\./);
assert.throws(
  () => withStream(Buffer.from(shortHeader, "hex"), 3, () => readFrame("Incomplete design inspection request.")),
  /Incomplete design inspection request\./
);

const savedWrite = fs.writeSync;
const written = [];
fs.writeSync = function(fd, buffer, offset, length) {
  assert.equal(arguments.length, 4);
  assert.equal(fd, 1);
  const count = Math.min(length, 1);
  written.push(Buffer.from(buffer.subarray(offset, offset + count)));
  return count;
};
try {
  writeExact("😀-café");
  writeExact(Buffer.from("c3a9", "hex"));
} finally {
  fs.writeSync = savedWrite;
}
assert.equal(Buffer.concat(written).toString("hex"), Buffer.from("😀-café", "utf8").toString("hex") + "c3a9");

const boundary = 1048576;
for (const size of [boundary - 1, boundary]) {
  const wire = Buffer.alloc(12 + size);
  wire.writeUInt32LE(size, 4);
  const frame = withStream(wire, size, () => readFrame()).value;
  assert.equal(frame.large, size >= boundary);
  assert.equal(frame.slots[1].length, size);
}

const python = spawnSync("python3", ["-I", "-B", "-c", `
import json, struct, sys
from io import BytesIO
sys.path.insert(0, sys.argv[1])
from board_runner import _frame_header, _frames

def wire(parts):
    bodies = [part.encode("utf-8") for part in parts]
    packed = _frames(bodies)
    lengths = list(_frame_header(stream=BytesIO(packed)))
    assert lengths == [len(body) for body in bodies] + [0] * (3 - len(bodies))
    assert packed == struct.pack("<3I", *lengths) + b"".join(bodies)
    return packed.hex()

class Huge:
    def __len__(self):
        return 0x100000000

report = {
    "probe": wire(["😀", "", "café"]),
    "sibling": wire(["alpha", "", "beta"]),
    "tail": wire(["alpha"]),
    "empty": _frames([]).hex(),
}
try:
    _frame_header(stream=BytesIO(b"1234567"))
    raise SystemExit("truncated header was accepted")
except struct.error:
    pass
for packer in (_frame_header, _frames):
    try:
        packer([Huge()])
        raise SystemExit("oversized slot was accepted")
    except ValueError as error:
        if "JavaScript runtime input size" not in str(error):
            raise
json.dump(report, sys.stdout)
`, path.join(root, "mcp")], {encoding: "utf8"});
assert.equal(python.status, 0, python.stderr);
const packed = JSON.parse(python.stdout);
assert.equal(packed.probe, probeHex);
assert.equal(packed.sibling, encode(sibling).toString("hex"));
assert.equal(packed.tail, "050000000000000000000000616c706861");
assert.equal(packed.empty, "000000000000000000000000");
const tail = withStream(Buffer.from(packed.tail, "hex"), 5, () => readFrame()).value;
assert.deepEqual(tail.slots, ["alpha", "", ""]);

function boardRequest(input) {
  return spawnSync(process.execPath, [path.join(root, "mcp/board-runner.js"), "--stdio"], {
    input, encoding: "utf8", timeout: 10000,
  });
}
const incomplete = boardRequest(Buffer.alloc(4));
assert.equal(incomplete.status, 1);
assert.equal(incomplete.stderr, "Incomplete design inspection request.");
require("../../app/core/model.js");
const boardRequestText = JSON.stringify({tool: "load_git_comparison", identical: true});
const documentText = JSON.stringify(Atrium.project("Protocol fixture"));
const compacted = boardRequest(encode([boardRequestText, "", documentText]));
assert.equal(compacted.status, 0, compacted.stderr);
assert.deepEqual(JSON.parse(compacted.stdout), {result: null});

function headlessArgs(second, third) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br03-echo-"));
  const echo = path.join(dir, "echo.js");
  fs.writeFileSync(echo, "globalThis.Echo = (...args) => JSON.stringify(args);\n");
  const request = JSON.stringify({modules: [echo], entry: "Echo"});
  const result = spawnSync(process.execPath, [path.join(root, "mcp/headless.js")], {
    input: encode([request, second, third]),
    cwd: root,
    timeout: 10000,
  });
  fs.rmSync(dir, {recursive: true, force: true});
  assert.equal(result.status, 0, result.stderr.toString());
  const line = result.stdout.toString("utf8").trim();
  return JSON.parse(JSON.parse(line).text);
}
const requestOf = args => JSON.parse(args[0]);
const kept = headlessArgs("", "beta");
assert.equal(requestOf(kept).entry, "Echo");
assert.deepEqual(kept.slice(1), ["", "beta"]);
assert.deepEqual(headlessArgs("alpha", "").slice(1), ["alpha"]);
assert.deepEqual(headlessArgs("", "").slice(1), []);
assert.deepEqual(headlessArgs("alpha", "beta").slice(1), ["alpha", "beta"]);
assert.deepEqual(headlessArgs("😀", "café").slice(1), ["😀", "café"]);

console.log("Three-slot stdio frames keep split headers, empty slots, non-ASCII bytes, and reject truncated frames.");
