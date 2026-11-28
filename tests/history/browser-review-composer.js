"use strict";
// Review comments in a real browser: the Annotate composer (no per-comment name, no kind badge, no
// accent bar, the shortcut on the Comment button), the map-pin marker, and no hover card that only
// repeats a sheet note's own text.
const assert = require("node:assert/strict"), path = require("node:path"), {pathToFileURL} = require("node:url");

async function open(browser, theme) {
  const page = await browser.newPage({viewport: {width: 1280, height: 840}}), errors = [];
  page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(9000);
  await page.clock.install();
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
  await page.evaluate(t => {
    AtriumTheme.set({preset: t}, {persist: false});
    const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
  }, theme);
  await page.waitForFunction(theme => AtriumNavHost.doc().kind === "schematic" &&
    document.documentElement.dataset.theme === theme && !globalThis.AtriumMotion?.active(), theme);
  return {page, errors};
}

// Pixels of a page region, read back in the page (no PNG decoder needed here).
async function pixels(page, clip) {
  const png = (await page.screenshot({clip})).toString("base64");
  return page.evaluate(async ({png, w, h}) => {
    const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h);
    return Array.from(x.getImageData(0, 0, w, h).data);
  }, {png, w: clip.width, h: clip.height});
}
const at = (data, w, x, y) => data.slice((y * w + x) * 4, (y * w + x) * 4 + 3);
const near = (a, b, d = 70) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= d;

async function composer(page, theme) {
  await page.evaluate(() => AtriumNavHost.act("comment-mode"));
  await page.waitForFunction(() => globalThis.AtriumReviewAnnotate?.isOn?.());
  const box = await page.locator("#canvas").boundingBox(), x0 = box.x + box.width * .62, y0 = box.y + box.height * .18;
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x0 + 120, y0 + 80, {steps: 6}); await page.mouse.up();
  const root = page.locator(".ann-composer[role=dialog]:visible"); await root.waitFor();
  // Identity comes from Preferences, never from a field in the composer.
  assert.equal(await root.locator("input").count(), 0, "no Reviewer / name field");
  assert.equal(await root.getByRole("textbox").count(), 1, "one text field: the comment");
  assert.equal(await root.locator(".ann-c-kind").count(), 0, "no kind badge");
  assert.doesNotMatch(await root.innerText(), /\bAREA\b|Area \d/, "no badge or area-size line for an area");
  const look = await root.evaluate(el => {
    const cs = getComputedStyle(el), bar = getComputedStyle(el, "::before"), text = el.querySelector("textarea");
    return {pad: cs.paddingTop + " " + cs.paddingLeft, bar: bar.content, barWidth: bar.width, inner: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), text: text.offsetWidth,
      foot: Math.round(el.querySelector(".ann-c-post").getBoundingClientRect().right - el.querySelector("textarea").getBoundingClientRect().right), nested: el.querySelectorAll(".ui-popover,.ui-dialog,fieldset").length};
  });
  assert.ok(look.bar === "none" || look.bar === "normal", "no accent bar on the left edge: " + look.bar);
  assert.equal(look.pad, "12px 12px", "12 px padding");
  assert.equal(look.text, look.inner, "the text field spans the popover");
  assert.equal(look.foot, 0, "actions are right-aligned with the text field");
  assert.equal(look.nested, 0, "no box in a box");
  // The shortcut lives on the Comment button, drawn by the shared keycap component.
  const post = root.getByRole("button", {name: /^Comment/});
  assert.match(await post.getAttribute("aria-keyshortcuts"), /(^| )Meta\+Enter( |$)/);
  assert.equal(await post.locator("kbd.ui-shortcut").count(), 1, "keycap inside the Comment button");
  assert.equal(await root.locator(".ui-shortcut").count(), 1, "no floating shortcut beside the buttons");
  assert.equal(await root.getByRole("button", {name: "Cancel"}).getAttribute("aria-keyshortcuts"), "Escape");
  const heights = await root.locator("button").evaluateAll(b => b.map(x => x.getBoundingClientRect().height));
  assert.ok(heights.every(h => h === heights[0]), "buttons share one height: " + heights);
  // The author comes from Preferences › Collaboration › display name.
  await page.evaluate(() => AtriumPref.set("collab.displayName", "Board reviewer"));
  await page.keyboard.type("Check the decoupling here " + theme);
  await page.keyboard.press("Meta+Enter");
  await root.waitFor({state: "hidden"});
  const made = await page.evaluate(() => { const h = AtriumNavHost; return AtriumReviewComments.threads(h.project(), {doc: h.doc().id, status: "all"}).at(-1); });
  assert.match(made.text, /Check the decoupling here/, "⌘↩ posts the comment");
  assert.equal(made.author, "Board reviewer");
  await page.evaluate(() => AtriumPref.set("collab.displayName", ""));
  return made;
}

