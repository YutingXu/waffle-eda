"use strict";
// Readers for the reports Altium Designer writes next to its fabrication outputs, used as external
// references (oracles) for Waffle's own checks and outputs:
//   drc(html)   Design Rule Verification Report (Design Rules Check.html): the summary tables
//               (warnings, rule violations, waived violations, one row per rule with its count) and
//               every listed violation (rule, measured value, the two objects with their positions).
//   erc(html)   Electrical Rule Check Report (Electrical Rules Check.html): one row per message.
//   bom(bytes)  a Bill of Materials .xlsx: the first sheet's rows, cells as text.
// The parsers need no Node-only API, so suites using them also run under JavaScriptCore.
// tests/fixtures/altium/pidp11-io-expander/altium-reports-reva.json holds what these readers return
// for the PiDP-11 RevA release files (the HTML carries the author's machine paths, which the
// public-tree check does not allow, so only the readings are vendored). When the full-tier cache has
// the original files (tests/altium-fidelity/fetch.py), reference() reads them again and checks the
// extract against them.
const fs = require("node:fs"), path = require("node:path");

const entity = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const plain = s => entity(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
const MIL = .0254;
// "Pad C1-1(947.716mil,260mil) on Top Layer" and "Arc (1227.479mil,318.488mil) on Top Overlay".
function objects(text) {
  const out = [], re = /(Pad|Via|Track|Arc|Text|Fill|Region|Component|Poly|Polygon|Hole)\s*(?:([^\s(]+?)|"([^"]*)")?\s*\((-?[\d.]+)mil,(-?[\d.]+)mil\)\s*on ([A-Za-z0-9 -]+?)(?= And | \[|$)/g;
  for (let m; (m = re.exec(text));) out.push({kind: m[1], name: m[2] || m[3] || "", at: [+m[4], +m[5]], layer: m[6].trim()});
  return out;
}
function summaryTable(html, heading) {
  const start = html.indexOf("<th class=\"column1\">" + heading + "</th>");
  if (start < 0) return null;
  const end = html.indexOf("</table>", start), rows = [];
  const re = /<td class="column1"><a href="#[^"]*">([\s\S]*?)<\/a><\/td>\s*<td class="column2">(\d+)<\/td>/g;
  const body = html.slice(start, end);
  for (let m; (m = re.exec(body));) rows.push({rule: plain(m[1]), count: +m[2]});
  const total = /Total<\/td>\s*<td[^>]*>(\d+)<\/td>/.exec(body);
  return {rows, total: total ? +total[1] : null};
}
function drc(html) {
  const header = label => { const m = new RegExp(label + ":</td>[\\s\\S]*?DRC_summary_header_col3[^>]*>(\\d+)<").exec(html); return m ? +m[1] : null; };
  const listed = [];
  // Each listed violation is an <acronym> with the full message; a waived one is followed by its waiver.
  const re = /<acronym title="[^"]*">([\s\S]*?)<\/acronym><\/a>((?:<br>[^<]*)*)<\/td>/g;
  for (let m; (m = re.exec(html));) {
    const text = plain(m[1]), c = /^(.*?) Constraint: \(([^)]*?) < ([\d.]+)mil\) Between (.*)$/.exec(text) || /^(.*?): \(([^)]*?) < ([\d.]+)mil\) Between (.*)$/.exec(text);
    if (!c) continue;  // the report's own file name and other links
    const measured = /^([\d.]+)mil$/.exec(c[2]);
    listed.push({text, rule: c[1], actualMil: measured ? +measured[1] : /collision/i.test(c[2]) ? 0 : null,
      limitMil: +c[3], objects: objects(c[4]), waived: /Waived by/.test(m[2])});
  }
  return {warnings: header("Warnings"), violations: header("Rule Violations"), waivedViolations: header("Waived Violations"),
    summary: {warnings: summaryTable(html, "Warnings"), rules: summaryTable(html, "Rule Violations"), waived: summaryTable(html, "Waived Violations")}, listed};
}
// Messages are Class | Document | Message rows; a clean compile is one row with a single cell.
function erc(html) {
  const messages = [], notes = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td class="column\d">([\s\S]*?)<\/td>/g)].map(m => plain(m[1]));
    if (cells.length >= 3) messages.push({class: cells[0], document: cells[1], message: cells[2]});
    else if (cells.length) notes.push(cells.join(" "));
  }
  return {messages, notes};
}
// .xlsx (Office Open XML): shared strings and the first worksheet's cells, as text per row.
function bom(bytes) {
  if (!globalThis.AtriumImportFormats) require(require("./app-source-paths.cjs").appFile("sexpr.js"));
  const Z = globalThis.AtriumImportFormats;
  const files = Z.unzip(bytes), text = n => files.has(n) ? new TextDecoder("utf-8").decode(files.get(n)) : "";
  const strings = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => entity([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const rows = [];
  for (const r of text("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || "")?.[1];
      const inline = /<is>([\s\S]*?)<\/is>/.exec(c[3] || "")?.[1];
      cells[col] = v == null ? (inline ? entity(inline.replace(/<[^>]+>/g, "")) : "") : /t="s"/.test(c[2]) ? strings[+v] : entity(v);
    }
    if (cells.some(x => x)) rows.push(Array.from(cells, x => x ?? ""));
  }
  return {rows};
}

// The vendored extract, checked against the original release files when the fetched cache has them.
const FIXTURE = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
function reference() {
  const ref = JSON.parse(fs.readFileSync(path.join(FIXTURE, "altium-reports-reva.json"), "utf8"));
  let verified = false;
  const home = typeof process !== "undefined" && process.env && (process.env.XDG_CACHE_HOME || (process.env.HOME && path.join(process.env.HOME, ".cache")));
  const dir = home && path.join(home, "waffle/altium-fidelity/pidp11-io-expander", ref.source.revision);
  if (dir && fs.existsSync(path.join(dir, "Design Rules Check.html"))) {
    if (!globalThis.AtriumSourceFile) require(require("./app-source-paths.cjs").appFile("source-file.js"));
    const sha = globalThis.AtriumSourceFile.sha256, read = name => new Uint8Array(fs.readFileSync(path.join(dir, name)));
    const latin1 = b => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
    for (const f of ref.source.files) if (sha(read(f.name)) !== f.sha256) throw Error(f.name + " in the fetched cache is not the release file");
    const again = {drc: drc(latin1(read("Design Rules Check.html"))), erc: erc(latin1(read("Electrical Rules Check.html"))), bom: bom(read("Bill of Materials.xlsx"))};
    for (const k of ["drc", "erc", "bom"]) if (JSON.stringify(again[k]) !== JSON.stringify(ref[k])) throw Error("altium-reports-reva.json differs from the readings of the release's " + k + " report");
    verified = true;
  }
  return {...ref, verified};
}
module.exports = {drc, erc, bom, objects, reference, MIL};
