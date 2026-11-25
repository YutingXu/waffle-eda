"use strict";

// Focused witness for the shared standalone Chromium envelope.
// Injects a launcher. Does not start Chromium, the full suite, or the startup budget.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const helperPath = path.join(__dirname, "standalone-chromium.cjs");
const helperText = fs.readFileSync(helperPath, "utf8");
const mutant = process.argv.includes("--mutant");
assert.equal(helperText.split("await browser.close()").length - 1, 1, "one close in the shared envelope");
const helperSource = mutant ? helperText.replace("await browser.close()", "await Promise.resolve()") : helperText;

function loadHelper(source) {
  let chromium;
  const module = {exports: {}};
  vm.runInNewContext(source, {
    require(name) {
      if (name !== "playwright-core") throw Error("unexpected require " + name);
      return {chromium};
    },
    module,
    exports: module.exports,
    __dirname,
    __filename: helperPath,
  }, {filename: helperPath});
  if (typeof module.exports !== "function") throw Error("standalone chromium export is not a function");
  return {
    use(value) { chromium = value; },
    call(...args) { return module.exports(...args); },
  };
}

const helper = loadHelper(helperSource);

function plain(value) {
  if (typeof value === "function" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Array.from(value, plain);
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = plain(value[key]);
  return copy;
}

function nodeArgv(extra = []) {
  return ["node", "suite.js", ...extra];
}

const fileAccess = {channel: "chrome", args: ["--allow-file-access-from-files"]};
const channel = {channel: "chrome"};
const headlessChannel = {headless: true, channel: "chrome"};

function chromeEnvModes() {
  return [
    {name: "default", argv: nodeArgv(), env: {}, launch: channel},
    {name: "env", argv: nodeArgv(), env: {CHROME: "env chrome"}, launch: {executablePath: "env chrome"}},
    {name: "ignored-flag", argv: nodeArgv(["--executable", "caller chrome"]), env: {}, launch: channel},
    {name: "empty-env", argv: nodeArgv(), env: {CHROME: ""}, launch: channel},
  ];
}

function ignoredEnv(launch) {
  return [
    {name: "default", argv: nodeArgv(), env: {}, launch},
    {name: "ignored-env", argv: nodeArgv(["--executable", "caller chrome"]), env: {CHROME: "env chrome"}, launch},
  ];
}

const policies = {
  panel: {
    report: "exit",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: headlessChannel},
      {name: "env-ignored", argv: nodeArgv(), env: {CHROME: "env chrome"}, launch: headlessChannel},
      {name: "executable", argv: nodeArgv(["--executable", "caller chrome"]), env: {CHROME: "env chrome"}, launch: {headless: true, executablePath: "caller chrome"}},
    ],
  },
  chromeEnv: {report: "code", modes: chromeEnvModes()},
  fileAccess: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: fileAccess},
      {name: "env", argv: nodeArgv(), env: {CHROME: "env chrome"}, launch: {executablePath: "env chrome"}},
      {name: "ignored-flag", argv: nodeArgv(["--executable", "caller chrome"]), env: {}, launch: fileAccess},
      {name: "empty-env", argv: nodeArgv(), env: {CHROME: ""}, launch: fileAccess},
    ],
  },
  gallery: {report: "message", modes: chromeEnvModes()},
  fixedExit: {report: "exit", modes: ignoredEnv(headlessChannel)},
  preferences: {report: "code", modes: ignoredEnv({channel: "chrome", headless: true})},
  workbench: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: channel, via: "exports"},
      {name: "chrome-only", argv: nodeArgv(["--chrome-only"]), env: {CHROME: "env chrome"}, launch: channel, via: "editorChrome"},
      {name: "menus-only", argv: nodeArgv(["--menus-only"]), env: {}, launch: channel, via: "projectMenus"},
      {name: "chrome-wins", argv: nodeArgv(["--menus-only", "--chrome-only"]), env: {}, launch: channel, via: "editorChrome"},
    ],
  },
  editorReport: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: channel, suite: {report: undefined}},
      {name: "env", argv: nodeArgv(), env: {CHROME: "env chrome", ATRIUM_EDITOR_CHROME_REPORT: "report.json"}, launch: {executablePath: "env chrome"}, suite: {report: "report.json"}},
      {name: "ignored-flag", argv: nodeArgv(["--executable", "caller chrome"]), env: {}, launch: channel, suite: {report: undefined}},
    ],
  },
  canvas: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: channel, suite: {app: undefined}},
      {name: "explicit", argv: nodeArgv(["/my/app"]), env: {CHROME: "env chrome"}, launch: {executablePath: "env chrome"}, suite: {app: "/my/app"}},
    ],
  },
  access: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: channel, suite: {screenshotDir: undefined}},
      {name: "env", argv: nodeArgv(), env: {CHROME: "env chrome"}, launch: {executablePath: "env chrome"}, suite: {screenshotDir: undefined}},
      {name: "flags", argv: nodeArgv(["--executable", "caller chrome", "--snapshots", "snaps"]), env: {CHROME: "env chrome"}, launch: {executablePath: "caller chrome"}, suite: {screenshotDir: "snaps"}},
    ],
  },
  palette: {
    report: "code",
    modes: [
      {name: "default", argv: nodeArgv(), env: {}, launch: channel, suite: {capture: undefined}},
      {name: "env", argv: nodeArgv(), env: {CHROME: "env chrome", ATRIUM_PALETTE_CAPTURES: "caps"}, launch: {executablePath: "env chrome"}, captureDir: "caps"},
    ],
  },
};

