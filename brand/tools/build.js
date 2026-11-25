// Builds the final Waffle (Stack) asset set into ../ :
//   svg/  masters        macos/  .icns (built from a temporary .iconset) + menu-bar template PNGs
//   windows/  .ico       linux/  hicolor PNGs + scalable SVG     web/  favicons
//   png/  overview  (pass --contact to also write png/contact-sheet.png)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const S = require('./stack');
const W = require('./wordmark');
const { icon } = require('./icon');
const I = require('./base');
const Mk = require('./base');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const dir = d => { const p = path.join(ROOT, d); fs.mkdirSync(p, { recursive: true }); return p; };
const D = { svg: dir('svg'), macos: dir('macos'), win: dir('windows'), linux: dir('linux'), web: dir('web'), png: dir('png') };
const f = n => +(+n).toFixed(2);
const put = (p, s) => { fs.writeFileSync(p, s); return s; };
const uri = s => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');

// ---------------------------------------------------------------------------
// Flavours, in build order (docs/releases.md: Apricot, Butter, Cinnamon, Dark Chocolate,
// Espresso, Fig, Ginger, Hazelnut). A flavour glazes the pocket floors and tints the
// via ring. Nothing else moves.
const FLAVOURS = [
  { key: 'apricot', name: 'Apricot', order: 1, pool: ['#E2632A', '#FFB27E'], wall: ['#93300D', '#C04A18'], via: ['#FFEBDD', '#F39058'] },
  { key: 'butter', name: 'Butter', order: 2, pool: ['#E9B93A', '#FFE9A0'], wall: ['#A8770E', '#CF9E2C'], via: ['#FFFCEB', '#F2D27A'] },
  { key: 'cinnamon', name: 'Cinnamon', order: 3, pool: ['#8E3416', '#C8643A'], wall: ['#4E1806', '#74290E'], via: ['#FFE6D6', '#C0582C'] },
  { key: 'dark-chocolate', name: 'Dark Chocolate', order: 4, pool: ['#24120A', '#5A3424'], wall: ['#120803', '#24120A'], via: ['#EADBD0', '#6B4030'] },
];

