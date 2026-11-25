"use strict";

globalThis.AtriumWorkbench = (() => {
  globalThis.AtriumI18n?.define({"status.grid": "Grid {value}", "status.switch_to_mm": "Switch to mm", "status.switch_to_mil": "Switch to mil", "project.connection_scope": "Connections: {value}", "project.add_to": "Add to {name}", "project.actions_for": "Project actions for {name}"}); // i18n
  const tablist=document.getElementById("document-tabs"),stage=document.getElementById("canvas-stage"),explorer=document.getElementById("documents"),explorerPane=document.getElementById("navigator");
  const projectEntry=explorer?.closest(".project-entry"), projectOwners=new WeakMap();
  const projectMenus=projectEntry?.querySelectorAll("[data-project-menu]") || [];
  const menus=Array.from(document.querySelectorAll(".work-menu"));
  // Without calc-size() (WebKit), ui/whole-pixels.js rounds tabs and menus up as style.css does.
  const roundsInCSS=!globalThis.ResizeObserver||globalThis.CSS?.supports?.("inline-size","calc-size(max-content, size)")!==false;
  const wholePixels=(box,label)=>{if(!roundsInCSS)AtriumLazy.need("AtriumWholePixels").then(w=>w.observe(box,label));};
  for(const m of menus)wholePixels(m.firstElementChild);
  const tabs=new Map();
  let currentId=null, selectDocument=null, activeMenu=null;
  // WebKit forwards a label's click with detail 0; after a press it is still a pointer action.
  let pointerAt=-Infinity;
  function motionInput(event){
    if(!event.isTrusted&&event.type!=="keydown")return;
    const state=document.documentElement.dataset;
    if(event.type==="pointerdown")pointerAt=event.timeStamp;
    if(event.type==="keydown" || event.detail===0&&event.type==="click"&&event.timeStamp-pointerAt>1000){
      if(state.motionInput!=="keyboard")state.motionInput="keyboard";
    }else if(event.type!=="click"&&state.motionInput)delete state.motionInput;
  }
  // Classify the input before the editor handles canvas events at window capture.
  for(const type of ["keydown","click","pointerdown","wheel"])globalThis.addEventListener?.(type,motionInput,{capture:true,passive:true});
  if (window.opener && /^#open-project=[0-9a-f]{32}$/.test(window.location.hash)) {
    window.__atriumOpeningProject = true;
    const token = window.location.hash.slice("#open-project=".length);
    window.addEventListener("load", () => globalThis.AtriumLazy.need("AtriumProjectWindows").then(w => w.receive(token)), {once:true});
  }
  const opened=new Set(); // onOpen(fn): refresh checked toggles before a menu shows
  const hoverSubmenus = new WeakSet();
  // Window › Panels: each docked panel's item opens it, brings it to the front, or closes it (dock.js toggle).
  function togglePanel(id) {
    const dock = globalThis.AtriumDock;
    if (dock?.current?.()) dock.toggle(id);
    else globalThis.AtriumLazy.need("AtriumDock").then(dock => dock.toggle(id));
  }
  document.addEventListener("click", e => {
    const button = e.target.closest?.("[data-dock-target]");
    if (!button) return;
    if (!globalThis.AtriumDock?.current?.() && button.dataset.action === "toggle-right") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    globalThis.AtriumWorkbench?.dismiss();
    togglePanel(button.dataset.dockTarget);
  });
  // Components has no module of its own: the command palette and key bindings reach it through this action.
  const componentsAction = () => globalThis.AtriumNavCommon?.ready?.(host => host.registerAction?.("components-panel", () => togglePanel("components")));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", componentsAction, {once:true}); else queueMicrotask(componentsAction);
  function explorerTarget(e) {
    return e.target.closest?.("#documents [data-doc], #document-tabs [data-tab], .pane-tabs [data-tab], .project-tree summary, .panel-projects") ||
      (e.target === explorerPane ? explorerPane.firstElementChild : null) || // the empty left pane, as in Altium
      emptyProjectsDock(e.target);
  }
  // The space below the Projects tree belongs to its dock group: a right-click there is on the tree background.
  function emptyProjectsDock(node) {
    if (!node?.matches?.("#navigator :is(.dock-group,.dock-body)")) return null;
    const panel = node.querySelector(".panel-projects");
    return panel?.getClientRects().length ? panel : null;
  }
  function explorerMenu(e, target, keyboard) {
    e.preventDefault();
    const box = target.getBoundingClientRect();
    const x = keyboard ? box.left + 8 : e.clientX;
    const y = keyboard ? box.bottom : e.clientY;
    const host = globalThis.AtriumNavHost;
    // A right-click leaves focus where it was (Finder): Escape returns there, not to the clicked row.
    // A keyboard menu (Shift+F10, the menu key) has no press before it and returns to the row.
    const press = rightPress && e.timeStamp - rightPress.at < 2000 ? rightPress : null, before = press?.focus;
    rightPress = null;
    const prior = keyboard || !press ? target : before?.isConnected && before !== document.body ? before : null;
    if (!host) return;
    const entry = target.closest(".project-entry"), project = entry ? projectOwners.get(entry) : host.project();
    if (project && host.project() === project) globalThis.AtriumLazy.need("AtriumContextMenu").then(
      menu => menu.explorer(host, target, x, y, {project, returnFocus:prior}), error => host.info(error.message));
  }
  // Read before the press focuses the row (Chrome focuses on mousedown; WebKit does not). A press while a
  // menu is open keeps the focus from before that menu.
  let rightPress = null, lastFocus = null;
  document.addEventListener("pointerdown", e => {
    if (e.button !== 2 && !(e.button === 0 && e.ctrlKey)) return;
    if (!document.activeElement?.closest?.(".nav-menu-portal")) lastFocus = document.activeElement;
    rightPress = {at:e.timeStamp, focus:lastFocus};
  }, true);
  document.addEventListener("contextmenu", e => {
    const target = explorerTarget(e);
    if (target) explorerMenu(e, target, false);
  });
  const textField = "textarea,input:not([type]),input:is([type=text],[type=search],[type=url],[type=email],[type=tel],[type=password],[type=number]),[contenteditable=true]";
  let textMenuRequest;
  function textMenu(e, keyboard) {
    const node = e.target.closest ? e.target : e.target.parentElement;
    const field = node?.closest(textField), selection = getSelection();
    if (!field && !(selection?.toString().trim() && selection.containsNode(node, true))) return false;
    e.preventDefault();
    const target = field || node, box = target.getBoundingClientRect(), focus = document.activeElement;
    textMenuRequest?.abort();
    const request = textMenuRequest = new AbortController(), stop = () => request.abort();
    // A cold menu must not interrupt typing or an IME composition that began while it loaded.
    for (const type of ["beforeinput", "compositionstart"]) target.addEventListener(type, stop, {signal:request.signal});
    globalThis.AtriumLazy.need("AtriumContextMenu").then(menu => {
      if (!request.signal.aborted && target.isConnected && document.activeElement === focus)
        menu.editing(target, field, keyboard ? box.left : e.clientX, keyboard ? box.bottom : e.clientY);
    }, err => globalThis.AtriumNavHost?.info(err.message)).finally(() => {
      stop(); if (textMenuRequest === request) textMenuRequest = null;
    });
    return true;
  }
  window.addEventListener("contextmenu", e => {
    if (!e.defaultPrevented && !e.target.closest?.("canvas, .panel-projects, .nav-menu")) textMenu(e, false);
    e.preventDefault();
  });
  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!e.isComposing && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
      const target = explorerTarget(e);
      if (target) explorerMenu(e, target, true);
      else if (textMenu(e, true)) return;
    }
    // WebKit search fields can consume Escape before the default dialog dismissal.
    // Preserve a nested editor's Escape handler and each dialog's cancel/discard guard.
    if (e.key !== "Escape" || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const dialog = e.target.closest?.("dialog[open]");
    if (!dialog || e.target.matches?.("select")) return;
    e.preventDefault();
    if (dialog.dispatchEvent(new Event("cancel", {cancelable:true})) && dialog.open) dialog.close();
  });
  function menuState(menu,open,instant){
    if(!globalThis.AtriumSurfaceMotion?.menu(menu,open,instant))menu.open=open;
    menu.querySelector("summary").setAttribute("aria-expanded",String(open));if(!open)closeSubs(menu);
  }
  function dismiss(focus=false,instant=false){
    if(!activeMenu)return;
    const menu=activeMenu;activeMenu=null;menuState(menu,false,instant);
    if(focus)menu.querySelector("summary").focus();
  }
  function openMenu(menu){
    syncMenuScopes(document.body.dataset.kind);
    const entering=menu!==activeMenu,switching=entering&&!!activeMenu;
    if(entering)dismiss(false,switching);
    activeMenu=menu;menuState(menu,true,switching);for(const f of opened)try{f(menu);}catch{}
    if(entering)menuHints(document.body.dataset.kind);
    for (const item of menu.querySelectorAll('[role^="menuitem"]')) item.tabIndex = -1;
    fit(menu.querySelector(".menu-items"));
  }
  // menu-fit: keep menus and submenus inside the window (AtriumContextMenu.fitMenu, lazy; loads on the first open)
  const fit=(l,r)=>{const C=globalThis.AtriumContextMenu;if(C)C.fitMenu(l,r);else globalThis.AtriumLazy?.need("AtriumContextMenu").then(C=>C.fitMenu(l,r),()=>{});};
  // integ-submenu: arrow keys move within one level; Right/Enter opens a submenu, Left/Escape closes it.
  function level(menu,node){return node?.closest?.(".submenu.open > .menu-items")||menu.querySelector(".menu-items");}
  function commands(menu,node){
    const list=level(menu,node);
    return Array.from(list?.children||[]).map(n=>n.classList?.contains("submenu")?n.querySelector(":scope > .submenu-trigger"):n)
      .filter(n=>n&&n.matches?.('[role^="menuitem"]')&&!n.hidden&&!n.disabled&&!n.closest("[hidden]")&&n.getClientRects().length);
  }
  function closeSub(sub) {
    hoverSubmenus.delete(sub);
    sub.classList.remove("open");
    sub.querySelector(":scope > .submenu-trigger")?.setAttribute("aria-expanded", "false");
  }
  function closeSubs(root) {for (const sub of root.querySelectorAll(".submenu.open")) closeSub(sub);}
  function openSub(sub,focus){for(const s of sub.parentElement.querySelectorAll(":scope > .submenu.open"))if(s!==sub)closeSubs(s.parentElement);
    if (focus) hoverSubmenus.delete(sub);
    sub.classList.add("open");sub.querySelector(":scope > .submenu-trigger").setAttribute("aria-expanded","true");
    const inner=sub.querySelector(":scope > .menu-items");sub.classList.remove("flip");fit(inner,sub.querySelector(":scope > .submenu-trigger"));
    if(focus)commands(sub.closest(".work-menu"),inner.firstElementChild||inner)[0]?.focus();}
  for(const menu of menus){
    const trigger=menu.querySelector("summary");
    trigger.setAttribute("aria-expanded","false");
    trigger.onclick=event=>{
      event.preventDefault();
      if(activeMenu===menu) dismiss(true);
      else {
        openMenu(menu);
        if (event.detail === 0) commands(menu)[0]?.focus();
      }
    };
    menu.addEventListener("pointerenter",event=>{
      if(event.pointerType==="mouse"&&activeMenu?.parentElement===menu.parentElement&&menu!==activeMenu)openMenu(menu);
    });
    menu.addEventListener("click", event => {
      const trigger = event.target.closest?.(".submenu-trigger");
      if (!trigger) return;
      event.preventDefault();
      const sub = trigger.parentElement;
      // Pointer entry often opens the submenu just before a deliberate click.
      const wasHover = hoverSubmenus.delete(sub);
      if (sub.classList.contains("open") && !wasHover) closeSubs(sub.parentElement);
      else openSub(sub, event.detail === 0);
    });
    menu.addEventListener("pointerover", event => {
      const item = event.target.closest?.(".menu-items > *");
      if (!item || event.pointerType !== "mouse") return;
      for (const sub of item.parentElement.querySelectorAll(":scope > .submenu.open")) if (sub !== item) {
        closeSub(sub);
        closeSubs(sub);
      }
      if (item.matches(".submenu:not(.open)")) {
        openSub(item);
        hoverSubmenus.add(item);
      }
    });
    menu.addEventListener("scroll",event=>{for(const s of event.target.querySelectorAll?.(":scope > .submenu.open")||[])openSub(s);},true);
    menu.addEventListener("keydown",event=>{
      if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey)return;
      const key=event.key;
      // Tab leaves the menu from its trigger, including when focus is deep in a submenu.
      if (key === "Tab" && activeMenu === menu) {dismiss(true); return;}
      if (event.shiftKey) return;
      const trig=event.target.closest?.(".submenu-trigger"),inSub=event.target.closest?.(".submenu.open > .menu-items")?.parentElement;
      if(trig&&(key==="ArrowRight"||key==="Enter"||key===" ")){openSub(trig.parentElement,true);event.preventDefault();event.stopPropagation();return;}
      if(inSub&&(key==="ArrowLeft"||key==="Escape")){closeSub(inSub);closeSubs(inSub);inSub.querySelector(":scope > .submenu-trigger").focus();event.preventDefault();event.stopPropagation();return;}
      if(inSub&&key==="ArrowRight"){event.preventDefault();event.stopPropagation();return;}
      if(key==="Escape"){if(!activeMenu)return;dismiss(true);}
      else if(key==="ArrowLeft"||key==="ArrowRight"){
        const available=menus.filter(m=>m.parentElement===menu.parentElement&&!m.closest("[hidden]"));
        const step=key==="ArrowRight"?1:-1,target=available[(available.indexOf(menu)+step+available.length)%available.length];
        if(!target)return;
        if(activeMenu){openMenu(target);commands(target)[0]?.focus();}else target.querySelector("summary").focus();
      }else if(["ArrowDown","ArrowUp","Home","End"].includes(key)){
        openMenu(menu);
        const items=commands(menu,event.target),index=items.indexOf(event.target);
        const dest=key==="Home"?0:key==="End"?items.length-1:key==="ArrowUp"?(index<=0?items.length-1:index-1):(index+1)%items.length;
        items[dest]?.focus();
      }else return;
      event.preventDefault();event.stopPropagation();
    });
  }
  document.addEventListener("click",event=>{
    if(!activeMenu)return;
    if(!activeMenu.contains(event.target)) dismiss();
    else if (event.target.closest("[data-action]")) {
      dismiss(event.detail === 0 && activeMenu.id === "status-grid-menu");
      // Menu commands may load a dialog asynchronously. Give an opened document a
      // reliable focus origin instead of leaving focus on its now hidden menu item.
      if (event.detail === 0 && document.activeElement === document.body) globalThis.AtriumShell?.focusEditor();
    }
  });
  document.addEventListener("focusin",event=>{
    if(activeMenu&&!activeMenu.contains(event.target)) dismiss();
  });
  const narrow=matchMedia("(max-width:620px)");
  let desktopPanels={left:false,right:false};
  function viewportChanged(event){
    for(const side of ["left","right"]){
      const hidden="hide-"+side;
      if(event.matches){
        desktopPanels[side]=document.body.classList.contains(hidden);
        document.body.classList.add(hidden);
      }else document.body.classList.toggle(hidden,desktopPanels[side]);
      const expanded=String(!document.body.classList.contains(hidden));
      for(const toggle of document.querySelectorAll('[data-action="toggle-'+side+'"]'))toggle.setAttribute("aria-expanded",expanded);
    }
  }
  if(narrow.addEventListener)narrow.addEventListener("change",viewportChanged);
  else narrow.addListener?.(viewportChanged);
  tablist.replaceChildren();
  // Keep an active document label available before the first editor refresh.
  const starter=document.createElement("span");starter.id="doc-name";tablist.append(starter);
  function documentIcon() {
    const svg=AtriumNavCommon.icon();
    return {svg,use:svg.firstElementChild};
  }
  async function closeDocumentTab(tab){
    const host=globalThis.AtriumNavHost,project=host?.project(),focused=document.activeElement===tab;
    if(!host)return;
    try {
      const tabs=globalThis.AtriumDocTabs||await AtriumLazy.need("AtriumDocTabs");
      if(host.project()!==project||!tab.isConnected||tab.hidden)return;
      if(await tabs.run(host,"close",{id:tab.dataset.tab,pane:null})&&focused)tablist.querySelector('[aria-selected="true"]:not([hidden])')?.focus();
    } catch(error) { host.info(error.message); }
  }
  function tabEntry(doc){
    const tab=document.createElement("button"),label=document.createElement("span"),close=document.createElement("span");
    tab.type="button";tab.className="document-tab ui-document-tab ui-tab editor-chrome-tab";tab.setAttribute("role","tab");tab.setAttribute("aria-controls","canvas-stage");
    tab.setAttribute("aria-keyshortcuts","Delete");
    tab.setAttribute("aria-description","Use " + (globalThis.AtriumKeymap?.display("Delete",true)||"Delete") + " to close this tab.");
    tab.dataset.tab=doc.id;tab.draggable=true;
    close.className="document-tab-close ui-chrome-action ui-dismiss-glyph";close.setAttribute("aria-hidden","true");
    globalThis.AtriumNavCommon?.shortcutTitle(close,"Close tab","Delete");
    const {svg,use}=documentIcon();
    tab.append(svg,label,close);wholePixels(tab,label);
    tab.onclick=event=>{
      if(close.contains(event.target))closeDocumentTab(tab);
      else selectDocument?.(tab.dataset.tab);
    };
    tab.onauxclick=event=>{if(event.button===1){event.preventDefault();closeDocumentTab(tab);}};
    return {tab,label,use};
  }
  tablist.addEventListener("keydown",event=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    const selected=event.target.closest('[role="tab"]');
    if(!selected)return;
    const options=Array.from(tablist.querySelectorAll(':scope > [role="tab"]:not([hidden])')),at=options.indexOf(selected);
    if(at<0)return;
    if(event.key==="Delete"){event.preventDefault();event.stopPropagation();closeDocumentTab(selected);return;}
    const index=event.key==="Home"?0:event.key==="End"?options.length-1:event.key==="ArrowRight"?(at+1)%options.length:event.key==="ArrowLeft"?(at-1+options.length)%options.length:-1;
    if(index<0)return;
    event.preventDefault();event.stopPropagation();const next=options[index];
    next.click();next.focus();
  });
  function syncQuickAccessHints(kind) {
    const C=globalThis.AtriumNavCommon,K=globalThis.AtriumKeymap;
    if(!C||!K)return;
    for(const button of document.querySelectorAll(".quick-access [data-action]")) {
      C.shortcutTitle(button,button.getAttribute("aria-label"),K.hintKey(button.dataset.action,kind));
    }
  }
  let quickHintsPending=false;
  globalThis.AtriumKeymap?.onChange(()=>{
    if(quickHintsPending)return;
    quickHintsPending=true;
    queueMicrotask(()=>{quickHintsPending=false;syncQuickAccessHints(document.body.dataset.kind);});
  });
  function menuHints(kind){
    if(activeMenu)globalThis.AtriumKeymap?.applyMenuHints(activeMenu,kind);
  }
  globalThis.AtriumKeymap?.onChange(()=>menuHints(document.body.dataset.kind));
  let tabDocuments, tabOrder = [];
  const spatial = () => globalThis.AtriumSpatialMotion;
  const bindTabMotion = motion => motion?.tabs(tablist, order => { tabOrder = order; });
  tablist.addEventListener("pointerenter", () => {
    if (spatial()) bindTabMotion(spatial());
    else globalThis.AtriumLazy?.need("AtriumSpatialMotion").then(bindTabMotion, () => {});
  }, {once:true});
  function syncTabs(documents,id) {
    const motion = spatial();
    const order = motion?.dragOrder(tablist) || tabOrder;
    if (order.length) {
      const byId = new Map(documents.map(doc => [doc.id,doc]));
      const preferred = order.flatMap(key => byId.has(key) ? [byId.get(key)] : []);
      const known = new Set(preferred.map(doc => doc.id));
      documents = [...preferred,...documents.filter(doc => !known.has(doc.id))];
      tabOrder = tabOrder.filter(key => byId.has(key));
    }
    const moved = tabDocuments && (tabDocuments.length !== documents.length ||
      documents.some((doc,index) => tabDocuments[index].id !== doc.id));
    const apply = () => reconcileTabs(documents,id);
    bindTabMotion(motion);
    if (moved && motion && !motion.dragOrder(tablist)) motion.tabLayout(tablist,apply);
    else apply();
  }
  function reconcileTabs(documents,id) {
    const changed=!Atrium.sameDocumentMetadata(documents,tabDocuments);
    if(!changed&&currentId===id)return;
    if(changed)tabDocuments=Atrium.documentMetadata(documents);
    const focused=document.activeElement;
    starter.remove();
    const previous=tabs.get(currentId);
    if(previous&&currentId!==id)previous.label.removeAttribute("id");
    let insertion=tablist.firstChild;
    const keep=new Set();
    for(const doc of documents){
      keep.add(doc.id);
      let entry=tabs.get(doc.id);
      if(!entry){entry=tabEntry(doc);tabs.set(doc.id,entry);}
      const {tab,label,use}=entry,chosen=doc.id===id;
      if(tab!==insertion)tablist.insertBefore(tab,insertion);else insertion=insertion.nextSibling;
      if(label.textContent!==doc.name)label.textContent=doc.name;
      if(tab.dataset.kind!==doc.kind){
        tab.dataset.kind=doc.kind;use.setAttribute("href",doc.kind==="pcb"?"#i-board":"#i-schematic");
      }
      tab.title=doc.sourceName||doc.name;
      tab.setAttribute("aria-selected",String(chosen));tab.tabIndex=chosen?0:-1;
      if(chosen){
        label.id="doc-name";
        tab.id="current-document-tab";
        stage.setAttribute("aria-labelledby",tab.id);
        document.body.dataset.kind=doc.kind;
      }else tab.removeAttribute("id");
    }
    for(const [key,item] of tabs)if(!keep.has(key)){item.tab.remove();tabs.delete(key);}
    // The first tab starts in view. Scrolling it forces layout before the menus and panels have finished updating.
    if(currentId!==id && (currentId!==null || id!==documents[0]?.id))tabs.get(id)?.tab.scrollIntoView?.({block:"nearest",inline:"nearest"});
    currentId=id;
    if(focused&&tablist.contains(focused)&&document.activeElement!==focused)focused.focus({preventScroll:true});
  }
  for (const trigger of projectMenus) trigger.addEventListener("click", () => {
    const host = globalThis.AtriumNavHost, project = projectOwners.get(trigger.closest(".project-entry"));
    if (project && host?.project() === project) globalThis.AtriumLazy.need("AtriumContextMenu").then(
      menu => menu.projectActions(host, trigger, project), error => host.info(error.message));
  });
  let treeLoading, latestExplorer, projectMenuName;
  function syncExplorer(...args) {
    if (!explorer) return;
    const [project] = args, name = project.name || "Untitled";
    if (projectEntry) projectOwners.set(projectEntry, project);
    if (projectMenuName !== name) {
      projectMenuName = name;
      for (const button of projectMenus) {
        const add = button.dataset.projectMenu === "add";
        const label = globalThis.AtriumI18n?.t(add ? "project.add_to" : "project.actions_for", {name}) ||
          (add ? "Add to " + name : "Project actions for " + name);
        button.setAttribute("aria-label", label);
        button.dataset.tooltipLabel = label;
      }
    }
    latestExplorer = args;
    const show = tree => tree.syncPanel(explorer, documentIcon, ...latestExplorer);
    if (globalThis.AtriumProjectTree) show(AtriumProjectTree);
    else if (!treeLoading && !globalThis.AtriumNavHost?.isStarter?.()) {
      treeLoading = globalThis.AtriumLazy?.need("AtriumProjectTree").then(tree => {treeLoading = null; show(tree);},
        e => {treeLoading = null; globalThis.AtriumNavHost?.info(e.message);});
    }
  }
  function setHidden(node,hidden) {
    if(node.hidden!==hidden)node.hidden=hidden;
  }
  let scopedMenus,menuKind,menuScopeObserver,menuScopeDirty=false;
  function syncMenuScopes(kind) {
    const roots=document.querySelectorAll(".work-menu");
    const pending=menuScopeObserver?.takeRecords().length;
    if(menuScopeObserver&&!pending&&!menuScopeDirty&&menuKind===kind&&scopedMenus.length===roots.length&&
        Array.prototype.every.call(roots,(node,index)=>node===scopedMenus[index]))return;
    // Refresh on a document kind or menu subtree change. Do not observe our own visibility writes.
    menuScopeObserver?.disconnect();
    if(scopedMenus&&typeof MutationObserver==="function")
      menuScopeObserver??=new MutationObserver(()=>{menuScopeDirty=true;});
    scopedMenus=roots;menuKind=kind;menuScopeDirty=false;
    for(const menu of roots){
      if(menu.hasAttribute("data-scope"))setHidden(menu,menu.dataset.scope!==kind);
      for(const node of menu.querySelectorAll("[data-scope]:not(.menu-items > :is(hr,.submenu))"))
        setHidden(node,node.dataset.scope!==kind);
      // A menu whose items are all out of scope disappears, and separators never double up or dangle.
      // integ-scope: nested lists first, so a submenu with nothing in scope hides with its separators.
      const lists=Array.from(menu.querySelectorAll(".menu-items")).reverse(),some=new Map();
      for(const list of lists){
        let separator=null,any=false;
        for(const n of list.children){
          if(n.tagName==="HR"){
            if(any&&!separator)separator=n;
            else setHidden(n,true);
            continue;
          }
          if(n.classList.contains("submenu"))
            setHidden(n,(!!n.dataset.scope&&n.dataset.scope!==kind)||!some.get(n.querySelector(":scope > .menu-items")));
          if(n.hidden)continue;
          if(separator){setHidden(separator,false);separator=null;}
          any=true;
        }
        if(separator)setHidden(separator,true);
        some.set(list,any);
      }
      if(lists.length&&!menu.dataset.dynamic)setHidden(menu,!some.get(lists.at(-1)));
      menuScopeObserver?.observe(menu,{subtree:true,childList:true,attributes:true,
        attributeFilter:["hidden","data-scope","data-dynamic","class"]});
    }
  }
  function sync(documents,id,select,grid,unit){
    selectDocument=select;
    const priorKind=document.body.dataset.kind;
    syncTabs(documents,id);
    const kind=document.body.dataset.kind;
    if(kind!==priorKind)syncQuickAccessHints(kind);
    if(kind!==priorKind)menuHints(kind);
    for(const node of document.querySelectorAll("[data-scope]:not(.work-menu,.work-menu *)")){
      setHidden(node,node.dataset.scope!==kind);
    }
    syncMenuScopes(kind);
    // The model grid is millimetres. Display it in the same unit as the coordinates.
    const U=globalThis.Atrium?.units,I=globalThis.AtriumI18n;
    const value=U?U.format(grid,unit):Number(grid.toPrecision(5))+" mm";
    const readout=document.getElementById("grid-value"),label=I?I.t("status.grid",{value}):"Grid "+value; // i18n: status.grid
    if(readout.textContent!==label)readout.textContent=label;
  }
  // dismiss(): close the open menu (dock.js closes Window › Layouts after a saved layout is chosen).
  return {sync,syncExplorer,wholePixels,reviewScope:(...args)=>globalThis.AtriumProjectTree?.reviewScope(...args),dismiss:()=>dismiss(),onOpen:f=>{opened.add(f);return ()=>opened.delete(f);}};
})();
