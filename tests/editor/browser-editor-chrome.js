"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const url = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const tolerance = .5;
const quickActions = ["open","save","undo","redo","history"];
const topControls = {
  ...Object.fromEntries(quickActions.map(action=>[action,`.quick-access button[data-action="${action}"]`])),
  share:"#collab-share"
};

async function measure(page,{peers = 0} = {}) {
  return page.evaluate(({top,peers}) => {
    if (peers) {
      const lock = globalThis.AtriumCollabLock, current = AtriumNavHost.currentId();
      // Feed presence data through the real renderer without starting a network session.
      globalThis.AtriumCollabLock = {manager:()=>({
        docState:()=>({viewers:[]}),
        people:()=>Array.from({length:peers},(_,index)=>({session:"fixture-"+index,name:"Reviewer "+index,viewing:[current],editing:[]}))
      })};
      try {AtriumCollabPresence.paintBadges();}
      finally {globalThis.AtriumCollabLock = lock;}
    }
    const one = selector => document.querySelector(selector);
    const box = element => {
      const r = element?.getBoundingClientRect();
      if (!r || !r.width || !r.height || getComputedStyle(element).visibility !== "visible") return null;
      return {x:r.x,y:r.y,w:r.width,h:r.height};
    };
    const styles = (element, props, pseudo) => {
      if (!element) return {};
      const css = getComputedStyle(element,pseudo);
      return Object.fromEntries(props.map(prop=>[prop,css.getPropertyValue(prop)]));
    };
    const pick = (element, props = []) => ({rect:box(element),...styles(element,props)});
    const all = (selector, map) => [...document.querySelectorAll(selector)].filter(box).map(map);
    const sizing = selector => pick(one(selector),["border-radius","font-size","font-weight","border-top-width","border-left-width"]);
    const icon = (node, centered) => {
      const glyph = [...node.querySelectorAll("svg.icon,img.brand-mark")].find(box);
      if (!glyph) return null;
      const from = box(node), to = box(glyph);
      return {name:node.getAttribute("aria-label") || node.dataset.action || node.dataset.dockTarget || node.className,
        regular:node.matches(".quick-access button,.dock-tab-more,.editor-tabbar .split-button,.document-tab"),
        dx:centered ? to.x + to.w/2 - from.x - from.w/2 : null,dy:to.y + to.h/2 - from.y - from.h/2,glyph:to};
    };
    const iconHosts = [".quick-access button", "#tools > button, #tools [role=group] > button",
      ".dock-tab-more", ".editor-tabbar .split-button", ".editor-tabbar [data-close-tab]",
      "#navigator .pane-heading button", "#properties .pane-heading button", ".view-palette button"];
    const labeledIconHosts = [".appbar .brand", "#collab-share", ".status-grid",
      ".document-tab", ".project-tree > summary", ".tree-folder > summary", "#documents .doc-row"];
    const icons = [...iconHosts.flatMap(selector=>all(selector,node=>icon(node,true))),
      ...labeledIconHosts.flatMap(selector=>all(selector,node=>icon(node,false)))].filter(Boolean);
    const triangle = one("#tools .has-flyout");
    const tab = one('#document-tabs [role="tab"][aria-selected="true"]');
    const propertyTab = one('[data-dock-tab="properties"]');
    const propertyHeading = box(propertyTab) ? propertyTab.closest(".dock-tabs") : one("#properties > .pane-heading");
    const propertyTitle = box(propertyTab) ? propertyTab : propertyHeading?.querySelector("h2");
    const tabRow = one(".editor-tabbar");
    const strip = one(".layer-bar"), activeLayer = one('.layer-tab.copper[aria-pressed="true"]');
    const tree = all(".project-tree > summary,.tree-folder > summary,#documents .doc-row",node => {
      const depth = node.matches(".doc-row") ? 2 + Number(node.dataset.depth || 0) :
        node.parentElement.classList.contains("project-tree") ? 0 : 1;
      const label = node.querySelector(".tree-label");
      const glyph = [...node.querySelectorAll(".tree-icon,svg.icon")].find(item=>!item.classList.contains("tree-chevron") && box(item));
      const row = box(node), parent = box(one(".panel-projects .panel-body"));
      return {depth,row,label:box(label),chevron:box(node.querySelector(".tree-chevron")),glyph:box(glyph),
        document:node.matches(".doc-row"),weight:getComputedStyle(node).fontWeight,
        selected:node.getAttribute("aria-current") === "true",inset:row.x - parent?.x,radius:styles(node,["border-radius"])["border-radius"]};
    });
    const colorProbe = document.createElement("span");
    colorProbe.hidden = true;
    document.body.append(colorProbe);
    const surface = document.createElement("canvas").getContext("2d",{willReadFrequently:true});
    const rgba = color => {
      if (!color || !CSS.supports("color",color)) return null;
      surface.clearRect(0,0,1,1);
      surface.fillStyle = color;
      surface.fillRect(0,0,1,1);
      return [...surface.getImageData(0,0,1,1).data];
    };
    const resolve = token => {
      colorProbe.style.color = token;
      return getComputedStyle(colorProbe).color;
    };
    const sampleTokens = ["--accent","--focus","--selection","--selection-ink","--raised","--ink","--muted",
      "--chrome","--bar-bg","--panel-head","--pressed","--layer-on","--line","--line-strong","--button-face-hover"];
    const colors = Object.fromEntries(sampleTokens.map(prop=>[prop,rgba(resolve("var("+prop+")"))]));
    for (const selector of [".appbar",".quick-access button","#collab-share",
      ".editor-tabbar",".document-tab[aria-selected=true]","#tools","#tools .tool[aria-pressed=true]",
      ".statusbar",".status-snap",
      "#documents [aria-current=true]","#inspector .pcb-edit-filter .ui-chip"]) {
      const node = one(selector);
      if (!box(node)) continue;
      const css = getComputedStyle(node);
      for (const prop of ["color","backgroundColor","borderTopColor","borderLeftColor"]) colors[selector+" "+prop] = rgba(css[prop]);
    }
    const chipStyles = node=>({height:box(node).h,radius:getComputedStyle(node).borderRadius,
      pressed:node.getAttribute("aria-pressed") === "true",hovered:node.matches(":hover"),
      fill:rgba(getComputedStyle(node).backgroundColor),outline:rgba(getComputedStyle(node).borderTopColor),ink:rgba(getComputedStyle(node).color),
      width:getComputedStyle(node).borderTopWidth});
    const chips = all("#inspector .pcb-edit-filter .ui-chip",chipStyles);
    const filter = one(".pcb-edit-filter-section"), filterHeading = filter?.querySelector(".inspect-section-heading");
    const filterBar = filter?.querySelector(".pcb-edit-filter"), filterAction = filterHeading?.querySelector(".selection-filter-all");
    const filterBody = box(filter?.querySelector(".ui-collapse")), barBox = box(filterBar), nextSection = box(filter?.nextElementSibling);
    const chipBoxes = all("#inspector .pcb-edit-filter .ui-chip",box);
    const layerDivider = one(".layer-group-divider");
    const activeTool = one('#tools .tool[aria-pressed="true"]');
    const chip = one("#inspector .pcb-edit-filter .ui-chip");
    const picker = one(".layer-menu-button");
    const hits = (node,scope) => {
      if (!box(node)) return null;
      const r = node.getBoundingClientRect(), x = r.left + r.width/2;
      const target = y => document.elementFromPoint(x,y)?.closest("button") === node;
      return {top:target(r.top-.5),bottom:target(r.bottom+.5),outside:scope && target(scope.getBoundingClientRect().top-.5)};
    };
    const indicators = {
      tab:rgba(styles(tab,["background-color"],"::after")["background-color"]),
      tool:rgba(styles(activeTool,["background-color"])["background-color"]),
      strong:rgba(resolve("var(--accent-strong,var(--primary))"))
    };
    const snap = one(".statusbar .status-snap");
    const snapDot = snap?.querySelector(".status-snap-dot,.snap-dot");
    const snapInk = snapDot ? getComputedStyle(snapDot).backgroundColor :
      styles(snap,["background-color"],"::before")["background-color"];
    const zero = one('#status-problems[data-state="ok"]');
    // Keycaps are measured on the palette's footer (the app bar has no Search field since 2026-11-23).
    const search = one(".nav-palette[open] .nav-palette-foot-btn:has(.ui-shortcut)"), share = one(top.share), shortcut = search?.querySelector(".ui-shortcut");
    const inlineText = node => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      return {rect:box(node),rects:[...range.getClientRects()].filter(r=>r.width && r.height).map(r=>({x:r.x,y:r.y,w:r.width,h:r.height})),
        text:node.textContent.trim()};
    };
    const snapColors = {snap:rgba(snapInk),zero:zero && rgba(getComputedStyle(zero).color),
      accent:colors["--accent"],success:rgba(resolve("var(--ok-ink)"))};
    const caps = !search ? [] : [...search.querySelectorAll(".ui-shortcut-cap")].map(cap=>{
      const css = getComputedStyle(cap);
      const glyph = cap.querySelector(".native-shortcut-ink") || cap.querySelector(".ui-shortcut-visual");
      const clipping = [];
      for (let element=glyph?.parentElement;element && element!==search;element=element.parentElement) {
        const css = getComputedStyle(element);
        if (["hidden","clip","auto","scroll"].includes(css.overflowX) && box(element)) clipping.push(box(element));
      }
      return {rect:box(cap),ink:box(glyph),font:cap.querySelector(".ui-shortcut-visual")?.textContent || "",
        native:!!glyph?.classList.contains("native-shortcut-ink"),shadow:css.boxShadow,clipping};
    });
    colorProbe.remove();
    const metrics = {
      kind:document.body.dataset.kind,
      coarse:matchMedia("(any-pointer:coarse)").matches,
      geometry:{
        menu:sizing(".appbar"),mark:sizing(".appbar .brand-mark"),brand:(node=>node && {...pick(node),tag:node.localName,label:node.getAttribute("aria-label"),role:node.getAttribute("role"),
          parent:box(node.parentElement),ink:getComputedStyle(node).stroke,color:getComputedStyle(node.parentElement).color})(one(".appbar .brand-wordmark")),
        project:sizing(".panel-projects > .pane-heading"),projectTitle:sizing(".panel-projects > .pane-heading h2"),
        properties:pick(propertyHeading),propertiesTitle:pick(propertyTitle,["font-size"]),
        tabs:box(tabRow),status:sizing(".statusbar"),
        bar:pick(one("#tools"),["padding","border-radius"]),split:sizing(".editor-tabbar .split-button")
      },
      menus:all(".menubar .work-menu > summary",node=>({
        ...pick(node,["font-size","padding-inline-start","padding-inline-end"]),label:node.textContent.trim()
      })),
      quick:all(".quick-access button",node=>({action:node.dataset.action,...pick(node,["border-radius"])})),
      toolbar:all("#tools button.tool",node=>pick(node,["border-radius"])),
      toolMarks:all("#tools button.tool[data-tool-group]",node=>styles(node,["width","height","opacity"],"::after")),
      activeToolInk:styles(activeTool,["color"]).color,
      tabsRight:tab?.parentElement.getBoundingClientRect().right,
      tabBarButtons:all(".editor-tabbar > button",node=>box(node)),
      splitControls:all(".editor-tabbar .split-button",node=>box(node)),
      dividers:all(".quick-access .tool-divider,#tools .tool-divider",node=>box(node).w),
      triangle:styles(triangle,["width","height","border-bottom-width","border-right-width","opacity","content"],"::after"),
      tops:Object.fromEntries(Object.entries(top).map(([key,selector])=>[key,box(one(selector))])),
      shareText:inlineText(share?.querySelector("span:not(.ui-dot)")),
      shareBorder:styles(share,["border-top-width","border-top-color","white-space"]),
      caps,capsHost:box(search),shortcutBox:box(shortcut),icons,tree,
      peerCount:document.querySelectorAll("#collab-faces .collab-person").length,
      more:box(one("#collab-more")),
      menuStructure:{
        theme:!!one('.work-menu[data-menu=view] #sub-view-theme [data-action=theme-preferences]'),
        panels:!!one('.work-menu[data-menu=window] #sub-window-panels')
      },
      // No icon rail: panels live in dock tabs and Window › Panels, and the right side bar meets the window edge.
      rightEdge:{rails:document.querySelectorAll(".panel-rail").length,columns:getComputedStyle(one("#workbench")).gridTemplateColumns.split(" ").length,
        properties:box(one("#properties")),workbench:box(one("#workbench"))},
      tabLine:Object.fromEntries(["::before","::after"].map(pseudo=>[pseudo,
        styles(tab,["height","inset-inline-start","inset-inline-end","background-color","content"],pseudo)])),
      tab:box(tab), close:pick(tab?.querySelector(".document-tab-close"),["opacity","pointer-events"]),
      closeGlyph:styles(tab?.querySelector(".document-tab-close"),["width","height"],"::before"),
      inactiveClose:all('#document-tabs .document-tab[aria-selected="false"] .document-tab-close',node=>styles(node,["opacity"])),
      docTabs:all("#document-tabs .document-tab",node=>({selected:node.getAttribute("aria-selected")==="true",
        fill:rgba(getComputedStyle(node).backgroundColor),weight:getComputedStyle(node).fontWeight})),
      coords:pick(one("#coords"),["font-variant-numeric","flex-shrink"]),
      statusButtons:all(".statusbar .status-action",node=>pick(node,["font-size","border-top-width"])),
      propertyRows:all("#inspector div.ui-prop-row:has(> .ui-prop-value)",node=>box(node)),
      snapColors,chips,colors,indicators,
      filterHeader:{rect:box(filterHeading),action:box(filterAction),text:styles(filterAction,["text-decoration-line"])["text-decoration-line"],
        edge:getComputedStyle(filterHeading || document.body).paddingInlineEnd,
        afterChips:barBox && chipBoxes.length ? barBox.y + barBox.h - Math.max(...chipBoxes.map(n=>n.y+n.h)) : null,
        beforeNext:filterBody && nextSection && nextSection.y - filterBody.y - filterBody.h},
      touchTargets:{chip:hits(chip),layer:hits(picker,strip)},
      layer:strip && {bar:box(strip),trigger:box(strip.querySelector(".layer-menu-button")),
        pills:all(".layer-bar .layer-tab",node=>box(node)),
        weights:all(".layer-bar .layer-tab.copper",node=>getComputedStyle(node).fontWeight),
        divider:layerDivider && {box:box(layerDivider),previous:box(layerDivider.previousElementSibling),next:box(layerDivider.nextElementSibling),
          hidden:layerDivider.getAttribute("aria-hidden")},
        swatches:all(".layer-bar .layer-swatch",node=>box(node)),
        active:styles(activeLayer,["outline-width","outline-color","border-top-width","border-top-color","box-shadow"])},
      insert:box(one(".palette-insert-launch"))
    };
    if (peers) AtriumCollabPresence.paintBadges();
    return metrics;
  },{top:topControls,peers});
}

