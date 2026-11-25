"use strict";

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const {appFile} = require("../support/app-source-paths.cjs");

// Register the same optional commands as the generated shortcut reference.
const noop = new Proxy(function () {}, {
  get(_target, key) { return key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : noop; },
  apply() { return noop; }
});
const timer = globalThis.setTimeout;
globalThis.setTimeout = fn => { fn(); return 0; };
globalThis.document = {readyState: "complete", addEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], getElementById: () => null};
globalThis.AtriumNavHost = noop;
// The fixture supplies command metadata without starting the browser's editor watcher.
globalThis.AtriumNavCommon = {menuItem() {}, setChecked() {}, ready() {}, host: noop};
for (const name of ["keymap", "editor-keys", "keymap-presets", "lazy", "prefs", "multichannel", "rooms",
  "library-panel", "theme", "bus-route", "route-suggest"]) require(appFile(name + ".js"));
AtriumMultichannel.install(noop);
AtriumRooms.install(noop);
globalThis.setTimeout = timer;
delete globalThis.document;
delete globalThis.AtriumNavHost;

const keymap = globalThis.AtriumKeymap;
const keyboard = globalThis.AtriumEditorKeys;
for (const id of ["multichannel:mc-sync", "rooms:room-move", "bus:neck"])
  assert.ok(keymap.command(id), id + " is registered for the profile checks");
require("../../app/extensions/manifests.js");
for (const {manifest} of globalThis.AtriumBuiltinExtensionManifests) {
  if (manifest.enabledByDefault === false) continue;
  const {commands = [], keybindings = []} = manifest.contributes || {};
  for (const command of commands) {
    const defaultKeys = keybindings.filter(binding => binding.command === command.command);
    if (defaultKeys.length) keymap.registerCommand({id: command.command, title: command.title, category: "Extensions", when: command.when, defaultKeys});
  }
}
const forms = {tagName: "INPUT", closest: selector => selector.includes("input") ? forms : null};
const canvas = {tagName: "CANVAS", closest: () => null};
const panel = {tagName: "DIV", closest: () => null};

function samples() {
  const states = [];
  for (const kind of ["schematic", "pcb", "drawing", "panel"]) {
    const capture = {documentId: kind, kind, tool: "select", interactive: false, canvas: true,
      selected: false, selectionCount: 0, rotatable: false, cursorAt: false, canProperties: false,
      tuning: false, view3d: false, dragging: false, sticky: false, suggestion: false, suggestTab: false, busRouting: false};
    for (const focus of [true, false]) {
      const idle = {...capture, canvas: focus};
      states.push(idle, {...idle, cursorAt: true}, {...idle, selectionCount: 1, selected: true},
        {...idle, selectionCount: 1, selected: true, rotatable: true}, {...idle, selectionCount: 2, selected: true});
      if (!["schematic", "pcb"].includes(kind)) continue;
      const drag = {...idle, selectionCount: 1, selected: true, dragging: true};
      states.push(drag, {...drag, sticky: true});
      for (const tool of ["pan", "route", "route-diffpair", "place", "label", "sch-place", "move-object",
        "via", "measure", "paste", "length-tune", "length-tune-pair"]) {
        if (kind === "schematic" && ["route-diffpair", "via", "length-tune", "length-tune-pair"].includes(tool)) continue;
        if (kind === "pcb" && tool === "sch-place") continue;
        const route = tool === "route" || tool === "route-diffpair";
        const active = {...idle, tool, interactive: tool !== "pan", rotatable: ["place", "sch-place", "move-object"].includes(tool),
          canProperties: kind === "pcb" ? route || tool === "via" : ["place", "sch-place", "label"].includes(tool),
          tuning: tool.startsWith("length-tune")};
        states.push(active);
        if (kind === "pcb" && route && focus) states.push({...active, suggestion: true}, {...active, suggestion: true, suggestTab: true});
        if (kind === "pcb" && tool === "route") states.push({...active, busRouting: true});
      }
      if (kind === "pcb") states.push({...idle, view3d: true});
    }
  }
  return states;
}

