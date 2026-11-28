"use strict";
// Local palette contributions use the shared search index, clipboard, and keymap.
globalThis.AtriumPalettePersonal = (() => {
  const G = globalThis, kindNames = {schematic:"Schematic", pcb:"PCB"};
  const aliasKey = "search.commandAliases", linkKey = "search.quicklinks";
  const prefs = () => G.AtriumPrefs, palette = () => G.AtriumPalette, clips = () => G.AtriumClipHistory;
  const invalidate = () => palette()?.invalidateProvider?.("personal");
  const clean = value => String(value ?? "").normalize("NFKC").trim();
  const same = (a,b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  const t = G.AtriumI18n.define({
    "personal.aliasConflict":"{alias} already belongs to another command.",
    "personal.aliasLong":"Use up to 12 aliases of 64 characters each.",
    "personal.unknownCommand":"Choose a command.",
    "personal.quicklinkUrl":"Enter a full HTTP or HTTPS address. Use {example} in its path or query.",
    "personal.quicklinkLimit":"You can save up to 100 quicklinks.",
    "personal.quicklinkName":"Enter a quicklink name of up to 80 characters.",
    "personal.duplicateQuicklink":"A quicklink with this name already exists.",
    "personal.saved":"Saved.",
    "personal.removed":"Removed.",
    "personal.aliasGroup":"Command aliases and shortcuts",
    "personal.command":"Command",
    "personal.preferences":"Search Preferences",
    "personal.aliases":"Aliases",
    "personal.aliasHint":"Separate aliases with commas.",
    "personal.saveAliases":"Save aliases",
    "personal.setAliases":"Set aliases…",
    "personal.editShortcut":"Edit shortcut…",
    "personal.quicklinks":"Quicklinks",
    "personal.linkHint":"Use {example} to add search text when the link opens.",
    "personal.linkName":"Name",
    "personal.template":"URL template",
    "personal.saveLink":"Save quicklink",
    "personal.remove":"Remove",
    "personal.edit":"Edit",
    "personal.snippets":"Saved snippets",
    "personal.snippetHint":"Use Save Selection as Snippet in Search to save objects here.",
    "personal.clipboard":"Browse clipboard history",
    "personal.clipboardEmpty":"Copy objects to see them in the clipboard history.",
    "personal.thumbnailUnavailable":"Preview unavailable.",
    "personal.paste":"Place",
    "personal.saveSnippet":"Save Selection as Snippet",
    "personal.renameSnippet":"Rename snippet",
    "personal.saveClip":"Save as snippet",
    "personal.snippetName":"Snippet name",
    "personal.snippetSaved":"Saved {name} as a snippet.",
    "personal.save":"Save",
    "personal.open":"Open",
    "personal.searchText":"Search text",
    "personal.targetChanged":"Return to the document where you opened Search.",
    "personal.missingClip":"This clipboard entry is no longer available.",
    "personal.clipFull":"This selection does not fit in the clipboard history.",
    "personal.searchLibrary":"Search Library",
    "personal.searchHelp":"Search Docs",
    "personal.searchProvider":"Search Extension Providers",
    "personal.newNet":"Create Net Label",
    "personal.newText":"Create Text",
    "personal.netName":"Net name",
    "personal.text":"Text",
    "personal.nonEmpty":"Enter text to place.",
    "personal.searchFor":"Search for {query}",
    "personal.createWith":"Use {query}"
  });

  function validKey(key) {
    return typeof key === "string" && (/^(?:cmd|menu|power|insert|extension|personal):[^\u0000-\u001f]{1,160}$/.test(key) ||
      /^command:ext:[a-z0-9][a-z0-9_.-]{0,79}:[a-z][a-z0-9_.-]{0,79}$/i.test(key));
  }
  const parseAliases = value => (Array.isArray(value) ? value : String(value ?? "").split(/[,\n]/))
    .filter(a => typeof a === "string").map(clean).filter(Boolean);
  let cachedAliasValue, aliasMap = new Map();
  function allAliases() {
    const raw = prefs()?.get(aliasKey);
    if (raw === cachedAliasValue) return aliasMap;
    cachedAliasValue = raw;
    aliasMap = new Map(Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}).filter(([key]) => validKey(key))
      .map(([key,value]) => [key, parseAliases(value).filter(a => a.length <= 64).slice(0,12)]));
    return aliasMap;
  }
  const aliases = key => allAliases().get(key) || [];
  function saveAliases(key, value) {
    if (!validKey(key)) throw Error(t("personal.unknownCommand"));
    const requested = parseAliases(value), unique = requested.filter((a,i) => requested.findIndex(b => same(a,b)) === i);
    if (unique.length > 12 || unique.some(a => a.length > 64)) throw Error(t("personal.aliasLong"));
    const all = new Map(allAliases());
    for (const [other,names] of all) if (other !== key) {
      const conflict = unique.find(a => names.some(b => same(a,b)));
      if (conflict) throw Error(t("personal.aliasConflict", {alias:conflict}));
    }
    if (unique.length) all.set(key,unique); else all.delete(key);
    prefs().set(aliasKey,Object.fromEntries(all));
    return unique;
  }

  const token = "{query}";
  function templateURL(template, text = "") {
    const value = String(template ?? "").trim();
    try {
      if (value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) throw Error();
      const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
      if (!authority || authority.includes(token)) throw Error();
      const query = Array.from(String(text), c => c.length === 1 && /[\uD800-\uDFFF]/.test(c) ? "\uFFFD" : c).join("");
      const url = new URL(value.replaceAll(token,encodeURIComponent(query)));
      if (!["https:","http:"].includes(url.protocol) || url.username || url.password || !url.hostname) throw Error();
      return url.href;
    } catch { throw Error(t("personal.quicklinkUrl", {example:token})); }
  }
  function links() {
    const raw = prefs()?.get(linkKey);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const link of raw.slice(0,100)) try {
      if (!/^[\w-]{1,100}$/.test(link?.id) || typeof link?.name !== "string" || !clean(link.name) ||
          link.name.length > 80 || out.some(l => l.id === link.id || same(l.name,link.name))) continue;
      templateURL(link.template);
      out.push({id:link.id,name:link.name,template:link.template});
    } catch { /* Only usable templates enter the palette. */ }
    return out;
  }
  function saveLink(input) {
    const name = clean(input.name), template = String(input.template ?? "").trim(), all = links();
    if (!name || name.length > 80) throw Error(t("personal.quicklinkName"));
    templateURL(template);
    const index = all.findIndex(l => l.id === input.id);
    if (all.some((l,i) => i !== index && same(l.name,name))) throw Error(t("personal.duplicateQuicklink"));
    if (index < 0 && all.length === 100) throw Error(t("personal.quicklinkLimit"));
    const next = {id:index < 0 ? G.Atrium.id() : all[index].id, name, template};
    if (index < 0) all.push(next); else all[index] = next;
    prefs().set(linkKey,all);
    return next;
  }
  function removeLink(id) { prefs().set(linkKey,links().filter(l => l.id !== id)); }

  function openLink(link, query) {
    const url = templateURL(link.template,query);
    if (G.AtriumHost?.openURL) return G.AtriumHost.openURL(url);
    return G.open?.(url,"_blank","noopener,noreferrer");
  }
  function form(title, id, label, primary, value, submit) {
    const browser = palette();
    const show = (initial, text) => browser.present({kind:"form",title,text,
      fields:[{id,label,type:"text",value:initial}], primary:{id:"submit",label:primary}}, {
      submit(values) {
        try { return submit(values[id]); }
        catch (error) { return show(values[id],error.message); }
      }
    });
    return show(value);
  }
  function quicklink(link) {
    const key = "personal:quicklink:"+link.id, needsQuery = link.template.includes(token), domain = new URL(templateURL(link.template)).host;
    const inline = needsQuery ? [link.name,...aliases(key)].filter(term => !/\s/.test(term)).map(term => term.toLowerCase()) : [];
    return {key,kind:"command",label:link.name,detail:domain,keywords:["quicklink link",domain,...aliases(key)].join(" "),inline,
      keepOpen:needsQuery,run(req) {
        if (!needsQuery) return openLink(link,"");
        return form(link.name,"query",t("personal.searchText"),t("personal.open"),req.argument || "", query => {
          const result = openLink(link,query); palette().close(); return result;
        });
      }};
  }

  function editor(context, kind = context.kind) {
    const h = context.host, doc = h.doc();
    if (context.surface || !Object.hasOwn(kindNames,kind) || doc.kind !== kind || h.currentId() !== context.docId)
      throw Error(t("personal.targetChanged"));
    const center = h.view()?.camera();
    const point = context.point || h.pointer?.() || [center?.cx || 0,center?.cy || 0];
    return {h,doc,point:point.map(n => G.Atrium.snap(n,doc.grid))};
  }
  function placeClip(clip, context) {
    const {h,doc,point} = editor(context,clip.kind), project=h.project(), selection=G.AtriumEditSelection;
    const signal=G.AtriumLabs?.notebookSignal();
    if(signal?.aborted)return;
    function place() {
      if(signal?.aborted)return;
      if(h.doc()!==doc || h.project()!==project)throw Error(t("personal.targetChanged"));
      const plan = selection.prepare(project,doc,clip,h.defs());
      let ids;
      h.edit(() => { ids = plan.commit(point); });
      if (ids) {h.select(ids); h.canvas()?.focus();}
    }
    const pending=selection.demand(clip);
    return pending ? pending.then(place) : place();
  }
  function placeBlock(block, context) {
    const {h,doc,point} = editor(context,"pcb"), plan = G.AtriumBlocks.prepare(h.project(),block,point);
    h.edit(() => {h.project().library.push(...plan.library); doc.items.push(...plan.items);});
    h.select(plan.items.map(i => i.id)); h.canvas()?.focus();
  }
  const saved = clip => clip.pinned && clip.custom;
  function thumbnail(clip, {signal} = {}) {
    if (signal?.aborted) return null;
    // Large selections still paste normally. A preview should never decode a
    // multimegabyte project fragment on a selection change.
    if(clip.media?.includes("Image") && clips()?.imagePreview) return clips().imagePreview(clip.id,signal).then(canvas=>
      canvas&&!signal?.aborted?{kind:"image",url:canvas.toDataURL("image/png"),width:canvas.width,height:canvas.height,alt:clip.summary}:null);
    if (clip.size <= 512*1024) try {
      const canvas = clips()?.thumbnail(clip.id,{preview:true});
      if (canvas && !signal?.aborted) return {kind:"image",url:canvas.toDataURL("image/png"),width:canvas.width,height:canvas.height,alt:clip.summary};
    } catch { /* A text preview still identifies the copied objects. */ }
    return {kind:"text",title:clip.name,text:clip.summary || t("personal.thumbnailUnavailable")};
  }
  function snippetForm(title, initial, getClip, context) {
    return form(title,"name",t("personal.snippetName"),t("personal.save"),initial,name => {
      const source = getClip();
      if (!source) throw Error(t("personal.missingClip"));
      const clip = clips().saveSnippet(source.id,name);
      const h = context.host;
      palette().close(); h.info(t("personal.snippetSaved", {name:clip.name}));
    });
  }
  function saveSelected(context) {
    return snippetForm(t("personal.saveSnippet"),"",() => {
      const {h,doc} = editor(context), selection = new Set(context.selection);
      const clip = G.AtriumEditSelection.capture(doc,h.defs(),selection,false,h.project().blobs);
      if (!clip) return null;
      const packet = G.AtriumSelectionClipboard.encode(clip,G.Atrium.id());
      const entry = clips().recordSelection?clips().recordSelection({clip,packet,owner:doc},doc.name):clips().record({data:packet.data,kind:clip.kind,source:doc.name,items:clip.items});
      if (!entry) throw Error(t("personal.clipFull"));
      return entry;
    },context);
  }
  function insertClip(id,context) {
    const source=clips()?.read(id);
    if(!source)throw Error(t("personal.missingClip"));
    editor(context,source.kind);
    const pending=clips().prepareAssets?.(id,source);
    return pending?pending.then(()=>placeClip(source,context)):placeClip(source,context);
  }
  function clipEntry(clip, context) {
    const isSnippet = saved(clip), verb = isSnippet ? t("personal.renameSnippet") : t("personal.saveClip");
    return {key:"personal:clipboard:"+clip.id,kind:isSnippet ? "insert" : "clipboard",label:clip.name,
      detail:[kindNames[clip.kind],clip.summary].join(" · "),
      keywords:["clipboard copy paste",...(isSnippet ? ["snippet insert reusable"] : []),clip.source,clip.media,clip.keywords,...aliases("cmd:clipboard-picker")].join(" "),
      actions:[{id:"save-snippet",label:verb,keepOpen:true,run:() => snippetForm(verb,clip.name,() => clip,context)}],
      preview:req => thumbnail(clip,req),run:req => insertClip(clip.id,req.context)};
  }
  function clipboardList(context) {
    const current = (clips()?.list() || []).filter(c => c.kind === context.kind), byId = new Map(current.map(c => [c.id,c]));
    return palette().present({kind:"list",title:t("personal.clipboard"),items:current.map(c => ({id:c.id,label:c.name,detail:c.summary})),
      text:current.length ? "" : t("personal.clipboardEmpty")}, {
      run(id) {
        if (!byId.has(id)) return;
        palette().close();return insertClip(id,context);
      }
    });
  }
  function placeText(context, text, net) {
    const {h,doc,point} = editor(context), raw = String(text ?? "").trim();
    if (!raw) throw Error(t("personal.nonEmpty"));
    const item = {id:G.Atrium.id(),kind:net ? "netlabel" : "label",x:point[0],y:point[1],text:raw};
    if (doc.kind === "pcb") Object.assign(item,{layer:"Silk",size:1});
    h.edit(() => {doc.items.push(item);}); h.select([item.id]); h.canvas()?.focus();
  }
  function fallback(request) {
    if (request.scope) return [];
    const {context,query} = request, detail = query ? t("personal.searchFor",{query}) : "";
    const sources = [["library","personal.searchLibrary"],["help","personal.searchHelp"],["provider","personal.searchProvider"]];
    const out = sources.map(([scope,label]) => ({key:"personal:search:"+scope,kind:"command",label:t(label),detail,
      keywords:"search "+scope,boost:-90,keepOpen:true,run:req => palette().scope(scope,req.query)}));
    if (context.surface || !Object.hasOwn(kindNames,context.kind)) return out;
    for (const [type,label,field] of [["net","personal.newNet","personal.netName"],["text","personal.newText","personal.text"]]) {
      const net = type === "net";
      if (net && context.kind !== "schematic") continue;
      out.push({key:"personal:create:"+type,kind:"insert",label:t(label),detail:query ? t("personal.createWith",{query}) : "",
        keywords:net ? "create place net label" : "create place text string",boost:-90,keepOpen:!query,
        run:req => query ? placeText(req.context,query,net) : form(t(label),"text",t(field),t("personal.paste"),"",text => {
          placeText(req.context,text,net); palette().close();
        })});
    }
    return out;
  }
  function entries(context) {
    const items = links().map(quicklink);
    if (!context) return items;
    items.push({key:"personal:preferences",kind:"setting",label:t("personal.preferences"),keywords:"aliases shortcuts quicklinks snippets clipboard hotkeys",
      run:() => G.AtriumLazy.need("AtriumPrefs").then(p => p.open("search"))});
    items.push(...fallback({context,query:""}));
    if (context.surface || !Object.hasOwn(kindNames,context.kind)) return items;
    if (clips()) {
      items.push({key:"personal:clipboard",kind:"command",label:t("personal.clipboard"),keywords:["clipboard paste",...aliases("cmd:clipboard-picker")].join(" "),
        keepOpen:true,run:req=>clipboardList(req.context)});
      for (const clip of clips().list()) if (clip.kind === context.kind) items.push(clipEntry(clip,context));
      if (context.selection.length) items.push({key:"personal:save-snippet",kind:"command",label:t("personal.saveSnippet"),
        keywords:"snippet save selection clipboard",keepOpen:true,run:req=>saveSelected(req.context)});
    }
    if (context.kind === "pcb") for (const block of context.host.project().layoutBlocks || []) items.push({key:"personal:block:"+block.id,kind:"insert",label:block.name,
      detail:"Layout block",keywords:"snippet layout block pcb",run:req=>placeBlock(block,req.context)});
    return items;
  }

  function actions(entry, request) {
    if (!entry.run || !validKey(entry.key) || (entry.kind !== "command" && entry.kind !== "insert")) return [];
    const id = entry.key.startsWith("cmd:") ? entry.key.slice(4) : G.AtriumExtensionPalette?.shortcutId(entry.key);
    const out = [{id:"personal-alias",label:t("personal.setAliases"),keepOpen:true,run:() =>
      form(entry.label,"aliases",t("personal.aliases"),t("personal.saveAliases"),aliases(entry.key).join(", "),value => {
        saveAliases(entry.key,value);
        palette().close(); request.context.host.info(t("personal.saved"));
      })}];
    if (id && G.AtriumKeymap.command(id) || menuButtons(entry.key).length) out.push({id:"personal-shortcut",label:t("personal.editShortcut"),
      run:() => editShortcut(entry.key,id)});
    return out;
  }

  const isMenuKey = key => /^(?:menu|power):/.test(key);
  function menuButtons(key) {
    if (!isMenuKey(key) || !G.document) return [];
    const power = key.startsWith("power:"), value = key.slice(power ? 6 : 5), property = power ? "powerNet" : "action";
    return [...document.querySelectorAll('.menubar [data-action]')].filter(b => b.dataset[property] === value && (power || b.dataset.powerNet == null));
  }
  function registerShortcut(key) {
    const K = G.AtriumKeymap;
    if (K.command(key)) return key;
    const buttons = menuButtons(key), first = buttons[0];
    if (!first) return null;
    const power = key.startsWith("power:"), scopeOf = b => b.closest("[data-scope]")?.dataset.scope || "";
    const scopes = [...new Set(buttons.map(scopeOf))];
    const when = scopes.includes("") ? "" : scopes.map(k => "kind == " + JSON.stringify(k)).join(" || ");
    const title = power ? "Place Power Port: " + first.dataset.powerNet : G.AtriumNavCommon.menuLabel(first);
    const category = first.closest(".work-menu")?.querySelector("summary")?.textContent.trim() || "View";
    K.registerCommand({id:key,title,category,notebook:true,when:power ? "schematic" : when,run:() => {
      const kind = G.AtriumNavHost?.doc()?.kind;
      const button = menuButtons(key).find(b => !b.disabled && !b.closest("[hidden]") && (!scopeOf(b) || scopeOf(b) === kind));
      button?.click();
    }});
    return key;
  }
  function restoreShortcuts() {
    for (const key of G.AtriumKeymap.unregisteredBindings?.() || []) if (isMenuKey(key)) registerShortcut(key);
  }
  function editShortcut(key, id) {
    const cmd = id || registerShortcut(key);
    if (cmd) G.AtriumKeymap.open({query:cmd});
  }

  function targets() {
    const out = new Map(G.AtriumKeymap.commands().map(c => {
      const key = isMenuKey(c.id) || G.AtriumExtensionPalette?.shortcutId(c.id) ? c.id : "cmd:"+c.id;
      return [key,{key,title:c.title,id:c.id}];
    }));
    for (const entry of palette()?.entries?.(">") || []) if (!out.has(entry.key)) out.set(entry.key,{key:entry.key,title:entry.label});
    for (const button of document.querySelectorAll('.menubar [data-power-net]:not([data-power-net=""])')) {
      const net = button.dataset.powerNet, key = "power:"+net;
      if (!out.has(key)) out.set(key,{key,title:"Place Power Port: "+net});
    }
    return [...out.values()].sort((a,b) => a.title.localeCompare(b.title));
  }
  let preferenceFieldId = 0;
  function renderPreferences(container,P) {
    const {el,button,group} = P, feedback = el("p","ui-status-line palette-personal-status");
    feedback.setAttribute("role","status");
    const announce = text => {feedback.textContent = text;};
    const fail = fn => () => {try {fn();} catch (error) {announce(error.message);}};
    const field = (label,input,help) => {
      const row = el("div","prf-row palette-personal-field"), name = el("label","prf-label",label), control = el("span","prf-control");
      name.htmlFor = input.id = "prf-personal-" + ++preferenceFieldId;
      input.classList.add("ui-field");
      control.append(input);
      row.append(name,control);
      if (help) {
        const hint = el("small","prf-help",help);
        hint.id = "prf-quicklink-template-help";
        input.setAttribute("aria-describedby",hint.id);
        row.append(hint);
      }
      return row;
    };
    const action = (label,fn) => button(label,fn,"prf-button");
    const rowAction = (label,fn) => { const b = button(label,fn,"prf-button"); b.dataset.size = "sm"; return b; };
    const groups = el("div","palette-personal-groups");

    const commands = group(groups,t("personal.aliasGroup")), target = el("select"), aliasesInput = el("input"), row = el("div","palette-personal-controls");
    commands.dataset.search = "alias command keyboard global hotkey shortcut";
    let catalog = new Map();
    const sync = () => {
      catalog = new Map(targets().map(c=>[c.key,c]));
      const key = target.value;
      target.replaceChildren(...[...catalog.values()].map(c=>new Option(c.title,c.key)));
      if (catalog.has(key)) target.value = key;
    };
    const shortcut = action(t("personal.editShortcut"), () => {
      const command = catalog.get(target.value);
      if (command) {prefs().close(); editShortcut(command.key,command.id);}
    });
    const read = () => {
      aliasesInput.value = aliases(target.value).join(", ");
      shortcut.disabled = !catalog.get(target.value)?.id && !menuButtons(target.value).length;
    };
    target.addEventListener("change",read);
    target.addEventListener("focus",sync);
    aliasesInput.placeholder = t("personal.aliasHint");
    sync(); read();
    row.append(action(t("personal.saveAliases"),fail(() => {
      aliasesInput.value = saveAliases(target.value,aliasesInput.value).join(", "); announce(t("personal.saved"));
    })),shortcut);
    commands.append(field(t("personal.command"),target),field(t("personal.aliases"),aliasesInput),row);

    const quicklinks = group(groups,t("personal.quicklinks")), name = el("input"), template = el("input"), formEl = el("form","palette-personal-link-form");
    const list = el("div","ui-list palette-personal-list"), saveButton = action(t("personal.saveLink"));
    list.setAttribute("role","list");
    quicklinks.dataset.search = "quicklinks url template browser search";
    name.required = template.required = true;
    name.maxLength = 80; template.maxLength = 2048; saveButton.type = "submit";
    let editing = null;
    const paintLinks = () => {
      list.replaceChildren(...links().map(link => {
        const li = el("div","ui-row palette-personal-row"), text = el("span","ui-row-text"), title = el("span","ui-row-title",link.name), actions = el("span","ui-row-actions");
        li.setAttribute("role","listitem");
        const edit = rowAction(t("personal.edit"),() => {editing = link.id; name.value = link.name; template.value = link.template; name.focus();});
        const remove = rowAction(t("personal.remove"),() => {
          removeLink(link.id);
          if (editing === link.id) {editing = null; formEl.reset();}
          paintLinks(); name.focus(); announce(t("personal.removed"));
        });
        edit.setAttribute("aria-label",t("personal.edit")+" "+link.name);
        remove.setAttribute("aria-label",t("personal.remove")+" "+link.name);
        title.title = link.template; text.append(title); actions.append(edit,remove); li.append(text,actions); return li;
      }));
    };
    formEl.addEventListener("submit",e => {e.preventDefault(); fail(() => {
      saveLink({id:editing,name:name.value,template:template.value});
      editing = null; formEl.reset(); paintLinks(); announce(t("personal.saved"));
    })();});
    formEl.append(field(t("personal.linkName"),name),field(t("personal.template"),template,t("personal.linkHint",{example:token})),saveButton);
    quicklinks.append(formEl,list); paintLinks();

    const snippets = group(groups,t("personal.snippets")), items = el("div","ui-list palette-personal-list"), help = el("div","ui-empty palette-personal-empty");
    items.setAttribute("role","list");
    help.append(el("p",null,t("personal.snippetHint")));
    snippets.dataset.search = "snippet selection clipboard saved group reusable";
    const paintSnippets = () => {
      const rows = (clips()?.list() || []).filter(saved);
      help.hidden = !!rows.length;
      items.replaceChildren(...rows.map(clip => {
        const li = el("div","ui-row palette-personal-row"), text = el("span","ui-row-text"), actions = el("span","ui-row-actions");
        li.setAttribute("role","listitem");
        text.append(el("span","ui-row-title",clip.name), el("span","ui-row-detail",kindNames[clip.kind]));
        const remove = rowAction(t("personal.remove"), () => {clips().pin(clip.id,false); paintSnippets(); announce(t("personal.removed"));});
        remove.setAttribute("aria-label",t("personal.remove")+" "+clip.name);
        actions.append(remove); li.append(text,actions); return li;
      }));
    };
    snippets.append(help,items); paintSnippets();
    needClipboard().then(() => {if (container.isConnected) paintSnippets();},() => {});
    container.replaceChildren(groups,feedback);
  }

  let registered = false, watched = false, watchingClips = false, clipboardLoading;
  function needClipboard() {
    if (!clipboardLoading) clipboardLoading = G.AtriumLazy.need("AtriumClipHistory").then(history => {
      if (!watchingClips) {watchingClips = true; history.on(invalidate); invalidate();}
      return history;
    },error => {clipboardLoading = null; throw error;});
    return clipboardLoading;
  }
  function install() {
    if (!G.AtriumLabs?.notebookEnabled()) return;
    if (!watched && prefs()) {
      watched = true;
      prefs().on("search.",({key}) => {if (key === aliasKey || key === linkKey) invalidate();});
    }
    if (!registered && palette()?.registerProvider) {
      registered = true;
      palette().registerProvider("personal",{entries,fallback});
      needClipboard().catch(() => {});
    }
  }
  if (G.document) {
    G.addEventListener("waffle-palette-ready",install);
    install();
    if (!prefs()) G.AtriumLazy.need("AtriumPrefs").then(() => {install(); invalidate();},() => {});
  }
  return Object.freeze({aliases, saveAliases, templateURL, saveLink, removeLink, links, entries, fallback, actions, install, renderPreferences, restoreShortcuts});
})();