async function pin(page, made) {
  await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
  const geo = await page.evaluate(id => {
    const h = AtriumNavHost, C = AtriumReviewComments, t = C.thread(h.project(), id), a = C.locate(h.doc(), h.defs(), t).at;
    const s = h.view().worldToScreen(a), r = h.canvas().getBoundingClientRect();
    return {x: Math.round(r.left + s[0]), y: Math.round(r.top + s[1]), head: 11 * C.PIN_HEAD, reach: C.PIN_REACH,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()};
  }, made.id);
  const accent = await page.evaluate(c => { const s = document.createElement("span"); s.style.color = c; document.body.append(s); const v = getComputedStyle(s).color.match(/\d+/g).slice(0, 3).map(Number); s.remove(); return v; }, geo.accent);
  const w = 60, h = 60, clip = {x: geo.x - 30, y: geo.y - 50, width: w, height: h}, data = await pixels(page, clip);
  const tipX = 30, tipY = 50, cy = Math.round(tipY - geo.head * geo.reach);
  // A teardrop: filled just above the tip (a circle with a stub would leave this empty), not beside it.
  assert.ok(near(at(data, w, tipX, tipY - 5), accent), "filled near the tip: " + at(data, w, tipX, tipY - 5) + " vs " + accent);
  assert.ok(!near(at(data, w, tipX - 7, tipY - 5), accent), "narrow at the tip");
  // The round head is centred above the tip and holds the number (light ink pixels inside it).
  assert.ok(near(at(data, w, tipX - Math.round(geo.head * .7), cy), accent), "the head is round and wide");
  let ink = 0;
  for (let y = cy - 4; y <= cy + 4; y++) for (let x = tipX - 3; x <= tipX + 3; x++) if (!near(at(data, w, x, y), accent, 120)) ink++;
  assert.ok(ink >= 4, "the number sits in the head centre (" + ink + " ink pixels)");
  // The hit target is the head.
  assert.ok(await page.evaluate(({x, y}) => { const h = AtriumNavHost, p = h.panes().find(q => q.active); return !!AtriumReviewComments.pinAt(p, x, y); }, {x: geo.x, y: cy + clip.y}));
}