const keyPairs = {Backquote: "`~", Minus: "-_", Equal: "=+", Backslash: "\\|", Slash: "/?", Comma: ",<", Period: ".>",
  Quote: "'\"", Semicolon: ";:", BracketLeft: "[{", BracketRight: "]}", Digit0: "0)", Digit1: "1!", Digit2: "2@", Digit3: "3#",
  Digit4: "4$", Digit5: "5%", Digit6: "6^", Digit7: "7&", Digit8: "8*", Digit9: "9("};
const nativeCode = Object.fromEntries(Object.entries(keyPairs).flatMap(([code, pair]) => [...pair].map(key => [key, code])));
nativeCode[" "] = "Space";
const shiftedSymbol = new Set(Object.values(keyPairs).map(pair => pair[1]));
const keyName = token => token.endsWith("+") ? "+" : token.split("+").at(-1);
function keyEvent(token, chord, mac, target) {
  const mods = chord & 15;
  const name = keyName(token);
  let key = name === "Space" ? " " : ["Up", "Down", "Left", "Right"].includes(name) ? "Arrow" + name : name;
  const shiftKey = !!(mods & keymap.SHIFT) || shiftedSymbol.has(key);
  const letter = /^[A-Z]$/.test(key);
  const code = letter ? "Key" + key : nativeCode[key] || key;
  if (mac && letter && (mods & keymap.ALT)) key = "ƒ"; // Option can produce a non-ASCII letter on macOS.
  else if (letter && !shiftKey) key = key.toLowerCase();
  else if (shiftKey && keyPairs[code]) key = keyPairs[code][1];
  return {key, code, target, shiftKey, ctrlKey: !!(mods & keymap.CTRL), altKey: !!(mods & keymap.ALT),
    metaKey: !!(mods & keymap.META), preventDefault() { this.defaultPrevented = true; }};
}

function replay(rec, sequence, state, mac, target = state.canvas ? canvas : panel) {
  const fired = [];
  const invoke = keymap.invoke;
  keymap.invoke = binding => fired.push(binding.id);
  try {
    const editor = keyboard.create(() => {}, () => {});
    const events = rec.key.split(" ").map((token, i) => keyEvent(token, sequence[i], mac, target));
    for (const event of events) editor.handle(event, state);
    return {fired, claimed: events.every(event => event.defaultPrevented)};
  } finally { keymap.invoke = invoke; }
}

// Navigator is captured when the formatter loads. Use separate realms to check OS
// names instead of using the dispatch table's Mac/PC toggle for presentation.
const keymapSource = readFileSync(appFile("keymap.js"), "utf8");
const shortcutSource = readFileSync(appFile("ui/shortcut.js"), "utf8");
const arrowMarks = {Up: "↑", Down: "↓", Left: "←", Right: "→"};
const macKeyMarks = {...arrowMarks, Enter: "⏎", Escape: "esc", Tab: "⇥", Backspace: "⌫", Delete: "⌦",
  Home: "↖", End: "↘", PageUp: "⇞", PageDown: "⇟"};
const pcKeyMarks = {...arrowMarks, Escape: "Esc", Delete: "Del", PageUp: "PgUp", PageDown: "PgDn"};
const macKeyNames = {Enter: "Return", Backspace: "Delete", Delete: "Forward Delete"};
const keyNames = {Up: "Up Arrow", Down: "Down Arrow", Left: "Left Arrow", Right: "Right Arrow", PageUp: "Page Up", PageDown: "Page Down",
  ContextMenu: "Context Menu", "+": "Plus", "-": "Minus", "=": "Equal", "*": "Asterisk", ",": "Comma", ".": "Period", "/": "Slash",
  "\\": "Backslash", "?": "Question Mark", "`": "Backtick", "'": "Apostrophe", "\"": "Quotation Mark", "[": "Left Bracket",
  "]": "Right Bracket", "{": "Left Brace", "}": "Right Brace", "!": "Exclamation Mark", "@": "At Sign", "#": "Number Sign",
  "$": "Dollar Sign", "%": "Percent Sign", "^": "Caret", "&": "Ampersand", "(": "Left Parenthesis", ")": "Right Parenthesis",
  "_": "Underscore", "|": "Vertical Bar", ":": "Colon", ";": "Semicolon", "<": "Less Than", ">": "Greater Than", "~": "Tilde"};
