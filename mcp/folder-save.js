"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../app/core/base64.js");

globalThis.AtriumMCPFolderSave = (() => {
  const F = globalThis.AtriumFormat2, M = globalThis.AtriumFormat2Model;
  const P = globalThis.AtriumProposal, C = globalThis.AtriumCollabCRDT;
  const text = new TextDecoder();
  const owners = list => new Map(list.map(owner => [owner.id, owner]));
  const own = (file, path) => ({path, text: text.decode((F.serializePhysical || F.serialize)(file))});
  const scalar = new Set(["order", "text", "name", "label", "ref", "value", "x", "y", "z", "w", "h", "width", "height",
    "size", "length", "radius", "diameter", "thickness", "rotation", "angle", "sweep", "layer", "hidden", "locked"]);
  const coordinates = new Set(["at", "start", "end", "points"]);
  const vector = value => Array.isArray(value) && value.length >= 2 && value.length <= 3 && value.every(Number.isSafeInteger);
  const writable = (key, value) => scalar.has(key) ? value == null || ["string", "boolean"].includes(typeof value) || Number.isSafeInteger(value) :
    coordinates.has(key) && Array.isArray(value) && (vector(value) || value.every(vector));
  const readOnly = () => new F.FormatError("read-only-revision", "This edit needs the Waffle version that saved the project.");

  function checkWritable(file) {
    const diagnostic = file && F.unsupportedMessage(file);
    if (diagnostic) throw new F.FormatError("read-only-format", diagnostic);
    if (file?.readOnly) throw readOnly();
  }

  function checkAdditive(file, delta) {
    if (!delta.splices || delta.headerChanged || file.readOnly) throw readOnly();
    const check = (a, b) => {
      if (a === b) return;
      if (a && b && a.kind !== b.kind) throw readOnly();
      for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        if (key === "kind" || key === "id" || P.equal(a?.[key], b?.[key])) continue;
        if (a && Object.hasOwn(a, key) && !writable(key, a[key]) || b && Object.hasOwn(b, key) && !writable(key, b[key])) throw readOnly();
      }
    };
    for (const row of file.records()) check(row, delta.file.get(row.id));
    for (const row of delta.file.records()) if (!file.get(row.id)) check(null, row);
  }

  // Compare the same projection on both sides. Existing records preserve their
  // original IDs and bytes if the authored value did not change.
  function libraryRecordDelta(base, before, after) {
    const key = row => row.kind === "projectSetting" ? row.kind + ":" + row.key :
      ["documentSettings", "librarySettings"].includes(row.kind) ? row.kind : row.id;
    const get = file => new Map(Array.from(file.records(), row => [key(row), row]));
    const previous = get(before), desired = get(after), exact = get(base);
    const put = [], remove = [];
    for (const identity of new Set([...previous.keys(), ...desired.keys()])) {
      const a = previous.get(identity), b = desired.get(identity);
      if (P.equal(a, b)) continue;
      let prior = exact.get(identity);
      if (a && !prior) prior = Array.from(exact.values()).find(row => row.kind === a.kind && row.side === a.side &&
        row.order === a.order && P.equal(row.value, a.value));
      if (a && !prior) throw Error("A changed record could not be matched to its saved ID: " + a.id + ".");
      if (b) {
        if (!a && prior) throw Error("A new record would replace an existing ID: " + b.id + ".");
        put.push(prior ? {...prior, ...b, id: prior.id,
          ...(a.order === b.order && Object.hasOwn(prior, "order") && {order: prior.order})} : b);
      } else remove.push(prior.id);
    }
    return {put, remove};
  }

  function orderKeys(next, saved) {
    const anchors = next.map(item => saved(item.id));
    const stable = anchors.filter(key => key != null);
    if (stable.some((item, i) => !/^[0-9A-Za-z]*[1-9A-Za-z]$/.test(item) || i && stable[i - 1] >= item)) {
      const spread = C.spread(next.length);
      return new Map(next.map((item, i) => [item.id, spread[i]]));
    }
    const right = anchors.slice();
    let later = null;
    for (let i = right.length - 1; i >= 0; i--) { right[i] = later; later = anchors[i] ?? later; }
    const keys = new Map();
    let order = null;
    for (const [i, item] of next.entries()) {
      order = anchors[i] ?? C.between(order, right[i]);
      keys.set(item.id, order);
    }
    return keys;
  }

  function deltaDocument(file, before, after, changes, itemPositions) {
    const itemOps = changes.filter(op => op.target === "item");
    const put = new Set(itemOps.filter(op => op.op !== "remove").map(op => op.id ?? op.value.id));
    const remove = itemOps.filter(op => op.op === "remove").map(op => op.id);
    const order = itemOps.some(op => op.op === "add") ? orderKeys(after.items, id => file.get(id)?.order) : null;
    let items;
    if (!order && itemPositions) {
      const ids = [...put], known = ids.map(id => after.items[itemPositions.get(id)]);
      if (known.every((item,index) => item?.id === ids[index])) items = known;
    }
    if (!items) {
      items = [];
      for (const item of after.items) {
        if (put.has(item.id) || order && order.get(item.id) !== file.get(item.id)?.order) {
          items.push(order ? {...item, order: order.get(item.id)} : item);
        }
      }
    }
    const settings = changes.some(op => op.target === "document" && op.path?.[0] !== "name");
    const edit = M.documentEdits(file, after, {put: items, remove, settings, ...(settings && {settingsBefore:before})});
    return F.applyDelta(file, edit);
  }

  function changed(path, delta) {
    if (!delta.changedRows && !delta.headerChanged) return null;
    return delta.splices ? {path, edits: delta.splices} : own(delta.file, path);
  }

  function plan(saved, before, after, manifestPath, ops, itemPositions) {
    const root = saved.root;
    checkWritable(root);
    if (!saved.version) throw readOnly();
    const additive = root.newer;
    if (ops.some(op => op.target === "project" && ["id", "format", "formatVersion", "layoutBlocks", "revisions", "revisionStore"].includes(op.path[0]))) {
      throw Error("This command needs a native layout-block, frozen-revision or format editor.");
    }
    const originalRefs = new Map(saved.manifest.members.map(ref => [ref.id, root.get(ref.id)]));
    const refs = new Map(originalRefs), plan = [], touched = new Map();
    const encoded = {payloads:new Map(),models:new Map(),residuals:[],modelDiagnostics:[],trackResiduals:false};
    const pathFor = M.pathPool([manifestPath, ...saved.manifest.members.map(ref => ref.path)]);
    const oldDocs = owners(before.documents), oldLibrary = owners(before.library);
    const docs = owners(after.documents), library = owners(after.library);
    const metadataFields = new Set();
    let membershipChanged = false, tableTransition = false;
    for (const op of ops) {
      if (op.target === "project") {
        const field = op.path[0];
        if (additive && (root.header.formatVersion !== "2.1" || !M.optionalProjectField(field))) throw readOnly();
        metadataFields.add(field);
        continue;
      }
      const id = P.memberOwner(op);
      if (!touched.has(id)) touched.set(id, []);
      touched.get(id).push(op);
    }
    for (const [id, changes] of touched) {
      const ref = refs.get(id), old = ref && saved.files.get(ref.path);
      checkWritable(old);
      const prior = oldDocs.get(id) ?? oldLibrary.get(id);
      const next = docs.get(id) ?? library.get(id), isDoc = docs.has(id) || oldDocs.has(id);
      if (additive && (!old || !prior || !next || old.readOnly || prior.kind !== next.kind || prior.name !== next.name)) throw readOnly();
      if (!next) {
        plan.push({path: ref.path, remove: true}); refs.delete(id);
        membershipChanged = true; continue;
      }
      const suffix = isDoc ? F.documentSuffix[next.kind] : ".wlib";
      if (!suffix || prior && isDoc && prior.kind !== next.kind) throw Error("The document type cannot be changed by this command.");
      const rename = isDoc && prior && next.name !== prior.name;
      const dir = ref ? ref.path.slice(0, ref.path.lastIndexOf("/") + 1) : isDoc ? "" : "libraries/";
      const natural = rename && M.pathPool()(dir, next.name, suffix);
      const sameName = natural && F.pathKey(natural) === F.pathKey(ref.path);
      const path = !ref || rename ? sameName ? natural : pathFor(dir, next.name, suffix) : ref.path;
      if (!old || path !== ref.path) {
        if (!ref && root.get(id)) throw Error("A new record would replace an existing ID: " + id + ".");
        const member = {kind: isDoc ? "document" : "library", id, path};
        refs.set(id, {...ref, ...member, ...(isDoc && {docKind: next.kind, name: M.pathStem(path, suffix)})});
        membershipChanged = true;
      }
      let delta, file;
      if (old) {
        if (isDoc) delta = deltaDocument(old, prior, next, changes, itemPositions);
        else if (changes.some(op => op.path?.includes("model3d"))) {
          const edits = M.libraryEdits(old,next,{state:encoded,blobs:after.blobs});
          delta = F.applyDelta(old,edits);
        } else {
          const desired = M.createLibrary(next);
          delta = F.applyDelta(old, {...libraryRecordDelta(old, M.createLibrary(prior), desired),
            header: {...old.header, name: desired.header.name}});
        }
        file = delta.file;
      } else file = isDoc ? M.createDocument(next) : M.createLibrary(next);
      if (isDoc && F.tableFeature) {
        const reference = refs.get(id), nextReference = F.tableReference(reference,file);
        if (nextReference !== reference) {
          if (additive && (root.header.formatVersion !== "2.1" || old?.header.formatVersion !== "2.0" || !delta?.headerChanged))
            throw readOnly();
          tableTransition = true;
          refs.set(id,nextReference);
          membershipChanged = true;
        }
      }
      if (additive && !(tableTransition && delta?.headerChanged && file.header.requires?.includes(F.tableFeature))) checkAdditive(old, delta);
      if (!old || path !== ref.path) {
        if (old) plan.push({path: ref.path, remove: true});
        plan.push(own(file, path));
      } else if (delta.changedRows || delta.headerChanged) plan.push(changed(path, delta));
    }
    if (metadataFields.size || membershipChanged) {
      let edits = {put:[],remove:[]};
      if (metadataFields.size) {
        // Headless validation can supply editor defaults. Only pass the authored
        // fields to the desktop metadata planner, based on the saved projection.
        const metadata = {...saved.manifest.project};
        for (const field of metadataFields) metadata[field] = after[field];
        edits = M.manifestEdits(root, metadata);
      }
      if (additive && !tableTransition) {
        if (edits.header || edits.put.some(row => !F.isOptionalManifestKind(row.kind)) ||
            edits.remove.some(id => !F.isOptionalManifestKind(root.get(id)?.kind))) throw readOnly();
      }
      if (membershipChanged) {
        for (const collection of [after.documents, after.library]) {
          if (!collection.some(item => !originalRefs.has(item.id))) continue;
          const keys = orderKeys(collection, id => originalRefs.get(id)?.order);
          for (const item of collection) refs.set(item.id, {...refs.get(item.id), order: keys.get(item.id)});
        }
        for (const [id, ref] of refs) if (!P.equal(ref, originalRefs.get(id))) edits.put.push(ref);
        for (const id of originalRefs.keys()) if (!refs.has(id)) edits.remove.push(id);
        const entryDocument = saved.manifest.entryDocument;
        if (entryDocument && !refs.has(entryDocument)) {
          edits.header = {...(edits.header || root.header)};
          delete edits.header.entryDocument;
        }
        const tableFeature = F.tableFeature, needed = [...refs.values()].some(ref => ref.requires?.includes(tableFeature));
        if (tableFeature && (root.header.requires?.includes(tableFeature) === true) !== needed) {
          edits.header = F.withTable(edits.header || root.header, needed);
          edits.featureChange = tableFeature;
        }
      }
      const delta = F.applyDelta(root, edits);
      if (membershipChanged) F.manifestMembers(delta.file);
      if (delta.changedRows || delta.headerChanged) plan.push(changed(manifestPath, delta));
    }
    if (encoded.models.size) {
      const modelWrites = [...encoded.models.values()].map(model => {
        const bytes = globalThis.AtriumFormat2Models.encode(model.raw);
        return {path:model.path,data:globalThis.AtriumBase64.encode(bytes)};
      });
      return [...modelWrites,...plan];
    }
    return plan;
  }

  return Object.freeze({plan});
})();