function rounded(value) {return typeof value === "number" ? Math.round(value * 1000)/1000 : value;}
function closeTo(actual,wanted) {return Number.isFinite(actual) && Math.abs(actual-wanted) <= tolerance;}
function equalPaletteColor(left,right) {
  return left && right && left.every((value,index)=>Math.abs(value-right[index])<=1);
}

function geometryProblems(m) {
  const problems = [];
  const check = (condition,label,data) => {if (!condition) problems.push(`${label}${data === undefined ? "" : " " + JSON.stringify(data)}`);};
  const dimension = (actual,wanted,label) => check(closeTo(actual,wanted),label,{actual:rounded(actual),wanted});
  const property = (node,key,expected,label) => dimension(parseFloat(node?.[key]),expected,label+" "+key);
  const rect = (node,w,h,label) => {
    if (w != null) dimension(node?.w,w,label+" width");
    if (h != null) dimension(node?.h,h,label+" height");
  };
  const g = m.geometry;
  rect(g.menu.rect,null,30,"menu bar");
  rect(g.mark.rect,16,16,"brand mark");
  check(g.brand?.tag==="svg" && g.brand.role==="img" && g.brand.label==="Waffle","the app bar brand is the SVG wordmark named Waffle",g.brand && {tag:g.brand.tag,role:g.brand.role,label:g.brand.label});
  rect(g.brand?.rect,51,18,"Waffle wordmark");
  check(g.brand && [g.brand.rect.x,g.brand.rect.y,g.brand.rect.w,g.brand.rect.h].every(Number.isInteger),"the wordmark box is whole pixels",g.brand?.rect);
  check(g.brand && Math.abs(g.brand.rect.y + g.brand.rect.h/2 - g.brand.parent.y - g.brand.parent.h/2) < 0.01,"the wordmark is centred in the brand row",g.brand?.rect);
  check(g.brand?.ink===g.brand?.color,"the wordmark takes the theme ink",g.brand && [g.brand.ink,g.brand.color]);
  check(m.menus.length>=5,"main menu headings are visible");
  check(m.menus[0]?.label==="File" && m.menus.at(-1)?.label==="Help",
    "the menu bar begins with File and ends with Help",m.menus.map(menu=>menu.label));
  check(m.menus.every(menu=>Number.isInteger(menu.rect.x) && Number.isInteger(menu.rect.w)),
    "top-level menu titles sit on whole pixels",m.menus);
  for (const menu of m.menus) {
    property(menu,"font-size",13,"menu label");
    property(menu,"padding-inline-start",8,"menu label");
    property(menu,"padding-inline-end",8,"menu label");
  }
  rect(g.project.rect,null,32,"Projects header");
  property(g.projectTitle,"font-size",12,"Projects title");
  rect(g.properties.rect,null,32,"Properties header");
  property(g.propertiesTitle,"font-size",12,"Properties title");
  rect(g.tabs,null,32,"document tabs");
  rect(g.status.rect,null,24,"status bar");
  for (const button of m.statusButtons) {
    property(button,"font-size",11,"status button");
    property(button,"border-top-width",0,"plain status button");
  }
  check(m.coords["font-variant-numeric"]?.includes("tabular-nums") && m.coords["flex-shrink"]==="0","fixed tabular coordinates",m.coords);
  const actions = m.quick.map(button=>button.action);
  check(actions.length===quickActions.length && actions.every((action,i)=>action===quickActions[i]),
    "quick access actions are Open, Save, Undo, Redo and History in order",actions);
  for (const button of m.quick) {
    rect(button.rect,28,24,"quick action");
    property(button,"border-radius",6,"quick action");
  }
  check(m.toolbar.length>=5,"real Active Bar tools are visible");
  for (const tool of m.toolbar) {
    rect(tool.rect,28,28,"active tool");
    property(tool,"border-radius",6,"active tool");
  }
  property(g.bar,"padding",3,"active tool group");
  property(g.bar,"border-radius",8,"active tool group");
  check(m.dividers.length>=2 && m.dividers.every(w=>closeTo(w,1)),"one-pixel tool dividers",m.dividers);
  const triangle = m.triangle;
  const triangleSize = Math.max(...["width","height","border-bottom-width","border-right-width"].map(key=>parseFloat(triangle[key])||0));
  dimension(triangleSize,5,"flyout triangle size");
  check(Math.abs(parseFloat(triangle.opacity)-.6)<=.01,"flyout triangle opacity",triangle.opacity);
  check(m.toolMarks.length>0 && m.toolMarks.every(mark=>parseFloat(mark.width)===5 &&
    parseFloat(mark.height)===5 && Number(mark.opacity)===.6),"all tool-group triangles are 5×5 at 0.6 opacity",m.toolMarks);

  const controls = Object.values(m.tops);
  check(controls.every(Boolean),"Open, Save, Undo, Redo, History and Share are present",m.tops);
  if (controls.every(Boolean)) {
    check(controls.every((control,i)=>!i || controls[i-1].x + controls[i-1].w <= control.x + tolerance),"top control order",m.tops);
  }
  const contains = (parent,child) => !!parent && !!child && child.x>=parent.x-tolerance && child.y>=parent.y-tolerance &&
    child.x+child.w<=parent.x+parent.w+tolerance && child.y+child.h<=parent.y+parent.h+tolerance;
  if (m.caps.length) check(contains(m.capsHost,m.shortcutBox),"the shortcut stays within its button",m.shortcutBox);
  for (const [index,cap] of m.caps.entries()) {
    rect(cap.rect,null,20,"keycap");
    check(cap.rect.w>=20,"keycap respects the shared minimum width",cap.rect.w);
    if (index>0) dimension(cap.rect.x-m.caps[index-1].rect.x-m.caps[index-1].rect.w,4,"keycap gap");
    check(contains(cap.rect,cap.ink),"shortcut glyph fits its keycap",cap);
    check(cap.clipping.every(clip=>contains(clip,cap.ink)),"shortcut glyph fits its clipping ancestors",cap);
    check(contains(m.capsHost,cap.ink),"shortcut glyph stays clear of its button edges",cap);
    if (cap.shadow !== "none") {
      const [x=0,y=0,blur=0,spread=0] = (cap.shadow.match(/-?(?:[0-9]*\.)?[0-9]+px/g)||[]).map(parseFloat);
      const extra = blur + spread;
      const shadow = {x:cap.rect.x+x-extra,y:cap.rect.y+y-extra,w:cap.rect.w+2*extra,h:cap.rect.h+2*extra};
      check(contains(m.capsHost,shadow),"shortcut shadow fits its button",shadow);
    }
  }
  check(m.shareText?.rects.length===1 && contains(m.tops.share,m.shareText.rects[0]),"Share label is a single unclipped line",m.shareText);
  property(m.shareBorder,"border-top-width",1,"outlined Share");
  check(m.shareBorder["white-space"]==="nowrap","Share prevents wrapping",m.shareBorder);
  check(m.menuStructure.theme,"Theme appears under View");
  check(m.menuStructure.panels,"Panels appears under Window");

  check(m.icons.length>=15,"visible chrome glyphs were sampled",m.icons.length);
  for (const glyph of m.icons) {
    dimension(glyph.dy,0,glyph.name+" icon y center");
    if (glyph.dx != null) dimension(glyph.dx,0,glyph.name+" icon x center");
    if (glyph.regular) rect(glyph.glyph,16,16,glyph.name+" chrome glyph");
  }
  const edge = m.rightEdge;
  check(edge.rails===0 && edge.columns<=3,"no panel rail column beside Properties",edge);
  if (edge.properties) dimension(edge.properties.x+edge.properties.w,edge.workbench.x+edge.workbench.w,"Properties meets the right window edge");
  check(equalPaletteColor(m.indicators.tool,m.indicators.strong),"active tool uses the filled accent",m.indicators.tool);
  check(m.activeToolInk==="rgb(255, 255, 255)","active tool foreground is white",m.activeToolInk);

  check(m.tree.length>=4,"real tree rows are present",m.tree.length);
  const depthX = new Map();
  for (const row of m.tree) {
    rect(row.row,null,24,"tree depth "+row.depth+" row");
    rect(row.glyph,16,16,"tree depth "+row.depth+" icon");
    if (row.depth<2) rect(row.chevron,12,12,"tree depth "+row.depth+" chevron");
    check(!!row.label,"tree depth "+row.depth+" has a label");
    if (row.label) {
      if (depthX.has(row.depth)) dimension(row.label.x,depthX.get(row.depth),"tree level "+row.depth+" x alignment");
      else depthX.set(row.depth,row.label.x);
    }
    if (row.selected) {
      dimension(row.inset,6,"selected tree inset");
      dimension(parseFloat(row.radius),6,"selected tree radius");
    }
  }
  const depths = [...depthX].sort((a,b)=>a[0]-b[0]);
  check(depths.length>=3,"the tree exercises three rendered depths",depths);
  for (let i=1;i<depths.length;i++) dimension(depths[i][1]-depths[i-1][1],14*(depths[i][0]-depths[i-1][0]),"tree depth step");
  const documents = m.tree.filter(row=>row.document);
  check(documents.some(row=>row.selected) && documents.some(row=>!row.selected) &&
    new Set(documents.map(row=>row.weight)).size===1,"selected and inactive tree rows share a weight",documents.map(row=>row.weight));

  const line = Object.values(m.tabLine).find(pseudo=>pseudo.content!=="none" && closeTo(parseFloat(pseudo.height),2));
  check(!!line,"active tab has a 2px underline",m.tabLine);
  if (line) {
    property(line,"inset-inline-start",8,"active tab line");
    property(line,"inset-inline-end",8,"active tab line");
    check(equalPaletteColor(m.indicators.tab,m.colors["--accent"]),"active tab underline uses accent",m.indicators.tab);
  }
  check(!!m.tab && !!g.split.rect && g.split.rect.x>m.tab.x,"split control follows document tabs");
  check(m.tabBarButtons.length>0 && m.tabBarButtons.every(control=>control.x>=m.tabsRight),
    "tab bar buttons stay after the document tab row",m.tabBarButtons);
  check(m.splitControls.length>=1,"editor split controls are visible",m.splitControls);
  for (const control of m.splitControls) {
    rect(control,28,24,"split control");
    dimension(control.y + control.h / 2,g.tabs?.y + g.tabs?.h / 2,"split control centered in tab strip");
  }
  check(m.docTabs.some(tab=>tab.selected) && m.docTabs.some(tab=>!tab.selected) &&
    m.docTabs.every(tab=>tab.weight==="400" && (tab.selected || tab.fill?.[3]===0)),
    "document tabs use regular weight and transparent inactive fill",m.docTabs);
  const luma = ([red,green,blue]) => .2126*red+.7152*green+.0722*blue;
  const activeFill=m.docTabs.find(tab=>tab.selected)?.fill, inactiveFill=m.docTabs.find(tab=>!tab.selected)?.fill;
  check(activeFill && inactiveFill && luma(activeFill)>luma(inactiveFill),"active tab fill is lighter than inactive fill");
  check(m.close.rect && m.close.opacity==="1" && m.close["pointer-events"]==="auto","active tab close is visible and reachable",m.close);
  property(m.closeGlyph,"width",14,"document tab close glyph");
  property(m.closeGlyph,"height",14,"document tab close glyph");
  if (!m.coarse) check(m.inactiveClose.every(node=>node.opacity==="0"),"inactive tab close rests hidden",m.inactiveClose);

  check(m.chips.length>0,"Properties selection filter is present");
  const filter = m.filterHeader;
  check(filter.action && filter.rect,"Select all is part of the Selection Filter header",filter);
  if (filter.action && filter.rect) {
    dimension(filter.action.y+filter.action.h/2,filter.rect.y+filter.rect.h/2,"Select all is vertically centered");
    dimension(filter.rect.x+filter.rect.w-filter.action.x-filter.action.w,parseFloat(filter.edge),"Select all aligns to the content edge");
    check(filter.text==="none","Select all has no idle underline",filter.text);
  }
  dimension(filter.afterChips,8,"space after Selection Filter chips");
  dimension(filter.beforeNext,8,"space between Selection Filter content and the next header");
  for (const chip of m.chips) {
    dimension(chip.height,22,"selection chip height (the shared 22 px toggle chip)");
    dimension(parseFloat(chip.radius),6,"selection chip radius");
    if (chip.pressed) {
      check(equalPaletteColor(chip.fill,m.colors["--raised"]),"selected chip uses a neutral fill",chip.fill);
      check(equalPaletteColor(chip.ink,m.colors["--ink"]),"selected chip uses ink text",chip.ink);
    }
    else {
      check(chip.fill?.[3]===0,"inactive chip has a transparent fill",chip.fill);
      dimension(parseFloat(chip.width),1,"inactive chip outline");
      check(equalPaletteColor(chip.outline,m.colors["--line"]),"inactive chip uses the muted outline",chip.outline);
      check(equalPaletteColor(chip.ink,m.colors["--muted"]),"inactive chip uses muted ink",chip.ink);
    }
  }
  for (const row of m.propertyRows) rect(row,null,m.coarse ? 44 : 32,"Properties row"); // a field row's height (docs/ui-library.md › Property rows)
  if (m.kind==="pcb") {
    const layer = m.layer;
    rect(layer?.bar,null,30,"PCB layer strip");
    rect(layer?.trigger,null,22,"PCB layer picker");
    check((layer?.pills.length||0)>=2,"visible copper layers");
    check(layer?.weights.length>=2 && new Set(layer.weights).size===1,"copper layer tabs share one weight",layer?.weights);
    const divider = layer?.divider;
    if (divider?.box && divider.previous && divider.next) {
      rect(divider.box,1,16,"copper group divider");
      dimension(divider.box.x-divider.previous.x-divider.previous.w,8,"space before copper group divider");
      dimension(divider.next.x-divider.box.x-divider.box.w,8,"space after copper group divider");
      check(divider.hidden==="true","cosmetic copper divider is hidden from accessibility APIs");
    } else check(false,"copper group divider is visible",divider);
    for (let i=1;i<(layer?.pills.length||0);i++) {
      const previous=layer.pills[i-1], current=layer.pills[i];
      const gap=current.x-previous.x-previous.w;
      if (divider?.box && previous.x < divider.box.x && current.x > divider.box.x) dimension(gap,17,"copper group gap");
      else dimension(gap,4,"ordinary layer pill gap");
    }
    for (const pill of layer?.pills || []) rect(pill,null,22,"layer pill");
    for (const swatch of layer?.swatches || []) rect(swatch,9,9,"layer swatch");
    check(layer?.active && (parseFloat(layer.active["outline-width"])===1 ||
      parseFloat(layer.active["border-top-width"])===1 || /\b1px\b/.test(layer.active["box-shadow"])),
    "active layer has a one-pixel outline",layer?.active);
    check(equalPaletteColor(m.snapColors.snap,m.snapColors.accent),"Snap on dot uses accent",m.snapColors);
    if (m.snapColors.zero) check(equalPaletteColor(m.snapColors.zero,m.snapColors.success),"zero problems has its success color",m.snapColors.zero);
  } else check(!m.layer?.bar,"layer strip is hidden on schematics");
  if (m.coarse) {
    rect(m.insert,44,44,"touch Insert button");
    check(m.touchTargets.chip?.top && m.touchTargets.chip?.bottom,"touch chip has safe hit slop",m.touchTargets.chip);
    if (m.kind==="pcb") check(m.touchTargets.layer?.top && m.touchTargets.layer?.bottom && !m.touchTargets.layer.outside,
      "touch layer hit slop stays within the strip",m.touchTargets.layer);
  } else check(!m.insert,"desktop floating Insert is hidden");
  for (const [name,color] of Object.entries(m.colors)) {
    if (!color || !color[3]) continue;
    const [r,g,b] = color;
    const hue = r>b ? 60*(g-b)/(r-b) : -1;
    check(!(r>=g && g>b && r>=130 && r-b>=46 && hue>=28 && hue<=63),"amber found in ornamental chrome "+name,color);
  }
  return problems;
}

