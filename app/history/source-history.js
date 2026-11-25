"use strict";
// Project, file and object history share one source binding and revision reader.
globalThis.AtriumSourceHistory = (() => {
  function open() {
    const git = globalThis.AtriumGit;
    const source = globalThis.AtriumProjectHistoryData.source(git);
    const host = globalThis.AtriumHost, generation = host?.projectGeneration;
    const binding = () => host?.historyPath || host?.folderGitGrant;
    const selection = binding(), folder = !host?.historyPath && !!host?.folderGitGrant;
    // A closed picker can hand an immutable comparison to a lazily loaded viewer. The file
    // still has to be the same when the viewer actually starts.
    const bound = () => host === globalThis.AtriumHost && generation === host?.projectGeneration && selection === binding();
    const controller = new AbortController(), signal = controller.signal;
    let head, snapshot;
    async function page(skip, limit, visit) {
      const log = folder ? await source.query("projectLog", {skip, limit, firstParent:true, ...(snapshot && {snapshot})}) :
        await source.query("sourceLog", {skip, limit});
      if (head && log.head !== head) throw Error("The repository history changed. Refresh the history.");
      head = log.head; snapshot = log.snapshot;
      let checked = skip;
      for (const commit of log.commits) {
        if (signal.aborted || !bound()) throw Error("Project history request cancelled.");
        const parent = commit.parents[0] || null;
        const [before, after] = await source.resolve(parent, commit.revision, signal);
        checked++;
        if (before !== after && await visit(commit, before, after) === false) break;
      }
      return {checked, head, path: log.path, more: log.more || checked < skip + log.commits.length};
    }
    async function project(revision) {
      return (await source.project(revision, signal)).project;
    }
    async function side(spec, host) {
      if (spec.type === "working") return git.readSpec(spec, host);
      const snapshot = spec.rev ? await source.project(spec.rev, signal) : null;
      return {...snapshot, project: snapshot?.project || globalThis.AtriumHistorySummary.empty(), missing: !snapshot?.project, label: git.specLabel(spec), spec};
    }
    async function compare(before, after, editor, options = {}) {
      const opened = editor.project(), session = editor.fileSession?.();
      const active = () => bound() && !signal.aborted && editor.project() === opened && editor.fileSession?.() === session &&
        (options.active?.() ?? true);
      const left = await side(before, editor), right = await side(after, editor);
      if (active()) await git.compare(left, right, {...options, active});
    }
    async function restoreCopy(revision, editor, canRestore = () => true) {
      const opened = editor.project(), session = editor.fileSession?.();
      const active = () => bound() && !signal.aborted && editor.project() === opened && editor.fileSession?.() === session && canRestore();
      const data = await side({type:"commit", rev:revision}, editor), project = data.project;
      if (!active()) return;
      if (data.missing) throw Error("The design was deleted at this revision.");
      if (await git.openPrivateCopy(editor, project, revision, active)) {
        const missing = data.unavailableLibraries ? " Missing historical libraries: " + data.unavailableLibraries + "." : "";
        editor.info?.("Opened a copy of " + git.short(revision) + ". Save writes the copy to a new file." + missing);
      }
    }
    function close() { controller.abort(); source.close(); }
    return {page, project, side, compare, restoreCopy, bound, close};
  }
  return Object.freeze({open});
})();
