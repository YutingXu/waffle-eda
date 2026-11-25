"use strict";
// File › Import › Altium Project / Document… (action "import-altium"). Lazy: app/lazy.js loads
// this file on the first use of the action, and the editor's lazy gate runs the action once it
// has registered.
//
// It opens a file chooser limited to Altium Designer® files (.PrjPcb, .SchDoc, .PcbDoc, .SchLib,
// .PcbLib; binary or ASCII) and hands the chosen files to the same import path as File › Open
// (editor importFiles → AtriumIO / the import worker → import report). Native open resolves a
// project's referenced documents. Browsers can request the containing folder.
//
// In the native hosts the system open panel already lists every supported format (AtriumHost.open),
// so the action shows it with a hint; in a browser it uses its own <input type=file> with an
// Altium-only accept list, so the panel opens in the right place for an Altium user.
globalThis.AtriumAltiumBridge = (() => {
  const registry = globalThis.AtriumTranslatorRegistry;
  const descriptor = registry.get("altium");
  const EXTENSIONS = [...descriptor.extensions, ...(descriptor.companions || []).flatMap(id => registry.get(id).extensions)];
  const isAltium = name => registry.forName(name)?.id === descriptor.id;
  const HINT = "Choose the .PrjPcb to open its project, or choose individual Altium documents.";
  let host = null;

  // Files the user picked → only the Altium ones; the others are named in the status line.
  function split(files) {
    const all = Array.from(files || []), board = all.some(f => /\.(pcbdoc|pcblib|prjpcb)$/i.test(f.name)), keep = all.filter(f => isAltium(f.name) || board && descriptor.companions?.includes(registry.forName(f.name)?.id)), skipped = all.filter(f => !keep.includes(f)).map(f => f.name);
    return {keep, skipped};
  }
  function hand(files) {
    const {keep, skipped} = split(files);
    if (!keep.length) { if (skipped.length) host?.info?.("Not an Altium file: " + skipped.slice(0, 3).join(", ") + ". Use File › Open… for other formats."); return; }
    if (skipped.length) host?.info?.("Skipped " + skipped.length + " non-Altium file" + (skipped.length === 1 ? "" : "s") + ".");
    host?.openFiles?.(keep);
  }
  function choose() {
    if (globalThis.AtriumHost?.open) {
      host?.info?.(HINT);
      AtriumHost.open(EXTENSIONS).then(hand, e => host?.info?.(e.message));
      return;
    }
    const doc = globalThis.document;
    if (!doc?.createElement) { host?.info?.("Altium import needs a file chooser. From MCP, use import_design."); return; }
    const input = doc.createElement("input");
    input.type = "file"; input.multiple = true; input.accept = EXTENSIONS.join(","); input.hidden = true;
    input.setAttribute("aria-label", "Altium project or documents");
    const done = () => input.remove();
    input.addEventListener("change", () => { const f = Array.from(input.files || []); done(); hand(f); }, {once: true});
    input.addEventListener("cancel", done, {once: true});
    doc.body.append(input);
    host?.info?.(HINT);
    input.click();
  }
  function attach(h) {
    host = h;
    h.registerAction("import-altium", choose);
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({EXTENSIONS, isAltium, split, choose, attach});
})();
