"use strict";
globalThis.AtriumGroupLibraryUI = (() => {
  const G = globalThis, Core = G.AtriumGroupLibrary, Local = G.AtriumGroupLocal;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const t = AtriumI18n.define({
    "group.naming.name": "Naming conventions",
    "group.naming.propose": "Propose naming conventions…",
    "group.naming.source": "Project naming styles, dictionary and choices",
    "group.naming.update": "Update naming conventions",
    "group.naming.history": "Naming conventions history",
    "group.naming.current": "Installed naming conventions",
    "group.naming.incoming": "Proposed naming conventions",
    "group.naming.choose": "Naming conventions to keep",
    "group.naming.empty": "No shared styles, choices or dictionary words.",
    "group.naming.rail": "Rail spelling",
    "group.naming.activeLow": "Active-low spelling",
    "group.naming.pair": "Pair spelling",
    "group.naming.bus": "Bus spelling",
    "group.naming.case": "Capitalisation",
    "group.naming.forget": "Forgotten styles",
    "group.naming.lone": "Lone _N suffix",
    "group.naming.lone.low": "Active low",
    "group.naming.lone.pair": "Negative line of a pair",
    "group.naming.rs485": "RS-485 positive line",
    "group.naming.stems.rail": "Rail words",
    "group.naming.stems.ground": "Ground words",
    "group.naming.stems.clock": "Clock words",
    "group.naming.never.rail": "Excluded rail words",
    "group.naming.never.pair": "Excluded pair styles",
    "group.naming.never.bus": "Excluded bus stems",
    "group.naming.never.kinds": "Excluded suggestion types"
  });
  const ui = G.AtriumLibrary.ui, el = ui.el, btn = ui.button;
  let sharing, view, member;
  const project = ctx => ctx.currentProject ? ctx.currentProject() : ctx.project;
  function displayName(name) {
    if (member === undefined) {
      try { member = JSON.parse(localStorage.getItem("atrium.group-member.v1"))?.name; } catch { /* first use */ }
      member ||= "";
    }
    if (name !== undefined) {
      name = String(name).trim();
      if (!name) throw Error("Enter your display name for the revision history.");
      member = name;
      try { localStorage.setItem("atrium.group-member.v1", JSON.stringify({name})); } catch { /* the key is in IndexedDB */ }
    }
    return member;
  }
  const keyText = id => id.slice("member-".length).match(/.{1,8}/g).join(" ");
  function identityNotice(identity, decision = false) {
    const {status, name, id} = identity;
    const descriptions = {local: "This record is stored on this device only.", unsigned: "Older unsigned record. Its author cannot be verified.",
      changed: "This name has a different signing key.", renamed: "This key previously used the name “" + (identity.knownName || "") + "”.",
      new: "First signature from this member.", known: "Recognised signing key."};
    const box = el("div", null, "group-identity");
    box.append(note((decision ? "Review decision by " : "") + name + " · " + descriptions[status]));
    if (status === "unsigned" || status === "local") return box;
    const keys = el("dl");
    for (const oldKey of identity.previousKeys || []) keys.append(el("dt", "Previous signing key"), el("dd", keyText(oldKey)));
    keys.append(el("dt", "Signing key"), el("dd", keyText(id)));
    box.append(keys); return box;
  }
  const historyName = (group, event) => {
    const {status, name} = group.identityStatus(event);
    if (status === "local") return name + " (local only)";
    if (status === "unsigned") return name + " (unsigned)";
    return name + " · " + event.author.id.slice(7, 19) + (status === "known" ? "" : " (identity to review)");
  };
  const makeInput = (label, max, value = "") => {
    const input = el("input"); input.setAttribute("aria-label", label); input.maxLength = max; input.value = value; return input;
  };
  const option = (select, caption, value) => select.add(new Option(caption, value));
  const nameOf = e => e?.kind === "naming" ? t("group.naming.name") : e?.def?.name || e?.component || "Component";
  const label = e => "rev " + e.rev + " · " + (e.author.publicKey ? e.author.name : e.author.name + (e.localOnly ? " (local only)" : " (unsigned)"));
  const time = e => new Date(e.at).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
  const note = s => el("p", s, "fe-note");
  function stopSharing() {
    if (!sharing) return;
    const old = sharing; sharing = null; old.off(); old.transport.close(); old.sync.close(); view?.refresh();
  }
  function sharingProtocol() {
    let transport;
    const sync = G.AtriumGroupSync.create({current: Local.current,
      accept: (info, items, from) => Local.edit(info, group => group.receive(items), from),
      send: body => transport?.send(body), offered: () => view?.refresh(),
      error: message => { if (view) view.report(message); else G.AtriumNavHost?.info?.(message); }});
    const channel = {sync, handlers: {receive: sync.receive, opened: sync.refresh, offline: sync.disconnect,
      left: sync.left, ended: stopSharing, state(s, detail) {
        if (!["open", "connecting", "offline", "error", "ended"].includes(s)) return;
        channel.status = s === "error" ? String(detail || s) : s; view?.refresh();
      }},
      attach(t) {
        transport = t; channel.transport = t;
        channel.off = Local.onChange((id, added, from) => { if (added && sync.selected() === id) sync.announce(from); }); sharing = channel;
      }};
    return channel;
  }
  function session() {
    if (sharing) return sharing.sync;
    const live = G.AtriumCollabLive;
    if (!live?.session()?.t) throw Error("Start or join a live session first.");
    const channel = sharingProtocol();
    channel.attach(live.bindGroupLibrary(channel.handlers)); return channel.sync;
  }
  let connecting = false;
  async function libraryRoom(info, raw) {
    if (connecting || sharing) throw Error("Stop the current library connection first.");
    connecting = true;
    try {
      if (!G.AtriumCollabTransport) await G.AtriumLazy.need("AtriumCollabTransport");
      const invite = raw ? G.AtriumGroupSync.parseInvitation(raw) : null;
      info = invite?.info || info;
      if (!info) throw Error("Choose a group library or paste an invitation.");
      await Local.edit(info, () => {});
      const channel = sharingProtocol();
      const transport = await G.AtriumGroupSync.room(info, invite, channel.handlers);
      channel.room = true; channel.attach(transport); channel.sync.select(info.id);
      return info;
    } finally { connecting = false; }
  }
  async function saveGit(ctx, group, archive = false) {
    const files = Core.gitFiles(group);
    if (!archive && typeof G.showDirectoryPicker === "function") {
      const dir = await G.showDirectoryPicker({id: "atrium-group-git", mode: "readwrite"});
      for (const file of files) {
        const parts = file.name.split("/"), filename = parts.pop();
        let folder = dir;
        for (const part of parts) folder = await folder.getDirectoryHandle(part, {create: true});
        let existing;
        try { existing = await folder.getFileHandle(filename); } catch (e) { if (e.name !== "NotFoundError") throw e; }
        if (existing) {
          if (await (await existing.getFile()).text() !== file.data) throw Error("A Git library file differs on disk. Read the checkout before saving again.");
          continue;
        }
        const handle = await folder.getFileHandle(filename, {create: true}), writer = await handle.createWritable();
        await writer.write(file.data); await writer.close();
      }
      return "Git files saved in the selected checkout.";
    }
    const zip = G.AtriumZip || await G.AtriumLazy.need("AtriumZip");
    return await ctx.exportFile("group-library-git.zip", zip.create(files)) ? "Extract the Git files in your checkout, then commit them with Git." : "";
  }
  function chooseCheckout() {
    return new Promise(resolve => {
      const input = el("input"); input.type = "file"; input.multiple = true; input.setAttribute("webkitdirectory", ""); input.hidden = true;
      const finish = files => { input.remove(); resolve(files); };
      input.onchange = () => finish([...input.files].map(f => ({name: f.webkitRelativePath, size: f.size, text: () => f.text()})));
      input.oncancel = () => finish([]); document.body.append(input); input.click();
    });
  }
  function proposalDialog(ctx, info, author, done) {
    const group = Local.current(info.id), p = project(ctx);
    const defs = p.library.filter(d => !d.mirrorOf);
    const d = ui.dialog("Propose a component revision", "lib-small");
    const part = el("select"), stage = el("select"), noteInput = makeInput("Change summary", 240);
    const sources = new Map();
    for (const def of defs) { const k = "add:" + def.id; sources.set(k, def); option(part, def.name, k); }
    for (const def of group.library().defs) { const k = "remove:" + def.id; sources.set(k, def); option(part, "Remove " + def.name, k); }
    const STAGES = {draft: "Draft", review: "In Review", released: "Released", deprecated: "Deprecated"};
    for (const state of Core.states) option(stage, STAGES[state] || state, state);
    const status = note(""), base = note("");
    function picked() {
      const def = sources.get(part.value); if (!def) return;
      const removing = part.value.startsWith("remove:");
      stage.disabled = removing; stage.value = Core.states.includes(def.state) ? def.state : "draft";
      try {
        const parent = removing ? group.heads.get(def.id) : group.baseFor(def, author.id).key;
        base.textContent = parent ? "Based on " + label(group.events.get(parent)) : "New component proposal";
      } catch (e) { base.textContent = e.message; }
    }
    part.onchange = picked;
    const submit = btn("Submit proposal", async () => {
      submit.disabled = true;
      try {
        const def = sources.get(part.value), removing = part.value.startsWith("remove:");
        if (!def) throw Error("Choose a project component.");
        const live = project(ctx);
        if (!removing && (live !== p || !live.library.includes(def))) throw Error("The project component changed. Open the proposal again.");
        const basis = removing ? {component: def.id, key: group.heads.get(def.id)} : group.baseFor(def, author.id);
        await Local.edit(info, g => g.propose(removing ? null : def, {component: basis.component, project: p, state: stage.value,
          parents: basis.key ? [basis.key] : [], author, note: noteInput.value.trim() || (removing ? "Remove " : "Propose ") + def.name}));
        d.close(); done();
      } catch (e) { status.textContent = e.message; submit.disabled = false; }
    }, "lib-primary");
    const foot = el("div", null, "lib-actions"); foot.append(btn("Cancel", () => d.close()), submit);
    if (author.localOnly) d.append(note("This browser cannot store a signing key. This revision will stay on this device."));
    d.append(ui.label("Project component", part), base, ui.label("Lifecycle after approval", stage), ui.label("Change summary", noteInput), status, foot);
    ui.show(d); picked(); submit.disabled = !sources.size;
  }
  function attribution(def) {
    const source = def?.source;
    return [source, source?.footprint].filter(Boolean).map(s => {
      const a = s.attribution || s;
      return [a.credit, a.licence || a.license, a.licenceUrl, a.sourceUrl].filter(Boolean).join(" · ");
    }).filter((v, i, all) => v && all.indexOf(v) === i).join(" / ");
  }
  function namingSummary(c, heading) {
    const section = el("section", null, "ld-entry group-naming-summary"), list = el("dl");
    const labels = {
      rail: t("group.naming.rail"), activeLow: t("group.naming.activeLow"), pair: t("group.naming.pair"), bus: t("group.naming.bus"),
      case: t("group.naming.case"), forget: t("group.naming.forget"), lone: t("group.naming.lone"), rs485: t("group.naming.rs485"),
      "stems.rail": t("group.naming.stems.rail"), "stems.ground": t("group.naming.stems.ground"), "stems.clock": t("group.naming.stems.clock"),
      "never.rail": t("group.naming.never.rail"), "never.pair": t("group.naming.never.pair"), "never.bus": t("group.naming.never.bus"),
      "never.kinds": t("group.naming.never.kinds")
    };
    const add = (key, value) => list.append(el("dt", labels[key]), el("dd", value));
    for (const [key, value] of Object.entries(c.keep || {})) add(key, value.id || value);
    if (c.forget?.length) add("forget", c.forget.map(k => labels[k]).join(", "));
    for (const field of ["stems", "never"]) for (const [key, values] of Object.entries(c[field] || {})) add(field + "." + key, values.join(", "));
    if (c.loneN) add("lone", t(c.loneN === "pair" ? "group.naming.lone.pair" : "group.naming.lone.low"));
    if (c.rs485) add("rs485", c.rs485);
    section.append(el("h3", heading), list.childNodes.length ? list : note(t("group.naming.empty")));
    return section;
  }
  function namingProposalDialog(ctx, info, author, done) {
    const p = project(ctx), proposals = G.AtriumNetIntentIndex, data = proposals.groupProposal(p);
    const prior = Local.current(info.id).library().naming;
    const d = ui.dialog(t("group.naming.propose"), "lib-small"), status = note(""), noteInput = makeInput("Change summary", 240);
    status.setAttribute("role", "status");
    const submit = btn("Submit proposal", async () => {
      submit.disabled = true;
      try {
        if (project(ctx) !== p || G.AtriumLibraryStore.canonical(proposals.groupProposal(p)) !== G.AtriumLibraryStore.canonical(data)) {
          throw Error("The project naming conventions changed. Open the proposal again.");
        }
        await Local.edit(info, g => g.proposeConventions(data,
          {author, parents: prior ? [prior.key] : [], note: noteInput.value.trim() || t("group.naming.update")}));
        d.close(); done();
      } catch (e) { status.textContent = e.message; submit.disabled = false; }
    }, "lib-primary");
    submit.disabled = !prior && !Object.keys(data).length;
    const foot = el("div", null, "lib-actions"); foot.append(btn("Cancel", () => d.close()), submit);
    if (author.localOnly) d.append(note("This browser cannot store a signing key. This revision will stay on this device."));
    d.append(namingSummary(data, t("group.naming.source")), ui.label("Change summary", noteInput), status, foot);
    ui.show(d);
  }
  function reviewDialog(info, key, who, done, history = false) {
    const group = Local.current(info.id);
    const rev = group.events.get(key), first = group.events.get(rev.parents[0]);
    const review = history ? {ours: first, target: rev} : group.preview(key);
    const naming = rev.kind === "naming";
    const caption = history ? (naming ? t("group.naming.history") : "Component history · " + nameOf(rev)) :
      (review.conflict ? "Merge review" : "Review proposal") + " · " + nameOf(rev);
    const d = ui.dialog(caption, "ld-dialog");
    const body = el("div", null, "ld-body"), foot = el("div", null, "lib-actions"), status = note("");
    const before = review.ours?.def || {}, after = rev.def || {};
    body.append(note(rev.note + " · " + label(rev) + " · " + time(rev)));
    if (review.rival) body.append(note("Versions from " + (review.base ? label(review.base) : "separate additions") + ". Comparing " + label(review.ours) + " with " + label(rev) + "."));
    if (naming) {
      if (review.ours) body.append(namingSummary(review.ours.conventions, t("group.naming.current")));
      body.append(namingSummary(rev.conventions, t("group.naming.incoming")));
    } else {
      if (!rev.def) body.append(note("This proposal removes the component from the group library. Placed project copies keep their definition."));
      body.append(G.AtriumLibraryDiff.visualChanges(before, after));
      const credit = attribution(after), previous = attribution(before);
      if (credit) body.append(note("Source attribution · " + credit));
      if (previous && previous !== credit) body.append(note("Previous source attribution · " + previous));
      const compared = new Set(["id", "rev", "symbol", "footprint", "model3d", "name", "prefix", "value", "category", "description", "state", "parameters"]);
      const other = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !compared.has(k) &&
        G.AtriumLibraryStore.canonical(before[k]) !== G.AtriumLibraryStore.canonical(after[k]));
      if (other.length) body.append(note("Changed component fields · " + other.join(", ")));
    }
    const identityChecks = review.identities || [], authorStatus = group.identityStatus(rev);
    for (const identity of identityChecks.length ? identityChecks : [authorStatus]) body.append(identityNotice(identity));
    if (history?.kind === "decision") body.append(identityNotice(group.identityStatus(history), true));
    let choice, checked = false;
    const resolve = async vote => {
      try {
        const author = await who();
        await Local.edit(info, g => g.decide({...review, confirmedIdentities: checked}, vote, author, choice));
        d.close(); done();
      } catch (e) { status.textContent = e.message; }
    };
    foot.append(btn("Close", () => d.close()));
    if (!history) {
      const approve = btn(review.rival ? "Approve merge" : "Approve for my library", () => resolve("approved"), "lib-primary");
      const updateApproval = () => { approve.disabled = !!(review.conflict && !choice || identityChecks.length && !checked); };
      if (identityChecks.length) {
        const input = el("input"); input.type = "checkbox";
        input.onchange = () => { checked = input.checked; updateApproval(); };
        const item = el("label", null, "fw-check");
        item.append(input, el("span", identityChecks.some(a => a.status === "unsigned") ?
          "I reviewed the author information, including the unsigned history." :
          "I checked the signing key with the author.")); body.append(item);
      }
      if (review.conflict) {
        const picks = el("fieldset"); picks.append(el("legend", naming ? t("group.naming.choose") : "Component to keep in the merge"));
        for (const [k, r] of [["ours", review.ours], ["theirs", rev]]) {
          const input = el("input"); input.type = "radio"; input.name = "group-merge";
          input.onchange = () => { if (input.checked) { choice = k; updateApproval(); } };
          const item = el("label", null, "fw-check"); item.append(input, el("span", label(r) + " · " + r.note)); picks.append(item);
        }
        body.append(picks);
      }
      updateApproval();
      foot.append(btn("Decline for my library", () => resolve("declined")), approve);
    }
    body.append(status); d.append(body, foot); ui.show(d);
    return d;
  }

  async function dialog(ctx, initial, {onChoose, onClose} = {}) {
    if (view?.dialog.open) { view.dialog.focus(); return view.dialog; }
    await Local.restore();
    const d = ui.dialog("Group library", "ld-dialog group-dialog"), body = el("div", null, "ld-body"), foot = el("div", null, "lib-actions");
    d.dataset.returnFocus = "opener";
    const library = el("select"), memberName = makeInput("Your display name", 80, displayName() || G.AtriumPref?.get?.("collab.displayName") || "");
    const status = note(""), createName = makeInput("New group name", 120); status.setAttribute("role", "status");
    const who = () => Local.member(displayName(memberName.value));
    let chosen = initial || Local.libraries()[0]?.id, limit = 40, loading = 0;
    const section = heading => { const box = el("section", null, "ld-entry"); box.append(el("h3", heading)); body.append(box); return box; };
    const controls = section("Local copy"), pending = section("Proposals"), log = section("Revision history"), exchange = section("Share");
    const libraryField = ui.label("Group library", library), empty = note("No group libraries yet. Create one below, or import a bundle, a Git checkout or an invitation under Share.");
    controls.append(libraryField, empty, ui.label("Your display name", memberName));
    const myKey = el("details"), fingerprint = note("");
    myKey.append(el("summary", "My signing key"), fingerprint);
    myKey.ontoggle = async () => {
      if (!myKey.open || fingerprint.textContent) return;
      try {
        const me = await Local.member("");
        fingerprint.textContent = me.localOnly ? "This browser stores your revisions on this device only." : keyText(me.id);
      }
      catch (e) { status.textContent = e.message; }
    };
    controls.append(myKey);
    const createRow = el("div", null, "group-actions"), newGroup = btn("Create group", () => run(async () => {
      const name = createName.value.trim(); if (!name) { createName.focus(); throw Error("Enter a name for the group library."); }
      const info = {id: "group-" + G.Atrium.id(), name};
      await Local.edit(info, () => {}); chosen = info.id; createName.value = "";
    }));
    createRow.append(ui.label("New group name", createName), newGroup); controls.append(createRow);
    const actions = el("div", null, "group-actions"), available = el("div");
    const sharingStatus = note(""), room = el("details");
    const invitation = el("textarea"); invitation.setAttribute("aria-label", "Group library invitation"); invitation.rows = 4; invitation.spellcheck = false;
    const roomActions = el("div", null, "group-actions");
    room.append(el("summary", "Library-only session"), ui.label("Group library invitation", invitation), roomActions);
    exchange.append(sharingStatus, actions, available, room);
    function report(message) { status.textContent = message || ""; return true; }
    async function run(fn) {
      try { report(""); await fn(); await refresh(); }
      catch (e) { if (e.name !== "AbortError") report(e.message); }
    }
    async function add(group) {
      await Local.edit(group.info, copy => copy.receive([...group.events.values()])); chosen = group.info.id;
    }
    function refreshShare(g) {
      actions.replaceChildren(); available.replaceChildren();
      const click = (name, fn) => btn(name, () => run(fn));
      const sync = sharing?.sync;
      sharingStatus.textContent = sync?.selected() ? "Sharing " + Local.current(sync.selected()).info.name + " in this live session." :
        "Share a local copy through a live session, a bundle or a Git checkout.";
      if (g && g.shareable.size < g.events.size) sharingStatus.textContent += " Local-only revisions stay on this device.";
      roomActions.replaceChildren();
      if (sharing?.room) {
        const invite = sharing.transport.invitation;
        if (invite) {
          invitation.value = invite; invitation.readOnly = true;
          roomActions.append(click("Copy invitation", async () => { invitation.select(); await G.navigator?.clipboard?.writeText?.(invite); }));
        }
        sharingStatus.textContent = "Library-only session · " + (sharing.status || "connecting") + " · " + Local.current(sync.selected()).info.name;
        roomActions.append(click("Sync again", sync.refresh), click("Leave library session", () => { stopSharing(); invitation.value = ""; }));
      } else {
        invitation.readOnly = false;
        if (!sync) {
          if (g) roomActions.append(click("Start library session", async () => { await libraryRoom(g.info); room.open = true; }));
          roomActions.append(click("Join library session", async () => {
            if (!invitation.value.trim()) throw Error("Paste a group library invitation.");
            chosen = (await libraryRoom(null, invitation.value)).id; invitation.value = "";
          }));
        }
      }
      if (!sharing?.room && G.AtriumCollabLive?.session()?.t) {
        actions.append(click("Find groups in session", () => session().refresh()));
        if (g && sync?.selected() !== g.info.id) actions.append(click("Share this group in session", () => session().select(g.info.id)));
        if (sync?.selected()) actions.append(click("Stop sharing", stopSharing));
      } else if (!sharing?.room) actions.append(click("Project live session…", async () => {
        if (!G.AtriumCollabLive) await G.AtriumLazy.need("AtriumCollabPresence");
        G.AtriumCollabLive.dialog();
      }));
      if (sync && !sharing?.room) for (const [id, info] of new Map([...sync.offers.values()].map(i => [i.id, i]))) {
        if (id === sync.selected()) continue;
        available.append(click("Join " + info.name, async () => { await Local.edit(info, () => {}); chosen = id; session().select(id); }));
      }
      actions.append(click("Import bundle…", async () => {
        const f = await ctx.pickFile([".atrgroup"]); if (f) await add(await Core.readArchiveFile(f));
      }));
      const git = [click("Read Git checkout…", async () => {
        const files = await chooseCheckout(); if (files.length) for (const copy of await Core.readGit(files)) await add(copy);
      })];
      if (g) {
        actions.append(click("Export bundle…", () => ctx.exportFile(g.info.id + ".atrgroup", G.AtriumLibraryStore.serialise(Core.archive(g)))));
        if (typeof G.showDirectoryPicker === "function") git.push(click("Save to Git checkout…", async () => report(await saveGit(ctx, g))));
        git.push(click("Export Git files…", async () => report(await saveGit(ctx, g, true))));
      }
      actions.append(G.AtriumNavCommon.actionMenu(btn("Git"), git));
    }
    async function refresh() {
      if (!d.open || document.visibilityState === "hidden") return;
      const request = ++loading, libs = Local.libraries();
      library.replaceChildren(); for (const lib of libs) option(library, lib.name, lib.id);
      libraryField.hidden = !libs.length; empty.hidden = !!libs.length;
      if (!libs.some(l => l.id === chosen)) chosen = libs[0]?.id;
      if (chosen) library.value = chosen;
      const g = chosen ? await Local.open(chosen) : null;
      if (request !== loading || !d.open) return;
      pending.replaceChildren(el("h3", "Proposals")); log.replaceChildren(el("h3", "Revision history"));
      pending.hidden = log.hidden = !g; refreshShare(g);
      if (!g) return;
      const rows = g.pending();
      const propose = el("div", null, "group-actions");
      propose.append(btn("Propose revision…", () => run(async () => proposalDialog(ctx, g.info, await who(), refresh))),
        btn(t("group.naming.propose"), () => run(async () => namingProposalDialog(ctx, g.info, await who(), refresh))));
      pending.append(propose);
      if (!rows.length) pending.append(note("No proposals awaiting your review."));
      for (const e of rows.slice(0, limit)) {
        const row = el("div", null, "group-actions");
        row.append(el("span", nameOf(e) + " · " + label(e) + " · " + e.note), btn("Review…", () => run(() => reviewDialog(g.info, e.key, who, refresh))));
        pending.append(row);
      }
      const history = [...g.events.values()].reverse().sort((a, b) => b.at.localeCompare(a.at));
      for (const e of history.slice(0, limit)) {
        const r = e.kind === "decision" ? g.events.get(e.target) : e;
        const summary = nameOf(r) + " · rev " + r.rev + " · " +
          (e.kind === "decision" ? (e.vote === "approved" ? "Approved" : "Declined") + " by " + historyName(g, e) : "Proposed by " + historyName(g, e) + " · " + e.note);
        const row = el("div", null, "group-actions group-history"); row.append(el("span", summary), el("small", time(e)),
          btn("View…", () => run(() => reviewDialog(g.info, r.key, who, refresh, e)))); log.append(row);
      }
      if (limit < Math.max(rows.length, history.length)) log.append(btn("Show more", () => { limit += 80; refresh(); }));
    }
    library.onchange = () => { chosen = library.value; limit = 40; refresh(); };
    const off = Local.onChange(() => refresh());
    const wake = () => { if (document.visibilityState !== "hidden") refresh(); };
    document.addEventListener("visibilitychange", wake);
    d.addEventListener("close", () => {
      off(); document.removeEventListener("visibilitychange", wake);
      if (view?.dialog === d) view = null;
      if (sharing && !sharing.sync.selected()) stopSharing();
      onClose?.(chosen);
    }, {once: true});
    // A live session may have been started by the nested Share dialog.
    d.addEventListener("focusin", () => {
      const shared = !!G.AtriumCollabLive?.session()?.t;
      if (view?.dialog !== d || view.hadSession === shared) return;
      view.hadSession = shared;
      refresh();
    });
    foot.append(status, btn("Done", () => {
      // Publish the selection before the panel can receive input again.
      onChoose?.(chosen);
      d.close();
    }, "lib-primary")); d.append(body, foot);
    view = {dialog: d, refresh, report, hadSession: !!G.AtriumCollabLive?.session()?.t}; ui.show(d); await refresh(); return d;
  }
  G.addEventListener?.("pagehide", stopSharing);
  return Object.freeze({dialog, restore: Local.restore});
})();
