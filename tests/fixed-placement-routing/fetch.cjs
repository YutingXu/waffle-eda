"use strict";
// Explicit cache preparation only. The experiment itself has no network operations.
const fs = require("node:fs"), path = require("node:path");
const {entries, confirmation, fixture, read, hash} = require("./sources.cjs");
async function main() {
  const all=[...entries,...confirmation];
  if(process.argv.includes("--offline")) {
    for(const b of all){read(b);console.log("Verified",b.id);}
    return;
  }
  // Use the existing zip and licence verification for just the two Altium projects in this experiment.
  for(const entry of entries.filter(b=>b.fidelity)) {
    const f=fixture(entry), missing=f.files.some(a=>!fs.existsSync(path.join(f.directory,path.basename(a.path))));
    if(missing) {
      const script=["from fetch import DEFAULT_CACHE, manifest, verified","import sys",
        "p = next(p for p in manifest() if p['id'] == sys.argv[1])","verified(p, DEFAULT_CACHE, False)"].join("\n");
      require("node:child_process").execFileSync("python3",["-c",script,entry.id],{cwd:path.join(__dirname,"..","altium-fidelity"),stdio:"inherit"});
    }
    read(entry);
    console.log("Verified",f.id,f.revision,f.license);
  }
  for (const entry of [...entries, ...confirmation].filter(b => !b.fidelity)) {
    const f = fixture(entry);
    fs.mkdirSync(f.directory, {recursive: true});
    for (const asset of f.files) {
      const file = path.join(f.directory, path.basename(asset.path));
      if (fs.existsSync(file)) continue;
      const url = "https://raw.githubusercontent.com/" + f.repo + "/" + f.revision + "/" + asset.path.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
      if (!response.ok) throw Error(f.id + ": HTTP " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== asset.sha256) throw Error(f.id + ": SHA-256 mismatch");
      fs.writeFileSync(file, bytes, {flag: "wx"});
    }
    read(entry);
    console.log("Verified", f.id, f.revision, f.license);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
