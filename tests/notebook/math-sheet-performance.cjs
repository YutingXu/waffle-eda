"use strict";
// Time the shared equation layout and cache, then pan the persisted project in a real browser.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(process.argv[2] || path.join(__dirname, "../.."));
const {appFileFrom} = require("../support/app-source-paths.cjs");
for (const n of ["model", "vendor/stix-two-math", "math-font", "math-tex", "math", "path-record", "pdf", "print"])
  require(appFileFrom(path.join(root, "app"), n + ".js"));
const rows = fs
  .readFileSync(path.join(__dirname, "../fixtures/math/electronics.tsv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map(r => r.split("\t")[4]);
const p = Atrium.project("Equation notebook", []),
  doc = p.documents[0];
p.documents = [doc];
doc.name = p.name;
assert.equal(rows.length, 100);
const now = globalThis.performance?.now?.bind(globalThis.performance) || Date.now;
const coldStart = now();
const cpuStart = process.cpuUsage?.();
for (let i = 0; i < 500; i++) {
  const tex = "a_{" + i + "}=" + rows[i % rows.length],
    size = 2.5,
    l = AtriumMath.layout(tex, { display: true }),
    { w, h } = AtriumMath.noteDimensions(l, size);
  assert.equal(l.errors.length, 0, tex);
  assert.ok(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0, tex);
  doc.items.push({
    id: "eq-" + i,
    kind: "textframe",
    math: true,
    x: (i % 20) * 65,
    y: Math.floor(i / 20) * 15,
    w,
    h,
    size,
    text: tex
  });
}
const coldMs = now() - coldStart;
const coldCpu = cpuStart && process.cpuUsage(cpuStart);

// The vector recorder accepts the editor's draw calls even in a shell without a raster canvas.
function recordSheet(dx = 0, dy = 0) {
  const recorder = AtriumPDF.recorder(1370, 860);
  recorder.ctx.translate(dx, dy);
  for (const item of doc.items) AtriumMath.drawItem(recorder.ctx, item, "#222");
  return recorder.list;
}
const original = recordSheet();
assert.equal(original.length, 500);
assert.equal(new Set(original.map(op => op.layout)).size, 500);
assert.ok(original.every(op => op.k === "math" && op.m.every(Number.isFinite)));
assert.ok(original.every(op => op.layout.commands.some(command => command.kind === "glyph")));
assert.ok(original.some(op => op.layout.commands.some(command => command.kind === "rule")));
const times = [];
for (let i = 0; i < 60; i++) {
  const start = now();
  const cached = recordSheet(5 * i, i);
  times.push(now() - start);
  assert.equal(cached.length, original.length);
  for (const [j, op] of cached.entries()) {
    const before = original[j];
    assert.equal(op.layout, before.layout);
    assert.equal(op.m[4], before.m[4] + 5 * i);
    assert.equal(op.m[5], before.m[5] + i);
  }
}
const edited = doc.items[0];
const source = edited.text;
edited.text = "x+y";
const afterEdit = recordSheet();
assert.equal(afterEdit.length, original.length);
assert.notEqual(afterEdit[0].layout, original[0].layout);
assert.equal(afterEdit[0].layout.plain, "x+y");
assert.ok(afterEdit.slice(1).every((op, j) => op.layout === original[j + 1].layout));
edited.text = source;
const restored = recordSheet();
assert.equal(restored.length, original.length);
assert.deepEqual(restored[0], original[0]);
assert.ok(restored.slice(1).every((op, j) => op.layout === original[j + 1].layout));
times.sort((a, b) => a - b);
assert.ok(coldMs >= 0 && times.every(ms => Number.isFinite(ms) && ms >= 0));
assert.ok(times[56] < 16, "A cached 500-equation display-list pass exceeded 16 ms at p95");
console.log(JSON.stringify({
  equations: original.length,
  coldLayoutMs: +coldMs.toFixed(2),
  coldProcessCpuMs: coldCpu && +((coldCpu.user + coldCpu.system) / 1000).toFixed(2),
  cachedDisplayListPasses: times.length,
  cachedDisplayListP95Ms: +times[56].toFixed(2)
}));

async function browserPan() {
  const { chromium } = require("playwright-core");
  const { pathToFileURL } = require("node:url");
  for (const module of ["source-file","format-2-codec","format-2-units","format-2-values","format-2-model","import-sidecars","zip"])
    require(appFileFrom(path.join(root,"app"),module+".js"));
  const native=AtriumFormat2Model.fromEditor(p,{manifestPath:"Equations.waffle"});
  const members=native.files.map(row=>({name:row.path,data:AtriumFormat2.serialize(row.file)}));
  members.push({name:AtriumImportSidecars.IGNORE,data:AtriumImportSidecars.ignoreText});
  const archive=AtriumZip.create(members);
  const browser = await chromium.launch({ channel: "chrome" }),
    page = await browser.newPage({ viewport: { width: 1370, height: 860 } });
  try {
    await require("../fixtures/notebook-labs.cjs").profile(page);
    await page.addInitScript(() => {
      const measure = (window.mathPaints = { seen: [], draws: 0, cold: 0 });
      for (const key of ["AtriumCanvas", "AtriumMath"])
        Object.defineProperty(window, key, {
          configurable: true,
          set(module) {
            if (key === "AtriumMath") {
              const draw = module.drawItem;
              module = {
                ...module,
                drawItem(...args) {
                  measure.draws++;
                  return draw(...args);
                }
              };
            } else {
              const create = module.create;
              module.create = (...args) => {
                const v = create(...args),
                  render = v.render;
                v.render = (doc, ...paint) => {
                  const started = performance.now(),
                    before = measure.draws,
                    result = render(doc, ...paint);
                  if (doc.name === "Equation notebook") {
                    const observation = {
                      ms: performance.now() - started,
                      loaded: !!window.AtriumMath,
                      objects: measure.draws - before
                    };
                    if (measure.seen.length < 120) measure.seen.push(observation);
                  }
                  return result;
                };
                return v;
              };
            }
            Object.defineProperty(window, key, { value: module, writable: true, configurable: true });
          }
        });
    });
    await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
    await page.waitForFunction(() => window.AtriumStartPage?.isOpen());
    assert.equal(await page.evaluate(() => !!window.AtriumMath), false);
    await page
      .locator("#file-input")
      .setInputFiles({
        name: "Equations.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive)
      });
    await page.getByRole("dialog",{name:"Open project ZIP"}).getByRole("button",{name:"Open project",exact:true}).click();
    await page.waitForFunction(
      () => mathPaints.seen.length > 0 && AtriumNavHost.doc().name === "Equation notebook",
      null,
      { timeout: 15000 }
    );
    const stats = await page.evaluate(async () => {
      const h = AtriumNavHost,
        v = h.view(),
        doc = h.doc(),
        defs = h.defs(),
        measure = mathPaints;
      globalThis.AtriumCamera?.takeCamera?.(v);
      const times = [],
        perf = { first: measure.seen[0] },
        digit = v => +v.toFixed(2);
      for (const [name, scale] of [
        ["overview", 0.47],
        ["reading", 6]
      ]) {
        v.restoreCamera({ ...v.camera(), cx: 300, cy: 75, scale });
        v.render(doc, defs, { grid: true });
        times.length = 0;
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          v.pan(5, 1);
          const start = performance.now();
          v.render(doc, defs, { grid: true });
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        perf[name] = {
          p50: digit(times[29]),
          p95: digit(times[56]),
          max: digit(times[59]),
          over16: times.filter(v => v > 16).length
        };
      }
      const first = doc.items[0],
        other = doc.items[1],
        source = first.text,
        layout = AtriumMath.layout(first.text, { display: true }),
        cached = AtriumMath.layout(first.text, { display: true }) === layout;
      h.edit(
        () => {
          first.text = "x+y";
          const m = AtriumMath.noteDimensions(AtriumMath.layout(first.text, { display: true }), first.size);
          first.w = m.w;
          first.h = m.h;
        },
        "Edit equation",
        [first]
      );
      h.act("undo");
      return {
        ...perf,
        cached,
        undo: h.doc().items.find(i => i.id === first.id).text === source,
        untouched: h.doc().items.find(i => i.id === other.id).text === other.text
      };
    });
    assert.equal(stats.first.loaded, true);
    assert.equal(stats.first.objects, 500);
    assert.equal(stats.cached, true);
    assert.equal(stats.undo, true);
    assert.equal(stats.untouched, true);
    console.log(JSON.stringify({ equations: 500, ...stats }));
    assert.ok(stats.reading.p95 < 16 && stats.overview.p95 < 16);
  } finally {
    await browser.close();
  }
}
if (process.versions.node) {
  browserPan().catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  console.log("SKIP Chromium first-paint and pan checks: standalone JavaScriptCore cannot launch a browser.");
}
