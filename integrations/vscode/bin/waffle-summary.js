#!/usr/bin/env node
"use strict";
// A native manifest and its typed members form each side of this saved project comparison.
const path = require("node:path");
const Folder = require("../lib/folder.js");
const D = require("../lib/diff.js");
const [before, after, extra] = process.argv.slice(2);
if (!before || !after || extra) {
  process.stderr.write("usage: waffle-summary.js BEFORE_PROJECT AFTER_PROJECT\n");
  process.exitCode = 2;
} else {
  try {
    const read = input => input === "/dev/null" ? {documents:[], library:[]} : Folder.fromDisk(input).project;
    process.stdout.write(D.format(D.summarize(read(before),read(after)), {title:path.basename(after)}) + "\n");
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 2; }
}