// ---------------------------------------------------------------------------
// SVG masters
function markSVG({ set = null, small = false, mono = false, flavour = null, pad = 1.08, title = 'Waffle', id = 'm' } = {}) {
  const G = S.centred(set || (small ? S.SMALL : S.FULL));
  const b = S.bounds(G);
  const side = Math.max(b.x1 - b.x0, b.y1 - b.y0) * pad;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const vb = [f(cx - side / 2), f(cy - side / 2), f(side), f(side)];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="1024" height="1024"><title>${title}</title>` +
    S.build(G, { mono, flavour, id }) + `</svg>\n`;
}
const MASTER = {
  mark: put(path.join(D.svg, 'waffle-mark.svg'), markSVG()),
  mono: put(path.join(D.svg, 'waffle-mark-mono.svg'), markSVG({ mono: true })),
  small: put(path.join(D.svg, 'waffle-mark-small.svg'), markSVG({ small: true, pad: 1.02 }).replace('width="1024" height="1024"', 'width="16" height="16"')),
  smallMono: put(path.join(D.svg, 'waffle-mark-small-mono.svg'), markSVG({ small: true, mono: true, pad: 1.02 }).replace('width="1024" height="1024"', 'width="16" height="16"')),
  macos: put(path.join(D.svg, 'waffle-macos.svg'), icon({ plate: 'cocoa' })),
  macosSmall: put(path.join(D.svg, 'waffle-macos-16-32.svg'), icon({ plate: 'cocoa', small: true })),
  macosCream: put(path.join(D.svg, 'waffle-macos-cream.svg'), icon({ plate: 'cream' })),
};
MASTER.template = put(path.join(D.svg, 'waffle-menubar-template.svg'),
  markSVG({ set: S.TEMPLATE, mono: true, pad: 1.0 }).replace('width="1024" height="1024"', 'width="16" height="16"').replace(/currentColor/g, '#000'));
MASTER.favicon = put(path.join(D.web, 'favicon.svg'), MASTER.small);
for (const fl of FLAVOURS) {
  fl.icon = put(path.join(D.svg, `waffle-macos-${fl.key}.svg`), icon({ plate: 'cocoa', flavour: fl, id: 'f' + fl.key.replace('-', '') }));
  fl.mark = put(path.join(D.svg, `waffle-mark-${fl.key}.svg`), markSVG({ flavour: fl, id: 'g' + fl.key.replace('-', '') }));
}

// Wordmark and lockups (mark left, wordmark right; x-height centred on the mark's waist)
const INK = { light: '#2A1D07', dark: '#FFF3DC' };
put(path.join(D.svg, 'waffle-wordmark.svg'), W.wordmarkSVG(INK.light, 160));
put(path.join(D.svg, 'waffle-wordmark-on-dark.svg'), W.wordmarkSVG(INK.dark, 160));
put(path.join(D.svg, 'waffle-wordmark-eda.svg'), W.wordmarkSVG(INK.light, 160, { eda: true }));
put(path.join(D.svg, 'waffle-wordmark-eda-on-dark.svg'), W.wordmarkSVG(INK.dark, 160, { eda: true }));
function lockup(ink, id, eda = false) {
  const G = S.centred(S.FULL);
  const b = S.bounds(G);
  const side = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.04;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const markH = 340, CH = 390, my = 25, wm = W.wordmarkInner(ink, id + 'w', { eda });
  const k = 1.25;                                   // wordmark units -> px (x-height 125)
  const wx = markH + 56, xMid = my + markH / 2 + 8;  // x-height centre sits on the mark's waist
  const top = xMid - 50 * k;                        // y of x-height top (centre line 0)
  const total = wx + wm.x1 * k + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(total)} ${CH}" width="${f(total)}" height="${CH}"><title>Waffle</title>` +
    `<svg x="0" y="${my}" width="${markH}" height="${markH}" viewBox="${f(cx - side / 2)} ${f(cy - side / 2)} ${f(side)} ${f(side)}">${S.build(G, { id: id + 's' })}</svg>` +
    `<svg x="${f(wx)}" y="${f(top - 120 * k)}" width="${f((wm.x1 + 20) * k)}" height="${f(240 * k)}" viewBox="-4 -120 ${f(wm.x1 + 20)} 240">${wm.svg}</svg></svg>\n`;
}
const LOCK = {
  light: put(path.join(D.svg, 'waffle-lockup-on-light.svg'), lockup(INK.light, 'l')),
  dark: put(path.join(D.svg, 'waffle-lockup-on-dark.svg'), lockup(INK.dark, 'd')),
  edaLight: put(path.join(D.svg, 'waffle-lockup-eda-on-light.svg'), lockup(INK.light, 'e', true)),
  edaDark: put(path.join(D.svg, 'waffle-lockup-eda-on-dark.svg'), lockup(INK.dark, 'k', true)),
};

// Neutral placeholder app icons for the Dock mock (plain shapes only).
const PH = [['#9AA3AE', '#6B7380', 'circle'], ['#C9CDD3', '#9AA1AA', 'square'], ['#7F8B99', '#55606D', 'tri'],
  ['#B6AFA6', '#857D73', 'lines'], ['#8E9AA6', '#5E6A76', 'ring'], ['#A7B0A1', '#76806F', 'dots']].map(([a, b, g]) => {
  const glyph = {
    circle: '<circle cx="512" cy="512" r="170" fill="#fff" fill-opacity=".9"/>',
    square: '<rect x="352" y="352" width="320" height="320" rx="56" fill="#fff" fill-opacity=".9"/>',
    tri: '<path d="M512 330L700 670H324Z" fill="#fff" fill-opacity=".9" stroke="#fff" stroke-opacity=".9" stroke-width="40" stroke-linejoin="round"/>',
    lines: '<path d="M340 400H684M340 512H684M340 624H560" stroke="#fff" stroke-opacity=".9" stroke-width="56" stroke-linecap="round"/>',
    ring: '<circle cx="512" cy="512" r="160" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="64"/>',
    dots: '<g fill="#fff" fill-opacity=".9"><circle cx="400" cy="512" r="56"/><circle cx="512" cy="512" r="56"/><circle cx="624" cy="512" r="56"/></g>',
  }[g];
  return I.plate({ defs: Mk.grad('ph', [[0, a], [1, b]]), base: b, content: `<path d="${I.SQ}" fill="url(#ph)"/>${glyph}` });
});

