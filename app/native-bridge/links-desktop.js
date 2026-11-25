"use strict";
// Desktop authority stays in the existing folder chooser and recent-project service.
globalThis.AtriumLinksDesktop = (() => {
  const G = globalThis, L = G.AtriumLinks;
  let cached, hydration, following;
  const butterEnabled = feature => G.AtriumLabs?.butterEnabled?.(feature) ?? G.AtriumPrefs?.get("butter." + feature) === true;
  const enabled = () => butterEnabled("links");
  const revision = editor => editor.authoredRevision?.() ?? editor.revision?.();
  G.addEventListener?.("atrium-git-binding", () => cached?.index?.importCommits([], {replace:true}));
  G.AtriumPrefs?.on?.("butter.links", ({value}) => {if (value !== true) clearIndex();});

  function clearIndex() {
    for (const off of cached?.subscriptions ?? []) off?.();
    cached = null;
  }

  function covered(editor = G.AtriumNavHost) {
    const folder = editor?.folderProject();
    if (!folder) return true;
    return folder.completeFor("links");
  }

  function currentIndex(id) {
    const editor = G.AtriumNavHost, project = editor?.project();
    if (!enabled() || project?.id !== id) return null;
    const folder = editor.folderProject(), undo = G.AtriumUndoStore;
    if (cached?.editor !== editor || cached.project !== project || cached.folder !== folder || cached.undo !== undo) {
      clearIndex();
      const entry = cached = {editor, project, folder, undo, invalid:true, subscriptions:[]};
      entry.subscriptions.push(
        undo?.onAuthored((records, direction, live, action, restored) => {
          if (entry.invalid || live !== project) return;
          entry.invalid = true;
          entry.index = L.update(entry.index, project, records, direction);
          entry.revision = revision(editor);
          entry.restored = restored;
          entry.invalid = false;
        }),
        editor.on?.("change", detail => {
          // Undo publishes the restored records before the editor advances its revision.
          const stamp = revision(editor);
          if (entry.restored && detail?.source === "undo") entry.revision = stamp;
          else if (entry.revision !== stamp && !undo?.unrecorded()) entry.invalid = true;
          entry.restored = false;
        }),
        editor.on?.("replace", clearIndex),
        folder?.on((event, detail) => {
          if (event !== "loaded" || project !== editor.project() || entry.invalid) return;
          if (detail.kind === "project") entry.invalid = true;
          else if (detail.id) {
            const document = editor.docById(detail.id);
            if (document) {
              entry.index.clear(detail.id);
              L.addDocument(entry.index, document);
            } else if (detail.kind === "library" || detail.kind === "block" || detail.purpose === "disk") {
              L.addMetadata(entry.index, project, "library");
              L.addMetadata(entry.index, project, "layoutBlocks");
            }
          }
        }));
    }
    if (!cached.invalid && undo?.root() === project && undo.unrecorded()) undo.sync(project);
    const stamp = revision(editor);
    if (cached.invalid || cached.revision !== stamp) {
      cached.index = L.fromProject(project, cached.index);
      cached.invalid = false;
      cached.revision = stamp;
    }
    return cached.index;
  }
  function resolveTargets(project, targets, {complete = true} = {}) {
    const entry = cached, editor = G.AtriumNavHost;
    if (complete && entry && entry.editor === editor && entry.project === project && !entry.invalid &&
        editor.project() === project && entry.folder === editor.folderProject() &&
        Number.isFinite(entry.revision) && entry.revision === revision(editor) && !editor.editInProgress?.() && covered(editor)) {
      const undo = entry.undo;
      if (undo && !undo.unrecorded() && (undo.root() === project || undo.verifiedDocumentVersion(editor.doc?.()) != null) &&
          entry.index.matchesDocuments(project)) {
        const found = targets.map(target => L.resolveFromOwner(project, target, entry.index));
        if (found.every(Boolean)) return found;
      }
    }
    return L.resolveTargets(project, targets, {complete});
  }
  function complete() {
    const editor = G.AtriumNavHost, project = editor?.project();
    if (!enabled() || !project || covered(editor)) return null;
    const folder = editor.folderProject();
    if (hydration?.project !== project || hydration.folder !== folder) {
      const request = editor.requireProjectClosure({purpose:"links", assets:false}).catch(() => {
        // A failed closure may have installed some of its owners before encountering a missing file.
        if (cached?.project === project && cached.folder === folder) cached.invalid = true;
      }).finally(() => {if (hydration?.request === request) hydration = null;});
      hydration = {project, folder, request};
    }
    return hydration.request;
  }

  async function gitPage({offset, snapshot}, signal) {
    const native = G.AtriumHost;
    if (!native?.folderGitGrant || !native.gitQuery || signal?.aborted) return {status:"unavailable"};
    try {
      const result = await native.gitQuery("projectLog",
        {limit:100, skip:offset, recordLinks:true, ...(snapshot && {snapshot})}, {signal});
      return signal?.aborted ? {status:"unavailable"} : {...result, status:"ready"};
    } catch {
      return {status:"unavailable"};
    }
  }

  async function matchesFolder(native, folder, projectId) {
    if (!folder?.grant || !folder.manifest || folder.status?.state === "conflict") return false;
    const {lease} = await native.folderReadLease({grant:folder.grant});
    try {
      const {files} = await native.folderRead({grant:folder.grant, lease, paths:[folder.manifest]});
      const file = files?.find(row => row.path === folder.manifest);
      if (!file) return false;
      const bytes = file.bytes ?? Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
      return G.AtriumFormat2Model.parse(bytes, {kind:"project"}).header.id === projectId;
    } finally {
      await native.folderRelease({grant:folder.grant, lease});
    }
  }
  const close = (native, folder) => folder?.grant ? native.folderClose({grant:folder.grant}).catch(() => {}) : null;
  async function findProject(native, projectId) {
    const matches = await native.linkRecentProjects(projectId);
    if (matches.length > 1) return {status:"ambiguous-project", count:matches.length};
    if (matches.length === 1) {
      let candidate;
      try {
        [candidate] = await native.openRecent(matches[0]);
        if (await matchesFolder(native, candidate?.folderProject, projectId)) return {candidate};
      } catch { /* A changed recent entry cannot grant access. */ }
      await close(native, candidate?.folderProject);
    }
    const folder = await native.chooseProjectFolder({mode:"open"});
    if (!folder) return {status:"missing-project", projectId};
    try {
      if (await matchesFolder(native, folder, projectId)) return {candidate:{name:folder.manifest, folderProject:folder}};
    } catch (error) { await close(native, folder); throw error; }
    await close(native, folder);
    return {status:"project-mismatch", projectId};
  }
  async function reveal(target, editor) {
    if (target.kind === "comment") {
      const comments = await G.AtriumLazy.need("AtriumReviewComments");
      if (editor.project()?.id === target.projectId) {
        const threadId = editor.project().review?.records?.[target.objectId]?.thread ?? target.objectId;
        comments.focus(threadId, true);
      }
      return;
    }
    const feature = target.kind === "slide" ? "slides" : target.kind === "savedView" ? "savedViews" : null;
    if (feature && butterEnabled(feature)) {
      const editorCommands = G.AtriumButterEditor ?? await G.AtriumLazy.need("AtriumButterEditor");
      const outcome = (await editorCommands.apply("butter." + feature + ".apply", {id:target.objectId}))?.result;
      if (outcome?.status !== "ready" && outcome?.status !== "partial") return outcome ?? {status:"unavailable-host"};
      return;
    }
    if (!target.documentId) return;
    await editor.selectDocument(target.documentId);
    if (editor.project()?.id !== target.projectId || editor.currentId() !== target.documentId)
      return {status:"missing-document", documentId:target.documentId};
    const itemId = target.presentedId ?? target.objectId;
    const doc = editor.doc(), item = doc?.items.find(row => row.id === itemId);
    if (item) {
      editor.select([item.id]);
      if (target.net) editor.setHighlight(target.net);
      const points = target.point && target.kind === "pin" ? [target.point] : G.Atrium.itemPoints(item, editor.defs().get(item.def), doc.kind);
      if (points?.length) editor.zoomTo(G.Atrium.bounds(points));
      editor.canvas().focus();
    }
  }
  async function follow(target) {
    if (!enabled()) return {status:"disabled"};
    if (!L.address(target)) return {status:"invalid-link"};
    if (following) return {status:"busy"};
    const editor = G.AtriumNavHost;
    if (!editor) return {status:"unavailable-host"};
    following = target;
    try {
      if (editor.project()?.id !== target.projectId) {
        const native = G.AtriumHost;
        if (!native?.chooseProjectFolder) return {status:"missing-project", projectId:target.projectId};
        const location = await findProject(native, target.projectId);
        if (!location.candidate) return location;
        if (!enabled()) {
          await close(native, location.candidate.folderProject);
          return {status:"disabled"};
        }
        G.AtriumStartPage?.close();
        if (!await editor.openFiles([location.candidate], {expectedProjectId:target.projectId})) {
          await close(native, location.candidate.folderProject);
          return {status:"cancelled"};
        }
      }
      if (editor.project()?.id !== target.projectId) return {status:"project-mismatch", projectId:target.projectId};
      const lookup = () => resolveTargets(editor.project(), [target], {complete:covered(editor)})[0];
      let result = lookup();
      if (result.status === "partial") {
        await complete();
        result = lookup();
      }
      if (!enabled()) return {status:"disabled"};
      if (editor.project()?.id !== target.projectId) return {status:"project-mismatch", projectId:target.projectId};
      if (result.status === "found") {
        const problem = await reveal(result.target, editor);
        if (problem) return {...problem, target:result.target};
      }
      return result;
    } finally {following = null;}
  }
  async function copyLink(objectId) {
    const editor = G.AtriumNavHost, project = editor?.project();
    if (!enabled() || !project) return false;
    const selected = objectId ?? editor.selection()[0] ?? editor.currentId();
    const [result] = resolveTargets(project, [{projectId:project.id, objectId:selected}]);
    if (result.status !== "found") {editor.info("Choose an object with a saved identity."); return false;}
    return copyTarget(result.target);
  }
  async function copyTarget(target) {
    const editor = G.AtriumNavHost;
    if (!enabled() || !L.address(target) || editor?.project()?.id !== target.projectId) return false;
    const url = L.format(target);
    let copied = false;
    try {
      if (G.navigator?.clipboard?.writeText) {await G.navigator.clipboard.writeText(url); copied = true;}
    } catch { /* This WebView may only support the native copy event. */ }
    if (!copied) {
      const input = G.document.createElement("textarea"), previous = G.document.activeElement;
      input.className = "visually-hidden";
      input.value = url;
      G.document.body.append(input);
      input.select();
      try {copied = G.document.execCommand("copy");}
      finally {input.remove(); previous?.focus?.({preventScroll:true});}
    }
    if (!copied) {editor.info("The clipboard is unavailable."); return false;}
    editor.info("Copied link to " + target.label);
    return true;
  }
  function receive(url) {
    const target = L.parse(url);
    if (!target) return false;
    return follow(target).then(result => {
      if (result.status !== "found")
        G.AtriumNavHost?.info({
          disabled:"Waffle links are available when Project Links is enabled in Experimental features.",
          "missing-project":"The project for this link could not be found.",
          "project-mismatch":"The selected project does not match this link.",
          "ambiguous-project":"More than one recent project has this identity. Open the intended project first.",
          "missing-object":"The object for this link is missing.",
          "missing-fragment":"This datasheet page is unavailable.",
          "missing-document":"The document for this link is unavailable.",
          "missing-frame":"The frame for this slide is unavailable.",
          partial:"This link could not be checked because part of the project is unavailable.",
          ambiguous:"More than one object has this identity.",
          busy:"Another Waffle link is opening."
        }[result.status] ?? "The Waffle link was not opened.");
      return result.status === "found";
    }, error => {G.AtriumNavHost?.info(error.message); return false;});
  }
  return Object.freeze({index:currentIndex, covered, complete, resolveTargets, gitPage, follow, copyLink, copyTarget, receive});
})();
