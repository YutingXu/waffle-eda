"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
for (const name of ["model", "source-file", "design-query-record", "format-2-codec", "format-2-units", "format-2-values",
  "format-2-model", "format-2-closure", "import-sidecars", "obsolete-project", "zip", "project-archive"])
  require(require("./app-source-paths.cjs").appFile(name + ".js"));

async function projectZIP(project, options) {
  const stored = AtriumFormat2Model.fromEditor(project, options);
  const files = new Map(stored.files.map(({path,file}) => [path,AtriumFormat2.serialize(file)]));
  for (const {path,bytes} of [...stored.assets,...stored.models]) files.set(path,bytes);
  files.set(AtriumImportSidecars.IGNORE, AtriumImportSidecars.ignoreText);
  const read = path => files.get(path);
  const verified = await AtriumProjectArchive.verifyClosure({manifestPath:stored.manifestPath,read});
  const {name,bytes} = await AtriumProjectArchive.archive({...verified,read});
  return {name,mimeType:"application/zip",buffer:Buffer.from(bytes)};
}

async function openProjectZIP(page, file) {
  await page.locator("#file-input").setInputFiles(file);
  await page.getByRole("dialog",{name:"Open project ZIP",exact:true})
    .getByRole("button",{name:"Open project",exact:true}).click();
}

async function saveFirstProjectZIP(page) {
  await page.getByRole("button",{name:"Save",exact:true}).click();
  await page.getByRole("dialog",{name:/^Save “.*” as a Waffle project\?$/})
    .getByRole("button",{name:"Save as Waffle Project…",exact:true}).click();
  const portable = page.getByRole("button",{name:"Download Format 2 ZIP",exact:true});
  await portable.waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"),portable.click()]);
  const name = download.suggestedFilename();
  assert.match(name,/\.zip$/);
  assert.equal(await download.failure(),null);
  return {name,mimeType:"application/zip",buffer:await fs.readFile(await download.path())};
}

async function readProjectZIP(bytes) {
  const archive = AtriumProjectArchive.zipDirectory(bytes), projects = await archive.projects();
  assert.equal(projects.length,1,"the download contains one Format 2 project");
  const {manifest,files} = await AtriumProjectArchive.extract(archive,projects[0],AtriumProjectArchive.verifyClosure);
  return {manifest:AtriumFormat2Model.parse(files.get(manifest)),files};
}

module.exports = {projectZIP,openProjectZIP,saveFirstProjectZIP,readProjectZIP};
