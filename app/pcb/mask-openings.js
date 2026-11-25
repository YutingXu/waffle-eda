"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("./land-contours.js");

if (!globalThis.AtriumPCBAppearance && typeof require === "function") require("./pcb-appearance.js");

// Solder-mask openings have a physical face and an authored policy. DFM and
// plotters can settle that policy against different defaults.
globalThis.AtriumMaskOpenings = (() => {
  const FACES = Object.freeze(["Top", "Bottom"]);
  const DEFAULTS = Object.freeze({maskExpansion:.1016,pasteExpansion:0,tentVias:true,overrideExpansions:false});

  const PCB = globalThis.AtriumPCBAppearance, L = globalThis.AtriumResolvedLand;
  const padFaces = (layer, drill, copper) => FACES.includes(layer) ? [layer] :
    layer === "Multi" || drill > 0 && !copper ? FACES : [];
  const padLand = (item, face) => L.geometry(item, face) ??
    {...L.profile("circle",0,0,item.angle), x:item.x, y:item.y};

  const C=AtriumLandContours, expandPad=C.expand;
  const own = (item, field) => Number.isFinite(item?.[field]) ? item[field] : undefined;
  const sideOf = face => face === "Top" ? "top" : "bottom";
  function paste(item, parent, face, land, rule) {
    if (!land || item.drill > 0 || item.noPaste || !FACES.includes(face)) return [];
    const {at,angle,mirror} = L.place(land,parent);
    const windows = Array.isArray(item.pasteApertures) ? item.pasteApertures.filter(q => q?.w > 0 && q.h > 0 && Number.isFinite(q.x) && Number.isFinite(q.y)) : [];
    if(windows.length)return windows.map(q=>({
      at:Atrium.world([q.x,q.y],{x:at[0],y:at[1],angle,mirror}), pad:L.profile("rect",q.w,q.h,angle),
      expand:"paste",expandBy:0
    }));
    let ruleExpand;
    try { ruleExpand = rule?.(item,parent,face); } catch {}
    return [{at, pad:placedProfile(land,parent), expand:"paste",expandBy:own(item,"pasteExpansion"),
      ruleExpand:Number.isFinite(ruleExpand)?ruleExpand:undefined}];
  }
  function placedProfile(g,parent) {
    const {angle,mirror} = L.place(g,parent);
    return {...g,angle,...(mirror&&g.poly?{poly:g.poly.map(([x,y])=>[-x,y])}:null)};
  }
  function rulesFor(board, project) {
    const R = globalThis.AtriumRules;
    if (!R?.maskRuleResolver) return null;
    const stored = project?.rules || board?.rules ? R.stored(board, project) : null;
    // The rule engine synthesizes its generic mask default for a v1 or
    // missing rule book. Only fabrication uses that default in this case.
    return {
      find: stored && stored.version !== 1 ? R.maskRuleResolver(board, "solder", {project}) : null,
      defaultExpansion: R.types.solderMask.fields.find(field => field.key === "expansion").def
    };
  }

  function candidate(item, parent, face, rules, open) {
    const rule = rules?.find?.(item, parent, face);
    return {
      open, face,
      ownExpansion: own(item, "maskExpansion"),
      ruleExpansion: rule?.expansion,
      ruleTent: open == null ? rule?.[face === "Top" ? "tentTop" : "tentBottom"] : undefined
    };
  }

  function pad(item, parent, face, rules) {
    const tent = item.tent?.[sideOf(face)];
    return tent === true ? null : candidate(item, parent, face, rules, tent === false ? true : null);
  }

  function via(item, parent, face, rules, span) {
    const side = sideOf(face);
    const VS = globalThis.AtriumViaStack, diameter = item.diameter || item.w;
    if (!(diameter > 0)) return null;
    const [from, to] = span || VS?.spanOf(item) || [item.fromLayer || "Top", item.toLayer || "Bottom"];
    if (from !== face && to !== face) return null;
    // Preserve fabrication's span fallback for an unresolved pair, as well
    // as saved vias that used w in place of diameter.
    const via = diameter === item.diameter && (!span || (from === item.fromLayer && to === item.toLayer)
      || (to === item.fromLayer && from === item.toLayer)) ? item : {...item, diameter, fromLayer: from, toLayer: to};
    const tent = via.tent?.[side];
    const opening = VS?.maskOpening(via, side, 0) ?? {land: diameter, open: typeof tent === "boolean" ? !tent : null};
    if (opening.open === false || !(opening.land > 0)) return null;
    return {...candidate(item, parent, face, rules, opening.open), land: opening.land, via: true};
  }

  function* maskSeeds(item,parent,faces,rules,span){
    for(const face of faces){
      const mask=item.kind==="via"?via(item,parent,face,rules,span):pad(item,parent,face,rules);
      if(!mask)continue;
      const land=mask.via?{...L.profile("circle",mask.land,mask.land,0),x:item.x,y:item.y}:padLand(item,face);
      yield {mask,land};
    }
  }

  // Null is a covered or collapsed aperture. Each expansion is in board millimetres.
  function aperture(opening, land, policy, ruleDefault) {
    const respectRules = !policy.overrideExpansions;
    const faceTent=opening.face==="Top"?policy.tentTop:policy.tentBottom;
    if (opening.open == null && (respectRules && typeof opening.ruleTent === "boolean" ? opening.ruleTent : opening.via && (faceTent??policy.tentVias)))
      return null;
    const expansion = opening.ownExpansion ?? (respectRules ? opening.ruleExpansion ?? ruleDefault : undefined) ?? policy.maskExpansion;
    return expandPad(land, expansion);
  }

  // The same resolved mask or stencil aperture feeds Gerber, IPC and ODB.
  function plotPad(f,o) {
    if(f.mask)return aperture(f.mask,f.pad,o,f.ruleDefault);
    const expansion=f.expandBy??(!o.overrideExpansions?f.ruleExpand:undefined)??(f.expand==="paste"?o.pasteExpansion:f.expand==="mask"?o.maskExpansion:0);
    return expandPad(f.pad,expansion);
  }

  function rulesForView(doc,project){
    return {mask:rulesFor(doc,project),paste:globalThis.AtriumRules?.expansionResolver?.(doc,"paste",{project})};
  }

  function collect({item,doc,project,defs,defaults,layers,landRules,emit,nominal}){
    if(!item)return;
    const part=item.kind==="part"?item:null;
    if(!part&&item.kind!=="pad"&&item.kind!=="via")return;
    const pads=part?PCB.readDefinition(defs,part.def,doc)?.footprint?.pads:[item];
    if(!pads?.length)return;
    const policy={...DEFAULTS,...defaults};
    const rules=landRules??rulesForView(doc,project),copper=layers.filter(l=>l.kind==="copper").map(l=>l.name);
    function flash(land,parent){
      const {at,angle,mirror}=L.place(land,parent);
      return {kind:"flash",aperture:C.aperture(land),at,clockwiseDegrees:angle,mirrorLocalX:mirror};
    }
    for(let i=0;i<pads.length;i++){
      const p=pads[i],member=part?["pad",String(i)]:[],roleLayer=PCB.padLayer(part,p),net=PCB.padNet(p,part)||null;
      const source=L.geometry(p);
      if(source)nominal(member,flash(source,part));
      for(const layer of copper){
        if(!PCB.onLayer(roleLayer,layer,p))continue;
        const land=C.film(p,layer,copper);
        if(land)emit(member,"land",layer,flash(land,part),{net});
      }
      if(source&&!p.drill){
        const role=/silk/i.test(roleLayer)?"legend":/ mask$/.test(roleLayer)?"mask":/ paste$/.test(roleLayer)?"paste":null;
        if(role)emit(member,role,roleLayer,flash(source,part),{net});
      }
      for(const {mask,land} of maskSeeds(p,part,padFaces(roleLayer,p.drill,PCB.index(roleLayer)>=0),rules.mask)){
        if(!land.min&&!(p.drill>0))continue;
        const opening=aperture(mask,land,policy,rules.mask?.defaultExpansion);
        if(opening?.w>0&&opening.h>0)emit(member,"mask",mask.face+" mask",flash(opening,part));
      }
      for(const [j,feature] of paste(p,part,roleLayer,L.geometry(p,roleLayer,copper),rules.paste).entries()){
        const land=plotPad(feature,policy);
        if(land)emit([...member,"paste",String(j)],"paste",roleLayer+" paste",{
          kind:"flash",aperture:C.aperture(land),at:feature.at,clockwiseDegrees:land.angle,mirrorLocalX:false
        });
      }
    }
  }

  return Object.freeze({FACES, DEFAULTS, openingShape:L.core, rulesFor, rulesForView, collect, pad, via, maskSeeds, aperture, padShape:(raw,w,h)=>L.shape(raw,w,h,true),
    padGeom:L.profile, padFaces, padLand, expandPad, placedProfile, paste, plotPad});
})();
