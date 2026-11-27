"use strict";
// Clipboard history: Window › Panels › Clipboard, Edit › Clipboard History… (Mod+Alt+V, a
// picker at the cursor like Windows' Win+V). Lazy; selection-clipboard.js records every copy
// and cut here when the clipboard is used.
//
//   AtriumClipHistory.record({data, kind, cut, source, items}) -> entry   (a copy or cut)
//   AtriumClipHistory.list()                 -> entries, newest first (copies of the metadata)
//   AtriumClipHistory.recopy(id, {paste})    makes an entry the current clipboard again
//   AtriumClipHistory.pin(id, on?) / rename(id, name) / remove(id) / clear()
//   AtriumClipHistory.stats()                -> {entries, pinned, dataBytes, thumbs, thumbBytes, totalBytes}
//   AtriumClipHistory.toggle(show?) / picker()
//
// Storage. An entry keeps the copy once, as the "Waffle-Selection/1" JSON the clipboard wrote
// (data); it is decoded (and so validated again) only when it is recopied, pasted or drawn.
// Pinned entries are saved per user in localStorage ("atrium.clipboard.v1"), never in the
// project; the rest of the history lives for the session, or also across restarts when the
// "clipboard.keepHistory" preference is on. Saved entries are untrusted when read back: shape
// and size checks here, the full selection validator when one is used, textContent only.
// Memory. The history holds at most "clipboard.historySize" unpinned entries (default 20) and
// at most BUDGET characters of copy data in all; thumbnails are drawn lazily, one visible entry per animation frame,
//  by the editor's own canvas renderer, and cached as small bitmaps.
globalThis.AtriumClipHistory = (() => {
  const STORE = "atrium.clipboard.v1", FORMAT = "atrium-clip-history", VERSION = 1;
  const PREF_SIZE = "clipboard.historySize", PREF_KEEP = "clipboard.keepHistory";
  const SIZE = {initial: 20, min: 1, max: 100};
  const ENTRY_MAX = 16 * 1024 * 1024 + 512, BUDGET = 48 * 1024 * 1024; // characters of copy data
  const SAVE_ENTRY = 2 * 1024 * 1024, SAVE_TOTAL = 4 * 1024 * 1024;   // what localStorage is asked to hold
  const THUMB = {w: 88, h: 55, stage: 1.6};                           // CSS px; the stage draws 1.5x and scales down
  const PREVIEW = {w:256, h:160, stage:1.4};
  const DRAG = "application/x-atrium-clip";
  const KINDS = new Set(["schematic", "pcb"]);
  // Object counts in the order they are listed ("3 parts · 12 tracks").
  const NOUNS = [["part", "part", "parts"], ["wire", "wire", "wires"], ["track", "track", "tracks"], ["via", "via", "vias"], ["pad", "pad", "pads"],
    ["polygon", "pour", "pours"], ["netlabel", "net label", "net labels"], ["power", "power port", "power ports"], ["port", "port", "ports"],
    ["offsheet", "off-sheet connector", "off-sheet connectors"], ["sheetsymbol", "sheet symbol", "sheet symbols"], ["bus", "bus", "buses"],
    ["busentry", "bus entry", "bus entries"], ["junction", "junction", "junctions"], ["label", "label", "labels"], ["graphic", "shape", "shapes"],
    ["noerc", "No ERC marker", "No ERC markers"], ["textframe", "text frame", "text frames"], ["image", "image", "images"]];
  const NOUN = new Map(NOUNS.map(n => [n[0], n]));

  const storage = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  let entries = [], currentId = null, serial = 0, saveTimer = 0, notice = "";
  const listeners = new Set();
  const butter = () => globalThis.AtriumLabs?.butterEnabled("visualHistory") === true;
  const imageEntry = e => (typeof e.media === "string" && e.media.includes("Image")) || e.counts?.image > 0;
  let persistedImages = [], mediaReady, mediaChanged = false;
  function mediaModule() {
    return mediaReady ||= Promise.resolve(globalThis.AtriumClipboardMedia || globalThis.AtriumLazy?.need("AtriumClipboardMedia"))
      .then(async media => {
        if (media) await media.sync(persistedImages);
        return media;
      }).catch(error => { mediaReady=undefined; throw error; });
  }

  // ------------------------------------------------------------------ preferences
  function pref(key, fallback) {
    try {
      const P = globalThis.AtriumPrefs;
      if (P?.get) { const v = P.get(key); if (v !== undefined) return v; }
      else { const v = globalThis.AtriumPref.legacyValue(key, storage); if (v !== undefined) return v; }
    } catch {}
    return fallback;
  }
  const limit = () => { const n = Math.round(+pref(PREF_SIZE, SIZE.initial)); return Number.isFinite(n) ? Math.min(SIZE.max, Math.max(SIZE.min, n)) : SIZE.initial; };
  const keep = () => pref(PREF_KEEP, false) === true;

  // ------------------------------------------------------------------ entries
  const str = (v, max) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max) : "";
  // The token the clipboard adds to each copy differs between two copies of the same objects;
  // the rest of the text is what makes two copies the same.
  function body(data) {
    const at = data.indexOf('"token":"');
    if (at < 0 || at > 96) return data;
    const end = data.indexOf('"', at + 9);
    return end < 0 ? data : data.slice(0, at) + data.slice(end + 1);
  }
  function countItems(items) {
    const counts = {};
    for (const i of items || []) { const k = NOUN.has(i?.kind) ? i.kind : null; if (k) counts[k] = (counts[k] || 0) + 1; }
    return counts;
  }
  function describe(counts, max = 3) {
    const parts = NOUNS.filter(([k]) => counts?.[k] > 0).map(([k, one, many]) => counts[k] + " " + (counts[k] === 1 ? one : many));
    if (!parts.length) return "No objects";
    return parts.length > max ? parts.slice(0, max).join(" · ") + " · +" + (parts.length - max) + " more" : parts.join(" · ");
  }
  // "R1, R2, C5" for parts, else the counts.
  function autoName(items, counts) {
    if(items?.length===1) {
      const item=items[0];
      const title=item.kind==="image"?item.caption||item.name||item.alt:
        ["textframe","label","netlabel"].includes(item.kind)?item.text||globalThis.AtriumNotebook?.bodyText?.(item.richText):"";
      if(typeof title==="string"&&title.trim())return str(title.trim(),80);
    }
    const refs = [];
    for (const i of items || []) if (i?.kind === "part" && typeof i.ref === "string" && i.ref) { refs.push(str(i.ref, 24)); if (refs.length > 3) break; }
    if (!refs.length) return describe(counts, 2);
    const parts = counts.part || refs.length;
    return refs.slice(0, 3).join(", ") + (parts > 3 ? " +" + (parts - 3) : "");
  }
  function content(items) {
    const terms=[], kinds=new Set();
    for (const item of items || []) {
      const kind=item.math || item.calculation ? "Math" : item.kind==="image" ? "Image" :
        ["textframe","label","netlabel"].includes(item.kind) ? "Text" : null;
      if (kind) kinds.add(kind);
      for (const t of [item.ref,item.value,item.net,item.text,item.name,item.calculation?.expression]) if (typeof t==="string" && terms.length<35) terms.push(str(t,95));
      if(item.richText && terms.length<35) terms.push(str(globalThis.AtriumNotebook?.bodyText?.(item.richText)||"",160));
    }
    return {media:[...kinds].join(" · "),terms:str(terms.join(" "),1500)};
  }
  let searchIndex;
  const normalise = text => text.normalize("NFC").toLowerCase();
  function* trigrams(text) {
    for (let i=0;i+3<=text.length;i++) yield text.slice(i,i+3);
  }
  function index() {
    if (searchIndex) return searchIndex;
    const text = new Map(), grams = new Map();
    for (const e of entries) {
      const value = normalise([nameOf(e),e.source,e.kind,e.media,e.terms,describe(e.counts)].join(" "));
      text.set(e,value);
      for (const gram of new Set(trigrams(value))) {
        let set = grams.get(gram);
        if (!set) { set = new Set(); grams.set(gram,set); }
        set.add(e);
      }
    }
    return searchIndex = {text,grams};
  }
  function filter(query="",pinned=false) {
    const words=normalise(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return pinned ? entries.filter(e=>e.pinned) : entries;
    const {text,grams} = index();
    let candidates;
    for (const word of words) for (const gram of trigrams(word)) {
      const matches = grams.get(gram);
      if (!matches) return [];
      if (!candidates || matches.size < candidates.size) candidates=matches;
    }
    return entries.filter(e=>(!pinned||e.pinned)&&(!candidates||candidates.has(e))&&words.every(w=>text.get(e).includes(w)));
  }
  const kindName = k => k === "pcb" ? "Layout" : "Schematic";
  const nameOf = e => e.name || e.auto;
  const view = e => ({id: e.id, name: nameOf(e), custom: !!e.name, kind: e.kind, source: e.source, time: e.time, pinned: e.pinned,
    media:e.media||"", keywords:e.terms||"", counts: {...e.counts}, summary: describe(e.counts), size: e.data.length, current: e.id === currentId, thumb: !!e.thumb});
  const find = id => entries.find(e => e.id === id) || null;
  const newId = () => "c" + Date.now().toString(36) + (++serial).toString(36);

  function recordSelection(job, source, session=host?.folderProject?.()) {
    const entry=record({data:job.packet.data,kind:job.clip.kind,cut:!!job.cut,source:String(source||""),items:job.clip.items});
    if(entry && butter()) captureMedia(entry,job.clip.items,job.owner,undefined,session);
    return entry;
  }
  function captureMedia(entry,items,doc,provided,session=host?.folderProject?.()){
    if(!session||!items.some(i=>i.kind==="image"&&i.asset))return;
    const stored=find(entry.id);if(!stored)return;
    stored.capturing=mediaModule().then(m=>m?.capture(entry,session,doc,items,provided)).then(()=>{
      stored.capturing=null;release(stored);stored.artRevision=(stored.artRevision||0)+1;paint();
    },e=>{stored.capturing=null;say("Could not retain the original clipboard image: "+e.message);});
  }
  function recordImage(item,doc,bytes){
    if(!butter())return null;
    const clip={kind:"schematic",origin:[item.x,item.y],items:[item],library:[]};
    const packet=AtriumSelectionClipboard.encode(clip,"image");
    const entry=record({data:packet.data,kind:clip.kind,items:clip.items,source:doc.name});
    if(entry)captureMedia(entry,clip.items,doc,bytes);return entry;
  }
  function recordText(text,{math=false,kind="schematic",source=""}={}){
    if(typeof text!=="string"||!text.trim()||text.length>65536||!KINDS.has(kind))return null;
    const item=kind==="pcb"?{id:"copied-text",kind:"label",x:0,y:0,text,layer:"Silk",size:1.5}:
      {id:"copied-text",kind:"textframe",x:0,y:0,text,w:Math.max(12,Math.min(80,text.length*2)),h:8,size:2.5,...(math?{math:true}:{})};
    const packet=AtriumSelectionClipboard.encode({kind,origin:[0,0],items:[item],library:[]},"text");
    return record({data:packet.data,kind,items:[item],source});
  }
  /** @param {string} id @param {any} clip @param {{target?: any, document?: AtriumDocument, isCurrent?: () => boolean}} [options] */
  function prepareAssets(id,clip,{target=host,document,isCurrent}={}){
    if(!butter())return null;
    const e=find(id);if(!e||!clip.items.some(i=>i.kind==="image"&&i.asset))return null;
    const owner=document ?? target?.doc();
    const current=()=>find(id)===e && !!owner &&
      (document ? target.docById(owner.id)===owner : target.doc()===owner) && isCurrent?.()!==false;
    return Promise.resolve(e.capturing).then(mediaModule)
      .then(m=>m?.prepare(id,clip,target,{document,isCurrent:current}));
  }
  function preparePacket(data,clip) {
    if(!clip.items.some(i=>i.kind==="image"&&i.asset))return null;
    const entry=entries.find(e=>e.data===data)||entries.find(e=>Math.abs(e.data.length-data.length)<128&&body(e.data)===body(data));
    return entry && prepareAssets(entry.id,clip);
  }
  function setMediaSize(id,bytes){
    const entry=find(id);if(!entry)return;
    entry.mediaBytes=bytes;
    mediaChanged=true;trim();schedule();
  }
  function record(input) {
    const data = input?.data;
    if (typeof data !== "string" || !data || data.length > ENTRY_MAX || !KINDS.has(input.kind)) return null;
    const key = body(data);
    let e = entries.find(x => x.kind === input.kind && Math.abs(x.data.length - data.length) <= 128 && body(x.data) === key);
    if (e) {
      e.time = Date.now(); e.data = data;
      entries.splice(entries.indexOf(e), 1); entries.unshift(e);
    } else {
      let items = input.items;
      if (!Array.isArray(items)) try { items = JSON.parse(data).items; } catch { items = []; }
      const counts = countItems(items);
      e = {id: newId(), data, kind: input.kind, source: str(input.source, 120), time: Date.now(), name: "", auto: str(autoName(items, counts), 80),
        ...content(items), counts, pinned: false, cut: !!input.cut, thumb: null};
      entries.unshift(e);
    }
    currentId = e.id;
    trim(); changed(true);
    return view(e);
  }
  // Unpinned entries over the size limit go first, oldest first; then the oldest unpinned
  // ones until the data fits the budget. The newest entry always stays.
  function trim() {
    let unpinned = 0;
    for (const e of [...entries]) if (!e.pinned && ++unpinned > limit()) drop(e);
    const cost=e=>e.data.length+(e.pinned?0:e.mediaBytes||0);
    let total = entries.reduce((n,e)=>n+cost(e),0);
    for (let i = entries.length - 1; i > 0 && total > BUDGET; i--) {
      const e = entries[i];
      if (!e.pinned) { total -= cost(e); drop(e); }
    }
  }
  function drop(e) {
    searchIndex = undefined;
    if(imageEntry(e) && (butter() || mediaReady || persistedImages.includes(e.id))) {
      const media=globalThis.AtriumClipboardMedia;
      (media ? media.forget(e.id) : mediaModule().then(m=>m?.forget(e.id))).catch(error=>say(error.message));
    }
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
    release(e);
    if (currentId === e.id) currentId = null;
  }
  function release(e) { if (e.thumb?.canvas) { e.thumb.canvas.width = e.thumb.canvas.height = 0; } e.thumb = null; }
  // Pinned clips are never trimmed, so pinning has its own ceiling: the same data budget and at most
  // SIZE.max pins. A pin over it is refused with a note (unpin or delete one first).
  function pin(id, on) {
    const e = find(id); if (!e) return null;
    const want = on == null ? !e.pinned : !!on;
    if (want && !e.pinned) {
      const pinned = entries.filter(x => x.pinned), bytes = pinned.reduce((n, x) => n + x.data.length, 0);
      if (pinned.length >= SIZE.max || bytes + e.data.length > BUDGET) {
        notice = "Pinned clips are limited to " + SIZE.max + " and " + Math.round(BUDGET / 1048576) + " MB of copies; unpin or delete one to pin this.";
        changed(false); return view(e);
      }
    }
    e.pinned = want;
    trim(); changed(true);
    return view(e);
  }
  function rename(id, name) {
    const e = find(id); if (!e) return null;
    const n = str(String(name ?? "").trim(), 80);
    e.name = n && n !== e.auto ? n : "";
    changed(true);
    return view(e);
  }
  // Named pins are snippets. Use the same selection packets and storage as the
  // clipboard history, but report a failed write before calling a snippet saved.
  function saveSnippet(id, name) {
    const e = find(id), next = str(String(name ?? "").trim(), 80).trim();
    if (!e) throw Error("This clipboard entry is no longer available.");
    if (!next) throw Error("Enter a snippet name.");
    if (entries.some(x => x !== e && x.kind === e.kind && x.pinned && x.name.toLowerCase() === next.toLowerCase()))
      throw Error("A snippet with that name already exists for this editor.");
    if (e.data.length > SAVE_ENTRY) throw Error("This selection exceeds the 2 MB limit for saved snippets.");
    if (!e.pinned && entries.filter(x => x.pinned).length >= SIZE.max) throw Error("Unpin a clipboard entry before saving another snippet.");
    const before = {name:e.name, pinned:e.pinned};
    e.name = next; e.pinned = true;
    if (!serialise().out.some(x => x.id === id) || !save()) {
      Object.assign(e, before);
      save();
      throw Error("There is not enough room to save this snippet.");
    }
    changed(false);
    return view(e);
  }
  function remove(id) { const e = find(id); if (!e) return false; drop(e); changed(true); return true; }
  function clear(all = false) { for (const e of [...entries]) if (all || !e.pinned) drop(e); changed(true); }
  function list(query="",pinned=false) { return filter(query,pinned).map(view); }
  function stats() {
    const mediaBytes=globalThis.AtriumClipboardMedia?.bytes()||0;
    let dataBytes = 0, thumbBytes = 0, thumbs = 0;
    for (const e of entries) {
      dataBytes += e.data.length; // Latin-1 JSON: one byte per character in V8 and JavaScriptCore.
      if (e.thumb?.canvas) { thumbs++; thumbBytes += e.thumb.canvas.width * e.thumb.canvas.height * 4; }
    }
    return {entries: entries.length, pinned: entries.filter(e => e.pinned).length, limit: limit(), budget: BUDGET, dataBytes,mediaBytes, thumbs, thumbBytes, totalBytes: dataBytes + thumbBytes + mediaBytes};
  }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function changed(persist) {
    searchIndex = undefined;
    if (persist) schedule();
    for (const fn of [...listeners]) try { fn(); } catch (e) { globalThis.console?.warn?.(e); }
    paint();
  }

  // ------------------------------------------------------------------ persistence
  function schedule() { if (!storage) return; clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
  function serialise() {
    const out = [], skipped = [];
    let total = 0;
    const ordered = [...entries.filter(e => e.pinned), ...entries.filter(e => !e.pinned)];
    for (const e of ordered) {
      if (!e.pinned && !keep()) continue;
      if (e.data.length > SAVE_ENTRY || total + e.data.length > SAVE_TOTAL) { skipped.push(e); continue; }
      total += e.data.length;
      out.push({media:e.media,mediaBytes:e.mediaBytes,terms:e.terms,id: e.id, name: e.name, auto: e.auto, kind: e.kind, source: e.source, time: e.time, pinned: e.pinned, counts: e.counts, data: e.data});
    }
    return {out, skipped};
  }
  function mediaSaved(rows) {
    const ids=rows.filter(imageEntry).map(e=>e.id);
    const changed=mediaChanged || ids.length!==persistedImages.length || ids.some((id,i)=>id!==persistedImages[i]);
    const active=butter() || !!mediaReady || persistedImages.length>0;
    persistedImages=ids;
    if (!active || !changed) return;
    mediaChanged=false;
    mediaModule().then(m=>m?.sync(persistedImages)).then(saved=>{
      if(saved===false && persistedImages.length)
        say("Local storage could not retain every original clipboard image. The image clips remain available for this session.");
    }).catch(error=>say(error.message));
  }
  function save() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!storage) return false;
    const {out, skipped} = serialise();
    notice = skipped.some(e => e.pinned) ? "Some pinned clips are too large to keep after a restart; they stay pinned until Waffle closes." : "";
    try {
      if (!out.length) storage.removeItem(STORE);
      else storage.setItem(STORE, JSON.stringify({format: FORMAT, version: VERSION, entries: out}));
      mediaSaved(out);
      return true;
    } catch {
      // Over the storage quota: keep the pinned entries only.
      try {
        const pinned=out.filter(e=>e.pinned);
        storage.setItem(STORE, JSON.stringify({format: FORMAT, version: VERSION, entries: pinned}));
        mediaSaved(pinned);
      } catch {}
      notice = "The clipboard history is too large to keep after a restart.";
      return false;
    }
  }
  function valid(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id) || !KINDS.has(raw.kind)) return null;
    if (typeof raw.data !== "string" || raw.data.length > SAVE_ENTRY || !raw.data.startsWith('{"format":"atrium-selection"')) return null;
    const counts = {};
    if (raw.counts && typeof raw.counts === "object") for (const [k, n] of Object.entries(raw.counts)) if (NOUN.has(k) && Number.isInteger(n) && n > 0 && n < 1e7) counts[k] = n;
    const time = Number.isFinite(raw.time) ? raw.time : Date.now();
    return {mediaBytes:Number.isSafeInteger(raw.mediaBytes)&&raw.mediaBytes>0?raw.mediaBytes:0,id: raw.id, data: raw.data, kind: raw.kind, source: str(raw.source, 120), time, name: str(raw.name, 80), auto: str(raw.auto, 80) || describe(counts, 2),
      counts, pinned: raw.pinned === true, cut: false, thumb: null};
  }
  function restore() {
    let raw = null;
    try { raw = JSON.parse(storage?.getItem(STORE) || "null"); } catch {}
    if (raw?.format !== FORMAT || raw.version !== VERSION || !Array.isArray(raw.entries)) return 0;
    const seen = new Set(entries.map(e => e.id)), back = [];
    persistedImages=[];
    for (const r of raw.entries.slice(0, SIZE.max * 2)) {
      const e = valid(r);
      if (!e) continue;
      if (imageEntry(r)) persistedImages.push(e.id);
      if (seen.has(e.id) || (!e.pinned && !keep())) continue;
      if(typeof r.terms==="string")Object.assign(e,{terms:str(r.terms,1500),media:str(r.media,50)});
      else try { Object.assign(e,content(JSON.parse(e.data).items)); } catch { /* Older malformed packets are rejected on use. */ }
      seen.add(e.id); back.push(e);
    }
    entries = [...entries, ...back].sort((a, b) => b.time - a.time);
    searchIndex = undefined;
    trim();
    return back.length;
  }

  // ------------------------------------------------------------------ editor glue
  const doc = globalThis.document, hasDOM = () => !!doc?.createElement;
  let host = null;
  const clipboard = () => globalThis.AtriumSelectionClipboard?.active?.() || null;
  const say = text => host?.info?.(text);
  const quote = e => "“" + nameOf(e) + "”";
  function decoded(e) {
    try { return globalThis.AtriumSelectionClipboard.decode(e.data); }
    catch (error) {
      drop(e); changed(true);
      say("This clip can no longer be read and was removed from the history" + (error?.message ? ": " + error.message : "."));
      return null;
    }
  }
  const read = id => { const e = find(id); return e ? decoded(e) : null; };
  // Kind check before a paste: the clipboard has no cross-editor paste, so say what to do.
  function kindProblem(e) {
    const d = host?.doc?.();
    if (!d) return "Open a document to paste.";
    if (d.kind === e.kind) return "";
    return quote(e) + " holds " + (e.kind === "pcb" ? "layout (PCB) objects: open a PCB layout to paste it." : "schematic objects: open a schematic sheet to paste it.") +
      (e.kind === "schematic" && d.kind === "pcb" ? " To bring parts onto a board, use Design › Update PCB." : "");
  }
  // Make an entry the current clipboard again (and the system clipboard where allowed).
  async function recopy(id, {paste = false} = {}) {
    const e = find(id), C = clipboard();
    if (!e) return false;
    if (!C?.adopt) { say("The clipboard is not ready yet."); return false; }
    let r;
    try { r = C.adopt(e.data); } catch (error) { decoded(e); if (find(id)) say(error.message); return false; }
    currentId = e.id; e.used = Date.now(); paint();
    const what = " (" + describe(e.counts, 2) + ")";
    if (paste) {
      const problem = kindProblem(e);
      if (problem) say(problem + " It is on the clipboard now.");
      else try{const ready=prepareAssets(e.id,r.clip);if(ready)await ready;await C.place(r.clip);}catch(error){say(error.message);return false;}
      r.written.catch(() => false);
      return !problem;
    }
    say("Copied " + quote(e) + what + " to the clipboard.");
    const system = await r.written.catch(() => false);
    if (!system && currentId === e.id) say("Copied " + quote(e) + what + " inside Waffle; the system clipboard is unavailable.");
    return true;
  }
  // Drop on a canvas: paste the entry with its origin at the drop point (snapped), in one edit.
  function dropAt(id, canvas, x, y) {
    const e = find(id);
    if (!e || !host) return false;
    const hit = host.hit?.(canvas, x, y);
    if (!hit) return false;
    if (hit.doc !== host.doc()) { say("Drop onto the active pane, or click this pane first."); return false; }
    const problem = kindProblem(e);
    if (problem) { say(problem); return false; }
    const clip = decoded(e);
    if (!clip) return false;
    try {
      const A = globalThis.Atrium, d = host.doc(), at = hit.point.map(v => A.snap(v, d.grid));
      const pending = AtriumEditSelection.demand(clip);
      if (pending) {pending.then(() => {if (host.doc() === d) dropAt(id, canvas, x, y);}, error => say(error.message)); return true;}
      const owner=host.project();
      const place=()=>{
        let plan;
        try {
          if(host.doc()!==d || host.project()!==owner)return false;
          plan=AtriumEditSelection.prepare(owner,d,clip,host.defs());
          let ids=[];
          if(host.edit(()=>{ids=plan.commit(at);})===false)return false;
          host.select?.(ids);
          currentId=e.id;paint();
          say("Pasted " + quote(e) + " (" + describe(e.counts, 2) + ").");
          return true;
        } finally {
          if(plan)plan.cancel?.();
          else globalThis.AtriumClipboardMedia?.cancelClip(clip);
        }
      };
      const assets=prepareAssets(id,clip);
      if(assets){assets.then(place).catch(error=>say(error.message));return true;}
      return place();
    } catch (error) { say(error.message); return false; }
  }

  // ------------------------------------------------------------------ thumbnails
  // One staging canvas and one renderer view draw every thumbnail; each entry keeps a small
  // bitmap (a detached canvas). A theme or layer-colour change redraws them.
  let epoch = 0;
  const thumbKey = () => epoch + ":" + (globalThis.devicePixelRatio || 1);
  function draw(e, size = THUMB, assets) {
    let clip;
    try { clip = AtriumSelectionClipboard.decode(e.data); } catch { return null; }
    const d = Atrium.sheet(clip.kind,"Clipboard"), defs = new Map(clip.library.map(x=>[x.id,x]));
    d.items=clip.items;
    if (clip.kind==="schematic") d.schDrawing={width:200,height:200,grid:2.54,frame:[],border:false,zones:false,showGrid:false};
    const canvas=globalThis.AtriumHistoryArtwork?.render(d,defs,size,null,assets);
    return canvas ? {canvas,key:thumbKey()} : null;
  }
  async function mediaArtwork(e,size,signal) {
    let assets;
    try {
      const items=JSON.parse(e.data).items;
      if(items.some(i=>i.asset)) {
        await e.capturing;
        if(signal?.aborted)return null;
        const media=await mediaModule();
        if(signal?.aborted)return null;
        assets=await media?.artwork(e.id,items,signal,size.w*2);
      }
      return signal?.aborted?null:draw(e,size,assets);
    } finally {globalThis.AtriumClipboardMedia?.close(assets);}
  }
  function want(e, target, watcher) {
    const paint=async signal=>{
      if (!e.thumb || e.thumb.key!==thumbKey()) {
        const next=e.media?.includes("Image")?await mediaArtwork(e,THUMB,signal):draw(e);
        if(signal?.aborted||!target.isConnected)return;
        release(e);e.thumb=next;
      }
      if(e.thumb) globalThis.AtriumHistoryArtwork.copy(target,e.thumb.canvas);
      else target.dataset.failed="true";
      delete target.dataset.pending;
    };
    if (e.thumb?.key===thumbKey()) {globalThis.AtriumHistoryArtwork.copy(target,e.thumb.canvas);return;}
    target.dataset.pending="true";watcher?.add(target,paint);
  }
  function staleThumbs() { epoch++; paint(); }

  // ------------------------------------------------------------------ DOM helpers
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(doc, tag, cls, text); }
  function icon(path) {
    const NS = "http://www.w3.org/2000/svg", s = doc.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "icon"); s.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS(NS, "path"); p.setAttribute("d", path); s.append(p);
    return s;
  }
  const ICON = {pin: "M9 4h6M10 4v5l-3 4h10l-3-4V4M12 13v7", rename: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4"};
  function iconButton(cls, label, path, fn) {
    // A small library icon button (ui/components.css); the pin's pressed state is the library's.
    const b = el("button", "ui-icon-button clip-btn " + cls); b.type = "button"; b.dataset.size = "sm"; b.tabIndex = -1; b.title = label; b.setAttribute("aria-label", label);
    if (path) b.append(icon(path));
    b.addEventListener("click", ev => { ev.stopPropagation(); fn(); });
    b.addEventListener("dblclick", ev => ev.stopPropagation());
    return b;
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 172800) return "yesterday";
    if (s < 7 * 86400) return Math.round(s / 86400) + " days ago";
    try { return new Date(t).toLocaleDateString(); } catch { return Math.round(s / 86400) + " days ago"; }
  }
  const binding = id => globalThis.AtriumKeymap?.hintKey?.(id, host?.doc?.()?.kind) || "";
  function emptyState() {
    const empty = el("p", "empty-state ui-dock-empty", "Copy something"), copy = binding("copy");
    if (copy) empty.append(" (", AtriumShortcut.render(copy, {variant:"inline"}), ")");
    empty.append(" and it appears here.");
    return empty;
  }
  function paintEmpty(empty, visible) {
    empty.hidden = !!visible.length;
    if (empty.hidden) return;
    const state = entries.length ? "filtered" : "empty";
    if (empty.dataset.state === state) return;
    empty.dataset.state = state;
    if (state === "filtered") empty.textContent = "No matching clips.";
    else empty.replaceChildren(...emptyState().childNodes);
  }

  // One row; the panel and the picker both use it. Design text goes in with textContent only.
  function row(e, o) {
    const r = el("div", "ui-row ui-card-row clip-item"); r.setAttribute("role", "option"); r.id = o.prefix + e.id; r.dataset.id = e.id;
    if (e.id === currentId) r.classList.add("is-current");
    if (e.pinned) r.classList.add("is-pinned");
    const d = host?.doc?.();
    if (d && d.kind !== e.kind) r.classList.add("is-other-kind");
    const thumb = el("canvas", "clip-thumb"); thumb.setAttribute("aria-hidden", "true"); thumb.width = 1; thumb.height = 1;
    thumb.dataset.kind = e.kind;
    const text = el("div", "ui-dock-text");
    const top = el("div", "clip-line");
    top.append(el("span", "clip-name", nameOf(e)));
    if (e.id === currentId) { const current = el("span", "ui-badge clip-badge", "Current"); current.dataset.tone = "success"; top.append(current); }
    const meta = el("div", "clip-meta ui-row-subtitle");
    meta.append(el("span", "clip-counts", [butter() && e.media,describe(e.counts)].filter(Boolean).join(" · ")));
    const src = el("div", "clip-src ui-row-subtitle");
    if (e.source) src.append(el("span", "clip-source", e.source));
    src.append(el("time", "clip-time", ago(e.time)));
    text.append(top, meta, src);
    const frame = el("div", "clip-frame"); frame.append(thumb, el("span", "clip-kind clip-kind-" + e.kind, kindName(e.kind)));
    r.append(frame, text);
    if (o.actions) {
      const acts = el("div", "clip-actions");
      if (butter()) {
        const paste=el("button","ui-button clip-paste","Paste");paste.type="button";paste.dataset.size="sm";paste.onclick=ev=>{ev.stopPropagation();recopy(e.id,{paste:true});};acts.append(paste);
      }
      const p = iconButton("clip-pin", e.pinned ? "Unpin (P)" : "Pin (P)", ICON.pin, () => doPin(e.id));
      p.setAttribute("aria-pressed", String(e.pinned));
      acts.append(p, iconButton("clip-rename", "Rename (F2)", ICON.rename, () => startRename(e.id)), iconButton("clip-delete ui-dismiss-glyph ui-dismiss-glyph-small", "Delete (Delete)", null, () => doRemove(e.id)));
      (butter() ? text : frame).append(acts);
    }
    r.title = (o.title || "") + (d && d.kind !== e.kind ? " · " + kindName(e.kind) + " objects: paste them into a " + (e.kind === "pcb" ? "PCB layout" : "schematic") : "");
    r.draggable = true;
    r.addEventListener("dragstart", ev => {
      try { ev.dataTransfer.setData(DRAG, e.id); ev.dataTransfer.effectAllowed = "copy"; } catch {}
      dragging = e.id;
    });
    r.addEventListener("dragend", () => { dragging = null; });
    o.observe?.(thumb, e);
    return r;
  }
  let dragging = null;

  // ------------------------------------------------------------------ panel
  let panel = null, ui = null, selected = null;
  function build() {
    if (panel) return true;
    const nav = doc?.getElementById?.("properties");
    if (!nav) return false;
    panel = el("section", "panel ui-dock-panel"); panel.dataset.dock = "clipboard"; panel.setAttribute("aria-labelledby", "clip-heading"); panel.hidden = true;
    const head = el("header", "pane-heading"), h2 = el("h2", null, "Clipboard"); h2.id = "clip-heading";
    const count = el("span", "ui-dock-count");
    const clearBtn = el("button", "clip-clear ui-button", "Clear"); clearBtn.type = "button"; clearBtn.dataset.size = "sm"; clearBtn.title = "Clear the history (pinned clips stay)";
    clearBtn.onclick = () => { const n = entries.filter(e => !e.pinned).length; clear(false); say(n ? "Cleared " + n + (n === 1 ? " clip" : " clips") + " from the clipboard history; pinned clips stay." : "Nothing to clear; pinned clips stay."); };
    const close = el("button", "ui-close ui-dock-close", "×"); close.type = "button"; close.title = "Close Clipboard"; close.setAttribute("aria-label", "Close Clipboard");
    close.onclick = () => toggle(false);
    head.append(h2, count, clearBtn, close);
    const listBox = el("div", "ui-list ui-dock-list pane-scroll"); listBox.dataset.layout = "flush"; listBox.dataset.selectOnFocus = ""; listBox.setAttribute("role", "listbox"); listBox.setAttribute("aria-label", "Clipboard history"); listBox.tabIndex = 0;
    const empty = emptyState();
    const note = el("p", "clip-note"); note.hidden = true;
    const foot = el("p", "ui-dock-foot", "Click copies · Enter or double-click pastes · drag to the canvas");
    const search=searchBar(paint); panel.append(head, search.bar, listBox, empty, note, foot);
    nav.append(panel);
    ui = {count, list: listBox, empty, note, clear: clearBtn,search,watch:globalThis.AtriumHistoryArtwork?.watch(listBox)};
    bindList(listBox, {panel: true});
    return true;
  }
  // Search applies to the panel and to the keyboard picker.
  function searchBar(onChange) {
    // The library search field (AtriumUIKit adopts it: clear button, Escape, match count) and a soft-fill Pinned toggle.
    const bar=el("div","clip-search"),input=el("input","ui-field"),pins=el("button","ui-button clip-filter","Pinned");
    input.type="search";input.placeholder="Search clipboard";input.setAttribute("aria-label","Search clipboard");
    const field=AtriumUI.searchField(input);
    pins.type="button";pins.dataset.size="sm";pins.setAttribute("aria-pressed","false");
    input.oninput=onChange;pins.onclick=()=>{pins.setAttribute("aria-pressed",String(pins.getAttribute("aria-pressed")!=="true"));onChange();};
    bar.append(field,pins);
    return {bar,items:()=> {
      const enabled=butter();
      bar.hidden=!enabled;
      bar.parentElement?.toggleAttribute("data-butter-visual-history",enabled);
      if(!enabled)return entries;
      const pinned=pins.getAttribute("aria-pressed")==="true",found=filter(input.value,pinned);
      input.parentElement?.setCount?.(input.value||pinned ? found.length : null);
      return found;
    }};
  }
  function paintRows(surface,visible,options) {
    const cache=surface.rows ||= new Map(),shown=new Set(visible.map(e=>e.id));
    for (const [id,prev] of cache) if(!shown.has(id)){
      surface.watch?.forget(prev.node.querySelector(".clip-thumb"));prev.node.remove();cache.delete(id);
    }
    let anchor=null;
    for (let i=visible.length-1;i>=0;i--) {
      const e=visible[i],stamp=JSON.stringify([nameOf(e),e.time,e.pinned,currentId===e.id,host?.doc?.()?.kind,e.artRevision||0,thumbKey(),butter()]);
      let saved=cache.get(e.id);
      if (!saved || saved.stamp!==stamp) {
        if(saved){surface.watch?.forget(saved.node.querySelector(".clip-thumb"));saved.node.remove();}
        const node=row(e,{...options,observe:(target,clip)=>want(clip,target,surface.watch)});
        saved={stamp,node};cache.set(e.id,saved);
      }
      const node=saved.node,selected=String(options.selected===e.id);
      if(node.getAttribute("aria-selected")!==selected)node.setAttribute("aria-selected",selected);
      if(node.parentNode!==surface.list||node.nextSibling!==anchor)surface.list.insertBefore(node,anchor);
      anchor=node;
    }
  }
  function paint() {
    if (panel && !panel.hidden && ui) {
      const keepFocus = ui.list.contains(doc.activeElement) || doc.activeElement === ui.list;
      const visible=ui.search.items();
      if (!visible.some(e=>e.id===selected)) selected=visible[0]?.id||null;
      paintRows(ui,visible,{prefix:"clip-opt-",selected,actions:true,title:"Click to copy; Enter or Paste to place"});
      ui.list.setAttribute("aria-activedescendant", selected ? "clip-opt-" + selected : "");
      paintEmpty(ui.empty,visible);ui.list.hidden = !visible.length;
      const pinned = entries.filter(e => e.pinned).length;
      ui.count.textContent = entries.length ? entries.length + (pinned ? " · " + pinned + " pinned" : "") : "";
      ui.clear.disabled = !entries.some(e => !e.pinned);
      ui.note.textContent = notice; ui.note.hidden = !notice;
      if (keepFocus && doc.activeElement !== ui.list && !renaming) ui.list.focus({preventScroll: true});

    }
    if (picker?.open) paintPicker();
  }
  function toggle(show, focusList = true) {
    if (!panel && !build()) return false;
    const onNow = show ?? panel.hidden;
    panel.hidden = !onNow;
    if (onNow && !globalThis.AtriumDock) doc.body.classList.remove("hide-right");
    globalThis.AtriumNavCommon?.setChecked("clipboard-panel", onNow);
    if (onNow) {
      paint(); if (focusList) ui.list.focus({preventScroll: true});
    } else {ui.watch?.reset();ui.rows?.clear();ui.list.replaceChildren();host?.canvas?.()?.focus?.();}
    return onNow;
  }
  // Shared list keyboard: arrows, Home/End, Enter (paste), Space (copy again), Delete, P (pin), F2 (rename).
  function bindList(listBox, o) {
    const ids = () => [...listBox.querySelectorAll(".clip-item")].map(n => n.dataset.id);
    const sel = () => o.panel ? selected : pickSel;
    const setSel = id => { if (o.panel) selected = id; else pickSel = id; for (const n of listBox.querySelectorAll(".clip-item")) n.setAttribute("aria-selected", String(n.dataset.id === id));
      listBox.setAttribute("aria-activedescendant", id ? listBox.querySelector(".clip-item[data-id=\"" + CSS.escape(id) + "\"]")?.id || "" : "");
      listBox.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block: "nearest"}); };
    listBox.addEventListener("keydown", ev => {
      if (renaming || ev.target !== listBox) return;
      const all = ids(), i = all.indexOf(sel());
      const go = id => { ev.preventDefault(); ev.stopPropagation(); setSel(id); };
      const k = ev.key;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (k === "ArrowDown") return go(all[Math.min(all.length - 1, i + 1)] ?? all[0]);
      if (k === "ArrowUp") return go(all[Math.max(0, i - 1)] ?? all[0]);
      if (k === "Home") return go(all[0]);
      if (k === "End") return go(all.at(-1));
      const id = sel();
      if (!id) return;
      const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
      if (k === "Enter") { stop(); if (!o.panel) closePicker(); recopy(id, {paste: true}); }
      else if (k === " ") { stop(); if (!o.panel) closePicker(); recopy(id); }
      else if (k === "Delete" || k === "Backspace") { stop(); const next = all[i + 1] ?? all[i - 1] ?? null; doRemove(id); setSel(next); }
      else if (k === "p" || k === "P") { stop(); doPin(id); }
      else if (k === "F2" && o.panel) { stop(); startRename(id); }
      else if (k === "Escape" && o.panel) { stop(); host?.canvas?.()?.focus?.(); }
    });
    listBox.addEventListener("click", ev => {
      const r = ev.target.closest(".clip-item"); if (!r || renaming) return;
      setSel(r.dataset.id);
      if (!o.panel) { closePicker(); recopy(r.dataset.id, {paste: true}); return; }
      listBox.focus({preventScroll: true});
      // A double-click pastes; its first click still copies, which is what the paste needs.
      recopy(r.dataset.id);
    });
    if (o.panel) listBox.addEventListener("dblclick", ev => { const r = ev.target.closest(".clip-item"); if (r && !renaming) recopy(r.dataset.id, {paste: true}); });
  }
  function doPin(id) {
    const e = pin(id); if (!e) return;
    say(e.pinned ? "Pinned “" + e.name + "”: it stays in the history and after restarts." : "Unpinned “" + e.name + "”.");
  }
  function doRemove(id) {
    const e = find(id); if (!e) return;
    const name = quote(e); remove(id);
    say("Deleted " + name + " from the clipboard history.");
  }
  let renaming = null;
  function startRename(id) {
    const e = find(id), r = ui?.list.querySelector(".clip-item[data-id=\"" + CSS.escape(id) + "\"]");
    if (!e || !r) return;
    selected = id; renaming = id;
    const nameNode = r.querySelector(".clip-name"), input = el("input", "clip-rename-input");
    input.type = "text"; input.value = nameOf(e); input.maxLength = 80; input.setAttribute("aria-label", "Clip name"); input.autocomplete = "off";
    nameNode.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = commit => {
      if (done) return; done = true; renaming = null;
      if (commit) { rename(id, input.value); say("Renamed the clip to " + quote(find(id) || e) + "."); } else paint();
      ui.list.focus({preventScroll: true});
    };
    input.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); finish(true); } else if (ev.key === "Escape") { ev.preventDefault(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", ev => ev.stopPropagation());
    input.addEventListener("dblclick", ev => ev.stopPropagation());
  }

  // ------------------------------------------------------------------ picker (Mod+Alt+V)
  let picker = null, pickUi = null, pickSel = null, pointerAt = null;
  function openPicker() {
    if (!hasDOM()) return false;
    closePicker();
    picker = el("dialog", "clip-picker"); picker.setAttribute("aria-label", "Clipboard history");
    const head = el("header", "clip-picker-head"), title = el("h2", null, "Clipboard history");
    head.append(title, AtriumShortcut.render(binding("clipboard-picker"), {variant:"inline", node:el("span", "clip-picker-key")}));
    const listBox = el("div", "ui-list ui-dock-list"); listBox.dataset.layout = "flush"; listBox.dataset.selectOnFocus = ""; listBox.setAttribute("role", "listbox"); listBox.setAttribute("aria-label", "Clipboard history"); listBox.tabIndex = 0;
    const empty = emptyState();
    const foot = el("p", "ui-dock-foot", "Enter pastes · Space copies · P pins · Esc closes");
    const more = el("button", "clip-open-panel ui-button", "Open Clipboard panel"); more.type = "button"; more.dataset.size = "sm";
    more.onclick = () => { closePicker(); toggle(true); };
    const bar = el("div", "clip-picker-foot"); bar.append(foot, more);
    const search=searchBar(paintPicker);
    picker.append(head, search.bar, listBox, empty, bar);
    AtriumShell.adoptDialog(picker, {title, body:[search.bar, listBox, empty], actions:bar});
    doc.body.append(picker);
    pickUi = {list: listBox, empty,search,watch:globalThis.AtriumHistoryArtwork?.watch(listBox)};
    bindList(listBox, {panel: false});
    const opened = picker;
    const watch = pickUi.watch;
    picker.addEventListener("close", () => {
      watch?.close();
      opened.remove();
      if (picker === opened) { picker = null; pickUi = null; }
    });
    picker.addEventListener("click", ev => { if (ev.target === picker) closePicker(); });
    pickSel = currentId && find(currentId) ? currentId : entries[0]?.id || null;
    picker.showModal();
    paintPicker();
    place();
    listBox.focus({preventScroll: true});
    return true;
  }
  function place() {
    const r = picker.getBoundingClientRect(), W = globalThis.innerWidth || 1024, H = globalThis.innerHeight || 768;
    let at = pointerAt;
    if (!at) { const c = host?.canvas?.()?.getBoundingClientRect?.(); at = c ? [c.left + c.width / 2 - r.width / 2, c.top + c.height / 3] : [W / 2 - r.width / 2, H / 3]; }
    const x = Math.max(8, Math.min(W - r.width - 8, at[0])), y = Math.max(8 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), Math.min(H - r.height - 8, at[1])); // below the title bar
    picker.style.left = Math.round(x) + "px"; picker.style.top = Math.round(y) + "px";
  }
  function paintPicker() {
    if (!pickUi) return;
    const visible=pickUi.search.items();if(!visible.some(e=>e.id===pickSel))pickSel=visible[0]?.id||null;
    paintRows(pickUi,visible,{prefix:"clip-pick-",selected:pickSel,actions:false,title:"Click or Enter to paste"});
    pickUi.list.setAttribute("aria-activedescendant", pickSel ? "clip-pick-" + pickSel : "");
    paintEmpty(pickUi.empty,visible);pickUi.list.hidden = !visible.length;
    pickUi.list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block: "nearest"});
  }
  function closePicker() { if (picker?.open) picker.close(); else { picker?.remove(); picker = null; pickUi = null; } }

  // ------------------------------------------------------------------ preferences page
  function prefsPage(P) {
    P.on?.("butter.visualHistory", paint);
    P.registerPage({id: "clipboard", title: "Clipboard", order: 7, keywords: "clipboard history copy paste pin recent", render(c, api) {
      const g = api.group(c, "Clipboard history");
      const n = api.el("div", "prf-row"); n.dataset.search = "history size clipboard entries recent copies";
      const l = api.el("label", "prf-label", "Recent copies to keep"); l.htmlFor = "prf-clip-size";
      const input = api.el("input", "ui-field"); input.type = "number"; input.id = "prf-clip-size"; input.min = String(SIZE.min); input.max = String(SIZE.max); input.step = "1"; input.value = String(limit());
      input.onchange = () => { const v = Math.min(SIZE.max, Math.max(SIZE.min, Math.round(+input.value) || SIZE.initial)); P.set(PREF_SIZE, v); input.value = String(v); };
      const ctl = api.el("span", "prf-control"); ctl.append(input);
      const help = api.el("small", "prf-help", "Pinned clips do not count toward this limit. Default " + SIZE.initial + ".");
      help.id = "prf-clip-size-help"; input.setAttribute("aria-describedby", help.id);
      n.append(l, ctl, help); g.append(n);
      const k = api.el("div", "prf-row prf-check"); k.dataset.search = "keep history restart persist clipboard";
      const box = api.el("input", "ui-checkbox"); box.type = "checkbox"; box.id = "prf-clip-keep"; box.checked = keep();
      box.onchange = () => P.set(PREF_KEEP, box.checked);
      const kl = api.el("label", "ui-checkbox-row"); kl.htmlFor = box.id; kl.append(box, api.el("span", null, "Keep the clipboard history after restarting Waffle"));
      const detail = api.el("small", "prf-help", "Store this history on your computer, outside the project.");
      detail.id = box.id + "-help"; box.setAttribute("aria-describedby", detail.id); k.append(kl, detail);
      g.append(k);
      const b = api.el("div", "prf-row prf-link"); b.dataset.search = "clear clipboard history";
      b.append(api.button("Clear clipboard history", () => { clear(false); say("Clipboard history cleared; pinned clips stay."); }, "prf-button"));
      g.append(b);
    }});
    P.on?.("clipboard.", ({key}) => { if (key === PREF_SIZE) { trim(); changed(false); } schedule(); });
  }

  // ------------------------------------------------------------------ install
  function attach(h) {
    host = h;
    h.registerAction?.("clipboard-panel", () => toggle());
    h.registerAction?.("clipboard-picker", () => openPicker());
    h.on?.("document", () => {globalThis.AtriumClipboardMedia?.cancelFocusChange();paint();});
    h.on?.("replace",()=>globalThis.AtriumClipboardMedia?.cancel());
  }
  function canvasOf(t) {
    if (!(t instanceof Element) || t.tagName !== "CANVAS" || !host) return null;
    return host.panes?.()?.find?.(p => p.canvas === t)?.canvas || (host.canvas?.() === t ? t : null);
  }
  if (hasDOM() && doc.addEventListener) {
    restore();
    doc.addEventListener("keydown",ev=>{if(ev.key==="Escape")globalThis.AtriumClipboardMedia?.cancel();},{capture:true});
    doc.addEventListener("pointermove", ev => { pointerAt = [ev.clientX, ev.clientY]; }, {passive: true, capture: true});
    doc.addEventListener("dragover", ev => {
      if (!dragging && !ev.dataTransfer?.types?.includes?.(DRAG)) return;
      if (!canvasOf(ev.target)) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = "copy";
    });
    doc.addEventListener("drop", ev => {
      const id = (() => { try { return ev.dataTransfer?.getData(DRAG); } catch { return ""; } })() || dragging;
      const c = canvasOf(ev.target);
      if (!id || !c) return;
      ev.preventDefault(); ev.stopPropagation(); dragging = null;
      dropAt(id, c, ev.clientX, ev.clientY);
    });
    globalThis.addEventListener?.("atrium-theme", staleThumbs);
    globalThis.addEventListener?.("atrium-pcb-appearance", staleThumbs);
    globalThis.addEventListener?.("pagehide", () => { if (saveTimer) save(); });
    globalThis.AtriumNavCommon?.ready(attach);
    if (globalThis.AtriumPrefs?.registerPage) prefsPage(AtriumPrefs);
    else globalThis.AtriumLazy?.need?.("AtriumPrefs").then(prefsPage, () => {});
  }

  // The entry's cached thumbnail bitmap, drawn now if it is missing or stale (probes and tests).
  function thumbnail(id, {preview = false} = {}) {
    const e = find(id); if (!e) return null;
    if (preview) return draw(e,PREVIEW)?.canvas || null;
    if (!e.thumb || e.thumb.key !== thumbKey()) { release(e); e.thumb = draw(e); }
    return e.thumb?.canvas || null;
  }
  return Object.freeze({record, recordText, recordImage, prepareAssets, preparePacket, setMediaSize, imagePreview:async(id,signal)=>{const e=find(id);return e?(await mediaArtwork(e,PREVIEW,signal))?.canvas:null;}, contains:id=>!!find(id), recordSelection, list, read, recopy, pin, rename, saveSnippet, remove, clear, stats, on, describe, save, restore, dropAt, attach, thumbnail,
    dragType:DRAG, dragEntry:id=>find(id)?view(find(id)):null, toggle, picker: openPicker, closePicker, isOpen: () => !!panel && !panel.hidden, current: () => currentId,
    limits: Object.freeze({...SIZE, budget: BUDGET, entryMax: ENTRY_MAX, saveEntry: SAVE_ENTRY, saveTotal: SAVE_TOTAL, thumb: THUMB}), STORE});
})();
