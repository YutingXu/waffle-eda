#!/usr/bin/env node
"use strict";

// Exercise the shipping application on immutable Round 4 snapshots. Browser
// files are in-memory copies and the approved case is opt-in.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {parseArgs} = require("node:util");
const {root, readReceipts, readCase, survey} = require("./schematic-workflows/corpus.cjs");
const preview = require("./schematic-workflows/preview.cjs");
const hierarchy = require("./schematic-workflows/hierarchy.cjs");
const direction = require("./schematic-workflows/direction.cjs");
const frames = require("./schematic-workflows/frames.cjs");
const outputs = require("./schematic-workflows/outputs.cjs");
const kicad = require("./schematic-workflows/kicad.cjs");

async function newEditor(browser, app, theme) {
  const page = await browser.newPage({viewport: {width: 1380, height: 860}});
  page.setDefaultTimeout(6500);
  try {
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(theme => {
      localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values: {
        "appearance.theme": theme, "appearance.animations": "off", "general.startPage": "always",
      }}));
    }, theme);
    await page.goto(pathToFileURL(path.join(app, "index.html")).href);
    await page.getByRole("button", {name: "Continue to editor", exact: true}).click();
    await page.evaluate(theme => AtriumTheme.set({preset: theme, followSystem: false, motion: "off"}, {persist: false}), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function openSnapshot(page, input) {
  await page.locator("#file-input").setInputFiles({
    name: "workflow-copy.waffle", mimeType: "application/json", buffer: input.bytes,
  });
  await page.waitForFunction(name => AtriumNavHost.project().name === name && !AtriumNavHost.isDirty(), input.design.name,
    {timeout: 30000});
  const documents = await page.evaluate(() => AtriumNavHost.project().documents.map(d => [d.id, d.items.length]));
  assert.equal(JSON.stringify(documents) === JSON.stringify(input.design.documents.map(d => [d.id, d.items.length])),
    true, "The editor did not open all frozen documents and objects.");
  // The format reader opens its Import Report above the canvas. Use the active
  // design tab just as a reader would before working on the imported design.
  const active = await page.evaluate(() => AtriumNavHost.currentId());
  await page.locator("#document-tabs [data-tab=" + JSON.stringify(active) + "]").click();
  await page.waitForFunction(() => !AtriumNavHost.canvas().inert);
}

const workflows = {
  preview: [["native previews and navigation", (page, input, result) => preview.inspectNative(page, input.design, result.source)],
    ["PCB net cross-probe", page => preview.crossProbe(page)],
    ["direction on existing or seeded connector", async (page, input, result) => {
      const existing = direction.nativeConnector(input.design);
      if (existing) return {...await direction.edit(page, existing), seededDirection: false};
      result.seed = await hierarchy.seed(page);
      return {...await direction.edit(page, result.seed.offsheet[0]), seededDirection: true};
    }],
    ["seeded entry, ignored name, and off-sheet siblings", async (page, input, result) =>
      preview.inspectSeeded(page, result.seed || await hierarchy.seed(page))]],
  hierarchy: [["native scope and tree", (page, input, result) => hierarchy.inspectNative(page, input.design, result.source)],
    ["sheet overview", (page, input, result) => hierarchy.overview(page, input.design, result.source)],
    ["Automatic first-port notice", (page, input) => input.id === "synthetic" && hierarchy.firstPortNotice(page)],
    ["seeded repeated channel and port", async page => hierarchy.inspectSeeded(page, await hierarchy.seed(page))]],
  frames: [["sheet size and named frame", async (page, input, result) => {
    if (input.id === "synthetic") await hierarchy.setScope(page, "automatic");
    const plan = await frames.chooseFrame(page);
    result.plan = plan;
    result.frame = await frames.placeFrame(page, plan);
    return {seededCircuit: plan.seededCircuit, tried: plan.tried, rejected: plan.rejected, sizeAndFrame: true};
  }],
  ["frame drag and its modifier", (page, input, result) => input.id === "synthetic" && result.frame && frames.dragFrame(page, result.plan, result.frame)],
  ["Print, PDF, and Output Job", (page, input, result) => result.frame && outputs.print(page)],
  ["Altium and KiCad schematic export", (page, input, result) => result.frame && outputs.exportDrawing(page, input.id === "synthetic")],
  ["Convert Frame to Sheet", (page, input, result) => result.frame && frames.convert(page, result.plan, result.frame)]],
  open: [],
};

async function main() {
  const {values} = parseArgs({options: {
    snapshots: {type: "string"},
    "baseline-inputs": {type: "string"},
    approved: {type: "boolean"},
    case: {type: "string", multiple: true},
    theme: {type: "string"},
    survey: {type: "boolean"},
    open: {type: "boolean"},
    workflow: {type: "string", multiple: true},
    app: {type: "string"},
    "kicad-cache": {type: "string"},
  }});
  const receipts = values["baseline-inputs"] ? readReceipts(values["baseline-inputs"]) : new Map();
  const allowed = [...receipts.keys()].filter(id => id !== "approved" || values.approved);
  const selected = values.case || allowed;
  const hasSupplement = !values.survey && values["kicad-cache"];
  assert.ok(selected.length && (values["baseline-inputs"] || selected.every(id => hasSupplement && id === kicad.sofleVariant)),
    "Supply --baseline-inputs with the pinned input TSV for the selected snapshots.");
  assert.ok(selected.every(id => allowed.includes(id) || hasSupplement && id === kicad.sofleVariant),
    "Choose a published case. The approved case requires --approved. The Sofle variant requires --kicad-cache and the browser.");
  assert.ok(values.snapshots || selected.every(id => id === kicad.sofleVariant),
    "Supply --snapshots with the retained baseline directory.");
  assert.ok(!values.theme || ["light", "dark"].includes(values.theme), "Choose a light or dark theme.");
  assert.ok([values.survey, values.open, values.workflow].filter(Boolean).length < 2, "Choose --survey, --open or --workflow.");
  const selectedWorkflows = values.open ? ["open"] : values.workflow || ["preview", "hierarchy", "frames"];
  assert.ok(selectedWorkflows.every(phase => Object.hasOwn(workflows, phase)), "Choose a preview, hierarchy or frames workflow.");
  const app = path.resolve(values.app || path.join(root, "app"));
  const {chromium} = values.survey ? {} : require("playwright-core");
  const browser = chromium && await chromium.launch({headless: true,
    ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}),
  });
  try {
    for (const [index, id] of selected.entries()) {
      const fail = (phase, error) => {
        // Playwright and assertion errors can include labels, URLs or project
        // names. Print only the failing operation for the approved fixture.
        console.error(id + " / " + phase + ": " + (id === "approved" ? "failed" : error.message));
        process.exitCode = 1;
      };
      let input;
      const supplement = id === kicad.sofleVariant;
      try {
        const theme = values.theme || ["light", "dark"][index % 2];
        if (supplement) {
          const page = await newEditor(browser, app, theme);
          try { input = await kicad.prepareSofle(page, values["kicad-cache"]); }
          finally { await page.close(); }
        } else input = readCase(values.snapshots, id, receipts);
        const source = survey(input.design), result = {case: id, source};
        if (input.imported) result.import = input.imported;
        if (browser) {
          result.theme = theme;
          for (const name of selectedWorkflows) {
            let page, phase = name + " editor open";
            try {
              page = await newEditor(browser, app, theme);
              const errors = [];
              page.on("pageerror", error => errors.push(error.message));
              await openSnapshot(page, input);
              const context = {source};
              const details = {};
              result[name] = details;
              for (const [label, run] of workflows[name]) {
                try {
                  const value = await run(page, input, context);
                  if (value) Object.assign(details, value);
                } catch (error) {
                  fail(label, error);
                  await page.keyboard.press("Escape").catch(() => {});
                }
              }
              phase = name + " uncaught browser errors";
              assert.equal(errors.length, 0, errors[0]);
            } catch (error) {
              fail(phase, error);
            } finally {
              await page?.close();
            }
          }
          if (values["kicad-cache"] && ["corne", "lily58"].includes(id)) {
            const page = await newEditor(browser, app, theme);
            try { result.import = await kicad.reopen(page, id, values["kicad-cache"]); }
            catch (error) { fail("pinned source import", error); }
            finally { await page.close(); }
          }
        }
        input.verify();
        console.log(JSON.stringify(result));
      } catch (error) {
        fail(supplement ? "pinned KiCad variant" : "snapshot receipt", error);
      }
    }
  } finally {
    await browser?.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
