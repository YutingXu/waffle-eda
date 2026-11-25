"use strict";

// Review-only integration with task 37's actual widget and Waffle's current
// Comments/Undo APIs. Pass its checkout until the shared widget owner lands.
const assert = require("node:assert/strict");
const path = require("node:path");
for (const name of ["model", "review-comments", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
require(path.resolve(process.argv[2] || path.join(__dirname, "../.."), "app/notebook/sheet-widgets.js"));

const widgets = AtriumSheetWidgets, comments = AtriumReviewComments, undo = AtriumUndoStore;
const project = Atrium.project("Review"), sheet = Atrium.sheet("schematic", "Sheet");
project.documents = [sheet];
const checklist = widgets.make("todo", [5, 10], {argument: "Review the connector"});
sheet.items.push(checklist);
const row = checklist.widget.state.rows[0];
const thread = comments.add(project, {doc: sheet.id, text: row.text, anchor: {kind: "point", at: [5, 10]},
  author: "Reviewer", now: "2026-01-02T00:00:00Z"});
comments.reply(project, thread.id, {text: "Check the orientation.", author: "Reviewer"});
row.threadId = thread.id; row.assignee = "Reviewer"; row.due = "2026-12-10";
const rowBefore = JSON.stringify(row), status = () => widgets.view(project, sheet, checklist).rows[0].checked;
assert.equal(status(), false); undo.reset(); undo.record(project);
const history = [], future = [];
undo.checkpoint(history, future, undo.mark(project), "Resolve review");
widgets.setDone(project, checklist, row.id, true, {author: "Reviewer"}); undo.record(project);
assert.equal(status(), true); assert.equal(comments.thread(project, thread.id).status, "resolved");
assert.equal(JSON.stringify(row), rowBefore, "resolution only edits the Review thread");
undo.jump(history, future, undo.mark(project), -1); undo.record(project);
assert.equal(status(), false);
undo.jump(history, future, undo.mark(project), 1); undo.record(project);
assert.equal(status(), true);
comments.setStatus(project, thread.id, "open"); assert.equal(status(), false);
assert.equal(comments.thread(project, thread.id).replies.length, 1);
comments.remove(project, thread.id);
assert.equal(status(), null); assert.throws(() => widgets.setDone(project, checklist, row.id, true), /unavailable/);
assert.equal(JSON.stringify(row), rowBefore);
undo.reset();
console.log("PASS shared Review resolution, reopen, Undo, Redo, missing thread, assignment, due date and reply");
