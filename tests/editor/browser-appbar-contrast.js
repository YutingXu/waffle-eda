"use strict";
// Every app-bar button meets WCAG AA in every theme (beta: the live-session button read as "a blue
// box with black text"). Generic: each visible button in the app bar, in each state the app bar can
// show (idle, focused by keyboard, sharing), and the buttons of the dialog the Share button opens.
// Text needs 4.5:1 against the button's composited fill; an icon-only button needs 3:1 (WCAG 1.4.11).
// Run: node tests/editor/browser-appbar-contrast.js (NODE_PATH for Playwright Core).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// In-page: the composited contrast of a button's ink on its own fill over the page behind it.
function measure(selector) {
  const parse = value => {
    let m = /^rgba?\(([^)]+)\)$/.exec(value);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
    }
    m = /^color\(srgb ([^)]+)\)$/.exec(value);
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    return null;
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const fillOf = node => {
    const layers = [];
    for (let n = node; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
    }
    let base = [1, 1, 1, 1];
    if (!layers.length || layers[layers.length - 1][3] < 1) base = parse(getComputedStyle(document.body).backgroundColor) || base;
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const lum = c => {
    const ch = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    return .2126 * ch(c[0]) + .7152 * ch(c[1]) + .0722 * ch(c[2]);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + .05) / (lo + .05);
  };
  const visible = n => {
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
    // Disabled controls are exempt (WCAG 1.4.3); Undo with nothing to undo is one.
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !n.closest("[hidden]") && !n.disabled;
  };
  return [...document.querySelectorAll(selector)].filter(visible).map(button => {
    const fill = fillOf(button), ink = over(parse(getComputedStyle(button).color) || [0, 0, 0, 1], fill);
    const text = [...button.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      || [...button.querySelectorAll("span:not(.ui-shortcut *):not(.ui-shortcut)")].some(n => visible(n) && n.textContent.trim());
    return {name: button.getAttribute("aria-label") || button.textContent.trim() || button.dataset.action || button.className,
      text, ratio: +ratio(ink, fill).toFixed(2), lightInk: lum(ink) > lum(fill)};
  });
}

module.exports = async function appbarContrast(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", {value: "MacIntel"}));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    const failures = [];
    const check = async (label, selector) => {
      const rows = await page.evaluate(measure, selector);
      assert.ok(rows.length, label + ": buttons were found");
      for (const row of rows) {
        const need = row.text ? 4.5 : 3;
        if (row.ratio < need) failures.push(label + ": " + row.name + " " + row.ratio + " < " + need);
      }
      return rows.length;
    };
    // The dialog behind Share uses the library primary button with white ink on the accent.
    const dialog = page.locator("dialog.collab-dialog[open]");
    const checkShare = async label => {
      await page.locator("#collab-share").click();
      await dialog.waitFor();
      await check(label + " live-session dialog", "dialog.collab-dialog[open] button.ui-button");
      const primary = await page.evaluate(measure, "dialog.collab-dialog[open] .ui-button[data-variant=primary]");
      assert.ok(primary.length, label + ": the live-session dialog has a primary action");
      for (const row of primary) assert.ok(row.lightInk, label + ": " + row.name + " has light ink on its fill");
      await page.keyboard.press("Escape");
      await dialog.waitFor({state:"detached"});
    };
    for (const preset of ["dark", "light", "hc", "classic"]) {
      await page.evaluate(p => AtriumTheme.set({preset: p, followSystem: false, accent: ""}), preset);
      // Let colour transitions settle before measuring.
      await page.evaluate(() => {
        getComputedStyle(document.querySelector("header.appbar")).backgroundColor;
        return Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
      });
      const n = await check(preset + " app bar", "header.appbar button, header.appbar summary");
      assert.ok(n >= 8, preset + ": the app bar's menus, search, quick access and Share are all measured");
      await page.evaluate(() => document.getElementById("collab-share").classList.add("is-sharing"));
      await check(preset + " sharing", "#collab-share");
      await page.evaluate(() => document.getElementById("collab-share").classList.remove("is-sharing"));
      await checkShare(preset);
    }
    // A host accent (macOS system blue) derives the primary fill: white ink still reads.
    for (const preset of ["dark", "light"]) {
      await page.evaluate(preset => {globalThis.__atriumHostAccent = "#007aff"; AtriumTheme.set({preset, followSystem: false, accent: ""});}, preset);
      await checkShare(preset + " + system blue");
    }
    assert.deepEqual(failures, [], "app-bar buttons meet WCAG AA:\n" + failures.join("\n"));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => ({headless: true, channel: "chrome"}),
    async browser => {await module.exports(browser); console.log("appbar contrast: ok");},
    e => {console.error(e); process.exit(1);});
}
