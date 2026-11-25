"use strict";
// Run by the real macOS editor. The external observer controls Git tracing and checks disk bytes.
const h = AtriumNavHost;
const native = (op, detail = {}) => webkit.messageHandlers.formatBenchmark.postMessage({op, ...detail});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const observe = (checkpoint, observation = {}) => native("formatObserve", {checkpoint, observation});
function check(result, message) { if (!result) throw Error(message); }
async function until(test, message) {
  const deadline = performance.now() + 20000;
  while (!await test()) {
    if (performance.now() > deadline) throw Error(message);
    await wait(20);
  }
}

await until(() => document.visibilityState === "visible", "The Waffle test window did not become visible");
AtriumPower.host({occluded:false});
const start = await AtriumLazy.need("AtriumStartPage");
start.open({launch:true});
document.querySelector("dialog.sp-dialog[open] [data-start-action=close]").click();
// Project-local collaboration heartbeats are separate from Save and recovery.
AtriumPref.set("collab.locking", false);
await native("open");
await until(() => h.folderProject()?.hasPresented(h.currentId()) && h.doc()?.items.some(row => row.id === "reference-label"),
  "The fixture did not open and present its active sheet");
await native("finishOpen");
const session = h.folderProject();
const active = () => h.doc().items.find(row => row.id === "reference-label");
const recovery = () => [...document.querySelectorAll("dialog[open]")].find(d => d.textContent.includes("Recover private draft"));

// Git discovery from ordinary Open remains useful. Exercise it while the command spy is
// in the Open phase and allow the scheduled discovery and native watcher delivery to settle.
await frame(); await frame();
const git = await AtriumLazy.need("AtriumGitPicker").then(() => AtriumGit.status());
check(git.head === trial.head, "The fixture's Git repository did not bind to the real native host");
await wait(500);
await observe("start-saves");

function edit(text) {
  const label = active(), id = h.currentId();
  h.edit(() => { label.text = text; }, "Edit quarantine label", [label.id], {documents:[id],items:[label.id]});
  check(h.isDirty() && active().text === text, "The editor did not record the active owner edit");
}
async function draft(text) {
  const previous = session.draftMetrics().writes;
  edit(text);
  await until(() => {
    const state = session.draftMetrics();
    return state.writes > previous && !state.pending;
  }, "The normal autosave timer did not write the private draft");
  await observe("draft", {text});
}

if (trial.mode === "draft") {
  await draft("save-01");
  return {draft:true};
}

await until(recovery, "The normal Open route did not offer its prior private draft");
const restore = [...recovery().querySelectorAll("button")].find(b => b.textContent === "Restore Draft");
check(restore && !h.isDirty(), "The crash draft was not separate from the saved sheet");
restore.click();
await until(() => h.isDirty() && active().text === "save-01", "Restore Draft did not restore the label");
await observe("restore");

const savedTransactions = new Set();
for (let save = 1; save <= 50; save++) {
  const value = "save-" + String(save).padStart(2, "0");
  if (save === 26) await draft(value);
  else if (save !== 1) edit(value);
  await frame();
  h.canvas().focus({preventScroll:true});
  let trusted = false;
  const key = e => { if (e.key.toLowerCase() === "s" && e.metaKey) trusted ||= e.isTrusted; };
  window.addEventListener("keydown", key, true);
  try {
    await native("formatSaveKey");
    await until(() => !h.isDirty(), "Command-S did not acknowledge and clear the saved edit");
  } finally { window.removeEventListener("keydown", key, true); }
  const receipt = session.metrics().lastSave;
  check(trusted && receipt?.transaction && !savedTransactions.has(receipt.transaction) &&
    receipt.paths.length === 1 && receipt.paths[0] === "Schematic.wsch", "Expected a new native receipt for one active sheet");
  savedTransactions.add(receipt.transaction);
  await until(async () => (await AtriumHost.folderStatus({grant:session.grant})).state === "settled", "The native transaction did not finish applying");
  await observe(save, {value, transaction:receipt.transaction});
}
await until(async () => !(await session.listDrafts()).length, "A recovered draft remained after its covered Save");
return {ordinarySaves:savedTransactions.size};