const callers = [
  ["editor/browser-panel-chrome.js", "panel"],
  ["editor/browser-inline-stack.js", "panel"],
  ["editor/browser-messages-fonts.js", "panel"],
  ["editor/browser-menu-toggle.js", "panel"],
  ["editor/browser-motion-contract.js", "chromeEnv"],
  ["editor/browser-rare-motion.js", "chromeEnv"],
  ["editor/browser-status-bar.js", "chromeEnv"],
  ["editor/browser-editor-chrome.js", "editorReport"],
  ["editor/browser-canvas-hover.js", "canvas"],
  ["editor/browser-no-quirks.js", "fileAccess"],
  ["editor/browser-focus-rings.js", "fileAccess"],
  ["editor/browser-panels-menu.js", "fileAccess"],
  ["editor/browser-accessibility.js", "access"],
  ["editor/browser-palette-view.js", "palette"],
  ["ui/browser-ui-kit.js", "chromeEnv"],
  ["ui/browser-ui-gallery.cjs", "gallery"],
  ["ui/browser-ui-snapshots.cjs", "gallery"],
  ["history/browser-history-refs.js", "chromeEnv", {via: "run"}],
  ["editor/browser-search-keys.js", "fixedExit", {log: "search keys: ok"}],
  ["editor/browser-appbar-contrast.js", "fixedExit", {log: "appbar contrast: ok"}],
  ["project/browser-split-controls.js", "fixedExit", {log: "split controls: ok"}],
  ["editor/browser-workbench-tree.js", "workbench"],
  ["editor/browser-preferences-layout.js", "preferences"],
];

function specFor(entry) {
  const spec = {...policies[entry[1]], ...(entry[2] || {})};
  spec.modes = policies[entry[1]].modes;
  return spec;
}

async function runCaller(rel, {argv, env, reject = false, asMain = true}) {
  const full = path.join(__dirname, "..", rel);
  const source = fs.readFileSync(full, "utf8");
  const label = "tests/" + rel;
  assert.equal(source.includes("chromium.launch"), false, label + " restored chromium.launch");
  assert.equal(source.includes('require("playwright-core")'), false, label + " restored playwright-core");
  assert.equal(source.includes("require('playwright-core')"), false, label + " restored playwright-core");
  const at = source.lastIndexOf("\nif (require.main");
  assert.ok(at > 0, label);
  const block = source.slice(at + 1);
  assert.equal(block.includes('require("../support/standalone-chromium.cjs")'), true, label);
  const trace = [];
  const proc = {argv, env, exitCode: 0, exit(code) { trace.push(["exit", code]); }};
  const finish = via => async (browser, options) => {
    trace.push(["run", {via, options: plain(options)}]);
    if (reject) throw Error("deliberate scenario rejection");
  };
  const callerModule = {exports: finish("exports")};
  let pending = null;
  function localRequire(name) {
    if (name !== "../support/standalone-chromium.cjs") throw Error(label + " unexpected require " + name);
    return (...args) => {
      pending = helper.call(...args);
      return pending;
    };
  }
  localRequire.main = asMain ? callerModule : {exports: {}};
  helper.use({
    async launch(options) {
      trace.push(["launch", plain(options)]);
      return {async close() { trace.push(["close"]); }};
    },
  });
  vm.runInNewContext(block, {
    require: localRequire,
    module: callerModule,
    process: proc,
    console: {
      log(...args) { trace.push(["log", args.join(" ")]); },
      error(value) {
        trace.push(["error", typeof value === "string" ? "message" : "error", typeof value === "string" ? value : value && value.message]);
      },
    },
    path,
    editorChrome: finish("editorChrome"),
    projectMenus: finish("projectMenus"),
    run: finish("run"),
  }, {filename: rel});
  if (pending) await pending;
  return {trace, exitCode: proc.exitCode};
}

