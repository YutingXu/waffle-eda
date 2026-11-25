"use strict";
// Command arguments carry addresses and stable IDs. Only the desktop adapter
// handles clipboard writes and project selection after an explicit invocation.
(() => {
  const G = globalThis, L = G.AtriumLinks;
  const fail = (code, message) => {throw Object.assign(Error(message), {code});};
  function readAddress(url) {
    const address = L.parse(url);
    if (!address) fail("invalid_link", "Choose a valid Waffle record link.");
    return address;
  }
  function edit(path, before, after) {
    return {op:"set", target:"project", path, ...(before !== undefined && {before}), ...(after !== undefined && {after})};
  }
  function linkOf(project, recordId) {
    const record = project.links?.[recordId];
    if (!L.validRecord(record)) fail("missing_link", "This stored link no longer exists.");
    return record;
  }
  const desktop = context => context.source === "editor" && context.isCurrent?.() === true ? G.AtriumLinksDesktop : null;
  const covered = context => desktop(context)?.covered() ?? true;
  function resolveTarget(context, target, complete = true) {
    return context.services.resolveLinkTargets([target], {complete})[0];
  }
  function resolve({url}, context) {
    return resolveTarget(context, readAddress(url), covered(context));
  }
  function selectedTarget(args, context) {
    const {project, selection, documentId} = context;
    const objectId = args.objectId ?? selection?.[0] ?? documentId;
    if (!G.AtriumLinkRecord.id(project.id) || !G.AtriumLinkRecord.id(objectId))
      return {status:"missing-identity"};
    return resolveTarget(context, {projectId:project.id, objectId});
  }
  function copyLink(args, context) {
    const resolved = selectedTarget(args, context);
    if (resolved.status !== "found") return resolved;
    const {target} = resolved, url = L.format(target);
    const result = {status:"found", url, label:target.label, target};
    if (context.mode !== "write") return result;
    const adapter = desktop(context);
    if (!adapter) return {...result, copied:false};
    return adapter.copyTarget(target).then(copied => ({...result, copied}));
  }
  function listLinks({offset = 0, limit = 100}, {project}) {
    const rows = Object.values(project.links ?? {});
    return {total:rows.length, offset, rows:rows.slice(offset, offset + limit)};
  }
  function status({recordId}, context) {
    const {project} = context, record = linkOf(project, recordId);
    const [source, target] = context.services.resolveLinkTargets([{projectId:project.id, objectId:record.source.objectId}, record.target],
      {complete:covered(context)});
    if (source.status === "partial") return {status:"partial", record};
    if (source.status === "ambiguous") return {status:"ambiguous-source", record, candidates:source.candidates};
    if (source.status !== "found") return {status:"missing-source", record};
    return {record, ...target};
  }
  function backlinks({url, offset = 0, limit = 100, includeGit = false, gitOffset = 0, gitSnapshot}, context) {
    const target = readAddress(url), {project} = context;
    function collect(history) {
      const complete = covered(context);
      const indexed = desktop(context)?.index(project.id) ?? L.fromProject(project);
      const page = indexed.backlinkPage(target, {offset, limit, excludeCommits:includeGit});
      if (includeGit) {
        const commits = L.createIndex(context.project.id);
        commits.importCommits(history?.commits ?? []);
        const git = commits.backlinkPage(target, {offset:Math.max(0, offset - page.total), limit:limit - page.rows.length});
        page.total += git.total;
        page.rows.push(...git.rows);
      }
      return {target, status:L.resolve(context.project, target, indexed, {complete}).status, complete,
        offset, ...page,
        ...(includeGit && {git:{status:history?.status ?? "unavailable", snapshot:history?.snapshot, offset:gitOffset,
          complete:history?.status === "not-repository" || gitOffset === 0 && history?.status === "ready" && !history.more &&
            !(history.commits || []).some(row => row.recordLinksTruncated),
          nextOffset:history?.more ? gitOffset + history.commits.length : null}})};
    }
    const adapter = desktop(context);
    if (includeGit && adapter)
      return adapter.gitPage({offset:gitOffset, snapshot:gitSnapshot}, context.signal).then(collect);
    return collect(context.services.native);
  }
  function create({sourceId, url, label}, context) {
    const {project} = context, target = readAddress(url);
    const resolved = selectedTarget({objectId:sourceId}, context);
    if (resolved.status !== "found") return {result:resolved, ops:[]};
    const {documentId, kind} = resolved.target;
    const record = L.authoredRecord({objectId:sourceId, kind, ...(documentId && {documentId})}, target, label);
    return {result:{record, url}, ops:[edit(["links", record.id], undefined, record)]};
  }
  function rebind({recordId, url}, {project}) {
    const before = linkOf(project, recordId), target = readAddress(url);
    if (L.format(before.target) === url) return {result:{record:before, url}, ops:[]};
    const record = L.authoredRecord(before.source, target, before.label, before.id);
    return {result:{record, url}, ops:[edit(["links", recordId], before, record)]};
  }
  function remove({recordId}, {project}) {
    const before = linkOf(project, recordId);
    return {result:{recordId}, ops:[edit(["links", recordId], before)]};
  }
  function anchor(args, {project}) {
    if (!G.AtriumLinkRecord.id(project.id)) return {result:{status:"missing-identity"}, ops:[]};
    const result = L.anchorPlan(project, args);
    return {result, ops:result.created ? [edit(["linkAnchors", result.anchor.id], undefined, result.anchor)] : []};
  }
  function open({url}, context) {
    const target = readAddress(url);
    if (context.mode === "write") {
      const adapter = desktop(context);
      if (adapter) return adapter.follow(target);
      return {...resolveTarget(context, target), opened:false};
    }
    return resolveTarget(context, target, covered(context));
  }
  G.AtriumButter.register("links", {resolve, backlinks, "copy-link":copyLink, open, list:listLinks, status,
    create, rebind, remove, anchor});
})();
