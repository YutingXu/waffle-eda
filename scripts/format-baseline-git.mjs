#!/usr/bin/env node
// Measure the compacted format 1.x save in a fresh repo for one frozen input.
// Usage: node scripts/format-baseline-git.mjs [--public-input] [--kicad-global-label] <case-id> <snapshot.waffle>
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {devNull, tmpdir} from "node:os";
import {join} from "node:path";
import {parseArgs} from "node:util";

const require = createRequire(import.meta.url);
for (const module of ["core/model", "compat", "pcb/pcb-appearance", "formats/io", "project/save-cache"]) require(`../app/${module}.js`);
require("./format-baseline/edits.js");
const {Atrium, AtriumCompat, AtriumIO, AtriumSaveCache, WaffleBaselineEdits} = globalThis;
const {MOVE_MM, TRACK_MM, LABEL_SUFFIX} = WaffleBaselineEdits;

const PROJECT_FILE = "project.waffle";
const SAVES = 100;
const COMMIT_EPOCH = 1704067200;
const GIT_CONFIG = [
  "core.autocrlf=false", "core.compression=6", `core.attributesFile=${devNull}`,
  `core.excludesFile=${devNull}`, `core.hooksPath=${devNull}`, "core.logAllRefUpdates=true",
  "commit.gpgSign=false", "gc.auto=0", "gc.cruftPacks=false", "gc.writeCommitGraph=false",
  "gc.reflogExpire=never", "gc.reflogExpireUnreachable=never", "maintenance.auto=false",
  "pack.depth=50", "pack.threads=1", "pack.window=10", "pack.windowMemory=256m", "repack.writeBitmaps=false"
];
const GC = ["gc", "--prune=now"];
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames",
  "--diff-algorithm=myers", "--numstat", "HEAD", "--", PROJECT_FILE];

function repoCommands(directory) {
  // An inherited Git directory, index, filter, or alias must not affect the scratch repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    GIT_AUTHOR_NAME: "Format Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
    GIT_COMMITTER_NAME: "Format Benchmark", GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
  });
  const config = GIT_CONFIG.flatMap(setting => ["-c", setting]);
  const git = args => execFileSync("git", [...config, ...args], {
    cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return {
    git,
    init: () => git(["init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=baseline"]),
    commit(n) {
      const date = `@${COMMIT_EPOCH + n} +0000`;
      env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = date;
      git(["add", "--", PROJECT_FILE]);
      git(["commit", "--quiet", "-m", n === 0 ? "Baseline" : `Small save ${String(n).padStart(3, "0")}`]);
    },
  };
}

function numstat(git) {
  const output = git(DIFF);
  const rows = output ? output.split("\n") : [];
  let additions = 0, deletions = 0;
  for (const row of rows) {
    const [added, deleted] = row.split("\t");
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) throw Error("Git returned a binary diff.");
    additions += Number(added);
    deletions += Number(deleted);
  }
  return {files: rows.length, additions, deletions, linesChanged: additions + deletions};
}

function fileBytes(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += fileBytes(path);
    else if (entry.isFile()) bytes += statSync(path).size;
  }
  return bytes;
}

function storage(git, gitDir) {
  const counts = new Map(git(["count-objects", "-v"]).split("\n").map(line => line.split(": ")));
  return {
    gitBytes: fileBytes(gitDir),
    objectBytes: fileBytes(join(gitDir, "objects")),
    looseObjects: Number(counts.get("count")),
    packedObjects: Number(counts.get("in-pack")),
  };
}

function growth(before, after) {
  return {before, after, increase: {gitBytes: after.gitBytes - before.gitBytes, objectBytes: after.objectBytes - before.objectBytes}};
}

