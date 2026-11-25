"use strict";
// Keep the file associations, save defaults, UI copy and on-disk project stamp in agreement.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "../.."), read = file => fs.readFileSync(path.join(root, file), "utf8");
for (const mod of ["i18n","model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "obsolete-project","io","io-browser","parts","folder-project-ui"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));

globalThis.__testDone = (async () => {
  const project = Atrium.project("Sensor");
  const converted = AtriumFormat2Model.fromEditor(project);
  const bytes = AtriumFormat2.serialize(converted.manifest);
  assert.equal(converted.manifestPath, "Sensor.waffle");
  assert.equal(AtriumFormat2Model.parse(bytes,{kind:"project"}).header.formatVersion, "2.0");
  const obsolete = new TextEncoder().encode('{"format":"atrium","formatVersion":"1.5","documents":[]}');
  for (const name of ["Board.waffle", "OLD.ATRIUM"])
    assert.throws(() => AtriumIO.read(name,obsolete), /re-import the design from its source EDA/);
  let choice, picked;
  globalThis.AtriumHost = {
    chooseProjectFolder(options) { choice = options; return null; },
    pickFile(exts) { picked = exts; }
  };
  const fileSession = {};
  const editor = {revision:()=>0, fileSession:()=>fileSession};
  const context = {session:()=>null, project:()=>project, host:()=>editor, current:()=>project.documents[0].id};
  assert.equal(await AtriumFolderProjectUI.create(context),false,"cancel leaves the new design alone");
  assert.deepEqual(choice,{mode:"create",name:"Sensor.waffle"});
  await AtriumIO.pickFile([".waffle"]);
  assert.deepEqual(picked,[".waffle"]);

  const board = AtriumParts.example().documents.find(doc => doc.kind === "pcb");
  assert.ok(board.items.some(item => item.layer === "Silk" && item.text === "WAFFLE"));
  const ui = read("app/index.html");
  assert.match(ui, /<title>Waffle<\/title>/);
  const accept = /id="file-input"[^>]+accept="([^"]+)"/.exec(ui)[1].split(",");
  assert.ok(accept.includes(".waffle") && !accept.includes(".atrium"));
  const mac = read("native/macos/Info.plist"), linux = read("native/linux/desktop/org.waffle.editor.xml");
  const windows = read("native/windows/packaging/AppxManifest.xml");
  for (const [descriptor, extension] of [[mac, ext=>"<string>"+ext+"</string>"],
    [linux, ext=>'pattern="*.'+ext+'"'], [windows, ext=>"<uap:FileType>."+ext+"</uap:FileType>"]]) {
    assert.ok(descriptor.includes(extension("waffle")));
    assert.ok(!descriptor.includes(extension("atrium")));
  }
  assert.ok(mac.includes("<string>org.waffle.editor</string>"));
  assert.ok(windows.includes('Identity Name="Waffle.Editor"'));
  for (const file of ["app/index.html", "app/locales/en.json", "README.md", "mcp/README.md",
    "docs/extension-api.md", "integrations/vscode/package.json", "native/macos/installer-background.html"]) {
    assert.doesNotMatch(read(file), /\bAtrium\b(?!\.)/, "old display name in " + file);
  }
  console.log("Waffle identity, 2.0 manifest and folder-picker defaults passed");
})();