const platforms = [
  {name: "macOS", platform: "MacIntel", mac: true, marks: macKeyMarks, names: macKeyNames, modifiers: ["⌃", "⌥", "⇧", "⌘"],
    spoken: ["Control", "Option", "Shift", "Command"]},
  {name: "Windows", platform: "Win32", mac: false, marks: pcKeyMarks, names: {}, modifiers: ["Ctrl", "Alt", "Shift", "Win"],
    spoken: ["Control", "Alt", "Shift", "Windows"]},
  {name: "Linux", platform: "Linux x86_64", mac: false, marks: pcKeyMarks, names: {}, modifiers: ["Ctrl", "Alt", "Shift", "Super"],
    spoken: ["Control", "Alt", "Shift", "Super"]}
];
function labelNode(ownerDocument) {
  const attributes = new Map(), classes = new Set();
  return {
    ownerDocument, dataset: {}, children: [],
    classList:{add: value => classes.add(value), contains: value => classes.has(value)},
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key) ?? null,
    removeAttribute: key => attributes.delete(key),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  };
}
for (const system of platforms) {
  const document = {createElement: () => labelNode(document)};
  const context = vm.createContext({navigator: {platform: system.platform}, document});
  vm.runInContext(shortcutSource, context);
  vm.runInContext(keymapSource, context);
  system.formatter = context.AtriumKeymap;
  assert.equal(system.formatter.mac, system.mac, system.name);
}
const modifierOrder = [keymap.CTRL, keymap.ALT, keymap.SHIFT, keymap.META];
function expectedLabel(key, sequence, system, spoken) {
  const join = spoken || !system.mac ? "+" : "";
  const modifierLabels = spoken ? system.spoken : system.modifiers;
  const tokens = key.split(" ");
  return tokens.map((token, i) => {
    const name = keyName(token);
    const modifiers = modifierLabels.filter((_, j) => (sequence[i] & modifierOrder[j]) !== 0);
    const visual = name === "," && tokens.length > 1 ? "Comma" : system.marks[name] || name;
    const label = spoken ? system.names[name] || keyNames[name] || name : visual;
    return [...modifiers, label].join(join);
  }).join(spoken ? ", then " : ", ");
}

const states = samples();
let trials = 0, variants = 0, labels = 0;
const problems = [], labelProblems = [], counts = [];
const presets = keymap.presets();
assert.deepEqual(presets.map(p => p.id), ["altium", "classic", "kicad", "vscode", "allegro", "modern", "rts"]);
for (const preset of presets) {
  keymap.setPreset(preset.id);
  for (const system of platforms) {
    const {mac, formatter} = system;
    keymap.setPlatform(mac);
    const table = keymap.table();
    const label = `${preset.id} on ${system.name}`;
    const intents = new Map(table.all.map(record => [record.id, record.command]));
    assert.deepEqual(table.errors, [], label);
    assert.deepEqual(keymap.conflicts().map(c => c.message), [], label);
    if (mac) counts.push(`${preset.id} ${table.all.length}`);
    for (const record of table.all) {
      for (const spoken of [false, true]) {
        const expected = expectedLabel(record.key, record.seqs[0], system, spoken);
        const actual = formatter.display(record.key, spoken);
        labels++;
        if (actual !== expected) labelProblems.push(`${label}: ${record.key} (${record.id}) ${spoken ? "spoken" : "visual"} was ${actual}, expected ${expected}`);
      }
      for (const sequence of record.seqs) {
        variants++;
        let seen = false;
        for (const state of states) {
          if (!record.test(state, state.canvas)) continue;
          trials++;
          const {fired, claimed} = replay(record, sequence, state, mac);
          const last = fired.at(-1);
          if (claimed && last === record.id) seen = true;
          // A visible router suggestion may intentionally take priority over the ordinary key.
          else if (!record.command.priority && intents.get(last)?.priority) continue;
          else problems.push(`${label}: ${record.key} (${record.id}) in ${state.kind}/${state.tool} fired ${fired.join(", ") || "nothing"}`);
        }
        if (record.inForms && sequence.length === 1) {
          for (const kind of ["pcb", "schematic"]) {
            const state = states.find(s => s.kind === kind && !s.canvas && s.tool === "select");
            if (!record.test(state, false)) continue;
            trials++;
            const {fired, claimed} = replay(record, sequence, state, mac, forms);
            if (!claimed || fired.at(-1) !== record.id) problems.push(`${label}: ${record.key} (${record.id}) did not run from a text field`);
          }
        }
        if (!seen) problems.push(`${label}: ${record.key} (${record.id}) has no usable editor context`);
      }
    }
  }
}
assert.equal(labelProblems.length, 0, `${labelProblems.length} shortcut label mismatches\n${[...new Set(labelProblems)].slice(0, 30).join("\n")}`);
assert.equal(problems.length, 0, `${problems.length} shortcut mismatches\n${[...new Set(problems)].slice(0, 30).join("\n")}`);
console.log(`PASS all ${presets.length} profiles (${counts.join(", ")}), ${labels} visual/spoken labels, ${variants} physical bindings and ${trials} dispatches across three platforms and ${states.length} editor states.`);

