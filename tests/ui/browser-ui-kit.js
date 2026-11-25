"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const appURL = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const focused = node => node.evaluate(el => el === document.activeElement);
const labels = node => node.evaluate(el => [...el.querySelectorAll("button")].map(button => button.textContent));

module.exports = async function uiKit(browser) {
  for (const [platform, preset, touch] of [["MacIntel", "dark", false], ["Win32", "light", false], ["Linux x86_64", "dark", true]]) {
    const page = await browser.newPage({hasTouch:touch, viewport:{width:touch ? 390 : 1200, height:800}, reducedMotion:"reduce"});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, "platform", {value:platform});
      Object.defineProperty(navigator, "userAgentData", {value:undefined});
    }, platform);
    try {
      await page.goto(appURL, {waitUntil:"domcontentloaded"});
      const analysisTable = await page.evaluate(async () => {
        const kit = await AtriumLazy.need("AtriumUIKit");
        const table = kit.analysisTable(["Net", "Limit"], [], () => { throw Error("No row renderer for an empty table."); },
          {tableClass:"analysis-table", empty:"No results."}).querySelector("table");
        return {columns:[...table.tHead.rows[0].cells].map(cell => [cell.textContent, cell.scope]),
          empty:[table.tBodies[0].rows[0].cells[0].colSpan,table.tBodies[0].rows[0].textContent]};
      });
      assert.deepEqual(analysisTable,{columns:[["Net","col"],["Limit","col"]],empty:[2,"No results."]});
      const ownership = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const {el, elementIn, elWithAttributes} = AtriumNavCommon;
        const body = el("label", "Project name", "ui-field-row");
        const input = elWithAttributes("input", null, "ui-field", {"data-empty":null}, {omitNull:true});
        input.value = "Schematic";
        body.append(input);
        const actions = [
          {label:"Delete", variant:"danger", default:false, size:"sm"},
          {label:"Cancel", variant:"quiet"},
          {label:"Save", primary:true, size:"lg", run:d => { d.dataset.attempted = "true"; return false; }}
        ];
        window.kit = AtriumShell.dialog({title:"Project options", body:[body], actions, sheet:true});
        const other = document.implementation.createHTMLDocument();
        const literal = elementIn(other, "span", "<b>Title</b>", "warning");
        return {other:literal.ownerDocument===other, html:literal.innerHTML, attached:literal.isConnected, absent:!input.hasAttribute("data-empty")};
      }, preset);
      assert.deepEqual(ownership, {other:true, html:"&lt;b&gt;Title&lt;/b&gt;", attached:false, absent:true});
      const dlg = page.getByRole("dialog", {name:"Project options"});
      const field = dlg.getByRole("textbox", {name:"Project name"});
      const foot = dlg.locator(".ui-dialog-actions");
      assert.ok(await focused(field));
      assert.deepEqual(await labels(foot), platform === "Win32" ? ["Save", "Delete", "Cancel"] : ["Delete", "Cancel", "Save"]);
      const presentation = await dlg.evaluate(root => {
        const reference = document.createElement("i");
        root.append(reference);
        const color = name => {
          reference.style.color = "var(" + name + ")";
          return getComputedStyle(reference).color;
        };
        reference.style.boxShadow = "var(--elev-3)";
        const css = getComputedStyle(root);
        const result = {
          sheet:root.classList.contains("ui-sheet"),
          radius:css.borderRadius === css.getPropertyValue("--r-lg"),
          surface:css.backgroundColor === color("--surface"),
          elevation:css.boxShadow === getComputedStyle(reference).boxShadow,
          padding:css.paddingTop === css.getPropertyValue("--s-16") && css.paddingInlineStart === css.getPropertyValue("--s-24"),
          fills:[...root.querySelectorAll(".ui-button")].every(node => {
            const token = {primary:"--primary", danger:"--danger-fill"}[node.dataset.variant];
            return getComputedStyle(node).backgroundColor === (token ? color(token) : "rgba(0, 0, 0, 0)");
          }),
          sizes:Object.fromEntries([...root.querySelectorAll(".ui-button")].map(node => [node.textContent, node.getBoundingClientRect().height]))
        };
        reference.remove();
        return result;
      });
      assert.deepEqual(presentation, {
        sheet:true, radius:true, surface:true, elevation:true, padding:true, fills:true,
        sizes:{Delete:touch ? 44 : 20, Cancel:touch ? 44 : 24, Save:touch ? 44 : 28}
      });
      await field.press("Shift+Tab");
      assert.ok(await focused(dlg.getByRole("button", {name:platform === "Win32" ? "Cancel" : "Save"})));
      await page.keyboard.press("Tab");
      assert.ok(await focused(field));
      await field.press("Enter");
      assert.equal(await dlg.getAttribute("data-attempted"), "true");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => window.kit.done), null);

      await page.evaluate(() => {
        const actions = [{label:"Delete", variant:"danger", default:false}, {label:"Cancel"}];
        window.kit = AtriumShell.dialog({title:"Confirm removal", actions});
      });
      const confirm = page.getByRole("dialog", {name:"Confirm removal"});
      assert.ok(await focused(confirm.getByRole("button", {name:"Cancel"})));
      await confirm.getByRole("button", {name:"Cancel"}).click();
      assert.equal(await page.evaluate(() => window.kit.done), "Cancel");
      if (platform === "MacIntel") {
        await page.locator('dialog.sp-dialog[open] [data-start-action="demo"]').click();
        await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
        await page.evaluate(() => { AtriumNavHost.act("rule-sets"); });
        const rules = page.locator("dialog.rset-dialog[open]");
        await rules.getByRole("textbox", {name:"Rule set name"}).fill("Board rule fixture");
        await rules.getByRole("button", {name:"New", exact:true}).click();
        await rules.getByRole("option", {name:/Board rule fixture/, selected:true}).waitFor();
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }

  const page = await browser.newPage();
  try {
    await page.goto(appURL, {waitUntil:"domcontentloaded"});
    await page.evaluate(() => {
      const d = document.createElement("dialog");
      d.innerHTML = `<h2>Form controls</h2>
        <form>
          <label class="ui-field-row">Name<input class="ui-field" required></label>
          <label class="ui-checkbox-row"><input class="ui-checkbox" type="checkbox">Remember</label>
          <div class="ui-tabs" role="tablist" aria-label="Views">
            <button class="ui-tab" type="button" role="tab" aria-selected="true">First</button>
            <span class="ui-tab-wrap" role="presentation">
              <button class="ui-tab" type="button" role="tab" aria-selected="false" tabindex="-1">Second</button>
              <button type="button" aria-label="Close Second">×</button>
            </span>
          </div>
          <div class="ui-segmented" role="radiogroup" aria-label="Units">
            <label class="ui-segment"><input type="radio" name="unit" checked>Metric</label>
            <label class="ui-segment"><input type="radio" name="unit">Imperial</label>
          </div>
          <footer><span class="ui-dialog-status">Ready</span><button type="submit" data-variant="primary">Apply</button></footer>
        </form>`;
      const tabs = [...d.querySelectorAll("[role=tab]")];
      tabs.forEach(tab => tab.onclick = () => tabs.forEach(item => item.setAttribute("aria-selected", String(item === tab))));
      d.querySelector("form").onsubmit = event => { event.preventDefault(); d.close("submitted"); };
      window.kit = d;
      AtriumShell.openDialog(d, {actions:d.querySelector("footer"), onClose:() => {window.formDisposed=!d.isConnected;}});
    });
    const engineering = await page.evaluate(async () => {
      const K = await AtriumLazy.need("AtriumUIKit"), values = [];
      const input = K.nullableNumber(null, value => values.push(value), {label:"Thermal rise", min:0});
      const row = K.analysisField("Thermal rise", input, "°C rise", "", "thm");
      window.kit.append(row);
      for (const value of ["0", ""]) {
        input.value = value;
        input.dispatchEvent(new Event("change", {bubbles:true}));
      }
      const actual = {values, element:row.querySelector("input") === input, label:input.getAttribute("aria-label"),
        min:input.min, step:input.step, unit:input.dataset.numericUnit};
      row.remove();
      return actual;
    });
    assert.deepEqual(engineering, {values:[0,null], element:true, label:"Thermal rise", min:"0", step:"any", unit:"Δ°C"});

    const form = page.getByRole("dialog", {name:"Form controls"});
    const field = form.getByRole("textbox", {name:"Name"});
    const status = form.locator(".ui-dialog-status"), tip = page.getByRole("tooltip");
    const longStatus = "Checking project files. ".repeat(25).trim();
    await status.hover();
    assert.equal(await status.getAttribute("data-tooltip"), null, "short status needs no tooltip");
    await status.evaluate((node, text) => { node.textContent = text; }, longStatus);
    await field.hover();
    await status.hover();
    await tip.waitFor();
    assert.equal(await tip.textContent(), longStatus, "truncated status expands on the first hover");
    const first = form.getByRole("tab", {name:"First"}), second = form.getByRole("tab", {name:"Second"});
    const indicator = node => node.evaluate(el => {
      const style = getComputedStyle(el, "::after");
      return {edge:style.insetBlockEnd, size:style.blockSize};
    });
    const unwrapped = await indicator(first);
    assert.deepEqual(unwrapped, {edge:"0px", size:"2px"});
    await first.press("ArrowRight");
    assert.ok(await focused(second));
    assert.equal(await second.getAttribute("aria-selected"), "true");
    assert.equal(await first.getAttribute("tabindex"), "-1");
    assert.equal(await second.evaluate(node => getComputedStyle(node, "::after").content), "none");
    assert.deepEqual(await indicator(form.locator(".ui-tab-wrap")), unwrapped);
    await second.press("Home");
    assert.ok(await focused(first));
    const metric = form.getByRole("radio", {name:"Metric"});
    await metric.press("ArrowRight");
    assert.ok(await form.getByRole("radio", {name:"Imperial"}).isChecked());
    const remember = form.getByRole("checkbox", {name:"Remember"});
    await remember.press("Space");
    assert.ok(await remember.isChecked());

    await form.evaluate(d => {
      const opener = document.createElement("button");
      opener.type = "button"; opener.textContent = "More details";
      window.detailOpener = opener;
      window.detailClosures = 0;
      opener.onclick = () => {
        const details = document.createElement("dialog");
        details.innerHTML = '<h2>Details</h2><button type="button">Close</button>';
        const close = details.querySelector("button");
        close.onclick = () => details.close();
        AtriumShell.openDialog(details, {initialFocus:close, onClose:() => {window.detailClosures++;}});
      };
      d.append(opener);
    });
    const opener = form.getByRole("button", {name:"More details"});
    const details = page.getByRole("dialog", {name:"Details"});
    await opener.click();
    await details.waitFor();
    assert.ok(await focused(details.getByRole("button", {name:"Close"})));
    await page.mouse.click(1,1);
    assert.equal(await page.evaluate(() => window.kit.open), true);
    await details.waitFor();
    await page.keyboard.press("Escape");
    await details.waitFor({state:"detached"});
    await page.waitForFunction(() => document.activeElement === window.detailOpener);

    await opener.click();
    await details.waitFor();
    await page.evaluate(() => {
      window.detailOpener.remove();
      window.detailOpener.focus = () => {window.focusedDetachedOpener=true;};
    });
    await page.keyboard.press("Escape");
    await details.waitFor({state:"detached"});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(await page.evaluate(() => [window.kit.open, window.detailClosures, !!window.focusedDetachedOpener]),
      [true,2,false]);

    await field.press("Enter");
    await form.waitFor();
    await field.fill("Retained form validation");
    await field.press("Enter");
    await page.waitForFunction(() => !window.kit.isConnected && window.formDisposed === true);
    assert.deepEqual(await page.evaluate(() => [window.kit.returnValue,window.formDisposed]), ["submitted",true]);
  } finally { await page.close(); }
  console.log("PASS shared UI kit in Chromium · button themes and sizes, platform order, safe defaults, forms, keyboard selection and nested modal focus");
};

