// Shared lexer used by the palette's cold intent check and the calculation worker.
// Offsets always refer to the user's original UTF-16 string.
(function (root) {
  "use strict";
  // An explicit design-field reference is one token. Number-looking rail names
  // and operators inside a quoted signal name do not enter the arithmetic grammar.
  const netField = /net\s+(?:"(?:[^"\\]|\\["\\])*"|'(?:[^'\\]|\\['\\])*'|[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*)\.[\p{L}_][\p{L}\p{N}_]*/iuy;
  const editingNet = /^net\s+(?:["']|[\p{L}\p{N}_]+\.)/iu;
  const number = /(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/y;
  // A qualified package function may contain hyphens. Recognise that spelling only
  // immediately before a call. Plain arithmetic (including R1-R2) keeps its minus.
  const callable = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+(?=\s*\()/y;
  const word = /[\p{L}_°Δ][\p{L}\p{N}_°²³]*(?:(?:\.|::)[\p{L}_][\p{L}\p{N}_]*)*/uy;
  const operator = /(?:\*\*|\|\||&&|>=|<=|==|!=|\+\/-|[+−\-*/^·×∥(),±%=<>≤≥≠.])/y;
  const spellings = {"−":"-", "·":"*", "×":"*", "**":"^", "∥":"||", "≤":"<=", "≥":">=", "≠":"!=", "==":"=", "+/-":"±"};
  const limits = Object.freeze({characters:8192, tokens:1024, depth:64, steps:20000});
  function error(code, message, span) {
    const e = new Error(message);
    e.diagnostic = {code, message, span};
    return e;
  }
  // The design-query parser owns the text inside count(). Only find its balanced
  // bounds here, including quotes, so its fields never become calculation bindings.
  function countToken(input, start, open) {
    let depth = 1, quote = "";
    for (let i = open + 1; i < input.length; i++) {
      const c = input[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") {
        if (++depth > limits.depth) throw error("limit", "Query nesting exceeds the limit.", [i,i + 1]);
      } else if (c === ")" && --depth === 0) {
        const value = input.slice(open + 1, i);
        if (!value.trim()) throw error("query", "Enter a design query to count.", [open + 1,i]);
        return {kind:"count-query", value, start, end:i + 1, querySpan:[open + 1,i]};
      }
    }
    throw error("syntax", "Close the count query.", [open,input.length]);
  }
  function lex(input) {
    if (typeof input !== "string") throw error("source", "Enter an expression.", [0,0]);
    if (input.length > limits.characters) throw error("limit", "Expression exceeds the character limit.", [limits.characters,input.length]);
    const tokens = [];
    let i = 0;
    while (i < input.length) {
      if (/\s/u.test(input[i])) { i++; continue; }
      if (tokens.length >= limits.tokens) throw error("limit", "Expression exceeds the token limit.", [i,input.length]);
      const start = i;
      let kind, value, match;
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        kind = "string"; value = ""; i++;
        while (i < input.length && input[i] !== quote) {
          if (input[i] === "\\") {
            i++;
            if (input[i] !== quote && input[i] !== "\\") throw error("string", "Use a quoted character or backslash.", [start,i]);
          }
          value += input[i++];
        }
        if (i >= input.length) throw error("string", "Close the quoted text.", [start,i]);
        i++;
      } else {
        for (const entry of [[netField,"net-field"],[number,"number"],[callable,"word"],[word,"word"],[operator,"operator"]]) {
          entry[0].lastIndex = i;
          match = entry[0].exec(input);
          if (match) { kind = entry[1]; break; }
        }
        if (!match) throw error("token", "Unrecognised calculation character.", [i,i + (input.codePointAt(i) > 65535 ? 2 : 1)]);
        i += match[0].length;
        value = Object.prototype.hasOwnProperty.call(spellings, match[0]) ? spellings[match[0]] : match[0];
        if (kind === "word" && value.toLowerCase() === "count") {
          let open = i;
          while (open < input.length && /\s/u.test(input[open])) open++;
          if (input[open] === "(") {
            const query = countToken(input,start,open);
            tokens.push(query); i = query.end; continue;
          }
        }
      }
      tokens.push({kind,value,start,end:i});
    }
    tokens.push({kind:"end",value:"",start:i,end:i});
    return tokens;
  }
  function acceptsPaletteText(source) {
    if (typeof source !== "string" || source.length > limits.characters) return false;
    const input = source.trim();
    if (!input || /^[>@:/]/.test(input)) return false;
    if (editingNet.test(input)) return true;
    let tokens;
    try { tokens = lex(input); } catch (_) {
      return /^[\d(+-]/.test(input) || /^(?:nearest|assert)\s/i.test(input) ||
        /^[\p{L}_][\p{L}\p{N}_.:-]*\s*\(/u.test(input);
    }
    const first = tokens[0], second = tokens[1];
    if (first.kind === "number" || first.kind === "count-query" || ["(","+","-"].includes(first.value)) return true;
    if (first.kind !== "word") return false;
    if (["nearest","assert"].includes(first.value) && second.kind !== "end") return true;
    if (second.value === "(" || second.kind === "operator" || first.value.includes(".")) return true;
    return (first.value === "π" || first.value === "pi") && second.kind === "end";
  }
  // Table formulas bind the same net-field spelling as design references.
  globalThis.AtriumCalculationIntent = Object.freeze({lex, acceptsPaletteText, limits, error, netField: netField.source});
})(globalThis);
