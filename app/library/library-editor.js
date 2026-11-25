"use strict";

globalThis.AtriumLibraryEditor = (() => {
  const A=Atrium,lead=2.54;
  const padShapes=["round","rect","roundrect","octagon"];
  const round=n=>Number(n.toFixed(8));
  const path=(points,style,closed=false,fill=false)=>({kind:"path",points,style,closed,fill});
  const box=(x,y,r,b,style,fill=false)=>path([[x,y],[r,y],[r,b],[x,b]],style,true,fill);
  function number(value,label,positive=false){
    if((typeof value!=="number" && typeof value!=="string") || String(value).trim()==="")throw Error("Enter "+label+".");
    const n=Number(value);
    if(!Number.isFinite(n) || Math.abs(n)>=1e7 || positive&&n<=0)throw Error("Enter a valid "+label+".");
    return n;
  }
  function text(value,label,required=true){
    const t=String(value??"").trim();if((required&&!t)||/[\u0000-\u001f]/.test(t))throw Error("Enter "+label+".");
    return t;
  }
  function freshRow(rows){
    let n=1;const used=new Set(rows.map(r=>String(r.number)));while(used.has(String(n)))n++;
    const prior=rows.at(-1);
    return {number:String(n),name:"",side:prior?.side||"Left",y:prior?round((Number(prior.y)||0)+2.54):0,
      px:prior&&Number.isFinite(Number(prior.px))?Number(prior.px):0,py:prior?round((Number(prior.py)||0)+2.54):0,
      w:prior?.w??1.6,h:prior?.h??1.6,drill:prior?.drill??.8,shape:prior?"round":"rect"};
  }
  function draft(source,library=[]){
    let rows=[],name=source?source.name+" copy":"";
    if(source){
      let i=2;const names=new Set(library.map(d=>d.name));
      while(names.has(name))name=source.name+" copy "+i++;
    }
    const custom=source?.pinLayout?.version===1;
    if(custom){
      const pads=new Map(source.footprint?.pads?.map(p=>[p.number,p]));
      rows=(source.symbol?.pins||[]).map(p=>{
        const pad=pads.get(p.number);if(!pad)throw Error("The source has no matching pad for pin "+p.number+".");
        return {number:p.number,name:p.name||"",side:p.x<0?"Left":"Right",y:p.y,px:pad.x,py:pad.y,w:pad.w,h:pad.h,shape:pad.shape,drill:pad.drill||0};
      });
    }else if(!source){rows.push(freshRow(rows));rows.push(freshRow(rows));}
    return {id:A.id(),source,custom:!source||custom,name,prefix:source?.prefix||"J",value:source?.value||"",footprint:source?.footprint?.name||"Custom footprint",width:custom?source.pinLayout.bodyWidth:12.7,rows};
  }
  function build(d){
    const name=text(d.name,"a component name"),prefix=text(d.prefix,"a designator prefix"),value=text(d.value,"a value",false);
    if(!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix))throw Error("Use a designator prefix beginning with a letter.");
    const footprint=d.custom||d.source?.footprint?text(d.footprint,"a footprint name"):null;
    if(!d.custom){
      const copy=A.clone(d.source);Object.assign(copy,{id:d.id,name,prefix,value});
      if(copy.footprint)copy.footprint.name=footprint;
      if(copy.footprintName&&copy.footprint)copy.footprintName=footprint;
      return copy;
    }
    if(!d.rows.length)throw Error("Add at least one electrical pin.");
    const width=number(d.width,"symbol body width",true),half=width/2;
    const pins=[],pads=[],art=[],numbers=new Set(),tips=new Set(),centres=new Set();
    let top=Infinity,bottom=-Infinity,left=Infinity,right=-Infinity,padTop=Infinity,padBottom=-Infinity;
    for(const [i,r] of d.rows.entries()){
      const label="pin "+(i+1),num=text(r.number,"a number for "+label),pinName=text(r.name,"a name for "+label,false);
      if(["__proto__","constructor","prototype"].includes(num))throw Error("Choose a different pin number for "+label+".");
      if(numbers.has(num))throw Error("Pin "+num+" appears twice. Give each pin its own number.");
      numbers.add(num);
      if(!["Left","Right"].includes(r.side))throw Error("Choose a symbol side for pin "+num+".");
      const y=number(r.y,"symbol Y for pin "+num),sign=r.side==="Left"?-1:1,edge=half*sign,x=round((half+lead)*sign);
      const xy=[x,y],tip=A.pointKey(xy);
      if(tips.has(tip))throw Error("Two pins share a symbol connection point. Change the side or Y of pin "+num+".");tips.add(tip);
      pins.push({number:num,name:pinName,x,y});art.push(path([xy,[edge,y]],"body"));
      art.push({kind:"text",text:num,x:(x+edge)/2,y:y-.22,size:.85,align:"center",style:"body"});
      if(pinName)art.push({kind:"text",text:pinName,x:edge-sign*.54,y:y+.42,size:1.15,align:sign<0?"left":"right",style:"body"});
      top=Math.min(top,y);bottom=Math.max(bottom,y);
      const px=number(r.px,"pad X for "+num),py=number(r.py,"pad Y for "+num),w=number(r.w,"pad width for "+num,true),h=number(r.h,"pad height for "+num,true),drill=number(r.drill,"drill for "+num);
      if(drill<0 || drill>=Math.min(w,h))throw Error("Pad "+num+" needs a drill smaller than its copper, or zero for SMD.");
      if(!padShapes.includes(r.shape))throw Error("Choose a pad shape for "+num+".");
      const centre=A.pointKey([px,py]);if(centres.has(centre))throw Error("Two pads share a centre. Change the position of pad "+num+".");centres.add(centre);
      pads.push({number:num,x:px,y:py,w,h,drill,shape:r.shape,angle:0,...(drill>0?{layer:"Multi",plated:true}:{})});
      left=Math.min(left,px-w/2);right=Math.max(right,px+w/2);padTop=Math.min(padTop,py-h/2);padBottom=Math.max(padBottom,py+h/2);
    }
    const symbol={pins,shapes:[box(-half,round(top-1.5),half,round(bottom+1.5),"body",true),...art]};
    // The footprint outline indicates the pad field. Body/package dimensions can differ.
    const shapes=[box(round(left-.4),round(padTop-.4),round(right+.4),round(padBottom+.4),"silk")];
    return {id:d.id,name,prefix,value,category:"Project components",pinLayout:{version:1,bodyWidth:width},symbol,footprint:{name:footprint,pads,shapes}};
  }
  function open({library,target,commit}){
    const el=(tag,t)=>AtriumNavCommon.el(tag, t);
    const button=(label,fn)=>{const node=el("button",label);node.type="button";node.onclick=fn;return node;};
    const listButton=(label,fn)=>{
      const node=button(label,fn);
      return globalThis.AtriumUI?.button(node,"secondary","sm")??node;
    };
    const dlg=el("dialog");dlg.className="work-dialog library-editor";dlg.setAttribute("aria-label","New component");
    let source=null,d=draft(null),tab="schematic",page=0,frame=0;
    const drafts=new Map();
    const caption=el("h2","New component"),start=el("select"),meta=el("div"),controls=el("div"),region=el("div"),preview=el("canvas");
    const status=el("p"),footer=el("div"),tabs=el("div"),unit=el("span","mm");
    status.setAttribute("role","status");status.className="le-error";footer.className="work-actions";
    meta.className="le-meta";controls.className="le-controls";region.className="le-region";tabs.className="le-tabs ui-tabs";preview.className="le-preview";
    unit.title="Geometry is measured in millimetres";unit.className="le-unit";
    const symbolTab=button("Symbol",()=>activate("schematic")),boardTab=button("Footprint",()=>activate("pcb"));
    const place=button("Save and place",()=>save(true));
    function label(name,control){
      const node=el("label");node.append(el("span",name),control);control.setAttribute("aria-label",name);return node;
    }
    function entry(value,write,kind="text",labelText){
      const input=el("input");input.type=kind;if(kind==="number"){input.step="any";input.dataset.numericUnit="mm";}input.value=value;
      if(labelText)input.setAttribute("aria-label",labelText);
      input.oninput=()=>{write(input.value);schedule();};return input;
    }
    function options(values,current,write,accessible){
      const menu=el("select");menu.setAttribute("aria-label",accessible);
      for(const v of values)menu.add(new Option(v,v));menu.value=current;
      menu.onchange=()=>{write(menu.value);schedule();};return menu;
    }
    start.setAttribute("aria-label","Start from");start.add(new Option("New pin-mapped component",""));
    for(const v of library)start.add(new Option(v.name,v.id));
    start.value="";
    start.onchange=()=>{
      const choice=library.find(v=>v.id===start.value);
      drafts.set(source?.id||"",d);
      try{d=drafts.get(choice?.id||"")||draft(choice,library);source=choice;tab=choice?.footprint&&!choice?.symbol?"pcb":"schematic";page=0;render();}
      catch(e){start.value=source?.id||"";status.textContent=e.message;}
    };
    function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint();});}
    function paint(){
      if(!dlg.isConnected)return;
      try{
        const def=d.custom?build({...d,name:d.name.trim()||"Component"}):source;
        if(A.geometries(def,tab)){preview.hidden=false;AtriumCanvas.preview(preview,def,tab);}else preview.hidden=true;
        status.textContent="";
      }catch(error){preview.hidden=true;status.textContent=error.message;}
    }
    function activate(kind){tab=kind;renderBody();schedule();}
    function renderBody(){
      region.replaceChildren();symbolTab.setAttribute("aria-pressed",String(tab==="schematic"));boardTab.setAttribute("aria-pressed",String(tab==="pcb"));
      preview.setAttribute("aria-label",tab==="pcb"?"Footprint preview":"Symbol preview");
      if(!d.custom){region.append(el("p","This copy keeps the existing pin, pad and drawing geometry."));return;}
      const sym=tab==="schematic",table=el("table"),head=el("thead"),headRow=el("tr"),body=el("tbody");
      if(sym)region.append(label("Body width (mm)",entry(d.width,v=>d.width=v,"number")));
      const columns=sym?["Pin / pad","Signal","Side","Y",""]:["Pad","X","Y","Width","Height","Drill","Shape",""];
      for(const c of columns){const th=el("th",c);th.scope="col";if(c==="Drill")th.title="Use zero for a surface-mount pad";headRow.append(th);}
      head.append(headRow);table.append(head,body);const wrap=el("div");wrap.className="le-table-wrap";wrap.append(table);region.append(wrap);
      const size=12;page=Math.max(0,Math.min(page,Math.ceil(d.rows.length/size)-1));const start=page*size;
      for(let i=start;i<Math.min(start+size,d.rows.length);i++){
        const r=d.rows[i],tr=el("tr");
        function cell(n){const td=el("td");td.append(n);tr.append(td);}
        const nn=(key,lbl)=>entry(r[key],v=>r[key]=v,"number",lbl+" "+(i+1));
        if(sym){
          cell(entry(r.number,v=>r.number=v,"text","Pin number "+(i+1)));cell(entry(r.name,v=>r.name=v,"text","Pin name "+(i+1)));
          cell(options(["Left","Right"],r.side,v=>r.side=v,"Pin side "+(i+1)));cell(nn("y","Pin Y"));
        }else{
          cell(el("strong",r.number));for(const [k,l] of [["px","Pad X"],["py","Pad Y"],["w","Pad width"],["h","Pad height"],["drill","Pad drill"]])cell(nn(k,l));
          cell(options(padShapes,r.shape,v=>r.shape=v,"Pad shape "+(i+1)));
        }
        const minus=button("−",()=>{d.rows.splice(i,1);renderBody();schedule();});minus.setAttribute("aria-label","Remove pin and pad "+(i+1));cell(minus);body.append(tr);
      }
      const nav=el("div");nav.className="le-list-actions";
      nav.append(listButton("Add pin",()=>{d.rows.push(freshRow(d.rows));page=Math.floor((d.rows.length-1)/size);renderBody();schedule();}));
      if(d.rows.length>size){
        const prev=listButton("Previous",()=>{page--;renderBody();}),next=listButton("Next",()=>{page++;renderBody();});
        prev.disabled=page===0;next.disabled=start+size>=d.rows.length;
        nav.append(prev,el("small",(start+1)+"–"+Math.min(start+size,d.rows.length)+" / "+d.rows.length),next);
      }
      region.append(nav);
    }
    function render(){
      meta.replaceChildren();
      meta.append(label("Component name",entry(d.name,v=>d.name=v)),label("Prefix",entry(d.prefix,v=>d.prefix=v)),
        label("Default value",entry(d.value,v=>d.value=v)));
      if(d.custom||source?.footprint)meta.append(label("Footprint name",entry(d.footprint,v=>d.footprint=v)));
      symbolTab.hidden=!d.custom&&!source?.symbol;boardTab.hidden=!d.custom&&!source?.footprint;
      place.hidden=!d.custom&&!A.geometries(source,target);unit.hidden=!d.custom;
      renderBody();schedule();
    }
    function save(andPlace){
      try{const definition=build(d),finish=commit(definition,andPlace);dlg.close();finish?.();}
      catch(error){status.textContent=error.message;}
    }
    symbolTab.classList.add("ui-tab");boardTab.classList.add("ui-tab");
    tabs.append(symbolTab,boardTab);controls.append(tabs,unit);
    const saveComponent=button("Save component",()=>save(false));saveComponent.classList.add("is-primary");
    footer.append(button("Cancel",()=>dlg.close()),place,saveComponent);
    dlg.append(caption,label("Start from",start),meta,controls,preview,region,status,footer);dlg.onclose=()=>dlg.remove();
    document.body.append(dlg);render();
    const initialFocus=meta.querySelector("input");
    globalThis.AtriumShell?.adoptDialog?.(dlg, {title:caption, body:[meta,controls,preview,region,status], actions:footer, initialFocus, defaultAction:false});
    dlg.showModal();initialFocus?.focus();
  }
  return {open,draft,build,freshRow};
})();
