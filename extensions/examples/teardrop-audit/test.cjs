"use strict";
// Teardrop Audit, in the extension sandbox (see ../harness.cjs).
const harness = require("../harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  const id = "atrium-samples.teardrop-audit", group = "Teardrop Audit (extension)";
  await X.install(h.files(dir));
  assert.deepEqual(X.permissions(id).declared, ["read:project", "ui:command"], "read-only: no edit permission at all");

  h.open("pcb");
  const before = JSON.stringify(h.project);
  const first = await X.execute("teardropAudit.run");
  assert.equal(JSON.stringify(h.project), before, "the audit never edits the board");
  assert.ok(first.ends > 0 && first.missing === first.ends && first.stale === 0, "a board without teardrops: every land is reported " + JSON.stringify(first));
  let rows = h.reported(group);
  assert.equal(rows.filter(m => m.class === "Warning").length, first.missing, "each finding is a Warning row in Messages");
  assert.ok(rows.every(m => m.source === "Teardrop Audit (extension)" && m.group === group), "rows are labelled with the extension, never as an editor check");
  const warn = rows.find(m => m.class === "Warning");
  assert.ok(h.board().items.some(i => i.id === warn.objectId) && Array.isArray(warn.point), "rows locate the track end");
  assert.match(h.messages.at(-1), /teardrop issue/, "a summary goes to the status bar");

  // Add a teardrop for one track end (the shape the Teardrops tool makes), and leave a stale one.
  const track = h.board().items.find(i => i.id === warn.objectId), end = warn.point;
  const via = h.board().items.find(i => i.kind === "via" && Math.hypot(i.x - end[0], i.y - end[1]) < 1e-6);
  let anchor = via?.id;
  for (const p of via ? [] : h.board().items.filter(i => i.kind === "part")) {
    const pins = (await X.runScript("return await api.parts.pins(args)", {args: p.id})).value;
    const pin = pins.find(q => Math.hypot(q.x - end[0], q.y - end[1]) <= Math.min(q.w, q.h) / 2 + 1e-6);
    if (pin) { anchor = p.id + ":" + pin.number; break; }
  }
  assert.ok(anchor, "the reported end sits on a pad or via");
  const drop = (trackId, anchorId) => ({id: "td-" + trackId + "-" + anchorId.replace(/\W/g, ""), kind: "graphic", points: [[end[0], end[1]], [end[0] + .3, end[1]], [end[0], end[1] + .3]],
    closed: true, fill: true, width: 0, layer: track.layer, net: track.net, teardrop: true, teardropTrack: trackId, teardropAnchor: anchorId, groupId: "teardrop:" + anchorId});
  h.host.edit(() => h.board().items.push(drop(track.id, anchor), drop("gone-track", anchor)));
  const second = await X.execute("teardropAudit.run");
  assert.equal(second.missing, first.missing - 1, "a matching teardrop clears that finding");
  assert.equal(second.stale, 1, "a teardrop whose track was deleted is reported");
  rows = h.reported(group);
  assert.equal(rows.filter(m => /left behind/.test(m.text)).length, 1, "the panel group is replaced on each run, not appended");

  // The command is offered on boards only ("when": "pcb").
  h.open("schematic");
  assert.equal(await X.execute("teardropAudit.run"), undefined);
  assert.match(h.messages.at(-1), /not available here/);
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
