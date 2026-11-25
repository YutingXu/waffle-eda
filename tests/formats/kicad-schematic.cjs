"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
for(const module of ["model","parts","kicad-export","kicad-schematic"])require(require("../support/app-source-paths.cjs").appFile(module+".js"));
const A=Atrium,K=AtriumKiCadSchematic;
const child=(node,key)=>node.find(i=>Array.isArray(i)&&i[0]===key);
const children=(node,key)=>node.filter(i=>Array.isArray(i)&&i[0]===key);
const key=p=>p.map(v=>Math.round(v*10000)).join(",");
const at=node=>child(node,"at").slice(1).map(Number);
function parse(source){
  const root=[],stack=[root];
  for(const token of source.match(/\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g)){
    if(token==="("){const node=[];stack.at(-1).push(node);stack.push(node);}
    else if(token===")"){assert.ok(stack.length>1);stack.pop();}
    else stack.at(-1).push(token.startsWith('"')?JSON.parse(token):token);
  }
  assert.equal(stack.length,1);assert.equal(root.length,1);return root[0];
}
function independent(expected,out,file){
  const script=`
from kiutils.schematic import Schematic
from math import sin,cos,radians
import sys,json
s=Schematic.from_file(sys.argv[1],encoding='utf-8')
expected=json.load(open(sys.argv[2]))
defs={d.libId:d for d in s.libSymbols}
assert len(s.schematicSymbols)==expected['counts']['symbols']
assert len(s.junctions)==expected['counts']['junctions']
assert len(s.labels)==expected['counts']['labels']
assert sum(g.type=='wire' for g in s.graphicalItems if hasattr(g,'type'))==expected['counts']['wires']
for symbol in s.schematicSymbols:
 props={p.key:p.value for p in symbol.properties}
 source=expected['symbols'][symbol.uuid]
 assert (props['Reference'],props['Value'])==(source['ref'],source['value'])
 theta=radians(symbol.position.angle or 0)
 pins=defs[symbol.libId].units[0].pins
 assert len(pins)==len(source['pins'])
 for pin,position in zip(pins,source['pins']):
  assert str(pin.number)==position[0]
  x=pin.position.X*cos(theta)-pin.position.Y*sin(theta)+symbol.position.X
  y=-pin.position.X*sin(theta)-pin.position.Y*cos(theta)+symbol.position.Y
  assert max(abs(x-position[1]),abs(y-position[2]))<0.000101,(pin,position,x,y)
 assert symbol.instances[0].paths[0].sheetInstancePath=='/'+s.uuid
print("PASS independent KiUtils parse and pin placement:",len(s.schematicSymbols),"symbols,",len(s.labels),"labels")
`;
  const check=file+".json";fs.writeFileSync(check,JSON.stringify(expected));
  const p=cp.spawnSync("python3",["-c",script,file,check],{encoding:"utf8",env:{...process.env,PYTHONPATH:process.env.KIUTILS_PYTHONPATH,PYTHONDONTWRITEBYTECODE:"1"}});
  assert.equal(p.status,0,p.stderr||p.error?.message);process.stdout.write(p.stdout);
}
function verify(project,doc,dir){
  const defMap=new Map(project.library.map(d=>[d.id,d])),net=A.connectivity(doc,defMap);
  const before=JSON.stringify(project),out=K.exportSheet(project,doc);
  assert.equal(before,JSON.stringify(project));assert.equal(K.exportSheet(project,doc.id).content,out.content);
  const root=parse(out.content);assert.equal(root[0],"kicad_sch");
  const symbolDefs=new Map(children(child(root,"lib_symbols"),"symbol").map(d=>[d[1],d]));
  const placements=children(root,"symbol"),byUuid=new Map(placements.map(i=>[child(i,"uuid")[1],i]));
  const parents=new Map(),find=x=>{while(parents.has(x))x=parents.get(x);return x;},join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parents.set(a,b);};
  for(const wire of children(root,"wire")){
    const xy=children(child(wire,"pts"),"xy").map(p=>key(p.slice(1).map(Number)));
    assert.equal(xy.length,2);join(...xy);
  }
  const labelAt=new Map();
  for(const label of children(root,"label")){
    const p=key(at(label).slice(0,2));
    if(labelAt.has(label[1]))join(labelAt.get(label[1]),p);
    labelAt.set(label[1],p);
  }
  const actual=[],wanted=[],expected={counts:out.counts,symbols:{}};
  const wantWorld=p=>p.map((v,i)=>Math.round((v+out.offset[i])*10000)/10000);
  for(const item of doc.items.filter(i=>i.kind==="part"&&defMap.get(i.def)?.symbol)){
    const uuid=AtriumKiCad.symbolUuid(doc,item),instance=byUuid.get(uuid);assert.ok(instance);
    const id=child(instance,"lib_id")[1],lib=symbolDefs.get(id);assert.ok(lib);
    const props=Object.fromEntries(children(instance,"property").map(([_,k,v])=>[k,v]));assert.equal(props.Reference,item.ref);assert.equal(props.Value,item.value);
    const [x,y,angle]=at(instance),a=angle*Math.PI/180;
    assert.ok(x>=0&&y>=0);assert.ok([0,90,180,270].includes(angle));
    const unit=child(lib,"symbol"),pins=children(unit,"pin"),source=A.pins(item,defMap.get(item.def),"schematic").filter(p=>p.number);
    assert.equal(source.length,pins.length);assert.equal(source.length,children(instance,"pin").length);
    const expectPins=[];
    for(const [n,pin] of pins.entries()){
      const [u,v]=at(pin),p=key([x+u*Math.cos(a)-v*Math.sin(a),y-u*Math.sin(a)-v*Math.cos(a)]);
      assert.equal(child(pin,"number")[1],source[n].number);
      const world=wantWorld(source[n].at);assert.equal(p,key(world),"world pin "+item.ref+"."+source[n].number);
      const pinId=item.id+"/"+source[n].number;
      wanted.push(net.byPin.get(pinId)||"isolated/"+pinId);actual.push(find(p));
      if(labelAt.has(wanted.at(-1)))assert.equal(find(p),find(labelAt.get(wanted.at(-1))),"named pin net "+pinId);
      expectPins.push([source[n].number,...world]);
    }
    expected.symbols[uuid]={ref:item.ref,value:item.value,pins:expectPins};
    const proj=child(child(instance,"instances"),"project"),instancePath=child(proj,"path");
    assert.equal(instancePath[1],"/"+child(root,"uuid")[1]);assert.equal(child(instancePath,"reference")[1],item.ref);
  }
  for(let i=0;i<wanted.length;i++)for(let j=i+1;j<wanted.length;j++)assert.equal(actual[i]===actual[j],wanted[i]===wanted[j],"pin-net partition "+i+" "+j);
  const ids=[...out.content.matchAll(/\(uuid ([0-9a-f-]+)\)/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  const file=path.join(dir,out.name);fs.writeFileSync(file,out.content);
  if(process.env.KIUTILS_PYTHONPATH)independent(expected,out,file);
  if(process.env.KICAD_CLI){
    const result=cp.spawnSync(process.env.KICAD_CLI,["sch","export","netlist","--format","kicadxml","-o",file+".xml",file],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr||result.error?.message);assert.ok(fs.statSync(file+".xml").size>0);
  }
  return {out,root};
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"atrium-sch-"));
try{
  const demo=AtriumParts.example(),doc=demo.documents[0],{out}=verify(demo,doc,dir);
  assert.deepEqual(out.counts,{symbols:7,pins:18,wires:17,junctions:2,labels:11,graphics:0,librarySymbols:5});
  const board=parse(AtriumKiCad.exportBoard(demo,demo.documents[1]).content);
  const footprints=children(board,"footprint");
  for(const item of doc.items.filter(i=>i.kind==="part")){
    const footprint=footprints.find(f=>children(f,"fp_text").some(t=>t[1]==="reference"&&t[2]===item.ref));
    assert.equal(child(footprint,"path")[1],"/"+AtriumKiCad.symbolUuid(doc,item));
  }
  const p=A.project('Rotated "project"',AtriumParts.catalogue),s=p.documents[0];s.name="Geometry";
  const add=(id,kind,props)=>s.items.push({id,kind,...props});
  for(const [j,angle] of [0,90,180,270,37].entries()){
    const part={id:"p"+j,kind:"part",def:"std-c",ref:"C"+(j+1),value:"test",angle,x:-40+j*10.000067,y:-17.000037,refAt:[-2,-3],showValue:false};
    s.items.push(part);
    const pin=A.pins(part,p.library[1],"schematic")[1];
    add("w"+j,"wire",{points:[pin.at,[pin.at[0]+1,pin.at[1]+2]],net:"N_"+j});
  }
  add("h","wire",{points:[[-50,-5],[-20,-5]],net:"H"});add("v","wire",{points:[[-35,-8],[-35,0]],net:"V"});
  add("branch","wire",{points:[[-22,-5],[-22,-2]]});add("l","netlabel",{x:-40,y:-5,text:"H"});
  add("caption","label",{x:-46,y:-6,text:'Quote " and slash \\',size:1.6});
  add("art","graphic",{points:[[-48,-8],[-46,-8],[-47,-7]],closed:true,fill:true});
  s.notes=["Unsupported hierarchical sheet entry from source."];
  const extra=verify(p,s,dir);
  assert.ok(extra.out.diagnostics.some(s=>/Non-cardinal/.test(s)));assert.ok(extra.out.diagnostics.includes(s.notes[0]));
  assert.equal(extra.out.counts.junctions,1);assert.equal(extra.out.counts.labels,8);
  const x=extra.out.offset[0]-35,y=extra.out.offset[1]-5;
  assert.ok(children(extra.root,"wire").every(w=>children(child(w,"pts"),"xy").every(xy=>key(xy.slice(1).map(Number))!==key([x,y]))),"bare crossing stays separate");
  assert.equal(children(extra.root,"text")[0][1],'Quote " and slash \\');
  const fx=process.argv.indexOf("--fixtures");
  if(fx>=0){
    global.CFB=require("../../app/vendor/cfb.min.js");require("../../app/formats/sch-import.js");require("../../app/formats/io.js");
    const name="Level.Shifter.SchDoc",real=AtriumIO.read(name,fs.readFileSync(path.join(process.argv[fx+1],name)));
    const result=verify(real,real.documents[0],dir).out;
    assert.deepEqual([result.counts.symbols,result.counts.pins,result.counts.wires,result.counts.junctions,result.counts.labels],[5,20,34,7,13]);
    console.log("PASS real Level.Shifter.SchDoc, 20 electrical endpoints and complete pin-net partitions");
  }
}finally{fs.rmSync(dir,{force:true,recursive:true});}
console.log("PASS editable KiCad sheets, cross-file identities, ordinary and baked rotations, wire splits, named nets and bare crossings");
