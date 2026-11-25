"use strict";
// The UI library's own regression test (docs/ui-library.md). Opens the living gallery
// (app/index.html#ui-gallery) in light, dark and touch and checks that
//   1. every component family documented in docs/ui-library.md has a gallery section and vice versa;
//   2. nothing breaks the native-behaviour policies: no pointing-hand or grab cursor on controls,
//      no selectable chrome text, no focus ring after a pointer press, a ring for keyboard focus;
//   3. each specimen's computed face (colours, borders, radius, padding, type, shadow) matches
//      tests/maintenance/ui-gallery-styles.json, so a change to the library's look is deliberate.
// Options: --out DIR writes full screenshots (light, dark, touch); --docs rewrites the per-family
// images in docs/ui-library/; --update rewrites tests/maintenance/ui-gallery-styles.json after a deliberate change.
// Run: node tests/ui/browser-ui-gallery.cjs   (CHROME=/path/to/chrome to choose the browser)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] || true; };
const STYLES = path.join(__dirname, "../maintenance/ui-gallery-styles.json");
const FACE = ["background-color", "color", "border-top-width", "border-top-style", "border-top-color", "border-top-left-radius", "padding-top", "padding-left",
  "font-size", "font-weight", "min-height", "box-shadow", "opacity", "cursor", "user-select"];
const PROFILES = [
  {name:"light", theme:"light", touch:false, viewport:{width:1280, height:900}},
  {name:"dark", theme:"dark", touch:false, viewport:{width:1280, height:900}},
  {name:"touch", theme:"light", touch:true, viewport:{width:820, height:1000}},
];

function documented() {
  const doc = fs.readFileSync(path.join(ROOT, "docs/ui-library.md"), "utf8");
  return [...doc.matchAll(/<a id="([a-z-]+)"><\/a>/g)].map(m => m[1]);
}

async function open(page, profile) {
  await page.goto(pathToFileURL(path.join(ROOT, "app/index.html")).href + "#ui-gallery");
  await page.locator(".ui-gallery").waitFor();
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, profile.theme);
  // The Start page opens on launch; the gallery closes it.
  await page.waitForFunction(() => !document.querySelector("dialog.sp-dialog[open]") && document.querySelector(".ui-gallery-thumbs .ui-thumb"), null, {timeout:8000});
  await page.evaluate(() => document.fonts.ready);
}

