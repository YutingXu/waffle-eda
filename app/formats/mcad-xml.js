"use strict";
// A small, safe XML reader and writer for ECAD-MCAD exchange (IDX / ProSTEP iViP EDMD).
//
// Imported XML is untrusted. The reader is a hand-written tokenizer, not the platform's DOMParser:
//   - no DTD: a <!DOCTYPE …> (and any <!ENTITY>, <!ATTLIST>, <!ELEMENT>) is refused outright, so
//     there are no external entities, no parameter entities and no entity expansion at all;
//   - only the five predefined entities (&lt; &gt; &amp; &quot; &apos;) and numeric character
//     references are decoded; any other &name; is an error;
//   - nothing is fetched: schemaLocation and the like are plain attribute text;
//   - caps on the text size, element count, nesting depth, attributes per element, name length
//     and text per node (LIMITS, each overridable downwards).
// Namespaces are resolved: every element and attribute carries its namespace URI, and `q` is the
// name with the canonical prefix for that URI (opts.prefixes), so a file that spells
// "foundation:" as "f:" reads the same.
//
//   AtriumXML.parse(text, {limits, prefixes}) -> root {name, local, ns, q, attrs:{q: value}, children:[node], text}
//   AtriumXML.parse(text, {profile: "ipc"})   -> {name, attrs, children, line}; source names, for IPC-2581 check().
//     IDX keeps opts.prefixes and LIMITS. The IPC profile does not change that default.
//   AtriumXML.el(q, attrs, ...children)        -> a node for write() (children: nodes, strings, numbers)
//   AtriumXML.write(root, {decl, namespaces})  -> deterministic, indented text
//   AtriumXML.validate(root, schema)           -> [{path, message}] (structural check; see mcad-idx.js)
//   AtriumXML.text(node), child(node, q), children(node, q), num(node)
globalThis.AtriumXML = (() => {
  const LIMITS = Object.freeze({bytes: 64 * 1048576, elements: 2000000, depth: 128, attributes: 64, name: 256, text: 4 * 1048576});
  const XML_NS = "http://www.w3.org/XML/1998/namespace", XMLNS = "http://www.w3.org/2000/xmlns/";
  const PREDEFINED = {lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'"};
  const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;
  const IPC_NAME = /^[A-Za-z_:][\w.\-:]*$/;
  class XMLError extends Error {}

  const IDX_ENTITY = /&([^;&\s]{1,12});/g;
  const IPC_ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  function decode(s, at, ipc = false) {
    if (s.indexOf("&") < 0) return s;
    if (ipc) {
      const bad = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(s);
      if (bad) throw new XMLError("XML line " + at + ": bad entity reference near " + JSON.stringify(s.slice(bad.index, bad.index + 12)));
    } else if (/&(?![^;&\s]{1,12};)/.test(s)) throw new XMLError("A bare & near offset " + at + ".");
    return s.replace(ipc ? IPC_ENTITY : IDX_ENTITY, (all, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!ipc && (!Number.isFinite(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))) throw new XMLError("Bad character reference near offset " + at + ".");
        return String.fromCodePoint(n);
      }
      if (Object.hasOwn(PREDEFINED, e)) return PREDEFINED[e];
      throw new XMLError("Undeclared entity &" + e + "; near offset " + at + " (entities are not supported).");
    });
  }

  function parse(text, opts = {}) {
    const ipc = opts.profile === "ipc";
    const L = {...LIMITS, ...(ipc ? {} : (opts.limits || {}))};
    if (ipc) { L.bytes = 256 * 1024 * 1024; L.elements = 2000000; L.depth = 256; }
    else for (const k of Object.keys(LIMITS)) L[k] = Math.min(LIMITS[k], L[k]);
    if (typeof text !== "string") throw new XMLError("The XML is not text.");
    if (text.length > L.bytes) throw new XMLError(ipc ? "XML line 1: document exceeds the XML text size limit" : ("The XML file is larger than " + Math.round(L.bytes / 1048576) + " MB."));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const canon = opts.prefixes || {}, byURI = new Map(Object.entries(canon).map(([p, u]) => [u, p]));
    const n = text.length;
    let i = 0, count = 0, root = null, line = 1;
    const stack = [];
    const fail = (plain, checked) => { throw new XMLError(ipc ? ("XML line " + line + ": " + (checked == null ? plain : checked)) : (plain + " (offset " + i + ").")); };
    const sync = to => { if (ipc) for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++; i = to; };
    const qOf = (ns, local, given) => { const p = ns ? byURI.get(ns) : null; return p ? p + ":" + local : ns ? (given.includes(":") ? given : local) : local; };
    while (i < n) {
      const lt = text.indexOf("<", i), end = lt < 0 ? n : lt;
      if (end > i) {
        const chunk = text.slice(i, end);
        if (!ipc && stack.length && (lt >= 0 || chunk.trim())) addText(chunk, i);
        else if (chunk.trim()) {
          if (!stack.length) fail("Text outside the root element", "text outside the root element");
          if (ipc) decode(chunk, line, true);
        }
      }
      if (lt < 0) { if (ipc) sync(end); break; }
      sync(lt);
      if (text.startsWith("<?", i)) {
        const e = text.indexOf("?>", i + 2);
        if (e < 0) fail("Unterminated processing instruction", i === 0 && text.startsWith("<?xml") ?
          "unterminated XML declaration" : "unterminated processing instruction");
        sync(e + 2); continue;
      }
      if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i + 4); if (e < 0) fail("Unterminated comment", "unterminated comment"); sync(e + 3); continue; }
      if (text.startsWith("<![CDATA[", i)) {
        const e = text.indexOf("]]>", i + 9); if (e < 0) fail("Unterminated CDATA section", "unterminated CDATA");
        if (ipc) { sync(e + 3); continue; }
        if (!stack.length) fail("CDATA outside the root element");
        pushText(text.slice(i + 9, e)); sync(e + 3); continue;
      }
      if (text.startsWith("<!", i)) {
        if (ipc) fail("DOCTYPE and other declarations are not expected");
        // DOCTYPE, ENTITY, ATTLIST, ELEMENT, NOTATION: refused (no DTD, no entities).
        throw new XMLError("The XML has a document type declaration (<!DOCTYPE> or <!ENTITY>), which Waffle does not read for safety.");
      }
      if (text[i + 1] === "/") {
        const e = text.indexOf(">", i + 2); if (e < 0) fail("Unterminated end tag");
        const name = text.slice(i + 2, e).trim(), top = stack.pop();
        if (!top || top.name !== name) fail("Mismatched end tag </" + name + ">", "closing tag </" + name + "> does not match <" + (top ? top.name : "#document") + ">");
        if (!ipc) finish(top);
        sync(e + 1); continue;
      }
      // Start tag.
      let j = i + 1;
      while (j < n && !/[\s/>]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      if (ipc ? !IPC_NAME.test(name) : (!name || name.length > L.name || !NAME.test(name))) fail("Bad element name", "invalid element name " + JSON.stringify(name));
      if (ipc && (stack.length >= L.depth || ++count > L.elements)) fail("document exceeds the XML nesting or element limit");
      const attrs = ipc ? {} : null, raw = [];
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (j >= n) fail("Unterminated start tag <" + name + ">", "unterminated start tag <" + name);
        if (text[j] === ">" || (text[j] === "/" && text[j + 1] === ">")) break;
        let k = j;
        while (k < n && !/[\s=/>]/.test(text[k])) k++;
        const an = text.slice(j, k);
        if (ipc ? !IPC_NAME.test(an) : (!an || an.length > L.name || !NAME.test(an))) fail("Bad attribute name in <" + name + ">", "invalid attribute name " + JSON.stringify(an) + " on <" + name + ">");
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== "=") fail("Attribute " + an + " has no value", "attribute " + an + " on <" + name + "> has no value");
        k++;
        while (k < n && /\s/.test(text[k])) k++;
        const quote = text[k];
        if (quote !== "\"" && quote !== "'") fail("Attribute " + an + " is not quoted", "attribute " + an + " on <" + name + "> is not quoted");
        const end = text.indexOf(quote, k + 1);
        if (end < 0) fail("Unterminated attribute value", "unterminated attribute value");
        const v = text.slice(k + 1, end);
        if (v.includes("<")) fail("A < inside an attribute value", "'<' in attribute " + an + " on <" + name + ">");
        if (ipc ? Object.hasOwn(attrs, an) : raw.some(r => r[0] === an)) fail("Duplicate attribute " + an, "duplicate attribute " + an + " on <" + name + ">");
        const value = decode(v, ipc ? line : k, ipc);
        if (ipc) {
          if (an === "__proto__") Object.defineProperty(attrs, an, {value, enumerable: true, configurable: true, writable: true});
          else attrs[an] = value;
        } else {
          raw.push([an, value]);
          if (raw.length > L.attributes) fail("Too many attributes on <" + name + ">");
        }
        j = end + 1;
      }
      const empty = text[j] === "/";
      const next = j + (empty ? 2 : 1);
      let node;
      if (ipc) node = {name, attrs, children: [], line};
      else {
        i = next;
        if (++count > L.elements) throw new XMLError("The XML has more than " + L.elements + " elements.");
        if (stack.length + 1 > L.depth) throw new XMLError("The XML nests deeper than " + L.depth + " levels.");
        // Namespace scope. IDX canonical prefixes (opts.prefixes) and LIMITS stay on this path.
        const parentNs = stack.length ? stack[stack.length - 1].nsMap : {xml: XML_NS};
        let nsMap = parentNs;
        for (const [an, v] of raw) {
          if (an === "xmlns" || an.startsWith("xmlns:")) { if (nsMap === parentNs) nsMap = {...parentNs}; nsMap[an === "xmlns" ? "" : an.slice(6)] = v; }
        }
        const split = q => { const c = q.indexOf(":"); return c < 0 ? ["", q] : [q.slice(0, c), q.slice(c + 1)]; };
        const [pfx, local] = split(name);
        const ns = pfx ? nsMap[pfx] : nsMap[""] || "";
        if (pfx && ns == null) fail("Undeclared namespace prefix " + pfx + ":");
        node = {name, local, ns: ns || "", q: qOf(ns, local, name), attrs: {}, children: [], text: "", nsMap, parts: null};
        for (const [an, v] of raw) {
          if (an === "xmlns" || an.startsWith("xmlns:")) continue;
          const [ap, al] = split(an);
          const ans = ap ? nsMap[ap] : "";
          if (ap && ans == null) fail("Undeclared namespace prefix " + ap + ":");
          node.attrs[ap ? qOf(ans, al, an) : al] = v;
        }
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) fail("More than one root element", "more than one root element");
      else root = node;
      if (ipc) sync(next);
      if (empty) { if (!ipc) finish(node); }
      else stack.push(node);
    }
    if (stack.length) throw new XMLError(ipc ? ("XML line " + line + ": unclosed element <" + stack[stack.length - 1].name + ">") : ("The XML ends inside <" + stack[stack.length - 1].name + ">."));
    if (!root) throw new XMLError(ipc ? ("XML line " + line + ": no root element") : "The file has no XML root element.");
    return root;
    function addText(s, at) { pushText(decode(s, at)); }
    function pushText(s) {
      const top = stack[stack.length - 1];
      (top.parts ||= []).push(s);
      if ((top.textLength = (top.textLength || 0) + s.length) > L.text) throw new XMLError("An XML element holds more than " + Math.round(L.text / 1048576) + " MB of text.");
    }
    function finish(node) {
      node.text = node.parts ? node.parts.join("") : "";
      delete node.parts; delete node.textLength;
      // Keep the namespace map only for xsi:type resolution, then drop it from the public tree.
      Object.defineProperty(node, "nsMap", {value: node.nsMap, enumerable: false, writable: true});
    }
  }

  // xsi:type="d2:EDMDPolyLine" -> canonical "d2:EDMDPolyLine" resolved through the element's scope.
  function typeOf(node, prefixes = {}) {
    const raw = node.attrs["xsi:type"] ?? Object.entries(node.attrs).find(([k]) => /(^|:)type$/.test(k) && k !== "type")?.[1];
    if (!raw) return "";
    const c = raw.indexOf(":");
    if (c < 0) return raw;
    const uri = node.nsMap?.[raw.slice(0, c)], p = uri && Object.entries(prefixes).find(([, u]) => u === uri)?.[0];
    return (p || raw.slice(0, c)) + ":" + raw.slice(c + 1);
  }

  // ---------------------------------------------------------------- tree helpers
  const child = (node, q) => node?.children.find(c => c.q === q || c.local === q) || null;
  const children = (node, q) => node ? node.children.filter(c => q == null || c.q === q || c.local === q) : [];
  const text = node => node ? node.text.trim() : "";
  // A number either as the element's text or inside a property:Value child (EDMD properties).
  function num(node) {
    if (!node) return null;
    const v = node.children.length ? text(child(node, "Value")) : text(node);
    const x = v === "" ? NaN : +v;
    return Number.isFinite(x) ? x : null;
  }

  // ---------------------------------------------------------------- writer
  const el = (q, attrs, ...kids) => ({q, attrs: attrs || {}, children: kids.flat(Infinity).filter(k => k != null && k !== false)});
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  function fmt(v) {
    if (typeof v !== "number") return String(v);
    if (!Number.isFinite(v)) throw Error("Cannot write a non-finite number to XML.");
    const r = Math.round(v * 1e6) / 1e6;
    return Object.is(r, -0) ? "0" : String(r);
  }
  function write(root, o = {}) {
    const out = [];
    if (o.decl !== false) out.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    const walk = (node, depth, top) => {
      const pad = "  ".repeat(depth);
      let attrs = "";
      const all = top && o.namespaces ? {...Object.fromEntries(Object.entries(o.namespaces).map(([p, u]) => ["xmlns:" + p, u])), ...node.attrs} : node.attrs;
      for (const [k, v] of Object.entries(all)) if (v != null) attrs += " " + k + "=\"" + esc(fmt(v)) + "\"";
      const kids = node.children;
      if (!kids.length) { out.push(pad + "<" + node.q + attrs + "/>"); return; }
      if (kids.every(k => typeof k !== "object")) { out.push(pad + "<" + node.q + attrs + ">" + kids.map(k => esc(fmt(k))).join("") + "</" + node.q + ">"); return; }
      out.push(pad + "<" + node.q + attrs + ">");
      for (const k of kids) if (typeof k === "object") walk(k, depth + 1, false); else out.push(pad + "  " + esc(fmt(k)));
      out.push(pad + "</" + node.q + ">");
    };
    walk(root, 0, true);
    return out.join("\n") + "\n";
  }

  // ---------------------------------------------------------------- structural validation
  // schema: {root, elements: {q: {children: [q], required: [q], attrs: [names], requiredAttrs: [names], text: "number"|"boolean"|[enum]|true, ref: true}},
  //          types: {q: [xsi types allowed]}, idAttr: "id"}
  function validate(root, schema) {
    const problems = [], ids = new Map(), refs = [];
    const say = (path, message) => { if (problems.length < 200) problems.push({path, message}); };
    if (schema.root && root.q !== schema.root) say(root.q, "The root element should be " + schema.root + ".");
    const walk = (node, path) => {
      const spec = schema.elements[node.q];
      if (!spec) { say(path, "Unknown element " + node.q + "."); return; }
      if (node.attrs.id != null) { if (ids.has(node.attrs.id)) say(path, "Duplicate id " + node.attrs.id + "."); ids.set(node.attrs.id, node); }
      for (const a of spec.requiredAttrs || []) if (node.attrs[a] == null) say(path, node.q + " needs the attribute " + a + ".");
      for (const a of Object.keys(node.attrs)) if (!(spec.attrs || []).includes(a) && a !== "xsi:type" && a !== "id" && !a.startsWith("xsi:")) say(path, node.q + " has an unexpected attribute " + a + ".");
      if (spec.enumAttrs) for (const [a, list] of Object.entries(spec.enumAttrs)) if (node.attrs[a] != null && !list.includes(node.attrs[a])) say(path, node.q + " " + a + " \"" + node.attrs[a] + "\" is not one of the known values.");
      const types = schema.types?.[node.q];
      if (types) { const t = node.attrs["xsi:type"]; if (!t) say(path, node.q + " needs an xsi:type."); else if (!types.includes(t)) say(path, node.q + " xsi:type " + t + " is not expected here."); }
      const allowed = spec.children || [];
      for (const c of node.children) {
        if (!allowed.includes(c.q) && !allowed.includes("*")) say(path + "/" + c.q, c.q + " is not allowed inside " + node.q + ".");
        else walk(c, path + "/" + c.q);
      }
      for (const r of spec.required || []) if (!node.children.some(c => c.q === r)) say(path, node.q + " needs " + r + ".");
      const t = node.text.trim();
      if (spec.text === "number" && !node.children.length && !(t !== "" && Number.isFinite(+t))) say(path, node.q + " should hold a number.");
      if (spec.text === "boolean" && !/^(true|false)$/.test(t)) say(path, node.q + " should be true or false.");
      if (Array.isArray(spec.text) && !spec.text.includes(t)) say(path, node.q + " \"" + t + "\" is not one of " + spec.text.join(", ") + ".");
      if (spec.ref) refs.push([path, t]);
    };
    walk(root, root.q);
    for (const [path, id] of refs) if (!ids.has(id)) say(path, "Reference " + id + " points at no element.");
    return problems;
  }

  // A tree written with el() read as if parsed (for validate()).
  function asParsed(node) {
    const kids = node.children.filter(k => typeof k === "object").map(asParsed);
    const text = node.children.filter(k => typeof k !== "object").map(fmt).join("");
    const local = node.q.includes(":") ? node.q.slice(node.q.indexOf(":") + 1) : node.q;
    const attrs = {};
    for (const [k, v] of Object.entries(node.attrs)) if (v != null && !k.startsWith("xmlns")) attrs[k] = fmt(v);
    return {name: node.q, local, ns: "", q: node.q, attrs, children: kids, text};
  }

  return Object.freeze({LIMITS, XMLError, parse, typeOf, child, children, text, num, el, write, fmt, validate, asParsed});
})();
