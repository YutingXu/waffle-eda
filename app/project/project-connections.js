"use strict";
// Projects panel options, and the non-modal choice shared by schematic edits and frame conversion.
globalThis.AtriumProjectConnections = (() => {
  const name = value => value.charAt(0).toUpperCase() + value.slice(1);
  const descriptions = {
    automatic:"Sheet entries select Hierarchical. Without entries, a port selects Flat. Otherwise connections are Global.",
    global:"Net labels, ports and off-sheet connectors connect by name across sheets. Sheet entries also connect to their child ports.",
    flat:"Ports and off-sheet connectors connect by name across sheets. Net labels stay on their sheet and sheet entries are ignored.",
    hierarchical:"Ports connect to matching entries on their parent sheet symbol. Off-sheet connectors join siblings. Net labels stay on their sheet."
  };
  const H = () => globalThis.AtriumHierarchy, P = () => globalThis.AtriumProjectRules;
  let finishNotice, deciding = false;
  function node(tag, text) { return AtriumNavCommon.el(tag, text); }
  async function open(host) {
    const project = host.project();
    try { await host.folderProject?.()?.ensureImportReports?.(); } catch (error) { host.info(error.message); }
    if (host.project() !== project) return;
    const setting = H().scopeSetting(project);
    const label = node("label", "Net identifier scope"), select = node("select"), description = node("dl");
    select.id = "project-net-scope"; label.htmlFor = select.id;
    for (const mode of H().SCOPES) {
      const option = node("option", name(mode)); option.value = mode; select.append(option);
      description.append(node("dt", name(mode)), node("dd", descriptions[mode]));
    }
    select.value = setting;
    const source = H().sourceAutomatic(project) ? node("p", "Altium selected Automatic. This working copy keeps " + name(setting) + " as you edit. Select Automatic to follow future changes.") : null;
    const dialog = globalThis.AtriumShell.dialog({
      title:"Cross-sheet connections", className:"project-connections-dialog",
      body:[label, select, source, description, node("p", "Power ports connect globally in every mode.")],
      actions:[{label:"Cancel"}, {label:"Apply", primary:true, run() {
        if (host.project() === project && select.value !== H().scopeSetting(project))
          host.edit(() => P().setNetScope(project, select.value), "Change net identifier scope", []);
      }}]
    });
    dialog.id = "project-connections-dialog";
  }
  // The strip participates in layout even when the Projects panel is closed. It never takes
  // focus from a placement or consumes a canvas click. A later edit retires its old actions.
  function notice(host, message, actions, ticket, cancelled) {
    finishNotice?.();
    const strip = node("section"), text = node("p", message), buttons = node("div");
    strip.id = "project-scope-notice"; strip.setAttribute("aria-label", "Net identifier scope");
    text.setAttribute("role", "status"); strip.append(text, buttons);
    let closed = false;
    const current = () => host.project() === ticket.project && host.revision() === ticket.revision &&
      (!ticket.step || host.undoSteps().history.at(-1) === ticket.step);
    function close(abandoned = true) {
      if (closed) return;
      closed = true; offChange?.(); offReplace?.(); strip.remove(); finishNotice = null;
      if (abandoned) cancelled?.();
    }
    const offChange = host.on("change", () => {if (!current()) close();});
    const offReplace = host.on("replace", () => close());
    finishNotice = close;
    for (const [title, fn] of actions) {
      const button = node("button", title); button.className = "ui-button"; button.type = "button"; buttons.append(button);
      button.onclick = () => {
        if (!current()) {close(); return;}
        close(false);
        try {fn?.();} catch (e) {host.info(e.message);}
      };
    }
    strip.onkeydown = e => {if (e.key === "Escape") {e.preventDefault(); close(); host.canvas()?.focus();}};
    document.getElementById("workbench").after(strip);
  }
  function review(host, ticket) {
    const {project, revision, step, from, to} = ticket;
    if (!host || host.project() !== project || host.revision() !== revision || host.undoSteps().history.at(-1) !== step) return;
    const action = to === "hierarchical" ? "Adding a sheet entry" : from === "hierarchical" ? "Removing the last sheet entry" :
      to === "flat" ? "Adding a port" : "Removing the last port";
    const message = action + " changes cross-sheet connections: " + name(from) + " → " + name(to) +
      ". Connections stay " + name(from) + " unless you switch before the next edit.";
    notice(host, message, [
      ["Switch", () => {
        // The original rule still exists, with all its metadata. Restoring Automatic
        // amends the originating checkpoint; unrelated settings in the book are retained.
        host.amend(() => {
          project.rules = H().withScope(project.rules, "automatic");
        }, "Switch connection scope", []);
      }],
      ["Keep " + name(from), () => host.info("Connections kept " + name(from) + ".")],
      ["Undo edit", () => host.historyGo(-1)]
    ], ticket);
  }
  async function convert(host, {from, to, apply, keep = true, switch:canSwitch = true, reason = "", label = "Convert Frame to Sheet"}) {
    const project = host.project(), revision = host.revision(), setting = H().scopeSetting(project);
    if (!P()) await globalThis.AtriumLazy.need("AtriumRules");
    if (host.project() !== project || host.revision() !== revision) return false;
    const changed = from !== to;
    function commit(mode) {
      if (host.project() !== project || host.revision() !== revision) return false;
      let applied = false;
      deciding = true;
      try {
        host.edit(() => {
          if (changed && (mode === from || setting !== "automatic")) P().setNetScope(project, mode);
          apply(mode);
          applied = true;
        }, label);
      } finally {deciding = false;}
      return applied;
    }
    if (!changed) {
      const applied = commit(to);
      if (applied && (setting === "automatic" || setting === "flat")) {
        const scope = setting === "automatic" ? "Automatic → " + name(to) : name(to);
        notice(host, "Frame converted to a sheet. Connections: " + scope + ". " + descriptions[to],
          [["Dismiss"]], {project, revision:host.revision()});
      }
      return applied;
    }
    const message = "Converting this frame changes cross-sheet connections: " + name(from) + " → " + name(to) + ". " +
      (reason ? reason + " " : "") + "Choose how to connect the new sheet. Another edit cancels this conversion.";
    return new Promise((resolve, reject) => {
      const choose = scope => {try {resolve(commit(scope));} catch (e) {reject(e);}};
      const actions = [];
      if (canSwitch) actions.push(["Switch", () => choose(to)]);
      if (keep) actions.push(["Keep " + name(from), () => choose(from)]);
      actions.push(["Cancel", () => resolve(false)]);
      notice(host, message, actions, {project, revision}, () => resolve(false));
    });
  }
  return {open, review, convert, deciding:() => deciding};
})();
