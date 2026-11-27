"use strict";
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const { pathToFileURL } = require("node:url"),
  { chromium } = require("../support/playwright.cjs");
async function run(browser, root, shots) {
  for (const theme of ["light", "dark"]) {
    const touch = theme === "dark",
      page = await browser.newPage({
        viewport: touch ? { width: 430, height: 780 } : { width: 1380, height: 900 },
        hasTouch: touch,
        isMobile: touch,
        deviceScaleFactor: 1
      });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    try {
      await require("../fixtures/notebook-labs.cjs").profile(page);
      await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
      await page.waitForFunction(() => globalThis.AtriumStartPage?.isOpen());
      await page.evaluate(async theme => {
        AtriumStartPage.close();
        AtriumTheme.set({ preset: theme, followSystem: false, motion: "off" }, { persist: false });
        const h = AtriumNavHost;
        await h.replaceProject(Atrium.project("Equation check", []), { force: true });
        h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
        h.act("select");
        h.select([]);
        h.canvas().focus();
      }, theme);
      assert.equal(await page.evaluate(() => !!globalThis.AtriumMath || !!globalThis.AtriumMathEditor), false);
      const fullPalette = fs.existsSync(path.join(root, "app/editor/palette-actions.js")),
        at = [-5, 4];
      let expected = at;
      if (fullPalette) {
        const position = await page.evaluate(async at => {
          const h = AtriumNavHost,
            v = h.view(),
            rect = h.canvas().getBoundingClientRect();
          globalThis.AtriumCamera?.takeCamera?.(v);
          v.restoreCamera({ ...v.camera(), cx: at[0], cy: at[1], scale: 8 });
          h.redraw();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const q = v.worldToScreen(at);
          return [rect.left + q[0], rect.top + q[1]];
        }, at);
        await page.mouse.move(...position);
        await page.locator("#canvas").focus();
        await page.keyboard.press("/");
        const input = page.locator("#palette[open]").getByRole("combobox");
        await input.fill("/math V=IR");
        await page.locator("#palette .nav-palette-equation svg").waitFor();
        assert.equal(await page.locator("#palette .nav-palette-equation svg").getAttribute("aria-label"), "V=IR");
        expected = await page.evaluate(() => [...AtriumPalette.context().point]);
        await input.press("Enter");
      } else
        await page.evaluate(async at => {
          const M = await AtriumLazy.need("AtriumMathEditor"),
            h = AtriumNavHost;
          void M.open({ context: { host: h, docId: h.doc().id, point: at }, argument: "V=IR" });
        }, at);
      const editor = page.locator("dialog[data-math-editor][open]"),
        source = editor.getByLabel("TeX source"),
        apply = editor.getByRole("button", { name: "Insert equation" });
      assert.equal(await source.inputValue(), "V=IR");
      await source.fill("\\fre");
      await source.fill("\\fra");
      await editor.getByRole("option", { name: "\\frac", exact: true }).waitFor();
      await source.press("Tab");
      assert.equal(await source.inputValue(), "\\frac{}{}");
      await source.fill("𝑥+\\bad");
      await editor.locator(".math-source-problem button").click();
      assert.deepEqual(await source.evaluate(n => [n.selectionStart, n.selectionEnd]), [3, 7]);
      assert.ok(await apply.isDisabled());
      await source.fill("");
      const omega = editor.getByRole("button", { name: "Ohms" });
      if (touch) {
        const size = await omega.boundingBox();
        assert.ok(size.height >= 44 && size.width >= 44);
        await omega.tap();
      } else await omega.click();
      assert.equal(await source.inputValue(), "\\Omega ");
      const tex = String.raw`Z=\frac{1}{j\omega C}\,\mathrm{k\Omega}`;
      await source.fill(tex);
      await page.waitForFunction(
        tex =>
          document.querySelector(".math-live-preview svg")?.getAttribute("aria-label") ===
          AtriumMath.layout(tex, { display: true }).plain,
        tex
      );
      assert.ok((await editor.locator(".math-live-preview svg use").count()) >= 8);
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, "equation-" + theme + ".png") });
      }
      if (touch) await apply.tap();
      else await source.press("Control+Enter");
      await page.waitForFunction(() => AtriumNavHost.doc().items.some(i => i.math));
      const obj = await page.evaluate(() => structuredClone(AtriumNavHost.doc().items.find(i => i.math)));
      assert.equal(obj.text, tex);
      assert.ok(Math.abs(obj.x - expected[0]) < 0.0001 && Math.abs(obj.y - expected[1]) < 0.0001);
      await page.evaluate(() => AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.some(i => i.math)), false);
      await page.evaluate(() => AtriumNavHost.act("redo"));
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.math).id), obj.id);
      const center = await page.evaluate(async () => {
        const h = AtriumNavHost,
          i = h.doc().items.find(i => i.math),
          v = h.view(),
          r = h.canvas().getBoundingClientRect();
        globalThis.AtriumCamera?.takeCamera?.(v);
        const at = [i.x + i.w / 2, i.y + i.h / 2];
        v.restoreCamera({ ...v.camera(), cx: at[0], cy: at[1], scale: 6 });
        h.redraw();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const p = v.worldToScreen(at),
          settled = h.canvas().getBoundingClientRect();
        if (v.hit(h.doc(), h.defs(), at)?.id !== i.id)
          throw Error("Equation is missing from the schematic hit index after Redo");
        return [settled.left + p[0], settled.top + p[1]];
      });
      await page.mouse.dblclick(...center);
      await source.waitFor();
      assert.equal(await source.inputValue(), tex);
      await source.fill("P=IV");
      await editor.getByRole("button", { name: "Save equation" }).click();
      const edited = await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.math));
      assert.equal(edited.text, "P=IV");
      assert.equal(edited.id, obj.id);
      await page.evaluate(() => AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.math).text), tex);
      if (touch && fullPalette) {
        await page.getByRole("button", { name: "Insert at pointer", exact: true }).tap();
        const palette = page.locator("#palette[open]");
        await palette.getByRole("combobox").fill("/math");
        await palette
          .getByRole("option", { name: /^Equation/ })
          .first()
          .tap();
        await palette.getByRole("button", { name: "Insert", exact: true }).tap();
        await source.waitFor();
        await page.evaluate(() => {
          Object.defineProperty(visualViewport, "height", { value: 345, configurable: true });
          Object.defineProperty(visualViewport, "offsetTop", { value: 12, configurable: true });
          visualViewport.dispatchEvent(new Event("resize"));
        });
        const rect = await editor.boundingBox();
        assert.ok(rect.y >= 11 && rect.y + rect.height <= 358);
        await editor.getByRole("button", { name: "Ohms" }).tap();
        await editor.getByRole("button", { name: "Pi", exact: true }).tap();
        await apply.tap();
        assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.math).length), 2);
        await page.evaluate(() => {
          delete visualViewport.height;
          delete visualViewport.offsetTop;
          visualViewport.dispatchEvent(new Event("resize"));
          AtriumNavHost.act("undo");
        });
      }
      if (!touch) {
        const cdp = await page.context().newCDPSession(page);
        const penTap = async (x, y) => {
          for (const type of ["mousePressed", "mouseReleased"])
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: "left",
              clickCount: 1,
              pointerType: "pen",
              force: 0.5
            });
        };
        const box = await page.evaluate(async () => {
          const h = AtriumNavHost,
            i = h.doc().items.find(i => i.math),
            v = h.view(),
            r = h.canvas().getBoundingClientRect(),
            at = [i.x + i.w / 2, i.y + i.h / 2];
          globalThis.AtriumCamera?.takeCamera?.(v);
          v.restoreCamera({ ...v.camera(), cx: at[0], cy: at[1], scale: 6 });
          h.redraw();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const q = v.worldToScreen(at);
          return [r.left + q[0], r.top + q[1]];
        });
        await penTap(...box);
        const edit = page.getByRole("button", { name: "Edit equation", exact: true });
        await edit.waitFor();
        const target = await edit.boundingBox();
        await penTap(target.x + target.width / 2, target.y + target.height / 2);
        await source.waitFor();
        const cancel = await editor.getByRole("button", { name: "Cancel" }).boundingBox();
        await penTap(cancel.x + cancel.width / 2, cancel.y + cancel.height / 2);
        await cdp.detach();
      }
      await page.evaluate(async () => {
        const h = AtriumNavHost,
          i = h.doc().items.find(i => i.math);
        void AtriumMathEditor.open({ context: { host: h, docId: h.doc().id }, itemId: i.id });
      });
      await source.fill("stale");
      await page.evaluate(() => {
        const h = AtriumNavHost;
        h.selectDocument(h.project().documents.find(d => d.kind === "pcb").id);
      });
      await editor.getByRole("button", { name: "Save equation" }).click();
      assert.equal(
        await page.evaluate(
          () =>
            AtriumNavHost.project()
              .documents.flatMap(d => d.items)
              .find(i => i.math).text
        ),
        tex
      );
      assert.deepEqual(errors, []);
      console.log(
        "PASS " +
          theme +
          " mouse/keyboard/touch TeX editor, live SVG, exact input, stale document, Undo" +
          (fullPalette ? ", slash palette" : "")
      );
    } finally {
      await page.close();
    }
  }
}
if (require.main === module)
  (async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      await run(browser, path.resolve(process.argv[2] || path.join(__dirname, "../..")), process.argv[3]);
    } finally {
      await browser.close();
    }
  })().catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = run;
