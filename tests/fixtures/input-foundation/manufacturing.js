"use strict";
globalThis.WaffleManufacturingInputProbe=async function(){
  await AtriumLazy.need(["AtriumCamera","AtriumDrawing","AtriumPanelUI","AtriumContextMenu"]);
  const H=AtriumNavHost,P=Atrium.project("Drawing and panel input"),board=P.documents.find(d=>d.kind==="pcb");
  board.outline=[[0,0],[32,0],[32,18],[0,18],[0,0]];
  const drawing=AtriumDrawing.create(P,{preset:"empty"}),panel=AtriumPanel.create(P,{rows:1,cols:2,spacing:3});
  P.documents.push(drawing,panel);
  AtriumDrawing.apply(P,drawing,[{op:"add_line",points:[[25,40],[45,40]],sheet:drawing.drawing.sheets[0].id}]);
  await H.replaceProject(P,{force:true,dirty:false});H.selectDocument(drawing.id);
  const c=H.canvas(),v=H.view(),checks=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const setView=(p,scale=9)=>{v.restoreCamera({...v.camera(),cx:p[0],cy:p[1],scale,rotation:0});H.redraw();};
  function event(type,id,world,kind="touch"){
    const r=c.getBoundingClientRect(),p=v.worldToScreen(world);
    c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:kind,isPrimary:true,
      button:type==="pointermove"?-1:0,buttons:type==="pointercancel"||type==="pointerup"?0:1,clientX:r.left+p[0],clientY:r.top+p[1]}));
  }
  const up=(id,p,kind)=>event("pointerup",id,p,kind),down=(id,p,kind)=>event("pointerdown",id,p,kind),
    move=(id,p,kind)=>event("pointermove",id,p,kind),end=(id,p,kind)=>event("pointercancel",id,p,kind);
  const tap=(id,p,kind)=>{down(id,p,kind);up(id,p,kind);};
  const position=()=>JSON.stringify(H.doc().drawing.lines[0].points);
  const [ox,oy]=AtriumDrawing.sheetOrigins(drawing.drawing)[0],line=[35+ox,40+oy],target=[line[0]+3,line[1]+3];
  setView(line);const original=position(),before=H.undoSteps().history.length;
  down(250,line);move(250,target);up(250,target);check(position()===original,"one finger on an unselected drawing line pans");setView(line);
  tap(249,line);down(251,line);move(251,target);check(position()===original&&AtriumDrawing.inputAt(target,v.scale())?.item?.kind==="line"&&!AtriumDrawing.inputAt(line,v.scale())?.item,"one finger previews the drawing line move without changing the document");
  end(251,target);check(position()===original&&H.undoSteps().history.length===before,"drawing cancellation restores geometry without a history entry");
  down(252,line,"pen");move(252,target,"pen");up(252,target,"pen");
  check(position()!==original&&H.undoSteps().history.length===before+1,"releasing a pen commits the drawing edit once");
  H.act("undo");
  check(position()===original,"Undo restores the original drawing line");
  tap(253,line);tap(254,line);check(v.scale()===9,"a second tap on a drawing object never zooms");
  setView(line);H.act("camera-zoom-selection");check(v.scale()>9,"the keyboard-fit command finds a drawing selection");
  setView(line);
  // The finger stays put on screen even if the layout reflows under it during the hold.
  const still=(()=>{const r=c.getBoundingClientRect(),p=v.worldToScreen(line);return [r.left+p[0],r.top+p[1]];})();
  const raw=type=>c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:262,pointerType:"touch",isPrimary:true,
    button:0,buttons:type==="pointerup"?0:1,clientX:still[0],clientY:still[1]}));
  const menu=()=>document.querySelector('.ctx-menu[role="menu"],.nav-menu[role="menu"]');
  raw("pointerdown");
  await WaffleInputProbe.waitFor(()=>document.querySelector('.touch-lift[data-kind="object"]'),"The drawing hold did not reach its pickup cue");
  raw("pointerup");
  await WaffleInputProbe.waitFor(menu,"The drawing hold did not open its object menu");
  check(menu()?.getAttribute("aria-label")==="Drawing line"&&menu().textContent.includes("Properties"),"holding a drawing object opens its own context menu");
  AtriumContextMenu.close();
  setView(line);H.act("drawing-line");const lines=H.doc().drawing.lines.length;
  const start=[line[0],line[1]+5],placed=[start[0]+6,start[1]+2],next=[placed[0]+5,placed[1]];
  down(260,start);move(260,placed);up(260,placed);tap(261,next);
  c.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  const made=H.doc().drawing.lines.at(-1);
  check(H.doc().drawing.lines.length===lines+1&&made.points[0][0]===41&&made.points[0][1]===47,"touch places an armed drawing line at release and Enter completes it");
  H.act("undo");check(H.doc().drawing.lines.length===lines,"one Undo removes the added drawing line");
  H.selectDocument(panel.id);
  const G=AtriumPanel.layout(H.project(),H.doc()),gap=AtriumPanelUI.handles(G).find(h=>h.kind==="gapx").at;
  const change=[gap[0]+4,gap[1]],spacing=()=>H.doc().panel.spacing,base=spacing(),steps=H.undoSteps().history.length;setView(gap);
  down(255,gap);move(255,change);check(AtriumPanelUI.state.draft.spacing!==base,"a finger previews the manufacturing panel gap");
  down(256,[gap[0]+12,gap[1]+4]);end(256,gap);up(255,change);
  check(!AtriumPanelUI.state.drag&&!AtriumPanelUI.state.draft&&spacing()===base&&H.undoSteps().history.length===steps,"a second finger cancels the panel edit before navigation");
  down(257,gap);move(257,change);up(257,change);
  check(spacing()!==base&&H.undoSteps().history.length===steps+1,"a panel drop creates one normal undo step");
  H.act("undo");check(spacing()===base,"Undo restores the panel parameters");
  const [x,y,x2,y2]=G.instances[0].box,cell=[(x+x2)/2,(y+y2)/2];setView(cell,5);
  tap(258,cell);tap(259,cell);check(v.scale()===5,"a second tap on a panel cell never zooms");
  setView(cell,5);H.act("camera-zoom-selection");check(v.scale()>5,"the keyboard-fit command finds the panel cell");
  setView(cell,5);
  return checks;
};
