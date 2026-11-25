"use strict";
// STEP component models (step-import.js): the bounded reader (size, entity, nesting and
// reference caps), tessellation of planes, cylinders, faceted B-reps, B-spline and circle
// edges, colours, units and assemblies, checked by enclosed volume and bounding box; and
// Waffle's own STEP export read back.
const assert=require("node:assert/strict");
for(const m of ["model","parts","pcb-appearance","pcb-pours","stackup","board-shape","rigid-flex","zip","fab-outputs","step-export","step-import"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumSTEP,SI=AtriumSTEPImport,A=Atrium;
const log=(...a)=>(globalThis.console?.log||globalThis.print||(()=>{}))(...a);
const near=(a,b,e,m)=>assert.ok(Math.abs(a-b)<=e,(m?m+": ":"")+a+" vs "+b);
const vol=r=>{let v=0;for(const p of r.parts){const P=p.positions,I=p.indices;for(let i=0;i<I.length;i+=3){const a=I[i]*3,b=I[i+1]*3,c=I[i+2]*3;
  v+=(P[a]*(P[b+1]*P[c+2]-P[b+2]*P[c+1])-P[a+1]*(P[b]*P[c+2]-P[b+2]*P[c])+P[a+2]*(P[b]*P[c+1]-P[b+1]*P[c]))/6;}}return v;};
const wrap=(data,unit="(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")=>"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1="+unit+";\n"+data+"\nENDSEC;\nEND-ISO-10303-21;\n";

// 1. Round holes in an unplated substrate, measured independently of the exporter.
for(const authored of [false,true]){
  const doc=A.sheet("pcb","Plate");doc.outline=[[0,0],[40,0],[40,20],[0,20]];
  for(let k=0;k<4;k++)doc.items.push({id:"v"+k,kind:"via",x:5+k*10,y:10,diameter:2,drill:1.2});
  if(authored){
    doc.stackup=AtriumStackup.build(["Signal","Signal"]);
    doc.stackup.layers.find(l=>l.type==="Dielectric").thickness=1.8;
    doc.stackup.layers.find(l=>l.key==="Top").thickness=.07;
    doc.stackup.layers.find(l=>l.type==="Solder Mask").thickness=.015;
  }
  // Derived rigid stack: 1.51 dielectric + 0.07 copper + 0.02032 mask.
  // Explicit stack: 1.8 dielectric + 0.105 copper + 0.02516 mask.
  const height=authored?1.8:1.51, finished=authored?1.93016:1.60032;
  const p={name:"Plate",documents:[doc],library:[]}, before=S.model(p,doc);
  near(AtriumStackup.thickness(doc,new Map()),finished,1e-9,"finished stack thickness");
  const r=SI.tessellate(S.export(p,doc,{deterministic:true}));log(SI.summary(r));
  assert.equal(r.stats.solids,1);assert.equal(r.stats.approximated,0);assert.ok(r.stats.cylindrical>=8,"hole walls are cylinders");
  const want=(40*20-4*Math.PI*.36)*height;
  near(vol(r),want,want*2e-3,"volume of the dielectric plate with holes");
  assert.deepEqual(r.bbox.map(v=>+v.toFixed(4)),[0,-20,0,40,0,height]);
  assert.deepEqual(S.model(p,doc,{copper:true}).board.bodies,before.board.bodies,
    "including copper leaves the substrate envelope unchanged");
}
// 2. A faceted cube (FACETED_BREP, POLY_LOOP) in inches, red.
{
  const v=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const F=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  let d="",n=10;const id=()=>++n,pts=v.map(p=>{const i=id();d+="#"+i+"=CARTESIAN_POINT('',("+p.join(".,")+".));\n";return i;});
  const faces=F.map(f=>{const l=id();d+="#"+l+"=POLY_LOOP('',("+f.map(k=>"#"+pts[k]).join(",")+"));\n";const b=id();d+="#"+b+"=FACE_OUTER_BOUND('',#"+l+",.T.);\n";const fc=id();d+="#"+fc+"=FACE('',(#"+b+"));\n";return fc;});
  const sh=id();d+="#"+sh+"=CLOSED_SHELL('',("+faces.map(x=>"#"+x).join(",")+"));\n";const so=id();d+="#"+so+"=FACETED_BREP('cube',#"+sh+");\n";
  d+="#"+id()+"=SHAPE_REPRESENTATION('',(#"+so+"),#2);\n#2=GEOMETRIC_REPRESENTATION_CONTEXT(3);\n";
  d+="#"+id()+"=STYLED_ITEM('',(#5),#"+so+");\n#5=PRESENTATION_STYLE_ASSIGNMENT((#6));\n#6=SURFACE_STYLE_USAGE(.BOTH.,#7);\n#7=SURFACE_SIDE_STYLE('',(#8));\n#8=SURFACE_STYLE_FILL_AREA(#9);\n#9=FILL_AREA_STYLE('',(#3));\n#3=FILL_AREA_STYLE_COLOUR('',#4);\n#4=COLOUR_RGB('',1.,0.,0.);";
  const r=SI.tessellate(wrap(d,"(CONVERSION_BASED_UNIT('INCH',#99)LENGTH_UNIT()NAMED_UNIT(*));\n#99=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#98);\n#98=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))"));
  assert.equal(r.stats.faceted,6);near(vol(r),25.4**3,1e-3,"inch cube volume");assert.deepEqual(r.parts[0].color,[1,0,0]);
}
// 3. A cylinder (two full circles, no seam) between two planar discs, and a B-spline edge.
function cylinderModel(r=2,h=5){
  return wrap(`#10=CARTESIAN_POINT('',(0.,0.,0.));#11=DIRECTION('',(0.,0.,1.));#12=DIRECTION('',(1.,0.,0.));#13=AXIS2_PLACEMENT_3D('',#10,#11,#12);
#14=CARTESIAN_POINT('',(0.,0.,${h}.));#15=AXIS2_PLACEMENT_3D('',#14,#11,#12);#16=DIRECTION('',(0.,0.,-1.));#17=AXIS2_PLACEMENT_3D('',#10,#16,#12);
#20=CIRCLE('',#13,${r}.);#21=CIRCLE('',#15,${r}.);#22=CARTESIAN_POINT('',(${r}.,0.,0.));#23=CARTESIAN_POINT('',(${r}.,0.,${h}.));
#24=VERTEX_POINT('',#22);#25=VERTEX_POINT('',#23);#26=EDGE_CURVE('',#24,#24,#20,.T.);#27=EDGE_CURVE('',#25,#25,#21,.T.);
#30=ORIENTED_EDGE('',*,*,#26,.F.);#31=EDGE_LOOP('',(#30));#32=FACE_OUTER_BOUND('',#31,.T.);#33=PLANE('',#17);#34=ADVANCED_FACE('',(#32),#33,.T.);
#40=ORIENTED_EDGE('',*,*,#27,.T.);#41=EDGE_LOOP('',(#40));#42=FACE_OUTER_BOUND('',#41,.T.);#43=PLANE('',#15);#44=ADVANCED_FACE('',(#42),#43,.T.);
#50=ORIENTED_EDGE('',*,*,#26,.T.);#51=EDGE_LOOP('',(#50));#52=FACE_BOUND('',#51,.T.);#53=ORIENTED_EDGE('',*,*,#27,.F.);#54=EDGE_LOOP('',(#53));#55=FACE_BOUND('',#54,.T.);
#56=CYLINDRICAL_SURFACE('',#13,${r}.);#57=ADVANCED_FACE('',(#52,#55),#56,.T.);
#60=CLOSED_SHELL('',(#34,#44,#57));#61=MANIFOLD_SOLID_BREP('pin',#60);#62=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#61,#13),#2);#2=GEOMETRIC_REPRESENTATION_CONTEXT(3);`);
}
{
  const r=SI.tessellate(cylinderModel(2,5));log(SI.summary(r));
  assert.equal(r.stats.cylindrical,1);assert.equal(r.stats.planar,2);near(vol(r),Math.PI*4*5,Math.PI*4*5*0.02,"cylinder volume (chords)");
  assert.deepEqual(r.bbox.map(v=>+v.toFixed(0)),[-2,-2,0,2,2,5]);
}
{
  // A planar quarter disc whose arc is a quadratic rational B-spline (exact circle), extruded nowhere: area check.
  const w=Math.SQRT1_2;
  const d=`#10=CARTESIAN_POINT('',(0.,0.,0.));#11=CARTESIAN_POINT('',(10.,0.,0.));#12=CARTESIAN_POINT('',(10.,10.,0.));#13=CARTESIAN_POINT('',(0.,10.,0.));
#20=VERTEX_POINT('',#10);#21=VERTEX_POINT('',#11);#22=VERTEX_POINT('',#13);
#30=DIRECTION('',(1.,0.,0.));#31=VECTOR('',#30,10.);#32=LINE('',#10,#31);#33=EDGE_CURVE('',#20,#21,#32,.T.);
#34=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#11,#12,#13),.CIRCULAR_ARC.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,${w},1.))REPRESENTATION_ITEM(''));
#35=EDGE_CURVE('',#21,#22,#34,.T.);#36=DIRECTION('',(0.,-1.,0.));#37=VECTOR('',#36,10.);#38=LINE('',#13,#37);#39=EDGE_CURVE('',#22,#20,#38,.T.);
#40=EDGE_LOOP('',(#41,#42,#43));#41=ORIENTED_EDGE('',*,*,#33,.T.);#42=ORIENTED_EDGE('',*,*,#35,.T.);#43=ORIENTED_EDGE('',*,*,#39,.T.);
#44=FACE_OUTER_BOUND('',#40,.T.);#45=DIRECTION('',(0.,0.,1.));#46=AXIS2_PLACEMENT_3D('',#10,#45,#30);#47=PLANE('',#46);#48=ADVANCED_FACE('',(#44),#47,.T.);
#49=OPEN_SHELL('',(#48));#50=SHELL_BASED_SURFACE_MODEL('',(#49));#51=SHAPE_REPRESENTATION('',(#50),#2);#2=GEOMETRIC_REPRESENTATION_CONTEXT(3);`;
  const r=SI.tessellate(wrap(d));let area=0;
  for(const p of r.parts){const P=p.positions,I=p.indices;for(let i=0;i<I.length;i+=3){const a=I[i]*3,b=I[i+1]*3,c=I[i+2]*3;area+=((P[b]-P[a])*(P[c+1]-P[a+1])-(P[b+1]-P[a+1])*(P[c]-P[a]))/2;}}
  near(area,Math.PI*25,Math.PI*25*0.01,"quarter disc bounded by a rational B-spline");
}
// 4. An assembly: the cylinder placed twice through representation relationships.
{
  const base=cylinderModel(1,2),data=base.slice(base.indexOf("DATA;")+5,base.indexOf("ENDSEC;",base.indexOf("DATA;")));
  const asm=data+`#200=CARTESIAN_POINT('',(10.,0.,0.));#201=AXIS2_PLACEMENT_3D('',#200,#11,#12);#202=CARTESIAN_POINT('',(-10.,0.,0.));#203=AXIS2_PLACEMENT_3D('',#202,#11,#12);
#210=SHAPE_REPRESENTATION('asm',(#13,#201,#203),#2);
#211=(REPRESENTATION_RELATIONSHIP('','',#62,#210)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#212)SHAPE_REPRESENTATION_RELATIONSHIP());#212=ITEM_DEFINED_TRANSFORMATION('','',#13,#201);
#213=(REPRESENTATION_RELATIONSHIP('','',#62,#210)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#214)SHAPE_REPRESENTATION_RELATIONSHIP());#214=ITEM_DEFINED_TRANSFORMATION('','',#13,#203);`;
  const r=SI.tessellate("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n"+asm+"\nENDSEC;\nEND-ISO-10303-21;\n");
  assert.equal(r.stats.solids,2,"placed twice");assert.deepEqual(r.bbox.map(v=>+v.toFixed(1)),[-11,-1,0,11,1,2]);
}
// 5. Untrusted input: caps and errors, never a hang.
{
  assert.throws(()=>SI.tessellate("hello"),/Not an ISO 10303-21/);
  assert.throws(()=>SI.tessellate(wrap("#2=FOO(((((((((((((((((((((((((((((((((((((((1)))))))))))))))))))))))))))))))))))))));")),/deeper than/);
  let many="";for(let i=0;i<60;i++)many+="#"+(i+10)+"=CARTESIAN_POINT('',(0.,0.,0.));";
  assert.throws(()=>SI.tessellate(wrap(many),{limits:{entities:50}}),/more than 50 entities/);
  assert.throws(()=>SI.tessellate(wrap(many),{limits:{bytes:100}}),/larger than/);
  assert.throws(()=>SI.tessellate(wrap("#2=FOO(1,);")),/Expected|Unexpected/);
  assert.throws(()=>SI.tessellate("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=FOO(1);"),/not terminated/);
  // A reference cycle in the representation tree terminates.
  const cyc=wrap(`#10=SHAPE_REPRESENTATION('',(),#2);#11=SHAPE_REPRESENTATION('',(),#2);#2=GEOMETRIC_REPRESENTATION_CONTEXT(3);
#12=(REPRESENTATION_RELATIONSHIP('','',#10,#11)SHAPE_REPRESENTATION_RELATIONSHIP());#13=(REPRESENTATION_RELATIONSHIP('','',#11,#10)SHAPE_REPRESENTATION_RELATIONSHIP());`);
  const r=SI.tessellate(cyc);assert.equal(r.parts.length,0);assert.match(r.notes.join(" "),/bounding box/);
  // load() never throws: errors come back as a result for the bounding-box fallback.
  let got=null;SI.load("not a step").then(x=>{got=x;});
  setTimeout(()=>{assert.ok(got&&got.error,"load reports the error");},0);
  // The export's own model reader is capped too.
  assert.throws(()=>S.readModel("garbage"),/not an ISO 10303-21/);
}
// Duplicate STEP instance numbers must not change the source geometry.
{
  const data = "#10=CARTESIAN_POINT('',(0.,0.,0.));\n" +
    "#10=CARTESIAN_POINT('',(4.,0.,0.));\n" +
    "#11=CARTESIAN_POINT('',(0.,1.,0.));\n" +
    "#12=CARTESIAN_POINT('',(0.,0.,1.));\n" +
    "#20=POLY_LOOP('',(#10,#11,#12));\n" +
    "#21=FACE_OUTER_BOUND('',#20,.T.);\n" +
    "#22=FACE('',(#21));\n" +
    "#23=CLOSED_SHELL('',(#22));\n" +
    "#24=FACETED_BREP('triangle',#23);\n" +
    "#25=SHAPE_REPRESENTATION('',(#24),#2);\n" +
    "#2=GEOMETRIC_REPRESENTATION_CONTEXT(3);";
  assert.throws(() => SI.tessellate(wrap(data)), /Duplicate STEP instance #10/);
}

// 6. Speed: a 400-hole plate.
{
  const doc=A.sheet("pcb","Big");doc.outline=[[0,0],[200,0],[200,200],[0,200]];
  for(let i=0;i<20;i++)for(let j=0;j<20;j++)doc.items.push({id:"h"+i+"-"+j,kind:"via",x:5+i*10,y:5+j*10,diameter:1,drill:.5});
  const text=S.export({name:"Big",documents:[doc],library:[]},doc,{deterministic:true}),t0=Date.now(),r=SI.tessellate(text);
  log("400 holes:",(text.length/1024).toFixed(0)+" KB",Date.now()-t0+" ms",SI.summary(r));
  assert.ok(Date.now()-t0<3000);
}
