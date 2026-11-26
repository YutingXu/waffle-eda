"use strict";
if (!globalThis.AtriumPCBAppearance && typeof require === "function") require("../pcb/pcb-appearance.js");
globalThis.AtriumKiCad = (() => {
  const A=Atrium, enc=new TextEncoder();
  const namespace=Uint8Array.from([0x27,0x77,0xf2,0x22,0x74,0x9b,0x46,0x85,0xa1,0xd8,0x49,0x96,0xd0,0xfa,0x58,0x21]);
  // UUID v5 gives a stable KiCad identity to every editable object and child
  // primitive even when an unrelated reference, net, or coordinate changes.
  // SHA-1 with its buffers kept between calls and the four round groups as separate loops
  // (tens of thousands of calls per board export; the same digests as a textbook SHA-1).
  const W=new Int32Array(80),HEX=Array.from({length:256},(_,i)=>(i<16?"0":"")+i.toString(16));
  let block=new Uint8Array(128),blockView=new DataView(block.buffer);
  const byte=(v,s)=>HEX[(v>>>s)&255];
  function uid(name){
    const text=enc.encode(name),length=16+text.length,size=Math.ceil((length+9)/64)*64;
    if(block.length<size){block=new Uint8Array(size*2);blockView=new DataView(block.buffer);}
    const input=block,view=blockView;
    input.fill(0,0,size);input.set(namespace);input.set(text,16);input[length]=128;
    view.setUint32(size-4,length*8);
    let h0=0x67452301,h1=0xefcdab89|0,h2=0x98badcfe|0,h3=0x10325476,h4=0xc3d2e1f0|0;
    const w=W;
    for(let p=0;p<size;p+=64){
      for(let i=0;i<16;i++)w[i]=view.getInt32(p+i*4);
      for(let i=16;i<80;i++){const x=w[i-3]^w[i-8]^w[i-14]^w[i-16];w[i]=(x<<1)|(x>>>31);}
      let a=h0,b=h1,c=h2,d=h3,e=h4,t=0;
      for(let i=0;i<20;i++){t=(((a<<5)|(a>>>27))+((b&c)|(~b&d))+e+0x5a827999+w[i])|0;e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t;}
      for(let i=20;i<40;i++){t=(((a<<5)|(a>>>27))+(b^c^d)+e+0x6ed9eba1+w[i])|0;e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t;}
      for(let i=40;i<60;i++){t=(((a<<5)|(a>>>27))+((b&c)|(b&d)|(c&d))+e+0x8f1bbcdc+w[i])|0;e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t;}
      for(let i=60;i<80;i++){t=(((a<<5)|(a>>>27))+(b^c^d)+e+0xca62c1d6+w[i])|0;e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=t;}
      h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;
      h4=(h4+e)|0;
    }
    return byte(h0,24)+byte(h0,16)+byte(h0,8)+byte(h0,0)+"-"+byte(h1,24)+byte(h1,16)+"-"+HEX[((h1>>>8)&15)|80]+byte(h1,0)+"-"+
      HEX[((h2>>>24)&63)|128]+byte(h2,16)+"-"+byte(h2,8)+byte(h2,0)+byte(h3,24)+byte(h3,16)+byte(h3,8)+byte(h3,0);
  }
  const q=s=>'"'+String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/[\u0000-\u001f]/g,c=>c==="\n"?"\\n":c==="\t"?"\\t":" ")+'"';
  function n(x){
    if(!Number.isFinite(x)||Math.abs(x)>2147.483647)throw Error("A coordinate or dimension exceeds KiCad's ±2147.483647 mm range.");
    return String(+x.toFixed(6));
  }
  const point=p=>n(p[0])+" "+n(p[1]);
  const angle=a=>globalThis.AtriumTranslatorPrecision?.angle(a) ?? n((-(a||0)%360+360)%360);
  const at=(p,a=0,exact)=>"(at "+point(p)+(a||exact&&exact!=="0"?" "+(exact??angle(a)):"")+")";
  const nameFor=(s,ext)=>(String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").trim()||"Board")+ext;
  const docFor=(p,d)=>typeof d==="string"?p.documents.find(v=>v.id===d):d;
  const symbolUuid=(doc,item)=>uid(doc.id+"\u001f"+item.id+"/symbol");
  const footprintId=name=>"Waffle:"+String(name||"Footprint").replace(/[:/\\]|[\x00-\x1f]/g,"_");
  function standardLayer(raw){
    if(!raw)return null;
    const m=/^(?:inner|mid(?:\s*layer)?)\s*(\d+)$/i.exec(raw);
    if(m && +m[1]>0 && +m[1]<=30)return "In"+(+m[1])+".Cu";
    const ml=/^mechanical\s*(\d+)$/i.exec(raw);if(ml && +ml[1]>=1 && +ml[1]<=9)return "User."+(+ml[1]);
    return {Top:"F.Cu",Bottom:"B.Cu",Silk:"F.SilkS","Bottom silk":"B.SilkS","Top paste":"F.Paste","Bottom paste":"B.Paste","Top mask":"F.Mask","Bottom mask":"B.Mask",Mechanical:"Dwgs.User","Drill guide":"Cmts.User","Drill drawing":"Cmts.User","Edge.Cuts":"Edge.Cuts"}[raw]||null;
  }
  // KiCad footprint field layers use the importer's technical-layer projection.
  const fieldLayers={"Mechanical 11":"Eco1.User","Mechanical 12":"Eco2.User","Mechanical 13":"F.Fab","Mechanical 14":"B.Fab",
    "Mechanical 15":"F.CrtYd","Mechanical 16":"B.CrtYd","Mechanical 17":"F.Adhes","Mechanical 18":"B.Adhes","Mechanical 19":"Margin"};
  const fieldLayer = layer => fieldLayers[layer] || standardLayer(layer);
  // Rings of a stored pour region (outline, then holes) as one KiCad filled_polygon ring:
  // each hole is bridged to the ring on its left by a zero-width slit, the way KiCad's own
  // fractured fills are written. Holes are merged left to right, so a bridge never crosses
  // a hole that is not merged yet.
  const signedArea=r=>{let s=0;const n=r.length;for(let i=0;i<n;i++){const a=r[i],b=r[i+1===n?0:i+1];s+=a[0]*b[1]-b[0]*a[1];}return s/2;};
  // The ring is a linked list (next[], one node per output vertex) and the edges that can cross a
  // horizontal ray sit in y bands, so each hole looks at the edges of one band instead of the whole
  // ring, and nothing is copied per hole. The bridge edge is the one the plain scan picks: the
  // crossing with the largest x at or left of the hole, the first in ring order on a tie (ord[]
  // keeps ring order: keys between neighbours, renumbered when a gap runs out).
  function fracture(rings){
    const list=rings.filter(r=>r.length>=3);if(!list.length)return null;
    const areas=list.map(signedArea);
    let o=0;for(let i=1;i<list.length;i++)if(Math.abs(areas[i])>Math.abs(areas[o]))o=i;
    const outer=list[o].slice();
    if(areas[o]<0)outer.reverse();
    const minX=r=>r.reduce((m,p)=>Math.min(m,p[0]),Infinity);
    const holes=list.filter((_,i)=>i!==o).map((r,i)=>{const h=r.slice();if(areas[i<o?i:i+1]>0)h.reverse();return h;}).sort((a,b)=>minX(a)-minX(b));
    if(!holes.length)return outer;
    let total=outer.length;for(const h of holes)total+=h.length+3;
    const pt=new Array(total),next=new Int32Array(total),ord=new Float64Array(total);let n=0;
    let y0=Infinity,y1=-Infinity;
    for(const r of [outer,...holes])for(const p of r){if(p[1]<y0)y0=p[1];if(p[1]>y1)y1=p[1];}
    const NB=Math.max(1,Math.min(65536,total>>3)),bh=(y1-y0)/NB||1,band=y=>{const b=Math.floor((y-y0)/bh);return b<0?0:b>=NB?NB-1:b;};
    const bands=new Array(NB);
    // The edge that starts at node k (k -> next[k]); horizontal edges never cross a ray.
    const index=k=>{const a=pt[k][1],b=pt[next[k]][1];if(a===b)return;for(let i=band(a<b?a:b),e=band(a<b?b:a);i<=e;i++)(bands[i]||(bands[i]=[])).push(k);};
    for(const p of outer){pt[n]=p;next[n]=n+1;ord[n]=n;n++;}
    next[n-1]=0;
    for(let k=0;k<n;k++)index(k);
    const renumber=()=>{let k=0,i=0;do{ord[k]=i++;k=next[k];}while(k!==0);};
    for(const h of holes){
      let mi=0;for(let i=1;i<h.length;i++)if(h[i][0]<h[mi][0]||h[i][0]===h[mi][0]&&h[i][1]<h[mi][1])mi=i;
      const M=h[mi],my=M[1],mx=M[0];let bx=0,bk=-1;
      for(const k of bands[band(my)]||[]){
        const p=pt[k],q=pt[next[k]];
        if((p[1]>my)===(q[1]>my))continue;
        const x=p[0]+(my-p[1])*(q[0]-p[0])/(q[1]-p[1]);
        if(x<=mx&&(bk<0||x>bx||x===bx&&ord[k]<ord[bk])){bx=x;bk=k;}
      }
      if(bk<0)continue;
      // bk -> I -> hole from M round to M -> I -> old next.
      const I=[bx,my],after=next[bk],m=h.length+3,start=n;
      pt[n++]=I;for(let i=mi;i<h.length;i++)pt[n++]=h[i];for(let i=0;i<mi;i++)pt[n++]=h[i];pt[n++]=M;pt[n++]=I;
      for(let k=start;k<n-1;k++)next[k]=k+1;
      next[n-1]=after;next[bk]=start;
      let lo=ord[bk],hi=after===0?lo+m+1:ord[after],step=(hi-lo)/(m+1);
      if(!(step>Math.abs(hi)*1e-14&&lo+m*step<hi)){renumber();lo=ord[bk];hi=after===0?lo+m+1:ord[after];step=(hi-lo)/(m+1);}
      for(let k=start,j=1;k<n;k++,j++)ord[k]=lo+j*step;
      // bk's edge now ends at I, on the old edge: its bands still cover it. The new edges join the index.
      for(let k=start;k<n;k++)index(k);
    }
    const ring=new Array(n);let k=0,i=0;do{ring[i++]=pt[k];k=next[k];}while(k!==0);
    ring.length=i;
    return ring;
  }
  const tech=["B.Adhes","F.Adhes","B.Paste","F.Paste","B.SilkS","F.SilkS","B.Mask","F.Mask","Dwgs.User","Cmts.User","Eco1.User","Eco2.User","Edge.Cuts","Margin","B.CrtYd","F.CrtYd","B.Fab","F.Fab","User.1","User.2","User.3","User.4","User.5","User.6","User.7","User.8","User.9"];
  const isCu=l=>l?.endsWith(".Cu");
  // ---- design rules: .kicad_pro net classes and board minimums, .kicad_dru custom rules ----
  // The KiCad custom rule language (public KiCad documentation): (rule name (condition "…")
  // (layer …) (constraint kind (min …) (opt …) (max …))). Later rules take precedence, so
  // Waffle's priority 1 (highest) is written last. Scopes KiCad cannot express exactly
  // (components, component classes, Altium queries) are left out with a note.
  const mm=v=>n(v)+"mm";
  function designRules(doc,project,netNames,base,observer){
    const R=globalThis.AtriumRules,notes=[],out={setup:"(pad_to_mask_clearance 0)",files:[],notes};
    if(!R?.effective)return out;
    let set;try{set=R.effective(doc,project);}catch(e){notes.push("Design rules could not be read ("+e.message+"); none were transferred.");return out;}
    if (observer?.usedFeatures) for (const r of set.list) if (r.enabled===false)
      observer.observed(doc,r,"Design rule","dropped","Disabled rules are omitted from the KiCad design.");
    const list=set.list.filter(r=>r.enabled!==false).map(r=>observer?.precision?.rule(doc,r)||r),classes=set.netClasses||{},pairs=set.diffPairs||[],pairClasses=set.diffPairClasses||{};
    const byType=t=>list.filter(r=>r.type===t).sort((a,b)=>a.priority-b.priority);
    const scopes=globalThis.AtriumDesignQueryRecord;
    const allOf=t=>byType(t).find(r=>scopes.isAll(r.scope)&&(!r.scope2||scopes.isAll(r.scope2)));
    const sq=s=>/['"\\]/.test(s)?null:"'"+s+"'";
    const pairNets=name=>{const p=pairs.find(x=>x.name===name);return p?[p.positive,p.negative]:[];};
    const netsCond=(nets,X)=>nets.length&&nets.every(sq)?"("+nets.map(v=>X+".NetName == "+sq(v)).join(" || ")+")":null;
    function condition(s,X){
      if(!s)return null;
      if(s.kind==="all")return "";
      if(s.kind==="net")return sq(s.value)?X+".NetName == "+sq(s.value):null;
      if(s.kind==="netclass")return /^all nets$/i.test(s.value)&&!classes[s.value]?X+".NetName != ''":sq(s.value)?X+".NetClass == "+sq(s.value):null;
      if(s.kind==="diffpair")return netsCond(pairNets(s.value),X);
      if(s.kind==="diffpairclass")return netsCond((pairClasses[s.value]||[]).flatMap(pairNets),X);
      return null;
    }
    const layerName=l=>{const m=/^Inner (\d+)$/.exec(l||"");return l==="Top"?"F.Cu":l==="Bottom"?"B.Cu":m?"In"+m[1]+".Cu":null;};
    const range=(lo,opt,hi)=>[lo!=null?"(min "+mm(lo)+")":"",opt!=null?"(opt "+mm(opt)+")":"",hi!=null?"(max "+mm(hi)+")":""].filter(Boolean).join(" ");
    const ZONE={direct:"solid",relief:"thermal_reliefs",none:"none"};
    function constraints(r){
      const c=[],add=(kind,body)=>{if(body)c.push("(constraint "+kind+" "+body+")");};
      switch(r.type){
        case "clearance":add("clearance",range(r.gap));if(r.objects&&Object.keys(r.objects).length)notes.push("Clearance object-kind matrices export as the rule's single clearance value. Add per-type rules (A.Type == 'Via' …) in KiCad if needed.");break;
        case "width":if(r.impedanceProfile)notes.push("Width rules linked to an impedance profile export their stored values; KiCad does not read Waffle profiles.");add("track_width",range(r.min,r.preferred,r.max));break;
        case "viaStyle":add("via_diameter",range(r.diameterMin,r.diameterPreferred,r.diameterMax));add("hole_size",range(r.holeMin,r.holePreferred,r.holeMax));break;
        case "holeSize":add("hole_size",range(r.min,null,r.max));break;
        case "holeToHole":add("hole_to_hole",range(r.gap));break;
        case "annularRing":add("annular_width",range(r.min));break;
        case "boardOutlineClearance":add("edge_clearance",range(r.gap));break;
        case "silkToSilk":add("silk_clearance",range(r.gap));break;
        case "diffPairsRouting":add("track_width",range(r.widthMin,r.widthPreferred,r.widthMax));add("diff_pair_gap",range(r.gapMin,r.gapPreferred,r.gapMax));
          if(r.maxUncoupled!=null)add("diff_pair_uncoupled",range(null,null,r.maxUncoupled));
          if(r.layers&&Object.keys(r.layers).length)notes.push("Per-layer differential pair widths and gaps export as the rule's own values.");break;
        case "length":add("length",range(r.min||null,null,r.max));break;
        case "matchedLengths":add("skew",range(null,null,r.tolerance));break;
        case "polygonConnect":{
          const z=ZONE[r.style];if(z)add("zone_connection",z);
          if(r.style!=="none"&&r.style!=="direct"){add("thermal_relief_gap",range(r.airGap));add("thermal_spoke_width",range(r.conductorWidth));}
          if(r.style==="auto")notes.push("Polygon Connect Style rules set to Auto (smart) export only their relief sizes; the zones carry their own connect style.");break;
        }
      }
      return c;
    }
    const SKIP=new Set(["short","unrouted","routingTopology","routingPriority","routingCorners","fanoutControl","solderMask","pasteMask"]);
    const rules=[],skipped=new Map(),seen=new Set();
    const skip=(r,why)=>{skipped.set(why,(skipped.get(why)||0)+1);observer?.observed(doc,r,"Design rule","dropped",why);};
    for(const r of [...list].sort((a,b)=>b.priority-a.priority)){
      if(SKIP.has(r.type)){
        if(observer){
          const boardWide=(r.type==="solderMask"||r.type==="pasteMask")&&r===allOf(r.type);
          observer.observed(doc,r,"Design rule",boardWide?"kept":"dropped",boardWide?"Board-wide mask setting.":"No corresponding scoped KiCad constraint.");
        }
        continue;
      }
      const noteAt=notes.length,body=constraints(r);
      if(!body.length){skip(r,"rule types KiCad has no constraint for ("+(R.types[r.type]?.title||r.type)+")");continue;}
      const viaHole=r.type==="holeSize"&&!r.scope.bindings?.length&&/^via(?=\s|$)/i.test(r.scope.source);
      const firstScope=viaHole?scopes.create(r.scope.source.replace(/^via/i,"object")):r.scope;
      const side1=scopes.toSelector(firstScope),side2=r.scope2&&scopes.toSelector(r.scope2);
      const layer=side1?.kind==="layer"?layerName(side1.value):null;
      if(side1?.kind==="layer"&&!layer){skip(r,"rules scoped to non-copper layers");continue;}
      const a=side1?.kind==="layer"?"":condition(side1,"A"),b=r.scope2?(side2?.kind==="layer"?null:condition(side2,"B")):"";
      if(a==null||b==null){skip(r,"rules scoped to components, component classes, queries or names with quotes");continue;}
      const via=viaHole||r.type==="viaStyle"&&body.some(x=>x.startsWith("(constraint hole_size"))?"A.Type == 'Via'":"";
      const cond=[a,b,via].filter(Boolean).join(" && ");
      let name=String(r.name||r.type).replace(/["\\\n]/g,"_");while(seen.has(name))name+="_";seen.add(name);
      observer?.observed(doc,r,"Design rule",noteAt===notes.length?"kept":"approximated",notes[noteAt]);
      rules.push("(rule "+q(name)+(cond?"\n  (condition "+q(cond)+")":"")+(layer?"\n  (layer "+q(layer)+")":"")+body.map(x=>"\n  "+x).join("")+")");
    }
    for(const [why,k] of skipped)notes.push(k+" design rule"+(k===1?"":"s")+" not transferred: "+why+".");
    // Net classes: each class's clearance, track width, via and pair sizes as the rules give them for one of its nets.
    // A probe net that belongs to the class (and to no net-specific rule) reads the class's values.
    // A KiCad routing class applies to every object on its net. A component, layer, bound
    // reference or two independently scoped clearance partners cannot set this class-wide size.
    const netRules = {...set,list:list.filter(r => {
      const first = scopes.toSelector(r.scope), second = r.scope2 && scopes.toSelector(r.scope2);
      return condition(first,"A") !== null && (!r.scope2 || condition(second,"B") !== null &&
        (first?.kind === "all" || second?.kind === "all"));
    })};
    const PROBE="\u0000kicad-class-probe",probe=new Map();
    const resolveFor=cls=>{
      if(!probe.has(cls)){
        const c={...classes};
        if(cls)c[cls]=[...(c[cls]||[]),PROBE];
        probe.set(cls,R.resolver(doc,{project,rules:{...netRules,netClasses:c}}));
      }
      return probe.get(cls);
    };
    const valueFor=(t,cls,key,fallback)=>{const v=resolveFor(cls)(t,{net:PROBE})?.[key];return Number.isFinite(v)&&v>0?v:fallback;};
    const viaFor=(resolve,net)=>{
      const {diameter,drill}=resolve.viaLimits(net);
      return {via_diameter:diameter??undefined,via_drill:drill??undefined};
    };
    const netResolve=resolveFor("");
    const sameVia=(a,b)=>a.via_diameter===b.via_diameter&&a.via_drill===b.via_drill;
    const classOf=(name,net)=>({name,nets:[],clearance:valueFor("clearance",net,"gap",.2),track_width:(()=>{const w=valueFor("width",net,"preferred",null);return w??valueFor("width",net,"min",.25);})(),
      ...viaFor(resolveFor(net),PROBE),
      diff_pair_width:valueFor("diffPairsRouting",net,"widthPreferred",null)??valueFor("diffPairsRouting",net,"widthMin",.2),diff_pair_gap:valueFor("diffPairsRouting",net,"gapPreferred",null)??valueFor("diffPairsRouting",net,"gapMin",.25),
      microvia_diameter:.3,microvia_drill:.1,wire_width:6,bus_width:12,line_style:0,pcb_color:"rgba(0, 0, 0, 0.000)",schematic_color:"rgba(0, 0, 0, 0.000)"});
    const def=classOf("Default",""),assigned=new Set(),patterns=[],kicadClasses=[def];
    for(const [name,members] of Object.entries(classes)){
      if(/^default$/i.test(name)||/^all nets$/i.test(name))continue;
      const nets=members.slice();
      const c=classOf(name,name);c.nets=nets.filter(v=>!assigned.has(v));
      const sizes=c.nets.map(net=>viaFor(netResolve,net));
      if(sizes.length&&sizes.every(size=>sameVia(size,sizes[0])))Object.assign(c,sizes[0]);
      else if(sizes.some(size=>!sameVia(size,c)))notes.push("Net-specific via preferences inside "+name+" are carried by the custom rules.");
      for(const v of c.nets){assigned.add(v);patterns.push({netclass:name,pattern:v});}
      kicadClasses.push(c);
    }
    // Nets outside every class whose net-specific rules give other routing sizes than the
    // Default class (KiCad imports, older rule sets) get a class per distinct set of sizes, so
    // KiCad's router and Waffle's importer see them as well as the .kicad_dru does.
    const KEYS=["clearance","track_width","via_diameter","via_drill"],own=new Map();
    const netValue=(t,net,key)=>{const v=netResolve(t,{net})?.[key];return Number.isFinite(v)&&v>0?v:null;};
    for(const net of netNames){
      if(assigned.has(net)||!sq(net))continue;
      const c={...def,clearance:netValue("clearance",net,"gap")??def.clearance,track_width:netValue("width",net,"preferred")??netValue("width",net,"min")??def.track_width,
        ...viaFor(netResolve,net)};
      if(KEYS.every(k=>c[k]===def[k]))continue;
      const key=KEYS.map(k=>c[k]).join("/");
      if(!own.has(key)){c.name="Waffle net rules "+(own.size+1);c.nets=[];own.set(key,c);kicadClasses.push(c);}
      own.get(key).nets.push(net);patterns.push({netclass:own.get(key).name,pattern:net});assigned.add(net);
    }
    if(own.size)notes.push(own.size+" net class"+(own.size===1?"":"es")+" named “Waffle net rules …” carry net-specific routing sizes ("+[...own.values()].reduce((s,c)=>s+c.nets.length,0)+" nets).");
    const rule0=t=>allOf(t);
    const minimum=(t,key,fallback)=>{const v=byType(t).map(r=>r[key]).filter(x=>Number.isFinite(x)&&x>0);return v.length?Math.min(...v):fallback;};
    const viaBounds=byType("viaStyle").filter(r=>r.diameterMin!=null||r.diameterMax!=null);
    const viaFloor=viaBounds.some(r=>scopes.isAll(r.scope))?Math.min(...viaBounds.map(r=>r.diameterMin??0)):0;
    const mask=rule0("solderMask")?.expansion??0,paste=rule0("pasteMask")?.expansion??0;
    out.setup="(pad_to_mask_clearance "+n(mask)+")"+(paste?" (pad_to_paste_clearance "+n(paste)+")":"");
    if(byType("solderMask").length>1||byType("pasteMask").length>1)notes.push("Scoped solder and paste mask expansion rules are not transferred; the board-wide values are.");
    const pro={board:{design_settings:{defaults:{},rules:{min_clearance:minimum("clearance","gap",0),min_track_width:minimum("width","min",0),
        min_via_diameter:viaFloor,min_through_hole_diameter:rule0("holeSize")?minimum("holeSize","min",0):0,min_hole_to_hole:rule0("holeToHole")?.gap??.25,
        min_copper_edge_clearance:rule0("boardOutlineClearance")?.gap??0,min_via_annular_width:rule0("annularRing")?.min??0,min_silk_clearance:rule0("silkToSilk")?.gap??0,
        solder_mask_clearance:mask},
      track_widths:[],via_dimensions:[],diff_pair_dimensions:[]}},
      meta:{filename:base+".kicad_pro",version:1},
      net_settings:{classes:kicadClasses,meta:{version:3},netclass_patterns:patterns},
      sheets:[],text_variables:{}};
    const dpNames=pairs.filter(p=>!/(?:[_\-.]?(?:P|N)|\+|-)$/i.test(p.positive)||!/(?:[_\-.]?(?:P|N)|\+|-)$/i.test(p.negative));
    if(pairs.length)notes.push(pairs.length+" differential pair"+(pairs.length===1?"":"s")+" exported as rules on their nets."+(dpNames.length?" KiCad pairs nets by name (…P/…N or …+/…−); rename "+dpNames.slice(0,3).map(p=>p.name).join(", ")+(dpNames.length>3?" …":"")+" for its router.":""));
    out.files.push({ext:".kicad_pro",content:JSON.stringify(pro,null,2)+"\n",pro});
    if(rules.length)out.files.push({ext:".kicad_dru",content:"(version 1)\n"+rules.join("\n")+"\n"});
    return out;
  }
  function exportBoard(project,requested,observer){
    const doc=docFor(project,requested);if(doc?.kind!=="pcb")throw Error("Choose a PCB layout to export.");
    const defs=new Map(project.library.map(d=>[d.id,d])),notes=new Map(),nets=new Set(),inner=new Set();
    const counts={footprints:0,components:0,standalonePads:0,pads:0,vias:0,segments:0,graphics:0,outlineEdges:0,zones:0,zoneFills:0,keepouts:0,teardrops:0,dimensions:0};
    const note=m=>notes.set(m,(notes.get(m)||0)+1), addNote=observer?observer.diagnostics(note):note;
    const markLayer=l=>{const mapped=standardLayer(l),m=/^In(\d+)\.Cu$/.exec(mapped||"");if(m)inner.add(+m[1]);};
    const padNet=(part,pad)=>part?.pinNets?.[pad.number]??pad.net??"";
    for(const item of doc.items){
      if(item.net)nets.add(item.net);[item.layer,item.fromLayer,item.toLayer].forEach(markLayer);
      const g=defs.get(item.def)?.footprint;
      for(const pad of g?.pads||[]){const net=padNet(item,pad);if(net)nets.add(net);[pad.layer,pad.fromLayer,pad.toLayer].forEach(markLayer);}
      for(const s of g?.shapes||[]){if(s.net)nets.add(s.net);markLayer(s.layer);}
      for(const labels of [item.boardLabels,item.hiddenBoardLabels])for(const label of labels||[])markLayer(label.layer);
    }
    for(const r of doc.pcbDrawing?.pours||[])if(r.net)nets.add(r.net);
    const names=["",...[...nets].sort()],netId=new Map(names.map((s,i)=>[s,i]));
    // A stored layer stack sets the copper count, plane layers, thickness and (setup (stackup)).
    const stack=doc.stackup!=null&&globalThis.AtriumStackup?.stored(doc)?AtriumStackup.kicad(doc,defs):null;
    const stackInner=stack?stack.copper.length-2:0,maxInner=inner.size?Math.max(...inner):0;
    const innerWanted=2*Math.ceil(Math.max(stackInner,maxInner)/2),innerCount=Math.min(30,innerWanted),useStack=!!stack?.stackup&&innerCount===stackInner;
    if(innerWanted>30)addNote("KiCad supports at most 32 copper layers: this board has "+(innerWanted+2)+"; In31.Cu and deeper were left out, so objects on Inner 31 and below are missing.");
    const layerList=[[0,"F.Cu","signal"]];
    for(let i=1;i<=innerCount;i++)layerList.push([i,"In"+i+".Cu",useStack?stack.copper[i][2]:"signal"]);
    layerList.push([31,"B.Cu","signal"],...tech.map((l,i)=>[32+i,l,"user"]));
    const rows=[],boardObjects=[];
    const schematicLinks=new Map(),boardLinkCounts=new Map();
    for(const sheet of project.documents.filter(d=>d.kind==="schematic")){
      for(const part of sheet.items.filter(i=>i.kind==="part"&&i.link)){
        schematicLinks.set(part.link,schematicLinks.has(part.link)?null:{sheet,part});
      }
    }
    for(const part of doc.items.filter(i=>i.kind==="part"&&i.link))boardLinkCounts.set(part.link,(boardLinkCounts.get(part.link)||0)+1);
    const stamp=k=>"(tstamp "+uid(doc.id+"\u001f"+k)+")";
    const omitLayer=(raw,what)=>{let mapped=standardLayer(raw);if(!mapped)addNote(what+" on unsupported layer "+String(raw||"(unset)")+" omitted.");return mapped;};
    function effect(size,align="",style) {
      const face=style?.font==="truetype" && style.family?" (face "+q(style.family)+")":"";
      const thickness=style?.width > 0?" (thickness "+n(style.width)+")":style?"":" (thickness "+n(Math.min(.15,size/6))+")";
      const spacing=style?.lineSpacing?" (line_spacing "+n(style.lineSpacing*3/5)+")":"";
      const font="(font"+face+" (size "+n(size)+" "+n(style?.fontWidth ?? size)+")"+thickness+
        (style?.bold?" bold":"")+(style?.italic?" italic":"")+spacing+")";
      return "(effects "+font+(align?" (justify "+align+")":"")+")";
    }
    function segments(points,width,layer,net,key){
      if(!isCu(layer)||!(width>0)){addNote("Tracks with an unresolved copper layer or zero width omitted.");return;}
      for(let i=1;i<points.length;i++){
        const a=point(points[i-1]),b=point(points[i]);if(a===b)continue;
        boardObjects.push("(segment (start "+a+") (end "+b+") (width "+n(width)+") (layer "+q(layer)+") (net "+(netId.get(net)||0)+") "+stamp(key+"/segment/"+i)+")");counts.segments++;
      }
    }
    function via(o,p,key){
      if(o.stackMode||o.padStack||o.backdrill||(o.ipc4761&&o.ipc4761!=="none"))addNote("Via stacks (per-layer lands, back-drill, IPC-4761) export as plain vias at the nominal diameter. Recreate them in KiCad.");
      if(!(o.diameter>0)||!(o.drill>0)||o.drill>=o.diameter){addNote("Vias without a valid drill and annular ring omitted.");return;}
      const hasSpan=o.fromLayer!=null||o.toLayer!=null;
      let a=hasSpan?standardLayer(o.fromLayer):"F.Cu",b=hasSpan?standardLayer(o.toLayer):"B.Cu";
      if(!isCu(a)||!isCu(b)||a===b){addNote("Vias with ambiguous layer spans omitted.");return;}
      const ord=l=>l==="F.Cu"?0:l==="B.Cu"?31:+l.slice(2,-3);
      if(ord(a)>ord(b))[a,b]=[b,a];const blind=a!=="F.Cu"||b!=="B.Cu";
      if(blind)addNote("Blind or buried via spans are preserved. Confirm via construction and drill technology.");
      boardObjects.push("(via"+(blind?" blind":"")+" "+at(p)+" (size "+n(o.diameter)+") (drill "+n(o.drill)+") (layers "+q(a)+" "+q(b)+") (net "+(netId.get(o.net)||0)+") "+stamp(key)+")");counts.vias++;
    }
    // ---- zones: polygon pours, cut-outs, net-assigned copper fills and teardrops ----
    const R=globalThis.AtriumRules,ruleOf=(()=>{try{return R?.resolver?R.resolver(doc,{project}):null;}catch{return null;}})();
    const rule=(type,o)=>{try{return ruleOf?.(type,o)||null;}catch{return null;}};
    const pours=doc.pcbDrawing?.pours||[];
    const ring=pts=>"(pts "+pts.map(p=>"(xy "+point(p)+")").join(" ")+")";
    const MAX_FILL_POINTS=400000;let fillPoints=0;
    function storedFill(region){
      try{
        const rings=AtriumPCBPours.contours(region).map(xy=>{const r=[];for(let i=0;i<xy.length;i+=2)r.push([xy[i],xy[i+1]]);return r;});
        const one=rings.length===1?rings[0]:fracture(rings);
        if(!one||one.length<3)return null;
        if((fillPoints+=one.length)>MAX_FILL_POINTS){addNote("Stored zone fills beyond "+MAX_FILL_POINTS+" vertices were left out; refill zones in KiCad (Edit › Fill All Zones, B).");return null;}
        return one;
      }catch{addNote("A stored pour fill could not be read and was left out; refill zones in KiCad.");return null;}
    }
    // KiCad fills higher priorities first; Waffle pours lower pour indices first. Pour indices
    // that are already 0, -1, -2 … (KiCad imports) map back exactly.
    const pourIndices=[...new Set(doc.items.filter(i=>i.kind==="polygon"&&!i.cutout).map(i=>+i.pourIndex||0))].sort((a,b)=>a-b);
    const exactPriority=pourIndices.every(v=>Number.isInteger(v)&&v<=0);
    const priorityOf=v=>exactPriority?-(+v||0):pourIndices.length-1-pourIndices.indexOf(+v||0);
    const topPriority=exactPriority?Math.max(0,...pourIndices.map(v=>-v))+1:pourIndices.length;
    function zone(o){
      const net=o.net||"",lay=o.layers.length>1?"(layers "+o.layers.map(q).join(" ")+")":"(layer "+q(o.layers[0])+")";
      const parts=["(zone (net "+(netId.get(net)||0)+") (net_name "+q(net)+") "+lay+" "+stamp(o.key)];
      if(o.name)parts.push("(name "+q(o.name)+")");
      parts.push("(hatch edge 0.5)");
      if(o.priority)parts.push("(priority "+o.priority+")");
      parts.push("(connect_pads"+(o.connect?" "+o.connect:"")+" (clearance "+n(o.clearance??0)+"))","(min_thickness "+n(o.minThickness??.25)+")");
      if(o.keepout)parts.push("(keepout "+o.keepout+")");
      const f=o.fill||{},filled=!o.keepout&&o.fills?.length;
      parts.push("(fill"+(filled?" yes":"")+(f.hatch?" (mode hatch)":"")+" (thermal_gap "+n(f.gap??.5)+") (thermal_bridge_width "+n(f.bridge??.5)+")"+
        (f.island!=null?" (island_removal_mode "+f.island+")"+(f.island===2?" (island_area_min "+n(f.islandArea)+")":""):"")+
        (f.hatch?" (hatch_thickness "+n(f.hatch.width)+") (hatch_gap "+n(f.hatch.gap)+") (hatch_orientation "+n(f.hatch.angle)+")":"")+")");
      parts.push("(polygon "+ring(o.outline)+")");
      if(filled)for(const [l,pts] of o.fills)parts.push("(filled_polygon (layer "+q(l)+") "+ring(pts)+")");
      boardObjects.push(parts.join(" ")+")");
    }
    const CONNECT={direct:"yes",none:"no"};
    function pour(o){
      const l=standardLayer(o.layer);
      if(!isCu(l)){addNote("Polygon pours on layers KiCad cannot map omitted.");return;}
      let pts=(o.points||[]).slice();if(pts.length>3&&point(pts[0])===point(pts.at(-1)))pts.pop();
      if(pts.length<3){addNote("Polygon pours with fewer than three vertices omitted.");return;}
      if(o.cutout){
        zone({key:o.id,layers:[l],outline:pts,name:o.name||"",clearance:0,keepout:"(tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)"});
        counts.keepouts++;addNote("Polygon pour cut-outs became KiCad rule areas that forbid copper pours.");return;
      }
      if(o.shelved)addNote("Shelved polygon pours export as unfilled zones. KiCad has no shelving; refill or delete them there.");
      const style=o.connectStyle||"relief";
      if(style==="auto")addNote("Pours with the Auto (smart) connect style use thermal reliefs in KiCad. Per-pad direct connections need a zone_connection rule or pad override there.");
      if(o.connectOverrides&&Object.keys(o.connectOverrides).length)addNote("Per-pad pour connect overrides are not transferred. Set pad zone connections in KiCad.");
      if((o.viaConnectStyle||"direct")!==(style==="none"?"none":"direct")&&style!=="auto")addNote("KiCad zones connect vias like pads: a separate via connect style was not transferred.");
      if(o.reliefEntries===2||o.reliefAngle===45)addNote("Two-spoke and 45° thermal reliefs export as KiCad's default four-spoke reliefs.");
      const clearance=o.clearance??rule("clearance",{net:o.net||"",layer:o.layer})?.gap??.2;
      const fills=pours.filter(r=>r.polygon===o.id&&r.layer===o.layer).map(storedFill).filter(Boolean).map(r=>[l,r]);
      const island=o.removeDeadCopper===false?1:o.islandAreaThreshold>0?2:0;
      const hatched=o.fillMode==="hatched";
      zone({key:o.id,layers:[l],net:o.net,name:o.name||"",priority:priorityOf(o.pourIndex),connect:CONNECT[style]||"",clearance,
        minThickness:Math.min(.25,Math.max(.01,o.minPrimLength||.25)),outline:pts,fills,
        fill:{gap:o.reliefAirGap??.254,bridge:o.reliefConductorWidth??.254,island,islandArea:o.islandAreaThreshold,
          hatch:hatched?{width:o.hatchWidth||.15,gap:Math.max(.01,(o.hatchPitch||.5)-(o.hatchWidth||.15)),angle:o.hatchAngle??45}:null}});
      counts.zones++;if(fills.length)counts.zoneFills+=fills.length;
      if(o.pourOverSameNet===false)addNote("Pours that do not pour over same-net copper export with KiCad's default, which does.");
    }
    // Net-assigned filled copper (fills, regions, teardrops) has no KiCad graphic with a net:
    // it becomes a top-priority solid zone whose stored fill is exactly the source copper.
    function copperZone(o,l,key){
      let pts=(o.points||[]).slice();if(pts.length>3&&point(pts[0])===point(pts.at(-1)))pts.pop();
      if(pts.length<3)return false;
      const teardrop=o.teardrop===true||/^teardrop:/.test(o.groupId||"");
      zone({key,layers:[l],net:o.net,name:teardrop?"Teardrop":"",priority:topPriority,connect:"yes",clearance:rule("clearance",{net:o.net,layer:o.layer})?.gap??.2,
        minThickness:.01,outline:pts,fills:[[l,pts]],fill:{island:1}});
      counts.zones++;counts.zoneFills++;
      if(teardrop){counts.teardrops++;addNote("Teardrops became small solid zones with their exact copper. KiCad 7+ can regenerate native teardrops (Edit › Edit Teardrops).");}
      else addNote("Net-assigned copper fills and regions became solid zones with their exact copper.");
      return true;
    }
    // Linear dimensions become KiCad orthogonal dimensions and aligned ones aligned dimensions
    // (live values, measured from their two points). Radial and angular dimensions have no
    // KiCad 6 equivalent and export as their drawn lines, arrows and text.
    function dimension(o,key){
      const d=o.dimension,D=globalThis.AtriumPCBDraw,l=standardLayer(o.layer);
      if(!D||!l)return null;
      if((d.type==="linear"||d.type==="aligned")&&!isCu(l)&&o.points?.length>=2){
        const g=D.dimensionGeometry(o),th=d.textHeight||1,units={in:0,mil:1,mm:2}[d.units]??3;
        const head="(dimension (type "+(d.type==="linear"?"orthogonal":"aligned")+") (layer "+q(l)+") "+stamp(key)+" (pts (xy "+point(o.points[0])+") (xy "+point(o.points[1])+"))";
        const height=d.type==="linear"?" (height "+n(d.offset||0)+") (orientation "+(d.dir==="v"?1:0)+")":" (height "+n(-(d.offset||0))+")";
        const label=g.text?"(gr_text "+q(g.label)+" "+at(g.text.at,g.text.angle)+" (layer "+q(l)+") "+stamp(key+"/text")+" (effects (font (size "+n(th)+" "+n(th)+") (thickness "+n(Math.min(.3,th/7))+"))))":"";
        counts.dimensions++;counts.graphics++;
        return [head+height+" "+label+" (format (units "+units+") (units_format 1) (precision "+(d.precision??(units===1?1:units===0?3:2))+")) (style (thickness "+n(o.width||.1)+") (arrow_length "+n(Math.max(th*.6,.3))+") (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5) keep_text_aligned))"];
      }
      if(d.export===false)return [];
      addNote("Radial and angular dimensions (and dimensions on copper) export as plain lines, arrows and text.");
      return D.dimensionPrimitives(o).flatMap((p,i)=>graphic({...p,dimension:undefined},null,key+"/dim/"+i));
    }
    function text(which,label,p,a,l,size,key,align="",hide=false,exact,style){
      const head=which==="board"?"gr_text":"fp_text "+which;
      return "("+head+" "+q(label)+" "+at(p,a,exact)+(style?.upright===false?" unlocked":"")+" (layer "+q(l)+")"+
        (hide?" hide":"")+" "+effect(size,align,style)+" "+stamp(key)+")";
    }
    function graphic(o,parent,key,exactText=false){
      // Keep-outs (pcb-draw.js): KiCad keep-out rule areas on their copper layer, or on all copper layers.
      if(!parent&&(o.keepout===true||/^keep-?out/i.test(o.layer||""))){
        const all=o.keepout!==true,outlines=globalThis.AtriumPCBDraw?.keepoutOutlines?.(o)||(o.fill&&o.points?.length>2?[o.points]:[]);
        if(!all&&!isCu(standardLayer(o.layer))){addNote("Keep-outs on layers KiCad cannot map omitted.");return [];}
        addNote(outlines.length?"Keepout objects became KiCad keep-out rule areas.":"Keepout tracks and arcs need pcb-draw.js to export as rule areas; omitted.");
        outlines.forEach((poly,i)=>{counts.graphics++;counts.keepouts++;zone({key:key+"/keepout/"+i,layers:[all?"*.Cu":standardLayer(o.layer)],outline:poly,clearance:0,
          keepout:"(tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints allowed)"});});
        return [];
      }
      if(!parent&&o.dimension){const out=dimension(o,key);if(out)return out;}
      // Footprint special strings become KiCad text variables, resolved per footprint.
      if(parent&&(o.kind==="text"||o.kind==="label")&&/^\.(?:designator|comment)$/i.test(o.text)){
        const ref=/^\.designator$/i.test(o.text);
        o={...o,text:o.sourceTextBox?String(parent[ref?"ref":"value"]||""):ref?"${REFERENCE}":"${VALUE}"};
      }
      const stem=parent?"fp_":"gr_",side=parent?.layer==="Bottom"?"B.":"F.";
      const l=o.layer?omitLayer(o.layer,"Graphic"):o.style==="package"?side+"Fab":side+"SilkS";
      if(!l)return [];
      if(isCu(l)&&o.net){
        if(o.points && !o.fill && o.width>0){
          let ps=o.closed?[...o.points,o.points[0]]:o.points;
          if(parent){ps=ps.map(p=>A.world(p,parent));addNote("Net-assigned footprint lines became board segments and move independently of their footprint.");}
          segments(ps,o.width,l,o.net,key);
        }else if(!parent&&o.fill&&copperZone(o,l,key)){}
        else addNote("Net-assigned copper fills or graphics without a native routed equivalent omitted.");
        return [];
      }
      const common="(layer "+q(l)+") (width "+n(o.width??.12)+")";
      if((o.kind==="text"||o.kind==="label")&&globalThis.AtriumPCBText){
        // Stroke text stays editable KiCad text; TrueType, barcode, framed and
        // knockout text become filled polygons identical to the Gerber regions.
        o=AtriumPCBText.withLetters(o,doc);
        const textLayer={layer:parent?o.layer:o.layer||"Silk"};
        const k=exactText?{mode:"poly",...AtriumPCBText.toPrimitives(o,textLayer)}:AtriumPCBText.kicad(o,textLayer);
        if(k.mode==="poly"){
          const out=[];
          k.regions.forEach((r,i)=>{counts.graphics++;out.push("("+stem+"poly (pts "+r.map(p=>"(xy "+point(p)+")").join(" ")+") (layer "+q(l)+") (width 0) (fill solid) "+stamp(key+"/poly/"+i)+")");});
          k.strokes.forEach((st,i)=>{for(let j=1;j<st.points.length;j++){counts.graphics++;out.push("("+stem+"line (start "+point(st.points[j-1])+") (end "+point(st.points[j])+") (layer "+q(l)+") (width "+n(st.width)+") "+stamp(key+"/stroke/"+i+"/"+j)+")");}});
          return out;
        }
        if(k.note)addNote(k.note);
        const a=(parent?.angle||0)+(o.angle||0);
        const justify=(o.justify==null?(o.align==="center"?"":o.align==="right"?"right bottom":"left bottom")+(k.mirror?" mirror":""):k.justify).trim();
        counts.graphics++;
        return ["("+(parent?"fp_text user":"gr_text")+" "+q(o.text)+" "+at([o.x,o.y],a,!parent?observer?.precision?.angle(o):undefined)+" (layer "+q(l)+") (effects (font (size "+n(k.size)+" "+n(k.fontWidth ?? k.size)+") (thickness "+n(o.width>0?o.width:Math.min(.15,k.size/6))+")"+(k.italic?" italic":"")+")"+(justify?" (justify "+justify+")":"")+") "+stamp(key)+")"];
      }
      if(o.kind==="text"||o.kind==="label"){
        const a=(parent?.angle||0)+(o.angle||0),align=o.align==="center"?"":o.align==="right"?"right bottom":"left bottom";counts.graphics++;
        return [text(parent?"user":"board",o.text,[o.x,o.y],a,l,o.size||.75,key,align,false,!parent?observer?.precision?.angle(o):undefined)];
      }
      if(o.kind==="circle"){
        counts.graphics++;return ["("+stem+"circle (center "+point([o.x,o.y])+") (end "+point([o.x+o.r,o.y])+") "+common+" (fill "+(o.fill?"solid":"none")+") "+stamp(key)+")"];
      }
      let ps=o.points||[];
      const loop=ps.length>2&&point(ps[0])===point(ps.at(-1));
      if(loop)ps=ps.slice(0,-1);
      if((o.fill||o.closed||loop)&&ps.length>=3){
        counts.graphics++;return ["("+stem+"poly (pts "+ps.map(p=>"(xy "+point(p)+")").join(" ")+") "+common+" (fill "+(o.fill?"solid":"none")+") "+stamp(key)+")"];
      }
      const lines=[];
      for(let i=1;i<ps.length;i++){
        if(point(ps[i-1])===point(ps[i]))continue;
        lines.push("("+stem+"line (start "+point(ps[i-1])+") (end "+point(ps[i])+") "+common+" "+stamp(key+"/line/"+i)+")");counts.graphics++;
      }
      return lines;
    }
    function pad(o,parent,p,key,source){
      const w=o.w,h=o.h,d=o.drill||0,net=padNet(parent,o);
      if(!(w>0&&h>0)||d<0||d>Math.min(w,h)+.000001){addNote("Pads with inconsistent copper or drill dimensions omitted.");return "";}
      const npth=d>0&&(o.plated===false||o.layer==="Mechanical"||(!net&&!o.number&&Math.abs(w-d)<1e-6&&Math.abs(h-d)<1e-6));
      if(npth&&net){addNote("Mechanical holes with a net omitted. Resolve their plating in the source design.");return "";}
      const layer=o.layer||(d>0?"Multi":parent.layer||"Top"),l=standardLayer(layer);
      const type=npth?"np_thru_hole":d>0?"thru_hole":"smd";
      if(type==="smd" && (!isCu(l)||layer==="Multi")){addNote("Surface pads on unresolved copper layers omitted.");return "";}
      const surf=l?.startsWith("F.")?"F.":l?.startsWith("B.")?"B.":"";
      const layers=d>0?["*.Cu","*.Mask"]:surf?[l,surf+"Paste",surf+"Mask"]:[l];
      if(d>0 && !npth && layer!=="Multi")addNote("Drilled pads use through plating on all copper layers. Confirm their source pad stacks.");
      const s=(o.shape||"round").toLowerCase();
      let shape,extra="",size=[w,h];
      if(["rect","rectangle"].includes(s))shape="rect";
      else if(["rounded","roundedrect","roundrect"].includes(s)){shape="roundrect";extra=" (roundrect_rratio "+n(A.padCornerRatio(o))+")";}
      else if(["round","circle","oval","ellipse"].includes(s)&&Math.abs(w-h)<.000001)shape="circle";
      else if(s==="custom"&&Array.isArray(o.poly)&&o.poly.length>2){
        // Custom polygon pads (footprint editor, KiCad and EasyEDA imports): one polygon primitive
        // around a minimal anchor, so the copper is exactly the stored outline.
        shape="custom";const anchor=Math.max(d,.01);size=[anchor,anchor];
        extra=" (options (clearance outline) (anchor circle)) (primitives (gr_poly (pts "+o.poly.map(v=>"(xy "+point(v)+")").join(" ")+") (width 0) (fill yes)))";
      }
      else if(["round","circle","oval","ellipse","octagon","octagonal"].includes(s)){
        // KiCad's oval is a capsule. Waffle displays an ellipse. A custom
        // polygon preserves its actual envelope and avoids changing clearance.
        shape="custom";let vertices;
        if(s.startsWith("oct")){
          const t=Math.min(w,h)*.25,x=w/2,y=h/2;vertices=[[-x+t,-y],[x-t,-y],[x,-y+t],[x,y-t],[x-t,y],[-x+t,y],[-x,y-t],[-x,-y+t]];
        }else{vertices=Array.from({length:64},(_,i)=>[w/2*Math.cos(i*Math.PI/32),h/2*Math.sin(i*Math.PI/32)]);addNote("Elliptical pads with unequal axes use 64-sided custom outlines.");}
        const anchor=Math.max(d,Math.min(w,h)*.25);size=[anchor,anchor];
        extra=" (options (clearance outline) (anchor circle)) (primitives (gr_poly (pts "+vertices.map(v=>"(xy "+point(v)+")").join(" ")+") (width 0) (fill yes)))";
      }else{addNote("Unsupported pad shape "+s+" omitted.");return "";}
      counts.pads++;
      return "(pad "+q(npth?"":o.number??"")+" "+type+" "+shape+" "+at(p,(parent.angle||0)+(o.angle||0),source?observer?.precision?.angle(source):undefined)+" (size "+point(size)+")"+(d?" (drill "+n(d)+")":"")+" (layers "+layers.map(q).join(" ")+")"+(net?" (net "+netId.get(net)+" "+q(net)+")":"")+extra+" "+stamp(key)+")";
    }
    const usedRefs=new Set(doc.items.filter(i=>i.kind==="part").map(i=>i.ref.toUpperCase()));
    let freeIndex=0;
    function footprint(item,g,wrapper=false,source){
      const raw=item.layer||"Top";
      if(!["Top","Bottom"].includes(raw)){addNote("Footprints with unresolved component side omitted.");return;}
      const side=raw==="Top"?"F.":"B.";
      const lines=["(footprint "+q(footprintId(g.name))+" (layer "+q(side+"Cu")+") "+stamp(item.id+"/footprint"),"  "+at([item.x,item.y],item.angle,wrapper?undefined:observer?.precision?.angle(item))];
      const linked=schematicLinks.get(item.link);
      if(linked&&boardLinkCounts.get(item.link)===1)lines.push("  (path "+q("/"+symbolUuid(linked.sheet,linked.part))+")");
      else if(!wrapper&&schematicLinks.has(item.link))addNote("Ambiguous schematic links omitted from footprint paths.");
      const box=A.bounds(A.symbolPoints(g))||[0,0,0,0],localRef=item.refAt||[(box[0]+box[2])/2,box[1]-.7],localValue=item.valueAt||[(box[0]+box[2])/2,box[3]+1];
      if(wrapper)lines.push("  (attr exclude_from_bom exclude_from_pos_files)");
      const appearance=globalThis.AtriumPCBAppearance, native=appearance?.sourceLabels(doc,item);
      const placer=globalThis.AtriumDesignators,placed=item.designator && placer?.label(item,defs.get(item.def));
      const fields=new Map([...(item.boardLabels||[]),...(item.hiddenBoardLabels||[])]
        .filter(a=>typeof a.upright==="boolean").map(a=>[a.field,a]));
      function componentField(field, which, local, layer, size, hide, show) {
        const row=fields.get(field), sourceLayer=row && fieldLayer(row.layer);
        const key=item.id+"/"+field, value=item[field]||"";
        if(!sourceLayer)return text(which,value,local,0,layer,size,key,"",hide);
        const anchor=appearance.textJustification(row);
        const [vertical,horizontal]=anchor==="center"?[]:anchor.split("-");
        const justify=[horizontal==="center"?"":horizontal,vertical==="middle"?"":vertical,appearance.textMirrored(row,row.layer)?"mirror":""].filter(Boolean).join(" ");
        const hidden=wrapper || show===false || (field==="ref" && !!placed) ||
          (item.hiddenBoardLabels?.includes(row) && show!==true);
        return text(which,value,row.at,(item.angle||0)+row.angle,sourceLayer,row.size,key,justify,hidden,undefined,row);
      }
      lines.push("  "+componentField("ref","reference",localRef,side+"SilkS",.68,wrapper||item.showRef===false||!!native||!!placed,item.showRef),
        "  "+componentField("value","value",localValue,side+"Fab",.8,true,item.showValue));
      if(placed)for(const token of graphic(placer.textShape(placed,item),item,item.id+"/placed-ref",true))lines.push("  "+token);
      for(const [i,a] of (native||[]).entries()){
        if((fields.get(a.field)===a && fieldLayer(a.layer)) || !appearance.annotationVisible(item,a))continue;
        for(const token of graphic(appearance.annotationText(item,a),item,item.id+"/annotation/"+i))lines.push("  "+token);
      }
      const shapes=observer?observer.items(doc,g.shapes,()=>lines.length+boardObjects.length,"Footprint graphic",item.id):g.shapes;
      let shapeIndex=0;
      for(const s of shapes){
        const key=item.id+"/shape/"+shapeIndex++;
        for(const token of graphic(s,item,key))lines.push("  "+token);
      }
      // A standalone pad's synthetic footprint is only an output container. Let
      // the outer item observe the source pad and its diagnostic exactly once.
      const pads=observer&&!wrapper?observer.items(doc,g.pads,()=>counts.pads+counts.vias,"Footprint pad",item.id):g.pads;
      let padIndex=0;
      for(const p of pads){
        const i=padIndex++;
        if(p.kind==="via"){via({...p,net:padNet(item,p)},A.world([p.x,p.y],item),item.id+"/via/"+i);addNote("Footprint-owned vias became board vias.");continue;}
        const token=pad(p,item,[p.x,p.y],item.id+"/pad/"+i,source || (!item.angle ? p : undefined));
        if(!token && wrapper)return;
        if(token)lines.push("  "+token);
      }
      lines.push(")");rows.push(lines.join("\n  "));counts.footprints++;if(wrapper)counts.standalonePads++;else counts.components++;
    }
    const exact=doc.outline?.length>=3&&globalThis.AtriumBoardShape?AtriumBoardShape.fresh(doc):null;
    if(exact){
      // Exact board shape: Edge.Cuts lines, arcs (start/mid/end) and circles, cutouts included.
      const S=AtriumBoardShape;
      [exact.contour,...(exact.cutouts||[])].forEach((c,ci)=>c.forEach((g,i)=>{
        const tail=' (layer "Edge.Cuts") (width 0.05) '+stamp("outline/"+ci+"/"+i)+")";
        if(g.kind==="arc"){
          const w=S.sweep(g);
          if(Math.abs(w)>359.999)boardObjects.push("(gr_circle (center "+point(g.c)+") (end "+point(S.pointAt(g.c,g.r,g.start))+")"+tail);
          else boardObjects.push("(gr_arc (start "+point(S.head(g))+") (mid "+point(S.pointAt(g.c,g.r,g.start+w/2))+") (end "+point(S.tail(g))+")"+tail);
        }else{const a=point(g.a),b=point(g.b);if(a===b)return;boardObjects.push("(gr_line (start "+a+") (end "+b+")"+tail);}
        counts.outlineEdges++;
      }));
    }else if(doc.outline?.length>=3){
      const pts=doc.outline.slice();if(point(pts[0])===point(pts.at(-1)))pts.pop();
      if(A.validOutline && !A.validOutline(pts))addNote("The perimeter is invalid. Its editable edges require repair in KiCad.");
      for(let i=0;i<pts.length;i++){
        const a=point(pts[i]),b=point(pts[(i+1)%pts.length]);if(a===b)continue;
        boardObjects.push("(gr_line (start "+a+") (end "+b+') (layer "Edge.Cuts") (width 0.05) '+stamp("outline/"+i)+")");counts.outlineEdges++;
      }
    }else addNote("No closed board outline available.");
    for(const o of observer?observer.items(doc,doc.items,()=>rows.length+boardObjects.length):doc.items){
      if(o.kind==="part"){
        const def=defs.get(o.def),g=observer?.precision?.footprint(doc,def) || def?.footprint;if(g)footprint(o,g);else addNote("Components without a footprint omitted.");
      }else if(o.kind==="pad"){
        let ref;do{ref="ATR_PAD"+(++freeIndex);}while(usedRefs.has(ref));usedRefs.add(ref);
        footprint({id:o.id,ref,value:"Board pad",x:o.x,y:o.y,angle:0,layer:o.layer==="Bottom"?"Bottom":"Top",pinNets:{}},
          {name:"BoardPad",shapes:[],pads:[{...o,x:0,y:0}]},true,o);
      }else if(o.kind==="via")via(o,[o.x,o.y],o.id);
      else if(o.kind==="track")segments(o.points,o.width,omitLayer(o.layer,"Track"),o.net,o.id);
      else if(o.kind==="graphic"||o.kind==="label")boardObjects.push(...graphic(o,null,o.id));
      else if(o.kind==="polygon")pour(o);
      else addNote("Unsupported board item "+o.kind+" omitted.");
    }
    // Stored pour fills that belong to no polygon (read-only Altium pours) become zones
    // around their outer ring, with their copper as the stored fill.
    pours.forEach((r,i)=>{
      if(r.polygon!=null&&doc.items.some(x=>x.id===r.polygon))return;
      const l=standardLayer(r.layer);if(!isCu(l))return;
      let rings;try{rings=AtriumPCBPours.contours(r).map(xy=>{const o=[];for(let k=0;k<xy.length;k+=2)o.push([xy[k],xy[k+1]]);return o;});}catch{return;}
      const sizes=rings.map(x=>Math.abs(signedArea(x)));let big=0;for(let k=1;k<rings.length;k++)if(sizes[k]>sizes[big])big=k;
      const outer=rings[big]||[],f=storedFill(r);
      if(outer.length<3||!f)return;
      zone({key:"pour/"+i,layers:[l],net:r.net,name:"Imported fill",priority:0,connect:"yes",clearance:rule("clearance",{net:r.net||"",layer:r.layer})?.gap??.2,outline:outer,fills:[[l,f]],fill:{island:1}});
      counts.zones++;counts.zoneFills++;addNote("Read-only imported pour fills became zones around their outer edge, filled with the imported copper. A KiCad refill pours them again from that outline.");
    });
    const base=observer?.fileStem?.(doc)||nameFor(doc.name,"");
    const design=designRules(doc,project,names.slice(1),base,observer);
    for(const m of design.notes)addNote(m);
    const defaultThickness=(()=>{try{const t=globalThis.AtriumStackup?.thickness?.(doc,defs);return t>0?t:1.6;}catch{return 1.6;}})();
    const header=['(kicad_pcb (version 20211014) (generator waffle)','  (general (thickness '+n(stack?stack.thickness:doc.thickness??defaultThickness)+'))','  (paper "A4")','  (title_block (title '+q(doc.name)+') (comment 1 "Editable Waffle interchange. Verify stackup and design rules before fabrication."))','  (layers',
      ...layerList.map(([id,l,t])=>"    ("+id+" "+q(l)+" "+t+")"),"  )",...(useStack?["  (setup",...stack.stackup.map(l=>"    "+l),"    "+design.setup,"  )"]:["  (setup "+design.setup+")"]),
      ...names.map((name,i)=>"  (net "+i+" "+q(name)+")")];
    const content=[...header,...rows.map(row=>"  "+row),...boardObjects.map(row=>"  "+row),")",""].join("\n");
    const librarySources=new Set(doc.items.filter(i=>i.kind==="part").map(i=>defs.get(i.def)?.sourceName).filter(s=>s&&s!==doc.sourceName));
    const libraryNotes=(project.importNotes||[]).filter(note=>librarySources.has(note.split(" — ")[0]));
    const diagnostics=[...new Set([...(doc.notes||[]),...libraryNotes])];
    if(design.files.length)diagnostics.push("Design rules travel in "+design.files.map(f=>f.ext).join(" and ")+" next to the board (net classes, board minimums and custom rules). Save them with the same name in the same folder, or use the KiCad project (.zip) export.");
    else diagnostics.push("Waffle design rules are not transferred to KiCad. Recreate and verify them before fabrication.");
    if(doc.sourceRules?.length)diagnostics.push("The source design's original rule records ("+doc.sourceRules.length+") are not transferred; only Waffle's rules are.");
    diagnostics.push("Mask and paste openings use the board-wide expansion"+(useStack?"":"; the physical stackup and dielectric properties are not represented")+". Per-pad overrides are not transferred.");
    if(stack&&!useStack)diagnostics.push("The layer stack was not written because KiCad needs an even number of copper layers matching the board objects.");
    if(!stack&&doc.thickness==null)diagnostics.push("No layer stack is saved for this board, so the KiCad board uses the default stack thickness of "+n(defaultThickness)+" mm shown in the Layer Stack Manager. Save the stack there to export its layers.");
    if(!useStack&&innerCount>Math.max(maxInner,stackInner))diagnostics.push("An unused inner copper layer was included to make an even KiCad layer stack.");
    for(const [msg,count] of notes)diagnostics.push(msg+(count>1?" ("+count+" instances)":""));
    return {name:base+".kicad_pcb",content,diagnostics,counts,files:design.files.map(f=>({name:base+f.ext,content:f.content}))};
  }
  function exportBOM(project,requested){
    const variants=globalThis.AtriumVariants;
    const view=variants?.forOutput(project) || project;
    const d=docFor(view,view===project ? requested : requested?.id || requested);
    if(!d)throw Error("Choose a schematic or board to export.");
    project=view;
    const defs=new Map(project.library.map(d=>[d.id,d]));
    const appliedParams=variants?.appliedParameters(project,defs);
    const {parameters,fieldOf,fallbackParameters}=A.partParameters;
    const read=appliedParams || parameters;
    function csv(value){
      // Keep spreadsheets from evaluating text as a formula, but leave plain numbers such as -5 alone (as bom.js csvCell).
      let s=String(value??"");if(/^[=+@\-\t\r]/.test(s)&&!/^[+-]?\d+(\.\d+)?$/.test(s))s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    }
    const counterparts=new Map();
    for(const other of project.documents.filter(doc=>doc.kind!==d.kind)){
      for(const item of other.items.filter(i=>i.kind==="part"&&i.link)){
        counterparts.set(item.link,counterparts.has(item.link)?null:item);
      }
    }
    const parts=d.items.filter(i=>i.kind==="part").sort((a,b)=>a.ref.localeCompare(b.ref,"en",{numeric:true}));
    const cells=[["Designator","Value","Footprint","Manufacturer","Manufacturer part number"]];
    for(const i of parts){
      const def=defs.get(i.def),mate=counterparts.get(i.link),other=mate && defs.get(mate.def);
      const fallback=mate && read(mate,other);
      const pars=appliedParams ? appliedParams(i,def,fallback) : fallbackParameters(parameters(i,def),fallback);
      const fields=fieldOf(pars);
      cells.push([i.ref,i.value,def?.footprint?.name||def?.footprintName||other?.footprint?.name||"",fields.manufacturer,fields.mpn||pars["PART NUMBER"]||""]);
    }
    return {name:nameFor(d.name,"-BOM.csv"),content:cells.map(row=>row.map(csv).join(",")).join("\r\n")+"\r\n",diagnostics:["Lists placed components on the selected document, including do-not-populate placements."],counts:{components:parts.length}};
  }
  // A whole KiCad project: the board (or the first board) with its .kicad_pro and .kicad_dru,
  // and every schematic sheet. The root sheet is named after the project, as KiCad expects.
  // Returns {name, files:[{name,content}], diagnostics, counts, bytes?} (bytes: a store-only zip
  // when AtriumZip is loaded).
  // KiCad resolves a child placement by the root file UUID followed by the sheet-symbol
  // UUIDs along its path. An individual document still opens by itself without this context.
  function sheetHierarchy(sheets, root, name) {
    const documents = new Map(sheets.map(d=>[d.id,d])), contexts = new Map();
    let page = 1;
    function visit(doc, path, ancestors) {
      let c = contexts.get(doc.id);
      if (!c) { c = {name,paths:[],children:new Map()}; contexts.set(doc.id,c); }
      c.paths.push(path);
      for (const symbol of doc.items) if (symbol.kind === "sheetsymbol" && documents.has(symbol.sheet) && !ancestors.has(symbol.sheet)) {
        const child = documents.get(symbol.sheet);
        if (!c.children.has(symbol.id)) c.children.set(symbol.id,[]);
        c.children.get(symbol.id).push({path,page:++page});
        if (page>10000) throw Error("The schematic hierarchy exceeds 10,000 sheet instances.");
        visit(child,path+"/"+uid(doc.id+"\u001f"+symbol.id),new Set([...ancestors,child.id]));
      }
    }
    if (root) visit(root,"/"+uid(root.id+"/sheet"),new Set([root.id]));
    return contexts;
  }
  function exportProject(project,requested,observer){
    const pick=docFor(project,requested),board=pick?.kind==="pcb"?pick:project.documents.find(d=>d.kind==="pcb"&&d.items.length)||project.documents.find(d=>d.kind==="pcb");
    const sheets=project.documents.filter(d=>d.kind==="schematic"&&(d.items.length||d.sheet?.infinite===true));
    if(!board&&!sheets.length)throw Error("This project has no board or schematic to export.");
    const base=nameFor(board?.name||project.name||"Project",""),files=[],diagnostics=[],counts={};
    if(board){
      const r=exportBoard(project,board,observer);observer?.written(board,base+".kicad_pcb",r);files.push({name:base+".kicad_pcb",content:r.content},...r.files.map(f=>({name:base+f.name.slice(nameFor(board.name,"").length),content:f.content})));
      diagnostics.push(...r.diagnostics.map(m=>board.name+": "+m));Object.assign(counts,r.counts);
      if(!r.files.some(f=>f.name.endsWith(".kicad_pro")))files.push({name:base+".kicad_pro",content:JSON.stringify({meta:{filename:base+".kicad_pro",version:1},sheets:[],text_variables:{}},null,2)+"\n"});
    }else files.push({name:base+".kicad_pro",content:JSON.stringify({meta:{filename:base+".kicad_pro",version:1},sheets:[],text_variables:{}},null,2)+"\n"});
    const S=globalThis.AtriumKiCadSchematic,children=new Set(sheets.flatMap(d=>d.items.filter(i=>i.kind==="sheetsymbol"&&i.sheet).map(i=>i.sheet)));
    const root=sheets.find(d=>!children.has(d.id)), hierarchy=sheetHierarchy(sheets,root,base);
    if(sheets.length&&!S)diagnostics.push("Schematic sheets were not exported: the KiCad schematic writer is not loaded.");
    counts.sheets=0;
    const evaluated=globalThis.AtriumCalculationRecords?.frozenProject(project),fidelity=[];
    for(const sheet of S?sheets:[]){
      const r=S.exportSheet(project,sheet,observer,hierarchy.get(sheet.id),evaluated),name=sheet===root?base+".kicad_sch":r.name;
      if(files.some(f=>f.name===name)){diagnostics.push(sheet.name+": a sheet with the same file name was already exported; skipped.");continue;}
      if (r.fidelity) fidelity.push(...r.fidelity.map(f=>({documentId:sheet.id,...f})));
      observer?.written(sheet,name,r);files.push({name,content:r.content});counts.sheets++;
      diagnostics.push(...r.diagnostics.filter(m=>!/^Only the selected sheet is exported/.test(m)).map(m=>sheet.name+": "+m));
    }
    const out={name:base+"-kicad.zip",files,diagnostics:[...new Set(diagnostics)],counts};
    if(!observer?.looseFiles&&globalThis.AtriumZip?.create)out.bytes=AtriumZip.create(files.map(f=>({name:base+"/"+f.name,data:f.content})));
    if (fidelity.length) out.fidelity=fidelity;
    return out;
  }
  return {exportBoard,exportBOM,exportProject,designRules,fracture,uid,quote:q,nameFor,symbolUuid,footprintId};
})();
