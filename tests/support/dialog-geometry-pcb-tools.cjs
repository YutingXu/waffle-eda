"use strict";

const assert = require("node:assert/strict");

function cases(page) {
  const act = action => page.evaluate(action => { AtriumNavHost.act(action); }, action);
  const dialog = name => page.getByRole("dialog", {name, exact:true});
  const canvas = page.locator("#canvas");
  const onBoard = () => page.evaluate(async () => {
    const h = AtriumNavHost;
    await h.selectDocument(h.documentRefs().find(doc => doc.kind === "pcb").id);
    h.act("select");
    h.select([]);
  });
  return [
    {
      name:"Interactive Bus Routing picker with an authored net class",
      async open() {
        await onBoard();
        await page.evaluate(async () => {
          const h = AtriumNavHost, project = h.project(), board = h.doc();
          await AtriumLazy.need("AtriumRules");
          h.edit(() => {
            board.outline = [[-2,-3],[36,-3],[36,15],[-2,15]];
            board.items = ["DATA0","DATA1"].flatMap((net,index) => {
              const y = 2 + 4 * index;
              const pad = x => ({kind:"pad",id:Atrium.id(),number:net,net,x,y,w:.5,h:.5,shape:"rect",layer:"Top"});
              return [{kind:"track",id:Atrium.id(),net,width:.2,layer:"Top",points:[[1,y],[29,y]]},pad(1),pad(29)];
            });
            const rules = AtriumRules.create();
            rules.netClasses = {"Timing data":["DATA0","DATA1"]};
            AtriumRules.store(board,project,rules);
          }, "Prepare a two-net timing coupon");
          h.view().fit(board,h.defs(),"board");
          h.redraw();
          h.act("route-bus");
        });
        const target = dialog("Interactive bus routing");
        await target.getByRole("combobox",{name:"Group",exact:true}).selectOption("class:Timing data");
        assert.equal(await target.locator("ol > li").count(),2);
        assert.ok(await target.getByRole("button",{name:"Start",exact:true}).isEnabled());
      },
    },
    {
      name:"Length tuning properties for an active trace meander",
      async open() {
        await onBoard();
        await act("length-tune");
        await page.waitForFunction(() => AtriumNavHost.tool() === "length-tune");
        const point = await page.evaluate(() => {
          const h = AtriumNavHost, box = h.canvas().getBoundingClientRect();
          const [x,y] = h.view().worldToScreen([5,2]);
          return [box.left+x,box.top+y];
        });
        await page.mouse.click(...point);
        await page.waitForFunction(() => AtriumNavHost.liveTune()?.net === "DATA0");
        await canvas.focus();
        await page.keyboard.press("Tab");
        await dialog("Length tuning properties").getByRole("combobox",{name:"Pattern",exact:true}).waitFor();
      },
    },
    {
      name:"PCB pad placement properties",
      async open() {
        await onBoard();
        await act("pcb-pad");
        await page.waitForFunction(() => AtriumNavHost.tool() === "pcb-draw");
        await canvas.focus();
        await page.keyboard.press("Tab");
        await dialog("Place Pad properties").getByRole("combobox",{name:"Shape",exact:true}).waitFor();
      },
    },
    {
      name:"Polygon Pour properties for the board outline",
      async open() {
        await onBoard();
        await act("pcb-polygon");
        await page.locator("#inspector").getByRole("button",{name:"Pour the board outline…",exact:true}).click();
        await dialog("Polygon Pour").getByRole("combobox",{name:"Connect to Net",exact:true}).selectOption("DATA0");
        await dialog("Polygon Pour").getByRole("radio",{name:"Hatched (Tracks/Arcs)",exact:true}).check();
      },
    },
    {
      name:"Locked object confirmation from deleting a selected track",
      async open() {
        await onBoard();
        await page.evaluate(() => {
          const h = AtriumNavHost, track = h.doc().items.find(item => item.kind === "track");
          h.edit(() => {track.locked = true;}, "Lock a timing trace");
          h.select([track.id]);
          h.act("delete");
        });
        const target = dialog("Locked objects");
        const cancel = target.getByRole("button", {name:"Cancel",exact:true});
        await cancel.waitFor();
        assert.ok(await cancel.evaluate(button => button === document.activeElement));
      },
    },
    {
      name:"Modeless Coordinate Entry from the Allegro routing shortcut",
      async open() {
        await onBoard();
        await page.evaluate(async () => {
          await AtriumLazy.need("AtriumKeymapPresets");
          AtriumKeymap.setPreset("allegro");
        });
        await canvas.focus();
        await page.keyboard.press("x");
        const target = dialog("Coordinate entry");
        await target.getByRole("textbox",{name:"Command",exact:true}).waitFor();
        assert.equal(await target.evaluate(node => node.matches(":modal")),false);
      },
    },
  ];
}

module.exports = {cases};
