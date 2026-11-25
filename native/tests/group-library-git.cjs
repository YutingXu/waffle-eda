"use strict";
// Exercise the same append-only files the GUI writes and reads in a real disposable Git
// checkout. Separate branches edit one component; Git keeps both candidates for visual review.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {execFileSync} = require("node:child_process");
for (const m of ["core/model", "library/library-store", "library/library-panel", "library/group-library"]) require("../../app/" + m + ".js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrium-group-git-"));
const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
  "-c", "core.hooksPath=" + os.devNull, ...args], {cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
async function run() {
  const Core = AtriumGroupLibrary, info = {id: "group-fixture", name: "Group fixture"}, author = {...await Core.newSigningKey(), name: "Fixture"};
  const source = {kind: "fixture", attribution: {credit: "Fixture contributors", licence: "CC0-1.0", sourceUrl: "https://example.invalid/fixture"}};
  const def = {id: "D", name: "Test diode", prefix: "D", source, symbol: {pins: [{number: "1", x: 0, y: 0}], shapes: []}};
  git("init", "--quiet", "-b", "fixture");
  const config = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  function commit(group, msg) {
    for (const f of Core.gitFiles(group)) {
      const p = path.join(dir, f.name); fs.mkdirSync(path.dirname(p), {recursive: true});
      if (fs.existsSync(p)) assert.equal(fs.readFileSync(p, "utf8"), f.data); else fs.writeFileSync(p, f.data);
    }
    git("add", "waffle-groups"); git("commit", "--quiet", "-m", msg);
  }
  const group = Core.create(info), base = await group.propose(def, {author, note: "Initial"});
  await group.decide(group.preview(base.key), "approved", author); commit(group, "Base");
  const branch = Core.create(info, group);
  git("checkout", "--quiet", "-b", "variant");
  const right = await branch.propose({...def, value: "second"}, {author, parents: [base.key], note: "Second"});
  commit(branch, "Second edit"); git("checkout", "--quiet", "fixture");
  const left = await group.propose({...def, value: "first"}, {author, parents: [base.key], note: "First"});
  await group.decide(group.preview(left.key), "approved", author); commit(group, "First edit");
  git("merge", "--quiet", "--no-edit", "variant");
  const files = git("ls-files", "waffle-groups").trim().split("\n").map(name => ({name, text: () => fs.readFileSync(path.join(dir, name), "utf8")}));
  const [read] = await Core.readGit(files); await group.receive([...read.events.values()]);
  assert.equal(read.heads.size, 0);
  assert.deepEqual(read.events.get(right.key).def.source, source);
  assert.equal(group.preview(right.key).conflict, true);
  assert.equal(group.heads.get("D"), left.key);
  assert.equal(git("status", "--porcelain"), ""); assert.equal(fs.readFileSync(path.join(dir, ".git", "config"), "utf8"), config);
  console.log("PASS Git working tree, divergent branch merge, portable attribution and stable config");
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(dir, {recursive: true, force: true}));