keymap.setPreset("altium");
const board = states.find(s => s.kind === "pcb" && s.tool === "select" && s.canvas);
const sheet = states.find(s => s.kind === "schematic" && s.tool === "select" && s.canvas);
const labelExamples = {
  macOS: ["⌃⌥⇧⌘F24, ⌘⏎", "Control+Option+Shift+Command+F24, then Command+Return", "⏎", "Return", "⌫", "Delete", "⌦", "Forward Delete"],
  Windows: ["Ctrl+Alt+Shift+Win+F24, Ctrl+Enter", "Control+Alt+Shift+Windows+F24, then Control+Enter", "Enter", "Enter", "Backspace", "Backspace", "Del", "Delete"],
  Linux: ["Ctrl+Alt+Shift+Super+F24, Ctrl+Enter", "Control+Alt+Shift+Super+F24, then Control+Enter", "Enter", "Enter", "Backspace", "Backspace", "Del", "Delete"]
};
for (const system of platforms) {
  const {mac, formatter, name} = system;
  keymap.setPlatform(mac);
  const custom = "Ctrl+Alt+Shift+Meta+F24 Mod+Return", comma = "Mod+, Mod+X";
  keymap.setBindings("toggle-units", [custom, comma + " Mod+Y"]);
  const actual = [custom, "Return", "Backspace", "Delete"].flatMap(key => [formatter.display(key), formatter.display(key, true)]);
  assert.deepEqual(actual, labelExamples[name], name);
  const tile = formatter.label(custom), [first, second, spoken] = tile.children;
  assert.ok(tile.classList.contains("ui-shortcut"), name);
  assert.equal(tile.dataset.variant, "keycap", name);
  const visibleKeys = [first, second].map(step => {
    assert.equal(step.className, "ui-shortcut-step", name);
    assert.equal(step.getAttribute("aria-hidden"), "true", name);
    return step.children.map(cap => {
      assert.equal(cap.className, "ui-shortcut-cap", name);
      return cap.children[0].children[0].textContent;
    });
  });
  assert.deepEqual(visibleKeys.map(keys => keys.length), [5, 2], name);
  assert.equal(visibleKeys.map(keys => keys.join(mac ? "" : "+")).join(", "), labelExamples[name][0], name);
  assert.equal(spoken.textContent, labelExamples[name][1], name);
  assert.notEqual(spoken.getAttribute("aria-hidden"), "true", name);
  assert.equal(formatter.display("Control"), system.modifiers[0], name);
  assert.equal(formatter.display("Alt", true), system.spoken[1], name);
  assert.equal(formatter.display("Shift"), system.modifiers[2], name);
  assert.equal(formatter.display("Meta"), system.modifiers[3], name);
  const bindings = keymap.table().byCommand.get("toggle-units");
  for (const binding of bindings)
    assert.deepEqual(replay(binding, binding.seqs[0], board, mac).fired, ["toggle-units"], name);
  assert.equal(formatter.display(comma), mac ? "⌘Comma, ⌘X" : "Ctrl+Comma, Ctrl+X", name);
  assert.equal(formatter.display(comma, true), mac ? "Command+Comma, then Command+X" : "Control+Comma, then Control+X", name);
  assert.equal(formatter.display("Mod+X Mod+,"), mac ? "⌘X, ⌘Comma" : "Ctrl+X, Ctrl+Comma", name);
  assert.equal(formatter.display("Mod+X Mod+,", true), mac ? "Command+X, then Command+Comma" : "Control+X, then Control+Comma", name);
  assert.equal(formatter.display("Mod+,"), mac ? "⌘," : "Ctrl+,", name);
  let prefixHint;
  const prefix = keyboard.create(() => assert.fail("The prefix must wait for the final stroke"), hint => {prefixHint = hint;});
  comma.split(" ").forEach((token, i) => prefix.handle(keyEvent(token, bindings[1].seqs[0][i], mac, canvas), board));
  assert.ok(prefixHint.startsWith(formatter.display(comma) + " · "), name + " pending sequence names its comma");
  for (const mark of Object.keys(nativeCode).filter(key => /^[^\d ]$/.test(key))) {
    assert.equal(formatter.display(mark), mark, name + " " + mark);
    assert.equal(formatter.display(mark, true), keyNames[mark], name + " " + mark);
  }
  for (let i = 1; i <= 24; i++) {
    assert.equal(formatter.display("F" + i), "F" + i, name);
    assert.equal(formatter.display("F" + i, true), "F" + i, name);
  }

  keymap.setBindings("toggle-units", ["Return"]);
  keymap.setBindings("toggle-left", ["Backspace"]);
  keymap.setBindings("toggle-right", ["Delete"]);
  const cases = [["Enter", "Enter", "toggle-units"], ["Enter", "NumpadEnter", "toggle-units"],
    ["Unidentified", "NumpadEnter", "toggle-units"], ["Backspace", "Backspace", "toggle-left"],
    ["Delete", "Delete", "toggle-right"], ["Delete", "Backspace", "toggle-right"], ["Delete", "NumpadDecimal", "toggle-right"]];
  for (const [key, code, action] of cases) {
    const fired = [];
    const e = {key, code, target: canvas, preventDefault() { this.defaultPrevented = true; }};
    keyboard.create(value => fired.push(value), () => {}).handle(e, board);
    assert.deepEqual(fired, [action], name + " " + code);
    assert.equal(e.defaultPrevented, true, name + " " + code);
  }
  keymap.resetAll();
}
keymap.setPlatform(true);
assert.equal(keymap.resolve("T D", sheet), "drc", "board checks can open the project board from a schematic");
assert.equal(keymap.resolve("B", {...board, tool: "route", interactive: true}), null, "ordinary routing leaves bus commands inactive");
assert.equal(keymap.resolve("B", {...board, tool: "route", interactive: true, busRouting: true}), "bus:via-pattern");
assert.equal(keymap.hintFor("library-panel", "pcb"), "T, L", "a menu action finds its namespaced keyboard command");

