"use strict";

// Sheet artwork is separate from electrical objects. An imported title block or port
// outline cannot become a wire, net or placement target through decorative geometry.
globalThis.AtriumSchAppearance = (() => {
  const A=Atrium;
  // Altium Designer's default schematic palette. Text uses Altium's default system
  // font, Times New Roman 10, which the importer maps to 2.032 mm.
  const wire="#000080",component="#800000",fillInk="#ffffb0",pinInk="#000000",border="#000000";
  const select="#00a000",system="Times New Roman",fontSize=2.032;
  // Sheet, sheet grid and workspace follow the UI theme (AtriumTheme.canvasPalette
  // ("sch")): a white sheet in light themes; Altium's cream sheet otherwise. Wire, part
  // and selection inks never change, so the sheet must stay light (the theme ensures it).
  const STANDARD=Object.freeze({workspace:"#a3a3a3",paper:"#fffcf8",grid:"#e6e3dc",marquee:"#0a5fd0"});
  const palette={...STANDARD};
  const hexColor=/^#[0-9a-f]{6}$/i;
  function setTheme(next){
    let moved=false;
    for(const k of Object.keys(STANDARD)){
      const v=typeof next?.[k]==="string"&&hexColor.test(next[k])?next[k].toLowerCase():STANDARD[k];
      if(palette[k]!==v){palette[k]=v;moved=true;}
    }
    return moved;
  }
  try{setTheme(globalThis.AtriumTheme?.canvasPalette?.("sch"));}catch{}
  const face={family:system,size:fontSize,ink:wire};
  const clamped=(v,min,max)=>Math.max(min,Math.min(max,v));
  // Native sheets keep the origin 12.7 mm inside the upper left corner at every size.
  const isInfinite = doc => doc?.kind === "schematic" && doc.sheet?.infinite === true;
  // Known canvas ink bounds can come from the active view's index. Other consumers,
  // including PDF and foreign export, compute the same geometry against their library.
  function drawingBounds(doc, defs, ink) {
    if (ink === undefined) {
      defs ??= new Map((context?.library || []).map(d => [d.id,d]));
      ink = globalThis.AtriumCanvas?.artBounds(doc, defs) || A.docBounds(doc, defs);
    }
    const b = ink || [-24,-16,24,16], title = templates[sheetOf(doc).titleBlock];
    if (!isInfinite(doc) || !title) return b.slice();
    return [Math.min(b[0], b[2] - title.width), b[1], b[2], b[3] + 2.54 + title.height];
  }
  function pageBounds(doc, defs, ink){
    if (isInfinite(doc)) return drawingBounds(doc, defs, ink);
    const p=doc.schDrawing||doc.schRestored?.sheet,s=p?null:sheetOf(doc),w=p?.width||s.width,h=p?.height||s.height;
    if (doc.sheetOrigin==="top-left" || (doc.sheet?.size||p) && /\.kicad_sch$/i.test(doc.sourceName || "")) return [0,0,w,h];
    return doc.sheetOrigin==="bottom-left"||doc.sourceName?[0,-h,w,0]:[-12.7,-12.7,w-12.7,h-12.7];
  }
  function path(ctx,points,closed=false){
    if(!points?.length)return false;
    ctx.beginPath();ctx.moveTo(...points[0]);
    for(let n=1;n<points.length;n++)ctx.lineTo(...points[n]);
    if(closed)ctx.closePath();return true;
  }
  function fontStack(family){
    const name=String(family||"Arial").replace(/["\\\n\r]/g,"");
    return '"'+name+'", '+(/times|serif|roman/i.test(name)?"Times, serif":"Arial, sans-serif");
  }
  // Quarter-turned parts keep their text readable, as in Altium: text never reads
  // upside down or top-to-bottom. The anchor stays put and the justification flips.
  function upright(ctx,paint){
    const m=typeof ctx.getTransform==="function"?ctx.getTransform():null;
    if(!m || !Number.isFinite(m.a))return paint;
    const t=A.rad(paint.angle||0),dx=m.a*Math.cos(t)+m.c*Math.sin(t),dy=m.b*Math.cos(t)+m.d*Math.sin(t);
    if(dx>1e-6 || Math.abs(dx)<=1e-6 && dy<0)return paint;
    const flip={left:"right",right:"left",top:"bottom",bottom:"top"};
    return {...paint,angle:(paint.angle||0)+180,align:flip[paint.align||"left"]||paint.align,
      baseline:flip[paint.baseline]||(paint.baseline==="middle"?"middle":"top")};
  }
  // Negation marks are display only: names, nets and netlists keep the backslashes (docs/getting-started.md, Active-low names).
  // Per character (Altium): a backslash after a character overlines it, R\E\S\E\T\ is RESET with a bar over
  // each letter. Single "\" negation (Preferences › Schematic › General, on by default): a name that starts
  // with one backslash is overlined whole, \RESET; "\\" at the start writes one literal backslash and the
  // rest follows the per-character rule. -> {text, bars: indices of overlined characters or null, all}
  let single=null;
  // singleNegation(on, true) (the Preferences toggle) also redraws every pane and drops cached PCB text layouts.
  function singleNegation(v,redraw){
    if(v!==undefined)single=v!==false;
    if(redraw){globalThis.AtriumPCBText?.clearCache?.();globalThis.AtriumNavHost?.redraw?.(true);}
    return single??=globalThis.AtriumPref?.get?.("schematic.singleNegation",true)!==false;
  }
  function negation(text,on=singleNegation()){
    text=String(text??"");
    if(text.length<2||!text.includes("\\"))return {text,bars:null,all:false};
    let s="",i=0;const bars=[];
    if(on&&text[0]==="\\"){if(text[1]!=="\\"){const r=negation(text.slice(1),false);return {text:r.text,bars:[...r.text].map((c,n)=>n),all:true};}s="\\";i=2;}
    for(const c of text.slice(i))if(c==="\\"&&s&&!bars.includes(s.length-1))bars.push(s.length-1);else s+=c;
    return {text:s,bars:bars.length?bars:null,all:false};
  }
  // Sheet text is a few px tall in canvas units and scaled up. WebKit rounds font metrics at
  // that size, so its top, middle and bottom baselines drift (a bottom-anchored power port name
  // falls onto its bar). Text is therefore always drawn on the alphabetic baseline, shifted by
  // the offset the browser reports for the asked baseline at 100 px.
  const baselineShifts=new Map();let metrics;const metricsCtx=()=>(metrics??=globalThis.document?.createElement("canvas").getContext("2d"));
  function baselineShift(face,baseline){
    if(baseline==="alphabetic")return 0;
    const key=face+"|"+baseline;let v=baselineShifts.get(key);
    if(v===undefined){
      const c=metricsCtx();
      if(c){c.font="100px "+face;c.textBaseline=baseline;v=-c.measureText("Hg").alphabeticBaseline/100;}
      // Without baseline metrics, the ratios print.js uses for the same fonts.
      if(!Number.isFinite(v))v={top:.8,hanging:.72,middle:.32,bottom:-.22,ideographic:-.22}[baseline]??0;
      baselineShifts.set(key,v);
    }
    return v;
  }
  function capHeight(face){
    let v=baselineShifts.get(face+"|cap");
    if(v===undefined){const c=metricsCtx();if(c){c.font="100px "+face;c.textBaseline="alphabetic";v=c.measureText("X").actualBoundingBoxAscent/100;}if(!Number.isFinite(v))v=.7;baselineShifts.set(face+"|cap",v);}
    return v;
  }
  function glyph(ctx,text,x,y,paint,scale,override){
    if(!text || paint.size*scale<2.4)return;
    ctx.save();ctx.translate(x,y);if(paint.angle)ctx.rotate(A.rad(paint.angle));
    const face=fontStack(paint.family),style=(paint.italic?"italic ":"")+(paint.bold?"bold ":"");
    ctx.font=style+paint.size+"px "+face;
    const dy=baselineShift(style+face,paint.baseline||"alphabetic")*paint.size;
    ctx.textAlign=paint.align||"left";ctx.textBaseline="alphabetic";ctx.fillStyle=override||paint.ink||wire;
    const neg=negation(text),bars=neg.bars;text=neg.text;
    if(paint.maxWidth>0)ctx.fillText(text,0,dy,paint.maxWidth);else ctx.fillText(text,0,dy);
    if(bars&&text){
      const w=s=>ctx.measureText(s).width,W=w(text),x=ctx.textAlign==="right"?-W:ctx.textAlign==="center"?-W/2:0,t=Math.max(paint.size*.06,.8/scale);
      const y=dy-capHeight(style+face)*paint.size-paint.size*.08-t;
      if(neg.all)ctx.fillRect(x,y,W,t);
      else for(const k of bars)ctx.fillRect(x+w(text.slice(0,k)),y,w(text.slice(0,k+1))-w(text.slice(0,k)),t);
    }
    if(paint.underline){
      const w=ctx.measureText(text).width,left=ctx.textAlign==="right"?-w:ctx.textAlign==="center"?-w/2:0;
      const y=paint.baseline==="top"?paint.size:paint.baseline==="middle"?paint.size*.5:0;
      ctx.fillRect(left,y,w,Math.max(.07,paint.size*.04));
    }
    ctx.restore();
  }
  const templateBounds=new WeakMap();
  function templateVisible(frame,viewport){
    if(!frame?.length)return false;
    if(!viewport)return true;
    let bounds=templateBounds.get(frame);
    if(!bounds){
      const pts=[];
      for(const s of frame){
        if(s.kind==="text"){
          const w=(s.text.length+1)*s.size,h=s.size*1.5;
          // The asymmetric text justification and its quarter turns fit this envelope.
          const r=Math.max(w,h);pts.push([s.x-r,s.y-r],[s.x+r,s.y+r]);
        }else if(s.kind==="path"&&s.points.length){
          const b=A.bounds(s.points);pts.push([b[0],b[1]],[b[2],b[3]]);
        }
      }
      bounds=A.bounds(pts);if(!bounds)return false;templateBounds.set(frame,bounds);
    }
    return !(bounds[2]<viewport[0] || bounds[0]>viewport[2] || bounds[3]<viewport[1] || bounds[1]>viewport[3]);
  }
  // Altium's visible grid is a field of thin, light grey lines on the sheet. Zoomed
  // out, the pitch doubles so the lines never crowd closer than about 8 pixels.
  function sheetGrid(ctx,rect,step,scale,viewport){
    if(!(step>0 && scale>0))return;
    let spacing=step;
    while(spacing*scale<8)spacing*=2;
    const [x0,y0,x1,y1]=viewport?[Math.max(rect[0],viewport[0]),Math.max(rect[1],viewport[1]),Math.min(rect[2],viewport[2]),Math.min(rect[3],viewport[3])]:rect;
    if(!(x1>x0 && y1>y0) || (x1-x0)/spacing+(y1-y0)/spacing>4000)return;
    // Snap a hairline to backing-pixel centres on screen, including Retina canvases.
    const t=ctx.getTransform?.(),pixels=t?.a>0 && t.d>0 && t.b===0 && t.c===0;
    const align=(v,k,offset)=>(Math.round(v*k+offset)+.5-offset)/k;
    // Odd lines fade out before the pitch doubles (nothing pops while zooming).
    const fade=Math.min(1,(spacing*scale-8)/8);
    ctx.lineCap="butt";ctx.strokeStyle=palette.grid;ctx.lineWidth=1/(pixels?t.a:scale);
    for(const odd of [1,0])if(!odd||fade>0){
      ctx.beginPath();ctx.globalAlpha=odd?fade:1;
      for(let k=Math.ceil(x0/spacing),v;(v=k*spacing)<=x1;k++)if((k&1)==odd){v=pixels?align(v,t.a,t.e):v;ctx.moveTo(v,y0);ctx.lineTo(v,y1);}
      for(let k=Math.ceil(y0/spacing),v;(v=k*spacing)<=y1;k++)if((k&1)==odd){v=pixels?align(v,t.d,t.f):v;ctx.moveTo(x0,v);ctx.lineTo(x1,v);}
      ctx.stroke();
    }
    ctx.globalAlpha=1;
  }
  // Sheet templates. Sizes are landscape width × height in mm. The margin is the zone
  // strip between the paper edge and the drawing border; zones count across × down.
  const IN=25.4,inch=(w,h)=>[+(w*IN).toFixed(4),+(h*IN).toFixed(4)];
  const small=5.08,medium=7.62,large=10.16;
  const SIZES=[
    ["A4","ISO","A4",297,210,small,6,4],["A3","ISO","A3",420,297,small,8,6],["A2","ISO","A2",594,420,medium,12,8],
    ["A1","ISO","A1",841,594,large,16,12],["A0","ISO","A0",1189,841,large,24,16],
    ["ANSI A","ANSI","A",...inch(11,8.5),small,4,4],["ANSI B","ANSI","B",...inch(17,11),small,8,4],
    ["ANSI C","ANSI","C",...inch(22,17),medium,8,6],["ANSI D","ANSI","D",...inch(34,22),large,12,8],
    ["ANSI E","ANSI","E",...inch(44,34),large,16,12],
    ["Altium A4","Altium","A4",...inch(11.5,7.6),small,4,4],["Altium A3","Altium","A3",...inch(15.5,11.1),small,6,4],
    ["Altium A2","Altium","A2",...inch(22.3,15.7),medium,8,6],["Altium A1","Altium","A1",...inch(31.5,22.3),large,12,8],
    ["Altium A0","Altium","A0",...inch(44.6,31.5),large,16,12],["Altium A","Altium","A",...inch(9.5,7.5),small,4,4],
    ["Altium B","Altium","B",...inch(15,9.5),small,6,4],["Altium C","Altium","C",...inch(20,15),medium,8,6],
    ["Altium D","Altium","D",...inch(32,20),large,12,8],["Altium E","Altium","E",...inch(42,32),large,16,12],
    ["Letter","Altium","Letter",...inch(11,8.5),small,4,4],["Legal","Altium","Legal",...inch(14,8.5),small,6,4],
    ["Tabloid","Altium","Tabloid",...inch(17,11),small,6,4],
    ["OrCAD A","OrCAD","A",...inch(9.9,7.9),small,4,4],["OrCAD B","OrCAD","B",...inch(15.4,9.9),small,6,4],
    ["OrCAD C","OrCAD","C",...inch(20.6,15.6),medium,8,6],["OrCAD D","OrCAD","D",...inch(32.6,20.6),large,12,8],
    ["OrCAD E","OrCAD","E",...inch(42.8,32.8),large,16,12]
  ].map(([name,family,label,width,height,margin,zonesX,zonesY])=>({name,family,label,width,height,margin,zonesX,zonesY}));
  const sizeByName=new Map(SIZES.map(s=>[s.name,s]));
  // Sheets saved before templates existed are Altium A4 with the Standard title block.
  const DEFAULT_SIZE="Altium A4",TITLE_BLOCKS=["standard","ansi","none"];
  const plain=v=>v&&typeof v==="object"&&!Array.isArray(v);
  const count=(v,max)=>Number.isInteger(v)&&v>=1&&v<=max?v:null;
  function sheetOf(doc){
    const s=plain(doc?.sheet)?doc.sheet:{},size=sizeByName.get(s.size)||sizeByName.get(DEFAULT_SIZE);
    const portrait=s.orientation==="portrait",z=plain(s.zones)?s.zones:{};
    const infinite=isInfinite(doc);
    return {size:infinite?"none":size.name,family:size.family,label:infinite?"Infinite":size.label,orientation:portrait?"portrait":"landscape",
      width:portrait?size.height:size.width,height:portrait?size.width:size.height,margin:size.margin,
      zonesX:count(z.x,32)||(portrait?size.zonesY:size.zonesX),zonesY:count(z.y,26)||(portrait?size.zonesX:size.zonesY),
      titleBlock:TITLE_BLOCKS.includes(s.titleBlock)?s.titleBlock:infinite?"none":"standard",params:plain(s.params)?s.params:{}};
  }
  // lenient: a file from a newer version (model.js): an unknown size, orientation or title block is
  // kept as written and drawn as the default (sheetOf).
  function validateSheet(s,lenient){
    const bad=()=>{throw Error("This file is not a supported Waffle project.");};
    const one=(v,ok)=>ok||lenient&&typeof v==="string"&&v.length<=64;
    if(!plain(s)||s.infinite!==undefined&&typeof s.infinite!=="boolean")bad();
    if(s.size!=null&&!one(s.size,sizeByName.has(s.size)))bad();
    if(s.orientation!=null&&!one(s.orientation,["landscape","portrait"].includes(s.orientation)))bad();
    if(s.titleBlock!=null&&!one(s.titleBlock,TITLE_BLOCKS.includes(s.titleBlock)))bad();
    if(s.zones!=null&&(!plain(s.zones)||s.zones.x!=null&&!count(s.zones.x,32)||s.zones.y!=null&&!count(s.zones.y,26)))bad();
    if(s.params!=null&&(!plain(s.params)||Object.values(s.params).some(v=>typeof v!=="string")))bad();
  }
  // Altium special strings: "=Name" resolves from the sheet's parameters, then the
  // project's, then built-in document values. Names are case-insensitive. A name that
  // resolves to nothing reads "*", as in Altium, unless the caller asks otherwise.
  let context=null;
  function setProject(project){context=project||null;}
  function paramTable(source){
    const table=new Map();
    if(Array.isArray(source)){for(const p of source)if(p&&typeof p.name==="string")table.set(p.name.toLowerCase(),String(p.value??""));}
    else if(plain(source))for(const [k,v] of Object.entries(source))if(v!=null)table.set(k.toLowerCase(),String(v));
    return table;
  }
  function resolveSpecialStrings(text,project,doc,{missing="*",now=new Date(),sheetParams=true,projectParameters=undefined}={}){
    if(typeof text!=="string" || !text.includes("="))return text;
    project=project||context;
    const sheets=project?.documents?.filter(d=>d.kind==="schematic")||[],at=doc?sheets.indexOf(doc):-1;
    const sheet=doc?.kind==="schematic"&&(isInfinite(doc)||!doc.schDrawing&&!doc.schRestored)?sheetOf(doc):null;
    const file=doc?(doc.sourceName||doc.name+".SchDoc"):"";
    const builtin={title:doc?.name,documentname:file,documentfullpathandname:file,projectname:project?.name,
      sheetnumber:at>=0?String(at+1):undefined,sheettotal:sheets.length&&at>=0?String(sheets.length):undefined,
      currentdate:now.toLocaleDateString(),currenttime:now.toLocaleTimeString(),date:now.toLocaleDateString(),
      time:now.toLocaleTimeString(),sheetsize:sheet?.label,scale:sheet?"NONE":undefined};
    // Board revisions (revisions.js): =Revision, =RevisionStatus, =RevisionDate, =RevisionNotes from project.revision win over project parameters.
    const rv=plain(project?.revision)&&typeof project.revision.letter==="string"?project.revision:null;
    const revTable=paramTable(rv?{Revision:rv.letter,RevisionStatus:{draft:"Draft",released:"Released",obsolete:"Obsolete"}[rv.status]||"Draft",RevisionDate:rv.date||"",RevisionNotes:rv.notes||""}:null);
    const tables=[paramTable(sheetParams&&plain(doc?.sheet)?doc.sheet.params:null),paramTable(doc?.parameters),revTable,paramTable(projectParameters ?? project?.parameters)];
    return text.replace(/(^|[\s([{,;:/])=([A-Za-z_][A-Za-z0-9_]*)/g,(all,lead,name)=>{
      const key=name.toLowerCase();
      for(const t of tables)if(t.has(key)&&t.get(key)!=="")return lead+t.get(key);
      const v=builtin[key];
      return lead+(v==null||v===""?missing:v);
    });
  }
  // Title blocks are laid out in their own millimetre frame, anchored to the drawing
  // border's lower right corner. Captions are printed; values are special strings.
  const templates={
    // Altium's "Standard" block: 3.5 × 0.8 in.
    standard:{width:88.9,height:20.32,
      lines:[[0,7.62,88.9,7.62],[0,15.24,88.9,15.24],[12.7,7.62,12.7,15.24],[68.58,7.62,68.58,15.24],[63.5,15.24,63.5,20.32]],
      captions:[["Title",.8,.7],["Size",.8,8.32],["Number",13.5,8.32],["Revision",69.4,8.32],
        ["Date:",.8,16.51,"middle"],["File:",.8,19.05,"middle"],["Sheet",64.3,16.51,"middle"],["of",76.2,16.51,"middle"],["Drawn By:",64.3,19.05,"middle"]],
      values:[["=Title",12.7,4.6,2.8,62],["=SheetSize",1.6,12.5,2.4,10],["=DocumentNumber",14.5,12.5,2.4,52],["=Revision",70.4,12.5,2.4,17],
        ["=CurrentDate",12.7,16.51,1.65,50],["=DocumentFullPathAndName",12.7,19.05,1.65,50],["=SheetNumber",70.5,16.51,1.65,5],
        ["=SheetTotal",80,16.51,1.65,8],["=DrawnBy",74,19.05,1.65,14]],
      caption:{family:system,size:1.65},value:{family:system}},
    // An ASME Y14.1-style block: approvals on the left, then title, size, CAGE code,
    // drawing number, revision, scale and sheet. 6.25 × 1.75 in.
    ansi:{width:158.75,height:44.45,
      lines:[[0,11.1125,63.5,11.1125],[0,22.225,63.5,22.225],[0,33.3375,63.5,33.3375],[44.45,0,44.45,44.45],[63.5,0,63.5,44.45],
        [63.5,11.43,158.75,11.43],[63.5,27.94,158.75,27.94],[63.5,38.1,158.75,38.1],
        [76.2,27.94,76.2,38.1],[99.06,27.94,99.06,38.1],[143.51,27.94,143.51,38.1],[111.125,38.1,111.125,44.45]],
      captions:[["APPROVALS",1,1],["DATE",45.3,1],["DRAWN",1,12.1],["CHECKED",1,23.2],["APPROVED",1,34.3],["TITLE",64.4,12.3],
        ["SIZE",64.4,28.8],["FSCM NO.",77.1,28.8],["DWG NO.",99.9,28.8],["REV",144.4,28.8],
        ["SCALE",64.4,41.275,"middle"],["SHEET",112,41.275,"middle"],["OF",132,41.275,"middle"]],
      values:[["=DrawnBy",2,19.5,2.032,41],["=DrawnDate",45.5,19.5,1.8,17],["=CheckedBy",2,30.6,2.032,41],["=CheckedDate",45.5,30.6,1.8,17],
        ["=ApprovedBy",2,41.7,2.032,41],["=ApprovedDate",45.5,41.7,1.8,17],["=CompanyName",111.125,6.6,2.8,92,"center"],
        ["=Title",111.125,21.8,2.8,92,"center"],["=SheetSize",69.85,36.4,2.8,11,"center"],["=CAGE",87.63,36.4,2.032,21,"center"],
        ["=DocumentNumber",121.3,36.4,2.8,43,"center"],["=Revision",151.13,36.4,2.8,14,"center"],
        ["=Scale",75,41.275,1.8,35],["=SheetNumber",125.5,41.275,1.8,6,"center"],["=SheetTotal",138,41.275,1.8,18]],
      caption:{family:"Arial",size:1.3},value:{family:"Arial"}}
  };
  function titleBlock(ctx,doc,project,style,right,bottom,scale,k=1,projectParameters){
    const t=templates[style];if(!t)return;
    ctx.save();ctx.translate(right-t.width*k,bottom-t.height*k);ctx.scale(k,k);
    const s=scale*k;
    ctx.fillStyle=palette.paper;ctx.fillRect(0,0,t.width,t.height);
    ctx.strokeStyle=border;ctx.lineWidth=1/s;ctx.strokeRect(0,0,t.width,t.height);
    ctx.beginPath();for(const [x1,y1,x2,y2] of t.lines){ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);}ctx.stroke();
    for(const [text,x,y,baseline="top"] of t.captions)glyph(ctx,text,x,y,{...t.caption,ink:border,baseline},s);
    for(const [text,x,y,size,maxWidth,align="left"] of t.values){
      const value=resolveSpecialStrings(text,project,doc,{missing:"",projectParameters});
      glyph(ctx,value,x,y,{...t.value,size,ink:wire,baseline:"middle",align,maxWidth},s);
    }
    ctx.restore();
  }
  // ASME Y14.1 numbers zones from the lower right corner and skips I and O.
  const zoneLetter=(i,ansi)=>ansi?"ABCDEFGHJKLMNPQRSTUVWXYZ"[i]||"?":String.fromCharCode(65+i);
  function page(ctx,doc,scale,drawGrid,viewport,project,extent,projectParameters){
    if (isInfinite(doc)) {
      const style = sheetOf(doc).titleBlock, title = templates[style];
      const b = extent || ((!viewport || title) && drawingBounds(doc)), area = viewport || b;
      ctx.save(); ctx.fillStyle = palette.paper;
      ctx.fillRect(area[0], area[1], area[2]-area[0], area[3]-area[1]);
      if (drawGrid) sheetGrid(ctx, area, Math.max(2.54,doc.grid||0), scale);
      if (title && area[2] >= b[2]-title.width && area[3] >= b[3]-title.height && area[0] <= b[2] && area[1] <= b[3])
        titleBlock(ctx, doc, project, style, b[2], b[3], scale, 1, projectParameters);
      ctx.restore(); return;
    }
    const p=doc.schDrawing||doc.schRestored?.sheet,[left,top,right,bottom]=pageBounds(doc),w=right-left,h=bottom-top;
    const sheet=p?null:sheetOf(doc),ansi=sheet?.family==="ANSI";
    ctx.save();ctx.fillStyle=p?.paper||palette.paper;ctx.fillRect(left,top,w,h);
    // A drawGrid callback means the visible grid is on. The sheet draws its own lines.
    if(drawGrid && p?.showGrid!==false)sheetGrid(ctx,[left,top,right,bottom],p?.grid||Math.max(2.54,doc.grid||0),scale,viewport);
    ctx.strokeStyle=border;ctx.lineWidth=1/scale;ctx.strokeRect(left,top,w,h);
    let inner=[left,top,right,bottom];
    if(p?.border!==false){
      const inset=Math.min(sheet?.margin||5.08,w*.07,h*.07),x=left+inset,y=top+inset,r=right-inset,b=bottom-inset;
      inner=[x,y,r,b];
      ctx.strokeStyle=border;ctx.lineWidth=1/scale;ctx.strokeRect(x,y,r-x,b-y);
      if(p?.zones!==false){
        const cols=clamped(p?.zonesX||sheet.zonesX,1,32),rows=clamped(p?.zonesY||sheet.zonesY,1,26);
        const paint={family:system,size:Math.min(fontSize*inset/5.08,inset*.55),align:"center",baseline:"middle",ink:border};
        for(let i=0;i<cols;i++){
          const x0=x+(r-x)*i/cols,mid=x0+(r-x)/(2*cols),name=String(ansi?cols-i:i+1);
          if(i){path(ctx,[[x0,top],[x0,y]]);ctx.stroke();path(ctx,[[x0,b],[x0,bottom]]);ctx.stroke();}
          for(const y0 of [top+inset*.5,bottom-inset*.5])glyph(ctx,name,mid,y0,paint,scale);
        }
        for(let i=0;i<rows;i++){
          const y0=y+(b-y)*i/rows,mid=y0+(b-y)/(2*rows),name=zoneLetter(ansi?rows-1-i:i,ansi);
          if(i){path(ctx,[[left,y0],[x,y0]]);ctx.stroke();path(ctx,[[r,y0],[right,y0]]);ctx.stroke();}
          for(const x0 of [left+inset*.5,right-inset*.5])glyph(ctx,name,x0,mid,paint,scale);
        }
      }
    }
    // Native sheets carry their chosen title block. Imported sheets draw their own frame.
    if(sheet)titleBlock(ctx,doc,project,sheet.titleBlock,inner[2],inner[3],scale,{5.08:1,7.62:1.25,10.16:1.5}[sheet.margin]||1,projectParameters);
    if(templateVisible(p?.frame,viewport))for(const shape of p.frame){
      if(shape.kind==="text"){glyph(ctx,shape.text,shape.x,shape.y,shape,scale);continue;}
      if(shape.kind!=="path")continue; // a frame shape from a newer version
      if(path(ctx,shape.points,shape.closed)){
        if(shape.solid){ctx.fillStyle=shape.fill;ctx.fill();}
        ctx.strokeStyle=shape.ink;ctx.lineWidth=Math.max(shape.width,.65/scale);ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Library drawings without source pens take Altium's defaults: black pins, maroon
  // body outlines over a pale yellow fill, and navy lines and text.
  function shapeInk(s){
    if(s.style==="pin")return pinInk;
    return s.kind!=="text" && (s.closed || s.fill || s.kind==="circle")?component:wire;
  }
  function shape(ctx,s,scale,selected){
    const p=s.schPaint;
    if(p?.pinNameFallback)return;
    const line=selected?select:p?.ink||shapeInk(s);
    if(s.kind==="text"){
      glyph(ctx,s.text,s.x,s.y,p||upright(ctx,{...face,size:s.size||1.5,angle:s.angle||0,align:s.align}),scale,selected?select:undefined);return;
    }
    // The one-pixel floor is the same as a wire's (canvas.js), so zoomed out a pin leg still matches its wire.
    ctx.strokeStyle=line;ctx.lineWidth=Math.max(1/scale,p?.width||s.width||.254);
    if(s.kind==="circle"){
      ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
    }else if(!path(ctx,s.points,s.closed))return;
    if(s.fill){ctx.fillStyle=p?.fill||fillInk;ctx.fill();}
    ctx.stroke();
  }
  // Pin names sit inside the body and pin numbers above the pin line, outside it.
  function pinText(ctx,part,def,scale,selected){
    if(def?.sourceSymbolShapes || !def?.schDrawing?.pins)return;
    const ink=selected?select:null,sourceFont=def.schDrawing.pinFont;
    const unit=part.unit||part.part||1; // pin text of a multi-part library symbol carries its gate
    for(const p of def.schDrawing.pins){
      if(p.part>0&&p.part!==unit)continue;
      const start=A.world(p.start,part),end=A.world(p.end,part),d=A.rotate(part.mirror?[-p.direction[0],p.direction[1]]:p.direction,part.angle||0);
      const vertical=Math.abs(d[1])>.5;
      const angle=vertical?-90:0,sign=vertical?-Math.sign(d[1]):Math.sign(d[0]);
      if(sourceFont){
        // Altium pin margins are measured from the pin's body end. The published
        // reference sheets use 70 mil inside and 80 mil outside, in every pin length.
        // Names sit centred on the pin line. A number sits outside, with the bottom of its text box
        // (the font's descent) on the pin line, so its digits clear the line by the descent, as Altium prints.
        const name=p.nameMargin??-1.778,number=p.numberMargin??2.032;
        if(p.name)glyph(ctx,p.name,start[0]+d[0]*name,start[1]+d[1]*name,
          {...(p.nameFont||sourceFont),align:sign>0?"right":"left",baseline:"middle",ink:pinInk,angle},scale,ink);
        if(p.number)glyph(ctx,p.number,start[0]+d[0]*number,start[1]+d[1]*number,
          {...(p.numberFont||sourceFont),align:sign>0?"left":"right",baseline:"bottom",ink:pinInk,angle},scale,ink);
        continue;
      }
      if(p.name)glyph(ctx,p.name,start[0]-d[0]*.6,start[1]-d[1]*.6,
        {family:system,size:fontSize,align:sign>0?"right":"left",baseline:"middle",ink:pinInk,angle},scale,ink);
      if(p.number){
        const mid=[(start[0]+end[0])/2,(start[1]+end[1])/2];
        glyph(ctx,p.number,mid[0]-(vertical?.25:0),mid[1]-(vertical?0:.25),
          {family:system,size:fontSize*.9,align:"center",baseline:"bottom",ink:pinInk,angle},scale,ink);
      }
    }
  }
  // Designator and Comment are navy system-font text, like Altium's parameters.
  function refs(ctx,i,pos,scale,selected){
    for(const [key,offset,show,defaultAt] of [["ref",i.refAt,i.showRef,pos.ref],["value",i.valueAt,i.showValue,pos.value]]){
      if(show===false||!i[key])continue;
      const at=offset?A.world(offset,i):defaultAt;if(!at)continue;
      const source=i.schPaint?.[key];
      const paint=source?{...source,angle:source.angle+(i.angle||0)}:{...face,align:offset?"left":pos.align};
      glyph(ctx,i[key],at[0],at[1],paint,scale,selected?select:null);
    }
  }
  function portOutline(p){
    const half=p.height/2,w=p.width,t=Math.min(half,w/3),vertical=p.style>=4,flags=p.style%4;
    const left=vertical?Boolean(flags&2):Boolean(flags&1),right=vertical?Boolean(flags&1):Boolean(flags&2);
    const points=[[left?t:0,-half],[right?w-t:w,-half]];
    if(right)points.push([w,0]);
    points.push([right?w-t:w,half],[left?t:0,half]);if(left)points.push([0,0]);
    return points;
  }
  const grounded=p=>p.style===4||p.style===8;
  // Power port geometry follows Altium: a 100 mil stem, a 100 mil bar, and the power
  // ground's four bars narrowing from 200 mil at a 30 mil pitch.
  function powerSymbol(ctx,i,p,scale,color){
    const rotation=-(p.direction||0)*90,stem=2.54;
    ctx.save();ctx.rotate(A.rad(rotation));ctx.strokeStyle=color;ctx.lineWidth=Math.max(.2,.85/scale);
    const line=pts=>{path(ctx,pts);ctx.stroke();};
    if(!p.offSheet)line([[0,0],[stem,0]]);
    switch(p.offSheet?"offsheet":p.style){
      case "offsheet":{
        const tip=p.style===1?1.27:0,back=1.27-tip;
        line([[0,0],[.508+tip,0]]);
        for(const x of [.508,1.778])line([[x+back,-1.27],[x+tip,0],[x+back,1.27]]);
        break;
      }
      case 0:ctx.beginPath();ctx.arc(stem+.62,0,.62,0,Math.PI*2);ctx.stroke();break;
      case 1:case 7:line([[stem-1,-.8],[stem,0],[stem-1,.8]]);break;
      case 2:case 10:line([[stem,-1.27],[stem,1.27]]);break;
      case 3:line([[stem,-1.27],[stem-.3,-.65],[stem+.3,.65],[stem,1.27]]);break;
      case 4:case 8:
        for(let n=0;n<4;n++){const x=stem+n*.762,r=2.54-n*.762;line([[x,-r],[x,r]]);}break;
      case 5:line([[stem,-1.27],[stem+1.3,0],[stem,1.27],[stem,-1.27]]);break;
      case 6:case 9:line([[stem,-1.27],[stem,1.27]]);for(const y of [-1,0,1])line([[stem,y],[stem+.7,y-.6]]);break;
      default:line([[stem,-.8],[stem,.8]]);
    }
    ctx.restore();
    if(p.showName){
      // In the Altium print a bar facing up shares its top edge with the bottom
      // text anchor. The font supplies the space between the bar and the ink.
      const gap=p.offSheet?3.556:p.style===2&&p.direction===1?stem:grounded(p)?5.3:3.25;
      const d=A.rotate([1,0],rotation),offset=A.rotate([gap,0],rotation);
      glyph(ctx,i.text,...offset,{...p,angle:0,align:d[0]>.5?"left":d[0]<-.5?"right":"center",baseline:d[1]>.5?"top":d[1]<-.5?"bottom":"middle"},scale,color);
    }
  }
  // A plain label turned upside down (90 to 270 degrees, e.g. KiCad's 180 degree labels) is
  // drawn a half turn further and right-aligned: same anchor and side, readable text.
  const upsideDown=a=>{const v=((a||0)%360+360)%360;return v>=90-1e-9&&v<270-1e-9;};
  function label(ctx,i,scale,highlight){
    const p=i.schPaint,ink=highlight?select:p?.ink||(p?.type==="port"||p?.type==="power"?component:wire);
    ctx.save();ctx.translate(i.x,i.y);ctx.rotate(A.rad(i.angle||0));
    if(p?.type==="port"){
      ctx.translate(...p.offset);if(p.style>=4)ctx.rotate(-Math.PI/2);
      path(ctx,portOutline(p),true);ctx.fillStyle=p.paper||fillInk;ctx.fill();ctx.strokeStyle=ink;ctx.lineWidth=Math.max(.12,.8/scale);ctx.stroke();
      const pad=Math.min(p.width*.2,p.height*.6),x=p.align==="right"?p.width-pad:p.align==="left"?pad:p.width/2;
      glyph(ctx,i.text,x,0,{...p,angle:0,size:Math.min(p.size||fontSize,p.height*.84),baseline:"middle"},scale,highlight?select:p.textInk||component);
    }else if(p?.type==="power")powerSymbol(ctx,i,p,scale,ink);
    else if(p)glyph(ctx,i.text,0,0,p,scale,ink);
    // Altium net labels rest on their wire: the anchor is the text's lower left.
    else{const flip=upsideDown(i.angle);if(flip)ctx.rotate(Math.PI);
      glyph(ctx,i.text,0,i.at==="below"?2.1:i.kind==="netlabel"?-.35:0,
      {...face,size:i.size||fontSize,baseline:i.at==="below"?"top":i.kind==="netlabel"?"alphabetic":"bottom",align:flip?"right":"left"},scale,ink);}
    ctx.restore();
    crossReferences(ctx,i,scale,highlight);
  }
  function crossReferences(ctx,i,scale,highlight){
    for(const caption of i.schPaint?.crossReferences||[]){
      const at=A.world(caption.at,i);
      glyph(ctx,caption.text,...at,upright(ctx,{...caption,angle:caption.angle+(i.angle||0)}),scale,highlight?select:null);
    }
  }
  // Altium marks a selection with a thin dashed outline in its selection green and
  // small square grips; editable vertices and pin ends take the same grip.
  function grip(ctx,p,scale){
    const s=3.2/scale;
    ctx.fillStyle=palette.paper;ctx.fillRect(p[0]-s,p[1]-s,s*2,s*2);
    ctx.strokeStyle=select;ctx.lineWidth=1.2/scale;ctx.setLineDash?.([]);ctx.strokeRect(p[0]-s,p[1]-s,s*2,s*2);
  }
  function selection(ctx,b,scale){
    if(!b)return;
    const pad=3/scale,x=b[0]-pad,y=b[1]-pad,r=b[2]+pad,v=b[3]+pad;
    ctx.save();ctx.strokeStyle=select;ctx.lineWidth=1/scale;ctx.setLineDash?.([4/scale,3/scale]);
    ctx.strokeRect(x,y,r-x,v-y);ctx.setLineDash?.([]);
    for(const p of [[x,y],[r,y],[r,v],[x,v]]){const s=2.4/scale;ctx.fillStyle=select;ctx.fillRect(p[0]-s,p[1]-s,s*2,s*2);}
    ctx.restore();
  }
  function labelBox(i){
    const p=i.schPaint,fontSize=p?.size||i.size||2.032;
    const w=Math.max(fontSize,String(i.text||"").length*fontSize*.9);
    let box,origin=[0,0],angle=0;
    if(p?.type==="port"){
      angle=p.style>=4?-90:0;origin=p.offset;box=[0,-p.height*.5,p.width,p.height*.5];
    }else if(p?.type==="power"){
      const d=A.rotate([1,0],-p.direction*90),extent=(grounded(p)?5.4:4.2)+(p.showName?fontSize*1.5:0);
      const end=[extent*d[0],extent*d[1]],ww=Math.max(grounded(p)?2.7:1.4,p.showName?w*.55:0);
      box=[Math.min(-ww,end[0]-ww),Math.min(-1.4,end[1]-1.4),Math.max(ww,end[0]+ww),Math.max(1.4,end[1]+1.4)];
      if(Math.abs(d[0])>.5&&p.showName)box[d[0]>0?2:0]=d[0]*(extent+w);
    }else{
      angle=p?.angle||0;const x=p?.align==="center"?-w/2:p?.align==="right"?-w:0;
      const y=p?.baseline==="top"?0:p?.baseline==="middle"?-fontSize*.6:i.at==="below"?0:-fontSize*1.5;
      box=[x,y,x+w,y+fontSize*1.6];
      if(!p&&upsideDown(i.angle))box=[box[0],-box[3],box[2],-box[1]];
    }
    const corners=[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]];
    const bounds=A.bounds(corners.map(q=>A.world(A.world(q,{x:origin[0],y:origin[1],angle}),i)));
    for(const caption of p?.crossReferences||[]){
      const [x,y]=A.world(caption.at,i),b=labelBox({kind:"label",x,y,text:caption.text,angle:i.angle,schPaint:caption});
      bounds[0]=Math.min(bounds[0],b[0]);bounds[1]=Math.min(bounds[1],b[1]);bounds[2]=Math.max(bounds[2],b[2]);bounds[3]=Math.max(bounds[3],b[3]);
    }
    return bounds;
  }
  function sheetSettings(container,doc,apply,project){
    if(project)setProject(project);
    if(!container||doc?.kind!=="schematic")return;
    const fill=(ui,target)=>ui.fill(target,doc,apply,project,{plain,count,inch:IN});
    if(globalThis.AtriumSheetInspector)fill(globalThis.AtriumSheetInspector,container);
    else globalThis.AtriumLazy?.appendOnLoad("AtriumSheetInspector",container,fill,e=>globalThis.AtriumNavHost?.info(e));
  }
  function eligible(doc,{source=doc,includeRestored=false}={}){
    return doc.kind==="schematic" && !doc.schDrawing && (includeRestored || !doc.schRestored) &&
      /\.schdoc$/i.test(source.sourceName||"") && /^[a-f0-9]{64}$/.test(source.sourceSha256||"");
  }
  function sourceKey(item){
    if(globalThis.AtriumTranslatorProvenance)return AtriumTranslatorProvenance.schematicSourceKey(item);
    const k=item.schSource;
    return Number.isInteger(k?.record)&&typeof k.role==="string"?k.record+":"+k.role:null;
  }
  const fingerprints=new WeakMap();
  function symbolFingerprint(symbol,cache=fingerprints){
    if(!symbol)return "";
    let value=cache.get(symbol);
    if(value)return value;
    // Project serialization sorts object keys. Hash the drawing without import-only
    // styling, preserving the order of the pins, primitives and vertices.
    const data=JSON.stringify(A.definitionGeometry({symbol}).symbol,(key,obj)=>{
      if(key==="schPaint")return undefined;
      if(!obj||typeof obj!=="object"||Array.isArray(obj))return obj;
      return Object.fromEntries(Object.keys(obj).sort().map(k=>[k,obj[k]]));
    });
    value=AtriumSourceFile.sha256(new TextEncoder().encode(data));
    cache.set(symbol,value);return value;
  }
  function planRestore(doc,library,source){
    if(!eligible(doc))throw Error("This sheet already has source appearance or has no linked binary SchDoc.");
    const original=source.documents?.[0];
    if(!original?.schDrawing || source.documents.length!==1 || original.sourceSha256!==doc.sourceSha256)
      throw Error("The selected file differs from the original SchDoc. Choose the revision used to import this sheet.");
    const byKey=new Map(original.items.map(item=>[sourceKey(item),item]));
    const defs=new Map(library.map(d=>[d.id,d])),originalDefs=new Map(source.library.map(d=>[d.id,d]));
    const appearance={sheet:original.schDrawing,items:Object.create(null),definitions:Object.create(null)};
    const cache=new WeakMap();
    let matched=0,custom=0;
    for(const item of doc.items){
      const key=sourceKey(item),other=key&&byKey.get(key);
      if(!other||other.kind!==item.kind)continue;
      matched++;
      const style={};
      if(other.schPaint)style.paint=other.schPaint;
      if(other.kind==="graphic"){
        if(other.closed!==undefined)style.closed=other.closed;
        if(other.fill!==undefined)style.fill=other.fill;
      }
      if(item.kind==="part"){
        const def=defs.get(item.def),ref=originalDefs.get(other.def);
        if(!def?.symbol || !ref?.symbol || def.name!==ref.name || def.sourceSymbolShapes ||
           symbolFingerprint(def.symbol,cache)!==symbolFingerprint(ref.symbol,cache)){
          custom++;
        }else{
          style.symbol=item.def;
          if(!Object.hasOwn(appearance.definitions,item.def)){
            appearance.definitions[item.def]={fingerprint:symbolFingerprint(def.symbol,cache),
              shapes:ref.symbol.shapes.map(s=>s.schPaint||null),pins:ref.schDrawing?.pins||[],...(ref.schDrawing?.pinFont?{pinFont:ref.schDrawing.pinFont}:{})};
          }
        }
      }
      if(Object.keys(style).length)appearance.items[key]=style;
    }
    return {appearance,matched,custom};
  }
  const itemViews=new WeakMap(),definitionViews=new WeakMap();
  function restoredStyle(doc,item) {
    const rows=doc.schRestored?.items;
    if(!rows)return null;
    if(Object.hasOwn(rows,item.id))return rows[item.id];
    const key=sourceKey(item);
    return key&&Object.hasOwn(rows,key)?rows[key]:null;
  }
  function displayItem(doc,item){
    const style=restoredStyle(doc,item);
    if(!style)return item;
    const prior=itemViews.get(item);if(prior?.style===style)return prior.view;
    // Inherit current geometry, edited values and designators. Only the pens and
    // graphic fill flag come from the verified original.
    const view=Object.create(item);
    if(style.paint)view.schPaint=style.paint;
    if(style.fill!==undefined)view.fill=style.fill;
    if(style.closed!==undefined)view.closed=style.closed;
    itemViews.set(item,{view,style});return view;
  }
  function displayDef(doc,item,def){
    if(!doc.schRestored || !def?.symbol || def.sourceSymbolShapes)return def;
    const ref=restoredStyle(doc,item)?.symbol;
    if(ref!==def.id||!Object.hasOwn(doc.schRestored.definitions,ref))return def;
    const style=doc.schRestored.definitions[ref],cached=definitionViews.get(def.symbol);
    if(cached?.style===style)return cached.view;
    if(symbolFingerprint(def.symbol)!==style.fingerprint)return def;
    const view=Object.create(def);
    view.symbol=Object.create(def.symbol);
    view.symbol.shapes=def.symbol.shapes.map((s,n)=>style.shapes[n]?Object.assign(Object.create(s),{schPaint:style.shapes[n]}):s);
    view.schDrawing={pins:style.pins,pinFont:style.pinFont};definitionViews.set(def.symbol,{style,view});return view;
  }
  async function restore(doc,project,ctx){
    const original=await ctx.pickFile([".SchDoc"]);
    if(!original || !ctx.current())return;
    const source=await AtriumImport.read(doc.sourceName,new Uint8Array(await original.arrayBuffer()));
    if(!ctx.current())throw Error("The design changed while reading the SchDoc. Choose the original again.");
    const {appearance,matched,custom}=planRestore(doc,project.library,source);
    ctx.edit(()=>{doc.schRestored=appearance;});
    ctx.info("Restored sheet appearance · "+matched+" matched objects"+(custom?" · "+custom+" custom symbol placements kept":""));
  }
  // canvas.js paints junctions and free graphics in `body`; Altium draws both in navy.
  return {sheetSizes:SIZES,isInfinite,drawingBounds,sheetOf,validateSheet,resolveSpecialStrings,setProject,sheetSettings,pageBounds,page,shape,glyph,negation,singleNegation,refs,pinText,label,labelBox,fontStack,baselineShift,crossReferences,selection,grip,wire,body:wire,component,select,get workspace(){return palette.workspace;},get paper(){return palette.paper;},get marquee(){return palette.marquee;},setTheme,fontSize,eligible,sourceKey,planRestore,restore,displayItem,displayDef};
})();
