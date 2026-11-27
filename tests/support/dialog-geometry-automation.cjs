"use strict";

// Labs automation dialogs: Ask AI, Macros, the shared change review and Query.
const assert = require("node:assert/strict");
const {installProvider} = require("../automation/butter-intel-ui-shared.cjs");

// An offline provider that needs a key, so the Access view offers Forget.
const hosted = {
  "waffle-extension.json":JSON.stringify({id:"waffle.hosted-ai-example", name:"Hosted AI example", version:"1.0.0", apiVersion:1, main:"provider.js",
    permissions:["ai:provider", "network:provider.invalid"],
    contributes:{aiProviders:[{id:"hosted", label:"Hosted provider", entry:"provider.js", hosts:["provider.invalid"], auth:"bearer"}]}}),
  "provider.js":"module.exports.respond = async () => ({type:\"answer\", text:\"Offline.\"});",
};
// A saved macro with a parameter, so Run asks for its value before the review.
const macro = {format:"waffle-macro", version:1, name:"Widen tracks", alias:"widen",
  parameters:[{name:"width", type:"number", default:0.5}],
  steps:[{command:"butter.macros.set-track-width", args:{width:{$parameter:"width"}}}]};

function cases(page) {
  const modal = name => page.getByRole("dialog", {name, exact:true});
  const button = (root, name) => root.getByRole("button", {name, exact:true});
  const flags = names => page.evaluate(async names => {
    for (const name of names) AtriumPrefs.set("butter." + name, true);
    await AtriumLazy.need("AtriumButterEditor");
  }, names);
  const command = id => page.evaluate(async id => {
    const deadline = performance.now() + 4000;
    while (!AtriumKeymap.command(id) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    AtriumKeymap.command(id).run();
  }, id);

  const ask = page.locator(".panel-ask");
  const openAsk = async tab => {
    await flags(["ai"]);
    await command("assist.ask-ai");
    await ask.waitFor();
    await page.evaluate(async tab => { AtriumAskUI.setTab(tab); await AtriumAskUI.refresh(true); }, tab);
  };

  const macros = page.locator(".panel-macros");
  const macroRow = () => macros.locator(".ui-row", {hasText:macro.name});
  const openMacros = async () => {
    await flags(["macros"]);
    await command("assist.macros");
    await macros.waitFor();
    await page.evaluate(async macro => {
      if (!globalThis.geometryMacroSaved) {
        await AtriumButterEditor.apply("butter.macros.save", {macro});
        globalThis.geometryMacroSaved = true;
      }
      AtriumMacrosUI.render();
    }, macro);
    await macroRow().waitFor();
  };
  const macroMenu = async item => {
    await openMacros();
    await macroRow().hover();
    await button(macros, "More actions for " + macro.name).click();
    await page.getByRole("menuitem", {name:item, exact:true}).click();
  };
  const runMacro = async () => {
    await openMacros();
    await page.evaluate(() => {
      const host = AtriumNavHost, ids = host.doc().items.filter(item => item.kind === "track" && !item.locked).slice(0, 2).map(item => item.id);
      host.select(ids, ids[0]);
    });
    await macroRow().hover();
    await button(macroRow(), "Run…").click();
    const target = modal("Run " + macro.name);
    await target.getByRole("spinbutton", {name:"width"}).or(target.getByRole("textbox", {name:"width"})).waitFor();
    return target;
  };

  const query = page.locator(".panel-design-query");
  const saved = "Low resistors";
  const openQuery = async () => {
    await flags(["query"]);
    await command("assist.design-query");
    await query.waitFor();
  };
  const savedMenu = async item => {
    await openQuery();
    await page.evaluate(async name => {
      if (!(AtriumNavHost.project().savedQueries ?? []).some(record => record.name === name))
        await AtriumButterEditor.apply("butter.query.save-query", {name, source:"resistor where value < 100 kΩ", scope:{}});
      AtriumQueryUI.setTab("saved");
    }, saved);
    const row = query.locator(".ui-row", {hasText:saved}).first();
    await row.hover();
    await button(query, "More actions for " + saved).first().click();
    await page.getByRole("menuitem", {name:item, exact:true}).click();
  };

  return [
    {name:"Clear the Ask AI request log", async open() {
      await installProvider(page);
      await openAsk("activity");
      await page.evaluate(() => {
        const id = AtriumNavHost.project().id, rows = [];
        for (let i = 0; i < 3; i++) rows.push({provider:"waffle.local-ai-example:local", at:Date.now() - i * 60000,
          promptExcerpt:"Question " + (3 - i), promptCharacters:10, readTools:[{tool:"query", rows:3, fields:["id", "kind"]}], result:"answered"});
        AtriumAIProvidersDesktop.local(id, "activity", rows.reverse());
        AtriumAskUI.setTab("activity");
      });
      await button(ask, "Clear…").click();
      await button(modal("Clear AI activity?"), "Clear").waitFor();
    }},
    {name:"Forget a hosted AI provider key", async open() {
      await page.evaluate(async pkg => {
        globalThis.AtriumHost = Object.assign(globalThis.AtriumHost ?? {}, {
          async aiCredential() { return {available:true, configured:true, maxBytes:4096}; },
        });
        await AtriumLazy.need("AtriumExtensions");
        const host = AtriumNavHost;
        AtriumExtensions.attach({project:host.project, documentId:host.currentId, revision:host.revision,
          selection:() => new Set(host.selection()), info:host.info},
        {consent:request => request.kind === "install" ? {"ai:provider":true, "network:provider.invalid":true} : true});
        await AtriumExtensions.install(pkg);
      }, hosted);
      await openAsk("access");
      const row = ask.locator(".ui-row", {hasText:"Hosted provider"});
      await row.getByText("Key in keychain").waitFor();
      await button(row, "Forget").click();
      await button(modal("Forget this key?"), "Forget").waitFor();
    }, async finish() {
      await page.evaluate(async () => {
        delete globalThis.AtriumHost?.aiCredential;
        await AtriumExtensions.uninstall("waffle.hosted-ai-example");
      });
    }},
    {name:"Import a portable macro record", async open() {
      await openMacros();
      await button(macros, "Import…").first().click();
      await modal("Import macro").getByRole("textbox", {name:"Macro record", exact:true}).waitFor();
    }},
    {name:"Run a saved macro with a parameter", async open() {
      await runMacro();
    }},
    {name:"Review a macro replay before it changes the design", async open() {
      const target = await runMacro();
      await button(target, "Preview").click();
      const review = page.locator("dialog[open].intel-review-dialog");
      await review.getByRole("button", {name:/^Apply/}).waitFor();
    }},
    {name:"Export a saved macro as an extension", async open() {
      await macroMenu("Export…");
      await modal("Export macro").getByText(macro.alias + ".waffle-extension").waitFor();
    }},
    {name:"Delete a saved macro", async open() {
      await macroMenu("Delete…");
      await button(modal("Delete " + macro.name + "?"), "Delete").waitFor();
    }},
    {name:"Save a design query as a group", async open() {
      await openQuery();
      await query.locator(".intel-query-source").fill("resistor where value < 100 kΩ");
      await query.locator(".ui-status-line", {hasText:/\d+ match/}).first().waitFor();
      await button(query, "Save…").click();
      await modal("Save query").getByRole("textbox", {name:"Name"}).waitFor();
    }},
    {name:"Rename a saved query group", async open() {
      await savedMenu("Rename…");
      const target = modal("Rename saved group"), name = target.getByRole("textbox", {name:"Name"});
      await name.waitFor();
      assert.equal(await name.inputValue(), saved);
    }},
    {name:"Delete a saved query group", async open() {
      await savedMenu("Delete…");
      await button(modal("Delete " + saved + "?"), "Delete").waitFor();
    }},
  ];
}

module.exports = {cases};
