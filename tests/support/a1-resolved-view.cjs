"use strict";

// This function also runs as-is in the browser. All geometry, edits and
// publication inputs are the real loaded app APIs.
async function exerciseResolvedView(request) {
  const {Atrium: A, AtriumNavHost: host} = globalThis;
  const geometry = () => globalThis.AtriumResolvedGeometry;
  const check = (condition, why) => { if (!condition) throw Error(why); };
  const equal = (actual, want, why) => check(JSON.stringify(actual) === JSON.stringify(want),
    why + " wanted " + JSON.stringify(want) + ", received " + JSON.stringify(actual));
  const close = (actual, want, why) => check(Math.abs(actual - want) < 1e-7, why + " got " + actual + " vs " + want);
  const point = (actual, want, why) => {
    equal(actual.length,want.length,why+" dimension");
    actual.forEach((n, i) => close(n, want[i], why));
  };
  const rejects = (fn, why) => {
    let code;
    try { fn(); } catch (e) { code = e.code; }
    equal(code, "STALE_GEOMETRY", why);
  };
  const box = (x, y, w, h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  const copper = key => ({type:"Signal", name:key, key, material:"Copper", thickness:.035});
  const core = (name, thickness) => ({type:"Dielectric", name, material:"FR-4", dielectric:"Core", thickness, dk:4.2});
  const stackup = () => ({version:1, layers:[copper("Top"), core("Upper",.53), copper("Inner 1"), core("Middle",.5),
    copper("Inner 2"), core("Lower",.5), copper("Bottom")]});
  const blindVia = (id, x, y) => ({id,kind:"via",x,y,diameter:1,drill:.5,layer:"Multi",fromLayer:"Top",toLayer:"Inner 1"});
  const fabrication = (project, root) => (root.kind==="panel" ? AtriumPanel : AtriumFabOutputs).build(project, root, {
    origin:"absolute",drillOrigin:"absolute",units:"mm",drillUnits:"mm",date:new Date("2025-01-01T00:00:00Z")
  }).files.filter(file => file.kind === "gerber" || file.kind === "drill");
  const take = (project, root, options) => {
    check(host.project() === project, "geometry read belongs to the active project");
    const view = host.boardGeometry(root, options);
    check(view, "editor exposes the committed geometry view");
    return view;
  };
  const snapshot = (project, root, live, options) => geometry().read({kind:"snapshot", project, root, revision:live.revision}, options);
  const owner = (board, id, cell) => ({kind:"item", documentId:board.id, instancePath:cell == null ? [] : [cell], id});
  const boardOwner = (board, instancePath = []) => ({kind:"board", documentId:board.id, instancePath});
  const keys = entries => [...entries].map(k => [k.id ?? k.kind, k.instancePath.join("/")].join("@")).sort();
  const rect = (id, layer, points, extra = {}) => ({id, kind:"graphic", layer, points, fill:true, ...extra});
  const track = (id, layer, points) => ({id, kind:"track", layer, points, width:.5, net:"SIG"});
  const set = list => [...new Set(list)].sort();
  const stale = state => () => state.assertCurrent();

  async function prepareView(root) {
    // A replacement may still be waiting for its normal idle Undo baseline.
    for (let i=0; i<40; i++) {
      const view = await host.prepareBoardGeometry(root);
      if (view) return view;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    throw Error("No committed editor geometry view for "+root.kind);
  }

  async function prepare(fixture, author) {
    const project = A.project(fixture, []), board = project.documents.find(d => d.kind === "pcb");
    board.outline = box(0, 0, 24, 16);
    board.items = [];
    const spec = author(project, board);
    check(await host.replaceProject(project, {force:true, dirty:false}), "fixture project installed");
    await host.selectDocument(board.id);
    await prepareView(host.doc());
    return {project:host.project(), board:host.doc(), ...spec};
  }
  const edit = (apply, why, touched) => check(host.edit(apply, why, touched) !== false, why);
  const inkOf = v => [...v.features()];
  const production = globalThis.AtriumMaskOpenings;
  const curves = globalThis.AtriumGeometryCurves;
  let resolved = [];
  const trackResolutions = [];
  globalThis.AtriumGeometryCurves = {...curves, pathEdges(item) {
    if (item.kind === "track") trackResolutions.push(item.id);
    return curves.pathEdges(item);
  }};
  globalThis.AtriumMaskOpenings = {...production, collect(ctx) {
    resolved.push(ctx.owner);
    return production.collect(ctx);
  }};

  // Point occupancy from the returned boundaries. Circles and ellipses are
  // evaluated at fixed analytic parameter values far finer than these probes
  // need. This deliberately does not call the product sampler or clipper.
  function insideLoop(loop, [x, y]) {
    const points = loop.flatMap(edge => {
      if (edge.kind === "line") return [edge.a];
      return Array.from({length:180}, (_, i) => {
        const t = (edge.start + edge.sweep * i / 180) * Math.PI / 180;
        const c = Math.cos(t), s = Math.sin(t), [u, v] = edge.center;
        return edge.kind === "arc" ? [u + edge.radius * c, v - edge.radius * s] :
          [u + edge.cosineAxis[0] * c + edge.sineAxis[0] * s, v + edge.cosineAxis[1] * c + edge.sineAxis[1] * s];
      });
    });
    return points.reduce((hit, [ax, ay], i) => {
      const [bx, by] = points[(i + 1) % points.length];
      return Boolean(hit ^ ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)));
    }, false);
  }
  const inside = (islands, at) => islands.some(i => insideLoop(i.outer, at) && !i.holes.some(h => insideLoop(h, at)));
  const compareFresh = (p, d, v, o) => {
    const detached = snapshot(p, d, v, o);
    equal(inkOf(v), inkOf(detached), "incremental ink equals cold snapshot");
    equal([...v.bores()], [...detached.bores()], "incremental bores equal cold snapshot");
  };

  async function exerciseSolvedPour() {
    const P = AtriumPolygonPour;
    const {project, board} = await prepare("A1 solved copper", (_, d) => {
      d.items.push(P.make(box(2,2,18,10),{id:"copper",net:"GND",layer:"Top",clearance:.25,removeIslands:false}),
        {id:"anchor",kind:"pad",net:"GND",layer:"Top",x:4,y:5,w:1,h:1,shape:"round"},
        track("blocker","Top",[[6,7],[13,7]]),track("idle","Bottom",[[4,14],[12,14]]));
    });
    const solve = () => P.apply(board,host.defs(),{project});
    edit(solve,"Resolve initial copper pour",[{doc:board,items:[]}]);
    const initial=take(project,board);
    const occupancy = view => [[9,7.4],[9,10.4]].map(at=>inside(view.layerArea("Top","film"),at));
    equal(occupancy(initial),[false,true],"initial solved clearance beside the blocker");
    const blocker=board.items.find(item=>item.id==="blocker");
    edit(()=>{blocker.points=[[6,10],[13,10]];},"Move pour obstacle",[blocker]);
    const edited=take(project,board), prior=edited.revision;
    const anchor=edited.owner(owner(board,"anchor")), idle=edited.owner(owner(board,"idle"));
    edit(solve,"Resolve copper after route edit",[{doc:board,items:[]}]);
    const solved=take(project,board), damage=solved.changes(prior);
    equal(occupancy(solved),[true,false],"new fill follows the separately moved blocker");
    equal(keys(damage.owners),["board@"],"solving the retained pour affects its board owner only");
    equal(damage.layers,["Top"],"solving the Top pour leaves the board outline clean");
    equal(damage.bounds.length,1,"solving the retained pour dirties one extent");
    point(damage.bounds[0],[2,2,20,12],"only the copper outline bounds are dirty");
    check(solved.owner(owner(board,"anchor"))===anchor&&solved.owner(owner(board,"idle"))===idle,
      "pour commit retains the two unrelated owner records");
    compareFresh(project,board,solved);
    return {owners:keys(damage.owners),layers:damage.layers,bounds:damage.bounds};
  }

  const cases = {
    async C2() {
      const {project, board, panelId} = await prepare("A1 placement", (p, d) => {
        p.library.push({id:"package", name:"Double land", prefix:"Q", footprint:{pads:[
          {number:"1", x:1, y:1, layer:"Top", shape:"rect", w:1, h:1},
          {number:"1", x:2, y:1, layer:"Top", shape:"rect", w:1, h:1}
        ], shapes:[]}});
        d.items.push({id:"q4", kind:"part", def:"package", ref:"Q4", x:4, y:2, angle:0, pinNets:{"1":"SIG"}},
          {id:"q5", kind:"part", def:"package", ref:"Q5", x:12, y:4, angle:0, pinNets:{"1":"SIG"}},
          track("untouched","Bottom",[[3,10],[5,10]]),
          {...track("caption","Top",[[4,9],[20,9]]),width:1.5},
          {...blindVia("mirror-span",8,11),ipc4761:"I",ipcSides:"top"});
        d.stackup = stackup();
        const panel = AtriumPanel.create(p, {board:d.id, rows:1, cols:2, spacing:2, cells:{"0,1":{rotation:180,mirror:true}},
          rails:{top:false,bottom:false,left:false,right:false}, text:{enabled:false},
          tooling:{enabled:false}, fiducials:{enabled:false}});
        p.documents.push(panel);
        return {panelId:panel.id};
      });
      const panel = project.documents.find(d => d.id === panelId);
      await prepareView(panel);
      const live = take(project, panel), before = live.revision;
      const landing = (v, id, cell) => v.owner(owner(board, id, cell)).features.filter(f => f.key.role === "land");
      const pair = landing(live,"q4","0,0"), turned = landing(live,"q4","0,1");
      equal(pair.length,2,"duplicate pad numbers have two lands");
      check(JSON.stringify(pair[0].key) !== JSON.stringify(pair[1].key),"duplicate pad number keys are distinct");
      point(pair[0].ink.at,[5,3],"normal panel position");
      point(turned[0].ink.at,[31,13],"second panel position after reflection and 180 degrees");
      equal(pair[0].key.layer,"Top","authored layer");
      equal(turned[0].key.layer,"Bottom","reflected layer");
      equal(turned[0].key.owner.instancePath,["0,1"],"second occurrence path");
      equal(take(project,board).owner(owner(board,"q4")).owner.instancePath,[],"root path");
      check(live.owner(boardOwner(panel)).features.some(f => f.key.role === "profile"),"panel profile belongs to the root");
      const bore = cell => live.owner(owner(board,"mirror-span",cell)).bores[0];
      equal([bore("0,0").from,bore("0,0").to,bore("0,0").z],["Top","Inner 1",[1.035,1.635]],"normal span");
      equal([bore("0,1").from,bore("0,1").to],["Inner 2","Bottom"],"reflected span");
      point(bore("0,1").z,[-.035,.565],"reflected bottom datum");
      equal(bore("0,1").treatment.ipcSides,"bottom","reflected treatment face");
      point(bore("0,1").cutter.at,[34,5],"reflected blind drill");
      const legend = live.owner(owner(board,"q4","0,1")).features.find(f => f.text);
      equal([legend.text.content,legend.key.layer,legend.text.mirrored],["Q4","Bottom silk",true],"reflected reference inscription");
      const normalLegend = live.owner(owner(board,"q4","0,0")).features.find(f => f.text);
      equal([normalLegend.text.content,normalLegend.key.layer,normalLegend.text.mirrored],["Q4","Silk",false],"normal reference inscription");
      inkOf(live);
      const stable = live.owner(owner(board,"untouched","0,0"));
      resolved = [];
      edit(() => { project.library[0].footprint.pads[0].w = 1.4; },"Widen two repeated package placements",
        [{doc:board, items:[]},{library:true}]);
      rejects(stale(live),"the earlier panel view has expired");
      const updated = take(project,panel), dirty = updated.changes(before);
      const changed = ["q4@0,0","q4@0,1","q5@0,0","q5@0,1"];
      equal(keys(dirty.owners),changed,"only the four dependent occurrences are invalidated");
      equal(keys(resolved.filter(o => o.instancePath.length)),changed,"only the four dependent occurrences are resolved");
      check(updated.owner(owner(board,"untouched","0,0"))===stable,"unaffected occurrence shares immutable geometry");
      for (const face of ["Top","Bottom"]) {
        for (const layer of [face,face+" mask",face+" paste"]) check(dirty.layers.includes(layer),"edited land affects "+layer);
      }
      close(landing(updated,"q4","0,0")[0].bounds[2],5.7,"expanded land edge");
      close(landing(updated,"q4","0,1")[0].bounds[0],30.3,"expanded reflected land edge");
      compareFresh(project,panel,updated);
      const view = host.view(), original = view.camera();
      view.restoreCamera({...original,cx:12,cy:9,scale:36});
      const showCaptions = netNames => view.render(board,host.defs(),{grid:false,origin:false,layer:"Top",netNames});
      showCaptions(true);
      const captions = view.internals().netLabels().filter(label => label.text === "SIG").length;
      check(captions>0,"board is displaying the screen-only SIG caption");
      const files = fabrication(project,panel);
      showCaptions(false);
      equal(view.internals().netLabels().length,0,"now the board has no screen caption");
      const fileBytes = list => list.map(({name,content}) => [name,content]);
      check(files.some(f => f.kind==="gerber")&&files.some(f => f.kind==="drill"),"tested Gerber and NC output");
      equal(fileBytes(fabrication(project,panel)),fileBytes(files),"caption visibility leaves fabrication bytes unchanged");
      await AtriumLazy.need("AtriumFormat2Closure");
      const F = AtriumFormat2, M = AtriumFormat2Model, storage = M.fromEditor(project);
      const records = new Map(storage.files.map(({path,file})=>[path,F.serialize(file)]));
      const native = M.manifest(M.parse(records.get(storage.manifestPath)));
      const member = native.members.find(row=>row.kind==="panel");
      const reopened = M.document(M.parse(records.get(member.path)),{name:member.name});
      const {rotation,mirror}=reopened.panel.cells["0,1"];
      equal([rotation,mirror],[180,true],"native panel roundtrip retains reflected placement");
      return {captions,files:files.map(({name,kind,content})=>({name,kind,content})),owners:changed,layers:[...dirty.layers],normalAt:pair[0].ink.at,rotatedAt:turned[0].ink.at};
    },
    async C3() {
      const {project, board} = await prepare("A1 process", (p, d) => {
        d.stackup = stackup();
        for (const layer of ["Top","Inner 1","Inner 2","Bottom"]) d.items.push(rect("film-"+layer,layer,box(1,1,21,13)));
        d.items.push(rect("clear","Top",box(18,8,1,1),{polarity:"clear"}),
          {id:"slot",kind:"pad",x:5,y:6,w:2,h:2,shape:"round",layer:"Multi",holeOnly:true,
            drill:.6,slotLength:2,slotAngle:90,plated:true},
          {id:"round",kind:"pad",x:8,y:6,w:2,h:2,shape:"round",layer:"Multi",drill:1,plated:true,
            stackMode:"full",padStack:{Top:{w:0,h:0},"Inner 1":{w:1.8,h:1.8},Bottom:{w:2,h:2}}},
          {id:"back",kind:"via",x:12,y:6,diameter:1,drill:.4,layer:"Multi",
            backdrill:{from:"top",toLayer:"Inner 1",stubMax:.05,diameter:.8},ipc4761:"VII",tent:{top:true,bottom:true}},
          blindVia("blind",15,6),
          {...blindVia("unknown",20,6),toLayer:"Opaque copper"},
          {id:"npth",kind:"pad",x:18,y:6,w:1,h:1,shape:"round",layer:"Multi",drill:.65,plated:false},
          {id:"smd",kind:"pad",x:4,y:10,w:1,h:1,shape:"rect",layer:"Top"});
        const scope = (kind, value) => AtriumDesignQueryRecord.selector(kind,value);
        const rules = [{id:"top", type:"solderMask", name:"Top opening", enabled:true, priority:1, scope:scope("layer","Top"), expansion:.05},
          {id:"bottom", type:"solderMask", name:"Bottom opening", enabled:true, priority:2, scope:scope("layer","Bottom"), expansion:.20}];
        AtriumRules.store(d,p,AtriumRules.normalize({list:rules}));
      });
      const v = take(project,board), roof = v.layers.find(l => l.name === "Top").z;
      equal(roof,[1.6,1.635],"copper above the dielectric datum");
      equal(v.layers.find(l => l.name === "Bottom").z,[-.035,0],"bottom foil below the datum");
      const bores = id => v.owner(owner(board,id)).bores;
      const [slot] = bores("slot"), [back, ream] = bores("back"), [blind] = bores("blind");
      equal([slot.cutter.kind,slot.cutter.diameter,slot.plated,slot.z],["slot",.6,true,[-.035,1.635]],"plated slot spans both faces");
      point(slot.cutter.centerline[0].a,[5,5.3],"independent slot end");
      point(slot.cutter.centerline[0].b,[5,6.7],"independent slot end");
      equal([ream.operation,ream.z,ream.cutter.diameter],["backdrill",[1.12,1.635],.8],"backdrill ends at foil plus stub");
      equal(ream.primary,back.key,"backdrill refers to its primary");
      equal(back.treatment,{ipc4761:"VII",ipcSides:null,tented:{top:true,bottom:true}},"cap and tent are retained");
      equal([blind.from,blind.to,blind.z],["Top","Inner 1",[1.035,1.635]],"blind span including terminal foil");
      equal(bores("npth")[0].plated,false,"nonplated hole remains distinct");
      equal(bores("unknown")[0].z,null,"unknown depth is explicit");
      check([...v.diagnostics()].some(d => d.owner.id==="unknown"&&d.code==="unknown-bore-depth"),"unknown depth is diagnosed");
      check(v.owner(owner(board,"round")).features.every(f => f.key.role !== "land" || f.key.layer !== "Top"),"zero suppresses only Top land");
      const film = v.layerArea("Top","film"), top = v.layerArea("Top","finished"), bottom = v.layerArea("Bottom","finished");
      for (const at of [[5,6.8],[8,6],[18,6]]) {
        check(inside(film,at),"positive film covers the cutter location");
        check(!inside(top,at)&&!inside(bottom,at),"other-owner hole cuts both external layers");
      }
      check(!inside(film,[18.5,8.5]),"clear region affects film polarity");
      check(!inside(top,[15,6])&&inside(bottom,[15,6]),"blind cutter leaves Bottom material");
      check(!inside(top,[12.33,6])&&inside(bottom,[12.33,6]),"backdrill widening does not reach Bottom");
      check(inside(v.layerArea("Top","finished",undefined,1.119),[12.33,6]),"just below backdrill");
      check(!inside(v.layerArea("Top","finished",undefined,1.121),[12.33,6]),"just above backdrill");
      check(inside(top,[20,6]),"unknown depth leaves the film material");
      const files = fabrication(project,board).map(({name,kind,content}) => ({name,kind,content}));
      const exported = AtriumSTEP.build(project,board,{copper:true,components:false,geometryView:v});
      check(exported.notes.some(note=>note.includes("Unresolved physical drill depth on unknown")),"STEP reports unresolved cutter depth");
      const step = [...AtriumSTEP.parse(exported.data).entities];
      const width = (view, id, layer) => {
        const feature = view.owner(owner(board,id)).features.find(f => f.key.layer===layer);
        check(feature,"expected feature on "+layer);
        return feature.bounds[2]-feature.bounds[0];
      };
      const round = () => board.items.find(i => i.id==="round");
      const topRule = () => AtriumRules.effective(board,project).list.find(r => r.id==="top");
      const initialRules = AtriumRules.effective(board,project).list.filter(r => r.type === "solderMask");
      close(width(v,"smd","Top mask"),1.1,"original face rule "+JSON.stringify(initialRules));
      close(width(v,"round","Bottom mask"),2.4,"original bottom rule");
      edit(() => {
        const set = AtriumRules.effective(board,project);
        set.list.find(r=>r.id==="top").expansion=.15;
        AtriumRules.store(board,project,set);
      },"Increase Top-only mask rule",[{doc:board,items:[]}]);
      close(topRule().expansion,.15,"editor authored the rule change");
      const rulesView=take(project,board);
      close(width(rulesView,"smd","Top mask"),1.3,"top rule changes the top opening");
      close(width(rulesView,"round","Bottom mask"),2.4,"top rule preserves bottom opening");
      compareFresh(project,board,rulesView);
      const override={maskExpansion:.35,overrideExpansions:true};
      const job=take(project,board,override);
      const jobDamage=job.changes(rulesView.revision);
      equal(keys(jobDamage.owners),["npth@","round@","slot@","smd@"],
        "effective job default reports only owners with changed film");
      equal(set(jobDamage.layers),["Bottom mask","Top mask"],"effective job default touches only mask");
      close(width(job,"smd","Top mask"),1.7,"job override changes effective Top film");
      close(width(job,"round","Bottom mask"),2.7,"job override changes effective Bottom film");
      compareFresh(project,board,job,override);
      close(width(rulesView,"round","Inner 1"),1.8,"exact named inner land");
      close(width(rulesView,"round","Inner 2"),2,"unoverridden inner land uses nominal");
      edit(() => { round().padStack["Inner 1"]={w:1.7,h:1.7}; },"Change named inner land",[round()]);
      const inner=take(project,board);
      close(width(inner,"round","Inner 1"),1.7,"named-foil change");
      close(width(inner,"round","Inner 2"),2,"named-foil change leaves another foil alone");
      edit(() => { round().w=2.2; round().h=2.2; },"Change nominal land",[round()]);
      const nominal=take(project,board);
      close(width(nominal,"round","Inner 2"),2.2,"nominal change follows missing row");
      close(width(nominal,"round","Inner 1"),1.7,"nominal change preserves override");
      compareFresh(project,board,nominal);
      return {z:roof, primary:back.z, backdrill:ream.z, blind:blind.z, film:inside(film,[5,6.8]), files, step};
    },
    async C4() {
      const {project, board} = await prepare("A1 edits", (_, d) => {
        d.items.push(track("wire","Top",[[2,2],[5,2]]),track("idle","Bottom",[[3,10],[5,10]]));
      });
      const wire = () => host.doc().items.find(i => i.id === "wire"), key = owner(board,"wire");
      const first = take(project,board), token = first.revision;
      const original = first.owner(key), neighbor = first.owner(owner(board,"idle"));
      const oldBox = [1.75,1.75,5.25,2.25], newBox = [14.75,7.75,18.25,9.25];
      const frozen = snapshot(project,board,first);
      const iterator = first.features()[Symbol.iterator](); iterator.next();
      inkOf(first);
      const view = host.view(), before = view.camera();
      resolved = []; trackResolutions.length = 0;
      host.select(["wire"],"wire");
      view.zoom(1.25);
      host.redraw();
      check(view.camera().scale !== before.scale,"real camera zoom changed");
      equal(host.selection(),["wire"],"real selection changed");
      check(take(project,board) === first,"view and selection changes reuse the same geometry");
      equal(first.changes(token),{kind:"incremental",owners:[],layers:[],bounds:[]},"same revision delta");
      const cameraResolutions = resolved.length + trackResolutions.length;
      equal(cameraResolutions,0,"camera and selection resolve no owners");

      const pending = host.prepareBoardGeometry(board);
      edit(() => Object.assign(wire(),{layer:"Bottom",points:[[15,8],[18,9]]}),"Move to disjoint bounds and layer",[wire()]);
      const moved=take(project,board), movedToken=moved.revision, damage=moved.changes(token);
      equal(keys(damage.owners),["wire@"],"only edited owner changes");
      equal(set(damage.layers),["Bottom","Top"],"old and new layers are invalidated");
      equal(damage.bounds,[oldBox,newBox],"both extents are invalidated");
      equal(trackResolutions,["wire"],"one edited track resolved");
      check(await pending===moved,"pending preparation returns the now-current revision");
      check(moved.owner(owner(board,"idle"))===neighbor,"unchanged owner identity");
      check(Object.isFrozen(original.features[0].ink.centerline[0]),"published coordinates are immutable");
      rejects(()=>iterator.next(),"iterator expires mid-read");
      rejects(()=>first.owner(key),"stale owner read");
      rejects(()=>geometry().read({kind:"snapshot",project,root:board,revision:token}),"expired work request is rejected");
      equal(frozen.owner(key),original,"detached view keeps old geometry");
      compareFresh(project,board,moved);
      const preview=geometry().preview(moved,[{kind:"item",owner:key,value:null}]);
      equal(preview.owner(key),undefined,"preview delete is visible in its own view");
      check(moved.owner(key)&&wire(),"preview does not edit captured source");
      geometry().preview(moved,[]);
      rejects(stale(preview),"cancelled preview expires");
      const removed = wire();
      edit(()=>board.items.splice(board.items.indexOf(removed),1),"Delete moved wire",[removed]);
      const deleted=take(project,board), deletedToken=deleted.revision;
      const beforeUndo=AtriumUndoStore.documentVersions(board,project,true);
      equal(deleted.changes(movedToken).bounds,[newBox],"delete invalidates the old extent");
      equal(deleted.owner(key),undefined,"delete removes the owner");
      await host.historyGo(-1);
      const undoDelete=take(project,board), undoDeleteToken=undoDelete.revision;
      const afterUndo=AtriumUndoStore.documentVersions(board,project,true);
      const deleteUndoDamage=undoDelete.changes(deletedToken);
      equal(deleteUndoDamage.bounds,[newBox],"undo delete restores the moved extent "+JSON.stringify({beforeUndo,afterUndo}));
      await host.historyGo(-1);
      const undoMove=take(project,board), undoMoveToken=undoMove.revision;
      equal(set(undoMove.changes(undoDeleteToken).layers),["Bottom","Top"],"undo move invalidates both layers");
      equal(undoMove.owner(key).features[0].bounds,oldBox,"undo move restores original ink");
      await host.historyGo(1);
      const redo=take(project,board);
      equal(redo.changes(undoMoveToken).bounds,[oldBox,newBox],"redo move invalidates old and new extents");
      compareFresh(project,board,redo);
      check(redo.owner(owner(board,"idle"))===neighbor,"unaffected owner retained across Undo/Redo");
      const redoMoveToken=redo.revision;
      await host.historyGo(1);
      const redoDelete=take(project,board);
      equal(redoDelete.changes(redoMoveToken).bounds,[newBox],"redo delete invalidates the moved extent");
      equal(redoDelete.owner(key),undefined,"redo delete removes the owner again");
      await host.historyGo(-1);
      const redoToken=take(project,board).revision;
      for (let n=0; n<25; n++) {
        edit(() => { wire().width = .55 + n*.01; },"Widen route",[wire()]);
        take(project,board).changes();
      }
      equal(take(project,board).changes(redoToken),{kind:"cold"},"compacted geometry history has no delta");
      const copy=A.clone(project);
      check(await host.replaceProject(copy,{force:true,dirty:false}),"second project installed with reused IDs");
      await host.selectDocument(board.id);
      await prepareView(host.doc());
      equal(take(host.project(),host.doc()).changes(redoToken),{kind:"cold"},"reused IDs cannot share lineage");
      return {moved:damage.bounds, layers:damage.layers, cameraResolutions, movedOwnerCount:damage.owners.length,pour:await exerciseSolvedPour()};
    }
  };
  const outcome = [];
  try {
    for (const name of request.cases) {
      try { outcome.push({name, pass:true, readings:await cases[name]()}); }
      catch (error) { outcome.push({name, pass:false, error:String(error.stack || error)}); }
    }
  } finally {
    globalThis.AtriumMaskOpenings = production;
    globalThis.AtriumGeometryCurves = curves;
  }
  return outcome;
}

module.exports = {exerciseResolvedView};
