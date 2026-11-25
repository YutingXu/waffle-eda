"use strict";
// Stable object ids for imported Altium designs (sch-import.js, pcb-import.js), so two imports of
// one file give identical ids and two revisions of a design line up by id in the diff engine
// (diff.js), the three-way merge (merge3.js) and Git blame.
//
//   scope(fileName) -> {doc(), durable(kind, uid, role), content(kind, obj, role), def(key), link(uid)}
//     One per imported document. Every id it hands out is unique within the document; a repeat
//     (two records with one Altium id, two identical stacked primitives) takes "-2", "-3"… in
//     record order. Ids hash the document's file name, so documents of one project never share one.
//   durable: "au-…" from an id Altium keeps for the object's life: a schematic record's UniqueID,
//     a PcbDoc component's UNIQUEID, a primitive's 16-byte GUID (PrimitiveGuids) or a pad's UNIQUEID
//     (UniqueIDPrimitiveInformation). The object keeps it when it moves or changes.
//   content: "ac-…" from what the object is (kind, layer, geometry rounded to 0.1 µm, text, owner;
//     never its net or appearance): records Altium gives no id (junctions, primitives of files older
//     than PrimitiveGuids). An unchanged object keeps it across revisions.
//   primitiveGuids(bytes) -> Map("tracks#12" -> hex GUID)   (PrimitiveGuids/Data)
//   padIds(bytes)         -> Map(pad index -> UNIQUEID)      (UniqueIDPrimitiveInformation/Data)
//   isDurable(id)         -> true for an "au-" id as the importer made it (no copy suffix)
//   distinct(results)     -> results, where a document whose ids an earlier one already uses (two
//                            files of one name in different folders) has all its ids re-derived
globalThis.AtriumAltiumIds = (() => {
  // cyrb53: a 53-bit string hash, written in base 36 (11 characters).
  function hash(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
  }
  // What an object is, for a content id: its own fields minus identity, net, source bookkeeping
  // and appearance, numbers rounded to 0.1 µm (import float noise).
  const SKIP = new Set(["id", "net", "pinNets", "link", "sourceRecord", "sourceDrillTool", "schSource", "schPaint", "sourceTextBox", "regionShape", "entries"]);
  const canon = v => JSON.stringify(v, (k, x) => SKIP.has(k) || k === "arc" && x?.kind === "arc" ? undefined : typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x);
  const fileKey = name => String(name || "").replace(/\\/g, "/").split("/").pop().normalize("NFC").toLowerCase();
  function scope(fileName) {
    const key = fileKey(fileName), used = new Set();
    const take = base => { let id = base, n = 1; while (used.has(id)) id = base + "-" + ++n; used.add(id); return id; };
    const durable = (kind, uid, role = "") => take("au-" + hash(key + "\u0001" + kind + "\u0001" + uid + "\u0001" + role));
    const content = (kind, obj, role = "") => take("ac-" + hash(key + "\u0002" + kind + "\u0002" + canon(obj) + "\u0002" + role));
    return {
      doc: () => take("ac-" + hash(key + "\u0003document")),
      durable, content,
      // A schematic record's item: its UniqueID, else what it is.
      record: (r, role, obj) => r?.UNIQUEID ? durable("sch", r.UNIQUEID, role) : content(role, obj),
      def: k => take("ac-" + hash(key + "\u0004" + k)),
      link: uid => "au-" + hash(key + "\u0005" + uid)
    };
  }
  // PrimitiveGuids/Data: 24-byte entries, u32 object code, u32 index in its stream, 16-byte GUID.
  // The code is the stream's section (high byte) and Altium's object id (low byte).
  const SECTIONS = {0x0d01: "arcs", 0x0e02: "pads", 0x0f03: "vias", 0x1004: "tracks", 0x1105: "texts", 0x1206: "fills", 0x1359: "regions", 0x0309: "components", 0x040a: "polygons"};
  function primitiveGuids(bytes) {
    const out = new Map();
    if (!bytes?.length) return out;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), hex = b => (b < 16 ? "0" : "") + b.toString(16);
    for (let p = 0; p + 24 <= bytes.length; p += 24) {
      const s = SECTIONS[v.getUint32(p, true)];
      if (!s) continue;
      let g = "";
      for (let k = p + 8; k < p + 24; k++) g += hex(bytes[k]);
      out.set(s + "#" + v.getUint32(p + 4, true), g);
    }
    return out;
  }
  // UniqueIDPrimitiveInformation/Data: text records |PRIMITIVEINDEX=n|PRIMITIVEOBJECTID=Pad|UNIQUEID=ABCDEFGH|.
  function padIds(bytes) {
    const out = new Map();
    if (!bytes?.length) return out;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder("windows-1252");
    for (let p = 0; p + 4 <= bytes.length;) {
      const n = v.getUint32(p, true) & 0xffffff, s = text.decode(bytes.subarray(p + 4, Math.min(bytes.length, p + 4 + n)));
      p += 4 + n;
      const i = /\|PRIMITIVEINDEX=(\d+)/i.exec(s)?.[1], kind = /\|PRIMITIVEOBJECTID=([^|\0]*)/i.exec(s)?.[1], uid = /\|UNIQUEID=([^|\0]*)/i.exec(s)?.[1];
      if (i != null && uid && /^pad$/i.test(kind || "")) out.set(Number(i), uid);
    }
    return out;
  }
  const isDurable = id => typeof id === "string" && /^au-[0-9a-z]{11}$/.test(id);
  // Results of AtriumIO.read in file order: a document whose ids collide with an earlier result's
  // (same file name) gets every id of its result re-derived, "#2", "#3"…, wherever it is referenced.
  function distinct(results) {
    const seen = new Set();
    let salt = 1;
    return results.map(r => {
      const ids = [...(r?.documents || []), ...(r?.library || [])].flatMap(d => [d.id, ...(d.items || []).map(i => i.id)]).filter(id => typeof id === "string");
      if (!ids.some(id => seen.has(id))) { ids.forEach(id => seen.add(id)); return r; }
      salt++;
      const map = new Map();
      for (const id of ids) if (/^a[uc]-/.test(id)) map.set(id, id.slice(0, 3) + hash(id + "#" + salt));
      const out = JSON.parse(JSON.stringify(r), (k, x) => typeof x === "string" && map.has(x) ? map.get(x) : x);
      [...(out.documents || []), ...(out.library || [])].flatMap(d => [d.id, ...(d.items || []).map(i => i.id)]).forEach(id => seen.add(id));
      return out;
    });
  }
  // SOURCEUNIQUEID on the board can be a backslash-separated hierarchy path; its final
  // record UID is the schematic symbol's UniqueID. Repeated leaves are disambiguated by ECO.
  function sourceLink(raw) {
    const leaf = String(raw || "").trim().split(/[\\/]/).filter(Boolean).pop();
    return leaf ? "au-" + hash("schematic part\u0000" + leaf.toUpperCase()) : "";
  }
  return Object.freeze({scope, primitiveGuids, padIds, isDurable, distinct, hash, sourceLink});
})();