function fixedProblems(before,after) {
  return Object.keys(topControls).flatMap(key=>{
    const previous = before[key], current = after[key];
    return previous && current && ["x","y","w","h"].every(prop=>closeTo(current[prop],previous[prop]))
      ? [] : [`${key} moved ${JSON.stringify({before:previous,after:current})}`];
  });
}

async function settle(page) {
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
}

async function withStyle(page,css,fn) {
  const style = await page.addStyleTag({content:css});
  try {await fn();}
  finally {await style.evaluate(node=>node.remove());}
}

async function proveSensitivity(page,baseline) {
  const baselineProblems = geometryProblems(baseline), proof = {};
  await withStyle(page,".quick-access [data-action=open]{translate:1px 0 !important}",async()=>{
    proof.open = fixedProblems(baseline.tops,(await measure(page)).tops).find(line=>line.startsWith("open moved"));
    assert.ok(proof.open,"one-pixel toolbar drift must fail");
  });
  const mutations = [
    ["history",`${topControls.history}{display:none !important}`,/^quick access actions/],
    ["historyIcon",`${topControls.history} .icon{translate:1px 0 !important}`,/^History icon x center/],
    ["icon","#tools [data-action=select] .icon{translate:0 1px !important}",/icon y center/],
    ["tree","#documents .doc-row:first-child .tree-label{translate:1px 0 !important}",/^tree (level|depth step)/],
    ["tab",'#document-tabs .document-tab[aria-selected="true"]::after{inset-inline-start:9px !important}',/^active tab line inset-inline-start/],
    ["status",".statusbar{height:25px !important}",/^status bar height/]
  ];
  for (const [name,css,reason] of mutations) {
    await withStyle(page,css,async()=>{
      proof[name] = geometryProblems(await measure(page)).find(problem=>!baselineProblems.includes(problem)&&reason.test(problem));
      assert.ok(proof[name],`${name} regression must fail`);
    });
  }
  return proof;
}

