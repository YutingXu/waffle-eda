"use strict";
// Leave project: the one transaction behind every switch to another project (open, import, new, close, restore,
// join). Every place that holds unsaved work registers a participant with an explicit order, and the switch asks
// each in turn: editor tabs, review-note drafts, notebook editors, foreign drafts, then the project's own save prompt.
//
//   const t = AtriumLeaveProject.begin(host, {reason, settled, confirmClean, prompt})
//   if (!await t.ask()) return false;      // the user kept the project (every participant was told: keep)
//   ... load the destination ...
//   if (!await t.ready() || !t.current()) return false;   // asks again about work changed since its answer
//   <the synchronous switch>; t.commit();  // destructive effects (delete a recovery copy, release drafts) run now
//   finally t.cancel();                    // no-op after commit
//
// Prompts only record answers. An answer holds for the state it was given about: ready() calls every participant
// again, and one whose work changed since (edits made while the destination loaded) asks again. ready() returns
// only after a full pass that needed no prompt, so the caller commits in the same task as the last check. A
// cancel at any step calls keep() on every participant. Nothing is deleted before commit().
//
// reason: "switch" (default), "close", or a switch that keeps the same project, which asks nobody: "branch" (an
// undo-tree branch), "mirror" (a workspace window's refresh), "save-reopen" (a Save reopening its own folder).
// settled (the replaceProject force option): the caller has already settled the project's own unsaved changes, so
// foreign drafts and the save prompt do not ask; tabs, notes and notebook editors still do.
// confirmClean: the save prompt asks even when the project is clean ("Replace current project?").
// prompt({dirty, name}) -> true when the project may go (it may save first); the save prompt participant calls it.
// t.current(): the project being left is still the editor's (a same-project replace keeps it current).
//
//   AtriumLeaveProject.register(name, {order, ask(t), keep?(t), commit?(t)}) -> unregister
//     ask returns true, false or a promise of one. Asked again with nothing changed, it answers at once (no promise).
//   AtriumLeaveProject.draft(name, order, {state(t), message, discard?(t)}): a participant for one piece of unsaved
//     input. state() is a token for it, or null; confirm(message) asks once per token; discard runs at commit.
//   AtriumLeaveProject.order: {tabs, notes, notebook, foreign, project}; same(reason); notebookDialogs().
globalThis.AtriumLeaveProject = (() => {
  const G = globalThis, participants = new Map();
  const order = Object.freeze({tabs: 10, notes: 20, notebook: 30, foreign: 40, project: 50});
  const SAME = new Set(["branch", "mirror", "save-reopen"]);
  const same = reason => SAME.has(reason);
  const ordered = () => [...participants.entries()].sort((a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1)).map(e => e[1]);

  function register(name, p) {
    const entry = {...p, name, order: typeof p.order === "string" ? order[p.order] : p.order};
    if (!Number.isFinite(entry.order) || typeof entry.ask !== "function") throw Error("A leave-project participant needs an order and ask().");
    participants.set(name, entry);
    return () => { if (participants.get(name) === entry) participants.delete(name); };
  }
  function draft(name, at, {state, message, discard}) {
    return register(name, {order: at,
      ask(t) {
        if (t.sameProject) return true;
        const s = state(t);
        if (s == null || t.answers.get(name) === s) return true;
        if (typeof G.confirm === "function" && !G.confirm(typeof message === "function" ? message(t) : message)) return false;
        t.answers.set(name, state(t));
        return true;
      },
      commit(t) { if (t.answers.has(name)) discard?.(t); }});
  }

  function begin(host, o = {}) {
    const reason = o.reason || "switch";
    let state = "open", stale = false;
    const t = {host, reason, sameProject: same(reason), settled: !!o.settled, confirmClean: !!o.confirmClean, prompt: o.prompt || null,
      answers: new Map(), get state() { return state; }};
    // Another project replacing this one ends the transaction; a same-project replace keeps it.
    const off = host?.on?.("replace", detail => { if (!detail?.sameProject) stale = true; });
    const each = fn => { for (const p of ordered()) try { fn(p); } catch (error) { G.console?.error?.(error); } };
    t.current = () => state === "open" && !stale;
    t.cancel = () => { if (state !== "open") return; state = "cancelled"; off?.(); each(p => p.keep?.(t)); };
    t.commit = () => { if (state !== "open") return; state = "committed"; off?.(); each(p => p.commit?.(t)); };
    async function pass(final) {
      for (;;) {
        let waited = false;
        for (const p of ordered()) {
          if (!t.current()) { t.cancel(); return false; }
          let ok;
          try {
            ok = p.ask(t);
            if (ok && typeof ok.then === "function") { waited = true; ok = await ok; }
          } catch (error) { host?.info?.(error.message); ok = false; }
          if (ok === false || !t.current()) { t.cancel(); return false; }
        }
        // A prompt took time: work may have changed meanwhile, so the final pass runs again until none asks.
        if (!final || !waited) return true;
      }
    }
    t.ask = () => pass(false);
    t.ready = () => pass(true);
    return t;
  }

  // The project's own unsaved changes, last: the caller's prompt (Save, Don't Save, Cancel), once per state.
  register("project", {order: order.project, ask(t) {
    // An unsaved foreign import's review (foreign-drafts.js) is this project's prompt.
    if (t.sameProject || t.settled || G.AtriumForeignDrafts?.needsReview?.(t.host)) return true;
    const h = t.host, key = () => (h.isDirty?.() ? "dirty:" : "clean:") + (h.authoredRevision?.() ?? h.revision?.() ?? 0);
    const dirty = !!h.isDirty?.(), held = t.answers.get("project");
    if (!dirty && (!t.confirmClean || held) || held === key()) return true;
    if (!t.prompt) return true;
    return Promise.resolve(t.prompt({dirty, name: h.project?.()?.name || "Untitled"})).then(ok => {
      if (ok) t.answers.set("project", key());
      return !!ok;
    });
  }});

  // Notebook dialogs that have no undo of their own until Apply: an open one asks once, and closes at commit.
  const DIALOGS = [["math-editor", "equation"], ["notebook-image-dialog", "image"], ["sw-editor", "sheet widget"], ["calculation-dialog", "calculation"]];
  const notebookDialogs = () => DIALOGS.flatMap(([cls, label]) => [...(G.document?.querySelectorAll?.("dialog." + cls + "[open]") || [])].map(dialog => ({dialog, label})));
  draft("notebook-dialogs", order.notebook, {
    state: () => notebookDialogs()[0]?.dialog || null,
    message: () => "Discard the changes in the open " + notebookDialogs()[0].label + " editor?",
    discard: () => { for (const {dialog} of notebookDialogs()) try { dialog.close(); } catch { /* already closed */ } }
  });

  return Object.freeze({begin, register, draft, same, order, notebookDialogs});
})();
