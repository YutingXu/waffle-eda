"use strict";
const assert = require("node:assert/strict"), path = require("node:path"), {pathToFileURL} = require("node:url");
const {windowPanel} = require("../support/window-panels.cjs");

async function openDemo(page, url) {
  await page.goto(url);
  const welcome = page.locator("dialog.sp-dialog[open]");
  await welcome.locator("[data-start-action=demo]").click();
  await welcome.waitFor({state: "hidden"});
  await page.waitForFunction(() => globalThis.AtriumNavHost?.project()?.name === "Sensor interface");
}

async function restartIdentity(browser, url) {
  const fs = require("node:fs"), os = require("node:os");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "waffle-member-"));
  const program = process.argv.indexOf("--executable");
  const options = program >= 0 ? {executablePath: process.argv[program + 1]} :
    process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"};
  let context;
  try {
    const reopen = async () => {
      context = await browser.browserType().launchPersistentContext(profile, {headless: true, ...options});
      const page = await context.newPage();
      await page.goto(url);
      await page.evaluate(() => AtriumLazy.need("AtriumGroupLibraryUI").then(() => true));
      return page;
    };
    const first = await reopen();
    const persisted = await first.evaluate(async () => {
      // Upgrade an actual version-one database, including one installed and one pending unsigned part.
      const legacy = {id: "legacy-group", name: "Earlier library"}, store = AtriumLibraryStore;
      const installed = [], records = [];
      for (const [id, name] of [["old-a", "Earlier fixture"], ["old-b", "Pending fixture"]]) {
        const def = {id, name, rev: 1, state: "draft", symbol: {pins: [], shapes: []}};
        const event = {group: legacy.id, kind: "revision", component: id, parents: [], rev: 1,
          author: {id: "old-member", name: "Earlier reviewer"}, at: "2024-01-01T00:00:00.000Z",
          note: "Original proposal", hash: store.contentHash(def), def};
        event.key = store.sha256(store.canonical(event)); records.push(event);
      }
      installed.push([records[0].component, records[0].key]);
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("atrium-group-libraries", 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore("groups", {keyPath: "id"}).add({...legacy, generation: 1, heads: installed, dismissed: []});
          const rows = db.createObjectStore("records", {keyPath: ["group", "key"]});
          rows.createIndex("group", "group");
          records.forEach((event, ordinal) => rows.add({group: legacy.id, key: event.key, ordinal, event}));
        };
        open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
      });
      const upgraded = await AtriumGroupLocal.open(legacy.id);
      if (upgraded.library().defs[0]?.name !== "Earlier fixture" || upgraded.pending().length !== 1 ||
          upgraded.identityStatus(upgraded.pending()[0]).status !== "unsigned") throw Error("The old library did not survive its storage upgrade.");
      const author = await AtriumGroupLocal.member("Bench reviewer"), info = {id: "group-restart", name: "Bench library"};
      const other = {...await AtriumGroupLibrary.newSigningKey(), name: "Remote contributor"};
      const peer = AtriumGroupLibrary.create(info);
      const remote = await peer.propose({id: "remote", name: "Peer fixture", symbol: {pins: [], shapes: []}}, {author: other, note: "Remote proposal"});
      const naming = await AtriumGroupLocal.edit(info, async g => {
        await g.receive([remote]);
        await g.decide({...g.preview(remote.key), confirmedIdentities: true}, "approved", author);
        const revision = await g.propose({id: "part", name: "Fixture", symbol: {pins: [], shapes: []}}, {author, note: "First revision"});
        await g.decide(g.preview(revision.key), "approved", author);
        const conventions = await g.proposeConventions({stems: {rail: ["BENCH_RAIL"]}}, {author, note: "Bench naming"});
        await g.decide(g.preview(conventions.key), "approved", author);
        return conventions.key;
      });
      return {id: author.id, remote: remote.key, peer: other.id, naming};
    });
    await context.close(); context = null;
    const next = await reopen();
    const result = await next.evaluate(async ({remote}) => {
      const author = await AtriumGroupLocal.member("Bench reviewer");
      await AtriumGroupLocal.restore();
      const approvedNaming = AtriumGroupLocal.libraries().find(l => l.id === "group-restart")?.naming?.key;
      const g = await AtriumGroupLocal.open("group-restart");
      const old = g.events.get(g.heads.get("part"));
      const r = await AtriumGroupLocal.edit(g.info, copy => copy.propose({...old.def, value: "2"}, {parents: [old.key], author, note: "After restart"}));
      const read = await AtriumGroupLibrary.readArchive(AtriumGroupLibrary.archive(AtriumGroupLocal.current(g.info.id)));
      const forwarded = read.events.get(remote);
      return [author.id, g.identityStatus(old).status, read.events.get(r.key).author.id, author.privateKey.extractable,
        g.identityStatus(forwarded).status, forwarded.author.id, approvedNaming];
    }, persisted);
    assert.deepEqual(result, [persisted.id, "known", persisted.id, false, "known", persisted.peer, persisted.naming]);
    const local = await next.evaluate(async () => {
      const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
      const rng = crypto.getRandomValues.bind(crypto);
      Object.defineProperty(globalThis, "crypto", {value: {getRandomValues: rng}, configurable: true});
      try {
        const author = await AtriumGroupLocal.member("Local reviewer"), info = {id: "offline", name: "Local fixtures"};
        await AtriumGroupLocal.edit(info, async g => {
          const rev = await g.propose({id: "offline-part", name: "Bench part", symbol: {pins: [], shapes: []}}, {author, note: "Local component"});
          await g.decide(g.preview(rev.key), "approved", author);
        });
        const g = await AtriumGroupLocal.open("offline");
        return [author.localOnly, g.library().defs.length, g.events.size, AtriumGroupLibrary.archive(g).events.length, AtriumGroupLibrary.gitFiles(g).length];
      } finally { Object.defineProperty(globalThis, "crypto", saved); }
    });
    assert.deepEqual(local, [true, 1, 2, 0, 1]);
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, {recursive: true, force: true});
  }
}

