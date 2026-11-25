"use strict";
// One Find Similar Objects dialog for sheets and boards. Each editor supplies its
// fields, defaults and select/cross-probe commit. Match rows use AtriumUIKit.select
// and the dialog opens through AtriumUI.openDialog.
globalThis.AtriumFindSimilarDialog = (() => {
  const MATCH = [["same", "Same"], ["different", "Different"], ["any", "Any"]];

  function open(ctx, spec) {
    const item = spec.item();
    if (!item) {
      const key = globalThis.AtriumKeymap?.hintFor("find-similar", spec.kind());
      ctx.info("Select an object, then Find Similar Objects" + (key ? " (" + key + ")" : "") + ".");
      return null;
    }
    const K = globalThis.AtriumUIKit, U = globalThis.AtriumUI;
    if (!K?.select || !U?.openDialog) {
      ctx.info("Find Similar Objects is unavailable in this build.");
      return null;
    }
    const sheet = spec.shape === "sheet";
    const el = K.el;
    const dlg = document.createElement("dialog");
    dlg.className = sheet ? "message-dialog pcb-edit-similar" : "ui-dialog message-dialog pcb-edit-similar";
    dlg.setAttribute("aria-label", "Find Similar Objects");
    const title = el("h2", sheet ? null : "ui-dialog-title", "Find Similar Objects");
    const grid = el("div", "pcb-edit-similar-grid");
    const summary = el("p", "side-note");
    if (sheet) summary.setAttribute("role", "status");
    const within = el("label", "pcb-edit-check");
    const box = el("input", sheet ? null : "ui-checkbox");
    box.type = "checkbox";
    within.append(box, el("span", null, " Only within the current selection"));
    const choice = {};
    const head = spec.preface ? el("p", "side-note") : null;
    let paint = () => {};
    const api = {choice, rebuild() { paint(); }};
    const lead = spec.lead?.(api) || [];
    const scope = () => box.checked ? [...ctx.selection()] : null;
    function refresh() {
      summary.textContent = spec.summary(spec.match(choice, scope()));
    }
    paint = () => {
      for (const key of Object.keys(choice)) delete choice[key];
      if (head) head.textContent = spec.preface();
      grid.replaceChildren();
      for (const p of spec.fields()) {
        if (p.key === "kind") continue;
        choice[p.key] = spec.initial(p);
        const sel = K.select(MATCH, {
          value: choice[p.key],
          label: p.label + " match",
          onChange(value) { choice[p.key] = value; refresh(); },
        });
        grid.append(el("span", null, p.label), el("strong", null, p.text), sel);
      }
      refresh();
    };
    box.addEventListener("change", refresh);
    const go = zoom => {
      const hits = spec.match(choice, scope());
      dlg.close();
      spec.commit(hits, zoom);
    };
    const actions = el("div", sheet ? "work-actions" : "ui-dialog-actions");
    const button = (label, variant, run) => {
      const b = U.button(el("button", null, label), variant);
      b.type = "button";
      if (sheet && variant === "primary") b.classList.add("is-primary");
      b.addEventListener("click", run);
      return b;
    };
    actions.append(
      button("Cancel", "secondary", () => dlg.close()),
      button("Select", sheet ? "secondary" : "primary", () => go(false)),
      button("Select and Zoom", sheet ? "primary" : "secondary", () => go(true)),
    );
    const sections = [head, ...lead, grid, within, summary].filter(Boolean);
    const wrap = el("div", "ui-dialog-body");
    if (!sheet) wrap.append(...sections);
    dlg.append(title, ...(sheet ? sections : [wrap]), actions);
    paint();
    U.openDialog(dlg, {
      title, body: sheet ? sections : wrap, actions,
      initialFocus: sheet ? undefined : () => grid.querySelector("select") || box,
      onClose() { ctx.canvas()?.focus?.(); },
    });
    return api;
  }

  return Object.freeze({open});
})();
