"use strict";
// JSON with source positions: maps a JSON path or an object id to a text range, so schema
// errors and DRC/ERC results land on the right line in VS Code. Pure JS, no dependencies;
// runs in the VS Code extension host, in Node and under JavaScriptCore (tests).
//
//   const {root, error} = parse(text);     // error: {offset, message} for invalid JSON
//   at(root, ["documents", 0, "items", 3]) // -> node {type, start, end, ...} or the deepest node found
//   findId(root, "b-U1")                   // -> {node, path} for the object whose "id" is that string
//   lines(text).position(offset)           // -> {line, character}, 0-based
(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.AtriumJsonPos = api;
})(function () {
  function parse(text) {
    let i = 0;
    const n = text.length;
    const fail = msg => { const e = Error(msg); e.offset = i; throw e; };
    const ws = () => { for (;;) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 13 || c === 9) i++; else break; } };
    function str() {
      const start = i++;
      for (;;) {
        if (i >= n) fail("Unterminated string.");
        const c = text.charCodeAt(i);
        if (c === 34) { i++; break; }
        if (c === 92) i += 2; else if (c < 32) fail("Control character in string."); else i++;
      }
      let value;
      try { value = JSON.parse(text.slice(start, i)); } catch { i = start; fail("Invalid string escape."); }
      return {type: "string", start, end: i, value};
    }
    function value(depth) {
      if (depth > 512) fail("Nesting is too deep.");
      ws();
      const start = i, c = text[i];
      if (c === "{") {
        i++; const props = []; ws();
        if (text[i] === "}") { i++; return {type: "object", start, end: i, props}; }
        for (;;) {
          ws(); if (text[i] !== "\"") fail("Expected a property name.");
          const key = str(); ws();
          if (text[i] !== ":") fail("Expected ':' after a property name."); i++;
          const node = value(depth + 1);
          props.push({key: key.value, keyStart: key.start, keyEnd: key.end, node});
          ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; return {type: "object", start, end: i, props}; }
          fail("Expected ',' or '}'.");
        }
      }
      if (c === "[") {
        i++; const items = []; ws();
        if (text[i] === "]") { i++; return {type: "array", start, end: i, items}; }
        for (;;) {
          items.push(value(depth + 1)); ws();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "]") { i++; return {type: "array", start, end: i, items}; }
          fail("Expected ',' or ']'.");
        }
      }
      if (c === "\"") return str();
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) fail(i >= n ? "Unexpected end of file." : "Unexpected character " + JSON.stringify(c) + ".");
      i += m[0].length;
      const t = m[0];
      return t === "null" ? {type: "null", start, end: i, value: null} : t === "true" || t === "false" ? {type: "boolean", start, end: i, value: t === "true"}
        : {type: "number", start, end: i, value: Number(t)};
    }
    try {
      const root = value(0); ws();
      if (i < n) fail("Unexpected text after the JSON value.");
      return {root, error: null};
    } catch (e) {
      return {root: null, error: {offset: e.offset ?? i, message: e.message}};
    }
  }
  const prop = (node, key) => node?.type === "object" ? node.props.find(p => p.key === key) : undefined;
  // The node at a path, or the deepest existing ancestor (so a missing property points at its parent).
  function at(root, path) {
    let node = root;
    for (const step of path || []) {
      let next = null;
      if (node?.type === "array" && typeof step === "number") next = node.items[step];
      else if (node?.type === "object") next = prop(node, String(step))?.node;
      if (!next) return node;
      node = next;
    }
    return node;
  }
  // The range of a property's key (nicer to underline than a whole object), else the node.
  function keyRange(root, path) {
    if (!path?.length) return root ? [root.start, Math.min(root.end, root.start + 1)] : [0, 0];
    const parent = at(root, path.slice(0, -1)), p = prop(parent, String(path[path.length - 1]));
    if (p) return [p.keyStart, p.keyEnd];
    const node = at(root, path);
    return node ? [node.start, node.type === "object" || node.type === "array" ? node.start + 1 : node.end] : [0, 0];
  }
  function findId(root, id) {
    const stack = [[root, []]];
    while (stack.length) {
      const [node, path] = stack.pop();
      if (node.type === "object") {
        const p = prop(node, "id");
        if (p && p.node.type === "string" && p.node.value === id) return {node, path, idNode: p.node};
        for (let k = node.props.length - 1; k >= 0; k--) if (node.props[k].node.type === "object" || node.props[k].node.type === "array") stack.push([node.props[k].node, path.concat(node.props[k].key)]);
      } else if (node.type === "array") {
        for (let k = node.items.length - 1; k >= 0; k--) if (node.items[k].type === "object" || node.items[k].type === "array") stack.push([node.items[k], path.concat(k)]);
      }
    }
    return null;
  }
  // Every object id -> its "id" value node, in one pass (for mapping many results).
  function idIndex(root) {
    const out = new Map(), stack = root ? [root] : [];
    while (stack.length) {
      const node = stack.pop();
      if (node.type === "object") {
        const p = prop(node, "id");
        if (p && p.node.type === "string" && !out.has(p.node.value)) out.set(p.node.value, p.node);
        for (const q of node.props) if (q.node.type === "object" || q.node.type === "array") stack.push(q.node);
      } else if (node.type === "array") for (const x of node.items) if (x.type === "object" || x.type === "array") stack.push(x);
    }
    return out;
  }
  function lines(text) {
    const starts = [0];
    for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) starts.push(k + 1);
    return {
      position(offset) {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
        return {line: lo, character: offset - starts[lo]};
      }
    };
  }
  return {parse, at, keyRange, findId, idIndex, lines};
});
