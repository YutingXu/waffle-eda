"use strict";
// Exercise prepositioned mathematical text independently of parsing. The source clusters here
// deliberately include a ligature, two meanings of one glyph, a composite accent, and a radical.
const assert = require("node:assert/strict");
for (const name of ["path-record","pdf","pdf-fonts","print","vendor/stix-two-math","math-font","math-tex","math","math-pdf"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const F=AtriumMathFont, P=AtriumPDF;
const glyph=(char,x,y,scale=1,text=char)=>({kind:"glyph",gid:F.idFor(char.codePointAt(0)),x,y,scale,text,start:0,end:char.length});
const commands=[glyph("𝑓",0,0,1,"f"),glyph("c",.46,.17,.68),glyph("=",1.15,0),
  glyph("é",2.16,-.47,.7),glyph("ﬁ",2.65,-.47,.7,"fi"),glyph("+",3.20,-.47,.7),glyph("Ω",3.82,-.47,.7),
  {kind:"rule",x:2.10,y:-.28,w:2.42,h:.05},glyph("√",2.30,.55,.78),glyph("x",2.83,.55,.78),
  {kind:"rule",x:2.82,y:0,w:.43,h:.044},glyph("ﬁ",4.76,0,1,"ﬁ")];
for (const c of commands) if (c.kind==="glyph") assert(c.gid>0);
const plain="fc = (éfi + Ω)/(√x) ﬁ", layout={advance:5.4,ascent:1,descent:.8,commands,plain,errors:[]};
const W=270,H=120,rec=P.recorder(W,H), ctx=rec.ctx;
ctx.save();ctx.beginPath();ctx.rect(7,7,W-14,H-14);ctx.clip();ctx.translate(18,17);
ctx.fillStyle="#14273b";ctx.drawMath(layout,0,44,37);ctx.restore();
assert.equal(rec.list.length,1);assert.deepEqual(rec.list[0].m,[37,0,0,37,18,61]);assert.equal(rec.list[0].layout,layout);
const shifted=P.shift(rec.list,4,5,[2,4,W-2,H-4]);assert.deepEqual(shifted[0].m,[37,0,0,37,22,66]);assert(shifted[0].clip.parent);
assert.deepEqual(P.counts(rec.list),{text:10,paths:2,images:0});
const svg=P.svg(W,H,rec.list), fi=F.idFor(0xfb01);
assert.equal(svg.split('id="math-g'+fi+'"').length,2,"one font outline per GID");
assert.equal(svg.split('href="#math-g'+fi+'"').length,3,"both ligature placements are drawn");
assert(svg.includes("<rect") && svg.includes("role=\"img\"") && svg.includes(plain));
function bytes(compress) {
  const doc=P.document({title:"Math subset"});doc.page(W,H,rec.list);return doc.bytes({compress});
}
const raw=Buffer.from(bytes(false)), contents=raw.toString("latin1");
assert.deepEqual(bytes(true),bytes(true));
assert.match(contents,/\/Type0\b/);assert.match(contents,/\/CIDFontType2\b/);assert.match(contents,/\/CIDToGIDMap \d+ 0 R/);
assert.match(contents,/\/ActualText <FEFF/i);assert.match(contents,/\/FontFile2 \d+ 0 R/);
assert.match(contents,/<[0-9a-f]{4}> <00660069>/i);assert.match(contents,/<[0-9a-f]{4}> <FB01>/i);
assert(raw.length < F.bytes().length/2);
// Exercise the same callback used by inline and display notes. An assembled delimiter
// has many decorative segments but exposes one logical token to the PDF.
const tex=String.raw`\left(\begin{matrix}a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\o\\p\end{matrix}\right)`;
const tall=AtriumMath.layout(tex,{display:true});assert.deepEqual(tall.errors,[]);
const pieces=tall.commands.filter(c=>c.kind==="glyph" && !c.text);
assert(pieces.length>20,"STIX assembly actually used");
const real=P.recorder(180,515);
AtriumMath.draw(real.ctx,tall,{x:8,y:14+tall.ascent*24,size:24,ink:"#222"});
assert.equal(real.list[0].layout,tall);
const tallDoc=P.document();tallDoc.page(180,515,real.list);
const realBytes=tallDoc.bytes();assert.deepEqual(realBytes,tallDoc.bytes());
const inline=AtriumMath.layout("x=\\frac{1}{2}"), line=P.recorder(400,120),lc=line.ctx,logical="Owner Bench "+inline.plain;
lc.beginActualText(logical);lc.font="12px sans-serif";lc.fillText("Owner",10,50);lc.fillText("Bench",51,50);
lc.drawMath(inline,100,50,12);lc.endActualText();
const lineDoc=AtriumPDF.document();lineDoc.page(400,120,line.list);
if (process.argv[2]) {
  const fs=require("node:fs"),path=require("node:path"),dir=process.argv[2];fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"math.pdf"),bytes(true));fs.writeFileSync(path.join(dir,"math.svg"),svg);
  fs.writeFileSync(path.join(dir,"line.pdf"),lineDoc.bytes());fs.writeFileSync(path.join(dir,"line-plain.txt"),logical);
  fs.writeFileSync(path.join(dir,"tall.pdf"),realBytes);fs.writeFileSync(path.join(dir,"tall-plain.txt"),tall.plain);
  fs.writeFileSync(path.join(dir,"original.ttf"),F.bytes());fs.writeFileSync(path.join(dir,"plain.txt"),plain);fs.writeFileSync(path.join(dir,"used.json"),JSON.stringify(commands.filter(c=>c.kind==="glyph")));
}
console.log("PASS selectable STIX glyphs, semantic clusters, mathematical rules, SVG outlines, exact page clipping and deterministic PDF subsets");
