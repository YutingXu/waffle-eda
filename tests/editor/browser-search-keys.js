"use strict";
// The search model (docs/shortcuts.md, "Search"): one palette, opened with a starting filter.
//   /        everything (no filter)            ⌘⇧P / F1  Commands
//   ⌘F       Project (objects, nets, text)     ⌘P        Documents (quick open)
// The filter is a removable chip in the palette field. On a sheet and on a board, each key opens the
// palette with focus in its field and the right chip. Then, generically: every shortcut hint the chrome
// shows (menu items' data-hint, tooltips' data-tooltip-shortcut, keycaps' data-binding) is the key the
// key map really binds to that action in this document kind.
// Run: node tests/editor/browser-search-keys.js (NODE_PATH for Playwright Core).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// ⌘F first: the cold open (the palette module loading) must keep its filter chip too.
const KEYS = [["Meta+F", "Project"], ["/", null], ["Meta+Shift+P", "Commands"], ["F1", "Commands"], ["Meta+P", "Documents"]];

module.exports = async function searchKeys(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", {value: "MacIntel"}));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    assert.equal(await page.locator(".nav-command-centre").count(), 0, "the app bar has no Search field");
    const palette = page.locator("#palette"), input = palette.getByRole("combobox"), chip = palette.locator(".nav-palette-scope-chip");
    for (const kind of ["pcb", "schematic"]) {
      await page.evaluate(k => {const d = AtriumNavHost.project().documents.find(x => x.kind === k); return AtriumNavHost.selectDocument(d.id);}, kind);
      await page.waitForFunction(k => AtriumNavHost.doc().kind === k, kind);
      for (const [key, filter] of KEYS) {
        await page.locator("canvas#canvas").focus();
        await page.keyboard.press(key);
        await input.waitFor();
        await page.waitForFunction(() => document.activeElement?.matches("#palette [role=combobox]"));
        assert.equal(await input.inputValue(), "", kind + " " + key + ": the field starts empty");
        if (filter) {
          await chip.waitFor();
          assert.equal((await chip.textContent()).trim(), filter, kind + " " + key + " filter");
          assert.equal(await chip.getAttribute("aria-label"), "Remove " + filter + " scope");
        } else assert.equal(await chip.isVisible(), false, kind + " " + key + ": no filter");
        await page.keyboard.press("Escape");
        await palette.waitFor({state: "hidden"});
      }
      // The chip widens the filter: ⌘F finds R1's component; removing Project shows commands too.
      await page.locator("canvas#canvas").focus();
      await page.keyboard.press("Meta+F");
      await input.fill("R1");
      await palette.getByRole("option").first().waitFor();
      const groups = () => palette.locator(".nav-palette-group").allTextContents();
      assert.ok(!(await groups()).some(g => /Commands|Settings/.test(g)), kind + ": Project lists objects only " + (await groups()));
      await input.fill("");
      await page.keyboard.press("Backspace");
      await chip.waitFor({state: "hidden"});
      await page.keyboard.press("Escape");
      await palette.waitFor({state: "hidden"});

      const jumped = await page.evaluate(async () => {
        const host = AtriumNavHost;
        const hit = AtriumPalette.entries("@").find(row =>
          row.target?.type === "part" && row.target.docId === host.currentId());
        if (!hit) throw Error("The demo has no component in the current document.");
        host.select([]);
        await hit.run();
        return {expected:hit.target.id, selection:host.selection(), focused:document.activeElement === host.canvas()};
      });
      assert.deepEqual(jumped.selection,[jumped.expected], kind + ": the palette result selects the exact object");
      assert.equal(jumped.focused,true, kind + ": an object jump returns focus to the canvas");

      // Every visible or menu hint matches the binding in effect.
      const mismatches = await page.evaluate(k => {
        const K = AtriumKeymap, out = [], state = {kind: k, tool: "select", canvas: true, selected: true, selectionCount: 2};
        const owns = (id, action) => id === action || K.command?.(id)?.action === action;
        const check = (node, action, shown, how) => {
          const want = K.hintKey(action, k);
          if (how === "visual" ? shown !== K.display(want) : shown !== want) out.push(action + " shows " + shown + " but binds " + (want || "nothing"));
          else if (want && !want.includes(" ")) {
            const id = K.resolve(want, state);
            if (id && id !== "prefix" && !owns(id, action) && !K.bindingsFor?.(action)?.some?.(b => b.key === want)) out.push(action + ": " + want + " resolves to " + id);
          }
        };
        for (const n of document.querySelectorAll("[data-action][data-hint]")) check(n, n.dataset.action, n.dataset.hint, "visual");
        // data-shortcut-action: a control whose tooltip names a related command's key (Snap options: object snap).
        for (const n of document.querySelectorAll("[data-action][data-tooltip-shortcut]")) if (n.checkVisibility()) check(n, n.dataset.shortcutAction || n.dataset.action, n.dataset.tooltipShortcut, "key");
        for (const n of document.querySelectorAll("[data-action] > .ui-shortcut[data-binding]")) check(n, n.parentElement.dataset.action, n.dataset.binding, "key");
        return out;
      }, kind);
      assert.deepEqual(mismatches, [], kind + ": hints match bindings");
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => ({headless: true, channel: "chrome"}),
    async browser => {await module.exports(browser); console.log("search keys: ok");},
    e => {console.error(e); process.exit(1);});
}
