"use strict";
// One drop-target policy for butter.drop.
// While something is dragged over the window, the canvas pane under the pointer is a library drop
// target (.ui-drop-target, data-drop ready, over, denied or busy) and one status-bar line says what the
// drop will do or why it cannot. After the drop the same line follows the receiver: waiting for
// approval, reading, preparing, applying, then complete, cancelled or stale. Large files and edits that
// change shared definitions ask first in a compact dialog that shows only the file metadata.
// Settled drop faces keep their look: the document tab strip, the split zones and the dock.
// Lazy: drop-editor.js loads it when butter.drop is on.
globalThis.AtriumDropUI = (() => {
  const G = globalThis, L = G.AtriumLazy, MiB = 1024 * 1024;
  const WAFFLE = "application/x-waffle-drop", CLIP = "application/x-atrium-clip", LIBRARY = "application/x-atrium-def";
  const CONSENT_BYTES = 16 * MiB, SHOW_AFTER = 300, LINGER = 4000;
  let installed = false, K = null, item = null, lit = null, dropped = null, transfer = null, mixed = null;
  const enabled = () => G.AtriumPrefs?.get("butter.drop") === true;
  const host = () => G.AtriumNavHost;
  const size = bytes => bytes == null ? "" : bytes >= MiB ? (bytes / MiB).toFixed(bytes >= 100 * MiB ? 0 : 1) + " MB"
    : bytes >= 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " bytes";
  const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);

  // ------------------------------------------------------------------ status bar line
  // One .ui-status-line after the window status. It exists only while a drag or transfer is live.
  function line() {
    if (item?.isConnected) return item;
    const status = document.getElementById("status");
    if (!status) return null;
    item = document.createElement("span");
    item.className = "ui-status-line drop-status";
    item.setAttribute("role", "status");
    item.setAttribute("aria-live", "polite");
    status.after(item);
    return item;
  }
  function say(text, {tone, busy, progress, cancel} = {}) {
    const n = line();
    if (!n) return;
    clearTimeout(n.linger);
    if (!text) { n.remove(); item = null; return; }
    n.replaceChildren();
    if (tone) n.dataset.tone = tone; else delete n.dataset.tone;
    if (tone && !busy) n.append(K?.dot(tone) ?? "");
    if (busy && K) n.append(K.spinner({size:"sm", label:text}));
    const label = document.createElement("span");
    label.className = "ui-status-text";
    label.textContent = text;
    n.append(label);
    if (progress && K) {
      const bar = document.createElement("span");
      bar.className = "ui-progress";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", text);
      bar.dataset.indeterminate = "";
      n.append(bar);
    }
    if (cancel && K) {
      const b = K.button("Cancel", {variant:"quiet", size:"sm", run:cancel});
      b.dataset.tooltip = "Cancel";
      b.dataset.tooltipShortcut = "Escape";
      n.append(b);
    }
    n.title = text;
  }
  const fade = () => { const n = item; if (n) n.linger = setTimeout(() => { if (n === item) say(""); }, LINGER); };

  // ------------------------------------------------------------------ while dragging
  function offerOf(dt) {
    const types = [...(dt?.types ?? [])];
    if (types.includes(WAFFLE)) return {ref:true, count:1};
    if (types.includes(CLIP)) return {clip:true, count:1};
    if (types.includes(LIBRARY)) return null; // the Library panel's own placement drop
    if (!types.includes("Files")) return null;
    const mimes = [...(dt.items ?? [])].filter(i => i.kind === "file").map(i => (i.type || "").toLowerCase());
    return {files:true, count:mimes.length || 1, mimes};
  }
  const fileKind = mime => mime === "text/csv" ? "csv" : mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image"
    : mime === "model/step" ? "step" : "other";

  // What a drop here would do: {state, text}. Ready says the window takes it; over names the exact target.
  function preview(offer, event) {
    const H = host(), doc = H?.doc(), canvas = H?.canvas();
    const onCanvas = event.target === canvas || event.target?.closest?.("#editor-panes .split-pane");
    const hit = event.target === canvas ? H.hit(canvas, event.clientX, event.clientY) : null, item = hit?.item;
    const kind = doc?.kind, name = target => target?.ref || target?.name || target?.widget?.title || "the table";
    if (offer.ref) {
      if (!onCanvas) return {state:"ready", text:"Drop on a schematic or board to place it"};
      return ["schematic", "pcb"].includes(kind) ? {state:"over", text:"Drop to place the part on " + doc.name}
        : {state:"denied", text:"Parts go on schematics and boards"};
    }
    if (offer.clip) return onCanvas ? {state:"over", text:"Drop to paste here"} : {state:"ready", text:"Drop on the canvas to paste"};
    if (offer.count > 1) return {state:onCanvas ? "over" : "ready", text:"Drop to open " + plural(offer.count, "file")};
    const k = fileKind(offer.mimes[0] ?? "");
    if (!onCanvas) return {state:"ready", text:k === "other" ? "Drop to open the file" : "Drop on the canvas to use the file"};
    const notebook = G.AtriumLabs?.notebookEnabled?.() !== false, datasheets = G.AtriumPrefs?.get("butter.datasheets") === true;
    if (k === "csv") return kind === "schematic" && item?.widget?.type === "table" ? {state:"over", text:"Drop to add rows to " + name(item)}
      : {state:"denied", text:"CSV files go into a schematic table"};
    if (k === "pdf") return kind === "schematic" && (datasheets || notebook)
      ? {state:"over", text:datasheets ? "Drop to reference the datasheet" : "Drop to add the PDF to the sheet"}
      : {state:"denied", text:"PDFs go on schematic sheets"};
    if (k === "image") return kind === "schematic" && notebook ? {state:"over", text:"Drop to add the image to the sheet"}
      : {state:"denied", text:"Images go on schematic sheets"};
    if (kind === "pcb" && item?.kind === "part") return {state:"over", text:"Drop a STEP model to attach it to " + name(item)};
    return {state:"over", text:"Drop to open designs and libraries, or a library part to place it"};
  }

  function light(stage, state) {
    if (lit && lit !== stage) K?.dropState(lit, null);
    lit = stage;
    if (stage && K) K.dropState(stage, state);
  }
  function clearDrag() {
    light(null);
    if (!transfer) say("");
  }

  function install() {
    if (installed) return;
    installed = true;
    L.need("AtriumUIKit").then(kit => { K = kit; }, () => {});
    let offer = null;
    document.addEventListener("dragenter", event => {
      if (!enabled() || transfer?.busy) return;
      offer = offerOf(event.dataTransfer);
    }, true);
    document.addEventListener("dragover", event => {
      if (!enabled() || transfer?.busy) return;
      offer ??= offerOf(event.dataTransfer);
      if (!offer) return;
      const p = preview(offer, event), stage = event.target?.closest?.("#editor-panes .split-pane") ?? null;
      light(stage, stage ? p.state : null);
      if (p.state === "denied") { event.preventDefault(); event.dataTransfer.dropEffect = "none"; }
      say(p.text, {tone:p.state === "denied" ? "warning" : null});
    }, true);
    // relatedTarget is often null between elements during a native drag: only the window edge ends it.
    document.addEventListener("dragleave", event => {
      if (!offer) return;
      const {clientX:x, clientY:y} = event;
      if (x <= 0 || y <= 0 || x >= G.innerWidth || y >= G.innerHeight) { offer = null; clearDrag(); }
    }, true);
    document.addEventListener("drop", () => { offer = null; dropped = lit; light(null); }, true);
    document.addEventListener("dragend", () => { offer = null; clearDrag(); }, true);
  }

  // ------------------------------------------------------------------ after the drop
  const VERBS = {"open-design":["Open", "Opened"], "insert-image":["Add", "Added"], "insert-pdf":["Add", "Added"],
    "place-library":["Place", "Placed"], "attach-model":["Attach", "Attached"], "import-table":["Import", "Imported"],
    "scope-rule":["Apply", "Applied"], "bind-calculation":["Bind", "Bound"], "resolve-result":["Show", "Showing"],
    "paste-entry":["Paste", "Pasted"], "transfer-tab":["Move", "Moved"]};
  const subject = p => p.files?.length ? (p.files.length === 1 ? p.files[0].name : plural(p.files.length, "file")) : "the item";
  function targetName(p) {
    const t = p.target, doc = host()?.doc(), found = t.id && doc?.items.find(i => i.id === t.id);
    if (t.kind === "part") return found?.ref || "the part";
    if (t.kind === "table") return found?.widget?.title || "the table";
    return doc?.name || "the document";
  }
  // A drop asks first when it reads a large file or changes a definition other placements share.
  function needsConsent(p) {
    const bytes = (p.files ?? []).reduce((sum, f) => sum + (f.size ?? 0), 0);
    return bytes >= CONSENT_BYTES || p.route === "attach-model";
  }
  async function consent(p, signal) {
    if (!K) K = await L.need("AtriumUIKit");
    const [verb] = VERBS[p.route] ?? ["Continue"], file = p.files?.[0];
    const doc = host()?.doc(), part = p.target.id && doc?.items.find(i => i.id === p.target.id);
    const shared = part && doc.items.filter(i => i.def === part.def).length;
    const body = (p.files ?? []).map(f => K.propRow(p.files.length > 1 ? "" : "File", [f.name, f.kind.toUpperCase(), size(f.size)].filter(Boolean).join(" · ")));
    body.push(K.propRow("Destination", targetName(p) + (shared > 1 ? " · footprint shared by " + plural(shared, "part") : "")));
    body.push(K.statusLine("Waffle reads the file after you choose " + verb + "."));
    const dialog = G.AtriumShell.dialog({title:verb + " " + (file ? file.kind === "step" ? "STEP model" : "file" : "item") + "?",
      label:"Approve drop", className:"drop-consent", body,
      actions:[{label:"Cancel"}, {label:verb, primary:true, default:true, focus:true}]});
    const abort = () => dialog.close();
    signal?.addEventListener("abort", abort, {once:true});
    dialog.showModal();
    const answer = await dialog.done;
    signal?.removeEventListener("abort", abort);
    return answer === verb;
  }

  // drop-editor.js hands each receiver ticket here. Returns the approval callback for receiver.apply.
  function track({receiver, ticket, cancel}) {
    let p;
    try { p = receiver.inspect(ticket); } catch { return () => true; }
    const me = transfer = {busy:true, started:performance.now(), route:p.route};
    const stage = dropped ?? document.querySelector("#editor-panes .split-pane.is-active, #editor-panes .split-pane");
    const label = state => ({"awaiting-consent":"Waiting for approval", reading:"Reading", preparing:"Preparing", applying:"Applying"})[state];
    const paint = () => {
      if (transfer !== me) return;
      let state;
      try { state = receiver.inspect(ticket).state; } catch { return; }
      if (!label(state)) return;
      if (stage && K && p.route !== "open-design") K.dropState(stage, "busy");
      if (state === "awaiting-consent") return say("Waiting for approval · " + subject(p), {busy:true});
      if (performance.now() - me.started < SHOW_AFTER) return;
      const detail = p.files?.length === 1 && p.files[0].size ? " · " + size(p.files[0].size) : "";
      say(label(state) + " " + subject(p) + detail + "…", {busy:state !== "reading", progress:state === "reading", cancel});
    };
    me.timer = setInterval(paint, 60);
    me.stage = stage;
    me.preview = p;
    return (preview, signal) => needsConsent(preview) ? consent(preview, signal) : true;
  }

  function settle(outcome, error) {
    const me = transfer;
    if (!me) return;
    clearInterval(me.timer);
    transfer = null;
    if (me.stage && K) K.dropState(me.stage, null);
    light(null);
    const p = me.preview, [, done] = VERBS[p.route] ?? ["", "Done"], offer = mixed;
    mixed = null;
    const cancelled = error?.name === "AbortError" || ["cancelled", "consent_required"].includes(error?.code) || !error && outcome === false;
    if (offer) return counts({...offer, accepted:cancelled || error ? 0 : offer.accepted, cancelled:cancelled ? offer.accepted : 0,
      failed:error && !cancelled ? error.message : null});
    if (error) {
      if (error.name === "AbortError" || ["cancelled", "consent_required"].includes(error.code)) say("Drop cancelled", {tone:"info"});
      else if (["stale_source", "stale_target"].includes(error.code)) say("The document changed during the drop. Drop again.", {tone:"warning"});
      else say(error.message, {tone:"danger"});
    } else if (outcome === false) say("Drop cancelled", {tone:"info"});
    else {
      const into = {"import-table":" into ", "attach-model":" to ", "place-library":" on ", "insert-image":" to ", "insert-pdf":" to "}[p.route];
      say(done + " " + subject(p) + (into ? into + targetName(p) : ""), {tone:"success"});
    }
    fade();
  }

  // A multi-file drop where only some items are usable: report the original counts.
  // drop-editor.js calls it before the transfer starts; settle() repeats it with the final counts.
  function summary(offer) {
    mixed = offer;
    counts(offer);
  }
  function counts({total, accepted, unsupported = [], cancelled = 0, failed = null}) {
    const parts = [accepted + " of " + plural(total, "file") + " accepted"];
    if (unsupported.length) parts.push(unsupported.length + " not supported (" + unsupported.slice(0, 2).join(", ") + (unsupported.length > 2 ? "…" : "") + ")");
    if (cancelled) parts.push(cancelled + " cancelled");
    if (failed) parts.push(failed);
    say(parts.join(" · "), {tone:accepted ? "warning" : "danger"});
    fade();
  }

  return Object.freeze({install, track, settle, summary, preview, consent, say});
})();
