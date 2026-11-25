"use strict";
if (!globalThis.AtriumAltiumRecords) { if (typeof importScripts === "function" && !globalThis.AtriumEmbeddedTranslatorScripts) importScripts("../formats/altium-records.js"); else if (typeof require === "function") require("../formats/altium-records.js"); }

globalThis.AtriumAltiumRules = (() => {
  const terminator = /(?:¶\s*)?[\r\n]+/;
  const limits = {
    width: {field:"MINLIMIT", key:"trackWidth", label:"Track width"},
    routingvias: {field:"MINHOLEWIDTH", key:"viaDrill", label:"Via drill"},
    clearance: {field:"GAP", key:"clearance", label:"Copper clearance"}
  };
  function properties(line) { return AtriumAltiumRecords.properties(line, false, true); }
  function legacyScope(fields, side) {
    const prefix="SCOPE"+side,count=fields[prefix+"COUNT"];
    const indexed=Object.keys(fields).filter(k=>k.startsWith(prefix+"_"));
    if(count===undefined&&!indexed.length)return /^rule$/i.test(fields.RECORD||"")?"Legacy scope "+side+" (unspecified)":"";
    if(count!=="1"||indexed.some(k=>k!==prefix+"_0_KIND"&&k!==prefix+"_0_VALUE"))return "Legacy scope "+side+" (unrecognised conditions)";
    const kind=fields[prefix+"_0_KIND"],value=fields[prefix+"_0_VALUE"]||"";
    if(/^board$/i.test(kind)&&(!value||/^board$/i.test(value)))return "All";
    const fn={net:"InNet",netclass:"InNetClass",component:"InComponent",componentclass:"InComponentClass",layer:"OnLayer"}[String(kind).toLowerCase()];
    return fn&&value?fn+"('"+value.replace(/'/g,"''")+"')":"Legacy scope "+side+" (unrecognised selector)";
  }
  function validate(lines) {
    if (!Array.isArray(lines) || lines.length > 10000 || lines.some(s => typeof s !== "string" || !s || s.includes("\n") || s.includes("\r") || !properties(s).RULEKIND)) throw Error("Invalid Altium rule records.");
    return lines;
  }
  function read(bytes) {
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le").decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes);
    else {try {text = new TextDecoder("utf-8", {fatal:true}).decode(bytes);} catch {text = new TextDecoder("windows-1252").decode(bytes);}}
    const lines = text.replace(/^\uFEFF/,"").trimEnd().replace(/¶$/,"").split(terminator).filter(s=>s.trim());
    if (!lines.length) throw Error("No Altium design rules found in the file.");
    return validate(lines);
  }
  function binary(bytes, kinds) {
    const result = [];
    let cursor = 0;
    while (cursor < bytes.length) {
      const found = AtriumAltiumRecords.frame(bytes, cursor, 6, ["Truncated Altium rule header.", "Truncated Altium rule record."]);
      cursor = found.end;
      result.push(AtriumAltiumRecords.textLine(found.payload, false));
      kinds?.push(found.kind);
    }
    return validate(result);
  }
  function checkOptions(bytes, kinds, lines) {
    if (!bytes || bytes.length < 5 || bytes.length > 65536) return null;
    const size = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
    if (size !== bytes.length-4 || kinds.length !== lines.length) return null;
    const fields = properties(new TextDecoder("windows-1252").decode(bytes.subarray(4)).replace(/\0+$/,""));
    if (!/^DesignRuleCheckerOptions$/i.test(fields.RECORD || "")) return null;
    const ids = key => {
      const value = fields[key];
      if (value === "") return [];
      if (typeof value !== "string" || !/^\d{1,5}(?:,\d{1,5})*$/.test(value)) return null;
      const list = value.split(",").map(Number);
      return list.length<=1024 && list.every(i=>i<=65535) && new Set(list).size===list.length ? list : null;
    };
    const batch=ids("RULESETTOCHECK"), online=ids("ONLINERULESETTOCHECK");
    if (!batch || !online) return null;
    const byId=new Map(),byKind=new Map();
    for (const [index,line] of lines.entries()) {
      const id=kinds[index], kind=properties(line).RULEKIND.toLowerCase();
      if (byId.has(id)&&byId.get(id)!==kind || byKind.has(kind)&&byKind.get(kind)!==id) return null;
      byId.set(id,kind);byKind.set(kind,id);
    }
    return {kinds,batch,online};
  }
  function write(lines) { return validate(lines).map(s=>s.replace(/^\|/,"")+"¶\r\n").join(""); }
  function minimum(text) {
    const m = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|mil|inch|in|um|µm)$/i.exec(text||"");
    if (!m) return null;
    const n = Number(m[1])*({mm:1,mil:.0254,inch:25.4,in:25.4,um:.001,"µm":.001})[m[2].toLowerCase()];
    return n>0 && n<=1000 ? Number(n.toFixed(10)) : null;
  }
  function describe(line) {
    const fields=properties(line), p=Object.assign(Object.create(null),fields);
    for(const key of Object.keys(fields))if(key.startsWith("%UTF8%"))p[key.slice(6)]=fields[key];
    const kind = p.RULEKIND || "", spec = limits[kind.toLowerCase()];
    const first = p.SCOPE1EXPRESSION ?? legacyScope(p,1), second = p.SCOPE2EXPRESSION ?? legacyScope(p,2);
    const row = {name:p.NAME||kind,kind,first,second,priority:p.PRIORITY||"",enabled:/^(true|t|1)$/i.test(p.ENABLED),fields,candidate:null};
    if (!row.enabled || !spec || !/^all$/i.test(second) || !/^SameLayer$/i.test(p.LAYERKIND||"")) return row;
    const named = /^InNet\s*\(\s*'((?:[^']|'')+)'\s*\)$/i.exec(first);
    if (!/^all$/i.test(first) && !named) return row;
    if (spec.key === "clearance") {
      if (named || !/^DifferentNets$/i.test(p.NETSCOPE||"") || /^true$/i.test(p.IGNOREPADTOPADCLEARANCEINFOOTPRINT)) return row;
      // Hole clearances are outside the editor's copper-edge check. Object-specific copper gaps need their own rule engine.
      if ((p.OBJECTCLEARANCES||"").trim().split(";").some(x=>x && !/^ClearanceObj_\w+-ClearanceObj_Hole:\d+$/i.test(x.trim()))) return row;
    } else if (!/^AnyNet$/i.test(p.NETSCOPE||"")) return row;
    const value = minimum(p[spec.field]);
    if (value !== null) row.candidate = {key:spec.key,label:spec.label,value,net:named?named[1].replace(/''/g,"'"):"",sourceField:spec.field};
    return row;
  }
  // Class and differential pair records (doc.sourceClasses, kept as text like doc.sourceRules): net classes
  // (KIND=0), differential pair classes (KIND=6) and xSignal classes (KIND=10) from Classes6 / SignalClasses,
  // and DifferentialPair records. Superclasses ("All Nets") are built in and skipped. Members are M0, M1, ...
  // DifferentialPair records name their nets POSITIVENETNAME / NEGATIVENETNAME; xSignal records are the
  // Board6 PINPAIR* keys kept as RECORD=xSignal|NAME|PINS ("U1-3,C1-1,C1-2,J1-3": start pad, the series
  // parts' pads, end pad)|GUID|PINUNIQUEIDS|... (pcb-import.js). docs/design/altium-pairs-xsignals-format.md.
  // -> {netClasses, diffPairs:[{name,positive,negative}], diffPairClasses, xSignalClasses,
  //     xSignals:[{name, from:{ref,pin}, to:{ref,pin}, through?}], ids:{"kind:name"|"pair:name"|"xsignal:name": UNIQUEID|GUID}}
  function classes(lines) {
    const out = {netClasses: {}, diffPairs: [], diffPairClasses: {}, xSignalClasses: {}, xSignals: [], ids: {}};
    if (!Array.isArray(lines)) return out;
    const valid = s => typeof s === "string" && !!s.trim() && s.length <= 512 && !/[\u0000-\u001f]/.test(s);
    for (const line of lines.slice(0, 100000)) {
      if (typeof line !== "string") continue;
      const f = properties(line), p = Object.assign(Object.create(null), f);
      for (const k of Object.keys(f)) if (k.startsWith("%UTF8%")) p[k.slice(6)] = f[k];
      const rec = String(p.RECORD || "").toLowerCase(), name = p.NAME;
      if (!valid(name)) continue;
      if (rec === "class") {
        if (/^(true|t|1)$/i.test(p.SUPERCLASS || "")) continue;
        const key = {0: "netClasses", 6: "diffPairClasses", 10: "xSignalClasses"}[Number(p.KIND)];
        if (!key || Object.prototype.hasOwnProperty.call(out[key], name)) continue;
        const members = [];
        for (let i = 0; i < 100000 && p["M" + i] != null; i++) if (valid(p["M" + i]) && !members.includes(p["M" + i])) members.push(p["M" + i]);
        Object.defineProperty(out[key], name, {value: members, enumerable: true, writable: true, configurable: true});
        if (p.UNIQUEID) out.ids[p.KIND + ":" + name] = p.UNIQUEID;
      } else if (rec === "differentialpair") {
        const pos = p.POSITIVENETNAME ?? p.POSITIVENET ?? p.POSNETNAME ?? p.POSITIVE, neg = p.NEGATIVENETNAME ?? p.NEGATIVENET ?? p.NEGNETNAME ?? p.NEGATIVE;
        if (!valid(pos) || !valid(neg) || pos === neg || out.diffPairs.some(x => x.name === name || [x.positive, x.negative].some(n => n === pos || n === neg))) continue;
        out.diffPairs.push({name, positive: pos, negative: neg});
        if (p.UNIQUEID) out.ids["pair:" + name] = p.UNIQUEID;
      } else if (rec === "xsignal") {
        const pins = String(p.PINS || "").split(",").map(s => s.trim()).filter(Boolean).map(s => { const k = s.lastIndexOf("-"); return k > 0 ? {ref: s.slice(0, k), pin: s.slice(k + 1)} : null; });
        if (pins.length < 2 || pins.some(x => !x || !valid(x.ref) || !valid(x.pin)) || out.xSignals.some(x => x.name === name)) continue;
        const ends = new Set([pins[0].ref, pins.at(-1).ref]), through = [...new Set(pins.slice(1, -1).map(x => x.ref))].filter(r => !ends.has(r));
        out.xSignals.push({name, from: pins[0], to: pins.at(-1), ...(through.length ? {through} : {})});
        if (p.GUID) out.ids["xsignal:" + name] = p.GUID;
      }
    }
    return out;
  }
  return {read,binary,checkOptions,write,describe,validate,classes};
})();