async function switchTo(page,kind,touch = false) {
  const target = page.locator(`#document-tabs [data-kind="${kind}"]`).first();
  if (touch) await target.tap();
  else await target.click();
  await page.waitForFunction(kind=>document.body.dataset.kind===kind && AtriumNavHost.doc().kind===kind,kind);
  await settle(page);
}

async function menuScopeRefresh(page) {
  await switchTo(page,"schematic");
  const result=await page.evaluate(()=>{
    const host=AtriumNavHost,view=document.querySelector('.menubar .work-menu[data-menu="view"]');
    const refresh=()=>AtriumWorkbench.sync(host.project().documents,host.currentId(),host.selectDocument,host.doc().grid,host.units());
    refresh();
    const query=view.querySelectorAll;
    let walks=0;
    view.querySelectorAll=function(selector){if(selector===".menu-items")walks++;return query.call(this,selector);};
    try{refresh();}
    finally{delete view.querySelectorAll;}
    const menu=document.createElement("details"),list=document.createElement("div");
    menu.className="work-menu";list.className="menu-items";menu.append(list);
    const rows=[["hr","leading"],["button","first","schematic"],["hr","group"],["span","hidden"],
      ["hr","adjacent"],["button","board","pcb"],["hr","extra"],["button","last","schematic"],["hr","end"]];
    for(const [tag,name,scope] of rows){
      const node=document.createElement(tag);
      node.dataset.label=name;
      if(scope)node.dataset.scope=scope;
      if(tag==="span")node.hidden=true;
      list.append(node);
    }
    document.body.append(menu);
    refresh();
    const separators=[...list.children].filter(node=>!node.hidden).map(node=>node.dataset.label);
    menu.remove();
    refresh();
    // Mount a real action after the schematic's scope is already cached.
    const item=document.createElement("button");
    item.id="scope-refresh-board-grid";
    item.dataset.scope="pcb";
    item.dataset.action="grid";
    item.setAttribute("role","menuitem");
    view.querySelector(".menu-items").append(item);
    return {walks,separators};
  });
  assert.deepEqual(result,{walks:0,separators:["first","group","last"]});
  const menu=page.locator('.menubar .work-menu[data-menu="view"]');
  await menu.locator("summary").click();
  const added=menu.locator("#scope-refresh-board-grid");
  assert.deepEqual(await added.evaluate(node=>[node.hidden,node.getAttribute("role")]),[true,"menuitemcheckbox"]);
  const grid=menu.locator('[data-action="grid"]:not(#scope-refresh-board-grid)').first();
  const initial=await grid.getAttribute("aria-checked");
  await grid.click();
  await menu.locator("summary").click();
  assert.equal(await grid.getAttribute("aria-checked"),initial==="true"?"false":"true");
  await grid.click();
  await added.evaluate(node=>node.remove());
}

