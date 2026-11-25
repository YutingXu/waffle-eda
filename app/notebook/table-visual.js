"use strict";
globalThis.AtriumTableVisual = (() => {
  const G=globalThis,T=G.AtriumTableData,X=G.AtriumTableExchange;
  const positions=new WeakMap(),presentedRows=new WeakMap();
  function offsets(axis,key,fallback) {
    let out=positions.get(axis);if(out)return out;
    out=new Float64Array(axis.length+1);
    for(let i=0;i<axis.length;i++)out[i+1]=out[i]+Math.max(.5,(axis[i][key]??fallback)/1e6);
    positions.set(axis,out);return out;
  }
  function first(arr,n) {
    let lo=0,hi=arr.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(arr[mid+1]<=n)lo=mid+1;else hi=mid;}
    return lo;
  }
  function layout(s,box) {
    const x=offsets(s.columns,"widthNm",14000000),y=offsets(s.rows,"heightNm",4500000);
    const c0=first(x,Math.max(0,box[0])),r0=first(y,Math.max(0,box[1]));
    const c1=Math.min(s.columns.length,first(x,box[2])+1),r1=Math.min(s.rows.length,first(y,box[3])+1);
    return {x,y,c0,c1,r0,r1,width:x.at(-1),height:y.at(-1)};
  }
  function rowNumbers(s,rows){
    if(rows===s.rows)return T.index(s).rows;
    let byId=presentedRows.get(rows);
    if(!byId){byId=new Map(rows.map((row,i)=>[row.id,i]));presentedRows.set(rows,byId);}
    return byId;
  }
  // Sorting and filtering keep each merge's rows together in authored order, even if a
  // viewport starts inside the span. Resolve to the presented anchor before clipping.
  function projectedCell(s,rows,r,c,seen){
    const row=rows[r],col=s.columns[c];
    if(!row||!col)return null;
    const merge=T.merged(s,row.id,col.id);
    if(!merge)return {rid:row.id,cid:col.id,x:c,y:r,nx:c+1,ny:r+1};
    if(seen?.has(merge.id))return null;
    const rid=merge.rows[0],cid=merge.columns[0];
    const x=T.index(s).columns.get(cid),y=rowNumbers(s,rows).get(rid);
    if(x==null||y==null)return null;
    seen?.add(merge.id);
    return {merge,rid,cid,x,y,nx:x+merge.columns.length,ny:y+merge.rows.length};
  }
  function values(project,doc,item,context={}) {
    const s=item.widget.state;
    let report;
    if(T.contentKinds(s).has("formula") && G.AtriumTableFormulas)
      report=context.formulaReport?.() ?? G.AtriumTableFormulas.report(project,doc,item,context);
    return (rowId,columnId)=>{
      const content=T.get(s,rowId,columnId)?.content;
      if(!content)return "";
      if(content.kind==="formula"){const v=report?.value(rowId,columnId);return v?.ok?v.display:v?.diagnostic?.message || "Formula unavailable";}
      if(content.kind==="field"||content.kind==="calculation")return G.AtriumSheetWidgets.resolveCell(project,doc,content,context).text;
      if(content.kind==="rich")return G.AtriumNotebook?.bodyText(content.richText,project,doc,context)?.text ?? X.plain(content);
      return X.plain(content);
    };
  }
  function view(project,doc,item,context={}) {
    const s=item.widget.state,value=values(project,doc,item,context),rows=T.presentationRows(s,value);
    const shown=rows===s.rows?s:{...s,rows},g=layout(shown,[0,0,item.w,item.h]);
    const preview=[];
    for(let r=0;r<Math.min(g.r1,32);r++)preview.push(s.columns.slice(0,Math.min(g.c1,16)).map(c=>value(rows[r].id,c.id)).join("\t"));
    if(context.queryDiagnostic)preview.unshift(context.queryDiagnostic);
    return {title:item.text||"Table",width:item.w,height:item.h,rows:[],fallback:{type:"text",text:preview.join("\n").slice(0,4096)},
      table:{s,shown,value,project,doc,context}};
  }
  function draw(ctx,v,{x=0,y=0,w=v.width,h=v.height,viewport,theme={},assets,scale=1}={}) {
    const {s,shown,value,project,doc,context}=v.table;
    const visible=Array.isArray(viewport)&&viewport.length===4?[Math.max(0,viewport[0]-x),Math.max(0,viewport[1]-y),Math.min(w,viewport[2]-x),Math.min(h,viewport[3]-y)]:[0,0,w,h];
    if(visible[0]>=visible[2]||visible[1]>=visible[3])return 0;
    const notice=context.queryDiagnostic && h>=9 ? 4.5 : 0;
    ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();
    if(notice && visible[1]<notice){
      ctx.fillStyle=theme.paper||"#fff";ctx.fillRect(0,0,w,notice);
      ctx.fillStyle=theme.broken||theme.ink||"#192330";ctx.font="1.85px system-ui";
      ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText(context.queryDiagnostic,.7,notice/2,Math.max(.1,w-1.4));
    }
    if(notice)ctx.translate(0,notice);
    const bounds=[visible[0],Math.max(0,visible[1]-notice),visible[2],visible[3]-notice];
    if(bounds[1]>=bounds[3]){ctx.restore();return 0;}
    const g=layout(shown,bounds),tokens={paper:"#fff",text:"#192330",muted:"#596575",line:"#a4afbc",accent:"#2563ad",
      header:"#e2e8f0",band:"#f5f7fa",transparent:"transparent",...theme},ink=color=>tokens[color]||color;
    tokens.text=theme.ink||tokens.text;
    const total=(g.r1-g.r0)*(g.c1-g.c0);
    if(total>4096 && !context.print && context.purpose!=="print") {
      ctx.fillStyle=tokens.paper;ctx.fillRect(bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]);
      ctx.strokeStyle=tokens.line;ctx.lineWidth=.15;ctx.beginPath();
      const eachRow=Math.max(1,Math.ceil((g.r1-g.r0)/64)),eachCol=Math.max(1,Math.ceil((g.c1-g.c0)/64));
      for(let r=g.r0;r<g.r1;r+=eachRow){ctx.moveTo(bounds[0],g.y[r]);ctx.lineTo(bounds[2],g.y[r]);}
      for(let c=g.c0;c<g.c1;c+=eachCol){ctx.moveTo(g.x[c],bounds[1]);ctx.lineTo(g.x[c],bounds[3]);}
      ctx.stroke();ctx.restore();return 0;
    }
    const seen=new Set();let drawn=0;
    for(let r=g.r0;r<g.r1;r++)for(let c=g.c0;c<g.c1;c++) {
      const span=projectedCell(s,shown.rows,r,c,seen);if(!span)continue;
      const rr=span.y,cc=span.x,re=span.ny,ce=span.nx;
      const row=shown.rows[rr],col=s.columns[cc],cell=T.get(s,row.id,col.id),st=cell?.style||{},content=cell?.content;
      const bx=g.x[cc],by=g.y[rr],bw=g.x[ce]-bx,bh=g.y[re]-by,header=T.index(s).rows.get(row.id)<s.headerRows||cc<s.headerColumns,pad=Math.min(.7,bw/6,bh/6);
      ctx.save();ctx.beginPath();ctx.rect(bx,by,bw,bh);ctx.clip();
      ctx.fillStyle=ink(st.fill || (header?"header":s.banded&&rr%2?"band":"paper"));ctx.fillRect(bx,by,bw,bh);
      ctx.strokeStyle=tokens.line;ctx.lineWidth=.12;ctx.strokeRect(bx,by,bw,bh);
      for(const [edge,colour] of Object.entries(st.borders||{})){
        const line={top:[bx,by,bx+bw,by],bottom:[bx,by+bh,bx+bw,by+bh],left:[bx,by,bx,by+bh],right:[bx+bw,by,bx+bw,by+bh]}[edge];
        ctx.strokeStyle=ink(colour);ctx.lineWidth=.3;ctx.beginPath();ctx.moveTo(line[0],line[1]);ctx.lineTo(line[2],line[3]);ctx.stroke();
      }
      const rect={x:bx+pad,y:by+pad,w:bw-2*pad,h:bh-2*pad,size:1.85};
      const bitmap=content?.kind==="image" && (assets ? assets.get?.(content.assetRef.sha256) : G.AtriumNotebookImages?.visibleAsset(doc.id,content.assetRef,bw,bh,scale));
      if(bitmap?.surface||bitmap?.bitmap){
        const ratio=Math.min(rect.w/bitmap.width,rect.h/bitmap.height);ctx.drawImage(bitmap.surface||bitmap.bitmap,rect.x,rect.y,bitmap.width*ratio,bitmap.height*ratio);
      } else if(content?.kind==="math"&&G.AtriumMath)G.AtriumMath.drawItem(ctx,{...rect,text:content.tex,math:true},ink(st.color||"text"));
      else if(content?.kind==="rich"&&G.AtriumRichText)G.AtriumRichText.draw(ctx,{...rect,richText:content.richText},{project,doc,scale,print:context.print===true || context.purpose==="print"});
      else{
        ctx.font=(st.italic?"italic ":"")+(header||st.bold?"bold ":"")+"1.85px system-ui";ctx.fillStyle=ink(st.color||(row.removed?"muted":"text"));
        ctx.textAlign=st.align||"left";ctx.textBaseline=st.vertical==="top"?"top":st.vertical==="bottom"?"bottom":"middle";
        const xx=ctx.textAlign==="right"?bx+bw-pad:ctx.textAlign==="center"?bx+bw/2:bx+pad;
        const yy=ctx.textBaseline==="top"?by+pad:ctx.textBaseline==="bottom"?by+bh-pad:by+bh/2;
        const text=(row.removed&&cc===0?"Removed · ":"")+value(row.id,col.id),room=Math.max(.1,bw-2*pad);
        if(st.wrap && ctx.measureText) {
          const lines=[],max=Math.max(1,Math.floor(rect.h/2.25));let line="";
          for(const word of text.split(/\s+/)){const test=line?line+" "+word:word;if(line&&ctx.measureText(test).width>room){lines.push(line);line=word;if(lines.length>=max)break;}else line=test;}
          if(line&&lines.length<max)lines.push(line);
          const top=st.vertical==="bottom"?by+bh-pad-lines.length*2.25:st.vertical==="top"?by+pad:by+Math.max(pad,(bh-lines.length*2.25)/2);
          ctx.textBaseline="top";lines.forEach((v,i)=>ctx.fillText(v,xx,top+i*2.25,room));
        } else ctx.fillText(text,xx,yy,room);
      }
      drawn++;ctx.restore();
    }
    ctx.restore();return drawn;
  }
  function imageRequests(project,doc,item,windows) {
    const s=item.widget.state;
    if(!T.contentKinds(s).has("image"))return [];
    const shown=T.presentationRows(s,values(project,doc,item)),rows=rowNumbers(s,shown),columns=T.index(s).columns;
    const layoutState=shown===s.rows?s:{...s,rows:shown},g=layout(layoutState,[0,0,item.w,item.h]),out=[];
    const intersects=(a,b)=>a[0]<b[2]&&b[0]<a[2]&&a[1]<b[3]&&b[1]<a[3];
    const frame=[item.x,item.y,item.x+item.w,item.y+item.h];
    for(const cell of s.cells) {
      if(cell.content?.kind!=="image")continue;
      const span=projectedCell(s,shown,rows.get(cell.rowId),columns.get(cell.columnId));
      if(!span||span.rid!==cell.rowId||span.cid!==cell.columnId)continue;
      const w=g.x[span.nx]-g.x[span.x],h=g.y[span.ny]-g.y[span.y];
      const x=item.x+g.x[span.x],y=item.y+g.y[span.y],box=[x,y,x+w,y+h];
      if(intersects(box,frame)&&(!windows?.length||windows.some(window=>intersects(window,box))))out.push({ref:cell.content.assetRef,w,h});
    }
    return out;
  }
  function registerForeign(api){
    api.register("notebookTable",(item,{doc,project,assets,scale,raster})=>{
      const v=view(project,doc,item,{print:true}),box=[item.x,item.y,item.x+item.w,item.y+item.h];
      return raster({box,alt:v.fallback.text||"Table",scale},ctx=>draw(ctx,v,{x:item.x,y:item.y,w:item.w,h:item.h,assets,scale}));
    });
  }
  if(G.AtriumNotebookForeign)registerForeign(G.AtriumNotebookForeign);
  return Object.freeze({layout,projectedCell,view,values,draw,imageRequests,registerForeign});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumTableVisual;
