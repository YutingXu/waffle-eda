"use strict";
// File history in the History dock’s Git tab.
globalThis.AtriumFileHistory = (() => {
  const G = globalThis, GIT = () => G.AtriumGit;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls, label) => {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button");
    if (cls === "is-primary") b.dataset.variant = "primary";
    b.onclick = fn;
    if (label) { b.title = label; b.setAttribute("aria-label", label); } return b;
  };
  const PAGE = 100;

  function mount(box, host) {
    const root = el("div", null, "fh-root"), list = el("ol", null, "fh-list"), status = el("p", null, "fh-status"), more = btn("Show older commits", () => load(true), "fh-more");
    status.setAttribute("role", "status"); list.setAttribute("aria-label", "Commits that changed this file");
    const failure = el("div");
    more.hidden = true;
    root.append(status, failure, list, more); box.append(root);
    let commits = [], ticket = 0, alive = true, reader = null, checked = 0, acting = false;
    const say = m => host.info?.(m);
    const run = (fn, what) => async () => {
      if (acting) return;
      acting = true;
      try { await fn(); } catch (e) { if (alive) say(what + ": " + e.message); } finally { acting = false; }
    };
    async function revisions() {
      const module = await G.AtriumLazy.need("AtriumSourceHistory");
      if (!alive) throw Error("File history closed.");
      return reader ??= module.open();
    }
    function row(c) {
      const li = el("li", null, "fh-row");
      const rail = el("span", null, "fh-dot"); rail.setAttribute("aria-hidden", "true");
      const text = el("div", null, "fh-text");
      text.append(el("span", c.subject || "(no message)", "fh-subject"), el("span", [c.author, GIT().ago(c.date), GIT().short(c.revision)].filter(Boolean).join(" · "), "fh-meta"));
      li.title = c.revision + "\n" + c.date;
      const parent = c.parents?.[0];
      const acts = el("div", null, "fh-actions");
      const self = {type: "commit", rev: c.revision, label: c.subject};
      if (parent) acts.append(btn("Previous", run(async () => (await revisions()).compare({type:"commit", rev:parent, label:"before " + GIT().short(c.revision)}, self, host, {active:() => alive}), "Compare"),
        "fh-btn", "Compare with the previous version: what this commit changed"));
      acts.append(btn("Working", run(async () => (await revisions()).compare(self, {type:"working"}, host, {active:() => alive}), "Compare"), "fh-btn", "Compare with the working design (unsaved edits included)"));
      acts.append(btn("Restore copy", run(async () => (await revisions()).restoreCopy(c.revision, host, () => alive), "Restore"), "fh-btn", "Open this version as a new unsaved copy; the project file stays as it is"));
      li.append(rail, text, acts);
      return li;
    }
    async function load(append) {
      const foreign = !!G.AtriumHost?.historyPath;
      if (!foreign && !GIT()?.available()) {
        list.replaceChildren();
        status.textContent = "File history lists the Git commits that changed this project. Save the project inside a Git repository and open it in the desktop app.";
        return;
      }
      const id = ++ticket;
      more.hidden = true;
      failure.replaceChildren();
      status.textContent = append ? "Reading older commits…" : "Reading the history of this file…";
      try {
        if (!append) {
          reader?.close(); reader = null; checked = 0; commits = []; list.replaceChildren();
          await revisions();
          if (!alive || id !== ticket) return;
        }
        const result = await reader.page(checked, PAGE, (c, before, after) => {
          if (!alive || id !== ticket) return false;
          commits.push(c);
          const item = row(c);
          if (!after) item.querySelector(".fh-actions button:last-child").disabled = true;
          list.append(item);
        });
        if (!alive || id !== ticket) return;
        checked = result.checked; more.hidden = !result.more;
        status.textContent = commits.length + (foreign ? " source " : " design ") +
          (commits.length === 1 ? "change" : "changes") + " in " + checked + " first-parent commits checked · " + result.path;
      } catch (e) {
        if (!alive || id !== ticket) return;
        status.textContent = "";
        const K = G.AtriumUIKit;
        failure.replaceChildren(K.notice({tone:"danger", title:"File history unavailable.", text:e.message, live:true,
          actions:[K.button("Try again", {size:"sm", run:() => load(false)})]}));
      }
    }
    load(false);
    return {refresh: () => load(false), destroy() { alive = false; reader?.close(); root.remove(); }};
  }
  return Object.freeze({mount});
})();
