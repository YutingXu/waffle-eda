"use strict";

// Recognise the signatures of pre-release designs without reading their models.
globalThis.AtriumObsoleteProject = (() => {
  const note = "This file is from a pre-release Waffle build; re-import the design from its source EDA";
  const code = "pre-release-format", limit = 65536;

  function prefix(input, length = limit) {
    if (typeof input === "string") return input.slice(0,length).replace(/^\uFEFF/,"").trimStart();
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer,input.byteOffset,input.byteLength) :
      input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!bytes) return "";
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" :
      bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
    return new TextDecoder(encoding).decode(bytes.subarray(0,length)).trimStart();
  }

  function header(text) {
    if (!text.startsWith("{")) return {};
    let depth = 0, design = false, format, kind, version;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{" || ch === "[") { depth++; continue; }
      if (ch === "}" || ch === "]") { if (!--depth) break; continue; }
      if (ch !== '"') continue;
      const begin = ++i;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
      if (depth !== 1 || i - begin > 24) continue;
      const key = text.slice(begin,i), value = /^\s*:\s*/.exec(text.slice(i+1,i+65));
      if (!value) continue;
      const start = i+1+value[0].length;
      if (["documents","library","sheets"].includes(key) && text[start] === "[") design = true;
      if (key === "format" || key === "kind" || key === "formatVersion") {
        const token = /^"([a-zA-Z0-9_.-]{1,48})"/.exec(text.slice(start,start+52))?.[1];
        if (key === "format") format = token;
        if (key === "kind") kind = token;
        if (key === "formatVersion") version = token;
      }
    }
    return {format,kind,version,design};
  }

  function recognize(input, name = "") {
    const text = prefix(input);
    if (/^ATRIUM-JOURNAL 1(?:\r?\n|$)/.test(text)) return true;
    if (!text.startsWith("{")) return false;
    const {format,kind,version,design} = header(text);
    if (kind === "project" && /^\d+(?:\.\d+)+$/.test(version) && Number(version.split(".")[0]) >= 2) return false;
    if (format === "atrium" || format === "waffle") return true;
    const named = /\.(?:waffle|atrium)(?:\.journal|~)?$/i.test(name);
    if (kind === "project") return named && /^(?:0|1)\./.test(version || "");
    return named && !format && design;
  }

  const error = () => Object.assign(Error(note),{code});
  function reject(input,name) {
    if (recognize(input,name)) throw error();
  }
  return Object.freeze({note,code,limit,prefix,header,recognize,reject,error});
})();
