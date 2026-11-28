"use strict";
// Before/after evidence for UI library migrations (docs/ui-library.md › Migrating a family).
// Opens the same settled surfaces from an app folder in light, dark and touch, and records for each
// one a screenshot and the computed style of every visible element (box, colours, type, borders,
// radius, shadow). Run it on the base commit and on the change, then compare:
//
//   node tests/ui/browser-ui-snapshots.cjs --app /base/app --out /tmp/before
//   node tests/ui/browser-ui-snapshots.cjs --out /tmp/after --compare /tmp/before
//
// --compare reports, per surface, the pixels that differ and the elements whose computed style
// changed, and exits 1 on any difference not listed with --allow SURFACE (repeatable).
// --only NAME limits the run to surfaces whose name contains NAME. CHROME=/path picks the browser.
// Without --out the captures go to a new temporary folder, named at the end, never into the checkout.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const all = name => argv.flatMap((a, i) => a === name ? [argv[i + 1]] : []);
const APP = path.resolve(arg("--app") || path.join(__dirname, "../../app"));
const OUT_ARG = arg("--out");
const BASE = arg("--compare") && path.resolve(arg("--compare"));
const ONLY = arg("--only");
const ALLOW = new Set(all("--allow"));

const PROFILES = [
  {name:"light", theme:"light", touch:false, viewport:{width:1440, height:900}},
  {name:"dark", theme:"dark", touch:false, viewport:{width:1440, height:900}},
  {name:"touch", theme:"light", touch:true, viewport:{width:1280, height:800}},
];
// Each surface: the document kind to open and the editor action that shows it (none = the editor).
// Chosen to cover every surface a library migration touched, plus the settled chrome around them.
const SURFACES = [
  {name:"start-page", start:true},
  {name:"pcb-editor", kind:"pcb"},
  {name:"schematic-editor", kind:"schematic"},
  {name:"bom", kind:"schematic", action:"bom"},
  {name:"constraints", kind:"pcb", action:"constraints"},
  {name:"variants", kind:"schematic", action:"variants"},
  {name:"find-replace", kind:"schematic", action:"find-replace"},
  {name:"messages", kind:"pcb", action:"show-problems"},
  {name:"navigator", kind:"pcb", action:"navigator-panel"},
  {name:"filter", kind:"pcb", action:"query-panel"},
  {name:"nets", kind:"pcb", action:"nets-panel"},
  {name:"pcb-list", kind:"pcb", action:"pcb-list"},
  {name:"scripting", kind:"pcb", action:"scripting-console"},
  {name:"library", kind:"schematic", action:"library-panel"},
  {name:"clipboard", kind:"pcb", action:"clipboard-panel"},
  {name:"history", kind:"pcb", action:"history-panel"},
  {name:"view-config", kind:"pcb", action:"view-config"},
  {name:"selection-memory", kind:"pcb", action:"selection-memory"},
  {name:"minimap", kind:"pcb", action:"minimap"},
  {name:"rule-sets", kind:"pcb", action:"rule-sets"},
  {name:"output-jobs", kind:"pcb", action:"output-jobs"},
  {name:"preferences", kind:"pcb", action:"preferences-page"},
  {name:"shortcuts", kind:"pcb", action:"shortcuts"},
].filter(s => !ONLY || s.name.includes(ONLY));

const PROPS = ["display", "position", "box-sizing", "width", "height", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-left-color", "border-top-style", "border-top-left-radius", "border-bottom-right-radius", "background-color", "background-image",
  "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-decoration-line", "opacity", "box-shadow",
  "outline-style", "cursor", "user-select", "mask-image", "gap", "align-items", "justify-content", "white-space", "visibility", "transform"];

