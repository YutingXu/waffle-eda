// The shipped sample ("Sensor interface", AtriumParts.example) passes its own design rule check:
// 0 errors and 0 warnings with the board's rules, including the Waffle extra checks the DRC
// command adds (Missing Courtyard, Net Antennae). A first DRC on the example must not show an
// error.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "connectivity", "net-ties", "rules", "drc", "drc-fixes"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const R = AtriumRules, p = AtriumParts.example(), board = p.documents.find(d => d.kind === "pcb");
const defs = new Map(p.library.map(d => [d.id, d]));
const rules = R.stored(board, p) || R.defaults();
const result = AtriumDRCFixes.augment(R.drc(board, defs, rules, {}), board, defs);
const rows = result.violations.map(v => (v.warning ? "warning " : "error ") + v.type + ": " + (v.title || v.id));
assert.deepEqual(rows, [], "sample DRC:\n" + rows.join("\n"));
// Every placed sample footprint has a courtyard, and U1's pin-1 dot clears the pad's mask opening.
for (const part of board.items.filter(i => i.kind === "part")) assert.ok(AtriumDRCFixes.hasCourtyard(defs.get(part.def).footprint), part.ref + " has a courtyard");
assert.ok(result.rules.some(r => r.type === "silkToMask" && r.count === 0));
console.log("PASS sample board DRC: 0 violations over " + result.rules.length + " rules");
