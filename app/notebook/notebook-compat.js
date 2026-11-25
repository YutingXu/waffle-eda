"use strict";
// A saved notebook remains visible when authoring is disabled. Render only its
// stored projection and optional asset. Never evaluate a field, script or formula.
globalThis.AtriumNotebookCompat = (() => {
  const G=globalThis;
  const labels={richtext:"Engineering note",math:"Equation",calculation:"Calculation",widget:"Widget",table:"Table",todo:"To-do list",
    sticky:"Sticky note",callout:"Callout",inkStroke:"Sketch",ink:"Sketch",image:"Image",imageMarkup:"Image markup"};
  const pigments={ink:"#425164",blue:"#326fa8",green:"#298155",amber:"#b47816",red:"#b24d50",violet:"#8556a9"};
  function kind(item) {return G.Atrium.notebookItemKind(item);}
  const locked=item=>G.AtriumLabs?.notebookEnabled()===false && !!kind(item);
  function body(body) {
    return (body?.blocks || []).map(b=>(b.style==="check"?(b.checked?"☑ ":"☐ "):"")+
      (b.runs || []).map(r=>r.text ?? r.tex ?? r.expression ?? "").join("")).join("\n");
  }
  function description(item,project) {
    const w=item.widget, s=w?.state;
    if(w?.type==="todo" && Array.isArray(s?.rows) && s.rows.length) {
      return s.rows.map(r=>{
        const linked=r.threadId && project?.review?.records?.[r.threadId];
        const check=r.threadId?(linked?(linked.status==="resolved"?"☑":"☐"):"?"):(r.done?"☑":"☐");
        return [check+" "+r.text,r.assignee,r.due].filter(Boolean).join(" · ");
      }).join("\n");
    }
    if(w?.type==="table" && Array.isArray(s?.columns) && Array.isArray(s.rows)) {
      const cols=s.columns;
      return [cols.map(c=>c.title).join("   "),...s.rows.map(r=>cols.map(c=>{
        const v=r["c_"+c.id.replace(/-/g,"")];return v?.text ?? v?.expression ?? v?.blockId ?? "";
      }).join("   "))].join("\n");
    }
    if(w?.fallback?.type==="image")return w.fallback.alt || item.text || "Image";
    if(w?.type?.startsWith("ext."))return w.fallback?.text || item.text || w.type;
    if(item.calculation)return [item.text || item.source,...(item.calculation.assertions || []).map(a=>a.source)].filter(Boolean).join("\n");
    if(item.kind==="image")return [item.alt || item.name,item.caption].filter(Boolean).join("\n") || "Image";
    return item.text || body(item.richText) || item.tex || item.source || w?.fallback?.text || labels[kind(item)] || "Notebook item";
  }
  function label(item) {return labels[item.widget?.type] || labels[kind(item)] || "Notebook item";}
  function navigation(item,project) {
    const links=new Map(),doc=(id)=>project.documents.find(d=>d.id===id);
    function target(binding,text) {
      if(!binding?.docId || !binding.itemId || !doc(binding.docId)?.items.some(i=>i.id===binding.itemId))return;
      links.set("item/"+binding.docId+"/"+binding.itemId,{text,docId:binding.docId,itemId:binding.itemId});
    }
    function external(raw,text) {
      if (G.AtriumPrefs?.get("butter.links") === true && G.AtriumLinkRecord?.parse(raw)) {
        links.set(raw,{text,url:raw}); return;
      }
      try{const url=new URL(raw);if(["https:","http:"].includes(url.protocol) && !url.username && !url.password)links.set(url.href,{text,url:url.href});}catch{}
    }
    const w=item.widget;
    if(w?.type==="link")external(w.state?.url,w.state?.caption || "Open link");
    if(w?.type==="todo")for(const r of w.state?.rows || []){
      target(r.link,"Go to linked object · "+r.text);
      if(r.threadId && project.review?.records?.[r.threadId]?.type==="thread")links.set("thread/"+r.threadId,{text:"Open review thread · "+r.text,threadId:r.threadId});
    }
    target(item.callout?.anchor,"Go to callout target");
    for(const b of item.richText?.blocks || [])for(const r of b.runs || []){
      if(r.type==="field")target(r.binding,"Go to "+r.expression);
      if(r.href)external(r.href,r.text || "Open link");
    }
    return [...links.values()];
  }
  async function follow(link,host) {
    if(link.url){
      if (G.AtriumLinkRecord?.parse(link.url)) {
        if (G.AtriumPrefs?.get("butter.links") !== true) return false;
        return (await G.AtriumLazy.need("AtriumLinksDesktop")).receive(link.url);
      }
      if(G.AtriumHost?.openURL)return G.AtriumHost.openURL(link.url);
      if(!G.AtriumHost)return G.open?.(link.url,"_blank","noopener,noreferrer");
    }else if(link.threadId){
      const project=host.project(),review=G.AtriumReviewComments || await G.AtriumLazy?.need("AtriumReviewComments");
      if(project===host.project())review?.focus?.(link.threadId,true);
    }else if(link.itemId){
      await host.selectDocument(link.docId);
      if(host.currentId()===link.docId && host.doc().items.some(i=>i.id===link.itemId))host.select([link.itemId]);
    }
  }
  function visible(item,doc,o) {
    if(!(o.print || o.purpose==="print") || (o.includeNotes ?? doc?.notesLayer?.print)!==false)return true;
    // Review Notes owns this print setting. Ordinary engineering notes, equations
    // and figures remain on the schematic, as in the authoring renderer.
    return !(item.sticky || item.callout || item.ink || item.widget?.type==="todo" && item.widget.state?.rows?.some(r=>r.threadId));
  }
  function stroke(ctx,i) {
    const a=i.ink;
    if(!Array.isArray(a?.at)||!Array.isArray(a.path))return false;
    let x=i.x+a.at[0],y=i.y+a.at[1];
    ctx.save();ctx.strokeStyle=ctx.fillStyle=pigments[a.colour] || pigments.ink;ctx.lineWidth=a.width || .45;
    if(a.brush==="highlighter")ctx.globalAlpha*=.28;
    ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(x,y);
    for(let p=0;p+2<a.path.length;p+=3){x+=a.path[p];y+=a.path[p+1];ctx.lineTo(x,y);}
    if(a.path.length)ctx.stroke();else {ctx.arc(x,y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}
    ctx.restore();return true;
  }
  // A file can finish while its initial fallback already occupies a retained
  // canvas layer. Invalidate that sheet's artwork when its reader is ready.
  const pending=new Map();
  function displayReader(name,doc) {
    if(G[name])return G[name];
    const lazy=G.AtriumLazy;
    if(!lazy || !doc)return null;
    let sheets=pending.get(name);
    if(sheets){sheets.add(doc);return null;}
    sheets=new Set([doc]);pending.set(name,sheets);
    lazy.need(name).then(()=>{
      const host=G.AtriumNavHost;
      for(const sheet of sheets)if(host?.docById?.(sheet.id)===sheet)host.invalidateDocument(sheet.id,true);
    },()=>{}).finally(()=>pending.delete(name));
    return null;
  }
  function photo(ctx,item,doc,o){
    const reader=displayReader("AtriumNotebookImages",doc);
    if(!G.AtriumSchNoteMarkup && doc?.items?.some(m=>m.kind==="imageMarkup" && m.imageId===item.id))displayReader("AtriumSchNoteMarkup",doc);
    if(!reader)return false;
    reader.draw(ctx,item,{...o,doc});
    return true;
  }
  function required(project,ids,options={}) {
    const chosen=ids && new Set(ids), names=new Set();
    for(const doc of project.documents){
      if(doc.kind!=="schematic" || chosen && !chosen.has(doc.id))continue;
      for(const item of doc.items){
        if(!kind(item) || !visible(item,doc,{...options,print:true}))continue;
        if(item.math===true || item.richText?.blocks?.some(b=>b.runs?.some(r=>r.type==="math")))names.add("AtriumMath");
        if(item.richText?.blocks)names.add("AtriumRichTextView");
        if(item.asset || item.widget?.fallback?.assetRef)names.add("AtriumNotebookImages");
        if(item.kind==="imageMarkup")names.add("AtriumSchNoteMarkup");
      }
    }
    return [...names];
  }
  function prepare(project,ids,resolveAsset,options={}) {
    const names=required(project,ids,options);
    if(!names.length)return null;
    const missing=names.filter(n=>!G[n]);
    const fonts=()=>names.includes("AtriumRichTextView") ? G.AtriumNotebookFonts?.prepareAssets?.(project,ids,resolveAsset) : null;
    return missing.length && G.AtriumLazy ? G.AtriumLazy.need(missing).then(fonts) : fonts();
  }
  function colours(doc,item,o) {
    const print=o.print || o.purpose==="print", palette=G.AtriumTheme?.color;
    const sheetPaper=!doc?.sheet?.infinite && (doc?.schDrawing || doc?.schRestored?.sheet)?.paper;
    const paper=sheetPaper || (print?"#ffffff":G.AtriumSchAppearance?.paper || "#fffcf8");
    const rgb=/^#([a-f0-9]{6})$/i.exec(paper);
    const dark=palette?palette.luminance(paper)<.18:rgb && parseInt(rgb[1].slice(2,4),16)<90;
    const card=item.sticky || item.callout || item.widget || item.kind==="image";
    const surface=item.fill || (card?(dark?"#25343c":"#f0f4f3"):paper);
    const ink=palette?.bestInk(surface,"#253b43","#f2f4f4") || (dark?"#f2f4f4":"#253b43");
    const line=pigments[item.sticky?.colour || item.callout?.colour] || (dark?"#89a9ba":"#79929b");
    const contrast=(value,ratio)=>palette?.ensureContrast(value,surface,ratio) || value;
    return {surface,ink,accent:contrast(line,3),field:contrast(dark?"#9dd5ff":"#235b89",4.5),
      broken:contrast(dark?"#ffb6ac":"#a7241e",4.5),faint:contrast(line,3),paper:surface};
  }
  function draw(ctx,i,doc,o={}) {
    if(!visible(i,doc,o) || i.kind==="imageMarkup")return;
    const {x,y,w,h}=i;
    if(!(w>0 && h>0))return;
    const fallback=i.widget?.fallback,asset=i.kind==="image"?i.asset:fallback?.assetRef;
    const image=asset && (i.kind==="image"?i:{...i,kind:"image",asset,alt:fallback.alt});
    const palette=colours(doc,i,o),foreground=palette.ink,accent=palette.accent;
    const math=i.math===true && displayReader("AtriumMath",doc), rich=i.richText && displayReader("AtriumRichTextView",doc);
    if(i.richText?.blocks?.some(b=>b.runs?.some(r=>r.type==="math")))displayReader("AtriumMath",doc);
    if(math)math.drawItem(ctx,i,foreground);
    const graphical=math || (image?photo(ctx,image,doc,o):!!i.ink && stroke(ctx,i));
    if(!graphical){
      ctx.save();
      const anchor=i.callout?.anchor?.at;
      if(Array.isArray(anchor) && anchor.length===2) {
        ctx.strokeStyle=accent;ctx.lineWidth=.28;ctx.beginPath();ctx.moveTo(Math.min(x+w,Math.max(x,anchor[0])),Math.min(y+h,Math.max(y,anchor[1])));ctx.lineTo(anchor[0],anchor[1]);ctx.stroke();
      }
      ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
      {
        if(i.sticky || i.callout || i.widget || i.kind==="image"){ctx.fillStyle=palette.surface;ctx.fillRect(x,y,w,h);}
        if(i.border!==false || i.sticky || i.callout || i.widget){ctx.strokeStyle=accent;ctx.lineWidth=.3;ctx.strokeRect(x,y,w,h);}
        if(rich && rich.draw(ctx,i,{...o,doc,colours:palette,print:o.print || o.purpose==="print"})){
          ctx.restore();
          if(o.selected)o.schBox?.([x,y,x+w,y+h]);
          return;
        }
        const size=Math.max(.6,Math.min(i.size || 2.4,h*.7)),inset=Math.min(1.2,w*.04,h*.1),width=Math.max(.05,w-inset*2);
        ctx.fillStyle=foreground;ctx.font=size+"px sans-serif";ctx.textBaseline="top";ctx.textAlign="left";
        let baseline=y+inset;
        for(const line of description(i,o.project || (!o.print && o.purpose!=="print" && G.AtriumNavHost?.project?.())).split("\n")){
          let row="";
          for(const word of line.split(/\s+/)){
            const next=row?row+" "+word:word;
            if(row && ctx.measureText(next).width>width){ctx.fillText(row,x+inset,baseline,width);baseline+=size*1.3;row=word;}else row=next;
            if(baseline>=y+h)break;
          }
          if(baseline>=y+h)break;
          if(row)ctx.fillText(row,x+inset,baseline,width);
          baseline+=size*1.3;
          if(baseline>=y+h)break;
        }
      }
      ctx.restore();
    }
    if(o.selected)o.schBox?.([x,y,x+w,y+h]);
  }
  return Object.freeze({locked,label,description,navigation,follow,required,prepare,colours,draw});
})();
