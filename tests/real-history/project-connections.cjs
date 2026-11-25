"use strict";
// Accepts the format baseline's in-memory file selection on stdin. Only aggregate
// counts leave the page; all geometry, edits and Undo steps live in its temporary profile.
const assert = require("node:assert/strict"), path = require("node:path");
const {pathToFileURL} = require("node:url"), {chromium} = require("playwright-core");
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const {files} = JSON.parse(Buffer.concat(chunks));
  const browser = await chromium.launch({channel:"chrome"});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    const summary = await page.evaluate(async files => {
      const host = AtriumNavHost, before = host.project(), H = AtriumHierarchy;
      const selected = files.map(f => new File([Uint8Array.from(atob(f.bytes), c => c.charCodeAt(0))],f.name));
      await host.openFiles(selected);
      const p = host.project();
      const check = (v,label) => {if (!v) throw Error("Projects corpus step " + label);};
      check(p !== before && p.documents.some(d => d.items.length), "open");
      await AtriumLazy.need(["AtriumRules","AtriumProjectTree","AtriumProjectConnections","AtriumUndoStore"]);
      // Adopt freshly imported source copper before measuring the edit, just as
      // the compatibility corpus does. This first-use conversion is independent of browsing.
      for (const doc of p.documents) if (doc.kind === "pcb" && doc.pcbDrawing?.sourceFill)
        AtriumPolygonPour.adopt(doc, host.defs(), {project:p});
      AtriumUndoStore.sync(p);
      const beforeEdits = JSON.stringify(p);
      const button = document.querySelector('[data-project-menu="more"]'), tree = document.getElementById("documents");
      const scope = H.scopeSetting(p), effective = H.effectiveScope(p, scope);
      const docs = p.documents.filter(d => d.kind === "schematic"), first = docs[0], board = p.documents.find(d => d.kind === "pcb");
      const ports = docs.reduce((n,d) => n + d.items.filter(i => H.sourceType(i) === "port").length, 0);
      let jumps = 0;
      check(!document.getElementById("project-scope-notice"), "import notice");
      for (const [theme,doc] of [["light",first],["dark",board || first]]) {
        document.documentElement.dataset.theme = theme;
        host.selectDocument(doc.id);
        button.click();
        const scopeAction = '.nav-menu:not([inert]) [data-menu-action="project-connection-scope"]';
        for (let i=0; i < 100 && !document.querySelector(scopeAction); i++) await new Promise(r => setTimeout(r,5));
        const entry = document.querySelector(scopeAction); check(entry, "overflow " + theme);
        entry.click();
        for (let i=0; i < 100 && !document.querySelector("#project-connections-dialog[open]"); i++) await new Promise(r => setTimeout(r,5));
        const dialog = document.querySelector("#project-connections-dialog[open]"); check(dialog?.open, "options " + theme + (dialog ? " closed" : " missing"));
        const select = dialog.querySelector("select"); check(select.value === scope, "source scope"); select.value = "hierarchical";
        [...dialog.querySelectorAll("button")].find(b => b.textContent === "Apply").click();
        await dialog.done;
        check(tree.getAttribute("role") === "tree", "tree");
        const rows = [...tree.children];
        check(rows.every(r => +r.getAttribute("aria-level") > 0 && +r.getAttribute("aria-posinset") <= +r.getAttribute("aria-setsize")), "levels");
        for (const r of rows) if (r.getAttribute("aria-expanded") === "false") r.querySelector("[data-tree-toggle]").click();
        const target = tree.querySelector("[data-port]");
        if (target) {
          target.click();
          for (let i=0; i<100 && !host.selection().includes(target.dataset.port); i++) await new Promise(r => setTimeout(r,10));
          check(host.currentId() === target.dataset.doc && host.selection().includes(target.dataset.port), "jump"); jumps++;
        }
        if (scope !== "hierarchical") host.act("undo");
        check(H.scopeSetting(p) === scope && !document.getElementById("project-scope-notice"), "scope undo");
      }
      check(JSON.stringify(p) === beforeEdits, "options retention");
      const port = AtriumSchObjects.make("port",[0,0],{text:"TEST_SCOPE",io:"input"});
      host.edit(() => first.items.push(port),"Test port",[{doc:first,items:[port]}]);
      check(!document.getElementById("project-scope-notice") && H.scopeSetting(p) === scope, "post-import edit");
      host.act("undo"); check(JSON.stringify(p) === beforeEdits, "edit undo");
      return {scope,effective,sourceAutomatic:H.sourceAutomatic(p),sheets:docs.length,ports,jumps};
    }, files);
    assert.ok(summary.sheets > 0); console.log(JSON.stringify(summary));
  } finally {await browser.close();}
}
main().catch(e => {console.error(e.message.match(/Projects corpus step [\w ]+/)?.[0] || "Projects corpus verification failed.");process.exitCode=1;});
