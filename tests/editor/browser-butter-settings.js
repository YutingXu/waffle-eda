"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {runInNewContext} = require("node:vm");
const proof = require("../fixtures/design-query/butter-search.json");

// Use the Preferences file picker and download in a disposable native project.
module.exports = async function settingsOptIn(page, requested, root, menuAction) {
  const automation = path.join(root,"app","automation");
  const descriptorRoot = path.join(automation,"descriptors");
  const descriptors = fs.readdirSync(descriptorRoot).filter(name=>name.endsWith(".json"))
    .map(name=>JSON.parse(fs.readFileSync(path.join(descriptorRoot,name),"utf8")));
  const catalogue = {};
  runInNewContext(fs.readFileSync(path.join(automation,"command-catalog.js"),"utf8"),catalogue);
  const flags = descriptors.map(({feature})=>`butter.${feature}`);
  const engineIds = descriptors.flatMap(({feature,commands})=>commands
    .filter(spec=>!spec.surfaces || spec.surfaces.includes("editor")).map(spec=>`butter.${feature}.${spec.id}`)).sort();
  const editorActionIds = descriptors.flatMap(({feature,editorActions = []})=>editorActions.map(s=>`butter.${feature}.${s.id}`));
  const expected = [...engineIds, ...editorActionIds].sort();
  const handler = feature => path.basename(catalogue.AtriumButterCatalog[feature].editorHandler);
  const butterAssets = new Set([
    "command-broker.js", "command-catalog.js", "editor-command-host.js", ...descriptors.map(({feature})=>handler(feature)),
    "ai-ui.js", "links-ui.js", "macros-ui.js", "query-service.js", "query-ui.js",
    "window-commands-ui.js", "workspace-tools.js", "workspace-tools.css"
  ]);
  const featureAssets = () => requested.filter(name=>butterAssets.has(name));
  const commandIds = () => page.evaluate(()=>AtriumKeymap.commands().filter(c=>c.id.startsWith("butter.")).map(c=>c.id).sort());
  const prefs = page.getByRole("dialog",{name:"Preferences",exact:true});
  const exportButton = prefs.getByRole("button",{name:"Export all settings…",exact:true});
  async function openSettings() {
    await menuAction(page,"file","Preferences…");
    await exportButton.waitFor();
  }
  async function exportBundle() {
    const downloaded = page.waitForEvent("download");
    await exportButton.click();
    const file = await downloaded;
    assert.equal(file.suggestedFilename(),"waffle-settings.json");
    return JSON.parse(fs.readFileSync(await file.path(),"utf8"));
  }
  async function importFlags(bundle, value) {
    bundle.prefs = {...bundle.prefs,...Object.fromEntries(flags.map(flag=>[flag,value]))};
    const chooser = page.waitForEvent("filechooser");
    await prefs.getByRole("button",{name:"Import all settings…",exact:true}).click();
    await (await chooser).setFiles({name:"butter-settings.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(bundle))});
    await page.waitForFunction(({flags,value})=>flags.every(flag=>AtriumPrefs.get(flag)===value),{flags,value});
  }
  async function reloadProject() {
    await page.reload();
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await menuAction(page,"file","Open…");
    await page.waitForFunction(()=>AtriumNavHost.folderProject()?.hasPresented("analog"));
  }

  assert.deepEqual(await commandIds(),[]);
  assert.deepEqual(featureAssets(),[]);
  const control = await page.evaluate(()=>{
    const host=AtriumNavHost, name=host.doc().name;
    host.edit(()=>{host.doc().name+=" QA";},"Change document name");
    return {shortcut:AtriumKeymap.mac?"Meta+z":"Control+z",name};
  });
  await page.keyboard.press(control.shortcut);
  await page.waitForFunction(name=>AtriumNavHost.doc().name===name,control.name);
  await openSettings();
  const initial = await exportBundle();
  assert.ok(flags.every(flag=>initial.prefs[flag]!==true));
  assert.deepEqual(featureAssets(),[],"exporting Settings leaves Butter cold");
  await importFlags(initial,true);
  await page.waitForFunction(ids=>ids.every(id=>AtriumKeymap.command(id)),expected);
  assert.deepEqual(await commandIds(),expected);
  assert.deepEqual(await page.evaluate(()=>AtriumButter.list("editor").map(c=>c.id).sort()),engineIds,
    "editor views stay outside the automation command list");
  await reloadProject();
  await page.waitForFunction(ids=>ids.every(id=>AtriumKeymap.command(id)),expected);
  const query = await page.evaluate(async args=>{
    const host=AtriumNavHost, before=host.revision();
    const run=input=>AtriumButter.run("butter.query.search",input);
    const first=await run(args), next=await run({...args,cursor:first.result.cursor});
    return {counts:[first.result.count,next.result.count],ids:[...first.result.rows,...next.result.rows].map(row=>row.id),
      complete:first.result.complete && next.result.complete,changed:before!==host.revision()};
  },proof.args);
  const count = proof.orderedIds.length;
  assert.deepEqual(query,{counts:[count,count],ids:proof.orderedIds,complete:true,changed:false});
  const enabledAssets = [...new Set(featureAssets())];
  assert.ok(enabledAssets.includes(handler("query")));
  await openSettings();
  const exported = await exportBundle();
  assert.ok(flags.every(flag=>exported.prefs[flag]===true));
  await importFlags(exported,false);
  assert.deepEqual(await commandIds(),[]);
  assert.equal(await page.evaluate(args=>AtriumButter.run("butter.query.search",args).catch(error=>error.code),proof.args),"butter_disabled");
  requested.length=0;
  await reloadProject();
  assert.deepEqual(await commandIds(),[]);
  assert.deepEqual(featureAssets(),[],"a fresh load with imported opt-out starts no Butter assets");
  assert.equal(await page.evaluate(()=>typeof globalThis.AtriumButter),"undefined");
  return {flags:flags.length,editorCommands:expected.length,query,enabledAssets,offAssets:featureAssets(),ordinaryUndo:true};
};