// ---------------------------------------------------------------------------
(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome' });
  const c1 = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1100, height: 1100 } });
  const p1 = await c1.newPage();
  async function raster(svgStr, n, file) {
    await p1.setContent(`<body style="margin:0;background:transparent"><img id="i" src="${uri(svgStr)}" width="${n}" height="${n}" style="display:block"></body>`);
    await p1.waitForFunction(() => document.getElementById('i').complete);
    const buf = await p1.locator('#i').screenshot({ omitBackground: true });
    if (file) fs.writeFileSync(file, buf);
    return buf;
  }
  const art = n => (n <= 32 ? MASTER.macosSmall : MASTER.macos);
  const markFor = n => (n <= 32 ? MASTER.small : MASTER.mark);

  // macOS .iconset -> .icns
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-iconset-'));
  const iconset = path.join(tmp, 'Waffle.iconset');
  fs.mkdirSync(iconset);
  for (const [name, n] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128],
    ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
    await raster(art(n), n, path.join(iconset, name + '.png'));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(D.macos, 'Waffle.icns')]);
  if (process.argv.includes('--keep-iconset')) fs.cpSync(iconset, path.join(D.macos, 'Waffle.iconset'), { recursive: true });
  // flavour .icns for the first four releases
  for (const fl of FLAVOURS) {
    const set = path.join(tmp, `Waffle-${fl.key}.iconset`);
    fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
    for (const [name, n] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128],
      ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
      await raster(n <= 32 ? MASTER.macosSmall : fl.icon, n, path.join(set, name + '.png'));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(D.macos, `Waffle-${fl.key}.icns`)]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  // menu-bar template (black + alpha; the "Template" suffix tells AppKit to tint it)
  await raster(MASTER.template, 16, path.join(D.macos, 'WaffleTemplate.png'));
  await raster(MASTER.template, 32, path.join(D.macos, 'WaffleTemplate@2x.png'));
  fs.copyFileSync(path.join(D.svg, 'waffle-menubar-template.svg'), path.join(D.macos, 'WaffleTemplate.svg'));

  // Windows .ico (PNG-compressed entries: 16, 24, 32, 48, 64, 256)
  const icoSizes = [16, 24, 32, 48, 64, 256];
  const pngs = [];
  for (const n of icoSizes) pngs.push(await raster(markFor(n), n));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach((b, i) => {
    const n = icoSizes[i], o = 6 + 16 * i;
    head.writeUInt8(n >= 256 ? 0 : n, o); head.writeUInt8(n >= 256 ? 0 : n, o + 1);
    head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12); off += b.length;
  });
  fs.writeFileSync(path.join(D.win, 'waffle.ico'), Buffer.concat([head, ...pngs]));
  fs.copyFileSync(path.join(D.win, 'waffle.ico'), path.join(D.web, 'favicon.ico'));

  // Linux hicolor theme PNGs + scalable SVG
  for (const n of [16, 22, 24, 32, 48, 64, 128, 256, 512]) {
    const d = path.join(D.linux, 'hicolor', `${n}x${n}`, 'apps'); fs.mkdirSync(d, { recursive: true });
    await raster(markFor(n), n, path.join(d, 'waffle.png'));
  }
  const sc = path.join(D.linux, 'hicolor', 'scalable', 'apps'); fs.mkdirSync(sc, { recursive: true });
  fs.copyFileSync(path.join(D.svg, 'waffle-mark.svg'), path.join(sc, 'waffle.svg'));
  const sym = path.join(D.linux, 'hicolor', 'symbolic', 'apps'); fs.mkdirSync(sym, { recursive: true });
  fs.writeFileSync(path.join(sym, 'waffle-symbolic.svg'), MASTER.template);

  // Web
  await raster(MASTER.small, 16, path.join(D.web, 'favicon-16.png'));
  await raster(MASTER.small, 32, path.join(D.web, 'favicon.png'));
  await raster(MASTER.mark, 192, path.join(D.web, 'icon-192.png'));
  await raster(MASTER.mark, 512, path.join(D.web, 'icon-512.png'));

  // WKWebView only reads within app/, so keep a minimal deployment copy for all web hosts.
  const app = path.resolve(ROOT, '../app');
  if (fs.existsSync(path.join(app, 'index.html'))) {
    const runtime = path.join(app, 'brand');
    fs.mkdirSync(runtime, { recursive: true });
    for (const name of ['favicon-16.png', 'favicon.png', 'favicon.svg', 'icon-192.png']) {
      fs.copyFileSync(path.join(D.web, name), path.join(runtime, name));
    }
    for (const mode of ['light', 'dark']) {
      const name = `waffle-lockup-eda-on-${mode}.svg`;
      fs.copyFileSync(path.join(D.svg, name), path.join(runtime, name));
    }

    // The optional Windows installer needs three images at its manifest's exact sizes.
    const msix = path.resolve(ROOT, '../native/windows/packaging/Assets');
    fs.mkdirSync(msix, { recursive: true });
    for (const [size, name] of [[44, 'Square44x44Logo'], [50, 'StoreLogo'], [150, 'Square150x150Logo']]) {
      await raster(markFor(size), size, path.join(msix, name + '.png'));
    }
  }

  // 1x pixel crops for the sheets
  const px = async s => 'data:image/png;base64,' + (await raster(s, 16)).toString('base64');
  const PX = { mark: await px(MASTER.mark), small: await px(MASTER.small), mono: await px(MASTER.smallMono), icon: await px(MASTER.macosSmall), tmpl: await px(MASTER.template) };

  // ---------------- sheets ----------------
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1720, height: 1000 } });
  const page = await ctx.newPage();
  const CSS = fs.readFileSync(path.join(__dirname, 'sheet.css'), 'utf8');
  const img = (s, n, cls = '') => `<img src="${uri(s)}" width="${n}" height="${n}" class="${cls}">`;
  const cell = (inner, label) => `<div class="cell">${inner}<span>${label}</span></div>`;
  const zoom = (u, k = 5, cls = '') => `<img class="zoom ${cls}" src="${u}" width="${16 * k}" height="${16 * k}">`;
  async function shoot(html, file, width = 1720) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
    await page.locator('.sheet').screenshot({ path: path.join(D.png, file) });
  }
  const menubar = dark => `<div class="menubar"><div class="mb-blob" style="width:14px;opacity:.85"></div><span>Waffle</span>
    <div class="mb-blob" style="width:30px"></div><div class="mb-blob" style="width:30px"></div><div class="mb-blob" style="width:40px"></div>
    <div class="mb-r"><svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    <img src="${uri(MASTER.template)}" width="16" height="16" class="${dark ? 'inv' : ''}" style="opacity:.9">
    <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    <span style="font-weight:500">Sat 21 Nov 09:41</span></div></div>`;
  const wall = (dark, ic = MASTER.macos) => {
    const apps = [PH[0], PH[1], PH[2], ic, PH[3], PH[4], PH[5]];
    return `<div class="wall ${dark ? 'd' : 'l'}">${menubar(dark)}<div class="label">${dark ? 'Dark' : 'Light'}</div>
      <div class="dock">${apps.map((a, i) => `<div class="app ${i === 3 || i === 0 ? 'on' : ''}">${img(a, 64)}</div>`).join('')}</div></div>`;
  };
  const sizes = dark => `<div class="panel ${dark ? 'dark' : 'light'}">
    ${cell(img(MASTER.mark, 512), '1024 px (512 pt @2x)')}${cell(img(MASTER.mark, 256), '256')}
    ${cell(img(MASTER.mark, 64), '64')}${cell(img(MASTER.small, 32), '32 (small)')}${cell(img(MASTER.small, 16), '16 (small)')}
    <div class="sep"></div>${cell(img(MASTER.mark, 32), 'full at 32')}${cell(img(MASTER.mark, 16), 'full at 16')}
    <div class="sep"></div>${cell(zoom(PX.small), '16 @1x')}</div>`;
  const monoRow = dark => `<div class="panel ${dark ? 'dark' : 'light'}" style="gap:22px">
    ${cell(img(MASTER.mono, 160, dark ? 'inv' : ''), '160')}${cell(img(MASTER.mono, 64, dark ? 'inv' : ''), '64')}
    ${cell(img(MASTER.smallMono, 32, dark ? 'inv' : ''), '32')}${cell(img(MASTER.template, 16, dark ? 'inv' : ''), 'menu bar 16 pt')}
    ${cell(zoom(PX.tmpl, 5, dark ? 'inv' : ''), '16 @1x')}</div>`;
  const iconRow = dark => `<div class="panel ${dark ? 'dark' : 'light'}" style="gap:24px">
    ${cell(img(MASTER.macos, 256), '256')}${cell(img(MASTER.macos, 128), '128')}${cell(img(MASTER.macos, 64), '64')}
    ${cell(img(MASTER.macosSmall, 32), '32')}${cell(img(MASTER.macosSmall, 16), '16')}${cell(zoom(PX.icon), '16 @1x')}</div>`;

  if (process.argv.includes('--contact')) await shoot(`<div class="sheet"><h1>Waffle <small>final mark: Stack</small></h1>
    <p class="idea">A waffle slab on a copper foil and a PCB-green core, turned slightly off-axis. Rounded corners, recessed pockets, a plated via in the front channel and inner copper layers in the core.</p>
    <h2>Colour mark: 1024, 256, 64, 32, 16 on light and dark (32 and 16 use the two-slab small variant)</h2>${sizes(false)}<div style="height:16px"></div>${sizes(true)}
    <h2>Monochrome and menu-bar template</h2><div class="row2">${monoRow(false)}${monoRow(true)}</div>
    <h2>macOS app icon (824 pt plate, light from above; 32 and 16 slots use the small art)</h2><div class="row2">${iconRow(false)}${iconRow(true)}</div>
    <h2>In context: menu bar and Dock, next to neutral placeholder icons</h2><div class="row2">${wall(false)}${wall(true)}</div></div>`, 'contact-sheet.png');

  const flav = FLAVOURS.map(fl => `<div class="cell">${img(fl.icon, 200)}${img(fl.mark, 96)}<span><b>${fl.order}</b>&nbsp; ${fl.name}</span></div>`).join('');
  await shoot(`<div class="sheet" style="width:1800px"><h1>Waffle EDA: final identity</h1>
    <p class="idea">Stack mark, app icon, wordmark and release flavours. Palette: gold waffle (app accent #F0A32E), toast pockets (#A65300), copper foil, PCB-green core.</p>
    <div style="display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:20px">
      <div class="panel light" style="justify-content:center;align-items:center">${img(MASTER.mark, 400)}</div>
      <div class="panel dark" style="justify-content:center;align-items:center">${img(MASTER.macos, 360)}</div>
      <div class="panel light" style="justify-content:center;align-items:center">${img(MASTER.macosCream, 300)}<span class="note" style="writing-mode:vertical-rl">alt plate: cream</span></div>
    </div>
    <h2>Wordmark and lockups</h2>
    <div class="row2"><div class="panel light" style="justify-content:center;padding:40px"><img src="${uri(LOCK.light)}" height="130"></div>
      <div class="panel dark" style="justify-content:center;padding:40px"><img src="${uri(LOCK.dark)}" height="130"></div></div>
    <h2>Secondary lockup for the public name "Waffle EDA" (small caps: lighter stroke, cap height on the x-height)</h2>
    <div class="row2"><div class="panel light" style="justify-content:center;padding:32px"><img src="${uri(LOCK.edaLight)}" height="110"></div>
      <div class="panel dark" style="justify-content:center;padding:32px"><img src="${uri(LOCK.edaDark)}" height="110"></div></div>
    <h2>Small sizes, monochrome and platform sets</h2>
    <div class="panel light" style="gap:26px;align-items:center">
      ${cell(img(MASTER.mark, 64), 'mark 64')}${cell(img(MASTER.small, 32), 'small 32')}${cell(img(MASTER.small, 16), 'small 16')}
      ${cell(zoom(PX.small, 4), '16 @1x')}<div class="sep"></div>
      ${cell(img(MASTER.mono, 64), 'mono 64')}${cell(img(MASTER.template, 16), 'template 16')}${cell(zoom(PX.tmpl, 4), '@1x')}<div class="sep"></div>
      ${cell(img(MASTER.macos, 64), 'macOS 64')}${cell(img(MASTER.macosSmall, 32), 'macOS 32')}${cell(img(MASTER.macosSmall, 16), 'macOS 16')}
      <div class="sep"></div><div class="note" style="max-width:360px">.icns, .ico (16/24/32/48/64/256), Linux hicolor 16 to 512 + scalable + symbolic, favicon.svg/.png/.ico. See README.</div></div>
    <h2>Release flavours, in build order: the pocket glaze and the via take the codename's colour</h2>
    <div class="panel dark" style="justify-content:space-around">${cell(img(MASTER.macos, 200) + img(MASTER.mark, 96), '<b>Default</b>')}<div class="sep"></div>${flav}</div>
    <div class="note">Dock mocks use neutral placeholders only. Rendered with Playwright (Chrome channel) at deviceScaleFactor 2.</div></div>`, 'overview.png', 1900);

  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