async function noteHover(page) {
  await page.evaluate(() => { if (AtriumReviewAnnotate?.isOn?.()) AtriumReviewAnnotate.exit(); });
  // A sticky note like the beta tester's "Power switch" note, in the middle of the view.
  await page.evaluate(async () => {
    if (!AtriumLabs.notebookEnabled()) AtriumPref.set("labs.notebook", true);   // notes are a Labs preview before Apricot
    await AtriumLazy.need("AtriumMarkup");
    const h = AtriumNavHost, d = h.doc(), p = h.project(), c = h.canvas();
    const at = h.view().screenToWorld([c.clientWidth * .3, c.clientHeight * .7]).map(v => Math.round(v));
    h.edit(() => { d.items.push(AtriumMarkup.card("sticky", at, "Power switch", "amber", p, d, {docId: d.id, at: [...at]})); }, "Place note");
    h.redraw(true);
  });
  const spot = await page.evaluate(() => {
    const h = AtriumNavHost, n = h.doc().items.find(i => i.text === "Power switch"), r = h.canvas().getBoundingClientRect();
    h.select([]);
    const s = h.view().worldToScreen([n.x + n.w / 2, n.y + n.h / 2]);
    const part = h.doc().items.find(i => i.kind === "part"), b = Atrium.bounds(Atrium.itemPoints(part, h.defs().get(part.def), "schematic"));
    const ps = h.view().worldToScreen([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    return {note: [r.left + s[0], r.top + s[1]], part: [r.left + ps[0], r.top + ps[1]]};
  });
  const tip = page.locator("#waffle-tooltip");
  // Control: a component still gets its card (reference, value).
  await page.mouse.move(spot.part[0] - 40, spot.part[1] - 40); await page.mouse.move(...spot.part, {steps: 3});
  await tip.waitFor({state: "visible"});
  await page.mouse.move(5, 5); await tip.waitFor({state: "hidden"});
  await page.mouse.move(spot.note[0] - 40, spot.note[1] - 40); await page.mouse.move(...spot.note, {steps: 3});
  await page.clock.runFor(1500);
  assert.equal(await tip.isVisible(), false, "hovering a note shows no card repeating its text");
}

async function filterComments(page) {
  await page.evaluate(() => {
    const h = AtriumNavHost, review = AtriumReviewComments, project = h.project();
    const doc = project.documents.find(d => d.kind === "pcb").id, anchor = {kind:"point", at:[0, 0]};
    const thread = review.add(project, {doc, anchor, text:"Check the board footprint"});
    review.reply(project, thread.id, {text:"調査済み"});
    review.setStatus(project, thread.id, "resolved");
    review.toggle(true);
  });
  const panel = page.locator('[data-dock="comments"]');
  const search = panel.getByRole("searchbox", {name:"Search comments"});
  const text = panel.locator(".rc-thread .rc-text");
  assert.deepEqual(await text.allTextContents(), ["Check the decoupling here light"]);
  assert.equal(await panel.locator(".ui-dock-count").textContent(), "1 open");

  const cdp = await page.context().newCDPSession(page);
  await search.focus();
  await cdp.send("Input.imeSetComposition", {text:"調査済み", selectionStart:4, selectionEnd:4});
  await page.clock.runFor(48);
  assert.deepEqual(await text.allTextContents(), ["Check the decoupling here light"], "tentative IME input leaves the threads in place");
  await cdp.send("Input.insertText", {text:"調査済み"});
  await panel.getByText("No comments match.").waitFor();
  await cdp.detach();

  await panel.getByRole("combobox", {name:"Documents"}).selectOption("all");
  assert.equal(await text.count(), 0, "open threads still hide the resolved result");
  await panel.getByRole("combobox", {name:"Show comments"}).selectOption("resolved");
  assert.deepEqual(await text.allTextContents(), ["Check the board footprint"], "the query also matches reply text across documents");
  assert.equal(await panel.locator(".ui-dock-count").textContent(), "1 open", "the project open count stays independent of filters");
}

module.exports = async function reviewComposer(browser, {shots} = {}) {
  for (const theme of ["light", "dark"]) {
    const {page, errors} = await open(browser, theme);
    try {
      const made = await composer(page, theme);
      await pin(page, made);
      await noteHover(page);
      if (theme === "light") await filterComments(page);
      assert.deepEqual(errors, []);
      console.log("PASS review composer " + theme + ": no name field, badge or bar; ⌘↩ on Comment; teardrop pin; no note echo card");
    } finally { await page.close(); }
  }
};
if (require.main === module) (async () => {
  const b = await require("../support/playwright.cjs").chromium.launch({channel: "chrome", args: ["--allow-file-access-from-files"]});
  try { await module.exports(b); } finally { await b.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
