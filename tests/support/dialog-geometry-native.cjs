"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const fixtureRoot = path.join(__dirname, "../fixtures");
const manifest = "Reference.waffle";
const source = "demo.kicad_pcb";

async function readWorkshop(dir = path.join(fixtureRoot, "format-2/workshop"), prefix = "") {
  const rows = [];
  for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
    const name = prefix + entry.name, file = path.join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...await readWorkshop(file, name + "/"));
    else if (entry.isFile()) rows.push({name, data:(await fs.readFile(file)).toString("base64")});
  }
  return rows;
}

function cases(page) {
  const modal = name => page.getByRole("dialog", {name,exact:typeof name === "string"});
  const button = (root, name) => root.getByRole("button", {name,exact:true});
  const run = action => page.evaluate(async action => {
    const host = AtriumNavHost, deps = AtriumLazy.forAction(action, host.doc()?.kind);
    if (deps) await AtriumLazy.need(deps);
    void host.act(action);
  }, action);
  const restoreDemo = () => page.evaluate(async () => {
    window.geometryDemo ??= structuredClone(AtriumNavHost.project());
    return AtriumNavHost.replaceProject(structuredClone(geometryDemo), {force:true,dirty:false});
  });
  const importDesign = async () => {
    const bytes = await fs.readFile(path.join(fixtureRoot,"import",source));
    await page.evaluate(async ({name, data}) => {
      await window.geometryImport;
      const file = new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))],name);
      window.geometryImport = AtriumNavHost.openFiles([file]);
    },{name:source,data:bytes.toString("base64")});
    await modal("Open project").waitFor();
  };
  const withImport = async () => {
    if (!await page.locator(".import-save-hint").isVisible()) {
      await importDesign();
      await button(modal("Open project"),"Open here").click();
      assert.ok(await page.evaluate(() => geometryImport));
    }
    return button(page.locator(".import-save-hint"),saveImport);
  };
  const saveImport = /^Save as Waffle Project…?$/;
  const firstSave = /^Save “.+” as a Waffle project\?$/;
  const openClose = async multi => {
    await restoreDemo();
    await page.evaluate(async multi => {
      const host = AtriumNavHost, tabs = await AtriumLazy.need("AtriumDocTabs");
      const docs = host.project().documents.slice(0,multi ? 2 : 1);
      await host.selectDocument(docs[0].id);
      tabs.capture();
      for (const doc of docs) host.edit(() => { doc.name += " edited"; }, "Edit document name", null, {documents:[doc.id]});
      window.geometryClosing = tabs.run(host,multi ? "all" : "close",{id:docs[0].id,pane:null});
    },multi);
    const target = modal(multi ? "Save changes to 2 documents before closing?" : /^Save changes to “.+” before closing\?$/);
    await button(target,multi ? "Save All" : "Save").waitFor();
    if (multi) assert.equal(await target.getByRole("checkbox").count(),2);
  };
  const setGit = exact => page.evaluate(exact => {
    const revision = "1234567890abcdef".repeat(2) + "12345678";
    const refs = [
      {kind:"branch",name:"refs/heads/main",short:"main",revision},
      {kind:"branch",name:"refs/heads/review",short:"review",revision},
    ];
    // Only the desktop transport is substituted. Each dialog still uses the
    // production navigation, requests, renderers and consent controls.
    const stageNames = ["base","ours","theirs"], sidePath = "Sensor.wsch";
    const revisions = exact && stageNames.map((name,i) => ({
      revision:name,blob:String(i+1).repeat(40),files:{[sidePath]:String(i+1).repeat(40)},
    }));
    const objects = exact && Object.fromEntries(revisions.map((row,i) => [row.blob,exact[i]]));
    window.AtriumHost = {
      folderGitGrant:"geometry-project",projectGeneration:1,
      async gitQuery(op) {
        if (op === "status" && exact) return {head:revision,ref:"refs/heads/main",mergeHead:"7".repeat(40),
          indexBlob:"8".repeat(40),conflicted:true,conflictVersion:"fixture-index-version",
          conflicts:[{path:sidePath,stages:stageNames}]};
        if (op === "folderRevisions" && exact) return {revisions,objects};
        // A folder project (folderGitGrant) reads a commit's preview through folderRevisions, not
        // projectBlobs. Like projectBlobs below, the fixture commit holds no project.
        if (op === "folderRevisions") return {revisions:[{revision,blob:null}],objects:{}};
        if (op === "refs") return {ref:"refs/heads/main",head:revision,refs};
        if (op === "projectBlobs") return {blobs:{[revision]:null}};
        if (op === "log" || op === "fileLog" || op === "projectLog") return {commits:[
          {revision,subject:"Edit sensor labels",author:"Fixture Author",date:"2026-11-20T12:00:00Z",parents:[]}
        ],more:false};
        if (op === "mergeDriverPlan") return {plan:"geometry-plan",config:".git/config",attributes:".gitattributes",
          attributeLines:["*.wsch merge=waffle","*.wpcb merge=waffle"]};
        if (op === "commitPlan") return {plan:"geometry-plan",branch:"refs/heads/main",
          paths:[{path:"Sensor.wsch",change:"modified"},{path:"Reference.waffle",change:"modified"}]};
        throw Error("Unexpected Git fixture query: "+op);
      },
    };
  },exact);
  const openWorkshop = async mode => {
    await page.evaluate(() => window.geometryWorkshop);
    await restoreDemo();
    const rows = await readWorkshop();
    return page.evaluate(async ({rows,manifest,mode}) => {
      const host = AtriumNavHost, Browser = await AtriumLazy.need("AtriumBrowserProject");
      const bytes = data => Uint8Array.from(atob(data),char => char.charCodeAt(0));
      const files = new Map(rows.map(({name,data}) => [name,bytes(data)]));
      const folder = Browser.create(manifest,files,{draftScope:"geometry-folder-"+mode});
      if (mode === "journal") {
        const path = "Sensor.wsch", digest = AtriumFormat2.sha256(files.get(path));
        window.AtriumHost = {
          folderConflict:async () => ({transaction:"geometry-journal",paths:[path],
            plan:[{path,current:digest,desired:{sha256:digest,length:files.get(path).length}}]}),
        };
        folder.status = {state:"conflict",paths:[path]};
      } else if (mode === "draft") {
        const D = await AtriumLazy.need("AtriumFolderDrafts");
        if (!await host.openFiles([{name:manifest,folderProject:folder}])) throw Error("Could not open the draft source.");
        const prefs = await AtriumLazy.need("AtriumPrefs"), session = host.folderProject(), doc = host.doc();
        prefs.set("general.autosave",true);
        session.configureDrafts();
        host.edit(() => { doc.grid = (doc.grid || 1.27) * 2; },"Edit document grid",null,{documents:[doc.id]});
        await session.flushDrafts();
        const scope = JSON.stringify([folder.draftScope,host.project().id]);
        if (!(await D.storage.list(scope)).length) throw Error("The project did not write the private draft fixture.");
        await host.replaceProject(structuredClone(geometryDemo),{force:true,dirty:false});
        const reopened = Browser.create(manifest,files,{draftScope:folder.draftScope});
        window.geometryWorkshop = host.openFiles([{name:manifest,folderProject:reopened}]);
        return true;
      } else {
        let external = new Map();
        const base = folder.host;
        folder.host = {
          ...base, async folderRead(request) {
            const reply = await base.folderRead(request);
            return {files:reply.files.flatMap(row => !external.has(row.path) ? [row] :
              external.get(row.path) ? [external.get(row.path)] : [])};
          },
        };
        window.geometryExternal = (path, data) => {
          external = new Map([[path,data && {path,bytes:data,length:data.length,sha256:AtriumFormat2.sha256(data)}]]);
        };
      }
      window.geometryWorkshop = host.openFiles([{name:manifest,folderProject:folder}]);
      if (mode === "journal") return true;
      return geometryWorkshop;
    },{rows,manifest,mode});
  };
  const external = async missing => {
    assert.ok(await openWorkshop(missing ? "missing" : "changed"));
    await page.evaluate(async missing => {
      const host = AtriumNavHost, session = host.folderProject();
      const ref = host.documentRefs().find(row => row.kind === "schematic" && row.name === "Sensor");
      if (!ref) throw Error("The Workshop fixture has no Sensor schematic.");
      await host.selectDocument(ref.id);
      const doc = host.doc(), path = session.getDocumentRef(ref.id).path;
      if (missing) geometryExternal(path,null);
      else {
        const disk = structuredClone(doc);
        disk.grid = (doc.grid || 1.27) * 2;
        const data = AtriumFormat2.serialize(AtriumFormat2Model.createDocument(disk));
        host.edit(() => { doc.grid = (doc.grid || 1.27) / 2; },
          "Edit document grid", null, {documents:[doc.id]});
        geometryExternal(path,data);
      }
      window.geometrySynchronizing = session.synchronize([path]);
    },missing);
    const target = modal(missing ? "Document missing" : "Document changed on disk");
    await button(target,missing ? "Locate Document…" : "Merge").waitFor();
  };

  return [
    {name:"Close one edited document",open:() => openClose(false)},
    {name:"Close multiple edited documents",open:() => openClose(true)},
    {name:"Browser project window destination",async open() {
      await restoreDemo(); await importDesign();
      await button(modal("Open project"),"Open in new window").waitFor();
    }},
    {name:"First Save of an imported KiCad design",async open() {
      await (await withImport()).click();
      await button(modal(firstSave),"Export to KiCad…").waitFor();
    }},
    {name:"KiCad export report after first Save",async open() {
      await (await withImport()).click();
      await button(modal(firstSave),"Export to KiCad…").click();
      await modal(/^Export “.+” to KiCad$/).getByRole("heading",{name:"Kept",exact:true}).waitFor();
    }},
    {name:"First Save portable ZIP confirmation",async open() {
      await (await withImport()).click();
      await button(modal(firstSave),saveImport).click();
      await button(modal(/^Download “.+” as a Waffle project ZIP\?$/),"Download Format 2 ZIP").waitFor();
    }},
    {name:"Close an unsaved imported design",async open() {
      await withImport();
      await page.evaluate(async () => {
        const drafts = await AtriumLazy.need("AtriumForeignDrafts");
        window.geometryDraftReview = drafts.review(AtriumNavHost);
      });
      await button(modal(/^Close .+\?$/),"Keep for Later").waitFor();
    }},
    {name:"Private imported drafts recovery",async open() {
      await withImport();
      await page.evaluate(async () => {
        await window.geometryDraftReview;
        const host = AtriumNavHost, drafts = await AtriumLazy.need("AtriumForeignDrafts");
        window.geometryDraftReview = drafts.review(host);
      });
      await button(modal(/^Close .+\?$/),"Keep for Later").click();
      assert.ok(await page.evaluate(() => geometryDraftReview));
      await restoreDemo();
      await page.evaluate(async () => {
        const heads = await AtriumAutosave.foreignHeads();
        if (!heads.length) throw Error("The retained KiCad draft is unavailable.");
        AtriumForeignDraftUI.prompt(heads,AtriumNavHost);
      });
      await button(modal("Recover imported projects"),"Restore Draft").waitFor();
    }},
    {name:"Retry opening History after its view fails to load",async open() {
      await page.evaluate(() => {
        const L = window.geometryHistoryLoader = AtriumLazy;
        globalThis.AtriumLazy = {...L, need: name => name === "AtriumHistoryView"
          ? Promise.reject(Error("The History view could not load.")) : L.need(name)};
      });
      try {
        await run("file-history");
        await button(modal("History could not open"), "Try again").waitFor();
      } finally { await page.evaluate(() => { globalThis.AtriumLazy = window.geometryHistoryLoader; }); }
    }},
    {name:"Browser guidance for reviewing Git conflicts",async open() {
      await run("merge-conflicts");
      await button(modal("Resolve merge conflicts"),"Merge Three Files…").waitFor();
    }},
    {name:"Review conflicting edits from three saved project ZIPs",async open() {
      await restoreDemo();
      await page.evaluate(async manifest => {
        const [zip,sidecars] = await AtriumLazy.need(["AtriumProjectArchive","AtriumImportSidecars","AtriumBrowserProject"]);
        const M = AtriumFormat2Model;
        const source = AtriumNavHost.project();
        const files = await Promise.all(["Base","Ours","Theirs"].map(async name => {
          const project = structuredClone(source);
          const board = project.documents.find(doc => doc.kind === "pcb");
          const item = board.items.find(row => row.kind === "track");
          if (!item) throw Error("The demo has no track to edit.");
          item.width *= name === "Base" ? 1 : name === "Ours" ? 2 : 3;
          const snapshot = M.fromEditor(project);
          const members = new Map([[manifest,AtriumFormat2.serialize(snapshot.manifest)], [sidecars.IGNORE,sidecars.ignoreText],
            ...snapshot.files.map(({path,file}) => [path,AtriumFormat2.serialize(file)])]);
          const read = async path => members.get(path);
          const checked = await zip.verifyClosure({manifestPath:manifest,read});
          const archive = await zip.archive({...checked,read});
          return new File([archive.bytes],name+".zip",{type:"application/zip"});
        }));
        window.geometryMergePicks = [];
        window.AtriumHost = {
          async pickFile(extensions) {
            if (extensions.join() !== ".zip") throw Error("The merge must choose three project ZIPs.");
            const file = files.shift() || null;
            window.geometryMergePicks.push(file?.name || null);
            return file;
          },
        };
      },manifest);
      try {
        await run("merge-files");
        for (const stage of [0,1,2]) {
          await page.waitForFunction(stage => {
            const chooser = document.querySelector('dialog[open][aria-label="Open project ZIP"]');
            return window.geometryMergePicks.length > stage + 1 ||
              (window.geometryMergePicks.length === stage + 1 && !!chooser) || !!document.querySelector(".mg-dialog[open]");
          },stage);
          const picker = modal("Open project ZIP");
          if (await picker.isVisible()) {
            const select = picker.getByRole("combobox");
            const selected = await select.evaluate((node,name) => [...node.options]
              .find(option => option.label === name || option.label.endsWith("/" + name))?.value, manifest);
            assert.ok(selected !== undefined, "The fixture archive exposes its native project manifest.");
            await select.selectOption(selected);
            const handle = await picker.elementHandle();
            await button(picker,"Open project").click();
            await handle.waitForElementState("hidden");
          }
        }
        const target = modal("Resolve merge conflicts");
        await target.waitFor();
        await target.getByRole("listbox",{name:"Conflicts",exact:true}).getByRole("option").first().waitFor();
        await target.getByText("Changed on both sides",{exact:false}).first().waitFor();
      } catch (error) {
        const state = await page.evaluate(() => ({status:document.getElementById("status").textContent,
          picks:window.geometryMergePicks, visible:[...document.querySelectorAll("dialog[open]")].map(dialog =>
            dialog.getAttribute("aria-label") || dialog.querySelector("h2")?.textContent)}));
        throw new Error(`The three stored project ZIPs did not open their conflict review: ${JSON.stringify(state)}`, {cause:error});
      } finally {
        await page.evaluate(() => { delete window.AtriumHost; });
      }
    }},
    {name:"Git history branch comparison with refs",async open() {
      await setGit(); await run("compare-branches");
      await modal("Compare branches").getByRole("searchbox",{name:"Search revisions"}).waitFor();
    }},
    {name:"Create a branch from Git history",async open() {
      await page.evaluate(async () => {
        const prefs = await AtriumLazy.need("AtriumPrefs");
        prefs.set("butter.visualHistory",true);
      });
      await run("history-panel");
      const panel = page.locator('.ui-dock-panel[data-dock="history"]'), slider = panel.getByRole("slider",{name:"Session and Git history"});
      await page.waitForFunction(() => Number(document.querySelector(".hist-scrub input")?.max) >= 1);
      await slider.evaluate(input => {
        input.value = "0";
        input.dispatchEvent(new Event("input",{bubbles:true}));
      });
      await button(panel,"Create Git branch…").click();
      const target = modal("Create Git branch");
      await target.getByRole("textbox",{name:"Branch name",exact:true}).waitFor();
    },async finish() {
      await page.evaluate(() => AtriumPrefs.set("butter.visualHistory",false));
    }},
    {name:"Create a branch at a commit in the History view",async open() {
      await setGit(); await run("project-history");
      const view = page.locator(".hv-view");
      await view.locator('.hv-row[data-key^="1234567890"]').click();
      await button(view.locator(".hv-details"),"More actions").click();
      await page.getByRole("menuitem",{name:"Create branch here…",exact:true}).click();
      await modal("Create Git branch").getByRole("textbox",{name:"Branch name",exact:true}).waitFor();
    }},
    {name:"Git merge driver consent with a preview",async open() {
      await run("git-merge-driver");
      await modal("Set up the Waffle merge driver").getByText(/\.gitattributes/).waitFor();
    }},
    {name:"Git staged file and message confirmation",async open() {
      await run("git-commit");
      const target = modal("Commit staged project files");
      await target.getByRole("textbox",{name:"Commit message"}).waitFor();
      assert.equal(await target.getByRole("checkbox").count(),2);
      await page.evaluate(() => { delete window.AtriumHost; });
    }},
    {name:"Review exact saved versions in a Git merge conflict",async open() {
      const original = await fs.readFile(path.join(fixtureRoot,"format-2/forward-bytes/Sensor.wsch"),"utf8");
      const versions = ["SENSE","OURS","THEIRS"].map(text =>
        Buffer.from(original.replace('"text":"SENSE"', '"text":"'+text+'"')).toString("base64"));
      await setGit(versions);
      await run("merge-conflicts");
      const target = modal("Resolve merge conflicts");
      await button(target,"Export Ours").waitFor();
      await button(target,"Export Theirs").waitFor();
      await page.evaluate(() => { delete window.AtriumHost; });
    }},
    {name:"Open a saved transaction with an external conflict",async open() {
      assert.ok(await openWorkshop("journal"));
      await modal("Saved, external conflict").getByRole("combobox").selectOption("merged");
      await modal("Saved, external conflict").getByRole("textbox",{name:"Merged records for Sensor.wsch"}).waitFor();
    }},
    {name:"Open a folder with a retained private draft",async open() {
      await page.evaluate(() => { delete window.AtriumHost; });
      assert.ok(await openWorkshop("draft"));
      await button(modal("Recover private draft"),"Restore Draft").waitFor();
    }},
    {name:"Missing native project member recovery",open:() => external(true)},
    {name:"Externally edited native project member review",open:() => external(false)},
    {name:"Save an edit that spans two project members",async open() {
      assert.ok(await openWorkshop("dependent"));
      await page.evaluate(async () => {
        const host = AtriumNavHost, session = host.folderProject();
        const refs = host.documentRefs().filter(row => row.kind === "schematic").slice(0,2);
        for (const ref of refs) await session.ensureDocument(ref.id);
        await host.selectDocument(refs[0].id);
        AtriumFolderProjectUI.atomicEdit(session,() => host.edit(() => {
          for (const ref of refs) {
            const doc = host.docById(ref.id);
            doc.grid = (doc.grid || 1.27) * 2;
          }
        },"Edit grids in both sheets",null,{documents:refs.map(ref => ref.id)}));
        window.geometryDependentSave = host.saveProject();
      });
      await button(modal("Save dependent changes"),"Save All").waitFor();
    }},
  ];
}

module.exports = {cases};