function checkNativeActionButtons() {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const root = path.join(__dirname, "../..");
  const retired = [
    "app/analysis/pdn-view.js", "app/analysis/thermal-view.js", "app/analysis/si.js", "app/analysis/stress.js",
    "app/formats/release-ui.js", "app/formats/fab-profiles.js", "app/pcb/stackup.js"
  ];
  for (const file of retired) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(/\bfunction button\s*\(/.test(source), false, file + " restored a local button factory");
    assert.equal(source.includes("AtriumUI.nativeButton"), true, file);
  }
  assert.match(fs.readFileSync(path.join(root, "app/formats/release-ui.js"), "utf8"), /ariaLabel: title/);
  assert.match(fs.readFileSync(path.join(root, "app/pcb/stackup.js"), "utf8"), /ariaLabel: title/);
  const css = fs.readFileSync(path.join(root, "app/ui/controls.css"), "utf8");
  assert.match(css, /\.ui-button\[data-variant=primary\][\s\S]{0,500}?--ui-button-fill:var\(--primary\)/);
  assert.match(css, /\.ui-button\[data-variant=danger\][\s\S]{0,240}?--ui-button-fill:var\(--danger-fill\)/);

  const doc = {activeElement: null};
  function create(tag) {
    const attrs = new Map(), classes = new Set(), listeners = new Map();
    let typeValue = "";
    const node = {
      tagName: String(tag).toUpperCase(), form: null, disabled: false, title: "", textContent: "", onclick: null, dataset: {},
      tabIndex: String(tag).toUpperCase() === "BUTTON" ? 0 : -1,
      classList: {
        add(...names) { for (const name of names) if (name) classes.add(name); },
        remove(...names) { for (const name of names) classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); for (const name of String(value || "").split(/\s+/)) if (name) classes.add(name); },
      setAttribute(name, value) { attrs.set(name, String(value)); if (name === "type") typeValue = String(value); if (name === "class") node.className = String(value); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      hasAttribute(name) { return attrs.has(name); },
      matches(selector) { return String(selector).split(",").some(part => { const item = part.trim(); return item.startsWith(".") && classes.has(item.slice(1)); }); },
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      focus() { if (node.tagName === "BUTTON" ? !node.disabled : node.tabIndex >= 0) doc.activeElement = node; },
      click() {
        if (node.disabled) return;
        const event = {type: "click", target: node, currentTarget: node};
        if (typeof node.onclick === "function") node.onclick(event);
        for (const fn of listeners.get("click") || []) fn(event);
      }
    };
    Object.defineProperty(node, "type", {get() { return typeValue; }, set(value) { typeValue = value == null ? "" : String(value); attrs.set("type", typeValue); }});
    return node;
  }
  doc.createElement = create;
  globalThis.document = doc;
  vm.runInThisContext(fs.readFileSync(path.join(root, "app/ui/dialog.js"), "utf8"), {filename: "app/ui/dialog.js"});
  vm.runInThisContext(fs.readFileSync(path.join(root, "app/ui/kit.js"), "utf8"), {filename: "app/ui/kit.js"});
  const nameOf = node => node.getAttribute("aria-label") || node.textContent || node.title || "";
  const roleOf = node => node.getAttribute("role") || (node.tagName === "BUTTON" ? "button" : "generic");
  // Enter and Space activate an enabled native button. This is the HTML precondition, not a browser dispatcher.
  function keyActivates(node, key) {
    if (key !== "Enter" && key !== " ") return false;
    if (node.tagName !== "BUTTON" || (node.type !== "button" && node.type !== "submit") || node.disabled) return false;
    let fired = 0;
    node.addEventListener("click", () => { fired += 1; });
    node.click();
    return fired === 1;
  }
  const kept = doc.createElement("button");
  kept.textContent = "Keep"; kept.className = "already"; kept.type = "button";
  assert.equal(AtriumUI.button(kept, "quiet", "sm"), kept);
  assert.equal(kept.dataset.variant, "quiet");
  assert.equal(kept.dataset.size, "sm");
  assert.equal(kept.classList.contains("ui-button"), true);
  const adoptedTab = doc.createElement("button");
  adoptedTab.className = "ui-tab"; adoptedTab.type = "button";
  AtriumUI.button(adoptedTab);
  assert.equal(adoptedTab.classList.contains("ui-button"), true, "adopt-only keeps ui-button on a tab");
  let primaryClicks = 0, dangerClicks = 0;
  const primary = AtriumUI.nativeButton("Save", () => { primaryClicks += 1; }, "is-primary", "Save board");
  const danger = AtriumUI.nativeButton("Delete", () => { dangerClicks += 1; }, "vs-danger", "Delete item");
  primary.focus();
  assert.equal(doc.activeElement, primary);
  danger.focus();
  assert.equal(doc.activeElement, danger);
  assert.equal(primary.type, "button");
  assert.equal(danger.type, "button");
  assert.equal(roleOf(primary), "button");
  assert.equal(roleOf(danger), roleOf(primary));
  assert.equal(nameOf(primary), "Save");
  assert.equal(primary.getAttribute("aria-label"), null);
  assert.equal(nameOf(danger), "Delete");
  assert.equal(primary.dataset.variant, "primary");
  assert.equal(danger.dataset.variant, "danger");
  assert.equal(primary.classList.contains("ui-button"), true);
  assert.equal(danger.classList.contains("ui-button"), true);
  assert.equal(keyActivates(primary, "Enter"), true);
  assert.equal(keyActivates(primary, " "), true);
  assert.equal(keyActivates(danger, "Enter"), true);
  assert.equal(keyActivates(danger, " "), true);
  assert.equal(primaryClicks, 2);
  assert.equal(dangerClicks, 2);
  const generic = doc.createElement("span");
  generic.tabIndex = 0; generic.textContent = "Delete"; generic.dataset.variant = "danger";
  generic.focus();
  assert.equal(doc.activeElement, generic);
  assert.equal(roleOf(generic), "generic");
  assert.equal(keyActivates(generic, "Enter"), false);
  assert.equal(keyActivates(generic, " "), false);
  assert.notEqual(roleOf(generic), roleOf(primary));
  const tab = AtriumUI.nativeButton("Views", () => {}, "pdn-tab ui-tab");
  const segment = AtriumUI.nativeButton("A", () => {}, "ui-segment");
  assert.equal(tab.classList.contains("ui-button"), false);
  assert.equal(segment.classList.contains("ui-button"), false);
  assert.equal(tab.type, "button");
  const apply = AtriumUI.nativeButton("Apply profile", () => {}, "fp-go");
  assert.equal(apply.dataset.variant, "primary");
  assert.equal(apply.classList.contains("ui-button"), true);
  const named = AtriumUI.nativeButton("Release", () => {}, "is-primary", "Run pre-flight, then make the versioned release package", {ariaLabel: "Run pre-flight, then make the versioned release package"});
  assert.equal(nameOf(named), "Run pre-flight, then make the versioned release package");
  assert.equal(named.dataset.variant, "primary");
  let kitClicks = 0, blocked = 0;
  const kitButton = AtriumUIKit.button("Pause", {variant: "secondary", size: "sm", title: "Pause run", pressed: false, run() { kitClicks += 1; }});
  assert.equal(kitButton.type, "button");
  assert.equal(kitButton.dataset.variant, "secondary");
  assert.equal(kitButton.dataset.size, "sm");
  assert.equal(kitButton.getAttribute("aria-pressed"), "false");
  assert.equal(kitButton.classList.contains("ui-button"), true);
  assert.equal(nameOf(kitButton), "Pause");
  kitButton.click();
  assert.equal(kitClicks, 1);
  const disabled = AtriumUIKit.button("Delete", {variant: "danger", disabled: true, pressed: true, run() { blocked += 1; }});
  assert.equal(disabled.getAttribute("aria-pressed"), "true");
  assert.equal(keyActivates(disabled, "Enter"), false);
  assert.equal(keyActivates(disabled, " "), false);
  disabled.click();
  assert.equal(blocked, 0);
}

if (require.main === module && process.argv.includes("--native-button")) {
  checkNativeActionButtons();
  console.log("PASS UI03 native action button");
} else if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => { console.error(error); process.exitCode = 1; });
}
