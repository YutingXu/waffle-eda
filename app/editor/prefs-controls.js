"use strict";

globalThis.AtriumPrefsControls = (() => {
  const doc = globalThis.document;
  const t = AtriumI18n.define({
    "prefs.units_key_help": "Press {shortcut} on the canvas to switch units.",
    "prefs.ratsnest_key_help": "Press {shortcut} on the board to show or hide them.",
    "prefs.imported_settings": "Imported settings",
    "prefs.keep_off": "Keep off",
    "prefs.the_imported_file_also_asks_to_turn_on_these_set": "The imported file also asks to turn on these settings. They stay off unless you tick them.",
    "prefs.turn_on_ticked": "Turn on ticked",
    "prefs.turn_these_on": "Turn these on?"
  });
  // Help that names a key reads "Press [key] …" with the inline keycap. The plain sentence stays when no key is bound.
  const KEY_HELP = [
    ["#prf-general-units-help", "toggle-units", null, "prefs.units_key_help"],
    ["#prf-pcb-showRatsnest-help", "unrouted", "pcb", "prefs.ratsnest_key_help"],
  ];
  function keyHelp(help, action, kind, id) {
    if (!help) return;
    const binding = globalThis.AtriumKeymap?.hintKey(action, kind ?? globalThis.AtriumNavHost?.doc?.()?.kind);
    help.dataset.plain ??= help.textContent;
    if (!binding) { help.textContent = help.dataset.plain; return; }
    help.classList.add("no-i18n");
    const marker = "\uFFFC";
    const [before, after] = t(id, {shortcut:marker}).split(marker);
    help.replaceChildren(before, AtriumShortcut.render(binding, {variant:"inline-keycap"}), after ?? "");
  }
  const refreshKeyHelp = (root = doc.querySelector(".prf-dialog[open]")) => {
    if (root) for (const [selector, ...rest] of KEY_HELP) keyHelp(root.querySelector(selector), ...rest);
  };
  globalThis.AtriumKeymap?.onChange(() => refreshKeyHelp());
  new MutationObserver(() => refreshKeyHelp()).observe(doc.documentElement, {attributes:true, attributeFilter:["lang"]});

  // The confirmation for held switches (F8): unticked boxes; only ticked ones are turned on.
  async function chooseHeld(held) {
    const boxes = held.map(([key, label]) => {
      const row = doc.createElement("label"), box = doc.createElement("input"), caption = doc.createElement("span");
      row.className = "prf-row prf-check";
      box.className = "ui-checkbox";
      box.type = "checkbox";
      caption.textContent = label + " (" + key + ")";
      row.append(box, caption);
      return row;
    });
    boxes[0].querySelector("input").autofocus = true;
    const note = doc.createElement("p"), accept = t("prefs.turn_on_ticked");
    note.className = "prf-note";
    note.textContent = t("prefs.the_imported_file_also_asks_to_turn_on_these_set");
    const dialog = AtriumShell.dialog({title:t("prefs.turn_these_on"), label:t("prefs.imported_settings"),
      className:"prf-held", body:[note, ...boxes],
      actions:[{label:t("prefs.keep_off")}, {label:accept, primary:true, default:false}]});
    if (await dialog.done !== accept) return [];
    return held.filter((_, index) => boxes[index].querySelector("input").checked).map(([key]) => key);
  }

  function download(name, text, host) {
    if (host?.exportFile) { try { return host.exportFile(name, text); } catch {} }
    const url = URL.createObjectURL(new Blob([text + "\n"], {type: "application/json"}));
    const link = doc.createElement("a");
    link.href = url;
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSettingsFile(contents, {host, status}) {
    const saved = download("waffle-settings.json", contents, host);
    function done() {
      status("Exported waffle-settings.json: preferences, appearance, key map and panel layout (no API keys).");
      host?.info?.("Settings exported to waffle-settings.json");
    }
    if (saved?.then) return saved.then(ok => { if (ok !== false) done(); });
    done();
  }

  async function importSettingsFile(file, {importSettings, guarded, set, report}) {
    const text = file.text ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
    const result = importSettings(text);
    const message = "Imported " + file.name + ": " + result.applied.join(", ") +
      (result.skipped.length ? " · skipped " + result.skipped.join(", ") : "") +
      (result.notes.length ? " · " + result.notes.join(" ") : "") +
      (result.held?.length ? " · left off: " + result.held.join(", ") : "");
    report(message);
    if (!result.held?.length) return [];
    const keys = await chooseHeld(result.held.map(key => [key, guarded[key]]));
    for (const key of keys) set(key, true);
    return keys;
  }

  function stepNumber(input, direction) {
    if (input.disabled || input.readOnly) return;
    const editing = input.type !== "number", N = globalThis.AtriumNumericFields;
    if (editing && N?.draft(input) && !Number.isFinite(Number(input.value))) {
      N.commitField(input).then(ok => {if (ok && input.isConnected) stepNumber(input,direction);});
      return;
    }
    const native = editing ? Object.assign(doc.createElement("input"), {
      type:"number", min:input.min, max:input.max, step:input.step, value:input.value
    }) : input;
    const current = native.valueAsNumber, fallback = Number(input.dataset.defaultValue ?? 0);
    if (!Number.isFinite(current)) native.value = String(fallback);
    if (native.step === "any") {
      const increment = Number(input.dataset.increment) || 1;
      const lo = input.min === "" ? -Infinity : Number(input.min), hi = input.max === "" ? Infinity : Number(input.max);
      const next = Number((native.valueAsNumber + direction * increment).toPrecision(12));
      native.value = String(Math.max(lo, Math.min(hi, next)));
    } else if (direction > 0) native.stepUp();
    else native.stepDown();
    if (editing) input.value = native.value;
    input.dispatchEvent(new Event("change", {bubbles:true}));
  }
  function enhance(container) {
    refreshKeyHelp(container);
    for (const input of container.querySelectorAll('.prf-control > input[type="number"]')) {
      if (doc.activeElement === input) {
        input.addEventListener("blur", () => enhance(container), {once:true});
        continue;
      }
      const control = input.parentElement, unit = control.querySelector(".prf-unit");
      const label = (input.labels?.[0] || control.closest(".prf-row")?.querySelector("label"))?.textContent.trim() || input.getAttribute("aria-label");
      const box = doc.createElement("span"), value = doc.createElement("span");
      box.className = "prf-stepper"; value.className = "prf-step-value";
      if (input.placeholder && input.dataset.defaultValue) {
        input.title = input.placeholder;
        input.placeholder = input.dataset.defaultValue;
      }
      value.append(input);
      if (unit) {
        let description = unit;
        if (unit.textContent === "connections") {
          description = doc.createElement("span");
          description.className = "visually-hidden";
          description.textContent = unit.textContent;
          unit.title = unit.textContent;
          unit.textContent = "conn.";
          unit.setAttribute("aria-hidden", "true");
          value.append(description);
        }
        description.id = input.id + "-unit";
        input.setAttribute("aria-describedby", [description.id, input.getAttribute("aria-describedby")].filter(Boolean).join(" "));
        value.append(unit);
      }
      box.append(value);
      for (const [direction, text, action] of [[-1,"−","Decrease"], [1,"+","Increase"]]) {
        box.append(AtriumUI.nativeButton(text, () => stepNumber(input, direction), "prf-step-button ui-stepper-button", null, {
          variant:"quiet", ariaLabel:label ? action + " " + label : action
        }));
      }
      input.addEventListener("keydown", event => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
        if (event.key === "Enter") { input.dispatchEvent(new Event("change", {bubbles:true})); return; }
        const direction = {"+":1, "-":-1, ArrowUp:1, ArrowDown:-1}[event.key];
        const operator = event.key === "+" || event.key === "-";
        if (!direction || operator && globalThis.AtriumNumericFields?.draft(input) ||
            event.key === "-" && !input.value && Number(input.min) < 0) return;
        event.preventDefault(); stepNumber(input, direction);
      });
      control.prepend(box);
    }
  }
  function makeMovable(dialog, handle) {
    const roundWithCSS = CSS.supports("top","round(1px,1px)");
    function center() {
      for (const axis of ["x","y"]) dialog.style.removeProperty("--prf-window-" + axis);
      if (roundWithCSS) return;
      const style = getComputedStyle(dialog);
      for (const [axis,edge] of [["x","left"],["y","top"]]) {
        dialog.style.removeProperty("--prf-center-" + axis);
        const value = parseFloat(style[edge]);
        if (Number.isFinite(value)) dialog.style.setProperty("--prf-center-" + axis, Math.round(value) + "px");
      }
    }
    center();
    handle.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.pointerType === "touch" || event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      const {left,top,width,height} = dialog.getBoundingClientRect(), x = event.clientX, y = event.clientY, id = event.pointerId;
      handle.setPointerCapture(id);
      const move = event => {
        if (event.pointerId !== id) return;
        const constrain = (value, space) => Math.round(Math.max(8, Math.min(space - 8, value)));
        dialog.style.setProperty("--prf-window-x", constrain(left + event.clientX - x, innerWidth - width) + "px");
        // Never under the title bar and its window controls (--window-caption-height in the native apps).
        const safeTop = Math.max(8, (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0) + 8);
        dialog.style.setProperty("--prf-window-y", Math.max(safeTop, constrain(top + event.clientY - y, innerHeight - height)) + "px");
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("lostpointercapture", () => handle.removeEventListener("pointermove", move), {once:true});
    });
    globalThis.addEventListener("resize", center);
  }
  async function confirmDefaults(title) {
    const AtriumI18n = globalThis.AtriumI18n, t = AtriumI18n.define({
      "prefs.restore.prompt": "Restore defaults for {page}?",
      "prefs.restore.explanation": "This restores the default preferences for {page}.",
      "prefs.restore.action": "Restore Defaults",
      "prefs.restore.complete": "Restored the defaults for {page}."
    });
    const page = AtriumI18n.text(title, ["prefs"]);
    const content = doc.createElement("p");
    content.textContent = t("prefs.restore.explanation", {page});
    const accept = t("prefs.restore.action");
    const warning = AtriumShell.dialog({title:t("prefs.restore.prompt", {page}), body:[content],
      actions:[{label:AtriumI18n.text("Cancel", ["common"]), default:false}, {label:accept, variant:"danger", default:false}]});
    return (await warning.done) === accept ? t("prefs.restore.complete", {page}) : null;
  }
  return Object.freeze({enhance, makeMovable, confirmDefaults, exportSettingsFile, importSettingsFile});
})();
