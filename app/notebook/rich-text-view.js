"use strict";
// A single world-coordinate layout feeds the editor, the canvas, smart PDF and hit testing.
// A camera or theme change does not alter line breaking. Each paragraph caches its resolved runs.
globalThis.AtriumRichTextView = (() => {
  const F=globalThis.AtriumNotebookFonts,Fields=globalThis.AtriumNoteFields;
  const owners=new WeakMap(), paraCache=new WeakMap(), fallbackProject={documents:[],library:[]};
  const PAD=1.25, sizes={paragraph:1,h1:1.85,h2:1.5,h3:1.24,bullet:1,number:1,check:1}, stats={layouts:0,paragraphs:0};
  let theme=null,fontsStarted=false;
  function colours() {
    if(theme) return theme;
    const css=globalThis.document?.documentElement && globalThis.getComputedStyle?.(document.documentElement);
    const token=(k,f)=>css?.getPropertyValue(k)?.trim() || f;
    const paper=globalThis.AtriumTheme?.canvasPalette?.("sch")?.paper || token("--sheet","#fffcf8");
    function light(hex) {const v=/^#([a-f0-9]{6})$/i.exec(hex);if(!v)return .95;const c=[0,2,4].map(i=>parseInt(v[1].slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
    function readable(cssName,preferred,dark,bright) {const raw=token(cssName,preferred),a=light(raw),b=light(paper);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5?raw:b>.45?dark:bright;}
    theme={ink:readable("--ink","#282521","#282521","#f4f2ed"),paper,field:readable("--primary","#1266a0","#235b89","#9dd5ff"),broken:readable("--ls-ink","#a7241e","#a7241e","#ffb6ac"),
      faint:token("--line-strong","#9b9996"),accent:token("--focus","#0a6ed1")}; return theme;
  }
  globalThis.addEventListener?.("atrium-theme",()=>{theme=null;});
  function textFace(font,run) {return F.face(font,run);}
  function resolved(project,doc,block,opts) {
    return block.runs.map(r=>{
      if(r.type==="field") {const f=Fields.resolve(project,doc,r.expression,r.binding,opts);return {r,text:f.text,field:f};}
      if(r.type==="math") {const math=globalThis.AtriumMath?.layout?.(r.tex,{display:false});return {r,text:math?.plain || r.tex,math};}
      return {r,text:r.text || ""};
    });
  }
  function paragraph(block,index,font,size,width,values) {
    const heading=/^h[123]$/.test(block.style), em=size*(sizes[block.style] || 1), step=em*1.45;
    const marker=block.style==="check"?(block.checked?"☑":"☐"):block.style==="bullet"?"•":block.style==="number"?(index+1)+".":"";
    const inset=marker?em*1.55:0, maximum=Math.max(em,width-inset),lines=[];let line=[],advance=0,body=0;
    const end=()=>{
      while(line.at(-1)?.space) {advance-=line.pop().width;}
      const rise=Math.max(em*1.05,...line.map(v=>(v.math?.ascent || 0)*v.em));
      const fall=Math.max(em*.32,...line.map(v=>(v.math?.descent || 0)*v.em));
      const baseline=body+rise,x0=inset+(block.align==="right"?maximum-advance:block.align==="center"?(maximum-advance)/2:0);
      const first=!lines.length;
      for(const v of line){v.x+=x0;v.y=baseline;}
      lines.push({runs:line,baseline,height:Math.max(step,rise+fall+em*.08),marker:first?marker:""});
      body+=lines.at(-1).height;line=[];advance=0;
    };
    const add=(chunk,value,face,w,space=false)=>{
      if(advance && advance+w>maximum && !space) end();
      if(!line.length && space) return;
      line.push({...value,face,text:chunk,em,x:advance,y:0,width:w,space});advance+=w;
    };
    for(const v of values) {
      const r=v.r,face=textFace(font,{...r,bold:!!(r.bold || heading)});
      if(v.math || r.type==="field") {add(v.text,v,face,(v.math?.advance ?? F.measure(face,v.text))*em);continue;}
      for(const t of v.text.match(/\n|[^\S\n]+|[^\s]+/gu) || []) {
        if(t==="\n"){end();continue;}
        const w=F.measure(face,t)*em,space=/^\s+$/u.test(t);
        if(w<=maximum || space) {add(t,v,face,w,space);continue;}
        for(const ch of t) add(ch,v,face,F.measure(face,ch)*em);
      }
    }
    end();
    return {block,em,lines,height:body+(heading?em*.10:0)};
  }
  function layout(project,doc,item,opts={}) {
    project=project || fallbackProject;
    const body=item.richText, width=Math.max(2.5,Math.abs(item.w || 0)-PAD*2),size=item.size || 2.7;
    if (!body || !Array.isArray(body.blocks)) return null;
    if(body.font?.source==="asset")F.prepareItem(item,opts.resolveAsset);
    const font=F.fontFor(item),host=globalThis.AtriumNavHost;
    const revision=opts.revision ?? (host?.project?.()===project?host.revision():null), key=[width,size,typeof font==="string"?font:JSON.stringify(font),opts.instanceId || "",opts.now || "",!!globalThis.AtriumMath].join("|");
    let cached=owners.get(item);
    if(cached && cached.body===body && cached.key===key && cached.project===project && revision!=null && cached.revision===revision) return cached;
    const blocks=[];let y=PAD, number=0;
    for(const block of body.blocks) {
      if(!Array.isArray(block?.runs)) continue;
      const values=resolved(project,doc,block,opts), n=block.style==="number"?number++:(number=0);
      const sig=key+"|"+n+"|"+JSON.stringify(block)+"|"+JSON.stringify(values.filter(v=>v.field).map(v=>[v.text,v.field.broken,v.field.sourceId]));
      let part=paraCache.get(block);
      if(!part || part.sig!==sig){part={sig,layout:paragraph(block,n,font,size,width,values)};paraCache.set(block,part);stats.paragraphs++;}
      blocks.push({layout:part.layout,y});y+=part.layout.height;
    }
    if(cached && cached.key===key && cached.blocks.length===blocks.length && blocks.every((b,i)=>b.layout===cached.blocks[i].layout)) {cached.revision=revision;return cached;}
    cached={project,body,key,revision,blocks,width:width+PAD*2,height:y+PAD};owners.set(item,cached);stats.layouts++;return cached;
  }
  function startFonts() {
    if(fontsStarted || !globalThis.document?.fonts) return;
    fontsStarted=true;F.ready().then(()=>globalThis.AtriumNavHost?.redraw?.()).catch(()=>{fontsStarted=false;});
  }
  const paperColours={ink:"#191919",field:"#235b89",broken:"#a7241e",faint:"#8c8c8c",accent:"#235b89"};
  function draw(ctx,item,o) {
    const project=o.project || globalThis.AtriumNavHost?.project?.(),c=o.colours || (o.print?paperColours:colours());
    if(!o.print && (item.size || 2.7)*o.scale<2.4) {
      const x=Math.min(item.x,item.x+item.w),y=Math.min(item.y,item.y+item.h),w=Math.abs(item.w),h=Math.abs(item.h);
      ctx.save();if(item.fill){ctx.fillStyle=item.fill;ctx.fillRect(x,y,w,h);}
      if(item.border || o.selected){ctx.strokeStyle=o.selected?o.select || c.accent:c.faint;ctx.lineWidth=1/o.scale;ctx.strokeRect(x,y,w,h);}
      ctx.fillStyle=c.ink;ctx.globalAlpha*=.4;const pitch=(item.size || 2.7)*1.45;
      for(let n=0;n<Math.min(item.richText.blocks.length,Math.floor(h/pitch));n++)ctx.fillRect(x+PAD,y+PAD+n*pitch,Math.max(0,w-2*PAD)*.65,.8/o.scale);
      ctx.restore();return true;
    }
    const L=layout(project,o.doc,item,o);
    if(!L) return false;
    if(item.richText.blocks.some(b=>b.runs?.some(r=>r.type==="math")) && !globalThis.AtriumMath && globalThis.AtriumLazy?.modules().includes("AtriumMath") && !AtriumLazy.pending("AtriumMath")) AtriumLazy.need("AtriumMath").then(()=>globalThis.AtriumNavHost?.redraw?.());
    startFonts();
    const h=Math.abs(item.h || 0),ox=Math.min(item.x,item.x+item.w),oy=Math.min(item.y,item.y+item.h);
    const ink=c.ink;
    ctx.save();ctx.translate(ox,oy);ctx.beginPath();ctx.rect(0,0,L.width,h);
    if(item.fill) {ctx.fillStyle=item.fill;ctx.fill();}
    if(item.border || o.selected) {ctx.strokeStyle=o.selected?o.select || c.accent:c.faint;ctx.lineWidth=Math.max(.09,.8/(o.scale || 1));ctx.stroke();}
    ctx.clip();ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.fontKerning="none";
    for(const {layout:part,y} of L.blocks) {
      if(y>=h) break;
      for(const line of part.lines) {
        if(ctx.beginActualText) {
          const text=(line.marker?line.marker+" ":"")+line.runs.map(run=>run.math?.plain ?? run.text).join("");
          ctx.beginActualText(text);
        }
        if(line.marker) {
          ctx.font=F.css(textFace(F.fontFor(item),{}),part.em);ctx.fillStyle=ink;
          if(part.block.style==="check") {
            const x=PAD,by=y+line.baseline-part.em*.76,s=part.em*.72;
            ctx.strokeStyle=ink;ctx.lineWidth=part.em*.07;ctx.strokeRect(x,by,s,s);
            if(part.block.checked){ctx.beginPath();ctx.moveTo(x+s*.14,by+s*.47);ctx.lineTo(x+s*.39,by+s*.75);ctx.lineTo(x+s*.91,by+s*.13);ctx.stroke();}
          } else ctx.fillText(line.marker,PAD,y+line.baseline);
        }
        for(const run of line.runs) {
          const {r,field,face,em,width}=run,x=PAD+run.x,baseline=y+run.y,top=baseline-em;
          if(r.highlight) {ctx.fillStyle=r.highlight;ctx.fillRect(x,top,width,em*1.18);}
          const color=field?.broken?c.broken:r.color || (field||r.href?c.field:ink);
          ctx.fillStyle=color;ctx.font=F.css(face,em);
          if(run.math) globalThis.AtriumMath.draw(ctx,run.math,{x,y:baseline,size:em,ink:color});
          else ctx.fillText(run.text,x,baseline);
          if(r.underline || r.href || field || r.strike) {
            ctx.strokeStyle=color;ctx.lineWidth=em*.052;
            const rule=yy=>{ctx.beginPath();ctx.moveTo(x,yy);ctx.lineTo(x+width,yy);ctx.stroke();};
            if(r.strike) rule(baseline-em*.29);
            if(r.underline || r.href || field) {if(field?.broken)ctx.setLineDash?.([em*.18,em*.13]);rule(baseline+em*.09);ctx.setLineDash?.([]);}
          }
        }
        ctx.endActualText?.();
      }
    }
    ctx.restore();return true;
  }
  function hit(project,doc,item,point,opts={}) {
    const L=layout(project,doc,item,opts),x=point[0]-Math.min(item.x,item.x+item.w),y=point[1]-Math.min(item.y,item.y+item.h);
    if(!L || x<0 || y<0 || x>L.width || y>Math.abs(item.h)) return null;
    for (let i=0;i<L.blocks.length;i++) {const b=L.blocks[i],p=b.layout;
      if(y<b.y || y>b.y+p.height) continue;
      if(p.block.style==="check" && x<PAD+p.em*1.35) return {check:i};
      for(const line of p.lines)for(const r of line.runs) if(x>=PAD+r.x && x<=PAD+r.x+r.width && y>=b.y+r.y-r.em*1.05 && y<=b.y+r.y+r.em*.34) return r;
    }
    return null;
  }
  function recordLinkRects(project, doc, item) {
    const isLink = globalThis.AtriumLinkRecord?.parse;
    if (!isLink || !item.richText) return [];
    const result = layout(project, doc, item);
    if (!result) return [];
    const left = Math.min(item.x, item.x + item.w), top = Math.min(item.y, item.y + item.h), height = Math.abs(item.h);
    const rectangles = [];
    for (const block of result.blocks) for (const line of block.layout.lines) for (const run of line.runs) {
      const href = run.r.href;
      if (!isLink(href)) continue;
      const x = Math.max(0, PAD + run.x), x2 = Math.min(result.width, PAD + run.x + run.width);
      const y = Math.max(0, block.y + run.y - run.em), y2 = Math.min(height, block.y + run.y + run.em * .25);
      if (x2 > x && y2 > y) rectangles.push({href, world:[left + x, top + y, left + x2, top + y2]});
    }
    return rectangles;
  }
  return Object.freeze({layout,draw,hit,recordLinkRects,stats,colours,ready:F.ready});
})();
