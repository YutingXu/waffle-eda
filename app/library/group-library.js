"use strict";
// Immutable, content-addressed component and naming revisions. The published history is shared, while the
// installed revision and dismissed proposals belong to this member. Receiving a record never
// changes a head. The same history travels over a live session, in a bundle or in a Git checkout.
globalThis.AtriumGroupLibrary = (() => {
  const Store = () => globalThis.AtriumLibraryStore, Lib = () => globalThis.AtriumLibrary;
  const FORMAT = "atrium-group-library", VERSION = 1, MAX_EVENTS = 100000, MAX_EVENT = 48 * 1024 * 1024;
  const HASH = /^[0-9a-f]{64}$/, ID = /^[A-Za-z0-9_-]{1,100}$/;
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
  const insist = (ok, message) => { if (!ok) throw Error(message); };
  const same = (a, b) => Store().canonical(a) === Store().canonical(b);
  const hash = value => Store().sha256(Store().canonical(value));
  const states = ["draft", "review", "released", "deprecated"];
  const fields = {
    revision: new Set(["key", "group", "kind", "component", "parents", "rev", "author", "at", "note", "hash", "def"]),
    naming: new Set(["key", "group", "kind", "parents", "rev", "author", "at", "note", "hash", "conventions"]),
    decision: new Set(["key", "group", "kind", "target", "vote", "author", "at"])
  };
  function groupInfo(value) {
    insist(object(value) && typeof value.id === "string" && ID.test(value.id) && text(value.name, 120), "Invalid group library name or identifier.");
    return {id: value.id, name: value.name};
  }
  // Null identifies the single naming dictionary in this group's heads. Component ids are always strings.
  const entryOf = e => e.kind === "naming" ? null : e.component;
  const isRevision = e => e?.kind === "revision" || e?.kind === "naming";
  const dependencies = e => isRevision(e) ? e.parents : [e.target];
  const namingPayload = c => globalThis.AtriumNetIntentIndex.portableConventions(c);
  const NAMING_LIMIT = 16 * 1024;
  // Session peer keys expire. These keys identify an author across offline edits, other peers
  // forwarding history, bundle imports and Git. Only the public key travels with a record.
  const curve = {name: "ECDSA", namedCurve: "P-256"}, signing = {name: "ECDSA", hash: "SHA-256"};
  const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join("");
  const bytes = value => Uint8Array.from(value.match(/../g), digits => parseInt(digits, 16));
  const fingerprint = publicKey => "member-" + Store().sha256(bytes(publicKey));
  const message = key => new TextEncoder().encode("Waffle group library record v1\n" + key);
  function cryptoAPI() {
    const api = globalThis.crypto?.subtle;
    insist(api, "This browser needs Web Crypto to sign and verify group library records.");
    return api;
  }
  async function newSigningKey() {
    const api = cryptoAPI(), pair = await api.generateKey(curve, false, ["sign", "verify"]);
    const publicKey = hex(await api.exportKey("raw", pair.publicKey));
    return {id: fingerprint(publicKey), publicKey, privateKey: pair.privateKey};
  }
  async function seal(body, signer) {
    if (signer?.localOnly && text(signer.name, 80)) {
      body.localOnly = true; body.author = {id: signer.id, name: signer.name};
      return {...body, key: hash(body)};
    }
    insist(signer?.privateKey && text(signer.name, 80), "Choose your signing identity and display name.");
    body.author = {id: signer.id, name: signer.name, publicKey: signer.publicKey};
    const key = hash(body);
    const signature = hex(await cryptoAPI().sign(signing, signer.privateKey, message(key)));
    return {...body, key, signature};
  }
  async function verify(e, local) {
    if (Object.hasOwn(e, "localOnly")) {
      insist(local && e.localOnly === true && !e.signature && !e.author.publicKey && e.author.id.startsWith("local-"),
        "A local-only record cannot be received from another library.");
      return;
    }
    const pub = e.author.publicKey;
    if (!Object.hasOwn(e.author, "publicKey") && !Object.hasOwn(e, "signature")) {
      insist(e.kind !== "naming", "A naming conventions revision needs a member signature.");
      insist(!/^member-[a-f0-9]{64}$/.test(e.author.id), "This member’s signature is missing.");
      return; // Older history remains readable, explicitly marked as unsigned.
    }
    insist(typeof pub === "string" && /^04[0-9a-f]{128}$/.test(pub) && fingerprint(pub) === e.author.id &&
      typeof e.signature === "string" && /^[0-9a-f]{128}$/.test(e.signature), "The member’s signing identity is invalid.");
    const api = cryptoAPI();
    const key = await api.importKey("raw", bytes(pub), curve, false, ["verify"]);
    insist(await api.verify(signing, key, bytes(e.signature), message(e.key)), "The member’s signature could not be verified.");
  }
  function validate(e, info) {
    insist(object(e) && HASH.test(e.key) && e.group === info.id && text(e.author?.name, 80) && typeof e.author.id === "string" && ID.test(e.author.id) &&
      typeof e.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at), "Invalid group library record.");
    insist(Object.hasOwn(fields, e.kind) && Object.keys(e).every(k => (k === "signature" || k === "localOnly" || fields[e.kind].has(k))) &&
      Object.keys(e.author).every(k => k === "id" || k === "name" || k === "publicKey"), "Unknown group library record fields.");
    const {key, signature, ...body} = e;
    insist(JSON.stringify(e).length <= MAX_EVENT && hash(body) === key, "Group library record exceeds the size limit or its checksum differs.");
    if (e.kind === "decision") {
      insist(HASH.test(e.target) && ["approved", "declined"].includes(e.vote), "Invalid library review decision.");
      return;
    }
    insist(Number.isSafeInteger(e.rev) && e.rev > 0 &&
      Array.isArray(e.parents) && e.parents.length <= 2 && new Set(e.parents).size === e.parents.length && e.parents.every(k => HASH.test(k)) &&
      text(e.note, 300), "Invalid library revision.");
    if (e.kind === "naming") {
      insist(object(e.conventions) && JSON.stringify(e.conventions).length <= NAMING_LIMIT && same(e.conventions, namingPayload(e.conventions)),
        "Invalid group naming conventions.");
      insist(e.hash === hash(e.conventions), "The naming conventions checksum differs.");
      return;
    }
    insist(text(e.component, 200), "Invalid component revision.");
    if (e.def === null) { insist(e.hash === null && e.parents.length, "Invalid component removal."); return; }
    insist(object(e.def) && e.def.id === e.component && e.def.rev === e.rev && states.includes(e.def.state), "Invalid component identity or lifecycle.");
    insist(same(e.def, Lib().scrub(e.def)) && !e.def.libraryRef && !e.def.mirrorOf, "Only portable library component fields can be shared.");
    insist(!Store().hoisted(e.def), "The 3D model data is missing from this revision.");
    const result = Lib().validateDef(e.def, {footprintWarnings: false});
    insist(result.ok, result.errors[0]);
    insist(e.hash === Store().contentHash(e.def), "The component content checksum differs.");
  }
  // Parents precede children on the wire. A bundle or Git tree can present files in any order.
  // Verify all dependencies before installing any of the batch, including decision targets.
  async function ingest(records, incoming, info, local) {
    insist(Array.isArray(incoming) && incoming.length <= MAX_EVENTS, "Too many group library records.");
    const fresh = new Map(), waiting = new Map(), ready = [], added = [];
    for (const e of incoming) {
      if (records.has(e?.key) || fresh.has(e?.key)) continue;
      validate(e, info); await verify(e, local); fresh.set(e.key, e);
    }
    insist(records.size + fresh.size <= MAX_EVENTS, "This group library exceeds the record limit.");
    const counts = new Map();
    for (const e of fresh.values()) {
      let pending = 0;
      for (const k of dependencies(e)) {
        const p = records.get(k) || fresh.get(k);
        insist(isRevision(p) && (e.kind === "decision" || entryOf(p) === entryOf(e)), "Incomplete library revision history.");
        if (e.kind === "decision" && p.kind === "naming") {
          insist(e.localOnly || e.author.publicKey, "A naming conventions review needs a member signature.");
        }
        if (!records.has(k)) {
          pending++;
          if (!waiting.has(k)) waiting.set(k, []);
          waiting.get(k).push(e);
        }
      }
      if (isRevision(e)) {
        const rev = 1 + Math.max(0, ...e.parents.map(k => (records.get(k) || fresh.get(k)).rev));
        insist(e.rev === rev, "The library revision does not follow its parents.");
      }
      if (pending) counts.set(e.key, pending); else ready.push(e);
    }
    for (let i = 0; i < ready.length; i++) {
      const e = ready[i]; added.push(e);
      for (const child of waiting.get(e.key) || []) {
        const n = counts.get(child.key) - 1; counts.set(child.key, n);
        if (!n) ready.push(child);
      }
    }
    insist(added.length === fresh.size, "A library revision has cyclic ancestry.");
    for (const e of added) records.set(e.key, e);
    return added;
  }

  function librarySource(info, heads, installed) {
    const defs = [], tombstones = [];
    let naming;
    for (const e of installed) {
      if (e.kind === "naming") naming = {key: e.key, rev: e.rev, conventions: e.conventions};
      else if (e.def) defs.push(e.def);
      else tombstones.push(Store().tombstone(e.component, e.rev, e.at));
    }
    const revisionKeys = naming ? new Map([...heads].filter(([component]) => component !== null)) : heads;
    return {id: info.id, name: info.name, kind: "group", revisionKeys, defs, tombstones, ...(naming ? {naming} : {})};
  }

  function create(info, previous) {
    info = groupInfo(info);
    const events = new Map(previous?.events), heads = new Map(previous?.heads), dismissed = new Set(previous?.dismissed);
    const members = new Map(previous?.members);
    const shareable = new Set(), inventory = [], added = [];
    const markShareable = e => {
      if (!e.localOnly && dependencies(e).every(k => shareable.has(k))) { shareable.add(e.key); inventory.push(e.key); }
    };
    for (const e of events.values()) markShareable(e);
    async function add(items, local) {
      const fresh = await ingest(events, items, info, local);
      for (const e of fresh) { markShareable(e); added.push(e); }
      return fresh;
    }
    const receive = items => add(items, false);
    async function propose(def, {component = def?.id, parents = [], author, note, project, state, at = new Date().toISOString()}) {
      const rev = 1 + Math.max(0, ...parents.map(k => {
        const p = events.get(k);
        insist(p?.kind === "revision" && p.component === component, "The base revision is unavailable.");
        return p.rev;
      }));
      let entry = null;
      if (def) {
        entry = Lib().portableDefinition(project, def);
        delete entry.mirrorOf;
        entry.id = component; entry.rev = rev; entry.state = state || entry.state || "draft";
        // Editors of older projects can omit source metadata. A derived revision keeps its
        // upstream attribution, including the footprint source of a paired component.
        const prior = parents.length === 1 ? events.get(parents[0]).def?.source : null;
        if (prior) {
          entry.source = {...prior, ...entry.source};
          if (prior.attribution && !entry.source.attribution) entry.source.attribution = prior.attribution;
          if (prior.footprint) {
            entry.source.footprint = {...prior.footprint, ...entry.source.footprint};
            if (prior.footprint.attribution && !entry.source.footprint.attribution) entry.source.footprint.attribution = prior.footprint.attribution;
          }
        }
      }
      const content = entry ? Store().record(entry).hash : null;
      insist(parents.length !== 1 || events.get(parents[0]).hash !== content, "This component already has that content.");
      const e = await seal({group: info.id, kind: "revision", component, parents, rev, at, note, hash: content, def: entry}, author);
      return addProposal(e, author);
    }
    async function proposeConventions(conventions, {parents = [], author, note, at = new Date().toISOString()}) {
      const rev = 1 + Math.max(0, ...parents.map(k => {
        const p = events.get(k);
        insist(p?.kind === "naming", "The naming conventions base revision is unavailable.");
        return p.rev;
      }));
      const snapshot = namingPayload(conventions), digest = hash(snapshot);
      insist(parents.length !== 1 || events.get(parents[0]).hash !== digest, "The group already has those naming conventions.");
      const e = await seal({group: info.id, kind: "naming", parents, rev, at, note, hash: digest, conventions: snapshot}, author);
      return addProposal(e, author);
    }
    async function addProposal(e, author) {
      await add([e], true);
      // The user chose this name for their own local key. An existing name/key change still
      // needs a separate review, including after this profile's signing key was lost.
      if (!author.localOnly && !members.has(author.id) && ![...members.values()].includes(author.name)) members.set(author.id, author.name);
      return e;
    }
    function ancestors(key) {
      const seen = new Set(), stack = key ? [key] : [];
      while (stack.length) {
        const k = stack.pop();
        if (!seen.has(k)) { seen.add(k); stack.push(...events.get(k).parents); }
      }
      return seen;
    }
    const revision = k => isRevision(events.get(k)) ? events.get(k) : null;
    const asRecord = e => !e ? null : e.kind === "naming" || e.def ?
      {id: e.kind === "naming" ? "naming" : e.component, rev: e.rev, hash: e.hash} : Store().tombstone(e.component, e.rev, e.at);
    function pending() {
      const tips = new Map();
      for (const e of events.values()) if (isRevision(e)) {
        tips.set(e.key, e);
        for (const k of e.parents) tips.delete(k);
      }
      return [...tips.values()].filter(e => heads.get(entryOf(e)) !== e.key && !dismissed.has(e.key));
    }
    function identityStatus(e) {
      const {id, name, publicKey} = e.author;
      if (e.localOnly) return {status: "local", name, id};
      if (!publicKey) return {status: "unsigned", name, id};
      const knownName = members.get(id);
      if (knownName === name) return {status: "known", name, id};
      if (knownName) return {status: "renamed", name, id, knownName};
      const previousKeys = [...members].filter(([, n]) => n === name).map(([k]) => k).sort();
      return previousKeys.length ? {status: "changed", name, id, previousKeys} : {status: "new", name, id};
    }
    function preview(key) {
      const e = revision(key);
      insist(e && !dismissed.has(key) && heads.get(entryOf(e)) !== key, "This proposal has already been reviewed here.");
      const head = heads.get(entryOf(e)) || null, incoming = ancestors(key);
      insist(!head || !ancestors(head).has(key), "A later revision is already installed.");
      const rival = head && !incoming.has(head) ? revision(head) :
        pending().find(p => entryOf(p) === entryOf(e) && p.key !== key && !incoming.has(p.key) && !ancestors(p.key).has(key));
      const ours = rival || revision(head);
      let base = ours;
      if (rival) {
        base = null;
        for (const k of ancestors(rival.key)) {
          const candidate = events.get(k);
          if (incoming.has(k) && (!base || candidate.rev > base.rev)) base = candidate;
        }
      }
      const merge = rival && Store().merge(base ? [asRecord(base)] : [], [asRecord(rival)], [asRecord(e)]);
      const identities = [e, rival].filter(Boolean).map(identityStatus)
        .filter((v, i, all) => v.status !== "known" && v.status !== "local" && all.findIndex(a => a.id === v.id && a.name === v.name) === i);
      return {target: e, ours, base, head, identities, rival: rival?.key || null, conflict: !!merge?.conflicts.length,
        keepRival: !!(merge && !merge.conflicts.length && merge.records.get(asRecord(e).id).hash === asRecord(rival).hash)};
    }
    async function decide(view, vote, author, choice, at = new Date().toISOString()) {
      const now = preview(view.target.key);
      insist(now.head === view.head && now.rival === view.rival && same(now.identities, view.identities), "The library changed during review. Open the proposal again.");
      insist(vote === "approved" || vote === "declined", "Choose a review decision.");
      if (vote === "approved" && now.identities.length) {
        insist(view.confirmedIdentities === true, "Review the author identity before approving this revision.");
      }
      let target = now.target;
      if (vote === "approved" && now.rival) {
        insist(!now.conflict || choice === "ours" || choice === "theirs", "Choose a version in the merge review.");
        const chosen = (now.conflict ? choice === "ours" : now.keepRival) ? now.ours : now.target;
        const opts = {parents: [chosen.key, (chosen === now.ours ? now.target : now.ours).key], author, at,
          note: "Merged rev " + now.ours.rev + " and rev " + now.target.rev + " using " + chosen.author.name + "’s " + (chosen.kind === "naming" ? "conventions" : "component")};
        target = chosen.kind === "naming" ? await proposeConventions(chosen.conventions, opts) : await propose(chosen.def, {...opts, component: chosen.component});
      }
      const event = await seal({group: info.id, kind: "decision", target: target.key, vote, at}, author);
      await add([event], true);
      if (vote === "approved") for (const identity of now.identities) {
        if (identity.status === "unsigned") continue;
        for (const oldKey of identity.previousKeys || []) members.delete(oldKey);
        members.set(identity.id, identity.name);
      }
      if (vote === "approved") heads.set(entryOf(target), target.key); else dismissed.add(target.key);
      return target;
    }
    function library() {
      return librarySource(info, heads, [...heads.values()].map(k => events.get(k)));
    }
    function baseFor(def, authorId) {
      const ref = def.libraryRef, linked = ref?.library === info.id;
      // Copies from the same external source keep one group identity even when the projects
      // assigned different placement ids. Identically named entries in other sources stay apart.
      const component = linked ? ref.id : ref?.library && ref.id ? "source-" + hash([ref.library, ref.id]) : def.id;
      if (linked && events.get(ref.groupRevision)?.component === component) return {component, key: ref.groupRevision};
      const versions = [...events.values()].filter(e => e.kind === "revision" && e.component === component);
      const source = linked && versions.find(e => e.rev === ref.rev && e.def && Lib().defHash(e.def) === ref.hash);
      if (linked) { insist(source, "The project copy’s base revision is missing. Import the group’s history first."); return {component, key: source.key}; }
      return {component, key: versions.reverse().find(e => e.author.id === authorId)?.key || null};
    }
    return {info, events, heads, dismissed, members, shareable, inventoryPage: (at, limit) => inventory.slice(at, at + limit), addedRecords: () => added.slice(), identityStatus, receive, propose, proposeConventions, decide, preview, pending, library, baseFor};
  }
  function archive(group) {
    return {format: FORMAT, version: VERSION, group: group.info, events: [...group.shareable].map(k => group.events.get(k))};
  }
  async function readArchive(data) {
    insist(data?.format === FORMAT && data.version === VERSION && Array.isArray(data.events), "Choose a Waffle group library bundle.");
    const group = create(data.group); await group.receive(data.events); return group;
  }
  // The Git directory is append-only. Concurrent edits create different files, so normal Git
  // merges retain both proposals. The semantic merge takes place in the library review.
  function gitFiles(group) {
    const prefix = "waffle-groups/" + group.info.id + "/";
    const header = {format: FORMAT, version: VERSION, group: group.info};
    return [{name: prefix + "library.json", data: Store().serialise(header)},
      ...[...group.shareable].map(k => ({name: prefix + "records/" + k + ".json", data: Store().serialise(group.events.get(k))}))];
  }
  const MAX_ARCHIVE = 256 * 1024 * 1024;
  async function readJSON(file, remaining = MAX_ARCHIVE) {
    insist(file.size == null || file.size <= remaining, "The library files exceed the import size limit.");
    const text = await file.text();
    insist(text.length <= remaining, "The library files exceed the import size limit.");
    const bytes = file.size ?? new TextEncoder().encode(text).length;
    insist(bytes <= remaining, "The library files exceed the import size limit.");
    return {value: JSON.parse(text), bytes};
  }
  async function readArchiveFile(file) { return readArchive((await readJSON(file)).value); }
  async function readGit(files) {
    const byPath = new Map(files.map(f => [f.name, f])), groups = [];
    let remaining = MAX_ARCHIVE;
    for (const [path, file] of byPath) {
      const match = /^(?:.*\/)?waffle-groups\/([a-zA-Z0-9_-]{1,100})\/library\.json$/.exec(path);
      if (!match) continue;
      const {value: header, bytes} = await readJSON(file, remaining);
      remaining -= bytes;
      const prefix = path.slice(0, -"library.json".length) + "records/", items = [];
      insist(header.group?.id === match[1], "The Git group identifier differs from its directory.");
      for (const [name, f] of byPath) if (name.startsWith(prefix)) {
        const key = name.slice(prefix.length, -5);
        if (!name.endsWith(".json") || !HASH.test(key)) continue;
        insist(items.length < MAX_EVENTS, "Too many group library records.");
        const {value: e, bytes} = await readJSON(f, remaining); remaining -= bytes;
        insist(key === e.key, "A Git record differs from its file name."); items.push(e);
      }
      groups.push(await readArchive({...header, events: items}));
    }
    insist(groups.length, "Choose a checkout containing a waffle-groups directory.");
    return groups;
  }
  return Object.freeze({create, newSigningKey, librarySource, archive, readArchive, readArchiveFile, gitFiles, readGit, states, groupInfo, MAX_EVENT, MAX_EVENTS});
})();
