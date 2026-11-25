"use strict";
// Native records are parsed by the same bounded, typed codec as the editor. Only the
// selected manifest grants document and library paths to this read-only viewer.
const fs = require("node:fs");
const path = require("node:path");
const modules = ["project/obsolete-project.js", "core/sha256.js", "project/source-file.js", "formats/format-2-codec.js", "formats/format-2-units.js", "formats/format-2-values.js", "formats/format-2-model.js"];
const kinds = {".waffle": "project", ".wsch": "schematic", ".wpcb": "pcb", ".wdraw": "drawing", ".wpanel": "panel", ".wlib": "library", ".wblock": "block"};
// Match the native folder hosts' per-file and per-batch read limits.
const oneFile = 256 * 1024 * 1024, totalSize = 2 * oneFile;
const utf8Length = typeof Buffer.byteLength === "function" ? Buffer.byteLength : s => new TextEncoder().encode(s).length;

function core() {
  if (!globalThis.AtriumFormat2Model || !globalThis.AtriumObsoleteProject) {
    const packaged = path.join(__dirname, "../media/app");
    const dir = fs.existsSync(path.join(packaged, modules[0])) ? packaged : path.join(__dirname, "../../../app");
    for (const file of modules) require(path.join(dir, file));
  }
  return {codec: globalThis.AtriumFormat2, model: globalThis.AtriumFormat2Model, obsolete: globalThis.AtriumObsoleteProject};
}

function parse(text, name, expected = {}) {
  const {model, obsolete} = core();
  obsolete.reject(text, name);
  if (/\.atrium$/i.test(name)) throw Error(obsolete.note);
  const kind = kinds[path.extname(name).toLowerCase()];
  if (!kind) throw Error("Choose a Waffle project folder or its .waffle manifest.");
  return model.parse(text, {...expected, kind});
}

function manifest(text, name) {
  const byteLength = typeof text === "string" ? utf8Length(text) : text.byteLength;
  if (byteLength > oneFile) {
    core().obsolete.reject(text,name);
    throw Error("The native manifest exceeds the preview’s size limit.");
  }
  const file = parse(text, name);
  if (file.header.kind !== "project") throw Error("Choose the .waffle manifest in the project folder.");
  return {file, byteLength, ...core().model.manifest(file)};
}

function snapshot(index, read) {
  const {codec, model} = core(), project = {...index.project, documents: [], library: []};
  let size = index.byteLength;
  for (const ref of index.members) {
    if (!["schematic", "pcb", "drawing", "panel", "library", "block"].includes(ref.kind)) continue;
    const bytes = read(ref.path);
    size += typeof bytes === "string" ? utf8Length(bytes) : bytes.byteLength;
    if (size > totalSize) throw Error("The native design exceeds the VS Code preview's size limit.");
    const file = parse(bytes, ref.path, {id: ref.id});
    codec.checkMemberVersion(index.file, file, ref);
    if (ref.kind === "library") project.library.push(model.library(file));
    else if (ref.kind === "block") (project.layoutBlocks ??= []).push(model.block(file));
    else project.documents.push(model.document(file, {name: ref.name}));
  }
  return project;
}

function sameFile(a,b) {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.size === b.size;
}

function diskBytes(root, relative, observed, headerOnly = false) {
  const actualRoot = fs.realpathSync(root);
  const absolute = path.resolve(actualRoot, relative);
  const inside = path.relative(actualRoot, absolute);
  if (path.isAbsolute(relative) || path.isAbsolute(inside) || inside.split(path.sep)[0] === ".." || fs.realpathSync(absolute) !== absolute) {
    throw Error("A native project member must be an ordinary file inside its selected folder.");
  }
  const entry = fs.lstatSync(absolute, {bigint: true});
  if (!entry.isFile() || entry.nlink !== 1n) throw Error("Choose an ordinary native project member.");
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const held = fs.fstatSync(fd, {bigint: true});
    if (!sameFile(entry,held) || !held.isFile() || held.nlink !== 1n) throw Error("Choose an ordinary native project member.");
    const obsolete = core().obsolete;
    const prefix = Buffer.alloc(Math.min(obsolete.limit, Number(held.size)));
    const length = fs.readSync(fd,prefix,0,prefix.length,0);
    let raw = prefix.subarray(0,length);
    if (!headerOnly) {
      obsolete.reject(raw,relative);
      if (held.size > BigInt(oneFile)) throw Error("The native member exceeds the preview's size limit.");
      raw = Buffer.alloc(Number(held.size));
      prefix.copy(raw,0,0,length);
      let offset = length;
      while (offset < raw.length) {
        const count = fs.readSync(fd,raw,offset,raw.length-offset,offset);
        if (!count) throw Error("The saved project changed during the read. Reload the preview.");
        offset += count;
      }
    }
    const final = fs.lstatSync(absolute, {bigint: true});
    if (!sameFile(held,final) || fs.realpathSync(absolute) !== absolute)
      throw Error("The project changed while the preview was reading it.");
    observed?.set(absolute,held);
    return raw;
  } finally { fs.closeSync(fd); }
}

function diskText(root, relative, observed) {
  return new TextDecoder("utf-8", {fatal: true}).decode(diskBytes(root,relative,observed));
}

function selection(file) {
  if (!fs.statSync(file).isDirectory()) return path.resolve(file);
  const names = fs.readdirSync(file, {withFileTypes: true}).filter(e => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(".waffle"));
  if (names.length === 1) return path.resolve(file,names[0].name);
  const ambiguous = "Choose the .waffle manifest in the project folder.";
  if (!names.length || names.length > 64) throw Error(ambiguous);
  const {codec} = core();
  let selected;
  for (const {name} of names) {
    const prefix = diskBytes(file,name,undefined,true), lf = prefix.indexOf(10);
    if (lf < 0) continue;
    try { codec.parse(prefix.subarray(0,lf+1),{kind:"project"}); }
    catch (error) { if (error instanceof codec.FormatError) continue; throw error; }
    if (selected) throw Error(ambiguous);
    selected = name;
  }
  if (!selected) throw Error(ambiguous);
  return path.resolve(file,selected);
}

function fromDisk(input, currentText, openMember) {
  const file = selection(input), root = path.dirname(file);
  const selected = path.basename(file);
  if (/\.atrium$/i.test(selected)) throw Error(core().obsolete.note);
  const journal = path.join(root, ".waffle", "journal", "active");
  if (fs.existsSync(journal)) {
    throw Error("Open this project in Waffle to finish its pending native save, then reload the preview.");
  }
  const observed = new Map();
  const savedRoot = diskText(root, selected, observed);
  const index = manifest(currentText ?? savedRoot, selected);
  const project = snapshot(index, relative => {
    const saved = diskText(root,relative,observed);
    return openMember?.(path.join(root,relative)) ?? saved;
  });
  for (const [file,pin] of observed) {
    if (!sameFile(pin,fs.lstatSync(file,{bigint:true})) || fs.realpathSync(file) !== file)
      throw Error("The saved project changed during the read. Reload the preview.");
  }
  if (fs.existsSync(journal)) throw Error("The project is being saved. Reload the preview when the save finishes.");
  return {file, index, project};
}

module.exports = {kinds, core, parse, manifest, snapshot, diskText, selection, fromDisk, oneFile, totalSize};
