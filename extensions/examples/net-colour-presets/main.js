// Net Colour Presets: a View contribution (View › Net Colour Presets…, a right-dock panel).
// Permissions: read:project (net names), propose:edits (net colours are saved with the board,
// so applying a preset is a reviewed change and one undo step), ui:command and ui:panel.
//
// Colours go to the board's netColors map (the same one the Nets panel edits) through a guarded
// proposal: each operation names the value it replaces, so a colour changed elsewhere since this
// extension set it makes the editor refuse the whole change rather than overwrite it.
// AtriumAPI v1 does not return netColors from documents.get, so the extension remembers what it
// last applied (api.storage) and guards with that; nets it never coloured are expected uncoloured.

const PRESETS = [
  {id: "power", name: "Power and ground", rules: [
    [/^(A|D|P|S|CHASSIS_?)?GND\w*$|^VSS\w*$|^0V$/i, "#3f7fbf"],
    [/^(V(CC|DD|IN|BAT|BUS|SYS|REF|IO)\w*|\+?\d+V\d*\w*|\d+V\d+)$/i, "#c84f4f"]]},
  {id: "clocks", name: "Clocks and crystals", rules: [[/CLK|CLOCK|XTAL|OSC|MCLK|SCK/i, "#b05cc8"]]},
  {id: "pairs", name: "Differential pairs", rules: [[/(_[PN]|[+-]|_D[PM]|_(POS|NEG))$/i, "#3fa67a"]]}
];
const HEX = /^#[0-9a-f]{6}$/i;
const glob = p => new RegExp("^" + p.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");

function customPreset(text) {
  const rules = [];
  for (const part of String(text || "").split(";").map(s => s.trim()).filter(Boolean)) {
    const [pattern, colour] = part.split("=").map(s => (s || "").trim());
    if (!pattern || !HEX.test(colour || "")) throw Error("My preset: write Pattern=#rrggbb, e.g. GND*=#3f7fbf (got \"" + part + "\").");
    rules.push([glob(pattern), colour.toLowerCase()]);
  }
  return rules.length ? {id: "custom", name: "My preset", rules} : null;
}

exports.activate = function (api, context) {
  async function presets() {
    const custom = customPreset((await api.settings.get()).custom);
    return custom ? [...PRESETS, custom] : PRESETS;
  }
  const colours = (preset, nets) => {
    const out = {};
    for (const n of nets) for (const [re, c] of preset.rules) if (re.test(n.name)) { out[n.name] = c; break; }
    return out;
  };
  const key = doc => "applied:" + doc.id;

  async function render() {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") { await api.ui.setPanel("netColours", {type: "text", text: "Open a board layout to colour its nets.", muted: true}); return; }
    const nets = await api.nets.list({doc: doc.id}), applied = (await api.storage.get(key(doc))) || {};
    const rows = (await presets()).map(p => { const m = Object.keys(colours(p, nets)); return {preset: p.id, name: p.name, nets: m.length, example: m.slice(0, 4).join(", ") + (m.length > 4 ? "…" : "")}; });
    await api.ui.setPanel("netColours", [
      {type: "text", text: "Click a preset to colour its nets on " + doc.name + ". You review the change; it is one undo step.", muted: true},
      {type: "table", rowCommand: "netColours.apply", columns: [{key: "name", title: "Preset"}, {key: "nets", title: "Nets", align: "right"}, {key: "example", title: "For example"}], rows},
      {type: "kv", rows: [["Coloured by a preset", Object.keys(applied).length + " nets"]]},
      {type: "buttons", items: [{label: "Clear preset colours", command: "netColours.clear"}, {label: "Refresh", command: "netColours.show"}]}
    ]);
  }

  // Replace this extension's colours on the active board with `target` ({net: colour}).
  async function setColours(target, label) {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") throw Error("Open a board layout to colour its nets.");
    const applied = (await api.storage.get(key(doc))) || {}, ops = [];
    for (const net of new Set([...Object.keys(applied), ...Object.keys(target)])) {
      if (applied[net] === target[net]) continue;
      ops.push({op: "set", target: "document", id: doc.id, path: ["netColors", net],
        ...(net in applied ? {before: applied[net]} : {}), ...(net in target ? {after: target[net]} : {})});
    }
    if (!ops.length) { await api.ui.showMessage(label + ": nothing to change."); return {changed: 0}; }
    const info = await api.project.info();
    let r;
    try { r = await api.proposals.submit({format: "atrium-ai", version: 2, project: info.name, ops}, label); }
    catch (e) {
      if (!/changed since/.test(e.message)) throw e;
      await api.ui.showMessage("Some of these nets were recoloured elsewhere (for example in the Nets panel). Clear their colours there, then apply the preset again.", {level: "warn"});
      return {changed: 0, stale: true};
    }
    if (r.declined || !r.applied) return {changed: 0, declined: !!r.declined};
    // Remember what the board now holds for the operations the user kept.
    const kept = {...applied};
    if (r.applied === ops.length) { for (const net of Object.keys(kept)) if (!(net in target)) delete kept[net]; Object.assign(kept, target); await api.storage.set(key(doc), kept); }
    else await api.storage.delete(key(doc)); // a partial review: forget, so later guards cannot be wrong
    await render();
    return {changed: r.applied};
  }

  api.commands.register("netColours.show", async () => { await api.ui.showPanel("netColours"); await render(); });
  api.commands.register("netColours.apply", async row => {
    // A panel row ({preset}), a preset id, or ad-hoc rules from a script: {rules: "GND*=#3f7fbf; V*=#c84f4f"}.
    const p = row && typeof row.rules === "string" ? {...customPreset(row.rules), name: "Custom rules"} : (await presets()).find(x => x.id === (row && (row.preset || row)));
    if (!p) throw Error("Unknown preset " + JSON.stringify(row) + ".");
    const doc = await api.documents.active();
    const target = colours(p, await api.nets.list({doc: doc.id}));
    if (!Object.keys(target).length) { await api.ui.showMessage(p.name + ": no net on this board matches."); return {changed: 0}; }
    return setColours(target, "Net colours: " + p.name);
  });
  api.commands.register("netColours.clear", () => setColours({}, "Clear preset net colours"));
  context.subscriptions.push(
    api.events.on("panelShown", e => { if (e.id === "netColours") render(); }),
    api.events.on("activeDocumentChanged", () => render().catch(() => {})));
};

exports.deactivate = function () {};