async function namingConventions(browser, url, {theme, capture}) {
  const options = {viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"};
  const sourceContext = await browser.newContext(options), recipientContext = await browser.newContext(options);
  const open = async (context, name) => {
    const page = await context.newPage();
    await openDemo(page, url);
    await page.evaluate(async ({name, theme}) => {
      const h = AtriumNavHost, p = AtriumParts.example();
      p.name = name;
      AtriumTheme.setPreset(theme);
      await h.replaceProject(p, {force: true, dirty: false});
      h.act("signals-panel");
    }, {name, theme});
    await page.locator(".panel-signals:visible").getByRole("tab", {name: "Naming", exact: true}).click();
    return page;
  };
  const dialog = page => page.getByRole("dialog", {name: "Group library", exact: true});
  const openGroup = page => page.getByRole("button", {name: "Open Group Library…", exact: true}).click();
  const propose = page => page.getByRole("dialog", {name: /^Review proposal · Naming conventions$/});
  try {
    const source = await open(sourceContext, "Conventions source");
    await source.getByRole("textbox", {name: "Also rails: Add"}).fill("BENCH_AUX");
    await source.getByRole("textbox", {name: "Also rails: Add"}).press("Enter");
    await openGroup(source);
    await dialog(source).getByLabel("New group name").fill("Bench team");
    await dialog(source).getByRole("button", {name: "Create group"}).click();
    await dialog(source).getByLabel("Your display name").fill("Fixture author");
    await dialog(source).getByRole("button", {name: "Propose naming conventions…"}).click();
    const draft = source.getByRole("dialog", {name: "Propose naming conventions…"});
    await draft.getByText("BENCH_AUX", {exact: true}).waitFor();
    await draft.getByRole("button", {name: "Submit proposal"}).click();
    await dialog(source).getByRole("button", {name: "Review…", exact: true}).click();
    await propose(source).getByRole("button", {name: "Approve for my library"}).click();
    await propose(source).waitFor({state: "hidden"});
    const bundle = await source.evaluate(async () => {
      const lib = AtriumGroupLocal.libraries().find(l => l.name === "Bench team");
      const group = await AtriumGroupLocal.open(lib.id);
      return JSON.stringify(AtriumGroupLibrary.archive(group));
    });

    const recipient = await open(recipientContext, "Another design");
    const field = recipient.getByRole("textbox", {name: "Try a name", exact: true});
    const toggle = recipient.getByRole("checkbox", {name: "Use group conventions", exact: true});
    await field.fill("BENCH_AUX");
    await recipient.getByText(/No known meaning/).waitFor();
    assert.equal(await toggle.isChecked(), false);
    await openGroup(recipient);
    await recipient.evaluate(() => { window.showOpenFilePicker = undefined; });
    const [picker] = await Promise.all([
      recipient.waitForEvent("filechooser"),
      dialog(recipient).getByRole("button", {name: "Import bundle…"}).click()
    ]);
    await picker.setFiles({name: "bench.atrgroup", mimeType: "application/json", buffer: Buffer.from(bundle)});
    await dialog(recipient).getByLabel("Your display name").fill("Fixture reviewer");
    await dialog(recipient).getByRole("button", {name: "Review…", exact: true}).click();
    await propose(recipient).getByText("BENCH_AUX", {exact: true}).waitFor();
    const approval = propose(recipient).getByRole("button", {name: "Approve for my library"});
    assert.equal(await approval.isEnabled(), false, "the imported author still needs identity review");
    await propose(recipient).getByRole("checkbox", {name: /checked the signing key/}).check();
    await approval.click();
    await propose(recipient).waitFor({state: "hidden"});
    await recipient.keyboard.press("Escape");
    await dialog(recipient).waitFor({state: "hidden"});
    assert.equal(await toggle.isChecked(), false, "approval does not opt the project in");
    await recipient.waitForFunction(() => document.activeElement?.classList.contains("nm-group-open"));
    await toggle.check();
    await recipient.getByText(/A rail \(no voltage in the name\)/).waitFor();
    assert.equal(await toggle.isChecked(), true);
    if (capture) await capture(recipient, "naming");
    await recipient.evaluate(() => {
      const h = AtriumNavHost;
      h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    });
    await recipient.getByText(/A rail \(no voltage in the name\)/).waitFor();
    assert.equal(await toggle.isChecked(), true, "the schematic shares the project's explicit setting");
    await recipient.evaluate(() => AtriumNavHost.act("undo"));
    await recipient.getByText(/No known meaning/).waitFor();
    assert.equal(await toggle.isChecked(), false);
  } finally { await sourceContext.close(); await recipientContext.close(); }
}

module.exports = async function groupLibrary(browser, {theme = "light", capture} = {}) {
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(6000);
  const url = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
  try {
    await openDemo(page, url);
    await page.evaluate(theme => {
      const H = AtriumNavHost;
      AtriumTheme.setPreset(theme);
      const def = H.project().library.find(d => d.id === "std-opamp");
      if (!def) throw new Error("The Demo needs a component with both a symbol and a footprint.");
      H.edit(() => H.project().library.push(Atrium.clone({id: "group-probe", name: "Group fixture",
        prefix: def.prefix, symbol: def.symbol, footprint: def.footprint})));
    }, theme);
    const panel = page.locator(".panel-library:visible"), source = panel.getByRole("combobox", {name: "Library source"});
    const openPanel = async () => {
      if (!await panel.isVisible()) await windowPanel(page, "library");
      await source.waitFor();
    };
    const waitForSourceFocus = () => page.waitForFunction(() => document.activeElement?.matches(".panel-library .lib-source"));
    await openPanel();
    assert.equal(await page.evaluate(() => !!globalThis.AtriumGroupLibrary), false, "the library is cold until opened");
    await source.focus();
    await source.selectOption("@group");
    const dialog = page.getByRole("dialog", {name: "Group library", exact: true});
    await dialog.getByLabel("New group name").fill("Portable fixtures");
    await dialog.getByRole("button", {name: "Create group"}).click();
    await dialog.getByLabel("Your display name").fill("Test contributor");
    await dialog.getByRole("button", {name: "Propose revision…"}).click();
    const draft = page.getByRole("dialog", {name: "Propose a component revision"});
    await draft.getByLabel("Project component").selectOption("add:group-probe");
    await draft.getByLabel("Lifecycle after approval").selectOption("released");
    await draft.getByLabel("Change summary").fill("Propose fixture symbol and footprint");
    await draft.getByRole("button", {name: "Submit proposal"}).click();
    await draft.waitFor({state: "hidden"});
    await dialog.getByRole("button", {name: "Review…", exact: true}).click();
    const review = page.getByRole("dialog", {name: /Review proposal/});
    await review.getByRole("img", {name: "Symbol: old and new", exact: true}).waitFor();
    await review.getByRole("img", {name: "Footprint: old and new pads", exact: true}).waitFor();
    assert.equal(await page.evaluate(() => AtriumGroupLocal.libraries()[0].defs.length), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => AtriumGroupLocal.libraries()[0].defs.length), 0, "Esc preserves the pending proposal");
    await dialog.getByRole("button", {name: "Review…", exact: true}).click();
    await review.getByRole("button", {name: "Approve for my library"}).click(); await review.waitFor({state: "hidden"});
    await dialog.getByText(/Approved by Test contributor/).waitFor();
    // A directory-handle stand-in exercises the normal Save button without opening a native picker.
    // The Git suite writes these same records into an actual temporary checkout.
    await page.evaluate(() => {
      const files = new Map(); window.groupGitFixture = files;
      const folder = prefix => ({
        getDirectoryHandle(name) { return folder(prefix + name + "/"); },
        getFileHandle(name, options) {
          const path = prefix + name;
          if (!files.has(path) && !options?.create) throw new DOMException("Missing", "NotFoundError");
          return {getFile: () => ({text: () => files.get(path)}),
            createWritable: () => ({write(data) { files.set(path, data); }, close() {}})};
        }
      });
      window.showDirectoryPicker = async () => folder("");
    });
    await dialog.getByRole("button", {name: "Git", exact: true}).click();
    await dialog.getByRole("menuitem", {name: "Save to Git checkout…"}).click();
    await dialog.getByText("Git files saved in the selected checkout.").waitFor();
    const files = await page.evaluate(() => [...window.groupGitFixture.keys()]);
    assert.equal(files.filter(path => /\/records\/[0-9a-f]{64}\.json$/.test(path)).length, 2);
    const room = dialog.locator("details").filter({hasText: "Library-only session"});
    await room.locator("summary").click();
    await room.getByRole("button", {name: "Start library session"}).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Group library invitation"]')?.value.startsWith("Waffle group library"));
    assert.equal(await page.evaluate(() => !!globalThis.AtriumCollabLive?.active()), false, "the design is never shared in a library-only room");
    await room.getByRole("button", {name: "Leave library session"}).click();
    const groupId = await dialog.getByLabel("Group library", {exact: true}).inputValue();
    await page.keyboard.press("Escape");
    await dialog.waitFor({state: "hidden"});
    assert.equal(await source.inputValue(), "project", "Escape leaves the selected source unchanged");
    await waitForSourceFocus();
    await source.selectOption("@group");
    await dialog.getByText(/Approved by Test contributor/).waitFor();
    const done = dialog.getByRole("button", {name: "Done", exact: true});
    // Capture the source during the trusted Done click. Both sources contain
    // the same row ID, so testing after the modal's close event can miss the race.
    await done.evaluate(button => button.addEventListener("click", event => {
      globalThis.groupSourceOnDone = {trusted: event.isTrusted, source: document.querySelector(".panel-library .lib-source").value};
    }, {once: true}));
    await done.click();
    assert.deepEqual(await page.evaluate(() => globalThis.groupSourceOnDone), {trusted: true, source: groupId});
    await dialog.waitFor({state: "hidden"});
    await waitForSourceFocus();
    const row = panel.locator('.lib-row[data-def="group-probe"]');
    await panel.getByRole("searchbox", {name: "Search the library"}).press("ArrowDown");
    assert.equal(await row.getAttribute("aria-pressed"), "true");
    assert.equal(await row.evaluate(button => document.activeElement === button), true);
    for (const name of ["Place on sheet", "Place on board"]) {
      assert.equal(await panel.getByRole("button", {name, exact: true}).isEnabled(), true);
    }
    const state = () => page.evaluate(id => {
      const h = AtriumNavHost, library = AtriumGroupLocal.libraries().find(l => l.id === id);
      const original = h.project().library.find(d => d.id === "group-probe");
      const copies = h.project().library.filter(d => d.libraryRef?.library === id && d.libraryRef.id === "group-probe");
      const approved = library.defs.find(d => d.id === "group-probe");
      return {original, copies, approved, head: library.revisionKeys.get("group-probe"),
        steps: h.undoSteps().history.length};
    }, groupId);
    const before = await state();
    assert.deepEqual(before.copies, []);
    assert.ok(before.approved.symbol.pins.length && before.approved.footprint.pads.length);
    assert.deepEqual(before.approved.symbol, before.original.symbol);
    assert.deepEqual(before.approved.footprint, before.original.footprint);
    await panel.getByRole("button", {name: "Add to project", exact: true}).press("Enter");
    const status = page.locator('#status[role="status"]');
    await status.filter({hasText: "Group fixture added to the project from Portable fixtures"}).waitFor();
    assert.equal(await status.getAttribute("aria-live"), "polite");
    const after = await state();
    assert.equal(after.steps, before.steps + 1, "copy is one project edit");
    assert.deepEqual(after.original, before.original);
    assert.deepEqual(after.approved, before.approved);
    assert.equal(after.head, before.head);
    assert.equal(after.copies.length, 1);
    const [copy] = after.copies, sourceInfo = {ref: copy.libraryRef};
    assert.match(copy.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(copy.state, "released");
    assert.equal(sourceInfo.ref.library, groupId);
    assert.equal(sourceInfo.ref.id, "group-probe");
    assert.equal(sourceInfo.ref.groupRevision, before.head);
    assert.match(sourceInfo.ref.groupRevision, /^[0-9a-f]{64}$/);
    assert.match(sourceInfo.ref.symbol.hash, /^[0-9a-f]{16}$/);
    assert.match(sourceInfo.ref.footprint.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(copy.symbol, before.approved.symbol);
    assert.deepEqual(copy.footprint, before.approved.footprint);

    const editMenu = page.locator('details[data-menu="edit"]');
    await editMenu.locator("summary").click();
    await editMenu.getByRole("menuitem", {name: /^Undo\b/}).click();
    assert.deepEqual(await state(), before, "Undo removes only the copy, leaving the signed group intact");
    await editMenu.locator("summary").click();
    await editMenu.getByRole("menuitem", {name: /^Redo\b/}).click();
    assert.deepEqual(await state(), after, "Redo restores the exact copy and its provenance");

    // Two independently opened windows submit competing revisions. IDB serializes the two
    // writers even if both had the same cached generation, and both histories survive restart.
    const other = await context.newPage(); await other.goto(url);
    const prepare = async page => page.evaluate(async id => {
      await AtriumLazy.need("AtriumGroupLibraryUI"); await AtriumGroupLocal.open(id);
    }, sourceInfo.ref.library);
    await prepare(other);
    const edit = (target, name) => target.evaluate(async ({id, name}) => {
      const author = await AtriumGroupLocal.member(name);
      const group = AtriumGroupLocal.current(id), base = group.events.get(group.heads.get("group-probe"));
      await AtriumGroupLocal.edit(group.info, g => g.propose({...base.def, value: name}, {
        parents: [base.key], author, note: "Value " + name}));
    }, {id: sourceInfo.ref.library, name});
    const memberId = target => target.evaluate(async () => {
      const key = await AtriumGroupLocal.member("Fixture");
      if (key.privateKey.extractable) throw Error("The signing key can be exported.");
      return key.id;
    });
    const originalKey = await memberId(page);
    assert.equal(await memberId(other), originalKey, "both windows use the persistent key");
    await Promise.all([edit(page, "Left"), edit(other, "Right")]);
    await page.waitForFunction(id => AtriumGroupLocal.current(id)?.pending().length === 2, sourceInfo.ref.library);
    const snapshot = await page.evaluate(() => AtriumAutosave.flush());
    assert.equal(snapshot?.dirty, true);
    await page.reload();
    const recovery = page.getByRole("dialog", {name: "Recover unsaved work", exact: true});
    await recovery.getByRole("button", {name: "Restore", exact: true}).click();
    await recovery.waitFor({state: "hidden"});
    const restored = await page.evaluate(id => AtriumNavHost.project().library.find(d => d.id === id), copy.id);
    assert.equal(restored?.id, copy.id, "recovery preserves the project copy's identity");
    assert.equal(restored.state, copy.state);
    assert.deepEqual(restored.libraryRef, copy.libraryRef, "recovery preserves the approved source for both sides");
    assert.deepEqual(restored.symbol.pins.map(pin => pin.number), copy.symbol.pins.map(pin => pin.number));
    assert.deepEqual(restored.footprint.pads.map(pad => pad.number), copy.footprint.pads.map(pad => pad.number));
    await page.evaluate(() => {
      const h = AtriumNavHost;
      h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    });
    await openPanel();
    await page.waitForFunction(id => !!document.querySelector('.lib-source option[value="' + id + '"]'), sourceInfo.ref.library);
    await source.selectOption("@group");
    await dialog.getByRole("button", {name: "Review…", exact: true}).first().waitFor();
    assert.equal(await page.evaluate(id => AtriumGroupLocal.current(id).pending().length, sourceInfo.ref.library), 2);
    await dialog.getByRole("button", {name: "Review…", exact: true}).first().click();
    const merge = page.getByRole("dialog", {name: /Merge review/}), approve = merge.getByRole("button", {name: "Approve merge"});
    assert.equal(await memberId(page), originalKey, "reload preserves the signing key");
    assert.equal(await approve.isEnabled(), false); await merge.getByRole("radio").first().check();
    assert.equal(await approve.isEnabled(), false, "a changed display name needs explicit identity review");
    await merge.getByRole("checkbox", {name: /signing key/}).check();
    await approve.click(); await merge.waitFor({state: "hidden"});
    const heads = await page.evaluate(id => {
      const g = AtriumGroupLocal.current(id); return {head: g.events.get(g.heads.get("group-probe")), pending: g.pending().length};
    }, sourceInfo.ref.library);
    assert.equal(heads.pending, 0); assert.equal(heads.head.parents.length, 2);
    await page.keyboard.press("Escape"); await dialog.waitFor({state: "hidden"});
    await restartIdentity(browser, url);
    await namingConventions(browser, url, {theme, capture});
    assert.deepEqual(errors, []);
    console.log("PASS browser group library: symbol and footprint approval, project copy and Undo/Redo, recovery, concurrent proposals and naming");
  } finally { await context.close(); }
};
