"use strict";
// Walks the Windows list (butter.windows, task 48) through its states with a scripted window source:
// one window, many windows, a loading detached view, an unavailable writer, saved layouts (empty,
// active, missing documents, missing display, store failure), recovery (replaying, reattached,
// conflict) and a large tab collection. The native AppKit fixture covers the real host.
// node tests/native-bridge/browser-butter-windows-ui.js [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const {boot, run} = require("../support/butter-design.cjs");

run("windows", async ({browser, profile, shot}) => {
  const {page, errors} = await boot(browser, profile, {"butter.windows":true});
  try {
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumProjectWindowClient");
      const H = AtriumNavHost, docs = H.documentRefs().map(row => row.id);
      const id = n => `0000000${n}-0000-4000-8000-00000000000${n}`;
      const S = window.winFake = {
        calls:[], listeners:new Set(),
        layout:{version:1, project:H.project().id, focused:id(1), windows:[{id:id(1), tabs:docs, active:docs[0]}]},
        status:{writer:"ready", recovery:null, store:null, loading:[], window:id(1), writerWindow:true},
        saved:[], missing:[], next:2,
        emit() { for (const f of S.listeners) f(); },
      };
      window.winSource = {
        async list() { return {layout:structuredClone(S.layout), missing:S.missing}; },
        status:() => structuredClone(S.status),
        layouts:() => structuredClone(S.saved),
        doc:id => H.docById(id) ?? (/:\d+$/.test(id) ? {name:"Sheet " + (+id.split(":")[1] + 1), kind:"schematic"} : null),
        on(f) { S.listeners.add(f); return () => S.listeners.delete(f); },
        async discardPending() { S.calls.push(["discard"]); S.status.recovery = null; },
        async returnTabs(args) { S.calls.push(["return", args]); const main = S.layout.windows[0];
          for (const w of S.layout.windows.slice(1)) if (w.id === args.window || w.tabs.includes(args.tab)) { main.tabs.push(...w.tabs); w.tabs = []; }
          S.layout.windows = S.layout.windows.filter(w => w.tabs.length); },
        async run(command, args) {
          S.calls.push([command, args]);
          if (command === "move-tab-to-new-window") {
            const from = S.layout.windows.find(w => w.tabs.includes(args.tab)), w = {id:id(S.next++), tabs:[args.tab], active:args.tab,
              bounds:{display:"Studio Display", left:0, top:0, width:900, height:700}};
            from.tabs = from.tabs.filter(t => t !== args.tab); from.active = from.tabs[0];
            S.layout.windows.push(w); S.layout.focused = w.id; S.status.loading = [w.id];
          }
          if (command === "merge-all-windows") { S.layout.windows = [{...S.layout.windows[0], tabs:S.layout.windows.flatMap(w => w.tabs)}]; }
          if (command === "save-workspace-layout") {
            if (S.status.store) throw Error("The project folder is read-only.");
            S.saved = S.saved.filter(l => l.name !== args.name).map(l => ({...l, active:false}));
            S.saved.push({name:args.name, windows:S.layout.windows.length, displays:["Built-in Retina Display"], missing:[], active:true});
          }
          if (command === "restore-workspace-layout") return {missing:S.saved.find(l => l.name === args.name).missing};
          return {};
        }
      };
    });
    const dialog = page.getByRole("dialog", {name:"Windows"});
    const openList = async () => {
      await page.evaluate(() => AtriumLazy.need("AtriumWindowsUI").then(ui => ui.open({source:winSource})));
      await dialog.waitFor();
    };
    await openList();
    // One window: its tabs are listed, the saved list is empty, Merge all is unavailable.
    await dialog.getByRole("treeitem", {name:/Main window/}).waitFor();
    assert.equal(await dialog.getByRole("button", {name:"Merge all"}).isDisabled(), true);
    await dialog.getByText("No saved layouts.", {exact:false}).waitFor();
    await shot(dialog, "one-window");

    // Move a tab out: the new window loads, then many windows.
    const tabs = dialog.locator(".ui-row[data-tab]");
    const second = await tabs.nth(1).getAttribute("data-tab");
    await tabs.nth(1).hover();
    await tabs.nth(1).getByRole("button", {name:"New window"}).click();
    await dialog.locator(".ui-row[data-state=pending]").waitFor();
    await dialog.getByText("Opening…").waitFor();
    await shot(dialog, "loading-detached");
    await page.evaluate(() => { winFake.status.loading = []; winFake.emit(); });
    await dialog.locator(".ui-row[data-state=pending]").waitFor({state:"detached"});
    assert.deepEqual(await page.evaluate(() => winFake.calls[0]), ["move-tab-to-new-window", {tab:second}]);
    assert.equal(await dialog.getByRole("button", {name:"Merge all"}).isDisabled(), false);
    await shot(dialog, "many-windows");

    // Save a layout from the keyboard; it becomes the active one.
    await dialog.getByRole("button", {name:"Save layout…"}).click();
    await page.keyboard.type("Review");
    await page.keyboard.press("Enter");
    await dialog.locator('.ui-row[data-layout="Review"]').getByText("Current").waitFor();
    await page.evaluate(() => { winFake.saved.push({name:"Bring-up bench", windows:3, displays:["Studio Display", "Built-in Retina Display"], missing:["gone"], active:false},
      {name:"Travel", windows:1, displays:[], missing:[], missingDisplays:["LG UltraFine"], active:false}); winFake.emit(); });
    await dialog.getByText("1 document missing").waitFor();
    await dialog.getByText("Display unavailable").waitFor();
    await shot(dialog, "saved-layouts");
    await dialog.locator('.ui-row[data-layout="Bring-up bench"]').hover();
    await dialog.locator('.ui-row[data-layout="Bring-up bench"]').getByRole("button", {name:"Restore"}).click();
    await dialog.locator(".ui-dialog-status").getByText("1 document no longer in the project was left out.").waitFor();

    // Writer unavailable, store failure and recovery: one notice, most severe first.
    await page.evaluate(() => { winFake.status.writer = "unavailable"; winFake.status.recovery = {state:"reattaching"}; winFake.emit(); });
    await dialog.getByText("The main window is reconnecting.").waitFor();
    await shot(dialog, "writer-unavailable");
    await page.evaluate(() => { winFake.status.writer = "ready"; winFake.status.recovery = {state:"conflict", label:"Move R12"}; winFake.emit(); });
    await dialog.getByText("An edit is waiting for review.").waitFor();
    await shot(dialog, "recovery-conflict");
    await dialog.getByRole("button", {name:"Review…"}).click();
    const pending = page.getByRole("dialog", {name:"Pending edit"});
    await pending.getByText("Move R12").waitFor();
    await shot(pending, "recovery-review");
    await pending.getByRole("button", {name:"Keep pending"}).click();
    await pending.waitFor({state:"detached"});
    await page.evaluate(() => { winFake.status.recovery = {state:"replaying", label:"Move R12"}; winFake.emit(); });
    await dialog.getByText("Replaying the last edit…").waitFor();
    await page.evaluate(() => { winFake.status.recovery = {state:"reattached", label:"Move R12"}; winFake.emit(); });
    await dialog.getByText("Reconnected.").waitFor();
    await shot(dialog, "recovery-reattached");
    await page.evaluate(() => { winFake.status.recovery = null; winFake.status.store = {message:"The project folder is read-only."}; winFake.emit(); });
    await dialog.getByText("Layouts can’t be saved.").waitFor();
    assert.equal(await dialog.getByRole("button", {name:"Save layout…"}).isDisabled(), true);
    await shot(dialog, "store-failure");
    await page.evaluate(() => { winFake.status.store = null; winFake.emit(); });

    // Return a detached window, then a large collection shows eight tabs and "Show more".
    const detached = dialog.locator(".ui-row[data-window]").nth(1);
    await detached.hover();
    await detached.getByRole("button", {name:"Return"}).click();
    await page.waitForFunction(() => winFake.calls.some(([c]) => c === "return"));
    await page.evaluate(() => {
      const many = Array.from({length:40}, (_, i) => AtriumNavHost.documentRefs()[i % AtriumNavHost.documentRefs().length].id);
      winFake.layout.windows[0].tabs = [...new Set(many)];
      winFake.layout.windows.push({id:"00000009-0000-4000-8000-000000000009", tabs:many.map((t, i) => t + ":" + i).slice(0, 30), active:null});
      winFake.emit();
    });
    const big = dialog.locator(".ui-row[data-window]").nth(1);
    await big.click();
    await dialog.getByRole("treeitem", {name:/Show 22 more tabs/}).waitFor();
    await shot(dialog, "large-collection");

    // Keyboard: arrows move between rows, Left folds a window.
    await dialog.locator(".ui-row[data-window]").first().focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await dialog.locator(".ui-row[data-window]").first().getAttribute("aria-expanded"), "false");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.window), "00000009-0000-4000-8000-000000000009");
    await page.keyboard.press("Escape");
    await dialog.waitFor({state:"detached"});

    // Tear-out and drop-back on the settled strip. A drag that ends inside the window does nothing.
    const torn = await page.evaluate(async () => {
      (await AtriumLazy.need("AtriumWindowsUI")).installTabs({source:winSource});
      winFake.calls.length = 0;
      const tab = document.querySelector("#document-tabs .document-tab[data-tab]"), id = tab.dataset.tab;
      const fire = (node, type, init = {}) => node.dispatchEvent(new DragEvent(type, {bubbles:true, cancelable:true, dataTransfer:new DataTransfer(), ...init}));
      fire(tab, "dragstart");
      fire(document.body, "dragover", {clientX:300, clientY:300});
      fire(tab, "dragend", {clientX:300, clientY:300});
      const inside = winFake.calls.length;
      fire(tab, "dragstart");
      fire(document.body, "dragleave", {clientX:-4, clientY:200});
      fire(tab, "dragend", {clientX:-4, clientY:200});
      const out = winFake.calls.at(-1);
      const strip = document.getElementById("document-tabs"), data = new DataTransfer();
      data.setData("application/x-atrium-document", id);
      const over = new DragEvent("dragover", {bubbles:true, cancelable:true, dataTransfer:data});
      strip.dispatchEvent(over);
      const lit = strip.classList.contains("ui-tab-drop");
      strip.dispatchEvent(new DragEvent("drop", {bubbles:true, cancelable:true, dataTransfer:data}));
      await new Promise(r => setTimeout(r));
      return {inside, out, id, accepted:over.defaultPrevented, lit, back:winFake.calls.at(-1), cleared:!strip.classList.contains("ui-tab-drop")};
    });
    assert.equal(torn.inside, 0);
    assert.deepEqual(torn.out, ["move-tab-to-new-window", {tab:torn.id}]);
    assert.deepEqual([torn.accepted, torn.lit, torn.cleared], [true, true, true]);
    assert.deepEqual(torn.back, ["return", {tab:torn.id}]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}).then(() => console.log("PASS butter windows UI"), error => { console.error(error); process.exit(1); });
