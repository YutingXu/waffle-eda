"use strict";

// Read-only history views and guarded restore use the same Undo tree in the editor and a
// bound, disposable MCP project. A preview is a receipt for the changes actually reviewed.
globalThis.AtriumHistorySession = (() => {
  const G = globalThis, U = () => G.AtriumUndoStore;
  const copy = value => JSON.parse(JSON.stringify(value));
  const key = mark => String(mark.id);
  const documents = model => model.documents.map(d => ({id:d.id, kind:d.kind, name:d.name, count:d.items.length}));
  const page = (items, {offset = 0, limit = 50} = {}) => ({
    total:items.length, items:items.slice(offset, offset + limit),
    nextOffset:offset + limit < items.length ? offset + limit : null
  });
  function bind(host) {
    let owner, file, sequence = 0;
    const receipts = new Map();

    function check() {
      const project = host.project(), session = host.fileSession?.();
      if (!project) throw Error("Open a history session first.");
      if (project !== owner || session !== file) { owner = project; file = session; receipts.clear(); }
      return project;
    }
    function marks() {
      check();
      return U().timeline(host);
    }
    function state(id, lists = marks()) {
      const target = id == null ? lists.current :
        lists.list.find(mark => key(mark) === id) || lists.branches.flatMap(branch => branch.trees).find(mark => key(mark) === id);
      if (!target || target.fileSession && target.fileSession !== file) throw Error("This history step has expired or belongs to another file.");
      return target;
    }
    function entry(mark, previous) {
      const change = previous && G.AtriumHistoryPanel.label(previous, mark);
      return {id:key(mark), label:change?.label || "Start", time:mark.time ?? null, documents:change?.docs || [],
        count:change?.count ?? 0};
    }
    function list(args) {
      const {current, list:line, branches} = marks();
      const offset = args.offset ?? 0, limit = args.limit ?? 50;
      const items = line.slice(offset, offset + limit).map((mark, i) => entry(mark, line[offset + i - 1]));
      return {items, total:line.length, current:key(current),
        nextOffset:offset + limit < line.length ? offset + limit : null,
        branches:branches.map(branch => ({id:branch.id, fork:key(branch.fork),
          tip:key(branch.trees.at(-1)), count:branch.trees.length}))};
    }
    function documentAt(model, documentId, args) {
      if (!documentId) return {};
      const doc = model.documents.find(d => d.id === documentId);
      if (!doc) return {document:null};
      const result = page(doc.items,args);
      return {document:{id:doc.id, kind:doc.kind, name:doc.name, ...result, items:copy(result.items)}};
    }
    function preview(args) {
      const target = state(args.step), baseline = U().reviewMark(owner);
      const view = U().viewState(target.live ? baseline : target);
      if (!view) throw Error("This history step has expired.");
      const model = view.project();
      const reviewed = G.AtriumHistoryEdits.plan(owner, model, view.peers);
      const id = String(++sequence);
      receipts.set(id, {target, baseline, reviewed});
      if (receipts.size > 16) receipts.delete(receipts.keys().next().value);
      return {receipt:id, step:key(target), documents:documents(model),
        changes:reviewed.ops.length, preserved:reviewed.preserved, ...documentAt(model,args.documentId,args)};
    }
    function compare(args) {
      const target = state(args.step), model = U().viewState(target)?.project();
      if (!model) throw Error("This history step has expired.");
      const ops = G.AtriumProposal.diff(model,owner), documentIds = [...new Set(ops.map(op => op.document).filter(Boolean))];
      return {step:key(target), documentIds, ...page(ops.map(op => ({
        op:op.op, target:op.target, documentId:op.document ?? null, id:op.id ?? op.value?.id ?? null, path:op.path ?? null
      })),args)};
    }
    function thumbnail(args) {
      const lists = marks(), target = state(args.step, lists), i = lists.list.indexOf(target);
      const branch = i < 0 ? lists.branches.find(branch => branch.trees.includes(target)) : null;
      const previous = i < 0 ? branch.trees[branch.trees.indexOf(target)-1] || branch.fork : lists.list[i-1];
      if (!previous) return {step:key(target), scene:null};
      const info = G.AtriumHistoryPanel.label(previous, target);
      const did = args.documentId || info.docs[0]?.id;
      const doc = host.docById(did) || info.docs.find(d => d.id === did);
      const changes = G.AtriumVisualHistory.affected(info,did);
      const rows = changes.before.length + changes.after.length;
      const take = 250, before = changes.before.slice(0,take), after = changes.after.slice(0,take);
      let bounds = null;
      for (const [mark, items] of [[previous,before], [target,after]]) {
        if (!doc || !items.length) continue;
        const ids = new Set(items.map(item => item.def).filter(Boolean));
        const defs = new Map(ids.size ? (U().libraryAt(mark) || [])
          .filter(def => ids.has(def.id)).map(def => [def.id,def]) : []);
        for (const item of items) {
          const box = G.AtriumNavCommon.itemBox(doc,defs,item);
          if (box) bounds = G.AtriumNavCommon.union(bounds,box);
        }
      }
      return {step:key(target), total:rows, partial:before.length + after.length < rows,
        scene:did ? {documentId:did, bounds, before, after} : null};
    }
    function restore(args, fork = false) {
      const project = check(), receipt = receipts.get(args.receipt);
      if (!receipt) throw Error("Prepare a fresh history preview before restoring.");
      const result = G.AtriumHistoryEdits.reviewedRestore(host, U(), {
        keep:fork, project, mark:{fileSession:file}, baseline:receipt.baseline,
        read:receipt.target.live ? receipt.baseline : receipt.target, stale:() => check() !== project,
        plan:receipt.reviewed, label:fork ? "Fork history" : "Restore history", anchor:receipt.target});
      if (result.cancelled) { receipts.delete(args.receipt); throw Error("This history line changed. Prepare a fresh preview."); }
      if (result.failed) throw result.failed;
      receipts.delete(args.receipt);
      return {applied:result.applied, preserved:result.preserved, fork:result.retained};
    }
    return {list, preview, compare, thumbnail, restore};
  }

  // Only the caller's explicit scratch edits create steps here. The app host supplies its own
  // editor history and never calls this constructor. No save or native project grant is used.
  function open(snapshot) {
    const project = copy(snapshot), history = [], future = [], fileSession = {};
    let revision = 0;
    G.Atrium.validate(project);
    U().reset(project);
    const host = {
      project:() => project, fileSession:() => fileSession, revision:() => revision, undoSteps:() => ({history,future}),
      docById:id => project.documents.find(d => d.id === id),
      defs:() => new Map(project.library.map(def => [def.id,def])),
      edit(change, label, touched) {
        const mark = U().mark(project,{fileSession});
        try {
          change();
          const hint = typeof touched === "function" ? touched() : touched;
          if (U().unchanged(mark, project, hint)) return false;
          U().checkpoint(history,future,mark,label);
          revision++;
          return true;
        } catch (error) {
          U().record(project); U().rollback(mark); throw error;
        }
      },
      historyGo(steps) {
        if (U().jump(history,future,U().mark(project,{fileSession}),steps)) revision++;
        return revision;
      }
    };
    const session = bind(host);
    return {host, session};
  }
  return Object.freeze({bind,open,page});
})();
