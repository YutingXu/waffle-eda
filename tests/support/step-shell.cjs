"use strict";
const assert=require("node:assert/strict");

// Verify the topology, curves and face orientation of a decoded STEP product.
function checkStepShell(f,{genus,folded=false}={}){
  assert.match(f.schema,/^AUTOMOTIVE_DESIGN/);
  const E=f.entities,get=r=>{const e=E.get(r.ref);assert.ok(e,"#"+r.ref);return e;};
  const P=r=>get(r).args[1];
  const known=new Set(["APPLICATION_CONTEXT","APPLICATION_PROTOCOL_DEFINITION","PRODUCT_CONTEXT","PRODUCT_DEFINITION_CONTEXT","UNCERTAINTY_MEASURE_WITH_UNIT",
    "DIRECTION","CARTESIAN_POINT","AXIS2_PLACEMENT_3D","COLOUR_RGB","FILL_AREA_STYLE_COLOUR","FILL_AREA_STYLE","SURFACE_STYLE_FILL_AREA","SURFACE_SIDE_STYLE",
    "SURFACE_STYLE_USAGE","PRESENTATION_STYLE_ASSIGNMENT","STYLED_ITEM","VECTOR","VERTEX_POINT","EDGE_CURVE","LINE","CIRCLE","PLANE","CYLINDRICAL_SURFACE",
    "ORIENTED_EDGE","EDGE_LOOP","FACE_OUTER_BOUND","FACE_BOUND","ADVANCED_FACE","CLOSED_SHELL","MANIFOLD_SOLID_BREP","PRODUCT","PRODUCT_DEFINITION_FORMATION",
    "PRODUCT_DEFINITION","PRODUCT_DEFINITION_SHAPE","PRODUCT_RELATED_PRODUCT_CATEGORY","ADVANCED_BREP_SHAPE_REPRESENTATION","SHAPE_DEFINITION_REPRESENTATION",
    "SHAPE_REPRESENTATION","ITEM_DEFINED_TRANSFORMATION","NEXT_ASSEMBLY_USAGE_OCCURRENCE","CONTEXT_DEPENDENT_SHAPE_REPRESENTATION",
    "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION"]);
  for(const [id,e] of E){
    if(e.complex){const t=e.complex.map(p=>p.type);assert.deepEqual(t,t.slice().sort(),"complex entity #"+id+" parts must be in alphabetical order");continue;}
    assert.ok(known.has(e.type),"unexpected entity "+e.type);
  }
  const solids=[...E].filter(([,e])=>e.type==="MANIFOLD_SOLID_BREP");
  const vec=(a,b)=>[b[0]-a[0],b[1]-a[1],b[2]-a[2]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const placement=r=>{const a=get(r).args;return {o:P(a[1]),z:get(a[2]).args[1],x:get(a[3]).args[1]};};
  const vpos=r=>P(get(r).args[1]);
  const genera=[];let planes=0,cyl=0;
  for(const [id,s] of solids){
    const shell=get(s.args[1]);assert.equal(shell.type,"CLOSED_SHELL");
    const uses=new Map(),verts=new Set();let loops=0;
    let topHoles=0;
    for(const fr of shell.args[1]){
      const face=get(fr);assert.equal(face.type,"ADVANCED_FACE");
      const surf=get(face.args[2]),sense=face.args[3].enum==="T"?1:-1;
      if(surf.type==="PLANE")planes++;else if(surf.type==="CYLINDRICAL_SURFACE")cyl++;else assert.fail("surface "+surf.type);
      let outer=0;
      for(const br of face.args[1]){
        const b=get(br);assert.ok(b.type==="FACE_OUTER_BOUND"||b.type==="FACE_BOUND");
        if(b.type==="FACE_OUTER_BOUND")outer++;
        const loop=get(b.args[1]);assert.equal(loop.type,"EDGE_LOOP");loops++;
        const flip=b.args[2].enum==="T"?false:true,chain=[];
        for(const oer of loop.args[1]){
          const oe=get(oer);assert.equal(oe.type,"ORIENTED_EDGE");
          const ec=get(oe.args[3]);assert.equal(ec.type,"EDGE_CURVE");
          let a=ec.args[1].ref,z=ec.args[2].ref;if(oe.args[4].enum==="F")[a,z]=[z,a];if(flip)[a,z]=[z,a];
          chain.push([a,z]);verts.add(a);verts.add(z);
          const u=uses.get(oe.args[3].ref)||[];u.push([a,z]);uses.set(oe.args[3].ref,u);
          // vertices lie on their curve
          const curve=get(ec.args[3]);
          for(const v of [ec.args[1],ec.args[2]]){
            const p=vpos(v);
            if(curve.type==="LINE"){const o=P(curve.args[1]),d=get(get(curve.args[2]).args[1]).args[1],w=vec(o,p),t=dot(w,d);const q=[o[0]+d[0]*t-p[0],o[1]+d[1]*t-p[1],o[2]+d[2]*t-p[2]];assert.ok(Math.hypot(...q)<1e-5,"vertex off line");}
            else if(curve.type==="CIRCLE"){const pl=placement(curve.args[1]),w=vec(pl.o,p);assert.ok(Math.abs(dot(w,pl.z))<1e-5);assert.ok(Math.abs(Math.hypot(...w)-curve.args[2])<2e-5,"vertex off circle");}
            else assert.fail("curve "+curve.type);
          }
        }
        for(let i=0;i<chain.length;i++)assert.equal(chain[i][1],chain[(i+1)%chain.length][0],"edge loop is not connected");
        if(folded&&surf.type==="PLANE"){
          const plane=placement(surf.args[1]);
          for(const [a] of chain)assert.ok(Math.abs(dot(vec(plane.o,vpos({ref:a})),plane.z))<=2e-6,"vertex on plane of solid #"+id);
        }
        // Orientation: the loop of a single-bound face turns counter-clockwise about the outward normal.
        if(!folded&&face.args[1].length===1&&chain.length>=3){
          const pts=chain.map(c=>vpos({ref:c[0]}));const nw=[0,0,0];
          for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];nw[0]+=(a[1]-b[1])*(a[2]+b[2]);nw[1]+=(a[2]-b[2])*(a[0]+b[0]);nw[2]+=(a[0]-b[0])*(a[1]+b[1]);}
          let n;
          if(surf.type==="PLANE")n=placement(surf.args[1]).z.map(v=>v*sense);
          if(n&&Math.hypot(...nw)>1e-9)assert.ok(dot(nw,n)>0,"face normal disagrees with its loop orientation ("+surf.type+")");
        }
      }
      assert.equal(outer,1,"one outer bound per face");
      if(!folded&&surf.type==="CYLINDRICAL_SURFACE"){
        const loop=get(get(face.args[1][0]).args[1]);let low=null;
        for(const oer of loop.args[1]){const oe=get(oer),ec=get(oe.args[3]),cv=get(ec.args[3]);if(cv.type!=="CIRCLE")continue;const z=placement(cv.args[1]).o[2];if(!low||z<low.z)low={z,forward:(oe.args[4].enum==="T")===(ec.args[4].enum==="T")};}
        assert.ok(low,"cylinder face has a circular edge");
        assert.equal(low.forward,sense>0,"cylinder face sense disagrees with its loop");
      }
      if(surf.type==="PLANE"&&face.args[1].length>1&&placement(surf.args[1]).z[2]*sense>0)topHoles=face.args[1].length-1;
    }
    for(const [e,u] of uses){
      assert.equal(u.length,2,"edge #"+e+" is used "+u.length+" times");
      assert.ok(u[0][0]===u[1][1]&&u[0][1]===u[1][0]||!folded&&u[0][0]===u[0][1]&&u[1][0]===u[1][1],"edge #"+e+" is not used in opposite directions");
    }
    const F=shell.args[1].length,chi=verts.size-uses.size+F-(loops-F);
    assert.equal(Math.abs(chi%2),0);const g=1-chi/2;
    if(folded)assert.ok(Number.isInteger(g)&&g>=0,"genus "+g);
    else assert.equal(g,topHoles,"genus equals the number of inner loops of the top face");
    genera.push(g);
  }
  if(genus!=null)assert.equal(genera[0],genus);
  return folded?{solids:solids.length,planes,cyl,entities:E.size}:{f,E,solids:solids.length,genera};
}
module.exports={checkStepShell};