async function preferences(page,touch) {
  const file = page.locator('.menubar .work-menu[data-menu="file"]');
  const action = touch ? "tap" : "click";
  await file.locator("summary")[action]();
  await file.locator('[data-action="preferences"]')[action]();
  const dialog = page.getByRole("dialog",{name:"Preferences",exact:true});
  await dialog.waitFor();
  return dialog;
}

async function openSearch(page) {
  const view = page.locator('.work-menu[data-menu="view"]');
  await view.locator("summary").click();
  await view.locator('[data-action="search"]').click();
  return page.locator("#palette");
}

async function controlsWork(page) {
  const palette = await openSearch(page);
  await palette.getByRole("combobox").waitFor();
  assert.ok(await palette.getByRole("combobox").evaluate(input=>input===document.activeElement));
  await page.keyboard.press("Escape");
  await palette.waitFor({state:"hidden"});
  const [picking] = await Promise.all([page.waitForEvent("filechooser"),page.locator(topControls.open).click()]);
  await picking.setFiles([]);
  const before = await measure(page);
  const identity = await page.evaluate(()=>{
    const host=AtriumNavHost, item=host.doc().items.find(item=>item.kind==="part"&&!item.locked);
    const x=item.x;
    host.edit(()=>{item.x+=1;},"Chrome fixture move");
    return {id:item.id,x};
  });
  const position = () => page.evaluate(id=>AtriumNavHost.doc().items.find(item=>item.id===id).x,identity.id);
  const moved = await measure(page);
  assert.deepEqual(fixedProblems(before.tops,moved.tops),[],"enabling Undo never shifts controls");
  await page.locator(topControls.undo).click();
  assert.equal(await position(),identity.x);
  await page.locator(topControls.redo).click();
  assert.equal(await position(),identity.x+1);
  assert.deepEqual(fixedProblems(moved.tops,(await measure(page)).tops),[],"Undo/Redo availability never shifts controls");
  await page.evaluate(async()=>{if (!await AtriumNavHost.saveAll({download:false})) throw Error("Scratch project save failed");});
  await page.evaluate(()=>AtriumNavHost.edit(()=>{AtriumNavHost.doc().name+=" edited";}));
  await page.locator(topControls.save).click();
  await page.waitForFunction(()=>!AtriumNavHost.isDirty());
  await page.locator(topControls.share).click();
  const sharing = page.getByRole("dialog",{name:/live session|share/i}).first();
  await sharing.waitFor();
  await page.keyboard.press("Escape");
  await sharing.waitFor({state:"hidden"});
}

