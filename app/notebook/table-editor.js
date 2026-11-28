"use strict";
globalThis.AtriumTableEditor=(()=>{
  const G=globalThis,T=G.AtriumTableData,X=G.AtriumTableExchange,V=G.AtriumTableVisual,R=G.AtriumTableFormulas;
  let active;
  const el=(tag,text)=>AtriumNavCommon.el(tag, text);
  function open(host,docId,itemId,initialCell){
    if(G.AtriumPrefs?.get("butter.tables")!==true)return false;
    active?.close();
    const project=host.project(),doc=host.doc(),get=()=>host.project()===project && host.doc()?.id===docId && host.doc()?.items.find(i=>i.id===itemId);
    if(!T.isItem(get()))return false;
    const dialog=el("dialog"),header=el("header"),toolbar=el("div"),tools=el("details"),options=el("div"),extra=el("div"),viewport=el("div"),grid=el("div"),formula=el("textarea"),address=el("output"),status=el("p");
    dialog.className="work-dialog table-editor";dialog.setAttribute("aria-label","Edit table");header.append(el("h2","Table"));toolbar.className="table-tools";options.className="table-tools";
    viewport.className="table-viewport";viewport.tabIndex=0;viewport.setAttribute("role","grid");viewport.setAttribute("aria-label","Table cells");
    grid.className="table-grid";viewport.append(grid);formula.setAttribute("aria-label","Cell contents or formula");formula.autocomplete="off";formula.rows=1;
    status.setAttribute("role","status");status.className="table-status ui-status-line";tools.append(el("summary","Table options"),options,extra);
    formula.className="ui-field";address.className="table-address";address.setAttribute("aria-label","Cell address");tools.className="table-options";
    // Group headings for the options: one hairline heading per group, no boxes (docs/ui-library.md).
    const group=(parent,title)=>{const h=el("h3",title);h.className="table-group-title ui-section-title";parent.append(h);};
    const entry=el("div");entry.className="table-entry";entry.append(address,formula);dialog.append(header,toolbar,entry,viewport,status,tools);document.body.append(dialog);
    let formulaReport=null,syncControls=()=>{},state,display,selected=initialCell,anchor=initialCell,visibleRows=[],windowLayout=null,frame=0,disposed=false,revision=-1,editing=null,queryEpoch=0;
    const gesture=new AbortController(),readable=()=>!disposed&&dialog.open&&G.AtriumPrefs?.get("butter.tables")===true&&!!get();
    const identity=()=>G.Atrium.id(),live=()=>readable()&&host.folderProject?.()?.canEdit?.(docId)!==false;
    let authoredItem,authoredState,projection,paintQueued=false,entryQueued=false,reveal=false,paintedViewport;
    const text=(r,c)=>String(display?.(r,c)??"");
    const currentSelection=()=>{
      const range=T.range(state,anchor,selected),first=visibleRows.findIndex(r=>r.id===anchor.rowId),last=visibleRows.findIndex(r=>r.id===selected.rowId);
      if(first>=0&&last>=0)range.rows=visibleRows.slice(Math.min(first,last),Math.max(first,last)+1).map(r=>r.id);
      return range;
    };
    function feedback(message){status.textContent=message||"";}
    function button(parent,label,fn){
      const b=el("button",label);b.type="button";b.className="ui-button";b.dataset.size="sm";
      b.dataset.variant=parent===header?"primary":parent===toolbar?"quiet":"secondary";b.addEventListener("click",async()=>{
        if(disposed)return;
        try{await fn();}catch(error){if(!disposed)feedback(error.message);}
      });parent.append(b);return b;
    }
    const select=(parent,label,values,fn)=>{
      const l=el("label",label+" "),field=el("select");field.setAttribute("aria-label",label);field.className="ui-field";l.className="table-field";
      for(const [val,name] of values)field.add(new Option(name,val));field.onchange=()=>{try{fn(field.value);}catch(e){feedback(e.message);}};l.append(field);parent.append(l);return field;
    };
    const input=(parent,label,value,type,fn)=>{const l=el("label",label+" "),f=el("input");f.type=type;l.className="table-field";if(type!=="color")f.className="ui-field";f.value=value;f.setAttribute("aria-label",label);f.onchange=()=>{try{fn(f.value);}catch(e){feedback(e.message);}};l.append(f);parent.append(l);return f;};
    function apply(label,next,{materialize=false}={}) {
      if(!live())throw Error("This table is unavailable for editing.");
      const item=get(),previous=item.widget.state;
      if(previous!==authoredState)throw Error("The table changed. Select the cell again.");
      if(next===previous || !materialize && next===state)return;
      if(!T.changedFrom(next,previous)){
        if(T.equal(next,previous))return;
        T.validate(next);
      }
      const edit=host.edit(()=>{const same=get();if(!same||same.widget.state!==previous)throw Error("The table changed. Select the cell again.");T.clearReplacedNumericTargets(project,docId,same,previous,next);same.widget={...same.widget,state:next};},label,[T.cellUndoScope(doc,item,previous,next)]);
      // The editor normally emits change before edit() returns. Refresh also
      // covers a host that completes without notifying this dialog.
      if(edit?.then)return edit.then(()=>refresh()).catch(error=>{if(readable())feedback(error.message);});
      refresh();
    }
    function set(point,extend=false){
      if(!point)return;
      selected={...point};if(!extend||!anchor)anchor={...selected};editing=null;
      schedulePaint(true);
    }
    const cellType=content=>({rich:"Rich text",math:"Math",field:"Design field",link:"Link",formula:"Formula"}[content?.kind]||"Value");
    function richBlockSource(block){
      return block.runs.map(run=>{
        if(run.type==="field")return "{"+run.expression+"}";
        if(run.type==="math")return "$"+run.tex+"$";
        const marker=run.bold?"**":run.strike?"~~":run.code?String.fromCharCode(96):run.italic?"*":"";
        return marker+run.text+marker;
      }).join("");
    }
    function entryText(content){
      if(content?.kind==="formula")return R.spelling(state,content);
      if(content?.kind==="link")return content.url||content.label;
      if(content?.kind!=="rich")return X.plain(content);
      return content.richText.blocks.map(richBlockSource).join("\n");
    }
    function updateEntry(){
      if(!selected)return;
      address.value=T.label(state,selected.rowId,selected.columnId);
      const v=T.get(state,selected.rowId,selected.columnId)?.content;
      if(document.activeElement!==formula){formula.value=entryText(v);kind.value=cellType(v);}
      viewport.setAttribute("aria-activedescendant","table-active-cell");syncControls();
    }
    function refresh(force=false){
      if(disposed||!dialog.open)return;
      const item=get();if(!item||!T.isItem(item)){dialog.close();return;}
      const authored=item.widget.state,nextRevision=host.revision?.()??0;
      const shown=projection?.authored===authored && auto.value==="on" ? projection.state : authored;
      if(force!==true&&item===authoredItem&&authored===authoredState&&nextRevision===revision&&shown===state)return;
      authoredItem=item;authoredState=authored;revision=nextRevision;state=shown;
      // One formula report per refresh: the grid reads values and marks the cells whose formula fails.
      const shownItem=state===authoredState?item:{...item,widget:{...item.widget,state}};
      formulaReport=T.contentKinds(state).has("formula")&&R?R.report(project,doc,shownItem,{revision,host}):null;
      display=V.values(project,doc,shownItem,{revision,host,formulaReport:()=>formulaReport});
      if(!selected||!T.index(state).rows.has(selected.rowId)||!T.index(state).columns.has(selected.columnId)){
        selected={rowId:state.rows[0].id,columnId:state.columns[0].id};anchor={...selected};
      }
      if(!anchor||!T.index(state).rows.has(anchor.rowId)||!T.index(state).columns.has(anchor.columnId))anchor={...selected};
      visibleRows=T.presentationRows(state,text);
      if(visibleRows.length&&!visibleRows.some(r=>r.id===selected.rowId)){selected={...selected,rowId:visibleRows[0].id};anchor={...selected};}
      formula.disabled=!visibleRows.length;
      windowLayout={...state,rows:visibleRows};
      viewport.setAttribute("aria-rowcount",String(visibleRows.length));viewport.setAttribute("aria-colcount",String(state.columns.length));
      schedulePaint(true);queueQuery();
    }
    const px=7,head=28;
    const viewportBox=()=>[viewport.scrollLeft,viewport.scrollTop,viewport.clientWidth||620,viewport.clientHeight||275];
    const sameViewport=(a,b)=>a?.every((value,i)=>value===b[i]);
    function schedulePaint(entry=false){
      entryQueued||=entry;
      if(paintQueued)return;
      paintQueued=true;
      // A key can both commit an edit and move the selection. Draw their final
      // state before the browser paints, using the viewport after any reveal.
      queueMicrotask(()=>{
        paintQueued=false;
        const entry=entryQueued;entryQueued=false;
        if(disposed||!dialog.open)return;
        if(frame){cancelAnimationFrame(frame);frame=0;}
        if(entry)updateEntry();
        paint();
      });
    }
    function paint(){
      const showSelection=reveal;reveal=false;
      if(!state||!visibleRows.length){paintedViewport=viewportBox();grid.replaceChildren();if(state)feedback("No rows match the column filters.");return;}
      const layout=([left,top,width,height])=>V.layout(windowLayout,[left/px,Math.max(0,top-head)/px,(left+width)/px,(top+height)/px]);
      const initial=viewportBox();let l=layout(initial);
      const gridWidth=Math.max(initial[2],l.width*px),gridHeight=l.height*px+head;
      grid.style.width=gridWidth+"px";grid.style.height=gridHeight+"px";
      const [left,top,width,height]=viewportBox();
      // The old absolute cells can still extend the scroll area while a filter
      // shrinks the grid. Clamp to the new dimensions before replacing them.
      const maxLeft=Math.max(0,Math.round(gridWidth)-width),maxTop=Math.max(0,Math.round(gridHeight)-height);
      let scrollLeft=Math.min(left,maxLeft),scrollTop=Math.min(top,maxTop);
      if(showSelection){
        const x=T.index(state).columns.get(selected.columnId),y=visibleRows.findIndex(row=>row.id===selected.rowId);
        const xx=l.x[x]*px,yy=l.y[y]*px;
        if(xx<scrollLeft||xx+30>scrollLeft+width)scrollLeft=Math.min(xx,maxLeft);
        if(yy<scrollTop||yy+50>scrollTop+height)scrollTop=Math.min(yy,maxTop);
      }
      if(left!==scrollLeft)viewport.scrollLeft=scrollLeft;
      if(top!==scrollTop)viewport.scrollTop=scrollTop;
      paintedViewport=viewportBox();
      if(!sameViewport(initial,paintedViewport))l=layout(paintedViewport);
      const headerTop=paintedViewport[1];
      const cells=document.createDocumentFragment(),range=currentSelection(),selectedRows=new Set(range.rows),selectedColumns=new Set(range.columns);
      const headings=el("div");headings.setAttribute("role","row");headings.style.display="contents";cells.append(headings);
      const rowElements=new Map();
      for(let c=l.c0;c<l.c1;c++){
        const col=state.columns[c],h=el("div",col.title||T.letters(c));h.className="table-col";h.setAttribute("role","columnheader");
        h.style.cssText="left:"+l.x[c]*px+"px;top:"+headerTop+"px;width:"+(l.x[c+1]-l.x[c])*px+"px;height:"+head+"px";
        const grip=el("span");grip.className="table-resize";grip.title="Resize "+col.title;grip.onpointerdown=e=>{
          e.preventDefault();const start=e.clientX,initial=l.x[c+1]-l.x[c];grip.setPointerCapture(e.pointerId);
          grip.onpointerup=end=>{const size=Math.round(Math.max(4,Math.min(150,initial+(end.clientX-start)/px))*1e6);
            apply("Resize table column",{...state,columns:state.columns.map(v=>v.id===col.id?{...v,widthNm:size}:v)});};
        };h.append(grip);headings.append(h);
      }
      const touched=new Set();
      for(let r=l.r0;r<l.r1;r++)for(let c=l.c0;c<l.c1;c++){
        const span=V.projectedCell(state,visibleRows,r,c,touched);
        if(!span)continue;
        const rid=span.rid,cid=span.cid,cell=T.get(state,rid,cid),st=cell?.style||{};
        const x=span.x,y=span.y,nx=span.nx,ny=span.ny;
        const node=el("div",(visibleRows[y].removed&&x===0?"Removed · ":"")+text(rid,cid));node.className="table-cell";node.setAttribute("role","gridcell");
        node.dataset.row=rid;node.dataset.column=cid;node.setAttribute("aria-rowindex",String(y+1));node.setAttribute("aria-colindex",String(x+1));
        if(span.merge){node.setAttribute("aria-rowspan",String(ny-y));node.setAttribute("aria-colspan",String(nx-x));}
        node.style.cssText="left:"+l.x[x]*px+"px;top:"+(l.y[y]*px+head)+"px;width:"+(l.x[nx]-l.x[x])*px+"px;height:"+(l.y[ny]-l.y[y])*px+"px";
        const isHeader=T.index(state).rows.get(rid)<state.headerRows||x<state.headerColumns;
        node.classList.toggle("heading",isHeader);node.classList.toggle("band",state.banded&&y%2===1);
        if(st.bold)node.style.fontWeight="bold";if(st.italic)node.style.fontStyle="italic";if(st.align)node.style.textAlign=st.align;
        if(st.fill)node.style.setProperty("--swatch", cssColor(st.fill));if(st.color)node.style.color=cssColor(st.color);
        if(st.wrap)node.style.whiteSpace="normal";for(const [edge,color] of Object.entries(st.borders||{}))node.style.setProperty("--swatch-"+edge,cssColor(color));
        node.setAttribute("aria-selected",String(selectedRows.has(rid)&&selectedColumns.has(cid)));
        const problem=cell?.content?.kind==="formula"?formulaReport?.value(rid,cid):null;
        if(problem&&!problem.ok){node.dataset.state="error";node.title=problem.diagnostic?.message||"Formula unavailable";}
        if(rid===selected.rowId&&cid===selected.columnId){node.id="table-active-cell";node.classList.add("current");}
        node.onpointerdown=e=>{if(e.button!==0)return;set({rowId:rid,columnId:cid},e.shiftKey);viewport.focus({preventScroll:true});};
        node.ondblclick=()=>editValue();
        if(!rowElements.has(y)){const group=el("div");group.setAttribute("role","row");group.setAttribute("aria-rowindex",String(y+1));group.style.display="contents";rowElements.set(y,group);}
        rowElements.get(y).append(node);
      }
      for(const [,row] of [...rowElements].sort(([a],[b])=>a-b))cells.append(row);
      grid.replaceChildren(cells);
    }
    function cssColor(v){return v[0]==="#"?v:({paper:"var(--field)",text:"var(--ink)",line:"var(--line-strong)",accent:"var(--accent)",muted:"var(--muted)",header:"var(--field)",band:"var(--surface)",transparent:"transparent"}[v]??"");}
    function move(dr,dc,extend=false){
      const x=T.index(state).columns.get(selected.columnId),y=visibleRows.findIndex(row=>row.id===selected.rowId);
      const row=visibleRows[Math.max(0,Math.min(visibleRows.length-1,y+dr))],col=state.columns[Math.max(0,Math.min(state.columns.length-1,x+dc))];
      if(!row||!col)return;
      reveal=true;set({rowId:row.id,columnId:col.id},extend);
    }
    const contentFor=(type,value,prior)=>{
      if(type==="Rich text"){
        const body=G.AtriumNotebook.textBody(value),old=prior?.richText;
        body.blocks=body.blocks.map((block,i)=>{
          const source=block.runs.map(run=>run.text).join(""),previous=old?.blocks[i];
          if(previous && richBlockSource(previous)===source)return previous;
          const fields=new Map();
          for(const run of previous?.runs||[])if(run.type==="field"){
            if(!fields.has(run.expression))fields.set(run.expression,[]);
            fields.get(run.expression).push(run);
          }
          const runs=G.AtriumNotebook.parseInline(source,project,doc).map(run=>{
            if(run.type!=="field")return run;
            return fields.get(run.expression)?.shift()??run;
          });
          return {...(previous||block),runs};
        });
        return {kind:"rich",richText:{...(old||body),blocks:body.blocks}};
      }
      if(type==="Math")return {kind:"math",tex:value};
      if(type==="Design field"){const r=G.AtriumNoteFields.resolve(project,doc,value);return {kind:"field",expression:value,...(r.binding?{binding:r.binding}:{})};}
      if(type==="Link"){const url=G.AtriumNotebook.safeURL(value);if(!url)throw Error("Enter an HTTP, HTTPS or mail link.");return {kind:"link",label:value,url};}
      if(type==="Formula"||value.startsWith("="))return R.report(project,doc,get(),{revision,host},state).bind(value);
      return {kind:"literal",text:value};
    };
    function editValue(start){
      if(!visibleRows.length)return;
      T.assertEditable(state,selected.rowId,selected.columnId);
      const value=T.get(state,selected.rowId,selected.columnId)?.content;
      editing={...selected};kind.value=start==null?cellType(value):start==="="?"Formula":"Value";
      formula.value=start??entryText(value);formula.focus();if(start==null)formula.select();
    }
    function commitValue(){
      if(!visibleRows.length)throw Error("Show a row before editing.");
      const at=editing||selected,prior=T.get(state,at.rowId,at.columnId)?.content;
      if(kind.value!==cellType(prior)||formula.value!==entryText(prior)){
        T.assertEditable(state,at.rowId,at.columnId);
        const value=contentFor(kind.value,formula.value,prior);
        apply("Edit table cell",T.change(state,at.rowId,at.columnId,{content:value}));
      }
      editing=null;
    }
    function editableRange(){
      const a=currentSelection();
      if(a.rows.length*a.columns.length>T.limits.range)throw Error("Select at most "+T.limits.range.toLocaleString()+" table cells for one edit.");
      return a;
    }
    function style(patch){
      const a=editableRange(),edits=[];
      for(const r of a.rows)for(const c of a.columns){
        T.assertEditable(state,r,c);
        const prior=T.get(state,r,c)?.style||{};
        edits.push({rowId:r,columnId:c,style:typeof patch==="function"?patch(prior):{...prior,...patch}});
      }
      apply("Format table selection",T.batch(state,edits));
    }
    function fill(){const a=editableRange(),changes=[];if(a.rows.length<2)throw Error("Select the source row and the rows below it.");
      for(const c of a.columns)for(const r of a.rows.slice(1)){T.assertEditable(state,r,c);const cell=T.get(state,a.rows[0],c);changes.push({rowId:r,columnId:c,content:cell?.content?.kind==="formula"?
        R.copyTo(state,cell.content,{rowId:a.rows[0],columnId:c},{rowId:r,columnId:c}):cell?.content??null,style:cell?.style??null});}
      apply("Fill table down",T.batch(state,changes));}
    function remove(selectedAxis){
      const rows=selectedAxis==="rows",index=T.index(state)[selectedAxis].get(rows?selected.rowId:selected.columnId);
      if(rows&&(state.rows[index]?.object||state.rows[index]?.queryEmpty))throw Error("Remove live query rows using the query commands.");
      apply("Remove table "+(rows?"row":"column"),T.axis(state,selectedAxis,index,1,false));
    }
    function add(selectedAxis){const rows=selectedAxis==="rows",index=T.index(state)[selectedAxis].get(rows?selected.rowId:selected.columnId)+1;apply("Insert table "+(rows?"row":"column"),T.axis(state,selectedAxis,index,1,true,identity));}
    function importData(transfer){const rich=transfer.getData("text/html"),data=rich&&X.html(rich)||X.tsv(transfer.getData("text/plain"));
      apply("Paste table cells",X.paste(state,selected,data,identity));feedback(data.notice);}
    viewport.onpaste=e=>{try{if(!e.clipboardData)return;e.preventDefault();importData(e.clipboardData);}catch(error){feedback(error.message);}};
    viewport.oncopy=e=>{try{if(!e.clipboardData)return;const value=X.render(state,currentSelection(),text);e.preventDefault();e.clipboardData.setData("text/plain",value.text);e.clipboardData.setData("text/html",value.html);}catch(error){feedback(error.message);}};
    const keys={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Home:[0,-Infinity],End:[0,Infinity]};
    viewport.onkeydown=e=>{
      try{
        if(e.isComposing)return;
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="d"){e.preventDefault();fill();return;}
        if(e.key==="Tab"||e.key==="Enter"){e.preventDefault();move(e.key==="Enter"?(e.shiftKey?-1:1):0,e.key==="Tab"?(e.shiftKey?-1:1):0);return;}
        if(keys[e.key]){e.preventDefault();move(...keys[e.key],e.shiftKey);return;}
        if(e.key==="F2"){e.preventDefault();editValue();return;}
        if(e.key==="Backspace"||e.key==="Delete"){e.preventDefault();const a=editableRange();apply("Clear table cells",T.batch(state,a.rows.flatMap(rowId=>a.columns.map(columnId=>{
          T.assertEditable(state,rowId,columnId);return {rowId,columnId,content:null};
        }))));return;}
        if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();editValue(e.key);}
      }catch(error){feedback(error.message);}
    };
    formula.onfocus=()=>{editing??={...selected};};formula.onkeydown=e=>{
      if(e.isComposing)return;
      if(e.key==="Escape"){e.preventDefault();editing=null;viewport.focus();updateEntry();return;}
      if(e.key==="Enter"&&e.altKey){e.preventDefault();formula.setRangeText("\n",formula.selectionStart,formula.selectionEnd,"end");return;}
      if(e.key!=="Enter"&&e.key!=="Tab")return;
      try{e.preventDefault();commitValue();viewport.focus();move(e.key==="Enter"?(e.shiftKey?-1:1):0,e.key==="Tab"?(e.shiftKey?-1:1):0);}catch(error){feedback(error.message);}
    };
    button(header,"Done",()=>dialog.close());const kind=select(toolbar,"Cell type",["Value","Formula","Rich text","Design field","Math","Link"].map(x=>[x,x]),()=>{formula.focus();});
    toolbar.className="table-tools ui-toolbar";toolbar.setAttribute("role","toolbar");toolbar.setAttribute("aria-label","Table cell");
    const sep=()=>{const s=el("span");s.className="ui-toolbar-sep";toolbar.append(s);};
    sep();button(toolbar,"Edit cell",()=>editValue());button(toolbar,"Apply",commitValue);sep();button(toolbar,"Bold",()=>style({bold:!T.get(state,selected.rowId,selected.columnId)?.style?.bold}));
    select(toolbar,"Align",[["left","Left"],["center","Centre"],["right","Right"]],align=>style({align}));button(toolbar,"Merge",()=>{
      const chosen=currentSelection(),stored=T.range(state,anchor,selected);
      if(chosen.rows.length!==stored.rows.length||chosen.rows.some(r=>!stored.rows.includes(r)))throw Error("Choose contiguous rows in sheet order to merge.");
      for(const r of chosen.rows)for(const c of chosen.columns)T.assertEditable(state,r,c);
      apply("Merge selected cells",T.join(state,anchor,selected,identity));
    });
    button(toolbar,"Unmerge",()=>apply("Unmerge cells",T.split(state,selected.rowId,selected.columnId)));
    group(options,"Rows and columns");
    for(const [label,fn] of [["Add row",()=>add("rows")],["Remove row",()=>remove("rows")],["Add column",()=>add("columns")],["Remove column",()=>remove("columns")],
      ["Header rows",()=>apply("Set table header rows",{...state,headerRows:state.headerRows?0:T.index(state).rows.get(selected.rowId)+1})],
      ["Header columns",()=>apply("Set table header columns",{...state,headerColumns:state.headerColumns?0:T.index(state).columns.get(selected.columnId)+1})],
      ["Banded rows",()=>apply("Toggle banded table rows",{...state,banded:!state.banded})],["Fill down",fill],
      ["Borders",()=>style({borders:{top:"line",right:"line",bottom:"line",left:"line"}})],
      ["Export CSV",()=>{const csv=X.render(state,null,text,{csvOnly:true});return G.AtriumIO.exportFile("Table.csv",csv);} ]])button(options,label,fn);
    group(options,"Cell");input(options,"Cell fill","#ffffff","color",fill=>style({fill}));input(options,"Text colour","#202020","color",color=>style({color}));
    button(options,"Italic",()=>style({italic:!T.get(state,selected.rowId,selected.columnId)?.style?.italic}));
    button(options,"Wrap text",()=>style({wrap:!T.get(state,selected.rowId,selected.columnId)?.style?.wrap}));
    const edges=["top","right","bottom","left"];
    group(options,"Borders");const borderEdge=select(options,"Border edge",[["all","All edges"],...edges.map(e=>[e,e])],()=>{});
    const borderTone=select(options,"Border colour",[["line","Theme line"],["accent","Theme accent"],["text","Theme text"],["muted","Theme muted"],["custom","Custom"]],()=>{});
    const borderCustom=input(options,"Custom border colour","#202020","color",()=>{borderTone.value="custom";});
    function edgeStroke(stroke){
      style(prior=>{
        const next={...prior},borders={...prior.borders};
        for(const edge of borderEdge.value==="all"?edges:[borderEdge.value]){
          if(stroke)borders[edge]=stroke;else delete borders[edge];
        }
        if(Object.keys(borders).length)next.borders=borders;else delete next.borders;
        return next;
      });
    }
    button(options,"Apply border",()=>edgeStroke(borderTone.value==="custom"?borderCustom.value:borderTone.value));
    button(options,"Clear border",()=>edgeStroke(null));
    select(options,"Theme fill",["paper","header","band","accent","transparent"].map(v=>[v,v]),fill=>style({fill}));
    select(options,"Vertical align",[["top","Top"],["middle","Middle"],["bottom","Bottom"]],vertical=>style({vertical}));
    group(options,"Column and row");const columnWidth=input(options,"Column width (mm)","","number",v=>apply("Resize table column",{...state,columns:state.columns.map(c=>c.id===selected.columnId?{...c,widthNm:Math.round(Number(v)*1e6)}:c)}));
    const rowHeight=input(options,"Row height (mm)","","number",v=>apply("Resize table row",{...state,rows:state.rows.map(r=>r.id===selected.rowId?{...r,heightNm:Math.round(Number(v)*1e6)}:r)}));
    const columnTitle=input(options,"Column title","","text",title=>apply("Rename table column",{...state,columns:state.columns.map(c=>c.id===selected.columnId?{...c,title}:c)}));
    const columnUnit=input(options,"Column unit","","text",unit=>{if(unit&&!G.AtriumCalculationCore.units(unit))throw Error("Choose a known quantity unit.");apply("Set table column unit",{...state,columns:state.columns.map(c=>c.id===selected.columnId?{...c,unit}:c)});});
    const columnFilter=input(options,"Column filter","","search",filter=>apply("Filter table column",{...state,columns:state.columns.map(c=>{
      if(c.id!==selected.columnId)return c;const next={...c};if(filter)next.filter=filter;else delete next.filter;return next;
    })}));
    const sortField=select(options,"Sort column",[["","Sheet order"],["1","Ascending"],["-1","Descending"]],v=>apply("Sort table column",{...state,columns:state.columns.map(c=>{
      if(c.id!==selected.columnId)return c;const next={...c};if(v)next.sortDirection=v==="1"?"asc":"desc";else delete next.sortDirection;return next;
    })}));
    syncControls=()=>{
      // A failing formula speaks in the status line while its cell is selected; the authored source stays in the entry.
      const here=T.get(state,selected.rowId,selected.columnId),verdict=here?.content?.kind==="formula"?formulaReport?.value(selected.rowId,selected.columnId):null;
      if(verdict&&!verdict.ok){status.dataset.tone="danger";feedback("Formula: "+(verdict.diagnostic?.message||"unavailable"));}
      else if(status.dataset.tone==="danger"){delete status.dataset.tone;feedback("");}
      const column=state.columns[T.index(state).columns.get(selected.columnId)],row=state.rows[T.index(state).rows.get(selected.rowId)];
      if(!column||!row)return;
      for(const [field,value] of [[columnTitle,column.title],[columnUnit,column.unit||""],[columnFilter,column.filter||""],
        [sortField,column.sortDirection==="asc"?"1":column.sortDirection==="desc"?"-1":""],[columnWidth,(column.widthNm??14e6)/1e6],[rowHeight,(row.heightNm??4.5e6)/1e6]])
        if(document.activeElement!==field)field.value=String(value);
    };
    group(options,"Insert");button(options,"Insert image",async()=>{
      if(!live())return;const at={...selected};
      T.assertEditable(state,at.rowId,at.columnId);
      const api=await G.AtriumLazy.need("AtriumNotebookImageUI");if(!live())return;
      await api.pickCellImage(host,gesture.signal,(staged,session)=>{
        if(!live())throw Error("The selected table was closed.");
        T.assertEditable(state,at.rowId,at.columnId);
        const next=T.change(state,at.rowId,at.columnId,{content:{kind:"image",assetRef:staged.assetRef,alt:staged.name||"Image"}});
        session.stageAttachment(staged);apply("Insert table cell image",next);
      });
    });
    const targets=[["","Choose an object"]];
    for(const d of project.documents)for(const item of d.items||[])if(item.id!==itemId&&targets.length<2048)
      targets.push([JSON.stringify([d.id,item.id]),d.name+" · "+(item.ref||item.name||item.text||item.kind)]);
    select(options,"Link design object",targets,v=>{if(!v)return;const [documentId,itemId]=JSON.parse(v);
      T.assertEditable(state,selected.rowId,selected.columnId);
      const label=targets.find(row=>row[0]===v)[1];apply("Link table cell",T.change(state,selected.rowId,selected.columnId,{content:{kind:"link",label,target:{documentId,itemId}}}));});
    button(options,"Open cell link",async()=>{
      const content=T.get(state,selected.rowId,selected.columnId)?.content;
      if(content?.kind!=="link")throw Error("Select a linked cell.");
      if(content.url)return G.AtriumSheetWidgets.openURL(content.url);
      const target=content.target,d=project.documents.find(d=>d.id===target.documentId);
      if(!d)throw Error("The linked document is unavailable.");
      await host.selectDocument?.(d.id);
      const owner=host.doc()?.items.find(i=>i.id===target.itemId);
      if(!owner)throw Error("The linked object is unavailable.");
      dialog.close();host.select?.([owner.id],owner.id);
      const cell=T.resolveTarget(project,target);if(cell)queueMicrotask(()=>open(host,d.id,owner.id,{rowId:cell.rowId,columnId:cell.columnId}));
    });
    extra.className="table-tools";group(extra,"Live data");const queryDoc=select(extra,"Query document",project.documents.map(d=>[d.id,d.name]),()=>{});
    const initialQuery=get().widget.state.query?.scope;
    const querySource=input(extra,"Query",initialQuery?.source ||
      project.savedQueries?.find(q=>q.id===initialQuery?.savedQueryId)?.query.source || "","text",()=>{});
    const queryFields=input(extra,"Query fields",get().widget.state.query?.fields.map(f=>f.field).join(", ")||"designator, value","text",()=>{});
    if(get().widget.state.query)queryDoc.value=get().widget.state.query.documentId;
    let running=false,latestQuery,queryJob;
    const queryKey={itemId,docId};
    async function runQuery(define){
      if(!live()||running)return;
      const epoch=++queryEpoch,initial=authoredState,rev=revision;
      const current=()=>live()&&epoch===queryEpoch&&get()?.widget.state===initial&&(host.revision?.()??0)===rev;
      running=true;
      try{
        const api=await G.AtriumLazy.need("AtriumTableQuery");
        if(!current())return;
        const options={project,revision:rev,getRevision:()=>host.revision?.()??0,defs:host.defs?.(),signal:gesture.signal,isCurrent:current};
        const authored=define?await api.author(initial,{...options,documentId:queryDoc.value,source:querySource.value,
          fields:queryFields.value.split(",").map((f,i)=>({columnId:initial.columns[i]?.id,field:f.trim()}))}):null;
        if(!current())return;
        if(authored&&!authored.ok){feedback(authored.diagnostics[0].message);return;}
        const base=authored?{...initial,query:authored.query}:initial;
        if(!base.query)return;
        const result=await api.refresh(base,options);
        if(!current())return;
        if(!result.complete){feedback(result.diagnostic.message);return;}
        if(!T.equal(initial,result.state))apply(define?"Bind table to query":"Refresh query table",result.state,{materialize:true});
        feedback(result.count+" query rows"+(result.removed?", "+result.removed+" removed":""));
        latestQuery=host.revision?.()??rev;
      }finally{
        running=false;
        queueQuery();
      }
    }
    function queueQuery(){
      if(!readable() || !authoredState?.query || auto.value!=="on" || running ||
        latestQuery===revision || G.AtriumPower?.visible()===false || queryJob?.current())return;
      const update=async()=>{
        queryJob=null;
        if(!readable()||auto.value!=="on"||running||G.AtriumPower?.visible()===false)return;
        const prior=authoredState,rev=revision,epoch=queryEpoch;
        const current=()=>readable()&&auto.value==="on"&&epoch===queryEpoch&&get()?.widget.state===prior&&revision===rev&&G.AtriumPower?.visible()!==false;
        try{
          const api=await G.AtriumLazy.need("AtriumTableQuery");
          if(!current())return;
          const result=await api.projected(prior,{project,host,revision:rev});
          if(!current())return;
          latestQuery=rev;
          if(!result.complete){feedback(result.diagnostic.message);return;}
          projection={authored:prior,state:result.state};
          refresh();
          feedback(result.count+" query rows"+(result.removed?", "+result.removed+" removed":""));
        }catch(error){if(current()){latestQuery=rev;feedback(error.message);}}
      };
      if(host.stageEdit)queryJob=host.stageEdit("idle",queryKey,update);
      else {
        const timer=setTimeout(update,0);
        queryJob={current:()=>true,cancel:()=>clearTimeout(timer)};
      }
    }
    button(extra,"Bind query",()=>runQuery(true));button(extra,"Refresh query",()=>runQuery(false));button(extra,"Clear removed rows",async()=>apply("Clear removed query rows",(await G.AtriumLazy.need("AtriumTableQuery")).clearRemoved(state)));
    const auto=select(extra,"Live query",[["on","On"],["off","Off"]],()=>{refresh();queueQuery();});
    viewport.onscroll=()=>{
      if(frame||paintQueued||sameViewport(paintedViewport,viewportBox()))return;
      frame=requestAnimationFrame(()=>{frame=0;if(!sameViewport(paintedViewport,viewportBox()))schedulePaint();});
    };
    const offChange=host.on?.("change",()=>refresh(!host.revision)),offDoc=host.on?.("document",()=>{if(!get())dialog.close();}),offProj=host.on?.("replace",()=>dialog.close());
    const offFlag=G.AtriumPrefs.on("butter.tables",()=>{if(G.AtriumPrefs.get("butter.tables")!==true)dialog.close();});
    const offPower=G.AtriumPower?.onChange(s=>{if(s.visible)queueQuery();});
    const offQueries=G.AtriumPrefs.on("butter.query",()=>{latestQuery=undefined;queueQuery();});
    dialog.addEventListener("close",()=>{disposed=true;queryEpoch++;gesture.abort();queryJob?.cancel();cancelAnimationFrame(frame);offChange?.();offDoc?.();offProj?.();offFlag();offPower?.();offQueries();if(active===dialog)active=null;dialog.remove();},{once:true});
    // A typed entry not yet applied to its cell (the project switch asks about it: leave-project.js).
    dialog.unapplied=()=>{
      if(disposed||!dialog.open||!editing||!visibleRows.length)return null;
      try{const prior=T.get(state,editing.rowId,editing.columnId)?.content;
        return kind.value!==cellType(prior)||formula.value!==entryText(prior)?editing.rowId+"\u0000"+editing.columnId+"\u0000"+kind.value+"\u0000"+formula.value:null;}
      catch{return null;}
    };
    G.AtriumUI.adoptDialog(dialog,{title:header.querySelector("h2"),defaultAction:false});
    active=dialog;dialog.showModal();refresh();viewport.focus();return true;
  }
  const LP=G.AtriumLeaveProject;
  LP?.draft("table-editor",LP.order.notebook,{state:()=>active?.unapplied?.()??null,message:"Discard the table entry you have not applied?",discard:()=>active?.close()});
  return Object.freeze({open});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumTableEditor;
