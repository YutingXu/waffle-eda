"use strict";

// Layers (docs/design-system.md › Layers, ui/owner-layer.js): an open app bar menu draws above floating
// panels; decorations that belong to one element join that element's layer, so what covers the element
// covers them, and they follow and are cut to the visible part of it (net-name completion over a field
// in a scrolled Properties panel, the pin-swap chip and timing readout over the canvas).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function ownerLayers(browser) {
  const page = await browser.newPage({viewport:{width:1400, height:900}, reducedMotion:"reduce"}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb" && !!globalThis.AtriumDock?.current?.());
    const top = (x, y) => page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.closest(".menu-items") ? "menu" : e.closest(".dock-float") ? "float" : e.className); }, [x, y]);

    // An open File menu draws above a floating panel under it.
    await page.evaluate(() => AtriumNavHost.act("messages"));
    const id = await page.evaluate(() => document.getElementById("inspector").closest("[data-dock-panel]").dataset.dockPanel);
    await page.evaluate(id => AtriumDock.moveTo(id, {area:"float", rect:{x:0, y:30, w:420, h:420}}), id);
    await page.waitForFunction(() => document.getElementById("inspector").closest(".dock-float"));
    await page.locator(".appbar .work-menu > summary").first().click();
    const item = await page.locator(".appbar .work-menu[open] .menu-items button").first().boundingBox();
    assert.equal(await top(item.x + item.width / 2, item.y + item.height / 2), "menu", "an open menu draws above a floating panel");
    await page.keyboard.press("Escape");
    // A scroll thumb in a floating panel moves with the panel.
    await page.evaluate(async () => { await AtriumLazy.need("AtriumOverlayScroll"); const i = document.getElementById("inspector");
      i.append(Object.assign(document.createElement("div"), {id:"tall-probe", style:"height:2000px"})); i.scrollTop = 50; AtriumOverlayScroll.show(i); });
    await page.waitForFunction(() => document.querySelector(".dock-float .ui-scroll-thumb[data-axis=v]"));
    const offset = () => page.evaluate(() => { const t = document.querySelector(".dock-float .ui-scroll-thumb[data-axis=v]").getBoundingClientRect(),
      i = document.getElementById("inspector").getBoundingClientRect(); return [Math.round(i.right - t.right), Math.round(t.top - i.top)]; });
    const before = await offset();
    await page.evaluate(() => { const f = document.querySelector(".dock-float"); f.style.left = parseFloat(getComputedStyle(f).left) + 150 + "px"; f.style.top = parseFloat(getComputedStyle(f).top) + 80 + "px"; });
    assert.deepEqual(await offset(), before, "a floating panel's scroll thumb moves with the panel");
    await page.evaluate(() => document.getElementById("tall-probe").remove());
    await page.evaluate(id => AtriumDock.moveTo(id, {area:"right", mode:"end"}), id);
    await page.waitForFunction(() => !document.getElementById("inspector").closest(".dock-float"));

    // Net-name completion over a field in Properties: in the field's layer (not the body), following the
    // panel as it scrolls and cut to what can be seen of the field.
    await page.setViewportSize({width:1400, height:460});
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumNaming"); await AtriumLazy.need("AtriumSignals");
      const p = Atrium.project("Naming", []), sch = p.documents[0];
      ["USB_DP", "USB_DM", "SPI_MOSI"].forEach((n, k) => sch.items.push({id:"l" + k, kind:"netlabel", text:n, x:0, y:k * 5}));
      AtriumSignals.attach(p);
      const inspector = document.getElementById("inspector");
      const pad = Object.assign(document.createElement("div"), {style:"height:900px"});
      const label = document.createElement("label"), input = Object.assign(document.createElement("input"), {id:"nm-probe"});
      label.append(input); inspector.append(pad, label);
      AtriumNaming.attach(input, {kind:"netlabel", project:() => p});
      inspector.scrollTop = inspector.scrollHeight;
      input.focus(); input.value = "USB_D";
      input.dispatchEvent(Object.assign(new Event("input", {bubbles:true}), {inputType:"insertText"}));
    });
    await page.waitForSelector(".nm-ghost");
    const ghost = () => page.evaluate(() => { const g = document.querySelector(".nm-ghost"), i = document.getElementById("nm-probe");
      const gr = g.getBoundingClientRect(), ir = i.getBoundingClientRect();
      return {parent:g.parentElement === document.body ? "body" : g.parentElement.id || g.parentElement.className, dy:Math.round(gr.top - ir.top),
        hidden:getComputedStyle(g).visibility === "hidden", clip:g.style.clipPath}; });
    const g0 = await ghost();
    assert.notEqual(g0.parent, "body", "the completion joins the field's layer, not the body");
    assert.equal(g0.dy, 0, "the completion sits on its field");
    await page.evaluate(() => { const i = document.getElementById("inspector"); i.scrollTop -= 40; });
    await page.waitForFunction(() => { const g = document.querySelector(".nm-ghost"), i = document.getElementById("nm-probe");
      return Math.round(g.getBoundingClientRect().top - i.getBoundingClientRect().top) === 0; }, null, {timeout:2000});
    await page.evaluate(() => { const i = document.getElementById("inspector"); i.scrollTop -= 4000; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".nm-ghost")).visibility === "hidden", null, {timeout:2000});
    await page.evaluate(() => { const i = document.getElementById("inspector"), f = document.getElementById("nm-probe");
      const fr = f.getBoundingClientRect(), ir = i.getBoundingClientRect(); i.scrollTop += fr.top + fr.height / 2 - (ir.top + i.clientTop + i.clientHeight); });
    await page.waitForFunction(() => /inset\(/.test(document.querySelector(".nm-ghost")?.style.clipPath || ""), null, {timeout:2000});
    assert.equal((await ghost()).hidden, false, "a half-shown field shows the part of its completion that can be seen");
    await page.evaluate(() => { document.getElementById("nm-probe").closest("label").previousElementSibling.remove(); document.getElementById("nm-probe").closest("label").remove(); });
    await page.setViewportSize({width:1400, height:900});

    // Canvas decorations join the canvas's layer: the pin-swap chip and the timing readout.
    const layered = await page.evaluate(async () => {
      const canvas = AtriumNavHost.canvas(), body = document.body;
      const host = AtriumLayer.layer(canvas);
      return {host:host === body ? "body" : host.id || host.className};
    });
    assert.notEqual(layered.host, "body", "a canvas's layer is inside the workbench, not the body");
    assert.deepEqual(errors, []);
    console.log("PASS layers: menus above floating panels; completion, canvas hints and readouts join their owner's layer");
  } finally { await page.close(); }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"}, ownerLayers, error => { console.error(error); process.exitCode = 1; });
module.exports = ownerLayers;
