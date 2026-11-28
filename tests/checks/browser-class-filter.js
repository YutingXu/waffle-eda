"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");
const {fields, near, textBaselines, baselineResults, failures, assertBaselinePerturbations} = require("../support/dialog-geometry.cjs");

const className = "Precision interface assembly components with long engineering provenance";
const themeModes = [{theme:"light"}, {theme:"dark"}, {theme:"hc"}, {theme:"dark", touch:true}, {theme:"light", rtl:true}];

async function check(browser, {theme, touch = false, rtl = false}) {
  const page = await browser.newPage({viewport:{width:1280,height:800},hasTouch:touch});
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const inspector = page.locator("#inspector");
    const disclosure = inspector.getByRole("button", {name:"Selection Filter",exact:true});
    if (await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
    const select = inspector.getByRole("combobox",{name:"Component class filter"});
    // Side is a segmented control now; the part's Designator is a field in the same value column.
    const designator = inspector.getByRole("textbox",{name:"Designator",exact:true});
    await select.waitFor();
    await page.evaluate(({theme,rtl,name}) => {
      AtriumTheme.setPreset(theme);
      if (rtl) document.documentElement.dir = "rtl";
      const host = AtriumNavHost, pcb = host.doc();
      host.edit(() => AtriumComponentClasses.set(pcb,name,["R1"]),"Test class",[{doc:pcb}]);
      host.select([pcb.items.find(item => item.ref === "U1").id]);
    },{theme,rtl,name:className});
    await designator.waitFor();
    const session = await page.context().newCDPSession(page);
    const geometry = await fields(page,session,inspector);
    const filter = geometry.find(row => row.name === "Component class filter");
    const comparison = geometry.find(row => row.name === "Designator");
    const control = await select.evaluate(node => {
      const row = node.closest("label");
      const style = getComputedStyle(node), option = getComputedStyle(node.options[0]);
      const rgb = value => value.match(/[\d.]+/g).slice(0,3).map(Number).map(channel => channel / 255);
      const lum = value => rgb(value).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
        .reduce((sum,n,i) => sum + n * [.2126,.7152,.0722][i],0);
      const luminances = [lum(style.color),lum(style.backgroundColor)].sort((a,b) => a - b);
      return {row:row.getBoundingClientRect().toJSON(),
        field:node.getBoundingClientRect().toJSON(),margin:parseFloat(style.borderInlineStartWidth),
        end:parseFloat(style.paddingInlineEnd),radius:parseFloat(style.borderTopLeftRadius),
        position:style.backgroundPositionX,appearance:style.appearance,
        native:node instanceof HTMLSelectElement,font:style.fontFamily,scheme:option.colorScheme,
        contrast:(luminances[1] + .05) / (luminances[0] + .05),overflow:style.textOverflow};
    });
    assert.ok(control.native && /system-ui|Segoe UI|apple-system/.test(control.font));
    assert.equal(control.appearance,"none");
    assert.equal(control.radius,6);
    assert.equal(control.end,28);
    assert.equal(control.overflow,"ellipsis");
    assert.equal(control.scheme,theme === "light" ? "light" : "dark");
    assert.ok(control.contrast >= 4.5,"field text has readable contrast");
    assert.equal(control.position,rtl ? "12px, 16px" : "calc(100% - 16px), calc(100% - 12px)");
    assert.ok(near(filter.x,comparison.x) && near(filter.width,comparison.width),"Class and Designator share a control column");
    assert.ok(near(filter.height,28) && near(comparison.height,28));
    assert.ok(near(control.row.height,touch ? 44 : 32)); // a property row: the field plus 2px above and below
    const readClass = async () => (await textBaselines(page,session,inspector))
      .find(item => item.control === "Component class filter");
    const text = await readClass();
    assert.equal(text.mode,"inline");
    assert.deepEqual(failures(baselineResults([text])),[],"caption and displayed selection share the alphabetic baseline");
    const leading = rtl ? control.field.right - filter.text.x - filter.text.width : filter.text.x - control.field.left;
    assert.ok(near(leading - control.margin,8),"the rendered native text has the shared leading inset");

    // A property row puts the caption and the field on one baseline, so text moved inside the field takes
    // the caption with it. Move the caption alone: the measurement must still see the 1px.
    if (theme === "light" && !touch && !rtl)
      await assertBaselinePerturbations(select.locator("xpath=preceding-sibling::*[1]"), readClass, {captionOnly:true});
    await session.detach();

    if (touch) await page.touchscreen.tap(control.field.left + 10,control.row.top + 3);
    else {
      if (theme === "dark") {
        await select.focus();
        await select.evaluate(node => node.addEventListener("keydown", event => {
          queueMicrotask(() => { node.dataset.nativeKey = String(event.isTrusted && !event.defaultPrevented); });
        },{once:true}));
        await select.press("Space");
        assert.equal(await select.getAttribute("data-native-key"),"false","Space opens the shared option list, not the platform pop-up");
        // The list module loads on first use: wait for Space to open it, as a click now would toggle it shut.
      } else await select.click();
    }
    // Touch keeps the system picker; a mouse or the keyboard opens the option list on the field.
    await page.waitForFunction(touch => {
      const node = document.querySelector('#inspector select[aria-label="Component class filter"]');
      return touch ? node?.matches(":open") : globalThis.AtriumSelectPopup?.field() === node;
    }, touch, {timeout:2000});
    if (!touch) await page.keyboard.press("Escape");
    await select.evaluate(node => node.blur());
    assert.ok(await select.getByRole("option",{name:className,exact:true}).count());
    await select.focus();
    await select.selectOption(className);
    assert.equal(await select.inputValue(),className);
    assert.ok(near((await select.boundingBox()).width,control.field.width),"the long label keeps the existing value column");
    assert.equal(await select.evaluate(node => node === document.activeElement),true,"class selection retains keyboard focus");
    assert.equal(await page.evaluate(() => AtriumNavHost.selection().length),0,"choosing a class clears the selected nonmember");
    assert.deepEqual(await page.evaluate(() => {
      const host = AtriumNavHost, component = ref => host.doc().items.find(i => i.ref === ref);
      return [AtriumComponentClasses.allows(component("R1")),AtriumComponentClasses.allows(component("U1"))];
    }),[true,false]);
    await select.selectOption("");
    assert.equal(await select.inputValue(),"");
    assert.equal(await page.evaluate(() => AtriumComponentClasses.filterValue()),"");
    assert.equal(await page.evaluate(() => AtriumComponentClasses.allows(AtriumNavHost.doc().items.find(i => i.ref === "U1"))),true);

    if (theme === "hc") {
      await page.emulateMedia({forcedColors:"active"});
      assert.deepEqual(await select.evaluate(node => {
        const style = getComputedStyle(node);
        return [style.appearance,style.backgroundImage];
      }),["auto","none"],"system high contrast leaves a single native arrow");
    }
    console.log(`Class select ${theme}${touch ? " touch" : ""}${rtl ? " RTL" : ""}: baseline delta ${text.valueBaseline - text.captionBaseline} px, ${control.field.width}×${control.field.height} px`);
  } finally { await page.close(); }
}

async function run(browser) {
  for (const mode of themeModes) await check(browser,mode);
}

module.exports = run;
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    try { await run(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
