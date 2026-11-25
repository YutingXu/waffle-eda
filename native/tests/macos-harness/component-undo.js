"use strict";

// Real Workshop PCB and test-point footprint. All movement and each Undo / Redo
// reaches the shipping editor through trusted AppKit or actual Edit-menu input.
globalThis.__uiProbes = {async run() {
  const send = (op, fields = {}) => webkit.messageHandlers.harness.postMessage({op, ...fields});
  const host = AtriumNavHost;
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
  // Snapshot requests still wait for WebKit drawing when the locked console
  // suspends regular page animation callbacks.
  const frame = () => Promise.race([new Promise(requestAnimationFrame),pause(125)]);
  async function until(test, label) {
    for (let tries=0; tries<100; tries++) {
      const value = test();
      if (value) return value;
      await pause(35);
    }
    throw Error(label + ". Editor status: " + document.getElementById("status")?.textContent);
  }
  const click = node => {
    if (!node?.getClientRects().length) throw Error("The targeted editor control is not visible.");
    const box = node.getBoundingClientRect();
    return send("mouse",{x:box.x+box.width/2,y:box.y+box.height/2});
  };
  const ref = "TP1", id = "probe";
  const selectBoard = async () => {
    const board = host.documentRefs().find(doc => doc.kind==="pcb");
    if (!board) throw Error("The fixture did not open the Workshop PCB folder.");
    await host.selectDocument(board.id);
    await until(() => host.doc()?.id===board.id,"The Workshop board is not the active document");
    return board.id;
  };
  await send("note",{text:"Opening the Workshop component canvas"});
  await AtriumLazy.need(["AtriumUndoStore","AtriumKeymapPresets"]);
  const boardId = await selectBoard();
  const part = () => host.doc().items.find(row => row.id===id && row.ref===ref && row.kind==="part");
  const position = () => {
    const item = part();
    if (!item) throw Error("The original TP1 board footprint has gone missing.");
    return [item.x,item.y];
  };
  const equal = (left,right) => left.every((value,index) => Math.abs(value-right[index]) < 1e-9);
  const point = () => {
    const [x,y] = host.view().worldToScreen(position());
    const rect = host.canvas().getBoundingClientRect();
    return [x+rect.left,y+rect.top];
  };
  const hits = () => {
    const center = point(), candidates = [[0,0],[-2,0],[2,0],[0,-2],[0,2],[-5,-5],[5,5]];
    return candidates.map(([dx,dy]) => [center[0]+dx,center[1]+dy])
      .find(([x,y]) => host.hit(host.canvas(),x,y)?.item?.id===id);
  };
  const pointer = [], keyboard = [], menuEvents = [], rows = [];
  const watchPointer = event => {
    if (event.isTrusted && event.target===host.canvas()) pointer.push(event.type);
  };
  const watchKey = event => {
    if (event.key.toLowerCase()==="z" && event.metaKey) keyboard.push({trusted:event.isTrusted,shift:event.shiftKey});
  };
  const watchClick = event => {
    const action = event.target.closest?.('[data-menu="edit"] [data-action]')?.dataset.action;
    if (action && event.isTrusted) menuEvents.push(action);
  };
  addEventListener("pointerdown",watchPointer,true); addEventListener("pointermove",watchPointer,true);
  addEventListener("keydown",watchKey,true); addEventListener("click",watchClick,true);
  async function observe(phase,want) {
    await until(() => equal(position(),want),phase + " did not restore the expected footprint coordinates");
    await frame(); await frame();
    const marker = hits();
    if (!marker) throw Error(phase + " cannot hit the placed footprint at its rendered coordinates");
    await send("note",{text:"TP1 "+phase+" at "+position().join(", ")+" mm"});
    rows.push({phase,ref,id,position:position(),screen:marker,selected:host.selection().includes(id),
      status:document.getElementById("status")?.textContent});
    await send("shot",{name:"component-"+phase});
  }
  async function editMenu(action) {
    if (await send("componentHistoryMenu",{action})) return "AppKit Edit menu";
    const menu = document.querySelector('.menubar [data-menu="edit"]');
    await click(menu.querySelector("summary"));
    const item = menu.querySelector('[data-action="'+action+'"]');
    await until(() => menu.open && item.getClientRects().length && !item.disabled,
      "The visible Edit menu never offered "+action);
    await click(item);
    return "Waffle Edit menu, trusted AppKit click";
  }
  const initial = position();
  await observe("initial",initial);
  const start = hits();
  await click(host.canvas()); // clear a prior selection before the real footprint drag
  const path = Array.from({length:10},(_,i) => [start[0]+i*5,start[1]+i*2]);
  await send("path",{button:"left",points:path,ms:12});
  const moved = await until(() => !equal(initial,position()) && position(),"The trusted AppKit drag did not move TP1");
  if (!pointer.includes("pointerdown") || !pointer.includes("pointermove"))
    throw Error("The board did not receive trusted pointer movement.");
  await observe("moved",moved);
  const menuUndo = await editMenu("undo");
  await observe("menu-undone",initial);
  const menuRedo = await editMenu("redo");
  await observe("menu-redone",moved);
  AtriumKeymap.setPreset("modern");
  host.canvas().focus();
  const keyUndo = await send("componentHistoryKey",{action:"undo"});
  await observe("key-undone",initial);
  host.canvas().focus();
  const keyRedo = await send("componentHistoryKey",{action:"redo"});
  await observe("key-redone",moved);
  if (keyUndo.route==="targeted WKWebView NSEvent" && !keyboard.some(event => event.trusted&&!event.shift) ||
      keyRedo.route==="targeted WKWebView NSEvent" && !keyboard.some(event => event.trusted&&event.shift))
    throw Error("The WebKit responder did not receive the trusted Undo and Redo keys.");
  if (menuUndo.startsWith("Waffle") && !menuEvents.includes("undo") ||
      menuRedo.startsWith("Waffle") && !menuEvents.includes("redo"))
    throw Error("The actual editor Edit menu did not receive trusted action clicks.");

  const save = document.querySelector('.command-link[data-action="save"]');
  await click(save);
  await until(() => !host.isDirty() && !host.savedWritePending(),"The board Save did not become durable");
  const lease = await host.folderProject().readLease({purpose:"verify moved PCB"});
  try {
    const [saved] = await lease.read([host.folderProject().getDocumentRef(boardId).path]);
    const bytes = saved.bytes || Uint8Array.from(atob(saved.data), character => character.charCodeAt(0));
    const rows = new TextDecoder().decode(bytes).trimEnd().split("\n").map(line => JSON.parse(line));
    const persisted = rows.find(row => row.kind==="part" && row.id===id && row.ref===ref);
    if (!persisted || !equal(persisted.at.map(value => value/1e6),moved))
      throw Error("The saved PCB has the wrong footprint or position.");
  } finally { await lease.release(); }
  if (!await send("componentHistoryMenu",{action:"close-project"}))
    throw Error("Could not request Close Project from the native File menu.");
  await until(() => !host.folderProject(),"Close Project left the loaded folder active");
  if (!await send("componentHistoryReopen")) throw Error("The saved fixture was not available for AppKit reopen.");
  await until(() => host.folderProject() && host.doc()?.items.some(row => row.id===id),
    "AppKit did not reopen the saved Workshop PCB");
  await selectBoard();
  await observe("reopened",moved);
  await send("save",{name:"component-undo.json",text:JSON.stringify({
    project:host.project().name,boardId,menuUndo,menuRedo,keyUndo,keyRedo,pointer,keyboard,menuEvents,rows
  },null,2)});
  await send("log",{ok:true,name:"Trusted PCB move, Edit menu and native keyboard Undo/Redo, Save and reopen preserve TP1",
    detail:JSON.stringify({initial,moved,menuUndo,keyUndo})});
  return "Verified Workshop PCB component movement";
}};
