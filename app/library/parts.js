"use strict";
globalThis.AtriumParts = (() => {
  const A=Atrium, u=1.27, scale=p=>p.map(v=>v*u);
  const path=(points,style="body",closed=false,fill=false)=>({kind:"path",points,style,closed,fill});
  const trace=(p,style,closed,fill)=>path(p.map(scale),style,closed,fill);
  const pin=(number,name,x,y)=>({number:String(number),name,x:x*u,y:y*u});
  const pad=(number,x,y,w,h,drill=0,shape="roundrect")=>({number:String(number),x,y,w,h,drill,shape,angle:0});
  const rect=(x,y,w,h,style,fill=false)=>path([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],style,true,fill);
  const passive=(name)=>({name,shapes:[rect(-0.55,-0.42,1.1,0.84,"package",true)],pads:[pad(1,-0.8,0,0.9,0.95),pad(2,0.8,0,0.9,0.95)]});
  // Symbols follow Altium's Miscellaneous Devices and Connectors libraries: black pin
  // lines, navy device artwork, and maroon outlines over pale yellow body fill.
  const lead=p=>trace(p,"pin");
  // Pin numbers and names that the symbol shows, drawn along each pin line.
  function annotate(symbol,names=false){
    const pins=[];
    for(const p of symbol.pins){
      const line=symbol.shapes.find(s=>s.style==="pin"&&s.points.length===2&&A.same(s.points[0],[p.x,p.y]));
      if(!line)continue;
      const [end,start]=line.points,len=Math.hypot(end[0]-start[0],end[1]-start[1]);
      pins.push({start,end,direction:[(end[0]-start[0])/len,(end[1]-start[1])/len],name:names?p.name:"",number:p.number});
    }
    return {pins};
  }
  const resistor={id:"std-r",name:"Resistor",category:"Resistors",prefix:"R",value:"10 kΩ",
    symbol:{pins:[pin(1,"1",-4,0),pin(2,"2",4,0)],shapes:[
      lead([[-4,0],[-2,0]]),trace([[-2,0],[-1.67,-0.8],[-1,0.8],[-0.33,-0.8],[0.33,0.8],[1,-0.8],[1.67,0.8],[2,0]]),lead([[4,0],[2,0]])]},
    footprint:passive("R_0603")};
  const capacitor={id:"std-c",name:"Capacitor",category:"Capacitors",prefix:"C",value:"100 nF",
    symbol:{pins:[pin(1,"1",-4,0),pin(2,"2",4,0)],shapes:[lead([[-4,0],[-0.4,0]]),lead([[4,0],[0.4,0]]),
      {...trace([[-0.4,-1.6],[-0.4,1.6]]),width:.38},{...trace([[0.4,-1.6],[0.4,1.6]]),width:.38}]},
    footprint:passive("C_0603")};
  const opampSymbol={pins:[pin(1,"OUT",6,0),pin(2,"V−",0,6),pin(3,"+IN",-6,-2),pin(4,"−IN",-6,2),pin(5,"V+",0,-6)],shapes:[
      trace([[-4,-4.5],[4,0],[-4,4.5]],"body",true,true),lead([[-6,-2],[-4,-2]]),lead([[-6,2],[-4,2]]),lead([[6,0],[4,0]]),lead([[0,-6],[0,-2.25]]),lead([[0,6],[0,2.25]]),
      trace([[-3.35,-2],[-2.2,-2]]),trace([[-2.77,-2.57],[-2.77,-1.43]]),trace([[-3.35,2],[-2.2,2]])]};
  const opamp={id:"std-opamp",name:"Operational amplifier",category:"Amplifiers",prefix:"U",value:"Op amp",
    symbol:opampSymbol,schDrawing:annotate(opampSymbol),
    footprint:{name:"SOT-23-5",shapes:[rect(-0.8,-1.45,1.6,2.9,"package",true),{kind:"circle",x:-0.3,y:-1.02,r:0.13,style:"silk",fill:true}],
      pads:[pad(1,-1.25,-0.95,1.05,.62),pad(2,-1.25,0,1.05,.62),pad(3,-1.25,.95,1.05,.62),pad(4,1.25,.95,1.05,.62),pad(5,1.25,-.95,1.05,.62)]}};
  function header(n) {
    const right=n===3, pinX=right?6:-6, edge=right?1.7:-1.7;
    const symbol={pins:[],shapes:[trace([[-1.7,-n*2],[1.7,-n*2],[1.7,n*2],[-1.7,n*2]],"body",true,true)]};
    const footprint={name:"PinHeader_1×0"+n+"_2.54mm",shapes:[rect(-1.49,-n*1.27,2.98,n*2.54,"silk")],pads:[]};
    for(let i=0;i<n;i++){
      const y=(i-(n-1)/2)*4;
      symbol.pins.push(pin(i+1,String(i+1),pinX,y));
      // Altium's header contact: a short stroke into the body from the pin edge.
      symbol.shapes.push(lead([[pinX,y],[edge,y]]),trace([[edge,y],[edge*.25,y]]));
      footprint.pads.push(pad(i+1,0,(i-(n-1)/2)*2.54,1.75,1.75,1,i===0?"rect":"round"));
    }
    return {id:"std-j"+n,name:n+"-pin header",category:"Connectors",prefix:"J",value:"1 × 0"+n,symbol,schDrawing:annotate(symbol),footprint};
  }
  const tp={id:"std-tp",name:"Test point",category:"Test points",prefix:"TP",value:"Test point",
    symbol:{pins:[pin(1,"1",0,2)],shapes:[lead([[0,2],[0,-.8]]),{kind:"circle",x:0,y:-1.8,r:.8,style:"body"}]},
    footprint:{name:"TestPoint_1.5mm",shapes:[],pads:[pad(1,0,0,1.5,1.5,0,"round")]}};
  // Courtyards, so the sample passes its own DRC (Missing Courtyard) and component clearance has an
  // outline to use: pads and body + 0.25 mm on a 0.05 mm grid, stored as drc-fixes.js's courtyard fix
  // stores it (footprint.courtyard [x0,y0,x1,y1] plus a Mechanical 15 outline).
  function courtyard(fp){
    if(!fp?.pads?.length||fp.courtyard)return fp;
    let b=[Infinity,Infinity,-Infinity,-Infinity];const add=([x,y])=>{b=[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)];};
    for(const p of fp.pads)for(const [sx,sy] of [[-1,-1],[1,1]])add([p.x+sx*p.w/2,p.y+sy*p.h/2]);
    for(const sh of fp.shapes||[])if(sh.points)sh.points.forEach(add);else if(sh.kind==="circle"){add([sh.x-sh.r,sh.y-sh.r]);add([sh.x+sh.r,sh.y+sh.r]);}
    const r=v=>Math.round(v*1e4)/1e4,dn=v=>r(Math.floor((v-.25)*20+1e-9)/20),up=v=>r(Math.ceil((v+.25)*20-1e-9)/20),c=[dn(b[0]),dn(b[1]),up(b[2]),up(b[3])];
    fp.courtyard=c;fp.shapes=[...(fp.shapes||[]),{kind:"path",points:[[c[0],c[1]],[c[2],c[1]],[c[2],c[3]],[c[0],c[3]]],closed:true,layer:"Mechanical 15",style:"courtyard",width:.05}];
    return fp;
  }
  const catalogue=[resistor,capacitor,opamp,header(3),header(2),tp].map(d=>(courtyard(d.footprint),d)).concat(globalThis.AtriumNetTies?[AtriumNetTies.starter()]:[]);
  function example() {
    const proj=A.project("Sensor interface",catalogue.filter(d=>!d.footprint?.netTie)), [sch,pcb]=proj.documents;
    sch.name="Analog front end";pcb.name="Sensor board";
    pcb.outline=[[1.5,0],[34.5,0],[36,1.5],[36,20.5],[34.5,22],[1.5,22],[0,20.5],[0,1.5]];
    // Altium-style sheet: signal flows left to right on a 100 mil grid, supplies rise
    // to power ports above and returns drop to ground ports below.
    const components=[
      ["J1","std-j3","Input",62,62,0,3.8,11,0],["R1","std-r","10 kΩ",82,62,0,9.9,11,0],
      ["C1","std-c","10 nF",94,70,90,13.3,14.3,90],["U1","std-opamp","Buffer",112,64,0,18.5,11.6,0],
      ["R2","std-r","100 Ω",130,64,0,25.2,9,0],["J2","std-j2","Output",150,66,0,32.2,10.3,0],["C2","std-c","100 nF",124,52,90,19.4,6.8,0]];
    // Designator above and Comment below each horizontal part; beside vertical ones.
    const fields={"std-r":[[-2,-1.5],[-2,3]],"std-c":[[2.6,-.5],[2.6,2.3]],"std-opamp":[[3,-4.6],[2.6,5.8]],
      "std-j3":[[-1.7,-7],[-1.7,8.2]],"std-j2":[[-1.7,-5],[-1.7,6.2]]};
    for(const [ref,d,value,sx,sy,sa,bx,by,ba] of components){
      const base={kind:"part",ref,def:d,value,link:"link-"+ref,pinNets:{}};
      const placed={...base,id:"s-"+ref,x:sx*u,y:sy*u,angle:sa};
      const [refAt,valueAt]=fields[d].map(p=>scale(A.rotate(p,-sa)).map(v=>Math.round(v*1e6)/1e6));
      Object.assign(placed,{refAt,valueAt});
      sch.items.push(placed);
      pcb.items.push({...base,id:"b-"+ref,x:bx,y:by,angle:ba});
    }
    const wire=(...pts)=>sch.items.push({id:A.id(),kind:"wire",points:pts.map(scale)});
    function label(text,x,y,at="above"){
      const item={id:A.id(),kind:"netlabel",text,x:x*u,y:y*u,at};
      if(text==="GND"||text==="VDD")item.schPaint={type:"power",style:text==="GND"?4:2,direction:at==="below"?3:1,
        showName:true,family:"Times New Roman",size:2.032,ink:"#800000"};
      sch.items.push(item);
    }
    const junction=(x,y)=>sch.items.push({id:A.id(),kind:"junction",x:x*u,y:y*u});
    label("VDD",68,58);label("GND",68,66,"below");
    wire([68,62],[78,62]);label("VIN",70,62);
    wire([86,62],[106,62]);wire([94,62],[94,66]);junction(94,62);label("FILTER",96,62);
    label("GND",94,74,"below");
    wire([112,58],[112,48],[124,48]);label("VDD",112,48);label("GND",124,56,"below");
    label("GND",112,70,"below");
    wire([118,64],[126,64]);wire([106,66],[104,66],[104,80],[122,80],[122,64]);junction(122,64);label("BUF",106,80);
    wire([134,64],[144,64]);label("VOUT",136,64);
    label("GND",144,68,"below");
    const defs=new Map(proj.library.map(d=>[d.id,d])), nets=A.connectivity(sch,defs);
    for(const i of pcb.items){for(const pin of A.pins(i,defs.get(i.def),"pcb"))i.pinNets[pin.number]=nets.byPin.get("s-"+i.ref+"/"+pin.number)||"";}
    const term=(ref,num)=>A.pins(pcb.items.find(i=>i.ref===ref),defs.get(components.find(c=>c[0]===ref)[1]),"pcb").find(p=>p.number===String(num)).at;
    function track(net,layer,...pts){pcb.items.push({id:A.id(),kind:"track",layer,net,width:net==="GND"||net==="VDD"?0.48:.32,points:pts});}
    function via(net,x,y){pcb.items.push({id:A.id(),kind:"via",x,y,diameter:.84,drill:.4,net,layer:"Multi"});return [x,y];}
    track("VIN","Top",term("J1",2),term("R1",1));
    track("FILTER","Top",term("R1",2),[12,11],[13.3,12.3],term("C1",1));
    track("FILTER","Top",term("C1",1),[15.3,13.5],[16.25,12.55],term("U1",3));
    track("BUF","Top",term("U1",1),[16.2,10.65],[15.2,9.65],[15.2,8.2],[16.2,7.2],[17,7.2],[19.2,9.4],[21,9.4],[21.4,9],[24.4,9]);
    track("BUF","Top",term("U1",4),[21.6,12.55],[22.6,11.55],[22.6,10.1],[23.7,9],[24.4,9]);
    track("VOUT","Top",term("R2",2),[29.6,9],[29.63,9.03],term("J2",1));
    track("VDD","Bottom",term("J1",1),[7.2,8.46],[9.16,6.5],[14.5,6.5],[15.9,5.1],via("VDD",19.7,5.1));
    track("VDD","Top",[19.7,5.1],[18.6,6.2],term("C2",1));
    track("VDD","Bottom",[19.7,5.1],[19.7,8.95],via("VDD",21.4,10.65));
    track("VDD","Top",[21.4,10.65],term("U1",5));
    track("GND","Top",term("U1",2),via("GND",16.1,11.6));
    track("GND","Top",term("C2",2),via("GND",21.55,6.8));
    track("GND","Top",term("C1",2),via("GND",13.3,16.2));
    track("GND","Bottom",term("J1",3),[6.3,13.54],[8.96,16.2],[13.3,16.2],[17.9,11.6],[16.1,11.6]);
    track("GND","Bottom",[17.9,11.6],[19.5,13.2],[22.9,13.2],[23.3,12.8],[23.3,8.1],[22,6.8],[21.55,6.8]);
    track("GND","Bottom",[13.3,16.2],[26.2,16.2],[30.83,11.57],term("J2",2));
    for(const p of [[2.6,2.6],[33.4,2.6],[2.6,19.4],[33.4,19.4]])pcb.items.push({id:A.id(),kind:"pad",number:"",x:p[0],y:p[1],w:2.4,h:2.4,drill:2.4,shape:"round",layer:"Mechanical",net:""});
    function silk(text,x,y,size){pcb.items.push({id:A.id(),kind:"label",text,x,y,size,layer:"Silk"});}
    silk("SENSOR INTERFACE",5.6,3.05,1.05);silk("AFE  /  REV A",5.65,4.6,.56);
    silk("ANALOG IN",2.15,16.8,.53);silk("OUT",31.35,14.45,.65);
    silk("WAFFLE",27.1,19.65,.74);
    return proj;
  }
  // Search form of a name: case, width and the lookalikes people type in ASCII (U+2212 minus and
  // dashes -> "-", micro -> "u", ohm -> "ohm", times -> "x"). Stored names are never changed.
  const fold=s=>String(s??"").normalize("NFKC").toLowerCase().replace(/[‐-―−﹣－]/g,"-").replace(/[µμ]/g,"u").replace(/[Ωω]/g,"ohm").replace(/ohms/g,"ohm").replace(/×/g,"x").replace(/±/g,"+-");
  return {catalogue,example,fold};
})();
