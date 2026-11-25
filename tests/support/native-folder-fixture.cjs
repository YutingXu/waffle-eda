"use strict";
const path = require("node:path");
const {execFileSync} = require("node:child_process");

const transport = path.join(__dirname, "native-folder-fixture.py");

// Compile the macOS fixture host once per copied environment. swiftc inherits
// the process environment and receives only cwd. A selected host is reused.
function hostEnv(output, cwd) {
  const env = {...process.env};
  if (process.platform === "darwin" && !env.WAFFLE_FOLDER_MCP_HOST) {
    env.WAFFLE_FOLDER_MCP_HOST = output;
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/macos/FolderTransactions.swift",
      "native/tests/folder-transaction/mcp-main.swift", "-o", env.WAFFLE_FOLDER_MCP_HOST], {cwd});
  }
  return env;
}

// One FolderFiles snapshot or commit. The caller chooses Python, the mcp
// directory, and the manifest. The copied environment reaches the child.
function folderFiles(env, python, mcp, manifest) {
  return request => JSON.parse(execFileSync(python, ["-B", transport, mcp, manifest], {
    input: JSON.stringify(request), encoding: "utf8", env
  }));
}

module.exports = {hostEnv, folderFiles};