assert.equal(keymap.importJSON({bindings: {"toggle-units": ["Alt+U", "InvalidKey", "Meta+Z"]}}).length, 1);
assert.deepEqual(keymap.bindingsFor("toggle-units").map(b => b.key), ["Alt+U", "Meta+Z"], "an invalid imported key keeps adjacent valid entries");
assert.equal(keymap.resolve("Mod+Z", board), "toggle-units", "Mod resolves through Command on Mac");
assert.equal(keymap.hintFor("undo", "pcb"), "⌃Z", "the menu hints at the usable physical alias");
const undo = labelNode();
undo.dataset.action = "undo";
const undoMenu = {querySelectorAll: () => [undo]};
keymap.applyMenuHints(undoMenu, "pcb");
assert.equal(undo.dataset.hint, "⌃Z");
assert.equal(undo.getAttribute("aria-description"), "Control+Z", "the menu speaks the same physical alias");
keymap.setBindings("undo", []);
keymap.applyMenuHints(undoMenu, "pcb");
assert.equal(undo.dataset.hint, undefined);
assert.equal(undo.getAttribute("aria-description"), null, "unbinding removes both menu forms");
keymap.resetCommand("undo");
keymap.setPlatform(false);
assert.equal(keymap.resolve("Mod+Z", board), "undo", "Mod resolves through Control on PC");
keymap.resetAll();

