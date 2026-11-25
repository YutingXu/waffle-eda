"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {createHash} = require("node:crypto");
const entries = require("./sources.json");
const confirmation = require("./confirmation-sources.json");
const fidelity = require("../altium-fidelity/fixtures.json");
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const hash = data => createHash("sha256").update(data).digest("hex");

function fixture(entry) {
  if (!entry.fidelity) return {...entry, directory: path.join(cache, "waffle", "fixed-placement-routing", entry.id, entry.revision)};
  const p = fidelity.projects.find(b => b.id === entry.id);
  const files = p.assets.flatMap(a => a.members || [a]).filter(a => a.role === "license" || a.role === "source" && /\.PcbDoc$/i.test(a.path));
  return {...entry, revision: p.revision, repo: p.upstream.replace("https://github.com/", ""), license: p.license,
    directory: path.join(cache, "waffle", "altium-fidelity", p.id, p.revision),
    files: files.map(a => ({path: a.path || new URL(a.url).pathname, role: a.role === "source" ? "board" : "license", sha256: a.sha256}))};
}

function read(entry) {
  const f = fixture(entry);
  let board;
  for (const asset of f.files) {
    const name = path.basename(asset.path), bytes = fs.readFileSync(path.join(f.directory, name));
    if (hash(bytes) !== asset.sha256) throw Error(f.id + ": SHA-256 mismatch for " + name);
    if (asset.role === "board") board = {name, bytes};
  }
  if (!board || !f.files.some(a => a.role === "license")) throw Error(f.id + ": missing board or licence");
  return board;
}

module.exports = {entries, confirmation, fixture, read, hash};