module.exports = async function gallery(browser) {
  const failures = [], styles = {}, out = opt("--out"), docs = opt("--docs");
  const families = documented();
  for (const profile of PROFILES) {
    const page = await browser.newPage({viewport:profile.viewport, hasTouch:profile.touch, reducedMotion:"reduce", deviceScaleFactor:1});
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    try {
      await open(page, profile);
      const shown = await page.evaluate(() => [...document.querySelectorAll(".ui-gallery-family")].map(s => s.dataset.family));
      if (profile.name === "light") {
        const missing = families.filter(f => !shown.includes(f)), extra = shown.filter(f => !families.includes(f));
        if (missing.length || extra.length) failures.push("gallery and docs/ui-library.md disagree: missing " + missing.join(",") + "; undocumented " + extra.join(","));
      }
      // Native-behaviour policies on every specimen.
      const quirks = await page.evaluate(() => {
        const out = [];
        for (const n of document.querySelectorAll(".ui-gallery-stage *")) {
          if (!n.getClientRects().length) continue;
          const cs = getComputedStyle(n), name = n.localName + "." + [...n.classList].join(".");
          const orbit = n.matches("canvas.ui-viewport[data-interaction=orbit]");
          if (orbit && cs.cursor !== "grab") out.push("orbit cursor " + cs.cursor + " on " + name);
          if (!orbit && /pointer|grab/.test(cs.cursor) && !n.matches("a[href]")) out.push("cursor " + cs.cursor + " on " + name);
          const field = n.closest("input,textarea,[contenteditable=true],.ui-selectable,pre,code,output");
          if (!field && cs.userSelect !== "none" && [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) out.push("selectable text " + name);
        }
        return [...new Set(out)];
      });
      failures.push(...quirks.map(q => profile.name + ": " + q));
      // A pointer press never shows a ring; keyboard focus always does.
      const button = page.locator("#ui-button .ui-button").first();
      await button.click();
      const pressed = await button.evaluate(n => getComputedStyle(n).outlineStyle);
      if (pressed !== "none") failures.push(profile.name + ": focus ring after a pointer press (" + pressed + ")");
      // Reach each focus specimen with the keyboard (Shift+Tab, Tab), as a user would.
      const rings = [];
      const targets = page.locator("[data-gallery-focus]");
      for (let i = 0, n = await targets.count(); i < n; i++) {
        const spec = targets.nth(i);
        const target = (await spec.evaluate(n => n.matches("button,input,select,textarea"))) ? spec : spec.locator("button,input").first();
        await target.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await target.evaluate(n => {
          const cs = getComputedStyle(n);
          return n === document.activeElement && document.documentElement.dataset.focusNav === "keys" && (cs.outlineStyle !== "none" || cs.boxShadow !== "none");
        });
        if (!ring) rings.push(await target.evaluate(n => n.className));
      }
      await page.mouse.click(4, 4);
      failures.push(...rings.map(r => profile.name + ": no keyboard focus ring on " + r));
      // The computed face of every specimen root.
      styles[profile.name] = await page.evaluate(FACE => {
        const out = {};
        for (const fam of document.querySelectorAll(".ui-gallery-family")) {
          fam.querySelectorAll(".ui-gallery-specimen").forEach((spec, i) => {
            const label = fam.dataset.family + "/" + spec.querySelector(".ui-gallery-caption").textContent;
            [...spec.querySelector(".ui-gallery-stage").children].forEach((n, j) => {
              const cs = getComputedStyle(n);
              out[label + "/" + j] = n.localName + "." + [...n.classList].sort().join(".") + " " + FACE.map(p => cs.getPropertyValue(p)).join("|");
            });
          });
        }
        return out;
      }, FACE);
      if (errors.length) failures.push(profile.name + ": page errors " + errors.join(" | "));
      if (out || docs) {
        const height = await page.evaluate(() => document.querySelector(".ui-gallery").scrollHeight);
        await page.setViewportSize({width:profile.viewport.width, height:Math.min(height, 16000)});
        if (out) { fs.mkdirSync(out, {recursive:true}); await page.screenshot({path:path.join(out, "gallery-" + profile.name + ".png")}); }
        if (docs && profile.name === "light") {
          const dir = path.join(ROOT, "docs/ui-library");
          fs.mkdirSync(dir, {recursive:true});
          for (const f of shown) await page.locator("#ui-" + f).screenshot({path:path.join(dir, f + ".png")});
        }
      }
    } catch (error) { failures.push(profile.name + ": " + error.message.split("\n")[0]); }
    finally { await page.close(); }
  }
  if (opt("--update")) fs.writeFileSync(STYLES, JSON.stringify(styles, null, 1) + "\n");
  else if (fs.existsSync(STYLES)) {
    const want = JSON.parse(fs.readFileSync(STYLES, "utf8"));
    for (const profile of Object.keys(want)) for (const key of new Set([...Object.keys(want[profile]), ...Object.keys(styles[profile] || {})]))
      if (want[profile][key] !== styles[profile]?.[key]) failures.push(`${profile} ${key}: ${want[profile][key]} → ${styles[profile]?.[key]}`);
  } else failures.push("tests/maintenance/ui-gallery-styles.json is missing: run with --update after checking the gallery");
  assert.equal(failures.length, 0, failures.slice(0, 40).join("\n"));
  console.log("PASS UI gallery: " + families.length + " families in light, dark and touch; policies, focus and component faces match");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => { console.error(error.message); process.exitCode = 1; });
}
