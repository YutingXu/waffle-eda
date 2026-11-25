"use strict";
// Uses the macOS app's Desktop and WKWebView with temporary Application Support.
// --app chooses a combined review checkout. --screenshots copies both native window captures.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };

async function nativeDetail(P, files) {
  (await AtriumLazy.need("AtriumPrefs")).set("labs.notebook",true);
  const post = (op, options = {}) => webkit.messageHandlers.harness.postMessage({op, ...options});
  const find = async (f, error) => { const result = await P.until(10000, f); if (!result) throw Error(error); return result; };
  const click = el => { const r = el.getBoundingClientRect(); return P.mouse(r.left + r.width / 2, r.top + r.height / 2); };
  await P.run("__boot_only__");
  try {
    await P.log(!globalThis.AtriumMath, "native extension Detail keeps equation typesetting off startup");
    await find(() => globalThis.AtriumExtensions?.attached, "Extension host did not attach.");
    const install = AtriumExtensions.install(files);
    const confirm = await find(() => [...document.querySelectorAll("dialog.ext-prompt[open] button")].find(b => b.textContent.trim() === "Install"), "Install prompt did not open.");
    await click(confirm); await install;
    await AtriumLazy.need("AtriumPalette");
    for (const theme of ["light", "dark"]) {
      AtriumTheme.setPreset(theme);
      await find(() => document.documentElement.dataset.theme === theme, "Native theme did not apply.");
      await new Promise(r => setTimeout(r, 300)); // Finish the application’s page-wide colour transition before its snapshot.
      AtriumPalette.open("command", null, {entryKey: "command:ext:example.divider:divider"});
      const form = await find(() => document.querySelector("#palette[open] .nav-palette-screen form"), "Calculator Form did not open.");
      await click(form.querySelector('button[type="submit"]'));
      const canvas = await find(() => document.querySelector("#palette[open] [role=math] canvas"), "Equation did not render.");
      await find(() => document.querySelector("#palette .nav-palette-rich-text strong"), "Notebook paragraph did not render.");
      const screen = canvas.closest(".nav-palette-screen");
      const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, inkRed;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i]) ink++;
        if (rgba[i] === 255) inkRed = rgba[i - 3];
      }
      const result = {theme, display: screen.querySelector(".nav-palette-screen-copy")?.textContent, ink, inkRed,
        aria: canvas.parentElement.getAttribute("aria-label"), labels: [...screen.querySelectorAll("strong")].map(n => n.textContent.trim()),
        worker: AtriumCalculations.stats()};
      await P.log(result.display === "3.333 V" && ink > 60 && result.aria.includes("V") && result.labels.join(",") === "Input,Upper,Lower" &&
        result.worker.started > 0 && result.worker.local === 0 && (theme === "light" ? inkRed < 100 : inkRed > 180), "native extension Detail with the real worker in " + theme, result);
      const motions = document.querySelector("#palette").getAnimations({subtree:true}).filter(a => a.effect?.getTiming().iterations !== Infinity);
      await Promise.race([Promise.allSettled(motions.map(a => a.finished)), new Promise(r => setTimeout(r, 450))]);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await post("shot", {name: "extension-detail-" + theme});
      AtriumPalette.close(false);
    }
    const remote = performance.getEntriesByType("resource").map(e => e.name).filter(name => /^https?:/i.test(name));
    await P.log(remote.length === 0, "native extension Detail uses only bundled resources", remote);
  } catch (error) { await P.log(false, "native extension Detail completed", error.message || String(error)); }
  return {finished: true};
}

function run() {
  if (process.platform !== "darwin") throw Error("This check uses the macOS application harness.");
  const root = path.resolve(arg("--app") || path.join(__dirname, "../.."));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "waffle-extension-detail-"));
  const cache = fs.mkdtempSync(path.join(os.homedir(), "Library", "Caches", "waffle-extension-detail-"));
  try {
    const harness = path.join(root, "native", "tests", "macos-harness"), run = path.join(work, "run");
    const env = {...process.env, HARNESS_INSTALL: cache, HARNESS_OUT: path.join(work, "build")};
    const pkg = path.join(root, "extensions", "examples", "palette-calculator");
    const files = Object.fromEntries(["waffle-extension.json", "main.js"].map(name => [name, fs.readFileSync(path.join(pkg, name), "utf8")]));
    const probe = path.join(work, "detail.js");
    fs.writeFileSync(probe, 'const first = globalThis.__uiProbes; globalThis.__uiProbes = {...first, run: () => (' + nativeDetail.toString() + ')(first,' + JSON.stringify(files) + ')};');
    execFileSync(path.join(harness, "build.sh"), {env, stdio: "ignore"});
    const output = execFileSync(path.join(cache, "WaffleHarness.app", "Contents", "MacOS", "Waffle"), {env: {...env, HARNESS_WORK: run, HARNESS_SUITE: "ui",
      HARNESS_EPHEMERAL: "1", HARNESS_PROBES: [path.join(harness, "ui-probes.js"), probe].join(":")}, timeout: 150000, encoding: "utf8"});
    console.log(output.split("\n").filter(s => /^(PASS|FAIL|RESULT|NOTE  WebKit)/.test(s)).join("\n"));
    if (!/^RESULT ok/m.test(output) || /^FAIL/m.test(output)) throw Error("The native extension Detail check failed.");
    const screenshots = arg("--screenshots");
    if (screenshots) {
      fs.mkdirSync(screenshots, {recursive: true});
      for (const theme of ["light", "dark"]) {
        const name = "extension-detail-" + theme + ".png";
        fs.copyFileSync(path.join(run, "shots", name), path.join(screenshots, name));
      }
    }
  } finally {
    fs.rmSync(work, {force: true, recursive: true});
    fs.rmSync(cache, {force: true, recursive: true});
  }
}
if (require.main === module) {
  try { run(); } catch (e) { if (e.stdout) console.error(String(e.stdout)); console.error(e.message); process.exitCode = 1; }
}
