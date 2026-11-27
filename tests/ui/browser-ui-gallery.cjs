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
const efficiencyOff = require("../support/efficiency-off.cjs");

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

async function buttonFace(button) {
  return button.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished));
    const style = getComputedStyle(node);
    // Composite the translucent fills over the gallery surface before measuring contrast.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = getComputedStyle(node.closest(".ui-gallery-body")).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return {
      fill: "rgb(" + [r, g, b].join(", ") + ")",
      ink: style.color,
      border: ["Top", "Right", "Bottom", "Left"].map(side => style["border" + side + "Color"]),
      durations: style.transitionDuration.split(", "),
    };
  });
}

async function pressedFace(page, button) {
  await page.mouse.down();
  try {
    return await buttonFace(button);
  } finally {
    await page.mouse.up();
  }
}

async function checkButtonHover(page, theme, failures) {
  const root = page.locator("html");
  // Use a distinct duration to catch a hard-coded value as well as a different token.
  await root.evaluate(node => node.style.setProperty("--motion-instant", "113ms"));
  try {
    for (const name of ["Primary", "Secondary", "Quiet", "Delete", "Pressed"]) {
      await page.mouse.move(4, 4);
      const button = page.locator("#ui-button").getByRole("button", {name, exact:true});
      const rest = await buttonFace(button);
      await button.hover();
      const hover = await buttonFace(button);
      const ratio = await page.evaluate(([a, b]) => AtriumTheme.color.contrast(a, b), [rest.fill, hover.fill]);
      const label = theme + " " + name;
      if ([...rest.durations, ...hover.durations].some(time => time !== "0.113s"))
        failures.push(label + " hover and press must use --motion-instant (" + hover.durations.join(", ") + ")");
      if (hover.border.some((color, side) => color !== rest.border[side]))
        failures.push(label + " border changed on hover");
      if (!(ratio >= 1.12))
        failures.push(label + " hover fill contrast step " + ratio.toFixed(3) + " is below 1.12");
      if (name === "Primary" || name === "Delete" || name === "Pressed") {
        const pressed = await pressedFace(page, button);
        if (pressed.fill === hover.fill || pressed.fill === rest.fill)
          failures.push(label + " needs a distinct pressed fill");
        if (pressed.border.some((color, side) => color !== rest.border[side]))
          failures.push(label + " border changed on press");
        if (pressed.durations.some(time => time !== "0.113s"))
          failures.push(label + " press must use --motion-instant");
        if (await page.evaluate(({fill, ink}) => AtriumTheme.color.contrast(fill, ink) < 4.5, pressed))
          failures.push(label + " pressed label does not meet 4.5:1 contrast");
        if (name === "Pressed" && await page.evaluate(([a, b]) => AtriumTheme.color.contrast(a, b), [rest.fill, pressed.fill]) <= ratio)
          failures.push(label + " press must deepen the selected button's fill");
      }
    }
    for (const name of ["Parts", "Wires", "Disabled"]) {
      await page.mouse.move(4, 4);
      const chip = page.locator("#ui-chip").getByRole("button", {name, exact:true});
      const rest = await buttonFace(chip);
      await chip.hover();
      const hover = await buttonFace(chip);
      const label = theme + " chip " + name;
      if ((hover.fill !== rest.fill) !== (name !== "Disabled"))
        failures.push(label + " hover fill does not match its enabled state");
      if (hover.border.some((color, side) => color !== rest.border[side]))
        failures.push(label + " border changed on hover");
      if (hover.durations.some(time => time !== "0.113s"))
        failures.push(label + " hover must use --motion-instant");
    }
  } finally {
    await page.mouse.move(4, 4);
    await root.evaluate(node => node.style.removeProperty("--motion-instant"));
  }
}

async function checkCustomButtonHover(browser, failures) {
  const profile = PROFILES[0];
  const page = await browser.newPage({viewport:profile.viewport, reducedMotion:"reduce"});
  await efficiencyOff(page);
  try {
    await open(page, profile);
    for (const [preset, accent, name] of [["light", "#000000", "Primary"], ["dark", "#ffd900", "Primary"], ["dark", "#ffd900", "Pressed"]]) {
      await page.mouse.move(4, 4);
      await page.evaluate(([preset, accent]) => AtriumTheme.set({preset, accent}, {persist:false}), [preset, accent]);
      const button = page.locator("#ui-button").getByRole("button", {name, exact:true});
      const rest = await buttonFace(button);
      await button.hover();
      const hover = await buttonFace(button);
      const [step, readability] = await page.evaluate(([rest, hover]) => [
        AtriumTheme.color.contrast(rest.fill, hover.fill),
        AtriumTheme.color.contrast(hover.ink, hover.fill)
      ], [rest, hover]);
      const label = preset + " " + accent + " " + name;
      if (step < 1.12) failures.push(label + " hover fill changes by only " + step.toFixed(2) + ":1");
      if (readability < 4.5) failures.push(label + " hover text contrast falls to " + readability.toFixed(2) + ":1");
      const pressed = await pressedFace(page, button);
      if (pressed.fill === hover.fill || pressed.fill === rest.fill)
        failures.push(label + " needs a distinct pressed fill");
      if (await page.evaluate(({fill, ink}) => AtriumTheme.color.contrast(fill, ink) < 4.5, pressed))
        failures.push(label + " pressed label does not meet 4.5:1 contrast");
    }
  } finally {
    await page.close();
  }
}

module.exports = async function gallery(browser) {
  const failures = [], styles = {}, out = opt("--out"), docs = opt("--docs");
  const families = documented();
  await checkCustomButtonHover(browser, failures);
  for (const profile of PROFILES) {
    const page = await browser.newPage({viewport:profile.viewport, hasTouch:profile.touch, reducedMotion:"reduce", deviceScaleFactor:1});
    await efficiencyOff(page);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    try {
      await open(page, profile);
      if (!profile.touch) await checkButtonHover(page, profile.name, failures);
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
  console.log("PASS UI gallery: " + families.length + " families in light, dark and touch; policies, focus, button hover and component faces match");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => { console.error(error.message); process.exitCode = 1; });
}