function mockMacShortcutHost() {
  Object.defineProperty(navigator,"platform",{value:"MacIntel"});
  document.documentElement.dataset.atriumNativeTitlebar="macos";
  document.documentElement.style.setProperty("--macos-caption-inset","78px");
  // Replay an AppKit-sized mask through the real host bridge and shared presentation.
  const bitmap=document.createElement("canvas");
  bitmap.width=45; bitmap.height=45;
  bitmap.getContext("2d").fillRect(0,0,45,45);
  const png=bitmap.toDataURL().split(",")[1];
  // Width ratios are from 12-point AppKit menu-key artwork on macOS.
  const widths={"⇧":1.25,"⌘":14/12,"P":8/12,"K":8/12,"⏎":1};
  window.webkit={messageHandlers:{atriumHost:{postMessage(text) {
    const {action,id,labels}=JSON.parse(text);
    if (id==null) return;
    const value=action==="macShortcutGlyphs" ? Object.fromEntries(labels.filter(label=>widths[label]).map(label=>
      [label,{png,width:widths[label],height:1.25,descent:.25}])) : null;
    window.__atriumReceive(id,value,null);
  }}}};
}

async function verifyNativeSearch(browser,viewport,errors) {
  // WKWebView provides the bridge at document start. Use a separate page so the native
  // fixture starts before the palette is built and the ordinary web checks keep their own host.
  const page = await browser.newPage({viewport,colorScheme:"light",reducedMotion:"reduce"});
  page.setDefaultTimeout(7000);
  page.on("pageerror", error=>errors.push(error.message));
  page.on("console", message=>{if (message.type()==="error") errors.push(message.text());});
  try {
    const [html,bridge] = await Promise.all([
      fs.readFile(path.join(__dirname,"../../app/index.html"),"utf8"),
      fs.readFile(path.join(__dirname,"../../native/bridge.js"),"utf8")
    ]);
    const body = html.replace("<head>", `<head><script>(${mockMacShortcutHost})();
${bridge}</script>`);
    await page.route(url, route=>route.fulfill({contentType:"text/html; charset=utf-8",body}), {times:1});
    await require("../fixtures/notebook-labs.cjs").profile(page);
    await page.goto(url);
    const welcome = page.locator("dialog.sp-dialog[open]");
    await welcome.locator("[data-start-action=demo]").click();
    await welcome.waitFor({state:"hidden"});

    const nativeInk = key=>`.nav-palette-foot-btn .ui-shortcut-cap[data-native-shortcut="${key}"][data-native-rendered] .native-shortcut-ink`;
    const issues = m=>geometryProblems(m).filter(line=>/shortcut|Share|Search icon/i.test(line));
    async function openAndMeasure() {
      const dialog = await openSearch(page);
      await dialog.getByRole("combobox").fill(">Fit Document");
      await dialog.getByRole("button",{name:"Actions",exact:true}).waitFor();
      for (const key of ["⏎","⌘","K"]) await dialog.locator(nativeInk(key)).waitFor();
      const metrics=await measure(page);
      assert.ok(metrics.caps.length && metrics.caps.every(cap=>cap.native),"every native mask uses the real shared renderer");
      assert.deepEqual(issues(metrics),[],"native Search ink and Share label fit");
      return metrics;
    }
    const cold = await openAndMeasure();
    await page.keyboard.press("Escape");
    await page.locator("#palette").waitFor({state:"hidden"});
    const warm = await openAndMeasure();

    const cap=warm.caps[0], offset=cap.ink.x-cap.rect.x+1;
    let rejected;
    await withStyle(page,`.nav-palette-foot-btn .ui-shortcut-cap:first-child .native-shortcut-ink{translate:${-offset}px 0 !important}`,async()=>{
      rejected=issues(await measure(page)).find(line=>line.includes("glyph fits its keycap"));
      assert.ok(rejected,"one pixel of native mask clipping fails");
    });
    return {coldCaps:cold.caps,caps:warm.caps,search:warm.capsHost,share:warm.tops.share,rejected};
  } finally { await page.close(); }
}

