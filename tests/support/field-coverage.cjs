"use strict";

const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");

const families = new Set(["text-edit","numeric","segmented","native-select","textarea","custom-combo",
  "custom-spinbutton","custom-searchbox","custom-textbox","output"]);
const modes = new Set(["inline","stacked","multiline","compound","centred","standalone"]);
const dispositions = new Set(["measured","missing painted text","empty value"]);
let panels;

function panelInventory() {
  return panels ??= JSON.parse(execFileSync("python3", ["-B", path.join(__dirname,"../editor/dialog-inventory.py"),"--field-surfaces"], {encoding:"utf8"}));
}

function assertPanelCoverage(observations, profile, inventory = panelInventory()) {
  const approved = new Set(inventory.map(panel => panel.id));
  const declared = observations.filter(entry => entry.panel);
  const invalid = declared.filter(entry => !entry.census?.surfaceVisible || entry.census.panel !== entry.panel);
  assert.deepEqual(invalid.map(entry => entry.panel), [], `${profile}: Dock panel coverage needs its visible mounted panel`);
  const seen = new Set(declared.map(entry => entry.panel));
  assert.deepEqual([...seen].filter(id => !approved.has(id)), [], `${profile}: observed Dock panels need a source inventory entry`);
  const missing = inventory.filter(panel => !seen.has(panel.id)).map(({id,source,line}) => `${id} (${source}:${line})`);
  assert.deepEqual(missing, [], `${profile}: open and exercise each inventoried Dock panel`);
}

// Intentionally enumerate the DOM independently of the field text helper's selector. An eligible
// control should still count even if a later change drops its type or role from the measurement.
function controlCensus(root) {
  const selector = "input, select, textarea, output[aria-labelledby], [role=combobox], [role=spinbutton], [role=searchbox], [role=textbox]";
  const buttonTypes = new Set(["button","image","reset","submit"]);
  const segmentedTypes = new Set(["date","datetime-local","month","time","week"]);
  const fields = [], unmeasured = [];
  for (const control of root.querySelectorAll(selector)) {
    const modal = control.closest("dialog,[role=dialog]");
    if (modal && modal !== root && !modal.contains(root)) continue;
    if (!control.getClientRects().length || getComputedStyle(control).visibility !== "visible") continue;
    const role = control.getAttribute("role"), type = control.type;
    const label = control.getAttribute("aria-label") || control.name || control.id || control.nodeName;
    let family;
    if (control instanceof HTMLInputElement) {
      if (buttonTypes.has(type)) continue;
      let reason;
      if (type === "checkbox" || type === "radio") reason = "toggle with no displayed value text";
      if (type === "range" || type === "color") reason = "visual value without a text run";
      if (type === "file") reason = "browser-owned file chooser";
      if (reason) {unmeasured.push({label, family:type, reason}); continue;}
      if (segmentedTypes.has(type)) family = "segmented";
      else family = type === "number" || control.inputMode === "decimal" ? "numeric" : "text-edit";
    } else if (control instanceof HTMLSelectElement) family = "native-select";
    else if (control instanceof HTMLTextAreaElement) family = "textarea";
    else if (control instanceof HTMLOutputElement) family = "output";
    else if (control.querySelector("input,select,textarea")) continue;
    else family = role === "combobox" ? "custom-combo" : `custom-${role}`;
    const value = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.label : control.value || control.placeholder;
    fields.push({label,family,hasNativeValue:!!value});
  }
  const box = root.getBoundingClientRect();
  return {surfaceVisible:box.width > 0 && box.height > 0 && getComputedStyle(root).visibility === "visible",
    panel:root.closest("[data-dock-panel]")?.dataset.dockPanel || null, visible:fields, unmeasured};
}

async function fieldCoverage(scope, rows) {
  const census = await scope.evaluate(controlCensus), metrics = [];
  const counts = values => values.reduce((map, {family}) => map.set(family,(map.get(family) || 0) + 1),new Map());
  const expected = counts(census.visible), observed = counts(rows);
  for (const family of new Set([...expected.keys(),...observed.keys()])) {
    metrics.push({kind:"field coverage by family", label:family, actual:observed.get(family) || 0, expected:expected.get(family) || 0});
  }
  for (const {label,family,mode,disposition,index,valueBaseline,captionCentre} of rows) {
    const actual = Number.isInteger(index) ? census.visible[index] : undefined;
    const valid = actual?.family === family && families.has(family) && modes.has(mode) && dispositions.has(disposition) &&
      (disposition !== "empty value" || !actual.hasNativeValue) &&
      (disposition !== "measured" || Number.isFinite(valueBaseline) && (mode === "standalone" || Number.isFinite(captionCentre)));
    if (!valid) metrics.push({kind:"field coverage disposition", label, family, mode, disposition, actual:0, expected:1});
  }
  metrics.push({kind:"unique field coverage",label:"control index",actual:new Set(rows.map(row=>row.index)).size,expected:rows.length});
  return {census,metrics};
}

module.exports = {panelInventory, assertPanelCoverage, fieldCoverage};
