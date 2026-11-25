"use strict";

// Each case makes the editor reach its normal canvas or review surface.
const assert = require("node:assert/strict");

function cases(page) {
  const dialog = name => page.getByRole("dialog", {name, exact:typeof name === "string"});
  const button = (scope, name) => scope.getByRole("button", {name, exact:typeof name === "string"});
  const act = action => page.evaluate(action => { AtriumNavHost.act(action); }, action);
  const pick = kind => page.evaluate(async kind => {
    const host = AtriumNavHost;
    const doc = host.documentRefs().find(doc => doc.kind === kind);
    await host.selectDocument(doc.id);
    host.select([]);
  }, kind);
  const waitDialog = async name => { const target = dialog(name); await target.waitFor(); return target; };
  const placement = page.getByRole("region",{name:"Placement properties",exact:true});
  const powerNet = placement.getByRole("textbox",{name:"Net",exact:true});
  const startReview = () => page.evaluate(async () => {
    const view = await AtriumLazy.need("AtriumDiffView"), host = AtriumNavHost;
    const before = structuredClone(host.project()), board = host.doc();
    const track = before.documents.find(doc => doc.id === board.id).items.find(item => item.kind === "track");
    track.points.at(-1)[0] += 2;
    // An imported pin table with no drawn wiring still compares against the original sheet.
    const sheet = before.documents.find(doc => doc.kind === "schematic");
    sheet.items = sheet.items.filter(item => item.kind === "part");
    await view.start({project:before,label:"Before routing"}, {project:host.project(),label:"Working design",working:true}, {doc:board.id});
  });
  const startPair = async () => {
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumCollabPresence", "AtriumHistoryPanel"]);
      if (!AtriumCollabLive.active()) await AtriumCollabLive.start("pair");
    });
    await page.waitForFunction(() => AtriumCollabLive.session()?.connection === "open");
  };
  return [
    {
      name:"PCB multi-selection design rule warning",
      async open() {
        await pick("pcb");
        await page.evaluate(async () => {
          await AtriumLazy.need(["AtriumPCBSelectionInspector", "AtriumRules"]);
          const h = AtriumNavHost;
          h.select(h.doc().items.filter(item => item.kind === "track").slice(0,2).map(item => item.id));
        });
        const width = page.locator("#inspector").getByRole("textbox", {name:"Width",exact:true});
        await width.fill("0.001mm");
        await width.press("Tab");
        await waitDialog("Design rule check");
      },
    },
    {
      name:"PCB snap options from the status bar",
      async open() {
        await pick("pcb");
        await page.locator('[data-action="snap-options"]').first().click();
        await waitDialog("Snap options");
      },
    },
    {
      name:"Suggested DRC fixes on a real width violation",
      async open() {
        await pick("pcb");
        await page.evaluate(() => {
          const h = AtriumNavHost, board = h.doc();
          h.edit(() => board.items.push({kind:"track",id:Atrium.id(),net:"FIXTURE",layer:"Top",width:.025,points:[[4,2],[8,2]]}), "Add narrow trace");
          h.act("drc");
        });
        await page.locator(".drc-fix-row:visible").first().click();
        await waitDialog("Suggested fixes");
      },
    },
    {
      name:"Design Insight on an acute trace corner",
      async open() {
        await pick("pcb");
        await page.evaluate(async () => {
          const ui = await AtriumLazy.need("AtriumInsightsUI"), h = AtriumNavHost, board = h.doc();
          h.edit(() => board.items.push({kind:"track",id:Atrium.id(),net:"CORNER",layer:"Top",width:.25,points:[[4,18],[14,18],[6,10]]}), "Add acute corner");
          ui.setEnabled(true);
          ui.schedule({now:true});
        });
        await page.waitForFunction(() => AtriumInsightsUI.current().length > 0);
        await act("insights-next");
        await page.locator('.insight-card[role="dialog"]:visible').waitFor();
      },
    },
    {
      name:"Support component placement proposal",
      async open() {
        await pick("pcb");
        await page.evaluate(async () => {
          const S = await AtriumLazy.need("AtriumSupportPlace"), h = AtriumNavHost, board = h.doc();
          const capacitor = board.items.find(item => item.ref === "C2"), target = board.items.find(item => item.ref === "U1");
          const pad = h.defs().get(target.def).footprint.pads[0];
          h.edit(() => {
            capacitor.x = 45;
            S.setOverride(board,capacitor.id,{kind:"decoupling",ref:target.ref,pin:pad.number});
          }, "Move a decoupling capacitor off-board");
          h.act("place-support");
        });
        await waitDialog("Place Support Components");
      },
    },
    {
      name:"Schematic power port placement properties",
      async open() {
        await pick("schematic");
        await page.evaluate(() => {
          if (!document.body.classList.contains("hide-right")) AtriumNavHost.act("toggle-right");
        });
        await page.locator("#inspector").waitFor({state:"hidden"});
        await act("sch-power");
        await page.waitForFunction(() => AtriumNavHost.tool() === "sch-place");
        await page.evaluate(() => AtriumLazy.need("AtriumSchPlace"));
        await page.locator("#canvas").press("Tab");
        await powerNet.waitFor();
        assert.ok(await powerNet.evaluate(field => field === document.activeElement), "Tab focuses the placement net field");
        await placement.getByRole("combobox",{name:"Style",exact:true}).waitFor();
        await placement.getByRole("checkbox",{name:"Show net name",exact:true}).waitFor();
      },
      async finish() {
        const net = "GEOMETRY_TEST_POWER";
        await powerNet.fill(net);
        await page.locator("#canvas").click({position:{x:120,y:120}});
        await placement.waitFor({state:"hidden"});
        await page.waitForFunction(net => AtriumNavHost.doc().items.some(item => item.kind === "power" && item.text === net), net);
        assert.equal(await page.evaluate(() => AtriumSchPlace.isOpen()), false, "Placement closes its Properties controls");
      },
    },
    {
      name:"Canvas annotation comment composer",
      async open() {
        await pick("schematic");
        await act("comment-mode");
        await page.waitForFunction(() => globalThis.AtriumReviewAnnotate?.isOn());
        const box = await page.locator("#canvas").boundingBox();
        const x = box.x + box.width * .4, y = box.y + box.height * .4;
        await page.mouse.move(x,y);
        await page.mouse.down();
        await page.mouse.move(x+72,y+48,{steps:4});
        await page.mouse.up();
        await page.locator('.ann-composer[role="dialog"]:visible').getByRole("textbox").first().waitFor();
      },
    },
    {
      name:"3D View options on the Sensor board",
      async open() {
        await page.evaluate(() => globalThis.AtriumReviewAnnotate?.exit());
        await pick("pcb");
        await act("view-3d");
        const bar = page.getByRole("toolbar",{name:"3D view",exact:true});
        await button(bar,"View options").click();
        await waitDialog("3D view options");
      },
    },
    {
      name:"Comparison before and after revision choices",
      async open() {
        await act("view-2d");
        await page.evaluate(async () => {
          const diff = await AtriumLazy.need("AtriumDiffView");
          diff.open({fallback:true});
        });
        await (await waitDialog("Compare")).getByRole("combobox",{name:"Before",exact:true}).waitFor();
      },
    },
    {
      name:"Comparison component match evidence",
      async open() {
        await startReview();
        await button(page,/^Component matches/).click();
        await (await waitDialog("Component matches")).getByRole("table").waitFor();
      },
    },
    {
      name:"Comparison routing changes per net",
      async open() {
        await page.locator(".dv-routing").click();
        await (await waitDialog("Routing delta")).getByRole("table").waitFor();
      },
    },
    {
      name:"Comparison design rule differences",
      async open() {
        await page.locator(".dv-drc").click();
        await (await waitDialog("DRC delta")).getByRole("heading",{name:/New violations/}).waitFor();
      },
    },
    {
      name:"Comparison reports different schematic connectivity sources",
      async open() {
        await page.locator(".dv-warn").click();
        await (await waitDialog("Comparison warnings")).getByText(/netlists come from different sources/).waitFor();
      },
    },
    {
      name:"Comparison invalidated by a working design edit",
      async open() {
        await page.evaluate(() => {
          const h = AtriumNavHost, track = h.doc().items.find(item => item.kind === "track");
          if (!AtriumDiffView.session()) throw Error("Open the working comparison first.");
          h.edit(() => {track.width += .01;}, "Change the working trace width");
        });
        await waitDialog("The working design changed");
      },
    },
    {
      name:"History branch leaving the live project confirmation",
      async open() {
        await page.evaluate(async () => {
          const h = AtriumNavHost;
          await AtriumLazy.need("AtriumUndoStore");
          const tweak = (width, label) => h.edit(() => {h.doc().items.find(item => item.kind === "track").width += width;}, label);
          tweak(.01,"First trace width");
          tweak(.02,"Second trace width");
          h.act("undo");
          tweak(.03,"Alternate trace width");
        });
        await startPair();
        await act("history-panel");
        const branches = page.locator("summary",{hasText:/^Alternate branches/});
        await branches.click();
        await button(page,"Open privately…").first().click();
        await waitDialog("Leave the live session?");
      },
    },
    {
      name:"History restore confirmation for a real shared checkpoint",
      async open() {
        await startPair();
        await page.evaluate(() => AtriumHistoryPanel.openTimeline());
        await button(page,"Save checkpoint").click();
        const checkpoint = page.locator(".hist-time").filter({hasText:"Checkpoint"}).first();
        await checkpoint.waitFor();
        await page.evaluate(async () => {
          const h = AtriumNavHost, track = h.doc().items.find(item => item.kind === "track");
          h.edit(() => {track.width += .01;}, "Edit after checkpoint");
          await AtriumCollabLive.flush();
        });
        await button(checkpoint,"Review restore…").click();
        await button(page,"Restore for everyone…").click();
        const target = await waitDialog("Restore for everyone?");
        assert.ok(await button(target,"Cancel").isVisible());
      },
    },
  ];
}

module.exports = {cases};