async function zeroProblems(page) {
  await page.evaluate(async()=>{
    const host=AtriumNavHost;
    await host.replaceProject(Atrium.project("No problems",[]),{force:true,dirty:false});
    await AtriumLazy.need("AtriumChecks");
  });
  await page.locator('#status-problems[data-state="ok"]').waitFor();
  const {zero,success}=(await measure(page)).snapColors;
  assert.ok(equalPaletteColor(zero,success) && zero[1]>zero[0] && zero[1]>zero[2],"zero problems uses the green success token");
}

async function selectionAndSnap(page) {
  const chip=page.locator('#inspector .pcb-edit-filter .ui-chip[aria-pressed="true"]').first();
  const label=await chip.textContent();
  await chip.click();
  const off=page.locator('#inspector .pcb-edit-filter .ui-chip[aria-pressed="false"]').filter({hasText:label}).first();
  await off.waitFor();
  // The click rebuilds the filter, and the pointer can hover the replacement chip.
  await page.mouse.move(1,1);
  await page.locator("#inspector .pcb-edit-filter .ui-chip:hover").waitFor({state:"hidden"});
  // The fill eases back over --motion-instant; under load a measure can land inside that fade.
  await page.locator("#inspector .pcb-edit-filter .ui-chip").evaluateAll(nodes=>Promise.all(nodes.flatMap(node=>node.getAnimations()).map(animation=>animation.finished)));
  assert.deepEqual(geometryProblems(await measure(page)).filter(x=>x.startsWith("inactive chip")),[]);
  await off.hover();
  await off.and(page.locator(":hover")).waitFor();
  // Hover changes the fill over --motion-instant and keeps the resting border (docs/ui-library.md › Chips).
  await off.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
  const hover=await measure(page),hovered=hover.chips.find(chip=>!chip.pressed && chip.hovered);
  assert.deepEqual(hovered?.outline,hover.colors["--line"],"hovered inactive chip keeps its resting outline");
  assert.ok(equalPaletteColor(hovered.fill,hover.colors["--button-face-hover"]) && hovered.fill[3]>0,
    "hovered inactive chip takes the library hover fill: "+hovered.fill);
  await off.click();
  const snap=page.locator(".statusbar .status-snap:visible");
  await snap.click();
  const options=page.getByRole("dialog",{name:"Snap options",exact:true});
  const objects=options.getByRole("checkbox",{name:"Snap to objects",exact:true});
  await objects.uncheck();
  assert.equal(await snap.getAttribute("aria-pressed"),"false");
  const disabled=await measure(page);
  assert.ok(!equalPaletteColor(disabled.snapColors.snap,disabled.snapColors.accent),"Snap Off loses the accent dot");
  await objects.check();
  assert.equal(await snap.getAttribute("aria-pressed"),"true");
  await page.keyboard.press("Escape");
  await options.waitFor({state:"hidden"});
  const layers=page.locator(".layer-menu-button");
  await layers.click();
  const menu=page.getByRole("menu",{name:"All layers",exact:true});
  await menu.waitFor();
  assert.ok(await menu.getByRole("menuitemradio").count()>=3);
  await page.keyboard.press("Escape");
  await menu.waitFor({state:"hidden"});
}