async function settle(page) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForTimeout(450);
}
async function open(page, surface, profile) {
  await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, profile.theme);
  const start = page.locator("dialog.sp-dialog[open]");
  await start.waitFor();
  if (surface.start) return settle(page);
  await start.locator("[data-start-action=demo]").click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  const kind = surface.kind;
  await page.evaluate(async kind => {
    const host = AtriumNavHost;
    if (host.doc().kind !== kind) {
      // The demo opens on its board; its other tab is the schematic.
      [...document.querySelectorAll(".document-tab")].find(t => !t.matches("[aria-selected=true]"))?.click();
    }
    await new Promise(r => setTimeout(r, 300));
  }, kind);
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  if (surface.action) {
    await page.evaluate(async action => {
      await AtriumLazy.need(AtriumLazy.forAction(action, AtriumNavHost.doc().kind) || []);
      await AtriumNavHost.act(action);
    }, surface.action);
  }
  await settle(page);
  // Shared state that varies by run, not by code: the caret, clocks and timestamps.
  await page.mouse.move(0, profile.viewport.height - 1);
  await page.evaluate(() => { document.activeElement?.blur?.(); delete document.documentElement.dataset.focusNav; document.getElementById("waffle-tooltip")?.setAttribute("hidden", ""); });
  await settle(page);
  if (surface.action === "output-jobs") {
    await page.locator('dialog.rel-dialog[open] #rel-tab-outputs[aria-selected="true"]').waitFor();
    // The Sensor board has two acid-trap findings, and its Problems button remains visible below Release.
    const label = await page.evaluate(() => AtriumI18n.t("checks.status.open", {
      summary: AtriumI18n.t("checks.status.many", {count:2})
    }));
    await page.locator('#status-problems[aria-busy="false"]').and(page.getByLabel(label, {exact:true})).waitFor();
  }
}
async function record(page) {
  return page.evaluate(PROPS => {
    const out = {}, seen = new Map();
    const key = n => {
      const parts = [];
      for (let e = n; e && e !== document.documentElement; e = e.parentElement) {
        const id = e.id ? "#" + e.id : "";
        const cls = [...e.classList].filter(c => !/^(is-|ui-|pcb-edit-chip$)/.test(c)).sort().join(".");
        parts.unshift(e.localName + id + (cls ? "." + cls : ""));
        if (id) break;
      }
      const k = parts.join(">"), n2 = (seen.get(k) || 0) + 1; seen.set(k, n2);
      return k + "[" + n2 + "]";
    };
    for (const n of document.querySelectorAll("body *")) {
      if (!n.getClientRects().length || n.closest("svg") && n.localName !== "svg" || n.closest("#waffle-tooltip")) continue;
      const r = n.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const cs = getComputedStyle(n), st = {box:[r.left, r.top, r.width, r.height].map(v => Math.round(v * 2) / 2).join(",")};
      for (const p of PROPS) st[p] = cs.getPropertyValue(p);
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(n, pseudo);
        if (ps.content && ps.content !== "none" && ps.content !== "normal")
          st[pseudo] = ["content", "width", "height", "background-color", "mask-image", "inset", "transform"].map(p => ps.getPropertyValue(p)).join("|");
      }
      out[key(n)] = st;
    }
    return out;
  }, PROPS);
}
async function pixelDiff(page, a, b) {
  const data = f => "data:image/png;base64," + fs.readFileSync(f).toString("base64");
  return page.evaluate(async ([a, b]) => {
    const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return {size:true, pixels:-1};
    const px = img => { const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const p = px(x), q = px(y); let n = 0, box = null;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) {
        n++; const j = i / 4, cx = j % x.width, cy = Math.floor(j / x.width);
        box = box ? [Math.min(box[0], cx), Math.min(box[1], cy), Math.max(box[2], cx), Math.max(box[3], cy)] : [cx, cy, cx, cy];
      }
    }
    return {pixels:n, box};
  }, [data(a), data(b)]);
}

module.exports = async function snapshots(browser) {
  const OUT = OUT_ARG ? path.resolve(OUT_ARG) : fs.mkdtempSync(path.join(os.tmpdir(), "waffle-ui-snapshots-"));
  fs.mkdirSync(OUT, {recursive:true});
  const failures = [], report = [];
  for (const profile of PROFILES) {
    for (const surface of SURFACES) {
      const page = await browser.newPage({viewport:profile.viewport, hasTouch:profile.touch, reducedMotion:"reduce", deviceScaleFactor:1});
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.addInitScript(() => {
        // Fixed clock so relative times ("2 min ago") and the caret do not differ between runs.
        const t0 = Date.UTC(2026, 10, 20, 12, 0, 0); const Real = Date;
        globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [t0])); } static now() { return t0; } };
      });
      const name = profile.name + "-" + surface.name;
      try {
        await open(page, surface, profile);
        await page.screenshot({path:path.join(OUT, name + ".png"), caret:"hide", animations:"disabled"});
        fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify(await record(page)));
        if (errors.length) failures.push(name + ": page errors " + errors.join(" | "));
        if (BASE) {
          const before = path.join(BASE, name + ".png");
          if (!fs.existsSync(before)) { report.push(name + ": no baseline"); continue; }
          const diff = await pixelDiff(page, before, path.join(OUT, name + ".png"));
          const was = JSON.parse(fs.readFileSync(path.join(BASE, name + ".json"), "utf8")), now = JSON.parse(fs.readFileSync(path.join(OUT, name + ".json"), "utf8"));
          const styles = [];
          for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
            if (!was[k] || !now[k]) { styles.push((was[k] ? "- " : "+ ") + k); continue; }
            const changed = Object.keys(now[k]).filter(p => was[k][p] !== now[k][p]);
            if (changed.length) styles.push("~ " + k + " " + changed.map(p => p + ": " + was[k][p] + " → " + now[k][p]).join("; "));
          }
          // Layout mechanism only (flex instead of block, say) with identical pixels is not a visual change.
          const MECHANISM = /^(display|gap|align-items|justify-content|white-space)$/;
          const visual = styles.filter(line => !line.startsWith("~ ") || line.split("; ").some(part => !MECHANISM.test(part.replace(/^~ \S+ /, "").split(":")[0])));
          const same = diff.pixels === 0 && !visual.length;
          report.push(name + ": " + (same ? (styles.length ? "identical pixels, " + styles.length + " layout-mechanism changes" : "identical") : diff.pixels + " px differ" + (diff.box ? " in " + diff.box.join(",") : "") + ", " + styles.length + " style changes"));
          if (styles.length) fs.writeFileSync(path.join(OUT, name + ".diff.txt"), styles.join("\n") + "\n");
          if (!same) {
            if (!ALLOW.has(surface.name)) failures.push(name + ": " + diff.pixels + " px, styles:\n  " + styles.slice(0, 12).join("\n  "));
          }
        }
      } catch (error) { failures.push(name + ": " + error.message.split("\n")[0]); }
      finally { await page.close(); }
    }
  }
  fs.writeFileSync(path.join(OUT, "report.txt"), report.join("\n") + "\n" + (failures.length ? "\nFAILURES\n" + failures.join("\n") + "\n" : ""));
  console.log(report.join("\n"));
  assert.equal(failures.length, 0, failures.join("\n") + "\nCaptures in " + OUT);
  console.log("PASS UI snapshots: " + PROFILES.length * SURFACES.length + " surface captures" + (BASE ? " match the baseline" : " recorded in " + OUT));
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => { console.error(error.message); process.exitCode = 1; });
}