function names(trace) {
  return trace.map(row => row[0]);
}

function checkSuccess(rel, spec, mode, result) {
  const label = "tests/" + rel + " " + mode.name;
  const expected = spec.log ? ["launch", "run", "log", "close"] : ["launch", "run", "close"];
  assert.deepEqual(names(result.trace), expected, "One standalone lifecycle for " + label);
  assert.equal(result.trace.filter(row => row[0] === "close").length, 1, label);
  assert.deepEqual(result.trace[0][1], mode.launch, label + " launch");
  const run = result.trace[1][1];
  assert.equal(run.via, mode.via || spec.via || "exports", label + " suite");
  if (mode.captureDir) {
    assert.deepEqual(Object.keys(run.options), ["capture"], label);
    assert.equal(typeof run.options.capture, "function", label);
    const shots = [];
    run.options.capture({screenshot(opts) { shots.push(plain(opts)); }}, "swatch");
    assert.deepEqual(shots, [{path: path.join(mode.captureDir, "swatch.png"), animations: "disabled"}], label);
  } else if (mode.suite !== undefined) {
    assert.deepEqual(run.options, mode.suite, label + " suite options");
  } else {
    assert.equal(run.options, undefined, label + " suite options");
  }
  if (spec.log) assert.equal(result.trace[2][1], spec.log, label);
  assert.equal(result.exitCode, 0, label);
}

async function checkRejection(rel, spec) {
  const label = "tests/" + rel;
  const rejected = await runCaller(rel, {argv: nodeArgv(), env: {}, reject: true});
  const error = rejected.trace.find(row => row[0] === "error");
  if (spec.report === "exit") {
    assert.deepEqual(names(rejected.trace), ["launch", "run", "close", "error", "exit"], "Rejected launch cleanup for " + label);
    assert.deepEqual(rejected.trace.at(-1), ["exit", 1], label);
    assert.equal(rejected.exitCode, 0, label);
    assert.equal(error[1], "error", label);
  } else {
    assert.deepEqual(names(rejected.trace), ["launch", "run", "close", "error"], "Rejected launch cleanup for " + label);
    assert.equal(rejected.exitCode, 1, label);
    assert.equal(error[1], spec.report === "message" ? "message" : "error", label);
  }
  assert.equal(error[2], "deliberate scenario rejection", label);
  assert.equal(rejected.trace.some(row => row[0] === "log"), false, label);
  assert.equal(rejected.trace.filter(row => row[0] === "close").length, 1, label);
}

async function main() {
  assert.equal(callers.length, 23);
  assert.equal(new Set(callers.map(entry => entry[0])).size, 23);
  if (mutant) {
    await checkRejection("editor/browser-panel-chrome.js", policies.panel);
    throw Error("mutant still closed the browser");
  }
  for (const entry of callers) {
    const spec = specFor(entry);
    for (const mode of spec.modes) {
      const result = await runCaller(entry[0], {argv: mode.argv, env: mode.env});
      checkSuccess(entry[0], spec, mode, result);
    }
    await checkRejection(entry[0], spec);
    const quiet = await runCaller(entry[0], {argv: nodeArgv(), env: {}, asMain: false});
    assert.deepEqual(quiet.trace, [], "tests/" + entry[0] + " stays quiet unless it is the main module");
  }
  console.log("23 standalone callers; explicit and default launch precedence; one close on success and rejection; exit and exitCode reporting");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