module.exports = async function editorChrome(browser,{report} = {}) {
  const results = [];
  const failures = [];
  for (const [width,height] of [[1440,900],[1280,800]]) {
    for (const [theme,touch] of [["light",false],["dark",false],["light",true]]) {
      const page = await browser.newPage({viewport:{width,height},colorScheme:theme,hasTouch:touch,reducedMotion:"reduce"});
      const errors = [], title = `${width}×${height} ${touch ? "touch" : theme}`;
      const tested = {width,height,theme,touch,documents:{}};
      results.push(tested);
      page.setDefaultTimeout(7000);
      page.on("pageerror", error=>errors.push(error.message));
      page.on("console", message=>{if (message.type()==="error") errors.push(message.text());});
      await page.addInitScript(()=>{Object.defineProperty(navigator,"platform",{value:"MacIntel"});});
      await require("../fixtures/notebook-labs.cjs").profile(page);
      try {
        await page.goto(url);
        await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
        await page.waitForFunction(()=>!!AtriumNavHost.project()?.documents.length);
        await page.evaluate(theme=>AtriumTheme.set({preset:theme,followSystem:false},{persist:false}),theme);
        const selectionFilter = page.locator("#inspector .pcb-edit-filter-section .section-toggle");
        await selectionFilter.waitFor();
        assert.equal(await selectionFilter.getAttribute("aria-expanded"), "false", "Properties initially collapses the Selection Filter");
        await selectionFilter[touch ? "tap" : "click"]();
        assert.equal(await selectionFilter.getAttribute("aria-expanded"), "true");
        let reference;
        for (const kind of ["pcb","schematic"]) {
          await switchTo(page,kind,touch);
          const metrics = await measure(page);
          const problems = geometryProblems(metrics);
          assert.equal(metrics.coarse,touch,"the browser really uses the requested pointer profile");
          tested.documents[kind] = {metrics,problems};
          if (!reference) reference=metrics;
          else problems.push(...fixedProblems(reference.tops,metrics.tops));
          failures.push(...problems.map(message=>title+" "+kind+" "+message));
        }
        if (!touch && theme==="light") {
          await page.evaluate(()=>AtriumLazy.need("AtriumCollabPresence"));
          const withPeople = await measure(page,{peers:5});
          assert.equal(withPeople.peerCount,3,"real presence renderer shows three avatars");
          assert.ok(withPeople.more,"presence overflow control is visible");
          failures.push(...fixedProblems(reference.tops,withPeople.tops).map(line=>title+" with peers "+line));
        }
        const settings = await preferences(page,touch);
        const onSettings = await measure(page);
        failures.push(...fixedProblems(reference.tops,onSettings.tops).map(line=>title+" while Preferences is open "+line));
        await page.keyboard.press("Escape");
        await settings.waitFor({state:"hidden"});
        failures.push(...fixedProblems(reference.tops,(await measure(page)).tops).map(line=>title+" after Preferences "+line));
        if (theme==="light" && !touch && width===1440) {
          await switchTo(page,"pcb");
          const baseline = await measure(page);
          tested.perturbations=await proveSensitivity(page,baseline);
          await selectionAndSnap(page);
          await controlsWork(page);
          await zeroProblems(page);
          await menuScopeRefresh(page);
          tested.actions=["Search","Open","Save","Undo","Redo","Share","Preferences","Selection chip","Snap","PCB layers","Zero problems"];
        }
        if (theme==="light" && !touch) tested.nativeSearch=await verifyNativeSearch(browser,{width,height},errors);
      } catch (error) {failures.push(`${title} ${error.message}`);}
      finally {
        failures.push(...errors.map(message=>title+" browser error "+message));
        tested.errors = errors;
        await page.close();
      }
    }
  }
  if (report) await fs.writeFile(report,JSON.stringify({results,failures},null,2)+"\n");
  assert.equal(failures.length,0,failures.slice(0,25).join("\n"));
  console.log("PASS editor chrome in both themes and on touch for schematic and PCB at 1440×900 and 1280×800");
};

if (require.main===module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser,{report:process.env.ATRIUM_EDITOR_CHROME_REPORT}),
    error => {console.error(error);process.exitCode=1;});
}