function measure(directory, input, {publicInput, kicadGlobalLabel}) {
  const bytes = readFileSync(input);
  const project = AtriumIO.read(PROJECT_FILE, bytes).project;
  const saver = AtriumSaveCache.create();
  const serialize = () => saver.serialize(AtriumCompat.forSave(project));
  const baseline = serialize();
  if (!bytes.equals(Buffer.from(baseline))) throw Error("Use a frozen, byte-identical current-format save as the baseline.");

  const projectPath = join(directory, PROJECT_FILE);
  const gitDir = join(directory, ".git");
  const {git, init, commit} = repoCommands(directory);
  const save = () => writeFileSync(projectPath, serialize());
  const seedRepo = () => {
    writeFileSync(projectPath, baseline);
    init();
    commit(0);
  };
  function diffEdit(apply, revert, reason) {
    try {
      apply();
      save();
      const diff = numstat(git);
      if (diff.files !== 1) throw Error("A single edit must change the one tracked project file.");
      return {status: "measured", ...diff, reason};
    } finally {
      revert();
      writeFileSync(projectPath, baseline);
    }
  }

  const {part, label, track} = WaffleBaselineEdits.select(project, {kicadGlobalLabel});
  const library = new Map(project.library.map(def => [def.id, def]));
  const initialX = part?.item.x;
  const moveTo = x => Atrium.transformPart(part.doc, part.item, library.get(part.item.def), {x});
  const edits = {};
  seedRepo();
  edits.movePart = part ? diffEdit(() => moveTo(initialX + MOVE_MM), () => moveTo(initialX),
    "Change the X coordinate of one existing PCB component.") : {status: "missing", reason: "No PCB component in the saved input."};
  if (label) {
    const text = label.item.text;
    edits.editNetLabel = diffEdit(() => { label.item.text = text + LABEL_SUFFIX; }, () => { label.item.text = text; },
      label.item.kind === "netlabel" ? "Change the text of one existing schematic net label." :
        "Change one existing KiCad global net label, stored as a Waffle offsheet connector.");
  } else {
    edits.editNetLabel = {status: "missing", reason: "No schematic net-label object in the saved input."};
  }
  edits.addTrack = track ? diffEdit(() => track.doc.items.push(track.item), () => track.doc.items.pop(), track.anchor ?
    "Append one track continuing an existing copper track on its layer and net." : "Append one standalone top-copper track.") :
    {status: "missing", reason: "No PCB document in the saved input."};
  if (serialize() !== baseline || numstat(git).files !== 0) throw Error("The edit probes did not restore the baseline.");

  let history = {status: "missing", reason: "No PCB component to move in the saved input."};
  if (part) {
    const beforeLoose = storage(git, gitDir);
    for (let count = 1; count <= SAVES; count++) {
      moveTo(initialX + count * MOVE_MM);
      save();
      commit(count);
    }
    const commits = Number(git(["rev-list", "--count", "HEAD"]));
    if (commits !== SAVES + 1 || git(["status", "--porcelain"])) throw Error("The save sequence left incomplete Git history.");
    const afterLoose = storage(git, gitDir);
    git(GC);
    const afterPacked = storage(git, gitDir);

    // Measure an independently packed baseline with the same branch, dates, and settings.
    rmSync(gitDir, {recursive: true});
    seedRepo();
    git(GC);
    const beforePacked = storage(git, gitDir);
    if (beforeLoose.packedObjects || afterLoose.packedObjects || beforePacked.looseObjects || afterPacked.looseObjects ||
        beforeLoose.looseObjects !== beforePacked.packedObjects || afterLoose.looseObjects !== afterPacked.packedObjects) {
      throw Error("The Git object counts do not agree before and after packing.");
    }
    history = {status: "measured", saves: SAVES, baselineCommits: 1, finalCommits: commits,
      loose: growth(beforeLoose, afterLoose), packed: growth(beforePacked, afterPacked)};
  }

  return {
    formatVersion: project.formatVersion,
    snapshotBytes: bytes.length,
    ...(publicInput ? {snapshotSha256: createHash("sha256").update(bytes).digest("hex")} : {}),
    gitVersion: git(["--version"]),
    method: {moveMm: MOVE_MM, trackMm: TRACK_MM, commitEpoch: COMMIT_EPOCH, diff: DIFF, pack: GC, gitConfig: GIT_CONFIG},
    edits, history,
  };
}

const {values, positionals} = parseArgs({
  options: {"public-input": {type: "boolean"}, "kicad-global-label": {type: "boolean"}}, allowPositionals: true,
});
const [id, input] = positionals;
if (positionals.length !== 2 || !/^[a-z0-9-]+$/.test(id)) {
  console.error("Usage: node scripts/format-baseline-git.mjs [--public-input] [--kicad-global-label] <case-id> <snapshot.waffle>");
  process.exitCode = 2;
} else {
  const publicInput = !!values["public-input"];
  const directory = mkdtempSync(join(tmpdir(), "waffle-format-git-"));
  try {
    console.log(JSON.stringify({id, ...measure(directory, input, {publicInput, kicadGlobalLabel: !!values["kicad-global-label"]})}));
  } catch (error) {
    console.error(`${id}: ${publicInput ? error.message : "Git baseline failed."}`);
    process.exitCode = 1;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}
