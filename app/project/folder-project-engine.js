"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../core/base64.js");
// A folder window's saved canonical owners live here, in the worker. Rendering receives only a
// projection. A save stages an immutable next cursor and installs it only at native durable ack.
globalThis.AtriumFolderProjectEngine = (() => {
  const utf8 = new TextEncoder();
  const DIR = {schematic: ".wsch", pcb: ".wpcb", drawing: ".wdraw", panel: ".wpanel", library: ".wlib"};
  const KINDS = Object.keys(DIR);
  const documentKeys = ["board", "sheet", "docId", "documentId"];
  const ownerReferenceKey = new RegExp('"(?:' + [...documentKeys, "sha256"].join("|") + ')":');
  const object = x => x && typeof x === "object";
  const sameAsset = (a,b) => a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mediaType === b.mediaType;
  const assetMetadata = ref => ref.mediaType + ":" + ref.byteLength;
  const tableOwner = row => row?.kind === "tableCell" ? row.tableId : row?.kind === "notebookTable" ? row.id : null;
  const tableAssetKey = (table,ref) => table + "\0" + ref.sha256;
  const assetConflict = () => { throw Error("Conflicting asset references."); };
  function bytesOf(record) {
    if (record.bytes instanceof Uint8Array) return record.bytes;
    if (record.bytes instanceof ArrayBuffer) return new Uint8Array(record.bytes);
    if (typeof record.data !== "string") throw Error("The folder reader did not return bytes for " + record.path + ".");
    return globalThis.AtriumBase64.decode(record.data);
  }
  const dataOf = globalThis.AtriumBase64.encode;
  const isDoc = kind => KINDS.includes(kind) && kind !== "library";
  const basename = path => path.split("/").at(-1);
  const stem = path => basename(path).replace(/\.[^.]+$/, "");
  function filename(name, kind) {
    if (typeof name !== "string" || name !== name.normalize("NFC") || !name || /[\\/:*?"<>|\u0000-\u001f\u007f]|[. ]$/.test(name)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || utf8.encode(name + DIR[kind]).length > 240) {
      throw Error("Choose a valid Waffle document name.");
    }
    return name + DIR[kind];
  }
  // Document rows contain their actual owning references. Never turn arbitrary strings or
  // provenance paths into authorised reads. A visible view requests just its geometry and images.
  function references(owner, membership) {
    const definitions = new Set(), documents = new Set(), assets = new Map();
    function walk(v) {
      if (!object(v)) return;
      if (Array.isArray(v)) {
        for (const child of v) if (object(child)) walk(child);
        return;
      }
      if (typeof v.def === "string" && (v.kind === "part" || membership.get(v.def)?.kind === "library")) definitions.add(v.def);
      for (const k of documentKeys) {
        if (typeof v[k] === "string" && isDoc(membership.get(v[k])?.kind) && v[k] !== owner.id) documents.add(v[k]);
      }
      if (v.sha256 !== undefined && /^[0-9a-f]{64}$/.test(v.sha256) && Number.isSafeInteger(v.byteLength) && v.byteLength >= 0 && typeof v.mediaType === "string")
        assets.set(v.sha256, {sha256: v.sha256, mediaType: v.mediaType, byteLength: v.byteLength});
      for (const key of Object.keys(v)) {
        if (key.startsWith("x-")) continue;
        const child = v[key];
        if (object(child)) walk(child);
      }
    }
    walk(owner);
    return {definitions: [...definitions], documents: [...documents], assets: [...assets.values()]};
  }
  function parsedMember(record, codec, model, options) {
    const bytes = bytesOf(record);
    // A custom projection can derive references that have no corresponding on-disk property.
    const nativeDocument = isDoc(options.kind) && codec === globalThis.AtriumFormat2 && model === globalThis.AtriumFormat2Model;
    let ownerLinks = true;
    const file = model.parse(bytes, nativeDocument ? {...options, onDecoded(header, body) {
      ownerLinks = ownerReferenceKey.test(header) || ownerReferenceKey.test(body);
    }} : options);
    // Retained syntax may escape a key that the canonical reference scan would see.
    const noOwnerLinks = !ownerLinks && !file.newer && !file.readOnly && !file.retainsSyntax;
    return {file, noOwnerLinks, path: record.path, sha256: record.sha256, length: bytes.length};
  }
  function create(codec = globalThis.AtriumFormat2, model = globalThis.AtriumFormat2Model,
    upgrades = globalThis.AtriumFormat2Upgrades?.current) {
    const saved = new Map(), drafts = new Map(), external = new Map(), grantedAssets = new Map();
    const tableAssetIndexes = new WeakMap();
    let manifest, members, project, conversion, seq = 0;
    const itemAssets = item => item ? (model.ownerDependencies?.(item,{purpose:"save"}) || references(item,members).assets) : [];
    function countTableAsset(index, table, ref, delta) {
      const key=tableAssetKey(table,ref), metadata=assetMetadata(ref);
      let counts=index.get(key);
      if (!counts) index.set(key,counts=new Map());
      const count=(counts.get(metadata) || 0)+delta;
      if (count > 0) counts.set(metadata,count); else counts.delete(metadata);
      if (!counts.size) index.delete(key);
    }
    function tableAssetIndex(file, refs) {
      let index=tableAssetIndexes.get(file);
      if (!index) {
        index=new Map();
        for (const ref of refs ?? model.documentDependencies(file).assets) {
          const table=tableOwner(file.get(ref.ownerId));
          if (table) countTableAsset(index,table,ref,1);
        }
        tableAssetIndexes.set(file,index);
      }
      return index;
    }
    function checkTableAssets(file, row, dependencies, previous) {
      for (const ref of dependencies) {
        const counts=tableAssetIndex(file).get(tableAssetKey(row.tableId,ref));
        if (!counts) continue;
        const metadata=assetMetadata(ref), old=previous.find(asset=>asset.sha256 === ref.sha256);
        const replaced=old && assetMetadata(old);
        const removed=Number(replaced!==undefined && replaced!==metadata && counts.get(replaced)===1);
        if (counts.size > Number(counts.has(metadata))+removed) assetConflict();
      }
    }
    function tableAssetPatch(before, after, edits) {
      if (before === after || !tableAssetIndexes.has(before)) return;
      const changes=[];
      function take(file,id,delta) {
        const row=file.get(id), table=tableOwner(row);
        if (table) for (const ref of itemAssets(row)) changes.push({table,ref,delta});
      }
      for (const id of edits.remove) take(before,id,-1);
      for (const {id} of edits.put) {
        take(before,id,-1);
        take(after,id,1);
      }
      return {before,changes};
    }
    function applyManifest(record, install = true) {
      const item = parsedMember(record, codec, model, {kind: "project"});
      const projection = model.manifest(item.file);
      if (projection.releases?.length) projection.project.releaseDescriptors = model.releaseDescriptors(projection.releases);
      const indexed = projection.members.map(r => r.name ? r : {...r,name:stem(r.path)});
      if (install) {
        members = new Map();
        for (const ref of indexed) members.set(ref.id,ref);
        project = projection.project; manifest = item;
      }
      return {project:projection.project,members:indexed,entry:projection.entryDocument,
        newer: !!item.file.newer, readOnly: !!(item.file.readOnly || projection.readOnly),
        unsupportedFeatures:item.file.unsupportedFeatures ?? [], formatDiagnostic:codec.unsupportedMessage?.(item.file),
        manifestPath: item.path, sha256: item.sha256};
    }
    function projected(ref, item, file = item.upgrade ?? item.file) {
      const kind = ref.kind;
      const {owner, dependencies} = kind === "library" ? {owner: model.library(file)} :
        kind === "block" ? {owner: model.block(file)} : model.documentWithDependencies(file, {name:ref.name});
      if (dependencies && file.header.requires?.includes(codec.tableFeature)) tableAssetIndex(file,dependencies.assets);
      // A merged in-memory document can introduce links that were absent in the disk record.
      const deps = dependencies && file === item.file && item.noOwnerLinks ?
        {definitions: [], documents: [], assets: []} : references(owner, members);
      if (dependencies) {
        deps.definitions = dependencies.libraries;
        for (const asset of dependencies.assets)
          if (!deps.assets.some(r => r.sha256 === asset.sha256)) deps.assets.push(asset);
      }
      return {id: ref.id, kind, path: ref.path, owner, deps, sha256: item.sha256,
        readOnly: !!file.readOnly, unsupportedFeatures:file.unsupportedFeatures ?? [],
        formatDiagnostic:codec.unsupportedMessage?.(file), upgradePending:!!item.upgrade};
    }
    function readOwner(record, ref, install = true) {
      const item = parsedMember(record, codec, model, {kind:ref.kind, id:ref.id});
      codec.checkMemberVersion(manifest.file, item.file);
      if (isDoc(ref.kind) && !item.file.readOnly && !item.file.retainsSyntax &&
          upgrades?.pending(item.file.header.formatVersion)) {
        const {header, records} = upgrades.project(item.file.header, item.file.records());
        item.upgrade = codec.create(header, records, model.readOptions(ref.kind, ref.id));
      }
      const result = projected(ref, item);
      if (install) saved.set(ref.id, item);
      else external.set(ref.id, {ref,item});
      return result;
    }
    function resolveExternal({id, choice, change}) {
      const incoming = external.get(id), previous = saved.get(id);
      if (!incoming) throw Error("Read the changed file again.");
      const {ref,item} = incoming;
      let file = item.upgrade ?? item.file;
      if (choice !== "disk" && change) {
        if (ref.kind === "library" || change.deleted || change.owner || change.name && change.name !== ref.name)
          throw Error("Resolve this structural change by accepting the disk version or saving a copy.");
        const patch = editDocument(previous, change);
        const conflicts = [...patch.put.map(r => r.id), ...patch.remove].filter(id =>
          JSON.stringify(previous.file.get(id)) !== JSON.stringify(item.file.get(id)));
        if (patch.header && JSON.stringify(previous.file.header) !== JSON.stringify(item.file.header))
          conflicts.push(item.file.header.id);
        if (choice === "merge" && conflicts.length) return {conflicts};
        file = codec.applyDelta(item.file, patch).file;
      }
      const result = projected(ref, item, file);
      return result;
    }
    function acceptExternal(id) {
      const next = external.get(id);
      if (!next) return false;
      saved.set(id,next.item);
      return external.delete(id);
    }
    const editItem = item => typeof item === "string" ? JSON.parse(item) : item;
    function editDocument(base, change, state, put = change.put.map(editItem)) {
      const doc = change.settings || {id: change.id, kind: change.kind};
      if(change.tableCells?.length && change.tableBase!==base.sha256)throw Error(model.tableEditStale);
      return model.documentEdits(base.file, doc, {put,remove:change.remove,tableCells:change.tableCells,settings:!!change.settings,
        copperBases:change.copperBases,state});
    }
    const physical = file => codec.serializePhysical?.(file) ?? codec.serialize(file);
    function write(path, expected, file, edits) {
      return edits ? edits.length ? {path, expected, splice: {base: expected, edits}} : null :
        {path, expected, data: dataOf(physical(file))};
    }
    function convertOwner(change,state,put) {
      const factory = change.kind === "library" ? model.createLibrary : model.createDocument;
      if (typeof importScripts === "function" && !globalThis.AtriumFormat2Models) loadModelCodec();
      if (change.kind === "library") return factory(change.owner,{state});
      if (!change.owner) throw Error("Read the new document before saving it.");
      const items = new Map((change.owner.items || []).map(item => [item.id,item]));
      for (const id of change.remove || []) items.delete(id);
      for (const item of put) items.set(item.id,item);
      return factory({...change.owner,...change.settings,items:[...items.values()]},{state});
    }
    function appendOrder(tail) { return (tail || "") + "V"; }
    const rawPath = (id,kind,name) => kind === "library" ? "libraries/" + filename(id,kind) : filename(name,kind);
    function parseNativeCopy({id,kind,bytes}) {
      const file = model.parse(bytes,{kind,id});
      codec.checkMemberVersion(manifest.file,file);
      if (!file.readOnly) throw Error("The native copy does not require read-only handling.");
      return file;
    }
    async function validateNativeCopy(copy, read) {
      const file = parseNativeCopy(copy), path = rawPath(copy.id,copy.kind,copy.name);
      const ids = new Set([copy.id,...[...file.records()].map(row => row.id)]);
      if (ids.has(manifest.file.header.id) || [...manifest.file.records()].some(row => ids.has(row.id)))
        throw Error("A document or record in this read-only file already exists in the project.");
      const check = row => {
        if (codec.pathKey(row.path) === codec.pathKey(path))
          throw Error("A file with that name already exists in the project.");
      };
      for (const ref of members.values()) {
        check(ref);
        if (ref.kind !== "library" && !isDoc(ref.kind)) continue;
        const entry = await read(ref.path);
        const existing = model.parse(bytesOf(entry),{kind:ref.kind,id:ref.id});
        if ([...existing.records()].some(row => ids.has(row.id)))
          throw Error("A record in this read-only file already exists in the project.");
      }
      if (await read(path,true)) throw Error("A file with that name already exists in the project folder.");
      return {path, ids:[...ids], diagnostic:codec.unsupportedMessage?.(file)};
    }
    function plan(message) {
      if (manifest.file.readOnly) throw new codec.FormatError("read-only-format", codec.unsupportedMessage?.(manifest.file) ||
        "This project requires a newer Waffle version and is read-only.");
      const targets = [], updates = new Map(), membership = [], dropped = [], assets = new Map(), existingAssets = new Map();
      const requirements = new Map();
      const encoded = {payloads:new Map(),models:new Map(),residuals:[],modelDiagnostics:[],trackResiduals:false};
      let rowsEncoded = 0, stagedBytes = 0;
      const manifestEdit = message.manifest ? model.manifestEdits(manifest.file, message.manifest) : null;
      let tail, upgraded;
      function retainAsset(ownerId, asset, knownAssets) {
        const requested = requirements.get(asset.sha256), grant = grantedAssets.get(asset.sha256);
        if (requested && !sameAsset(requested,asset) || grant && !sameAsset(grant,asset)) assetConflict();
        requirements.set(asset.sha256,asset);
        if (grant || knownAssets.some(ref=>sameAsset(ref,asset))) return;
        const staged = message.attachments.find(a => a.ownerId === ownerId && sameAsset(a.assetRef,asset));
        if (staged) assets.set(asset.sha256,{ref:asset,request:{path:"assets/"+asset.sha256,expected:null,assetToken:staged.assetToken}});
        else existingAssets.set(asset.sha256,asset);
      }
      function retainDependencies(ownerId, dependencies, known) {
        for (const asset of dependencies) retainAsset(ownerId,asset,known);
      }
      const activeUpgrade = message.upgradeOwnerId, changes = [...message.changes];
      if (saved.get(activeUpgrade)?.upgrade && !changes.some(change => change.id === activeUpgrade))
        changes.push({id:activeUpgrade, put:[], remove:[]});
      for (const change of changes) {
        const base = saved.get(change.id), ref = members.get(change.id);
        if (base?.file.readOnly && !(change.deleted && change.nativeCopy)) throw new codec.FormatError("read-only-format", codec.unsupportedMessage?.(base.file) ||
          ref.name + " requires a newer Waffle version and is read-only.");
        if (base?.upgrade && !change.deleted && change.id !== activeUpgrade)
          throw new codec.FormatError("read-only-format", "Save " + ref.name + " on its own to upgrade its native format.");
        if (change.deleted) {
          if (ref) {
            if (!base) throw Error("Read " + ref.name + " before removing it.");
            if (change.copyProof && change.copyProof.sha256 !== base.sha256)
              throw Error(ref.name + " has changed on disk. It could not be removed by Undo.");
            targets.push({path:ref.path,expected:base.sha256,remove:true,
              ...(change.copyProof && {nativeCopy:change.copyProof})});
            dropped.push(change.id);
          }
          continue;
        }
        const name = change.name || ref?.name || change.owner?.name, kind = ref?.kind || change.kind;
        const renamed = !!ref && isDoc(kind) && ref.name !== name;
        const path = renamed ? ref.path.slice(0, ref.path.length - basename(ref.path).length) + filename(name, kind) :
          ref ? ref.path : kind === "library" ? "libraries/" + filename(change.id, kind) : filename(name, kind);
        if (!base || renamed) {
          const old = ref && manifest.file.get(ref.id);
          tail ??= manifest.file.tailOrder;
          membership.push({...old, kind: isDoc(kind) ? "document" : "library", id: change.id,
            ...(isDoc(kind) ? {docKind: kind} : {}), name, path, order:old?.order || (tail = appendOrder(tail))});
        }
        let result = null, file, schematicEdits;
        if(change.tableCells?.length && (!base || base.upgrade || renamed || kind!=="schematic"))throw Error(model.tableEditStale);
        const put = !base && change.nativeCopy ? [] : (change.put || []).map(editItem);
        if (!base) file = change.nativeCopy ? parseNativeCopy({...change,bytes:change.nativeCopy}) : convertOwner(change,encoded,put);
        else {
          if (base.upgrade) codec.checkMemberVersion(manifest.file, base.upgrade);
          const editing = base.upgrade ? {...base, file:base.upgrade} : base;
          if (kind === "library" && typeof importScripts === "function" && !globalThis.AtriumFormat2Models) loadModelCodec();
          const edits = kind === "library" ? model.libraryEdits(editing.file, change.owner, {state:encoded}) : editDocument(editing,change,encoded,put);
          if (kind === "schematic" && !base.upgrade) schematicEdits = edits;
          result = codec.applyDelta(editing.file, edits);
          if (base.upgrade) {
            result.splices = null; // The offsets still name the older physical owner.
            upgraded = change.id;
          }
          rowsEncoded += (edits.put?.length || 0) + Number(!!edits.header);
          file = result.file;
        }
        if (!result) rowsEncoded += file.size + 1;
        if (codec.tableFeature) {
          const at = membership.findIndex(row => row.id === change.id);
          const reference = at >= 0 ? membership[at] : ref && manifest.file.get(ref.id);
          const next = reference && codec.tableReference(reference,file);
          if (next && next !== reference) {
            if (at >= 0) membership[at] = next;
            else membership.push(next);
          }
        }
        if (!change.nativeCopy) {
          for (const value of change.owner?.items ?? []) {
            const item = editItem(value);
            retainDependencies(change.id,itemAssets(item),itemAssets(base?.file.get(item.id)));
          }
          const certifiedTables = new Set(change.tableCells?.map(edit => edit.id));
          const comparedTables = new Set(certifiedTables);
          for (const item of put) {
            // Full validation also detects one asset hash used with conflicting type or length
            // across cell and fallback references in the same table.
            const dependencies = itemAssets(item);
            if (!dependencies.length) continue;
            const previous = base?.file.get(item.id);
            const native = schematicEdits && previous?.kind === "notebookTable" && file.get(item.id);
            if (native?.kind === "notebookTable") {
              // The physical table owner contains its own asset references. The planned cell rows
              // below account for changed cell references without requiring unchanged placeholders.
              comparedTables.add(item.id);
              retainDependencies(change.id,itemAssets(native),itemAssets(previous));
            } else retainDependencies(change.id,dependencies,itemAssets(previous));
          }
          if (comparedTables.size) for (const row of schematicEdits.put) {
            if (row.kind !== "tableCell" || !comparedTables.has(row.tableId)) continue;
            const dependencies=itemAssets(row);
            if (!dependencies.length) continue;
            const known=itemAssets(base.file.get(row.id));
            if (certifiedTables.has(row.tableId)) checkTableAssets(base.file,row,dependencies,known);
            retainDependencies(change.id,dependencies,known);
          }
        }
        if (!base && change.nativeCopy) {
          targets.push({path,expected:null,data:dataOf(change.nativeCopy),...(change.copyProof && {nativeCopy:change.copyProof})});
        } else if (renamed && base && file === base.file) {
          // The source owner's canonical bytes can be reused verbatim on a pure rename.
          targets.push({path, expected: null, data: dataOf(physical(file))});
        } else {
          const entry = write(path, base && !renamed ? base.sha256 : null, file, renamed ? null : result?.splices);
          if (entry) targets.push(entry);
        }
        if (renamed) {
          const removing = {path: ref.path, expected: base.sha256, remove: true};
          if (codec.pathKey(path) === codec.pathKey(ref.path)) targets.splice(targets.length - 1, 0, removing);
          else targets.push(removing);
        }
        if (file !== base?.file || renamed) stagedBytes += file.byteLength;
        const assetPatch=schematicEdits && tableAssetPatch(base.file,file,schematicEdits);
        updates.set(change.id, {file, path, assetPatch});
      }
      const importChanges = new Map(message.importIndexes?.map(ref => [ref.id, ref]));
      const detached = [];
      if (message.importIndexes) {
        for (const r of members.values()) if (r.kind === "import-index" && !importChanges.has(r.id)) detached.push(r.id);
        for (const [id, row] of importChanges)
          if (manifest.file.get(id) && codec.canonical(manifest.file.get(id)) === codec.canonical(row)) importChanges.delete(id);
      }
      const put = [...(manifestEdit?.put || []), ...membership, ...importChanges.values()];
      for (const row of manifestEdit?.put ?? []) if (row.kind === "datasheetRef" && row.value.asset) {
        const prior = manifest.file.get(row.id)?.value?.asset;
        retainAsset(manifest.file.header.id,row.value.asset,prior ? [prior] : []);
      }
      const remove = [...(manifestEdit?.remove || []), ...dropped, ...detached];
      if (put.length || remove.length || manifestEdit?.header) {
        let header = manifestEdit?.header;
        if (dropped.includes(manifest.file.header.entryDocument)) {
          header = {...(header || manifest.file.header)};
          delete header.entryDocument;
        }
        let featureChange;
        if (codec.tableFeature && (membership.length || dropped.length)) {
          const changed = new Map(membership.map(row => [row.id,row]));
          const left = new Set(dropped);
          const need = membership.some(row => row.requires?.includes(codec.tableFeature)) ||
            [...manifest.file.records()].some(row => row.kind === "document" && !changed.has(row.id) && !left.has(row.id) && row.requires?.includes(codec.tableFeature));
          if (!!manifest.file.header.requires?.includes(codec.tableFeature) !== need) {
            header = codec.withTable(header || manifest.file.header,need);
            featureChange = codec.tableFeature;
          }
        }
        const delta = {put,remove,...(header ? {header} : {}),...(featureChange ? {featureChange} : {})};
        const {file, splices} = codec.applyDelta(manifest.file, delta);
        const entry = write(manifest.path, manifest.sha256, file, splices);
        if (entry) { targets.push(entry); stagedBytes += file.byteLength; }
        rowsEncoded += put.length + Number(!!delta.header);
        updates.set(manifest.file.header.id, {file, path: manifest.path, manifest: true});
      }
      const token = ++seq;
      const payloads = new Map();
      for (const payload of encoded.payloads.values()) {
        const required=requirements.get(payload.ref.sha256);
        if (required && !sameAsset(required,payload.ref)) assetConflict();
        payloads.set(payload.path,{bytes:payload.bytes,sha256:payload.sha256});
        assets.delete(payload.ref.sha256);
        existingAssets.delete(payload.ref.sha256);
      }
      for (const model of encoded.models.values()) {
        const bytes = loadModelCodec().encode(model.raw);
        payloads.set(model.path,{bytes,sha256:codec.sha256(bytes)});
      }
      const binary = [...payloads].map(([path,{bytes}]) => ({path,expected:null,data:dataOf(bytes)}));
      drafts.set(token, {updates,membership,dropped,detached,imports:[...importChanges.values()],assets});
      const plan = [...binary,...Array.from(assets.values(),asset=>asset.request),...targets], transferBytes = plan.reduce((total, entry) =>
        total + (entry.data?.length || 0) + (entry.splice?.edits || []).reduce((n,row)=>n+utf8.encode(row.insert).length,0), 0);
      for (const {assetRef} of message.attachments) if (assets.has(assetRef.sha256)) stagedBytes += assetRef.byteLength;
      for (const {bytes} of payloads.values()) stagedBytes += bytes.length;
      return {token,plan,membership,dropped,upgraded,payloads:[...payloads].map(([path,{sha256}]) => ({path,sha256})),
        existingAssets:[...existingAssets.values()].filter(r => !assets.has(r.sha256)),
        metrics:{rowsEncoded,unrelatedVisits:0,stagedBytes,transferBytes}};
    }
    function accepted(token, hashes) {
      const next = drafts.get(token);
      if (!next) return false;
      drafts.delete(token);
      for (const id of [...next.dropped,...next.detached]) { saved.delete(id); members.delete(id); }
      for (const r of next.membership) members.set(r.id, {...r, kind: r.docKind || r.kind});
      for (const r of next.imports) members.set(r.id,{...r,kind:"import-index"});
      for (const [hash,{ref}] of next.assets) grantedAssets.set(hash,ref);
      for (const [id, member] of next.updates) {
        const hash = hashes[member.path];
        if (!hash) continue;
        const {assetPatch,...current}=member;
        const previous=saved.get(id);
        // Advance an index only from the saved cursor that actually supplied this plan.
        if (assetPatch && previous?.file === assetPatch.before && !tableAssetIndexes.has(current.file)) {
          const index=tableAssetIndexes.get(previous.file);
          if (index) {
            for (const {table,ref,delta} of assetPatch.changes) countTableAsset(index,table,ref,delta);
            tableAssetIndexes.delete(previous.file);
            tableAssetIndexes.set(current.file,index);
          }
        }
        const base = {...current, sha256: hash};
        if (member.manifest) manifest = base; else saved.set(id, base);
      }
      return true;
    }
    async function readClosure({record,full,read,readBatch,verifyOnly,proveModels}) {
      const root = applyManifest(record), refs = new Map(root.members.map(r => [r.path,r]));
      const kindOf = ref => ref?.kind === "library" ? "library" : ref?.kind === "block" ? "layoutBlocks" :
        isDoc(ref?.kind) ? "documents" : null;
      if (full) {
        const owners = new Map();
        if (!globalThis.AtriumFormat2Closure && typeof importScripts === "function")
          importScripts("../formats/import-sidecars.js","../formats/format-2-closure.js");
        const verify = globalThis.AtriumFormat2Closure.verify;
        const checked = await verify(manifest.file,async (path,ref) => bytesOf(await read(path,ref)),{
          accelerateDigests:true,
          loadModels:() => loadModelCodec(false),
          proveModels:verifyOnly && proveModels,
          readBatch:readBatch && (async (paths,refs) => (await readBatch(paths,refs)).map((value,index)=>
            verifyOnly && proveModels && refs[index].kind === "model" ? value : bytesOf(value))),
          onNative(file, ref) {
            const live = refs.get(ref.path), list = kindOf(live);
            if (list) {
              const {owner} = projected(live,{file});
              if (!verifyOnly) owners.set(live,owner);
            }
          }
        });
        if (verifyOnly) return {sha256:checked.sha256};
        for (const ref of root.members) {
          const list = kindOf(ref);
          if (list) (root.project[list] ||= []).push(owners.get(ref));
        }
        return {project:root.project,...checked};
      }
      const owners = root.members.filter(kindOf);
      const width = readBatch ? 8 : 1;
      for (let offset = 0; offset < owners.length; offset += width) {
        const group = owners.slice(offset,offset+width);
        const records = group.length === 1 ? [await read(group[0].path,group[0])] :
          await readBatch(group.map(ref => ref.path));
        for (const [index,ref] of group.entries())
          (root.project[kindOf(ref)] ||= []).push(readOwner(records[index],ref).owner);
      }
      return {project:root.project};
    }
    function copyPlan({files,plan,original,manifest:target}) {
      const rows = new Map(files.map(row => [row.path,row]));
      for (const change of plan) {
        const previous = rows.get(change.path);
        if ((previous ? (previous.sha256 || codec.sha256(bytesOf(previous))) : null) !== change.expected)
          throw Error(change.path + " changed on disk. Review it before saving a copy.");
        if (change.remove) { rows.delete(change.path); continue; }
        if (change.splice) {
          const current = bytesOf(previous);
          let offset = 0;
          const parts = [];
          for (const edit of change.splice.edits) {
            parts.push(current.subarray(offset,edit.offset),utf8.encode(edit.insert));
            offset = edit.offset + edit.remove;
          }
          parts.push(current.subarray(offset));
          const bytes = new Uint8Array(parts.reduce((n,part) => n + part.length,0));
          let at = 0;
          for (const part of parts) { bytes.set(part,at); at += part.length; }
          rows.set(change.path,{path:change.path,bytes});
        } else rows.set(change.path,change);
      }
      const manifestRow = rows.get(original);
      rows.delete(original);
      const rename = new Set([...rows.keys()].map(codec.pathKey));
      if (rename.has(codec.pathKey(target))) throw Error("The folder manifest name collides with a project member.");
      rows.set(target,{...manifestRow,path:target});
      return [...rows.values()].map(({path,data,bytes,text}) =>
        ({path,expected:null,data:data ?? dataOf(bytes || utf8.encode(text))}));
    }
    function conversionMembers() {
      const {manifestPath,files,assets,models} = conversion;
      const rows = files.filter(row => row.path !== manifestPath).map(({path,file}) => ({path,bytes:codec.serialize(file)}));
      rows.push(...assets);
      for (const {path,bytes,raw} of models) rows.push({path,bytes:bytes || loadModelCodec().encode(raw)});
      return rows;
    }
    async function run({op, ...m}) {
      switch (op) {
        case "manifest": return applyManifest(m.record, m.install !== false);
        case "owner": return readOwner(m.record, m.ref, m.install !== false);
        case "owners": return m.records.map((record,i) => readOwner(record,m.refs[i]));
        case "workspaceReferences": {
          const loaded = new Map(m.documents.map(row => [row.id,row]));
          return references(m.owner, {get:id => loaded.get(id) ?? members.get(id)}).documents;
        }
        case "savedOwner": {
          const ref = members.get(m.id), item = saved.get(m.id);
          return ref && item ? projected(ref,item) : null;
        }
        case "restoreMember": {
          const ref = members.get(m.id), base = saved.get(m.id);
          if (!ref || !m.bytes && !base) throw Error("Choose the missing project document.");
          let bytes = m.bytes;
          if (bytes) codec.checkMemberVersion(manifest.file, model.parse(bytes,{kind:ref.kind,id:ref.id}));
          else bytes = physical(base.file);
          return {path:ref.path,expected:null,data:dataOf(bytes)};
        }
        case "resolveExternal": return resolveExternal(m);
        case "acceptExternal": return acceptExternal(m.id);
        case "asset": {
          const bytes = bytesOf(m.record);
          if (codec.sha256(bytes) !== m.asset.sha256 || bytes.length !== m.asset.byteLength) throw Error("The attachment has changed on disk.");
          if (m.persisted !== false) {
            const old=grantedAssets.get(m.asset.sha256);
            if (old && !sameAsset(old,m.asset)) assetConflict();
            grantedAssets.set(m.asset.sha256,m.asset);
          }
          return {bytes, assetRef: m.asset};
        }
        case "invalidateAsset": return grantedAssets.delete(m.sha256);
        case "readModel": {
          const ref = model.modelRef(m.modelRef);
          const record = await m.read(model.modelPath(ref));
          return {bytes:loadModelCodec(false).decode(bytesOf(record),ref)};
        }
        case "validateMerged": {
          const kind = m.path.endsWith(".waffle") ? "project" : m.path.endsWith(".wblock") ? "block" :
            KINDS.find(kind => m.path.endsWith(DIR[kind]));
          if (!kind) throw Error("This type cannot be merged as native records.");
          const file = model.parse(m.text,{kind});
          if (kind === "project") model.manifest(file);
          return true;
        }
        case "draftDependency": {
          const entry = parsedMember(m.record,codec,model,{kind:m.ref.kind,id:m.ref.id});
          const row = projected(m.ref,entry);
          return {...row,binaries:model.dependencies(entry.file),newer:entry.file.newer};
        }
        case "draftBinary": {
          const bytes = bytesOf(m.record), a = m.asset;
          if (a.kind === "model") await loadModelCodec().decode(bytes,{sha256:a.sha256,byteLength:a.byteLength});
          else if (codec.sha256(bytes) !== a.sha256 || bytes.length !== a.byteLength) throw Error("The recovery original changed.");
          return dataOf(bytes);
        }
        case "sameSettings": return codec.canonical(m.left) === codec.canonical(m.right);
        case "draftOwners": {
          // Work from the same immutable saved cursor and deltas used by Save, without advancing it.
          const staged = plan(m), candidate = drafts.get(staged.token);
          try {
            const rows = m.changes.map(change => {
              const before = saved.get(change.id), ref = members.get(change.id);
              const next = candidate.updates.get(change.id);
              const kind = ref?.kind || change.kind, name = change.name || ref?.name || change.owner?.name;
              const description = {id:change.id, kind, name, baseHash:before?.sha256 || null, basePath:ref?.path || null,
                path:next?.path || ref?.path, deleted:!!change.deleted, seq:change.seq, group:change.group};
              if (!next) return {...description, owner:before && projected(ref,before).owner, desiredHash:null, assetRefs:[]};
              const projectedOwner = projected({id:change.id,kind,name,path:next.path},next);
              const bytes = physical(next.file);
              const binaries = model.dependencies ? model.dependencies(next.file) : projectedOwner.deps.assets;
              return {...description,owner:projectedOwner.owner,desiredHash:codec.sha256(bytes),binaries,
                ...(change.nativeCopy ? {nativeCopy: change.nativeCopy} : {}),
                deps:projectedOwner.deps,newer:!!next.file.newer,assetRefs:binaries.filter(a => a.kind !== "model")};
            });
            const originals = staged.plan.filter(p => p.data && p.path.startsWith("assets/")).map(p => ({sha256:p.path.slice(7),data:p.data}));
            return {rows,originals,verify:staged.existingAssets.map(a => a.sha256)};
          } finally { drafts.delete(staged.token); }
        }
        case "validateNativeCopy": return validateNativeCopy(m,m.read);
        case "plan": return plan(m);
        case "matchesSaved": {
          const change = m.change, base = saved.get(change.id), ref = members.get(change.id);
          if (!base || !ref || !isDoc(ref.kind) || change.owner || change.deleted || change.name && change.name !== ref.name) return false;
          return codec.applyDelta(base.file, editDocument(base, change)).file === base.file;
        }
        case "accepted": return accepted(m.token, m.hashes || {});
        case "aborted": return drafts.delete(m.token);
        case "closure": return readClosure(m);
        case "copy": return copyPlan(m);
        case "convert": {
          if (m.project.revisions?.length && typeof importScripts === "function") importScripts("../project/revisions.js");
          if (typeof importScripts === "function" && !globalThis.AtriumTranslatorProvenance) importScripts("../formats/translator-provenance.js");
          const modelCodec = loadModelCodec(), source = m.provenance ? {model:m.project,provenance:m.provenance} : m.project;
          conversion = model.fromEditor(source,{
            manifestPath:m.manifest,entryDocument:m.entryDocument,encodeModel:m.deferModelEncoding ? false : modelCodec.encode
          });
          return {residuals:conversion.residuals,modelDiagnostics:conversion.modelDiagnostics};
        }
        case "draftConversionMembers": {
          if (!conversion) throw Error("Start the native conversion before preparing the recovery draft.");
          // The import binding depends on the precision residuals, but the other
          // members can be built while the editor prepares that binding.
          const {manifest,manifestPath} = conversion;
          return {members:[{path:manifestPath,bytes:codec.serialize(manifest)},...conversionMembers()]};
        }
        case "conversionPlan": {
          if (!conversion) throw Error("Start the native conversion before saving it.");
          const {manifestPath} = conversion;
          const root = codec.edit(conversion.manifest,{put:m.importIndexes || []});
          const rows = conversionMembers();
          const digests = rows.map(r => ({path:r.path,sha256:codec.sha256(r.bytes)}));
          digests.push(...(m.extraMembers || []));
          rows.push({path:manifestPath,bytes:codec.serialize(root)});
          const plan = [
            ...(m.extras || []).map(({path,expected,text,data}) => ({path,expected,data:data ?? dataOf(utf8.encode(text))})),
            ...rows.map(({path,bytes}) => ({path,expected:null,data:dataOf(bytes)}))
          ];
          return {plan,projectId:root.header.id,version:codec.projectDigest(root,digests)};
        }
        default: throw Error("Unknown folder project worker action " + op + ".");
      }
    }
    return {run};
  }
  function loadModelCodec(encode = true) {
    if (typeof importScripts === "function") {
      if (!globalThis.AtriumFormat2Models) importScripts("../core/zip.js", "../formats/sexpr.js", "../formats/format-2-models.js");
      if (encode && !globalThis.AtriumZipDeflate) importScripts("../vendor/zipjs-deflate.js");
    }
    if (!globalThis.AtriumFormat2Models) throw Error("The native 3D model codec is unavailable.");
    return globalThis.AtriumFormat2Models;
  }
  return Object.freeze({create, bytesOf, dataOf, references, filename});
})();
