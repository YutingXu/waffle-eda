"use strict";
// Regeneration tool for make-corpus.py. The source and all frozen revisions are native 2.0.
const fs = require("node:fs"), path = require("node:path");
const {nativeCAD} = require("../../support/native-cad.cjs");
if (process.argv[2] === "--base") {
  process.stdout.write(JSON.stringify(nativeCAD("design-diff")));
} else {
  require("../../../app/project/revisions.js");
  const {base, cases} = JSON.parse(fs.readFileSync(0, "utf8"));
  let revisions = [], revisionStore = {};
  for (const [index, {name, project}] of cases.entries()) {
    project.revisions = revisions;
    project.revisionStore = revisionStore;
    delete project.revision;
    Atrium.withRevisionIds("8".repeat(64), () => AtriumRevisions.freeze(project, {
      letter: AtriumRevisions.letterAt(index), date: "2026-01-01", time: index+1, notes: name
    }));
    project.revisions[project.revisions.length-1].id = "case-" + name;
    revisions = project.revisions;
    revisionStore = project.revisionStore;
  }
  const snapshot = AtriumFormat2Model.fromEditor({...base, revisions, revisionStore}, {
    projectId: "design-diff", manifestPath: "Project.waffle"
  });
  const directory = path.join(__dirname, "..", "cad-native", "design-diff");
  function write(file, bytes) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.writeFileSync(destination, bytes);
  }
  for (const {path:file, file:record} of snapshot.files) write(file,AtriumFormat2.serialize(record));
  for (const asset of snapshot.assets) write(asset.path,asset.bytes);
}