keymap.setBindings("toggle-units", [{key: "Alt+K U", when: "selection"}]);
keymap.setBindings("grid", [{key: "Alt+K U", when: "!selection"}]);
const seenHints = [];
const pending = keyboard.create(() => {}, hint => seenHints.push(hint));
const altK = () => keyEvent("Alt+K", keymap.parse("Alt+K")[0].key * 16 + keymap.ALT, false, canvas);
pending.handle(altK(), board);
assert.match(seenHints.at(-1), /Visible Grid/i);
pending.clear();
pending.handle(altK(), {...board, selected: true, selectionCount: 1});
assert.match(seenHints.at(-1), /Units/i, "the same live continuation can have a different label");
keymap.resetAll();

const fired = [];
let follow;
const editor = keyboard.create((action, param, next) => {fired.push(action); follow = next;}, () => {});
const stroke = token => {
  const chord = keymap.parse(token)[0];
  return keyEvent(token, chord.key * 16 + chord.mods, false, canvas);
};
editor.handle(stroke("P"), board);
keymap.setPreset("modern");
editor.handle(stroke("T"), board);
assert.deepEqual(fired, ["label"], "changing profiles clears the previous profile's sequence");
const selection = {...board, selected: true, selectionCount: 1};
assert.equal(keymap.resolve("Mod+Alt+I", selection), "toggle-right");
assert.equal(keymap.resolve("Mod+Alt+Shift+I", selection), "ai.askSelection");
keymap.setBindings("toggle-units", ["Mod+K Mod+U U"]);
editor.handle(stroke("Ctrl+K"), board);
assert.equal(fired.at(-1), "command-palette");
assert.equal(typeof follow, "function");
editor.clear();  // The palette takes focus.
keymap.registerCommand({id: "test.late-command", title: "Lazy module command"});
assert.ok(follow(stroke("Ctrl+U"), () => {throw Error("an incomplete chord cannot run");}));
assert.ok(follow(stroke("U"), rec => fired.push(rec.id)));
assert.equal(fired.at(-1), "toggle-units");
console.log("PASS user imports and overrides, native modifier aliases, namespaced hints and multi-key palette continuation.");

keymap.setPreset("rts");
function wireAfter(change) {
  const actions = [], editor = keyboard.create(action => actions.push(action), () => {});
  editor.handle(keyEvent("P", 0, keymap.mac, canvas), sheet);
  change();
  editor.handle(keyEvent("W", 0, keymap.mac, canvas), sheet);
  return actions;
}
assert.deepEqual(wireAfter(() => {}), ["route"], "RTS P W draws a wire");
let optional;
assert.deepEqual(wireAfter(() => {
  optional = keymap.registerCommand({id:"test:late-optional",title:"Optional feature"});
}), ["route"], "optional registration preserves an equivalent prefix");
optional.dispose();
assert.deepEqual(wireAfter(() => {
  optional = keymap.registerCommand({id:"test:late-binding",title:"New child",defaultKeys:["P F24"]});
}), ["camera-pan-up"], "registration cancels the prefix when it changes the descendants");
optional.dispose();
assert.deepEqual(wireAfter(() => {
  keymap.setBindings("route", ["F24"]);
}), ["camera-pan-up"], "editing the binding cancels the previous prefix");
keymap.resetCommand("route");
console.log("PASS a cold wire prefix survives unrelated registrations and clears after its bindings change.");
