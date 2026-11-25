"use strict";

const assert = require("node:assert/strict");
const {resolve} = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const {exerciseResolvedView} = require("../support/a1-resolved-view.cjs");
const {parseGerber,parseExcellon,rasterize} = require("../formats/gerber-compare.cjs");

function verifyStepCaps(entries) {
  const entities = new Map(entries), get = ref => entities.get(ref.ref);
  const caps = new Map();
  for (const solid of entities.values()) {
    if (solid.type!=="MANIFOLD_SOLID_BREP") continue;
    const faceName = solid.args[0].str.match(/(?:Top|Bottom) copper/)?.[0];
    if (!faceName) continue;
    for (const faceRef of get(solid.args[1]).args[1]) {
      const face = get(faceRef), plane = get(face.args[2]);
      if (plane.type!=="PLANE") continue;
      const axis = get(plane.args[1]), normal = get(axis.args[2]).args[1];
      if (Math.abs(normal[2])!==1) continue;
      const z = get(axis.args[1]).args[1][2];
      const apertures = face.args[1].map(get).filter(bound=>bound.type==="FACE_BOUND").length;
      const name = faceName+" @ "+z;
      caps.set(name,Math.max(caps.get(name) || 0,apertures));
    }
  }
  const expected = [["Bottom copper @ -0.035",4],["Bottom copper @ 0",4],["Top copper @ 1.6",6],["Top copper @ 1.635",6]];
  assert.deepEqual([...caps].sort(),expected,"both faces of each copper foil have the depth-dependent cutouts");
  return expected;
}

function verifyPanelFiles(files) {
  const drills = files.filter(file=>file.kind==="drill").map(file=>({...parseExcellon(file.content),content:file.content}));
  const spanAt = (x,y) => drills.find(file=>file.hits.some(hit=>hit.x===x&&hit.y===-y&&hit.d===.5))?.content || "";
  assert.match(spanAt(8,11),/TF\.FileFunction,Plated,1,2,Blind/,"normal instance drills Top to Inner 1");
  assert.match(spanAt(34,5),/TF\.FileFunction,Plated,3,4,Blind/,"reflected instance drills Inner 2 to Bottom");
  return files.length;
}

function verifyProcessFiles(files) {
  const top = files.find(file => file.kind==="gerber" && /\.GTL$/i.test(file.name));
  assert.ok(top,"top copper film exists");
  const gerber = parseGerber(top.content);
  const at = (x,y) => rasterize(gerber.shapes,{x0:x-.0005,y0:-y-.0005,s:.001,w:1,h:1})[0];
  for (const pt of [[5,6.8],[8,6],[18,6]]) assert.equal(at(...pt),1,"film is positive at "+pt);
  assert.equal(at(18.5,8.5),0,"clear region removes film ink");
  const drills = files.filter(file => file.kind==="drill").map(file => ({...file,...parseExcellon(file.content)}));
  const slots = drills.flatMap(file => file.slots);
  assert.equal(slots.length,1,"one physical plated slot in NC output");
  assert.deepEqual({ends:[slots[0].a,slots[0].b].sort((a,b)=>a[1]-b[1]),diameter:slots[0].d,plated:slots[0].plated},
    {ends:[[5,-6.7],[5,-5.3]],diameter:.6,plated:true});
  const fileWith = (x,y,d) => drills.find(file => file.hits.some(hit=>hit.x===x&&hit.y===-y&&hit.d===d));
  assert.match(fileWith(15,6,.5)?.content || "",/TF\.FileFunction,Plated,1,2,Blind/,"blind drill reaches Inner 1");
  assert.match(fileWith(12,6,.8)?.content || "",/TF\.FileFunction,NonPlated,1,1,Blind/,"backdrill removes only the Top foil before its stop layer");
  assert.match(fileWith(18,6,.65)?.content || "",/TF\.FileFunction,NonPlated,1,4,NPTH/,"NPTH has its own NC file");
  return {gerber:top.name,drillFiles:drills.length,slotEnds:[[5,-6.7],[5,-5.3]]};
}

async function checkResolvedGeometry(browser,{app=resolve(__dirname,"../../app"),cases=["C2","C3","C4"]}={}) {
  const page = await browser.newPage();
  try {
    const startupErrors = [];
    page.on("pageerror", error => startupErrors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("atrium.prefs",JSON.stringify({
        format:"atrium-prefs",version:1,values:{"general.startPage":"never"}
      }));
    });
    await page.goto(pathToFileURL(resolve(app,"index.html")).href);
    await page.waitForFunction(() => globalThis.AtriumNavHost);
    assert.ok(await page.evaluate(() => typeof AtriumNavHost.prepareBoardGeometry==="function"),
      "The normal editor exposes board geometry preparation");
    await page.evaluate(() => AtriumLazy.need(["AtriumPanel","AtriumPCBNetLabels"]));
    const results = await page.evaluate(exerciseResolvedView,{cases});
    for (const result of results) {
      if (result.pass && result.name==="C2") {
        const {files,...readings} = result.readings;
        try { result.readings = {...readings,camFiles:verifyPanelFiles(files)}; }
        catch (error) { Object.assign(result,{pass:false,readings,error:String(error.stack || error)}); }
      }
      if (result.pass && result.name==="C3") {
        const {files,step,...readings} = result.readings;
        try { result.readings = {...readings,cam:verifyProcessFiles(files),stepCaps:verifyStepCaps(step)}; }
        catch (error) { Object.assign(result,{pass:false,readings,error:String(error.stack || error)}); }
      }
      process[result.pass ? "stdout" : "stderr"].write(JSON.stringify(result)+"\n");
    }
    assert.ok(results.every(result => result.pass), "Resolved geometry contract failed");
    assert.deepEqual(startupErrors,[],"No uncaught editor errors");
  } finally {
    await page.close();
  }
}

async function run() {
  const flag = name => {
    const at = process.argv.indexOf(name);
    return at < 0 ? null : process.argv[at+1];
  };
  const app = flag("--app") || resolve(__dirname,"../../app");
  const executablePath = flag("--executable");
  const cases = flag("--case")?.split(",") || ["C2","C3","C4"];
  assert.ok(cases.every(name => ["C2","C3","C4"].includes(name)), "Choose C2, C3, C4 or a comma-separated subset");
  const browser = await chromium.launch({
    ...(executablePath ? {executablePath} : {channel:"chrome"}),
    args:["--allow-file-access-from-files"]
  });
  try { await checkResolvedGeometry(browser,{app,cases}); }
  finally { await browser.close(); }
}

module.exports = {checkResolvedGeometry};
if (require.main===module) run().catch(error => {
  console.error(error);
  process.exitCode=1;
});
