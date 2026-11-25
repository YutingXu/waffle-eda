"use strict";
// Local mappings for KiCad's portable STEP references. Directory grants and cached model text
// stay on this device; neither the chosen path nor its grant is written into a project.
globalThis.AtriumKiCadModels = (() => {
  const KEY = "atrium.kicad-model-folders.v1", VARIABLE = /^KICAD[0-9]*_3DMODEL_DIR$/, DEFAULT = "*", MAX_BYTES = 32 << 20;
  const local = () => {
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || "{}");
      return Object.fromEntries(Object.entries(saved || {}).filter(([key, folder]) =>
        (key === DEFAULT || VARIABLE.test(key)) && folder?.name && (folder.kind === "native" || folder.kind === "directory")));
    } catch { return {}; }
  };
  const mappings = local(), results = new Map(), pending = new Map();
  let generation = 0;
  function resolve(file) {
    const m = /^\$\{(KICAD[0-9]*_3DMODEL_DIR)\}\/(.{1,2048})$/i.exec(String(file || "").replace(/\\/g, "/"));
    if (!m || !/\.(step|stp)$/i.test(m[2]) || /[\x00-\x1f:$]/.test(m[2]) || m[2].split("/").some(p => !p || p.startsWith("."))) return null;
    return {variable: m[1].toUpperCase(), path: m[2]};
  }
  const supported = () => !!(globalThis.AtriumHost?.chooseLibraryFolder || globalThis.showDirectoryPicker);
  async function db() {
    if (!globalThis.AtriumLibrarySources) await globalThis.AtriumLazy?.need("AtriumLibrarySourcesUI");
    return globalThis.AtriumLibrarySources?.db;
  }
  function changed() {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(mappings));
    generation++;
    results.clear(); pending.clear();
    if (globalThis.CustomEvent) globalThis.dispatchEvent?.(new CustomEvent("atrium-kicad-models-change"));
  }
  async function choose(variable = DEFAULT) {
    if (variable !== DEFAULT && !VARIABLE.test(variable)) throw Error("Enter a KiCad 3D model variable such as KICAD10_3DMODEL_DIR.");
    const native = globalThis.AtriumHost;
    let picked;
    if (native?.chooseLibraryFolder) {
      const folder = await native.chooseLibraryFolder("models");
      if (!folder) return false;
      picked = {name: folder.name, grant: folder.grant, kind: "native"};
    } else {
      const handle = await showDirectoryPicker({id: "atrium-kicad-models", mode: "read"});
      if (!await (await db())?.set("handles", KEY + variable, handle)) throw Error("The model folder could not be remembered.");
      picked = {name: handle.name, kind: "directory"};
    }
    const previous = mappings[variable];
    mappings[variable] = picked; changed();
    await forgetUnused(previous);
    return true;
  }
  async function forgetUnused(removed) {
    if (removed?.grant && !Object.values(mappings).some(f => f.grant === removed.grant)) {
      await globalThis.AtriumHost?.forgetLibraryFolder?.(removed.grant);
    }
  }
  async function remove(variable) {
    const removed = mappings[variable];
    delete mappings[variable]; changed();
    if (removed?.kind === "directory") await (await db())?.del("handles", KEY + variable);
    await forgetUnused(removed);
  }
  async function read(file) {
    const ref = resolve(file);
    if (!ref) return null;
    const key = mappings[ref.variable] ? ref.variable : DEFAULT, root = mappings[key];
    if (!root) return null;
    let bytes;
    if (root.kind === "native") {
      const [result] = await globalThis.AtriumHost.libraryFolderRead(root.grant, [ref.path]);
      if (!result?.data) return null;
      bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    } else {
      let handle = await (await db())?.get("handles", KEY + key);
      if (!handle) return null;
      const p = ref.path.split("/"), name = p.pop();
      for (const part of p) handle = await handle.getDirectoryHandle(part);
      const selected = await (await handle.getFileHandle(name)).getFile();
      if (selected.size > MAX_BYTES) return null;
      bytes = await selected.arrayBuffer();
    }
    if (bytes.byteLength > MAX_BYTES) return null;
    const text = new TextDecoder("utf-8").decode(bytes);
    return /^\s*ISO-10303-21;/i.test(text) ? text : null;
  }
  function load(file) {
    if (results.has(file)) return Promise.resolve(results.get(file));
    if (!pending.has(file)) {
      const at = generation;
      const job = read(file).catch(() => null).then(text => {
        if (generation !== at) return null;
        pending.delete(file);
        results.set(file, text);
        return text;
      });
      pending.set(file, job);
    }
    return pending.get(file);
  }
  return Object.freeze({resolve, supported, choose, remove, load, cached: file => results.get(file), list: () => Object.entries(mappings)});
})();
