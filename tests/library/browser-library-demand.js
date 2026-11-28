"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {pathToFileURL} = require("node:url");

function fixture(folder) {
  const root = process.env.WAFFLE_ALTIUM_FIXTURES;
  if (!root) return null;
  const dir = path.join(root, folder), rev = fs.readdirSync(dir).find(n => /^[a-f0-9]{40}$/.test(n));
  const at = path.join(dir, rev);
  return fs.readdirSync(at, {recursive: true}).filter(n => /\.(schlib|pcblib)$/i.test(n)).map(n => [n, fs.readFileSync(path.join(at, n)).toString("base64")]);
}

// Production dock, source worker and IndexedDB. Set WAFFLE_ALTIUM_FIXTURES to the
// licensed design cache used by tests/altium-fidelity/fixtures.json to replay the two real folders.
module.exports = async function libraryDemand(browser, appURL = pathToFileURL(path.join(__dirname, "../../app/index.html")).href) {
  const input = fixture("snes-tap");
  const cases = input ? [["SNES-Tap", input], ["ESP32-C3 Haptic", fixture("esp32c3-haptic")]] : [["Linked components", null]];
  for (const [name, files] of cases) {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}}), page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(7000);
    try {
      await page.goto(appURL);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
      const cold = await page.evaluate(async ({name, files}) => {
        await AtriumLazy.need("AtriumLibrarySourcesUI");
        if (files) await AtriumLazy.need("AtriumImport");
        const S = AtriumLibrarySources, L = AtriumLibrary, seed = AtriumParts.catalogue.find(d => d.id === "std-r");
        const store = new Map(files ? files.map(([path, text]) => [path, {data: Uint8Array.from(atob(text), c => c.charCodeAt(0)), mtime: 1}]) :
          Array.from({length: 12}, (_, i) => ["components/part-" + i + ".json",
            {data: JSON.stringify({...seed, id: "part-" + i, name: "Device " + i, rev: 1}), mtime: 1}]));
        const provider = S.providers.memory(store), original = provider.read.bind(provider), visits = [];
        let release, hold = false;
        provider.read = async p => {
          if (hold) await new Promise(r => { release = r; });
          const data = await original(p); visits.push([p, data.length]); return data;
        };
        const rec = {id: "probe-folder", kind: "files", name};
        S.addFolder(rec); const t = performance.now(), first = await S.scan(rec, {provider});
        const firstMs = performance.now() - t, coldBytes = visits.reduce((n, x) => n + x[1], 0);
        const initial = first.library.defs.slice(), project = Atrium.project("Library demand", []);
        const bodyStart = performance.now(); visits.length = 0;
        for (const row of initial) L.addFromLibrary(first.library, await S.load(first.library, row.id), project);
        const bodyMs = performance.now() - bodyStart, bodyBytes = visits.reduce((n, x) => n + x[1], 0), bodyReads = visits.length;
        const health = AtriumLibraryStore.health(project.library);
        visits.length = 0;
        const start = performance.now(), warm = await S.scan(rec, {provider});
        const warmMs = performance.now() - start;
        await AtriumNavHost.replaceProject(project, {force: true, dirty: false});
        AtriumPower.setMode("always");
        let replacements = 0;
        const replace = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function(...args) { if (this.matches(".lib-list")) replacements++; return replace.apply(this, args); };
        window.demand = {
          rec, project, provider, visits, store, ids: initial.map(d => d.id),
          counters: () => ({reads: visits.length, bytes: visits.reduce((n, x) => n + x[1], 0), replacements}),
          block() { hold = true; }, release() { hold = false; release?.(); }, entered: () => !!release,
          health: health.counts, warm: warm.library
        };
        return {name, rows: initial.length, files: first.stats.read, coldBytes, coldMs: Math.round(firstMs), bodyReads, bodyBytes, bodyMs: Math.round(bodyMs),
          warmReads: warm.stats.read, warmMs: Math.round(warmMs), healthErrors: health.counts.error, sourceErrors: first.library.report.errors};
      }, {name, files});
      if (!files) assert.deepEqual(cold.sourceErrors, [], "the scan worker indexes valid two-sided components");
      assert.equal(cold.warmReads, 0);
      assert.ok(cold.rows >= 12 && cold.bodyReads <= cold.files, "each shared asset file is read at most once for all parts");
      await page.clock.install();
      await page.locator("#canvas").focus(); await page.keyboard.press("t"); await page.keyboard.press("l");
      const panel = page.locator(".panel-library:visible"), source = panel.getByLabel("Library source", {exact: true});
      await source.waitFor();
      await page.waitForFunction(() => document.querySelectorAll(".panel-library .lib-row").length >= 12);
      await page.clock.runFor(450);
      const showing = await page.evaluate(() => demand.counters());
      assert.equal(showing.reads, 0, "the project Library opens and settles without reading a linked source");
      await page.evaluate(() => {
        const H = AtriumNavHost, d = H.doc();
        H.edit(() => d.items.push({id: "trace-test", kind: "track", layer: "Top", a: [0, 0], b: [1, 0], width: .2}));
      });
      await page.clock.runFor(450);
      assert.deepEqual(await page.evaluate(() => demand.counters()), showing, "unrelated copper leaves Library rows intact");
      await source.selectOption("probe-folder");
      const ids = await page.evaluate(() => demand.ids);
      await panel.getByRole("searchbox").fill("");
      const row = panel.locator('.lib-row[data-def="' + ids[0] + '"]');
      await row.waitFor();
      assert.equal((await page.evaluate(() => demand.counters())).reads, 0, "browsing source metadata needs no geometry");
      const before = await page.evaluate(() => demand.counters());
      await row.click();
      await panel.locator(".lib-detail .cat-pv").waitFor();
      const preview = await page.evaluate(() => demand.counters());
      assert.equal(preview.replacements, before.replacements, "a finished preview keeps every list row");
      assert.ok(preview.reads >= 1 && preview.reads <= 2);
      await source.selectOption("project");
      await page.evaluate(async () => { await AtriumLibrarySources.scan(demand.rec, {provider: demand.provider}); demand.visits.length = 0; });
      await source.selectOption("probe-folder");
      await page.evaluate(() => demand.block());
      await row.click(); await page.waitForFunction(() => demand.entered());
      await row.press("Enter");
      await page.evaluate(async () => {
        const p = Atrium.project("Another receiving project", []); await AtriumNavHost.replaceProject(p, {force: true, dirty: false});
        demand.release();
      });
      await page.waitForFunction(id => AtriumLibrarySources.library(demand.rec.id)?.defs.some(d => d.id === id && !d.stub), ids[0]);
      assert.equal(await page.evaluate(() => AtriumNavHost.project().library.length), 0, "stale placement did not add a part to another project");
      await row.click();
      await panel.locator(".lib-detail .cat-pv").waitFor();
      const selected = await page.evaluate(() => demand.counters());
      assert.ok(selected.reads >= 1 && selected.reads <= 2);
      await row.press("Enter");
      await page.waitForFunction(() => AtriumNavHost.project().library.some(d => d.libraryRef?.library === "probe-folder"));
      await page.keyboard.press("Escape");
      const detailReads = (await page.evaluate(() => demand.counters())).reads;
      assert.equal(detailReads, selected.reads, "a warm row places without another body read");
      // Check library… is in the Library's "Library commands" menu.
      await panel.getByRole("button", {name: "Library commands", exact: true}).click();
      await page.getByRole("menuitem", {name: "Check library…", exact: true}).click();
      const report = page.getByRole("dialog", {name: "Check " + name});
      await report.getByText(/error\(s\), .*warning\(s\)/).waitFor();
      assert.match(await report.textContent(), new RegExp(cold.healthErrors + " error\\(s\\)"));
      await report.getByRole("button", {name: "Close", exact: true}).last().click();
      const revisions = files ? await page.evaluate(async () => {
        const S = AtriumLibrarySources, L = AtriumLibrary, lib = S.library(demand.rec.id), copies = demand.project.library;
        const pairs = copies.filter(d => d.source?.footprint);
        let falseUpdates = 0;
        for (const copy of pairs) {
          const old = Atrium.clone(copy); delete old.libraryRef.folderRevision;
          old.source.date = "2020-01-02"; old.libraryRef.hash = L.defHash(old, demand.project);
          await S.load(lib, old.libraryRef.id);
          if (L.libraryStatus(old, [lib], demand.project).state !== "current") falseUpdates++;
        }
        const part = pairs[0], path = [...demand.store.keys()].find(p => p.split("/").pop() === part.source.footprint.file);
        const file = demand.store.get(path), renamed = path.replace(/[^/]+$/, s => "Renamed-" + s);
        demand.store.delete(path); demand.store.set(renamed, file);
        try {
          const next = await S.refresh(demand.rec, demand.provider, {index: await S.db.readIndex(demand.rec.id)});
          const state = L.libraryStatus(part, [next.library], demand.project);
          const bytes = new Map(S.needs(state.src).map(p => [p, demand.store.get(p).data]));
          const full = S.materialise(state.src, bytes, {}, next.library);
          return {pairs: pairs.length, falseUpdates, renameState: state.state, renamed: full.source.footprint.file === renamed.split("/").pop()};
        } finally { demand.store.delete(renamed); demand.store.set(path, file); }
      }) : null;
      if (revisions) { assert.equal(revisions.falseUpdates, 0); assert.equal(revisions.renameState, "update"); assert.ok(revisions.renamed); }
      const persistent = await page.evaluate(async synthetic => {
        const S = AtriumLibrarySources, puts = [], put = IDBObjectStore.prototype.put;
        let index = await S.db.readIndex(demand.rec.id);
        if (!index?.generation) throw Error("The source did not commit its durable head.");
        const paths = Object.keys(index.files);
        let previous, abortAtHead;
        IDBObjectStore.prototype.put = function(value, key) {
          const request = put.call(this, value, key);
          if (this.name === "index") {
            puts.push(key);
            if (abortAtHead && key === abortAtHead.id) abortAtHead.abort(this.transaction);
          }
          return request;
        };
        try {
          if (synthetic) {
            const file = paths[0], {rows, rowsHash, ...stamp} = index.files[file];
            const failed = {...stamp, rows: [], error: "Cannot read properties of undefined (reading 'difference')"};
            await S.db.writeIndex(demand.rec.id, {...index, files: {...index.files, [file]: failed}}, index, [file], []);
            puts.length = 0;
            const repaired = await S.scan(demand.rec, {provider: demand.provider});
            if (repaired.stats.read !== 1 || repaired.library.defs.length !== paths.length || repaired.library.report.errors.length)
              throw Error("Rescan did not recover the one row rejected by the previous worker");
            if (puts.filter(k => k === demand.rec.id).length !== 1 || puts.filter(k => Array.isArray(k) && k[1] === file).length !== 1)
              throw Error("Worker repair did not publish its changed file and head in the editor's transaction");
            index = await S.db.readIndex(demand.rec.id);
          }
          previous = index.generation;
          const interrupted = {id: "cancelled-worker-index", name: "Cancelled worker index"};
          const controller = new AbortController();
          abortAtHead = {id: interrupted.id, abort: () => controller.abort()};
          const cancelProvider = S.providers.memory(new Map([["LICENSE", {data: "terms", mtime: 1}]]));
          const cancelled = await S.scan(interrupted, {provider: cancelProvider, signal: controller.signal}).then(() => null, e => e.name);
          abortAtHead = null;
          if (cancelled !== "AbortError" || !puts.includes(interrupted.id) || await S.db.readIndex(interrupted.id))
            throw Error("Cancellation did not roll back the worker's open index transaction");
          puts.length = 0;
          // Two source names with identical projected rows store one immutable block.
          const id = "durability", first = S.emptyIndex(), bytes = new TextEncoder().encode("unrelated user terms");
          for (const path of ["a/LICENSE", "b/LICENSE"]) S.ingest(first, {path, size: bytes.length, mtime: 1}, bytes);
          await S.db.writeIndex(id, first, S.emptyIndex(), Object.keys(first.files), []);
          if (puts.filter(k => Array.isArray(k) && k[1] === 0).length !== 1) throw Error("Duplicate immutable block");
          const base = await S.db.readIndex(id);
          const jobs = [1, 2].map(i => {
            const next = {...base, files: {...base.files, "a/LICENSE": {...base.files["a/LICENSE"], mtime: i + 10}}};
            return S.db.writeIndex(id, next, base, ["a/LICENSE"], []);
          });
          puts.length = 0;
          const commits = await Promise.allSettled(jobs);
          if (commits.filter(r => r.status === "fulfilled").length !== 1 || puts.length !== 2 ||
              puts.some(k => Array.isArray(k) && k[1] === 0)) throw Error("Changed stamp should commit one file and head in one transaction");
          const last = await S.db.readIndex(id);
          if (last.files["a/LICENSE"].rows[0].t !== "notice" || last.files["b/LICENSE"].mtime !== 1) throw Error("Split metadata round trip failed");
          const staged = new Map([["a/LICENSE", {data: "first edit before freeing storage", mtime: 30}], ["b/LICENSE", {data: bytes, mtime: 1}]]);
          const provider = S.providers.memory(staged);
          const rec = {id, name: "Quota recovery"};
          abortAtHead = {id, abort: tx => tx.abort()};
          const session = await S.scan(rec, {provider});
          abortAtHead = null;
          const memory = await S.cache.get(id), warm = await S.scan(rec);
          if (session.cachedOK || !memory.sessionGeneration || memory.files["b/LICENSE"].mtime !== 1 || !warm.reuse || warm.stats.read)
            throw Error("Worker storage fallback lost an unchanged file or rebuilt the catalogue");
          staged.set("b/LICENSE", {data: "second edit after freeing storage", mtime: 40});
          const recovered = await S.scan(rec);
          const committed = await S.db.readIndex(id);
          if (recovered.stats.read !== 1 || committed.files["a/LICENSE"].mtime !== 30 ||
              committed.files["b/LICENSE"].mtime !== 40 || committed.sessionGeneration) throw Error("Previous uncommitted rows were lost");
          await S.db.deleteIndex(id);
          if (await S.db.readIndex(id)) throw Error("Removed index survived");
          const v1 = {version: 1, files: {"a/LICENSE": first.files["a/LICENSE"]}};
          await S.db.set("index", id, v1);
          const offline = await S.refresh({id, name: "Old library"}, null, {cache: S.cache});
          if (!offline.library.offline || offline.library.report.files !== 1) throw Error("Offline v1 index could not be read");
          const upgraded = await S.refresh({id, name: "Old library"}, S.providers.memory(new Map([["a/LICENSE", {data: bytes, mtime: 1}]])), {cache: S.cache});
          if (upgraded.stats.read !== 1 || !(await S.db.readIndex(id)).generation) throw Error("v1 index did not migrate");
          await S.db.deleteIndex(id);
        } finally { IDBObjectStore.prototype.put = put; }
        const same = await AtriumLibrarySources.scan(demand.rec, {provider: demand.provider});
        const again = await AtriumLibrarySources.db.readIndex(demand.rec.id);
        return {previous, next: again.generation, rows: paths.length, noChangeReads: same.stats.read};
      }, !files);
      assert.equal(persistent.previous, persistent.next); assert.equal(persistent.noChangeReads, 0);
      // A real second window edits the same registry entry and commits the derived index head.
      const projectId = await page.evaluate(async () => {
        const S = AtriumLibrarySources, L = AtriumLibrary, d = AtriumNavHost.project().library[0];
        L.sourceStore.save([{id: "file-probe", name: "Portable parts", defs: [{...d, value: "original"}]}]);
        AtriumLibrary.mountPanel().render();
        const id = "two-window-index", idx = S.emptyIndex();
        S.ingest(idx, {path: "LICENSE", size: 5, mtime: 1}, "terms");
        await S.db.writeIndex(id, idx, S.emptyIndex(), ["LICENSE"], []);
        demand.base = await S.db.readIndex(id);
        const rec = {id: "peer-folder", name: "Peer folder", kind: "files"}, path = "components/shared.json";
        const raw = {id: "shared", name: "Before", symbol: {pins: [{number: "1", name: "A", x: 0, y: 0}], shapes: []}};
        const files = new Map([[path, {data: JSON.stringify(raw), mtime: 1}]]), provider = S.providers.memory(files);
        S.addFolder(rec);
        const first = await S.scan(rec, {provider});
        const get = IDBObjectStore.prototype.get, cursor = IDBObjectStore.prototype.openCursor;
        let blocks = 0, stamps = 0;
        IDBObjectStore.prototype.get = function(key) {
          if (this.name === "index" && Array.isArray(key) && key[1] === 0) blocks++;
          return get.call(this, key);
        };
        IDBObjectStore.prototype.openCursor = function(range) {
          if (this.name === "index" && range?.lower?.[1] === 0) blocks++;
          if (this.name === "index" && range?.lower?.[1] === "") stamps++;
          return cursor.call(this, range);
        };
        try {
          const same = await S.scan(rec);
          if (!same.reuse || same.stats.read || blocks || !stamps || same.library.indexGeneration !== first.library.indexGeneration)
            throw Error("Unchanged worker scan should need only file stamps");
        } finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.openCursor = cursor; }
        demand.peerEdit = {rec, path, data: JSON.stringify({...raw, name: "After peer edit"}), mtime: 2};
        files.set(path, {data: demand.peerEdit.data, mtime: 2});
        const stalled = S.providers.memory(new Map([[path, {data: JSON.stringify({...raw, name: "Obsolete edit"}), mtime: 3}]]));
        const read = stalled.read.bind(stalled);
        stalled.read = async p => {
          await new Promise(resolve => { demand.resumeStaleScan = resolve; });
          return read(p);
        };
        demand.staleScan = S.scan(rec, {provider: stalled}).then(() => "", e => e.message);
        return d.id;
      });
      await page.waitForFunction(() => !!demand.resumeStaleScan);
      await source.selectOption("project");
      await panel.locator('.lib-row[data-def="' + projectId + '"]').click();
      // Save to library… is in the component's "More component actions" menu.
      await panel.locator(".lib-detail").getByRole("button", {name: "More component actions", exact: true}).click();
      await page.getByRole("menuitem", {name: "Save to library…", exact: true}).click();
      const saveDialog = page.getByRole("dialog", {name: / to a library$/});
      await saveDialog.getByLabel("Target library").selectOption("file-probe");
      const peer = await page.context().newPage();
      try {
        await peer.goto(page.url());
        await peer.evaluate(async incoming => {
          await AtriumLazy.need("AtriumLibrarySourcesUI");
          const store = AtriumLibrary.sourceStore, list = store.list(), lib = list.find(l => l.id === "file-probe");
          lib.defs[0].value = "approved in peer"; if (!store.save(list)) throw Error("Peer registry save failed");
          const S = AtriumLibrarySources, id = "two-window-index", old = await S.db.readIndex(id);
          const next = {...old, files: {LICENSE: {...old.files.LICENSE, mtime: 2}}};
          await S.db.writeIndex(id, next, old, ["LICENSE"], []);
          const {rec, path, data, mtime} = incoming;
          await S.scan(rec, {provider: S.providers.memory(new Map([[path, {data, mtime}]]))});
        }, await page.evaluate(() => demand.peerEdit));
        await page.bringToFront();
        await saveDialog.getByRole("button", {name: "Save and export .atrlib"}).click();
        await saveDialog.getByText(/changed in another window/).waitFor();
        assert.equal(await page.evaluate(() => AtriumLibrary.sourceStore.list()[0].defs[0].value), "approved in peer");
        const conflict = await page.evaluate(async () => {
          const S = AtriumLibrarySources, id = "two-window-index"; let rejected = false;
          try { await S.db.writeIndex(id, demand.base, demand.base, ["LICENSE"], []); } catch { rejected = true; }
          const index = await S.db.readIndex(id); await S.db.deleteIndex(id);
          demand.resumeStaleScan();
          const workerConflict = await demand.staleScan;
          if (!workerConflict.includes("Another window changed this library index")) throw Error("A stale worker scan committed after its peer");
          const fresh = await S.scan(demand.peerEdit.rec);
          await S.removeFolder(demand.peerEdit.rec.id);
          return [rejected, index.files.LICENSE.mtime, fresh.library.defs[0].name, fresh.stats.read];
        });
        assert.deepEqual(conflict, [true, 2, "After peer edit", 0]);
        await saveDialog.getByRole("button", {name: "Cancel", exact: true}).click();
      } finally { await peer.close(); }
      await page.reload();
      const reopened = await page.evaluate(async () => {
        await AtriumLazy.need("AtriumLibrarySourcesUI");
        const S = AtriumLibrarySources, lib = S.libraries().find(l => l.folder === "probe-folder");
        if (!lib.unopened) throw Error("Unexpected eager catalogue load");
        await S.openMetadata(lib.folder);
        const next = S.library(lib.folder);
        return [next.defs.length, next.defs.every(d => !!d.stub)];
      });
      assert.deepEqual(reopened, [cold.rows, true], "the saved catalogue reopens without a source grant or geometry");
      await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumLibrary", "AtriumTranslatorClient"]);
      const L = AtriumLibrary, host = AtriumNavHost, native = globalThis.AtriumHost, reports = [], infos = [];
      const path = "/fixture/catalogue.atrlib", seed = AtriumParts.catalogue.find(d => d.id === "std-r");
      const gone = {...seed, id: "registry-gone"}, keep = {...seed, id: "registry-kept"};
      const family = def => ({id: "registry-family", name: "Devices", members: [{defId: def.id, part: "R"}]});
      const tombstone = {id: gone.id, rev: 2, deleted: true, date: "2026-11-24"};
      const file = (lib, filePath) => ({name: "catalogue.atrlib", path: filePath,
        bytes: new TextEncoder().encode(L.libraryFile({id: "registry-fixture", ...lib}).text)});
      let session = 1, next, duringRead;
      const done = () => { ++globalThis.registryReloads; };
      globalThis.registryReloads = 0;
      globalThis.AtriumNavHost = {...host, fileSession: () => session, showImportReport: (...args) => reports.push(args)};
      globalThis.AtriumHost = {...native, readFile: async requested => {
        if (requested !== path) throw Error("Unexpected library path " + requested);
        duringRead?.(); return next;
      }};
      const ctx = {info: message => infos.push(message)};
      globalThis.registryFixture = {L, reports, infos, restore: () => {
        document.querySelector('dialog[aria-label="Library sources"]')?.close();
        globalThis.AtriumNavHost = host; globalThis.AtriumHost = native;
      }, set: kind => {
        next = kind === "foreign" ? file({id: "different-library", name: "Wrong", defs: [keep]}) :
          file({name: kind === "stale" ? "Stale session" : "Reloaded fixture", defs: [keep], tombstones: [tombstone], ...(kind === "stale" ? {componentFamilies: [family(keep)]} : {})});
        duringRead = kind === "stale" ? () => { ++session; } : undefined;
      }, read: () => L.sourceStore.list().find(lib => lib.id === "registry-fixture"),
      openWithoutPath: () => L.openLibraryFile(ctx, file({name: "Pathless open", defs: [keep]}))};
      const opened = await L.openLibraryFile(ctx, file({name: "Registry fixture", defs: [gone, keep], componentFamilies: [family(gone)]}, path));
      if (opened?.componentFamilies?.[0].members[0].defId !== gone.id) throw Error("Opening failed to retain the family");
      L.manageLibraries(ctx, done);
    });
    try {
      const table = page.getByRole("dialog", {name: "Library sources", exact: true});
      for (const [index, kind, name, family, reports] of [[1,"good","Reloaded fixture",null,2],[2,"foreign","Reloaded fixture",null,2],[3,"stale","Stale session","registry-kept",2]]) {
        await page.evaluate(kind => registryFixture.set(kind), kind);
        await table.getByRole("button", {name: "Reload", exact: true}).click();
        await page.waitForFunction(index => registryReloads === index, index);
        const state = await page.evaluate(() => {
          const {read, reports, infos} = registryFixture, lib = read();
          return [lib.name, lib.path, lib.defs.map(d => d.id), lib.tombstones.map(t => t.id),
            lib.componentFamilies?.[0].members[0].defId ?? null, reports.length,
            reports.at(-1)[3].adopt, infos.at(-1)];
        });
        assert.deepEqual(state.slice(0, 7), [name, "/fixture/catalogue.atrlib", ["registry-kept"], ["registry-gone"], family, reports, false]);
        if (kind === "foreign") assert.match(state[7], /different library/);
      }
      assert.equal(await page.evaluate(async () => (await registryFixture.openWithoutPath()).path), "catalogue.atrlib");
    } finally { await page.evaluate(() => registryFixture.restore()); }
    console.log("PASS portable registry open and native-style reload: tombstone, paths, different identity and stale report");
    assert.deepEqual(errors, []);
      console.log("PASS Library demand " + JSON.stringify({...cold, open: showing, singleRowReads: selected.reads, singleRowBytes: preview.bytes - before.bytes, stableListReplacementsAfterSelect: preview.replacements - before.replacements, persistentFiles: persistent.rows, revisions}));
    } finally { await context.close(); }
  }
};
