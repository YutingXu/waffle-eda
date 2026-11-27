"use strict";
// AtriumUndoStore: undo for editor.js as per-object deltas. A step costs what it changed, and undo
// or redo patches the live project in place, so caches keyed by object identity (the canvas
// index, connectivity) only see the objects the step touched.
//
// The shadow. The store mirrors the live project as a tree of nodes: the project and objects
// down to depth 2 (a document, its pcbDrawing) are containers; arrays in them (items, outline,
// pours, library) hold one JSON string per element, aligned with the element objects; the
// documents array holds a container per document. sync() compares the live project with the
// shadow (identity for structure, one native JSON.stringify per element for content: the model
// is mutated in place all over the codebase, so nothing cheaper is safe), appends the
// differences to a log as records and updates the shadow. Records:
//   e  an element of an array changed in place          {node, ref, before, after}
//   s  elements removed / inserted (identity diff)      {node, removed, inserted: [[index, ref, val]]}
//   k  a container key set, changed or deleted          {node, key, before, after, kb, ka}
//   r  the project object itself was replaced (Open)    {before, after}
// sync() runs when the editor is idle after a change (touch()), and synchronously only when a
// new step starts while a change is still unrecorded; it costs no more than one stringify of
// the project and is never on the path of an edit that follows idle time.
//
// States. history holds the states before each step: {pos} = the log position of that state.
// Undo reverts the log back to a state's position (record by record, in place) and moves those
// records to the redo entry ({recs}); redo re-applies them. Derived changes made without a step
// (live pours) stay in the log, so they belong to the step before them, as snapshots did. An
// edit after undo keeps the replaced redo states as an alternate branch (up to 8). Budget:
// preference history.undoBudgetMB (64): branches go first, then the oldest steps; 500 steps max.
// history-panel.js labels steps from changes(a, b), lists branches() and compares project(state).
// Entries the editor made before this module loaded (whole-project JSON) are lifted once.
//
// Touched sets. An edit that knows what it changed passes a hint to touch()/record()/unchanged():
// {doc, items, library?} (or a list of them): the items of doc whose content changed in place.
// sync() then compares only those items' content (O(changed)); everything else is still compared
// as before except the content of other items and, unless library is set, of library entries:
// structure (insertions, removals, a replaced list, by identity), container keys, outlines, pours.
// A touch without a hint makes the next sync a full comparison (the fallback). With
// globalThis.ATRIUM_UNDO_VERIFY (or the preference history.verifyHints) every hinted sync is
// followed by a full one; what it finds is recorded and reported (stats().missed; "throw" throws).
//
// Content hashes. Every array element of the shadow has a hash, computed lazily when its value
// changes, kept in chunks of CH elements by order (a two-level Merkle tree per list); containers
// hash their keys and children. Once warm (idle slices after the shadow is built), each mark
// stores the project's root hash, and an undo or redo checks the root it restores against the
// state's in O(changed · log n) (stats().verified, .mismatch). Pour copper (shared by reference)
// is fingerprinted from its length and a sample, not every character.
globalThis.AtriumUndoStore = (() => {
  const MAX_STEPS = 500, MAX_BRANCHES = 8, SPLICE_MAX = 16;
  const G = globalThis, now = () => Date.now();
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const skip = v => v === undefined || typeof v === "function" || typeof v === "symbol";
  const isObj = v => v !== null && typeof v === "object";
  const js = v => { const s = JSON.stringify(v); return s === undefined ? "null" : s; };
  const size = v => typeof v === "string" ? 40 + v.length : v && typeof v === "object" ? 64 + (v.bytes || 0) : 8;
  // Poured regions (pcbDrawing.pours) are replaced, not edited, by the pour engine and hold large
  // encoded copper: the shadow keeps their fields by reference ({sh: [key, value, ...]}), which
  // shares the strings with the live region instead of copying them into JSON. A record that keeps
  // an old region counts its data (data) against the budget.
  function shallowOf(e) {
    const sh = []; let data = 0;
    for (const k of Object.keys(e)) { const x = e[k]; if (skip(x)) continue; sh.push(k, x); if (typeof x === "string") data += x.length; }
    return {sh, bytes: 16 + sh.length * 8, data};
  }
  function sameShallow(e, v) {
    const sh = v.sh; let i = 0;
    for (const k of Object.keys(e)) { const x = e[k]; if (skip(x)) continue; if (sh[i] !== k || sh[i + 1] !== x) return false; i += 2; }
    return i === sh.length;
  }
  const fromShallow = v => { const o = {}; for (let i = 0; i < v.sh.length; i += 2) o[v.sh[i]] = v.sh[i + 1]; return o; };
  const held = v => v && v.sh ? 64 + v.data : size(v);
  const budget = () => Math.max(4, +(G.AtriumPref?.get?.("history.undoBudgetMB", 64)) || 64) * 1048576;
  const listeners = new Set(), libraryListeners = new Set(), authoredListeners = new Set();
  const emit = () => { for (const f of listeners) try { f(); } catch (e) { G.console?.error?.(e); } };

  let diskEpoch = 0;
  let root = null;            // the shadow of the live project
  let log = [], base = 0;     // records; base is the absolute position of log[0]
  let logBytes = 0, shadowBytes = 0;
  let dirty = false, settled = false, later = false, pending = null, timer = 0, seq = 0, gen = 0;
  let liveAct = null, action = null, liveFrom = -1, H = null, F = null, motionSince = null, motionEnd = 0, liveState = null;
  const branches = [];
  const end = () => base + log.length;
  // scope: what pending hints say changed ({docs: Map<doc, Set<item>>, library}); only: the scope of
  // the sync in progress. vs: verification counters.
  let scope = null, only = null, editing = 0;
  const vs = {scoped: 0, full: 0, missed: 0, verified: 0, mismatch: 0, tableCells:0, tableSnapshots:0};
  const strict = () => G.ATRIUM_UNDO_VERIFY ?? G.process?.env?.ATRIUM_UNDO_VERIFY ?? G.AtriumPref?.get?.("history.verifyHints", false);
  function addScope(hint) {
    scope ??= {docs: new Map(), library: false, tableCells:new Map()};
    for (const h of Array.isArray(hint) ? hint : [hint]) {
      if (!h) continue;
      if (h.library) scope.library = true;
      if (!h.doc) continue;
      let s = scope.docs.get(h.doc);
      if (!s) scope.docs.set(h.doc, s = new Set());
      let proofs=scope.tableCells.get(h.doc);
      if(!proofs)scope.tableCells.set(h.doc,proofs=new Map());
      for(const i of h.items||[])if(isObj(i)||typeof i==="string"){
        s.add(i);
        const id=typeof i==="string"?i:i.id;
        if(id)proofs.set(id,!proofs.has(id) && h.tableCell?.item===i ? h.tableCell : null);
      }
    }
  }
  // A hint is usable while nothing unhinted is pending.
  function hinted(hint) { if (hint && !dirty) addScope(hint); else dirty = true; }

  // ---- content hashes ---------------------------------------------------------------------------------
  const CH = 64, H21 = 2097152;
  const pack = (a, b) => (a >>> 0) * H21 + ((b >>> 0) & (H21 - 1));
  function hstr(s, h = 0) {
    let a = 0x811c9dc5 ^ (h % H21), b = 0x9747b28c ^ Math.floor(h / H21);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; }
    return pack(a ^ s.length, b);
  }
  function mix(h, x) {
    let a = Math.floor(h / H21) | 0, b = (h % H21) | 0;
    const xa = Math.floor(x / H21) | 0, xb = (x % H21) | 0;
    a = Math.imul(a ^ xa, 16777619) ^ Math.imul(xb + 0x165667b1, 0x27d4eb2d); a ^= a >>> 13;
    b = Math.imul((b ^ xb) + xa, 0x5bd1e995); b ^= b >>> 15; b = Math.imul(b ^ (a >>> 7), 0x85ebca6b);
    return pack(a, b);
  }
  // Long strings in a shallow (poured) value: length, ends and a stride sample.
  function sample(s) {
    if (s.length <= 4096) return hstr(s);
    let h = hstr(s.slice(0, 256), s.length);
    h = hstr(s.slice(-256), h);
    const step = Math.floor(s.length / 64);
    for (let i = 0; i < 64; i++) h = hstr(s.substr(i * step, 16), h);
    return h;
  }
  // A long list in a shallow value (ring and arc arrays): its length and a stride sample of elements.
  function sampleList(a) {
    let h = hstr("[" + a.length);
    const step = Math.max(1, Math.floor(a.length / 64));
    for (let i = 0; i < a.length; i += step) h = mix(h, part(a[i]));
    return mix(h, part(a[a.length - 1]));
  }
  const part = y => (Array.isArray(y) || ArrayBuffer.isView(y)) && /** @type {ArrayLike<any>} */ (y).length > 64 ? sampleList(y) : typeof y === "string" ? sample(y) : hstr(js(y));
  function shHash(v) {
    let h = 7;
    for (let i = 0; i < v.sh.length; i += 2) {
      const x = v.sh[i + 1];
      h = mix(mix(h, hstr(v.sh[i])), part(x));
    }
    return h;
  }
  const valHash = v => typeof v === "string" ? hstr(v) : v?.table ? v.hash : v?.sh ? (v.hash ??= shHash(v)) : v?.t ? nodeHash(v) : hstr(js(v));
  function nodeHash(n) {
    if (n.t === "o") {
      let h = 3;
      n.kh ??= new Map();
      for (const [k, kid] of n.kids) {
        let x;
        if (typeof kid === "string") { const c = n.kh.get(k); if (c && c[0] === kid) x = c[1]; else { x = hstr(kid); n.kh.set(k, [kid, x]); } }
        else x = nodeHash(kid);
        h = mix(mix(h, hstr(k)), x);
      }
      return h;
    }
    if (n.t === "l") { let h = 5; for (const v of n.vals) h = mix(h, valHash(v)); return mix(h, n.vals.length); }
    if (n.hr !== undefined) return n.hr;
    const V = n.vals, hs = n.hs ??= new Array(V.length), hc = n.hc ??= [];
    let h = mix(11, V.length);
    for (let c = 0; c * CH < V.length; c++) {
      if (hc[c] === undefined) {
        let x = 13;
        for (let i = c * CH, e = Math.min(V.length, i + CH); i < e; i++) x = mix(x, hs[i] ??= valHash(V[i]));
        hc[c] = x;
      }
      h = mix(h, hc[c]);
    }
    return n.hr = h;
  }
  // An element's value changed, or (reshape) the list's order from index `from` on.
  function leaf(n, i) { if (n.hs) { n.hs[i] = undefined; if (n.hc) n.hc[(i / CH) | 0] = undefined; } n.hr = undefined; }
  function reshape(n, removed, inserted) {
    n.at = null; n.hr = undefined;
    if (!n.hs) return;
    edit(n.hs, removed, inserted, 3);
    const from = Math.min(removed[0]?.[0] ?? Infinity, inserted[0]?.[0] ?? Infinity);
    if (n.hc && Number.isFinite(from)) n.hc.length = Math.min(n.hc.length, (from / CH) | 0);
  }
  // Warm-up: every element's hash, in idle slices; marks store root hashes from then on.
  let warm = false, warming = 0;
  function* lists(n) {
    if (n.t === "o") { for (const kid of n.kids.values()) if (typeof kid === "object") yield* lists(kid); return; }
    if (n.t === "l") { for (const v of n.vals) if (v?.t) yield* lists(v); return; }
    yield n;
  }
  function prime(deadline) {
    if (!root) return false;
    const r = root;
    let k = 0;
    for (const n of lists(r)) {
      const V = n.vals, hs = n.hs ??= new Array(V.length);
      for (let i = 0; i < V.length; i++) if (hs[i] === undefined) { hs[i] = valHash(V[i]); if (deadline && ++k % 256 === 0 && deadline.timeRemaining() < 1) return false; }
    }
    nodeHash(r);
    return warm = true;
  }
  function warmLater() {
    warm = false;
    if (warming || typeof setTimeout !== "function") return;
    // Only while there is a shadow left to hash (a reset or an unloaded project stops it).
    const I = G.AtriumIdle, step = d => { warming = 0; if (root && !warm && !prime(d)) warmLater(); };
    warming = I ? I.idle(step, {timeout: 4000}) : setTimeout(() => step({timeRemaining: () => 8}), 50);
  }
  function checkHash(state) {
    if (!warm || state?.hash == null || !root || state.diskEpoch !== diskEpoch) return;
    vs.verified++;
    const h = nodeHash(root);
    if (h === state.hash) return;
    vs.mismatch++;
    const msg = "undo: the restored project differs from the saved state (hash " + h + " ≠ " + state.hash + ")";
    if (strict() === "throw") throw Error(msg);
    G.console?.error?.(msg);
  }

  // ---- shadow --------------------------------------------------------------------------------------
  // Container depth: the project 0, a document 1, a document's object fields 2.
  function shape(v, depth, key) {
    if (Array.isArray(v)) return depth === 0 && key === "documents" ? "l" : depth <= 2 ? "a" : "";
    return depth <= 1 && plain(v) ? "o" : "";
  }
  const childPath = (n, k) => n.path ? n.path + "." + k : k;

  // The table shadow is an immutable, ordered tree of serialized cells. A cell
  // edit copies its path only. The sequence hash is independent of tree shape,
  // so a structural capture and a series of certified edits hash identically.
  const liveTables=new WeakMap(), editValues=new WeakMap(), tableValues=new WeakSet();
  const CELL_CHUNK=64, cellCount=node=>node?.count||0, cellHeight=node=>node?.height||0;
  const chunkOf=(raw,count)=>({raw,count,bytes:raw.length});
  function chunkRows(chunk) {
    if(chunk.rows)return chunk.rows;
    // Split only at array-level separators. Substrings retain the authored
    // bytes and share storage with their original chunk.
    const rows=[],raw=chunk.raw;
    let start=1,depth=0,quoted=false;
    for(let i=1;i<raw.length-1;i++){
      const c=raw[i];
      if(quoted){if(c==="\\")i++;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;
      else if(c==="{" || c==="[")depth++;
      else if(c==="}" || c==="]")depth--;
      else if(c==="," && depth===0){rows.push(raw.slice(start,i));start=i+1;}
    }
    rows.push(raw.slice(start,-1));return chunk.rows=rows;
  }
  function chunkFromRows(rows) {
    return {rows,count:rows.length,bytes:rows.reduce((sum,row)=>sum+row.length+8,0)};
  }
  const chunkText=chunk=>chunk.raw ?? "["+chunk.rows.join(",")+"]";
  function cellNode(chunk,left,right) {
    return {chunk,left,right,count:chunk.count+cellCount(left)+cellCount(right),height:1+Math.max(cellHeight(left),cellHeight(right)),
      bytes:96+chunk.bytes+(left?.bytes||0)+(right?.bytes||0)};
  }
  const zeroDigest={a:0,b:0,ap:1,bp:1};
  const appendDigest=(left,right)=>({
    a:(Math.imul(left.a,right.ap)+right.a)|0,b:(Math.imul(left.b,right.bp)+right.b)|0,
    ap:Math.imul(left.ap,right.ap),bp:Math.imul(left.bp,right.bp)
  });
  function digestChunk(chunk) {
    if(chunk.digest)return chunk.digest;
    const raw=chunkText(chunk);
    let {a,b,ap,bp}=zeroDigest;
    // Treat the closing bracket as a comma so chunk boundaries are invisible
    // to the sequence digest, including after split, clear, and reinsertion.
    for(let i=1;i<raw.length;i++){
      const code=i===raw.length-1?44:raw.charCodeAt(i);
      a=(Math.imul(a,16777619)+code)|0;b=(Math.imul(b,0x5bd1e995)+code)|0;
      ap=Math.imul(ap,16777619);bp=Math.imul(bp,0x5bd1e995);
    }
    return chunk.digest={a,b,ap,bp};
  }
  function digestCells(node) {
    if(!node)return zeroDigest;
    return node.digest??=appendDigest(appendDigest(digestCells(node.left),digestChunk(node.chunk)),digestCells(node.right));
  }
  function turnLeft(n) {
    const p=n.right;
    return cellNode(p.chunk,cellNode(n.chunk,n.left,p.left),p.right);
  }
  function turnRight(n) {
    const p=n.left;
    return cellNode(p.chunk,p.left,cellNode(n.chunk,p.right,n.right));
  }
  function balanceCells(chunk,left,right) {
    const height=cellHeight(left)-cellHeight(right);
    if(height>1){
      if(cellHeight(left.right)>cellHeight(left.left))left=turnLeft(left);
      return turnRight(cellNode(chunk,left,right));
    }
    if(height< -1){
      if(cellHeight(right.left)>cellHeight(right.right))right=turnRight(right);
      return turnLeft(cellNode(chunk,left,right));
    }
    return cellNode(chunk,left,right);
  }
  function prependChunk(node,chunk) {
    return node ? balanceCells(node.chunk,prependChunk(node.left,chunk),node.right):cellNode(chunk,null,null);
  }
  function removeFirstChunk(node) {
    if(!node.left)return node.right;
    return balanceCells(node.chunk,removeFirstChunk(node.left),node.right);
  }
  function setCell(node,offset,before,after) {
    if(!node)return !before && offset===0 && after?cellNode(chunkFromRows([after]),null,null):undefined;
    const start=cellCount(node.left),end=start+node.chunk.count;
    if(offset<start){
      const left=setCell(node.left,offset,before,after);
      return left===undefined?undefined:balanceCells(node.chunk,left,node.right);
    }
    if(offset>end || offset===end && before){
      const right=setCell(node.right,offset-end,before,after);
      return right===undefined?undefined:balanceCells(node.chunk,node.left,right);
    }
    const rows=chunkRows(node.chunk).slice(),within=offset-start;
    if(before && rows[within]!==before)return undefined;
    rows.splice(within,before?1:0,...(after?[after]:[]));
    if(rows.length>CELL_CHUNK){
      const split=rows.splice(CELL_CHUNK>>1);
      return balanceCells(chunkFromRows(rows),node.left,prependChunk(node.right,chunkFromRows(split)));
    }
    if(rows.length)return cellNode(chunkFromRows(rows),node.left,node.right);
    if(!node.left || !node.right)return node.left||node.right;
    let next=node.right;
    while(next.left)next=next.left;
    return balanceCells(next.chunk,node.left,removeFirstChunk(node.right));
  }
  function buildCells(chunks,from=0,to=chunks.length) {
    if(from===to)return null;
    const mid=(from+to)>>1;
    return cellNode(chunks[mid],buildCells(chunks,from,mid),buildCells(chunks,mid+1,to));
  }
  function* cellChunks(node) {
    const stack=[];
    while(node || stack.length){
      while(node){stack.push(node);node=node.left;}
      node=stack.pop();yield node.chunk;node=node.right;
    }
  }
  function tableState(item) {
    const w=item?.widget,s=w?.state;
    return item?.kind==="textframe" && w?.type==="table" && s?.tableVersion===1 && Array.isArray(s.cells) &&
      !item.toJSON && !w.toJSON && !s.toJSON && !s.cells.toJSON ? s : null;
  }
  const itemFrame=item=>js({...item,widget:{...item.widget,state:null}});
  function tableHole(shell) {
    const key='"cells":', marker=key+"null",start=shell.indexOf(marker);
    return start>=0 && start===shell.lastIndexOf(marker)?[shell.slice(0,start+key.length),shell.slice(start+marker.length)]:null;
  }
  function tableValue(id,shell,frame,cells,shellDigest={hole:tableHole(shell)}) {
    let hash;
    const value={table:true,id,shell,frame,cells,shellDigest,version:{},bytes:shell.length+frame.length+(cells?.bytes||0),
      get hash(){
        if(hash===undefined){
          const d=digestCells(cells);
          hash=mix(shellDigest.hash??=hstr(shell),mix(cellCount(cells),pack(d.a,d.b)));
        }
        return hash;
      }};
    tableValues.add(value);return value;
  }
  function captureTable(item,state,was) {
    const frame=itemFrame(item),shell=js({...item,widget:{...item.widget,state:{...state,cells:null}}});
    const chunks=[];
    if(was?.table && state.cells.length===cellCount(was.cells)){
      let at=0,same=true;
      for(const prior of cellChunks(was.cells)){
        const raw=js(state.cells.slice(at,at+prior.count)),equal=raw===chunkText(prior);
        chunks.push(equal?prior:chunkOf(raw,prior.count));at+=prior.count;same&&=equal;
      }
      if(same){
        const value=shell===was.shell?was:tableValue(item.id,shell,frame,was.cells);
        liveTables.set(item,{state,value});return value;
      }
    }else for(let at=0;at<state.cells.length;at+=CELL_CHUNK){
      const rows=state.cells.slice(at,at+CELL_CHUNK);
      chunks.push(chunkOf(js(rows),rows.length));
    }
    const value=tableValue(item.id,shell,frame,buildCells(chunks));
    liveTables.set(item,{state,value});return value;
  }
  const cellArrayJSON=value=>"["+Array.from(cellChunks(value.cells),chunk=>chunkText(chunk).slice(1,-1)).join(",")+"]";
  function tableObject(value) {
    return JSON.parse(snapshotJSON(value));
  }
  function snapshotJSON(value) {
    if(!value?.table)return value;
    vs.tableSnapshots++;
    const hole=value.shellDigest.hole;
    if(hole)return hole[0]+cellArrayJSON(value)+hole[1];
    const item=JSON.parse(value.shell);
    item.widget.state.cells=JSON.parse(cellArrayJSON(value));
    return js(item);
  }
  function elementEdit(n,ref,before,after,tableEdit,offset) {
    /** @type {{t:string,node:any,ref:any,before?:any,after?:any,tableEdit?:any,cellOffset?:number,peer?:boolean}} */
    const r={t:"e",node:n,ref,...(tableEdit&&{tableEdit})};
    if(!before?.table && !after?.table)return {...r,before,after};
    if(offset!==undefined)r.cellOffset=offset;
    editValues.set(r,{before,after});
    return Object.defineProperties(r,{
      before:{enumerable:true,get:()=>snapshotJSON(before)},after:{enumerable:true,get:()=>snapshotJSON(after)}
    });
  }
  const valuesOf=r=>editValues.get(r)||r;
  function captureCell(n,item,was,proof) {
    if(!proof || !was?.table)return null;
    const state=tableState(item),known=liveTables.get(item);
    if(!state || known?.value!==was || known.state!==proof.prior || proof.next!==state || itemFrame(item)!==was.frame)return null;
    const change=G.AtriumTableData?.cellTransition(proof.prior,state);
    if(!change)return null;
    const {before,after,offset}=change,old=before?js(before):null,next=after?js(after):null;
    if(!before && offset!==cellCount(was.cells))return null;
    const cells=setCell(was.cells,offset,old,next);
    if(cells===undefined)return null;
    const value=tableValue(was.id,was.shell,was.frame,cells,was.shellDigest);
    liveTables.set(item,{state,value});vs.tableCells++;
    return elementEdit(n,item,was,value,{id:item.id,before:old,after:next},offset);
  }
  // Transient schematic routes follow their existing undo records. Serialized item
  // values and their hashes still describe only the authored document.
  const wireShadow = new WeakMap(), wireEdits = new WeakMap(), wireSplices = new WeakMap();
  const isWire = (node, item) => node.doc && node.path === "items" && item?.kind === "wire";
  function captureWire(item) {
    const state = G.Atrium?.wireStretchState?.(item);
    if (state) wireShadow.set(item, state); else wireShadow.delete(item);
    return state;
  }
  function playWire(item, state) {
    G.Atrium?.restoreWireStretch?.(item, state);
    if (state) wireShadow.set(item, state); else wireShadow.delete(item);
  }
  function captureElementEdit(node, item, before, after, hint) {
    const record = elementEdit(node, item, before, after, hint);
    if (isWire(node, item)) {
      const old = wireShadow.get(item), next = captureWire(item);
      if (old || next) wireEdits.set(record, [old, next]);
    }
    return record;
  }
  const stretchSize = state => state ? 64 + 48 * (state.base.length + state.path.length) : 0;
  // old: a node this one replaces, whose equal strings are reused (shared, not copied).
  function build(v, t, depth, path, doc, old) {
    const n = {t, ref: v, depth, path, doc, bytes: 0};
    if (t === "o") {
      if (depth === 1 && path === "") n.doc = n;
      n.kids = new Map();
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (skip(x)) continue;
        const s = shape(x, depth, k), was = old?.t === "o" ? old.kids.get(k) : undefined;
        if (s) { const c = build(x, s, s === "o" ? depth + 1 : depth, childPath(n, k), n.doc, typeof was === "object" ? was : null); n.kids.set(k, c); n.bytes += c.bytes; }
        else { let j = js(x); if (j === was) j = was; n.kids.set(k, j); n.bytes += size(j); }
      }
      return n;
    }
    n.refs = v.slice(); n.vals = new Array(v.length); n.sh = t === "a" && /(^|\.)pours$/.test(path);
    if (t === "a") n.hs = new Array(v.length);
    const oldAt = old && old.t === t ? new Map() : null;
    if (oldAt) for (let i = 0; i < old.refs.length; i++) if (isObj(old.refs[i])) oldAt.set(old.refs[i], old.vals[i]);
    for (let i = 0; i < v.length; i++) {
      const e = v[i], val = element(n, e, oldAt?.get(e)); n.vals[i] = val; n.bytes += size(val);
      if (isWire(n, e)) captureWire(e);
    }
    return n;
  }
  function element(n, e, was) {
    if (n.t === "l" && plain(e)) return build(e, "o", 1, "", null, typeof was === "object" ? was : null);
    if (n.sh && plain(e)) return shallowOf(e);
    const state=n.doc && n.path==="items" && tableState(e);
    if(state)return captureTable(e,state,was);
    const j = js(e);
    if (j === was && isWire(n, e) && wireShadow.has(e)) captureWire(e);
    return j === was ? was : j;
  }

  // ---- sync: live project -> records ------------------------------------------------------------------
  function visitO(n, out) {
    const o = n.ref;
    let seen = 0, added = 0;
    for (const k of Object.keys(o)) {
      const x = o[k];
      if (skip(x)) continue;
      const kid = n.kids.get(k), s = shape(x, n.depth, k);
      if (kid !== undefined) seen++;
      if (s && typeof kid === "object" && kid.t === s) {
        if (kid.ref !== x) {
          if (s === "o") { setKid(n, k, build(x, s, n.depth + 1, childPath(n, k), n.doc, kid), out, kid); continue; }
          kid.ref = x;   // a new array object: compared element by element below
        }
        visit(kid, out);
        continue;
      }
      if (s) { added += setKid(n, k, build(x, s, s === "o" ? n.depth + 1 : n.depth, childPath(n, k), n.doc, null), out, kid); continue; }
      const j = js(x);
      if (j !== kid) added += setKid(n, k, j, out, kid);
    }
    if (seen + added !== n.kids.size) {
      const live = new Set(Object.keys(o).filter(k => !skip(o[k])));
      for (const k of [...n.kids.keys()]) if (!live.has(k)) setKid(n, k, undefined, out, n.kids.get(k));
    }
  }
  // A container key set, replaced or deleted. When a key appears or goes, both key orders are
  // kept (the shadow's order mirrors the live object's) so undo and redo restore it exactly.
  function setKid(n, k, val, out, was) {
    const kb = was === undefined || val === undefined ? [...n.kids.keys()] : null;
    if (val === undefined) n.kids.delete(k); else n.kids.set(k, val);
    out.push({t: "k", node: n, key: k, before: was, after: val, kb, ka: kb ? [...n.kids.keys()] : null});
    shadowBytes += size(val) - size(was);
    return was === undefined ? 1 : 0;
  }
  function visitA(n, out) {
    const v = n.ref;
    let same = v.length === n.refs.length;
    if (same) for (let i = 0; i < v.length; i++) if (v[i] !== n.refs[i]) { same = false; break; }
    if (!same) structure(n, out);
    const R = n.refs, V = n.vals;
    if (n.t === "l") { for (let i = 0; i < R.length; i++) if (typeof V[i] === "object") visitO(V[i], out); else contentAt(n, i, out); return; }
    if (only && n.doc && n.path === "items") return scoped(n, out);
    if (only && !n.doc && n.path === "library" && !only.library) return;
    for (let i = 0; i < R.length; i++) {
      const e = R[i];
      if (e === null || typeof e !== "object") continue;
      if (n.sh && V[i]?.sh) { if (!sameShallow(e, V[i])) { const v = shallowOf(e); out.push({t: "e", node: n, ref: e, before: V[i], after: v}); V[i] = v; leaf(n, i); } continue; }
      const j = element(n,e,V[i]);
      if (j !== V[i]) { out.push(captureElementEdit(n,e,V[i],j)); shadowBytes += size(j) - size(V[i]); V[i] = j; leaf(n, i); }
    }
  }
  // A hinted sync of a document's items: only the hinted elements' content, in list order.
  function scoped(n, out) {
    const s = only.docs.get(n.doc.ref);
    if (!s?.size) return;
    const R = n.refs, V = n.vals, at = new Set();
    if (!n.at) {
      const positions = n.at = new Map();
      for (let i = R.length-1; i >= 0; i--) if (isObj(R[i])) {
        positions.set(R[i],i);
        if (typeof R[i].id === "string") positions.set(R[i].id,i);
      }
    }
    for (const changed of s) {
      const index = n.at.get(changed);
      if (index !== undefined) at.add(index);
    }
    for (const i of [...at].sort((a,b) => a-b)) {
      const e=R[i],before=V[i],record=captureCell(n,e,before,only.tableCells.get(n.doc.ref)?.get(e.id));
      const after=record?valuesOf(record).after:element(n,e,before);
      if(after!==before){
        out.push(record??captureElementEdit(n,e,before,after,tableCellHint(e)));
        shadowBytes+=size(after)-size(before);V[i]=after;leaf(n,i);
      }
    }
  }
  function tableCellHint(item) {
    const tables = G.AtriumTableData;
    if (!tables?.isItem(item)) return null;
    const change = tables.recentCellEdit?.(item.widget.state);
    return change ? {id:item.id, before:change.before?js(change.before):null, after:change.after?js(change.after):null} : null;
  }
  function exactTableCellEdit(record) {
    const {tableEdit,cellOffset}=record;
    if (!tableEdit) return false;
    if(cellOffset!==undefined)return true;
    const {before,after}=record;
    // Verify that the serialized owner differs only at the reported sparse cell.
    const {before:oldCell,after:newCell}=tableEdit;
    if(!oldCell || !newCell){
      const cell=oldCell||newCell, larger=oldCell?before:after, smaller=oldCell?after:before;
      const at=larger.indexOf(cell);
      if(at<1 || larger.indexOf(cell,at+1)>=0)return false;
      let start=at,end=at+cell.length;
      if(larger[start-1]===",")start--;
      else if(larger[end]===",")end++;
      else if(larger[start-1]!=="[" || larger[end]!=="]")return false;
      return smaller===larger.slice(0,start)+larger.slice(end);
    }
    const at = after.indexOf(newCell);
    return at >= 0 && after.indexOf(newCell, at + 1) < 0 && before.startsWith(oldCell, at) &&
      before.slice(0, at) === after.slice(0, at) && before.slice(at + oldCell.length) === after.slice(at + newCell.length);
  }
  function tableCellEdit(record, dir = 1) {
    if (!exactTableCellEdit(record)) return null;
    const {id, before, after} = record.tableEdit;
    return {id, before:JSON.parse(dir > 0 ? before : after), after:JSON.parse(dir > 0 ? after : before)};
  }
  function tableItemSnapshot(record,dir) {
    const values=editValues.get(record);
    const value=values?(dir>0?values.after:values.before):record;
    return tableValues.has(value)?{id:value.id,tableJSON:()=>snapshotJSON(value)}:null;
  }
  function contentAt(n, i, out) {
    const e = n.refs[i];
    if (!isObj(e)) return;
    const j = js(e);
    if (j !== n.vals[i]) { out.push(elementEdit(n,e,n.vals[i],j)); n.vals[i] = j; leaf(n, i); }
  }
  // Identity diff of an array against its shadow: removals and insertions, in order.
  function structure(n, out) {
    const R = n.refs, v = n.ref, N = R.length, M = v.length;
    let p = 0, s = 0;
    while (p < N && p < M && v[p] === R[p]) p++;
    while (s < N - p && s < M - p && v[M - 1 - s] === R[N - 1 - s]) s++;
    let removed = [], inserted = [], ok = true;
    if (p + s < N && p + s < M) {
      const at = new Map();
      for (let i = p; i < N - s && ok; i++) { const e = R[i]; if (!isObj(e) || at.has(e)) ok = false; else at.set(e, i); }
      if (ok) {
        let last = -1;
        for (let j = p; j < M - s; j++) {
          const e = v[j], i = isObj(e) ? at.get(e) : undefined;
          if (i === undefined) inserted.push([j, e, null]);
          else if (i < last) { ok = false; break; }
          else { last = i; at.delete(e); }
        }
        if (ok) { for (const i of at.values()) removed.push([i, R[i], n.vals[i]]); removed.sort((a, b) => a[0] - b[0]); }
      }
      if (!ok) { removed = []; inserted = []; }
    }
    if (!ok || p + s >= N || p + s >= M) {
      for (let i = p; i < N - s; i++) removed.push([i, R[i], n.vals[i]]);
      for (let j = p; j < M - s; j++) inserted.push([j, v[j], null]);
    }
    for (const op of inserted) {
      op[2] = element(n, op[1]); shadowBytes += size(op[2]);
      const state = isWire(n, op[1]) && captureWire(op[1]);
      if (state) wireSplices.set(op, state);
    }
    for (const op of removed) {
      shadowBytes -= size(op[2]);
      const state = isWire(n, op[1]) && wireShadow.get(op[1]);
      if (state) wireSplices.set(op, state);
    }
    edit(n.refs, removed, inserted, 1); edit(n.vals, removed, inserted, 2); reshape(n, removed, inserted);
    out.push({t: "s", node: n, removed, inserted});
  }
  const visit = (n, out) => n.t === "o" ? visitO(n, out) : visitA(n, out);
  // Removes then inserts (removed by old index, inserted by new index, both ascending).
  function edit(arr, removed, inserted, pick) {
    if (removed.length + inserted.length <= SPLICE_MAX) {
      for (let r = removed.length - 1; r >= 0; r--) arr.splice(removed[r][0], 1);
      for (const op of inserted) arr.splice(op[0], 0, op[pick]);
      return;
    }
    const kept = [];
    for (let i = 0, r = 0; i < arr.length; i++) { if (r < removed.length && removed[r][0] === i) { r++; continue; } kept.push(arr[i]); }
    const total = kept.length + inserted.length;
    arr.length = total;
    for (let j = 0, a = 0, q = 0; j < total; j++) arr[j] = q < inserted.length && inserted[q][0] === j ? inserted[q++][pick] : kept[a++];
  }

  // project: the live project (the editor's), when it may differ from the shadow's.
  function sync(project) {
    if (project) pending = project;
    if (!dirty && !scope && root && root.ref === (pending || root.ref)) return;
    const p = pending || root?.ref, sc = dirty ? null : scope;
    const clean = p && p === cleanFolder && !dirty && !scope && !later && !quiet;
    dirty = false; later = false; scope = null; G.clearTimeout?.(timer); timer = 0;
    if (!p) return;
    if (!root) {
      cleanFolder = null;
      root = build(p, "o", 0, "", null, null);
      shadowBytes = root.bytes;
      // A verified folder already started a fresh journal when the editor adopted it.
      // Capturing its unchanged state does not invalidate the cursor used by its first paint.
      if (!clean) gap();
      warmLater();
      if (H) lift(H, F || []);
      return;
    }
    const out = [];
    if (root.ref !== p) {
      const next = build(p, "o", 0, "", null, root);
      out.push({t: "r", before: root, after: next});
      root = next; shadowBytes = next.bytes; warmLater();
    } else if (!sc) { vs.full++; visitO(root, out); }
    else {
      vs.scoped++;
      only = sc;
      try { visitO(root, out); } finally { only = null; }
      // Verification: a full comparison after the hinted one; anything it finds was not reported.
      if (strict()) {
        const extra = [];
        visitO(root, extra);
        if (extra.length) {
          vs.missed += extra.length;
          const where = extra.slice(0, 4).map(r => (r.node?.doc?.ref?.name ?? "") + ":" + (r.node?.path ?? "") + (r.t === "k" ? "." + r.key : r.ref?.id ? "#" + r.ref.id : "")).join(", ");
          out.push(...extra);
          if (strict() === "throw") { commit(out); throw Error("undo: an edit changed " + extra.length + " object(s) it did not report: " + where); }
          G.console?.warn?.("undo: an edit changed objects it did not report: " + where);
        }
      }
    }
    commit(out);
  }
  let rejecting=0;
  function authored(out, dir, restored = false) {
    if (rejecting || !out.length || !authoredListeners.size) return;
    for (const fn of authoredListeners) try { fn(out, dir, root?.ref, liveAct?.action, restored); }
    catch (error) { G.console?.error?.(error); }
  }
  let peerDepth = 0;
  // Collaboration patches enter the history mirror, but stay owned by their peer.
  function peerPatch(project, fn) {
    sync(project);
    peerDepth++;
    try { return fn(); } finally { try { sync(project); } finally { peerDepth--; } }
  }
  function commit(out) {
    if (!out.length) return;
    if (peerDepth) for (const r of out) r.peer = true;
    const previousLibrary = libraryVersion;
    for (const r of out) { logBytes += weigh(r); journal(r, 1); stackEdit(r); }
    for (const r of out) log.push(r);
    authored(out, 1);
    out.length = 0; gen++;
    if (previousLibrary !== libraryVersion) for (const f of libraryListeners) {
      try { f(); } catch (e) { G.console?.error?.(e); }
    }
  }
  function weigh(r) {
    if (r.w) return r.w;
    let w = 48;
    if (r.t === "e"){
      const {before,after}=valuesOf(r);
      w+= r.cellOffset!==undefined ? 160+144*cellHeight(after.cells)+8*CELL_CHUNK : held(before)+held(after);
      w+=r.tableEdit?size(r.tableEdit.before)+size(r.tableEdit.after):0;
      const stretch = wireEdits.get(r);
      if (stretch) w += stretchSize(stretch[0]) + stretchSize(stretch[1]);
    }
    else if (r.t === "k") w += size(r.before) + size(r.after);
    else if (r.t === "s") {
      for (const op of r.removed) w += 24 + held(op[2]) + stretchSize(wireSplices.get(op));
      for (const op of r.inserted) w += 24 + held(op[2]) + stretchSize(wireSplices.get(op));
    }
    else w += r.before.bytes;
    return r.w = w;
  }
  // The editor changed something: record it when idle (or before the next step starts).
  // The change() that follows an undo or redo finds the shadow exact already: a later idle pass
  // checks it, so repeated undo never waits for a sync.
  // hint (optional): {doc, items, library?} or a list of them, what the change touched (see the top).
  function touch(project, hint, restored = false) {
    if (project) pending = project;
    if (settled && restored) later = true;
    else hinted(hint);
    settled = false;
    gen++;
    if (timer || typeof setTimeout !== "function") return;
    const run = () => { timer = 0; if (later) { later = false; dirty = true; } if (dirty || scope) sync(); };
    // When idle (idle.js: requestIdleCallback, or in WebKit after input and frames have stopped), at most 400 ms later.
    const I = G.AtriumIdle;
    if (!I) { timer = setTimeout(run, 30); return; }
    const id = I.idle(run, {timeout: 400}); timer = setTimeout(() => { I.cancel(id); run(); }, 400);
  }
  // A visible PCB commit uses its exact journal for the next paint.
  function record(project, hint) {
    settled = false;
    hinted(hint);
    sync(project);
  }

  // ---- applying records to the live project ------------------------------------------------------------
  // Patch an object or array in place to the value of a JSON text (identity kept; key order kept).
  function patch(o, text) {
    const v = typeof text === "string" ? JSON.parse(text) : text.table ? tableObject(text) : fromShallow(text);
    if (Array.isArray(o)) { o.length = v.length; for (let i = 0; i < v.length; i++) o[i] = v[i]; return; }
    const keys = Object.keys(v);
    for (const k of Object.keys(o)) if (!(k in v)) delete o[k];
    for (const k of keys) o[k] = v[k];
    if(text.table)liveTables.set(o,{state:o.widget.state,value:text});else liveTables.delete(o);
    const now = Object.keys(o);
    if (now.length === keys.length && now.every((k, i) => k === keys[i])) return;
    for (const k of now) delete o[k];
    for (const k of keys) o[k] = v[k];
  }
  // Restores a container's key order (and the shadow's, which mirrors it).
  function orderKeys(n, ks) {
    const o = n.ref;
    if (!ks) return;
    const cur = Object.keys(o).filter(k => !skip(o[k]));
    if (!(cur.length === ks.length && cur.every((k, i) => k === ks[i]))) {
      const vals = {}; for (const k of Object.keys(o)) vals[k] = o[k];
      for (const k of Object.keys(o)) delete o[k];
      for (const k of ks) if (k in vals) o[k] = vals[k];
      for (const k of Object.keys(vals)) if (!(k in o)) o[k] = vals[k];
    }
    const kids = new Map();
    for (const k of ks) if (n.kids.has(k)) kids.set(k, n.kids.get(k));
    for (const [k, v] of n.kids) if (!kids.has(k)) kids.set(k, v);
    n.kids = kids;
  }
  // Element positions: a scan for a few lookups, a map once a list is looked up repeatedly.
  let index = new Map();
  function indexOf(n, ref) {
    let m = index.get(n);
    if (!(m instanceof Map)) {
      const c = (m || 0) + 1;
      if (c < 4 || n.refs.length < 512) { index.set(n, c); return n.refs.indexOf(ref); }
      m = new Map(); n.refs.forEach((r, j) => { if (isObj(r)) m.set(r, j); }); index.set(n, m);
    }
    const i = m.get(ref);
    return i === undefined ? -1 : i;
  }
  // ---- change journal: the document items each applied record touched (online DRC reads it) -------------
  // Entries [doc, item, its value before or undefined, present after]. Positions only grow; floor is
  // the first one from which the journal is complete (raised by a project or document-list change, a
  // fresh shadow, a reset, an overflow, or a record that replaces a document's items list).
  // outer counts the applied records outside documents' items and poured regions (library, rules,
  // layer names, outline, other keys) and every gap: online DRC reuses its whole-board extra checks
  // while the items, this and the rules are unchanged (a live pour's repour changes only pours).
  let jlog = [], jbase = 0, floor = 0, quiet = false, outer = 0, libraryVersion = 0;
  let cleanFolder = null;
  // parameterVersion: project parameters alone (sheet fields, title blocks, board strings read them; rules,
  // connectivity and geometry do not), so a parameter edit leaves projectVersion and its readers alone.
  let projectVersion = 0, parameterVersion = 0, assemblyVersion = 0, sheetTreeVersion = 0;
  const docVersions = new WeakMap(), definitionVersions = new WeakMap();
  const definitionVersion = def => definitionVersions.get(def) || 0;
  let familyVersion = 0;
  const POUR_KEYS = new Set(["pours", "pourSignatures", "pourSignatureVersion", "importedPourSignature", "sourceHatchSignature"]); // pcbDrawing keys a repour writes (canvas.js too)
  const jend = () => jbase + jlog.length;
  function gap(libraryChanged = true) {
    sheetCaches = new WeakMap(); jbase = jend() + 1; jlog = []; floor = jbase;
    outer++; sheetTreeVersion++; parameterVersion++;
    if (libraryChanged) libraryVersion++;
  }
  const partValue = v => typeof v === "string" && v.includes('"kind":"part"');
  function sheetTreeValue(value) {
    if (typeof value !== "string") return "";
    if (value.includes('"kind":"sheetsymbol"')) {
      const s = JSON.parse(value);
      if (s.kind === "sheetsymbol") return JSON.stringify([s.id, s.sheet, s.name, s.repeat?.name, s.repeat?.from, s.repeat?.to, !!s.entries?.length]);
    } else if (value.includes('"kind":"port"') || value.includes('"type":"port"')) {
      const p = JSON.parse(value);
      if (p.kind === "port" || p.kind === "netlabel" && p.schPaint?.type === "port") return JSON.stringify([p.id, p.text, p.io]);
    }
    return "";
  }
  function jot(doc, ref, was, present, next) {
    if (isObj(ref)) {
      jlog.push([doc,ref,was?.table?{table:true,id:was.id}:was,present]);
      // A part on another sheet or board can determine whether its linked body is fitted.
      if (ref.kind === "part" || partValue(was) || partValue(next)) assemblyVersion++;
      if (doc.kind === "schematic" && sheetTreeValue(was) !== sheetTreeValue(next)) sheetTreeVersion++;
    }
    if (jlog.length > 8192) gap();
  }
  function bumpDocument(doc, key) {
    let v = docVersions.get(doc);
    if (!v) { v = {items: 0, outer: 0, pours: 0}; docVersions.set(doc, v); }
    v[key]++;
  }
  function journal(r, dir) {
    if (quiet) return;
    // Browsing metadata remains in the undo/save log. It changes neither placed
    // geometry nor terminal mappings, even when the first family is added or the last is removed.
    if (r.t !== "r" && !r.node.doc && (r.node.path === "componentFamilies" ||
        r.t === "k" && r.node.path === "" && r.key === "componentFamilies")) { familyVersion++; return; }
    // Project parameters feed sheet fields, drawing title blocks and board strings.
    // Their values can change without changing item identity or library geometry.
    if (r.t !== "r" && !r.node.doc && (r.node.path === "parameters" ||
        r.t === "k" && r.node.path === "" && r.key === "parameters")) {
      outer++;parameterVersion++;return;
    }
    if (r.t === "r" || r.t === "s" && r.node.t === "l" || r.t === "k" && (!r.node.doc || r.node.doc === r.node && r.key === "items")) return gap();
    const n = r.node, d = n.doc?.ref;
    if (!d || n.path !== "items" || r.t === "k") {
      const pour = n.sh || r.t === "k" && (n.path === "pcbDrawing" ? (POUR_KEYS.has(r.key)||globalThis.AtriumPourMarker?.isKey(r.key)) : n.path === "" && r.key === "sourcePourSignature");
      if (!pour) outer++;
      if (d) bumpDocument(d, pour ? "pours" : "outer");
      else if (n.path === "library") {
        libraryVersion++;
        // In-place changes retain the definition identity; replacing/adding/removing definitions
        // is also observable through the current library index. Undo and redo pass here too.
        if (r.t === "e") definitionVersions.set(r.ref, definitionVersion(r.ref) + 1);
      }
      else projectVersion++;
      return;
    }
    bumpDocument(d, "items");
    if (r.t === "e"){
      const {before,after}=valuesOf(r);
      return jot(d,r.ref,dir>0?before:after,true,dir>0?after:before);
    }
    const [rem, ins] = dir > 0 ? [r.removed, r.inserted] : [r.inserted, r.removed];
    for (const op of rem) jot(d, op[1], op[2], false, undefined);
    for (const op of ins) jot(d, op[1], undefined, true, op[2]);
  }
  function duringEdit(fn) { editing++; try { return fn(); } finally { editing--; } }
  // Scope non-item dependencies without scanning a project. A prior sequence below
  // floor must rebuild; null means this live project has no complete committed read yet.
  function documentVersions(doc, project = root?.ref, committedItems = false) {
    if (editing || dirty || scope || (later && !committedItems) || quiet || !root || root.ref !== project || !project.documents?.includes(doc)) return null;
    const v = docVersions.get(doc);
    return {seq: jend(), floor, items: v?.items ?? 0, outer: v?.outer ?? 0, pours: v?.pours ?? 0,
      project: projectVersion, parameters: parameterVersion, library: libraryVersion, assembly: assemblyVersion};
  }
  // Verified native owners may be readable before the first Undo baseline. The
  // cold cursor changes on disk adoption without serializing untouched documents.
  function verifiedDocumentVersion(doc) {
    if (!root && !editing && !dirty && !scope && !later && !quiet && cleanFolder &&
        (!pending || pending === cleanFolder) && cleanFolder.documents?.includes(doc)) return floor;
    return null;
  }
  // One demand-driven entry per live sheet. Consumers keep their different projections here:
  // net names, physical ERC contacts and hierarchy entries/buses have distinct electrical rules.
  let sheetCaches = new WeakMap();
  function sheetEntry(project, doc, defs, revisionHost) {
    if (!project || !doc || doc.kind !== "schematic") return null;
    const host = revisionHost || globalThis.AtriumNavHost;
    if (host?.doc?.() === doc && host.drag?.()?.before) return null;
    if (editing) return null;
    const v = documentVersions(doc, project);
    // Only interactive reads may share an uncommitted result, within that one editor revision.
    const rev = !v && revisionHost?.project?.() === project && revisionHost.defs?.() === defs && project.documents.includes(doc)
      ? revisionHost.revision?.() : null;
    if (!v && rev == null) return null;
    let cache = sheetCaches.get(project);
    if (!cache) { cache = {sheets:new WeakMap()}; sheetCaches.set(project, cache); }
    const objects = globalThis.AtriumSchObjects, old = cache.sheets.get(doc);
    const geometry = old && old.items === doc.items && old.count === doc.items.length && old.source === doc.sourceName && old.objects === objects;
    if (!v) {
      if (geometry && !old.v && old.rev === rev && old.defs === defs) return old;
      const e = {items:doc.items, count:doc.items.length, source:doc.sourceName, objects, rev, defs};
      cache.sheets.set(doc, e);
      return e;
    }
    // Fresh Map instances built by different clients can describe the same project library.
    // Compare the definitions used by this sheet, including a previously missing definition.
    if (cache.floor !== v.floor || cache.library !== v.library || cache.list !== project.library) {
      cache.index = new Map(project.library.map(def => [def.id, def]));
      cache.floor = v.floor; cache.library = v.library; cache.list = project.library;
    }
    if (geometry && old.v && old.v.floor === v.floor && old.v.items === v.items && old.v.outer === v.outer &&
        old.deps.every(([id, def, version]) => cache.index.get(id) === def &&
          (!defs || defs.get(id) === def) && definitionVersion(def) === version)) return old;
    const ids = new Set();
    for (const item of doc.items) if (item.kind === "part") ids.add(item.def);
    const deps = [];
    for (const id of ids) {
      const def = cache.index.get(id);
      if (defs && defs.get(id) !== def) return null; // custom definitions and placement previews
      deps.push([id, def, definitionVersion(def)]);
    }
    const e = {items:doc.items, count:doc.items.length, source:doc.sourceName, objects, deps, v, projectCache:cache};
    cache.sheets.set(doc, e);
    return e;
  }
  // A settled undo can queue another check for display metadata (units). Its sheet tree is
  // already committed. Any subsequent touch marks the journal dirty before the check runs.
  function hierarchyVersion(project) {
    return dirty || scope || quiet || editing || root?.ref !== project ? null : sheetTreeVersion;
  }
  // The items of `doc` changed since journal position `since` (a `seq` returned earlier):
  // {seq, ids (every id they had), items (id → live item)}; ids null when not known.
  function changed(doc, since, limit) {
    if (dirty || scope) sync();
    return recordedChanges(doc, since, limit);
  }
  // Renderers can read the committed journal without serializing the project in a frame.
  // A null sequence means an edit still needs to be recorded. Live previews are outside the journal.
  function recordedChanges(doc, since, limit = 2000) {
    if (dirty || scope || quiet) return {seq: null, ids: null, items: null};
    const seq = jend();
    if (!root || since == null || since < floor || since > seq) return {seq, ids: null, items: null};
    const last = new Map(), ids = new Set();
    for (let k = since - jbase; k < jlog.length; k++) {
      const [d, ref, was, present] = jlog[k];
      if (d !== doc) continue;
      last.delete(ref); last.set(ref, present);
      if (last.size > limit) return {seq, ids: null, items: null};
      ids.add(ref.id);
      if(was?.table)ids.add(was.id);
      if (typeof was === "string" && !was.includes('"id":' + JSON.stringify(ref.id))) { try { ids.add(JSON.parse(was).id); } catch { return {seq, ids: null, items: null}; } }
    }
    const items = new Map();
    for (const [ref, present] of last) if (present) items.set(ref.id, ref);
    return {seq, ids, items};
  }
  // Live collaboration needs the exact after-values of committed edits. A drag preview
  // can already be mutating the live objects when its preceding edit is published.
  // Anchor the cursor to a record, not just its position: undo can fork at the same
  // position. The token does not keep a discarded undo record or project alive.
  const recordCursors = new WeakMap();
  function cursorAt(pos) {
    if (pos < base || pos > end()) return null;
    const record = log[pos - base - 1] || root;
    let cursor = recordCursors.get(record);
    if (cursor?.pos !== pos) recordCursors.set(record, cursor = {pos});
    return cursor;
  }
  function itemEdits(project, since, settle = false) {
    if (editing || quiet || later) return null;
    if (settle) sync(project);
    if (dirty || scope || !root || root.ref !== project) return null;
    const cursor = cursorAt(end());
    if (!since || cursorAt(since.pos) !== since) return {cursor, updates: null};
    const records = new Map(), moves = new Map();
    for (let at = since.pos - base; at < log.length; at++) {
      const r = log[at];
      // Project metadata, the document list, library geometry and derived pours need the full
      // collaboration comparison. Items changed in place and items added to, removed from or
      // moved within a document's list (the identity splices `s`) are reported as they are.
      if (r.t !== "e" && r.t !== "s" || r.node.path !== "items" || !r.node.doc) return {cursor, updates: null};
      if (r.t === "s") {
        const doc = r.node.doc.ref;
        let m = moves.get(doc);
        if (!m) moves.set(doc, m = new Map());
        // Per item: present at the cursor, present now, and its value when it first left.
        for (const [, ref, val] of r.removed) {
          const s = m.get(ref);
          if (s) s.now = false; else m.set(ref, {was: true, now: false, val});
        }
        for (const [, ref] of r.inserted) {
          const s = m.get(ref);
          if (s) s.now = true; else m.set(ref, {was: false, now: true});
        }
        continue;
      }
      const previous = records.get(r.ref), {before,after}=valuesOf(r);
      if (previous) { previous.after = after; previous.record = null; }
      else records.set(r.ref, {doc:r.node.doc.ref.id,before,after,record:r});
    }
    const structure = [];
    for (const [doc, m] of moves) {
      const added = [], removed = [];
      for (const [ref, s] of m) {
        records.delete(ref);   // its value is read from the live item
        if (!isObj(ref) || typeof ref.id !== "string") return {cursor, updates: null};
        if (s.was) {
          // The id it had at the cursor: an item whose id changed is compared as a whole project.
          const id = typeof s.val === "string" ? s.val.includes('"id":' + JSON.stringify(ref.id)) && ref.id : s.val?.table ? s.val.id : null;
          if (id !== ref.id) return {cursor, updates: null};
          if (!s.now) removed.push(id);
        }
        if (s.now) added.push(ref);
      }
      if (added.length || removed.length) structure.push({doc: doc.id, items: doc.items, added, removed});
    }
    const updates = [];
    for (const r of records.values()) {
      const tableEdit = r.record && tableCellEdit(r.record);
      if (tableEdit?.before && tableEdit.after) {
        updates.push({doc:r.doc,tableEdit:{...tableEdit,
          beforeVersion:r.before?.version,afterVersion:r.after?.version,
          get beforeJSON(){return snapshotJSON(r.before);},get afterJSON(){return snapshotJSON(r.after);}},
          get before(){return parse(r.before);},get after(){return parse(r.after);}});
        continue;
      }
      const before=parse(r.before),after=parse(r.after);
      if (before.id !== after.id) return {cursor, updates: null};
      updates.push({doc: r.doc, before, after});
    }
    return {cursor, updates, structure};
  }
  // Qualify journaled edits without recording the project. A comparator sees the
  // saved value before each update and the current item. Any splice is uncertain.
  function onlyRecordedItemUpdates(doc, since, matches) {
    if (dirty || scope || later || quiet || !root || since == null || since < floor || since > jend()) return false;
    let found = false;
    for (let k = since - jbase; k < jlog.length; k++) {
      const [d, item, was, present] = jlog[k];
      if (d !== doc) continue;
      if (!present || typeof was !== "string" || !matches(JSON.parse(was), item)) return false;
      found = true;
    }
    return found;
  }
  // Short foreground projections preserve source order through in-place changes, deletes and
  // appends. A middle insertion or a remove/reinsert of an existing item can change tie breaks.
  // The committed item journal is exact immediately after Undo, including its deferred units check.
  function orderedItemChanges(doc, since, hasOld) {
    if (editing) return null;
    const change = recordedChanges(doc, since);
    if (!change.ids) return null;
    const added = new Set();
    for (let k = since - jbase; k < jlog.length; k++) {
      const [d, item, was, present] = jlog[k];
      if (d !== doc) continue;
      if (!present || was === undefined) {
        if (hasOld(item.id) && change.items.has(item.id)) return null;
        if (!hasOld(item.id) && change.items.has(item.id)) added.add(item.id);
      }
    }
    for (const id of change.items.keys()) if (!hasOld(id) && !added.has(id)) return null; // renamed ID
    // Expose insertion order as it appears on the board, independent of the collection of journal refs.
    const append = [];
    for (let k = doc.items.length - added.size; k < doc.items.length; k++) {
      const item = doc.items[k];
      if (!item || !added.delete(item.id)) return null;
      append.push(item);
    }
    return {change, append};
  }
  // One demand-driven item projection for consumers of identities, counts and component membership.
  const itemProjections = new WeakMap();
  function documentItems(doc, project, version = documentVersions(doc, project, true)) {
    if (!version) return null;
    let entry = itemProjections.get(doc);
    if (!entry || entry.project !== project || entry.source !== doc.items || entry.version.floor !== version.floor || entry.version.seq > version.seq)
      entry = null;
    if (entry?.version.items !== version.items) {
      const delta = entry && orderedItemChanges(doc, entry.version.seq, id => entry.byId.has(id));
      const ordered = delta && [...delta.change.items.values()].every(item =>
        item.kind !== "part" || !entry.byId.has(item.id) || entry.parts.has(item.id));
      if (ordered) {
        for (const id of delta.change.ids) if (entry.byId.has(id)) updateProjection(entry, id, delta.change.items.get(id));
        for (const item of delta.append) updateProjection(entry, item.id, item);
      } else {
        entry = {project, source: doc.items, byId: new Map(), kinds: new Map(), counts: new Map(), parts: new Map(), components: null};
        for (const item of doc.items) updateProjection(entry, item.id, item);
        itemProjections.set(doc, entry);
      }
    }
    entry.version = version;
    entry.components ??= [...entry.parts.values()];
    return entry;
  }
  function updateProjection(entry, id, item) {
    const before = entry.kinds.get(id), after = item?.kind;
    if (before !== after) {
      if (before) entry.counts.set(before, entry.counts.get(before) - 1);
      if (after) entry.counts.set(after, (entry.counts.get(after) || 0) + 1);
    }
    if (item) { entry.byId.set(id, item); entry.kinds.set(id, after); }
    else { entry.byId.delete(id); entry.kinds.delete(id); }
    if (after === "part") { entry.parts.set(id, item); entry.components = null; }
    else if (entry.parts.delete(id)) entry.components = null;
  }
  // A collapsed board overview can survive an unchanged revision or a geometry-only track edit.
  function trackOverview(doc, project, previous, inputs, reuse) {
    const v = documentVersions(doc, project); if (!v) return null;
    const key = [doc, doc.items, project, v.floor, v.outer, v.library, v.project, v.parameters, v.assembly, ...inputs];
    const keep = reuse && previous?.key?.every((value, i) => key[i] === value) &&
      (previous.seq === v.seq || onlyRecordedItemUpdates(doc, previous.seq, (a, b) => a.kind === "track" &&
        b.kind === a.kind && a.id === b.id && a.layer === b.layer && a.net === b.net));
    return {key, seq: v.seq, keep};
  }
  // One record forward (dir 1) or backward (dir -1), on the live project and the shadow alike.
  function play(r, dir) {
    journal(r, dir);
    if (r.t === "e") {
      const n=r.node,i=indexOf(n,r.ref),{before,after}=valuesOf(r);
      const to=dir>0?after:before,from=dir>0?before:after;
      if (i < 0) throw Error("undo: an object is missing from its list");
      const known=liveTables.get(r.ref),tables=G.AtriumTableData;
      if(r.cellOffset!==undefined && tables && from===n.vals[i] && known?.value===from && known.state===r.ref.widget.state){
        const edit=r.tableEdit,old=dir>0?edit.before:edit.after,next=dir>0?edit.after:edit.before;
        const state=tables.replayCell(known.state,r.cellOffset,old,next&&JSON.parse(next));
        r.ref.widget={...r.ref.widget,state};liveTables.set(r.ref,{state,value:to});
      } else patch(r.ref,to);
      if (isWire(n, r.ref)) playWire(r.ref, wireEdits.get(r)?.[dir > 0 ? 1 : 0]);
      n.vals[i]=to;leaf(n,i);return;
    }
    if (r.t === "s") {
      const n = r.node, [rem, ins] = dir > 0 ? [r.removed, r.inserted] : [r.inserted, r.removed];
      for (const op of ins) {
        if (n.t === "a" && isObj(op[1]) && (op[2]?.table || (typeof op[2] === "string" ? JSON.stringify(op[1]) !== op[2] : op[2]?.sh && !sameShallow(op[1], op[2])))) patch(op[1], op[2]);
        if (isWire(n, op[1])) playWire(op[1], wireSplices.get(op));
      }
      edit(n.ref, rem, ins, 1); edit(n.refs, rem, ins, 1); edit(n.vals, rem, ins, 2); reshape(n, rem, ins);
      index.delete(n); return;
    }
    if (r.t === "k") {
      const n = r.node, o = n.ref, to = dir > 0 ? r.after : r.before;
      if (to === undefined) { delete o[r.key]; n.kids.delete(r.key); }
      else if (typeof to === "string") { o[r.key] = JSON.parse(to); n.kids.set(r.key, to); }
      else { o[r.key] = to.ref; n.kids.set(r.key, to); }
      orderKeys(n, dir > 0 ? r.ka : r.kb); return;
    }
    root = dir > 0 ? r.after : r.before;
  }
  // A record under a board's doc.stackup: stackup.js caches key on the stack's revision.
  function stackEdit(r) {
    if (r.t === "r" || !r.node.doc) return;
    const n = r.node;
    if (n.path === "stackup" || n.path.startsWith("stackup.") || r.t === "k" && n.path === "" && r.key === "stackup") G.AtriumStackup?.touch?.(n.doc.ref);
  }
  function run(recs, dir) {
    index = new Map();
    if (dir > 0) for (const r of recs) { play(r, 1); stackEdit(r); }
    else for (let i = recs.length - 1; i >= 0; i--) { play(recs[i], -1); stackEdit(recs[i]); }
    index = new Map();
    for(const r of recs)if(r.t==="e"){const {before,after}=valuesOf(r);shadowBytes+=dir*(size(after)-size(before));}
    else if(r.t==="r")shadowBytes=root.bytes;
    authored(recs, dir, true);
  }
  function invert(r) {
    if(r.t==="e"){
      const {before,after}=valuesOf(r),edit=r.tableEdit;
      const reversed=elementEdit(r.node,r.ref,after,before,edit&&{id:edit.id,before:edit.after,after:edit.before},r.cellOffset);
      const stretch = wireEdits.get(r);
      if (stretch) wireEdits.set(reversed, [stretch[1], stretch[0]]);
      if(r.peer)reversed.peer=true;
      return reversed;
    }
    if(r.t==="s")return {...r,removed:r.inserted,inserted:r.removed};
    return {...r,before:r.after,after:r.before,kb:r.ka,ka:r.kb};
  }
  // Cut the log back to an absolute position, reverting what follows; returns the records cut.
  function cutTo(pos) {
    const recs = log.splice(Math.max(0, pos - base));
    // A journal position can be reused after Undo. Move any branch whose shared
    // history was cut onto the remaining prefix, saving its removed ancestry.
    for (const branch of branches) if (branch.anchor > pos) {
      const ancestry = recs.slice(0, branch.anchor - pos);
      branch.ancestry = ancestry.concat(branch.ancestry);
      branch.bytes += recsBytes(ancestry);
      branch.anchor = pos;
      branch.fork.pos = undefined;
    }
    run(recs, -1);
    for (const r of recs) logBytes -= weigh(r);
    return recs;
  }
  // A loop, not log.push(...recs): a long redo can carry more records than a call takes arguments.
  function append(recs) { run(recs, 1); for (const r of recs) { logBytes += weigh(r); log.push(r); } }

  // A disk or hydration update becomes part of the shadow without adding an undo step.
  // Keep the existing owner nodes so journal records for other documents still replay.
  /**
   * @param {Project} project
   * @param {() => void} fn
   * @param {{doc?: AtriumDocument, library?: boolean, structureChanged?: boolean}} [options]
   */
  function reconcile(project, fn, {doc, library = false, structureChanged = false} = {}) {
    const documentsOnly = structureChanged && !doc && !library;
    // Until an edit or history reader needs a baseline, a disk load is already the live state.
    // The first edit or history reader can capture that state after this owner is installed.
    if (!root && !dirty && !scope && !later && !H && !F && (!pending || pending === project)) {
      pending = project;
      duringEdit(fn);
      gap(!documentsOnly);
      diskEpoch++; gen++;
      return;
    }
    sync(project);
    fn();
    if (root?.ref !== project) return;
    const out = [];
    if (library) {
      const list = root.kids.get("library");
      if (list?.t === "a") { list.ref = project.library; visitA(list, out); }
    }
    const documents = root.kids.get("documents");
    if (structureChanged && documents?.t === "l") {
      documents.ref = project.documents;
      structure(documents, out);
    }
    if (doc && documents?.t === "l") {
      const n = documents.vals[documents.refs.indexOf(doc)];
      if (n?.t === "o") visitO(n, out);
    }
    for (const r of out) {
      // Adding another loaded document invalidates hierarchy users. Its library geometry is unchanged.
      if (documentsOnly && r.t === "s" && r.node === documents) gap(false);
      else journal(r, 1);
      stackEdit(r);
    }
    if (out.length) { diskEpoch++; gen++; }
  }

  // ---- states ------------------------------------------------------------------------------------
  // A state before an edit (editor snapshot()). Cheap unless a change is still unrecorded.
  function mark(project, meta = {}) {
    sync(project);
    if (!root) return {project: JSON.stringify(project), ...meta};
    return {id: ++seq, pos: end(), current: meta.current, selected: meta.selected, ids: meta.ids, fileSession: meta.fileSession, imports: meta.imports, act: liveAct, time: now(), diskEpoch, libraryEpoch:libraryVersion, hash: warm ? nodeHash(root) : null};
  }
  const recsBytes = recs => recs.reduce((a, r) => a + weigh(r), 0);
  function bytes() {
    let b = shadowBytes + logBytes;
    if (F) for (const f of F) if (f.recs) b += f.bytes ??= recsBytes(f.recs);
    for (const br of branches) b += br.bytes;
    return b;
  }
  function trim(history) {
    while (history.length > MAX_STEPS) history.shift();
    const max = budget();
    while (bytes() > max && branches.length) branches.shift();
    while (bytes() > max && history.length > 1) { history.shift(); dropBefore(history[0].pos); }
    dropBefore(history.length ? history[0].pos : end());
  }
  function dropBefore(pos) {
    if (!(pos > base)) return;
    const k = Math.min(log.length, pos - base);
    for (let i = 0; i < k; i++) logBytes -= weigh(log[i]);
    log.splice(0, k); base += k;
    for (let i = branches.length - 1; i >= 0; i--) if (branches[i].anchor < base) branches.splice(i, 1);
  }
  // Redo states an edit is about to discard become an alternate branch (oldest first, tip last).
  function fork(future, keep) {
    if (!future.length) return;
    const trees = future.slice().reverse();
    future.length = 0;
    if (!keep || liveFrom < base || trees.some(t => !t.recs)) return;
    retainBranch({pos: liveFrom, time: now(), act: null}, trees);
  }
  function retainBranch(fork, trees) {
    branches.push({
      id: "b" + ++seq, time: now(), fork: {...fork, id: ++seq, fork: true},
      anchor: fork.pos, ancestry: [], trees,
      bytes: trees.reduce((sum, t) => sum + (t.bytes ??= recsBytes(t.recs)), 0)
    });
    while (branches.length > MAX_BRANCHES) branches.shift();
  }
  // An edit: `state` is the mark taken before it; label names it (else the action that ran).
  function checkpoint(history, future, state, label) {
    H = history; F = future;
    history.push(state);
    lift(history, future);
    fork(future, true);
    liveAct = {label: label || "", action: action && now() - action.at < 120000 ? action.id : "", time: now(), id: ++seq};
    liveFrom = -1;
    trim(history); emit();
  }
  // n < 0 undoes, n > 0 redoes |n| steps from the live state `here` (a mark); the live project is
  // patched at once; returns the state restored (its current, selected and ids).
  function jump(history, future, here, n) {
    H = history; F = future;
    lift(history, future); sync();
    motionSince = jend();
    if (n < 0) {
      const k = Math.min(-n || 1, history.length);
      if (!k) return null;
      const target = history[history.length - k];
      let top = end();
      here.pos = undefined;
      const moved = [here, ...history.splice(history.length - k + 1).reverse()];
      history.pop();
      // Each state above the target gets the records that lead to it from the state below it.
      const recs = cutTo(target.pos);
      motionEnd = jend();
      for (const s of moved) {
        const from = s === here ? (moved[1]?.pos ?? target.pos) : nextBelow(moved, s, target);
        s.recs = recs.slice(from - target.pos, top - target.pos); s.bytes = undefined;
        top = from; future.push(s); s.pos = undefined;
      }
      liveFrom = end(); liveAct = target.act; target.pos = undefined;
      done(history); checkHash(target); return target;
    }
    const k = Math.min(n, future.length);
    if (!k) return null;
    if (liveFrom >= base && liveFrom < end()) cutTo(liveFrom);   // changes made since the undo (derived) go
    here.pos = end(); history.push(here);
    // All k steps are replayed as one run (one object index per list, not one per step: a jump of
    // 500 steps on a 25k-object board took 700 ms that way); each state's position is where its
    // records end.
    let t = null, at = end();
    const all = [];
    for (let i = 0; i < k; i++) {
      t = future.pop();
      for (const r of t.recs) all.push(r);
      at += t.recs.length;
      if (i < k - 1) { t.pos = at; history.push(t); }
      t.recs = undefined; t.bytes = undefined;
    }
    append(all);
    motionEnd = jend();
    liveFrom = end(); liveAct = t.act;
    done(history); checkHash(t); return t;
  }
  function nextBelow(moved, s, target) { const i = moved.indexOf(s); return moved[i + 1]?.pos ?? target.pos; }
  function done(history) { trim(history); settled = true; emit(); }
  // Switch to an alternate branch's state as a new step (the current redo states become a branch).
  function adopt(history, future, here, tip, label) {
    H = history; F = future;
    if (!branches.some(branch => branch.trees.includes(tip))) return null;
    sync();
    const path = pathTo(tip);
    if (!path) return null;
    checkpoint(history, future, here, label || "Switch to branch");
    liveAct.branch = true;
    motionSince = jend();
    append(path.back.map(invert).concat(path.forward));
    motionEnd = jend();
    done(history);
    return {current: tip.current, selected: tip.selected, ids: tip.ids, act: liveAct};
  }
  // Back to a mark, discarding everything since (a failed edit, a cancelled drag, a read-only revert).
  // The live project is compared with the shadow whether or not touch() ran: what is rolled back
  // was changed in place with no change() yet (a failed edit's half, a drag, a mirror while dragging).
  // hint: what changed since the mark, when known (a cancelled drag's objects); else a full sync.
  function rollback(state, hint) {
    if (root) hinted(hint);
    sync();
    motionSince = null;
    if (state.project != null) {
      if (!root) return JSON.parse(state.project);
      append([{t: "r", before: root, after: build(JSON.parse(state.project), "o", 0, "", null, root)}]);
      return root.ref;
    }
    if (state.pos >= base && state.pos <= end()) cutTo(state.pos);
    return root.ref;
  }
  // A refused local transaction was never authored. Roll it back without
  // marking folder members dirty or forwarding a transient edit to observers.
  function reject(state) {
    rejecting++;
    try {return rollback(state);} finally {rejecting--;}
  }
  // Redo is dropped (a repour amends the current step).
  function discard(future) { future.length = 0; }

  // ---- entries made before this module loaded -----------------------------------------------------
  // [{project: JSON, current, selected, ids}]: the older states become whole-project records.
  function lift(history, future) {
    const old = history.filter(s => s.project != null);
    if (!old.length && !future.some(s => s.project != null)) return;
    sync();
    if (!root) return;
    let first = root;
    for (const r of log) if (r.t === "r") { first = r.before; break; }
    const nodes = old.map(s => build(JSON.parse(s.project), "o", 0, "", null, first));
    const recs = nodes.map((nd, i) => ({t: "r", before: nd, after: nodes[i + 1] || first}));
    base -= recs.length; log.unshift(...recs); for (const r of recs) logBytes += weigh(r);
    let k = 0;
    for (let i = 0; i < history.length; i++) if (history[i].project != null) {
      const s = history[i];
      history[i] = {id: ++seq, pos: base + k++, current: s.current, selected: s.selected, ids: s.ids, fileSession: s.fileSession, imports: s.imports, act: null, time: now()};
    }
    // Redo states (nearest last): each one replaces the whole project.
    const fut = future.filter(s => s.project != null);
    if (fut.length) {
      let below = root;
      liveFrom = end();
      for (let i = future.length - 1; i >= 0; i--) {
        const s = future[i];
        if (s.project == null) continue;
        const nd = build(JSON.parse(s.project), "o", 0, "", null, below);
        future[i] = {id: ++seq, recs: [{t: "r", before: below, after: nd}], current: s.current, selected: s.selected, ids: s.ids, fileSession: s.fileSession, imports: s.imports, act: null, time: now()};
        below = nd;
      }
    }
  }

  // ---- reading states (history panel) ---------------------------------------------------------------
  // The live state as a state object (a new one after each change, so cached labels refresh).
  function live(rev) {
    if (!liveState || liveState.rev !== rev || rev === undefined) liveState = {id: ++seq, live: true, rev, time: liveAct?.time || now(), act: liveAct};
    return liveState;
  }
  function timeline(host) {
    const {history, future} = host.undoSteps();
    const current = live(host.revision?.());
    const list = [...history, current, ...future.slice().reverse()];
    const alternate = branches.slice();
    return {history, future, current, list, at:history.length, branches:alternate,
      has: mark => list.includes(mark) || alternate.some(branch => branch.fork === mark || branch.trees.includes(mark))};
  }
  // The records that produce state b from the state a just before it.
  function recordsOf(a, b) {
    if (!b) return [];
    if (b.recs) return b.recs;
    sync();
    const from = a?.pos ?? (a?.recs ? end() : base), to = b.live ? end() : b.pos;
    if (from == null || to == null || from < base) return [];
    return log.slice(from - base, to - base);
  }
  const docInfo = d => d ? {id: d.ref.id, name: d.ref.name || "", kind: d.ref.kind || ""} : null;
  const parse = v => typeof v==="string"?JSON.parse(v):v?.table?tableObject(v):v?.sh?fromShallow(v):v&&typeof v==="object"?v.ref:v;
  // Every change from a to b: [{doc, path, added, removed, modified, keys, docAdded, docRemoved}].
  const changes=(a,b)=>describe(recordsOf(a,b));
  function changeSummary(a,b) {
    const records=recordsOf(a,b);
    return {rows:describe(records,true),details:()=>describe(records)};
  }
  function describe(recs,summary=false) {
    const arrays = new Map(), out = [], keyed = new Map();
    const at = (n, ref) => {
      let m = arrays.get(n); if (!m) arrays.set(n, m = new Map());
      let e = m.get(ref); if (!e) m.set(ref, e = {});
      return e;
    };
    for (const r of recs) {
      if (r.t === "r") { out.push({doc: null, path: "", keys: ["documents"], replaced: true}); continue; }
      if (r.t === "k") {
        const id = r.node;
        let c = keyed.get(id);
        if (!c) { c = {doc: docInfo(r.node.doc), path: r.node.path, keys: []}; keyed.set(id, c); out.push(c); }
        if (!c.keys.includes(r.key)) c.keys.push(r.key);
        continue;
      }
      if(r.t==="e"){
        const e=at(r.node,r.ref),{before,after}=valuesOf(r);
        if(!("before" in e))e.before=before;
        e.after=after;e.onlyCells=e.onlyCells!==false && r.cellOffset!==undefined;
        e.cellSteps=(e.cellSteps||0)+1;continue;
      }
      for(const op of r.removed){const e=at(r.node,op[1]);if(!("before" in e))e.before=op[2];e.after=undefined;e.onlyCells=false;}
      for(const op of r.inserted){const e=at(r.node,op[1]);if(!("before" in e))e.before=undefined;e.after=op[2];e.onlyCells=false;}
    }
    for (const [n, m] of arrays) {
      if (n.t === "l") {
        for (const e of m.values()) {
          if (e.before === undefined && e.after !== undefined && typeof e.after === "object") out.push({doc: docInfo(e.after), path: "", docAdded: true});
          else if (e.after === undefined && e.before !== undefined && typeof e.before === "object") out.push({doc: docInfo(e.before), path: "", docRemoved: true});
        }
        continue;
      }
      const added = [], removed = [], modified = [];
      for (const e of m.values()) {
        if(e.before===e.after || e.onlyCells && e.cellSteps>1 && e.before.hash===e.after.hash &&
          cellArrayJSON(e.before)===cellArrayJSON(e.after))continue;
        if (e.before === undefined) added.push(parse(e.after));
        else if (e.after === undefined) removed.push(parse(e.before));
        else if(summary && e.onlyCells){
          const before=JSON.parse(e.before.frame),after=JSON.parse(e.after.frame);
          before.widget.state={tableVersion:1};after.widget.state={tableVersion:1,cellsChanged:true};
          modified.push([before,after]);
        }else modified.push([parse(e.before),parse(e.after)]);
      }
      if (added.length || removed.length || modified.length) out.push({doc: docInfo(n.doc), path: n.path, added, removed, modified});
    }
    return out;
  }
  // The path to a state is immutable for the duration of a read. A preview never replays
  // records on live objects or calls folder dirty, journal, collaboration or renderer listeners.
  function pathTo(s) {
    if (!s || s.live) return {back: [], forward: []};
    let pos = s.pos, forward = [];
    if (s.recs || s.fork) {
      const fi = F?.indexOf(s) ?? -1;
      if (fi >= 0) {
        pos = liveFrom >= base ? liveFrom : end();
        for (let i = F.length - 1; i >= fi; i--) forward = forward.concat(F[i].recs);
      } else {
        const branch = branches.find(b => b.fork === s || b.trees.includes(s));
        if (!branch) return null;
        pos = branch.anchor;
        forward = branch.ancestry;
        if (s !== branch.fork) {
          for (const t of branch.trees) { forward = forward.concat(t.recs); if (t === s) break; }
        }
      }
    }
    if (!Number.isInteger(pos) || pos < base || pos > end()) return null;
    return {back: log.slice(pos - base).reverse(), forward};
  }
  function reviewMark(project) {
    return {...mark(project),lastRecord:log.at(-1)};
  }
  function sinceReview(s) {
    sync();
    if(s.pos<base || s.pos>end() || (s.pos>base && s.lastRecord!==log[s.pos-base-1])) return null;
    return log.slice(s.pos-base);
  }
  function readState(s, libraryOnly) {
    sync();
    const path = pathTo(s);
    if (!root || !path) return null;
    let head = root;
    const overrides = new Map(), peers = [];
    function replay(r, dir) {
      if(libraryOnly && r.t!=="r" && (r.node.doc || !(r.node.path==="library" || r.node.path==="" && r.key==="library")))return;
      if (r.peer) peers.push(r);
      const values=valuesOf(r),to=dir<0?values.before:values.after;
      if (r.t === "r") { head = to; return; }
      const n = r.node;
      let view = overrides.get(n);
      if (!view) {
        view = n.t === "o" ? {kids: new Map(n.kids)} : {refs: n.refs.slice(), vals: n.vals.slice(), index: null};
        overrides.set(n, view);
      }
      if (r.t === "k") {
        if (to === undefined) view.kids.delete(r.key); else view.kids.set(r.key, to);
        const keys = dir < 0 ? r.kb : r.ka;
        if (keys) view.kids = new Map(keys.filter(k => view.kids.has(k)).map(k => [k, view.kids.get(k)]));
      } else if (r.t === "s") {
        const rem = dir < 0 ? r.inserted : r.removed, ins = dir < 0 ? r.removed : r.inserted;
        edit(view.refs, rem, ins, 1); edit(view.vals, rem, ins, 2); view.index = null;
      } else {
        view.index ||= new Map(view.refs.map((r, i) => [r, i]));
        const i = view.index.get(r.ref);
        if (i !== undefined) view.vals[i] = to;
      }
    }
    for (const r of path.back) replay(r, -1);
    for (const r of path.forward) replay(r, 1);
    // Unchanged arrays, items and documents keep their identities. A slider gesture reads
    // only one document. A restore can compare the shared tree without walking untouched items.
    const memo = new Map();
    function value(n) {
      if (typeof n === "string") return JSON.parse(n);
      if(n?.table)return tableObject(n);
      if (!n?.t) return n?.sh ? fromShallow(n) : n;
      if (memo.has(n)) return memo.get(n);
      const v = overrides.get(n) || n;
      let out;
      if (n.t === "a") {
        if (v === n) return n.ref;
        const liveIndex = new Map(n.refs.map((r,i) => [r,i]));
        out = v.vals.map((entry,i) => entry === n.vals[liveIndex.get(v.refs[i])] ? v.refs[i] : value(entry));
      } else if (n.t === "l") {
        const docs = v.vals.map(value);
        out = v === n && docs.every((d,i) => d === n.refs[i]) ? n.ref : docs;
      } else {
        out = v === n ? n.ref : {};
        for (const [key,kid] of v.kids) {
          const child = typeof kid === "string" && n.kids.get(key) === kid ? n.ref[key] : value(kid);
          if (out === n.ref && child !== n.ref[key]) out = {...n.ref};
          if (out !== n.ref) Object.defineProperty(out,key,{value:child,writable:true,enumerable:true,configurable:true});
        }
      }
      memo.set(n,out);
      return out;
    }
    const top=overrides.get(head)?.kids||head.kids, documents=top.get("documents");
    return {project: () => value(head),library:()=>value(top.get("library")), doc(id) {
      const node = (overrides.get(documents) || documents)?.vals.find(n => (overrides.get(n)?.kids || n.kids)?.get("id") === JSON.stringify(id));
      return node ? value(node) : null;
    }, peers};
  }
  const viewState=s=>readState(s,false);
  function libraryAt(s) {
    sync();
    if(s?.live || s?.libraryEpoch===libraryVersion)return root?.ref.library;
    return readState(s,true)?.library();
  }
  function project(s) {
    const view = viewState(s);
    return view ? JSON.parse(JSON.stringify(view.project())) : null;
  }
  // A user forks the session at an earlier undo mark while the active line is still intact.
  function preserveLine(s, history, here) {
    sync();
    // A redo becomes a branch in checkpoint(). A previously retained branch shares a mark
    // with the active line, which can itself be preserved when forking from that other tip.
    const alternate=branches.find(branch=>branch.trees.includes(s));
    const anchor=history.includes(s)?s:alternate && history.findLast(mark=>mark.pos===alternate.anchor);
    const i=history.indexOf(anchor);
    if (!Number.isInteger(anchor?.pos) || i<0 || anchor.pos<base || anchor.pos>=here.pos) return false;
    const trees = [];
    let pos = anchor.pos;
    for (const next of [...history.slice(i + 1), here]) {
      const stop = next.pos ?? end(), recs = log.slice(pos - base, stop - base);
      trees.push({...next, id: ++seq, pos: undefined, recs, bytes: recsBytes(recs)}); pos = stop;
    }
    retainBranch(anchor, trees);
    trim(H || history); emit(); return true;
  }
  // The optional Undo highlight reads only the applied journal entries and their live references.
  // A journal gap or large replay can simply skip the effect.
  function motion(doc, limit) {
    const since = motionSince;
    motionSince = null;
    if (!doc || since == null || since < floor || motionEnd - since > limit) return null;
    const touched = new Map();
    for (let at = since - jbase; at < motionEnd - jbase; at++) {
      const [owner, item, before, present] = jlog[at];
      if (owner !== doc) continue;
      const existed = before !== undefined, edited = existed && present;
      const state = touched.get(item);
      if (state) {state.present = present; state.edited ||= edited;}
      else touched.set(item, {existed,present,edited});
    }
    const changed = [], removed = [];
    for (const [item, state] of touched) {
      if (state.present && (!state.existed || state.edited)) changed.push(item);
      else if (!state.present && state.existed) removed.push(item);
    }
    return changed.length || removed.length ? {changed,removed} : null;
  }
  function find(id) {
    for (const d of root?.ref?.documents || []) for (const i of d.items || []) if (i && i.id === id) return i;
    return null;
  }

  // The earlier tree API, for callers not yet moved over (an editor.js from before, extensions):
  // encode() is a mark (or the live state), decode(state, here) the project after jump()/adopt(),
  // decode(state) a rollback to that mark.
  // True when the live project equals the state at mark m (a drag dropped where it started). Without a
  // hint it forces one full sync, so in-place changes no one reported are seen; with one (what the drag
  // moved) only those are compared. A round trip records nothing net.
  function unchanged(m, project, hint) {
    if (!m || m.pos == null) return false;
    if (project) pending = project;
    hinted(hint); sync();
    const same = ([a, b]) => JSON.stringify(a) === JSON.stringify(b);
    return changes(m, {live: true}).every(c => !c.replaced && !c.docAdded && !c.docRemoved && !c.keys?.length
      && !c.added?.length && !c.removed?.length && (c.modified || []).every(same));
  }
  const encode = (p, meta = {}) => meta.live ? live() : mark(p, meta);
  const decode = (s, here) => here ? root?.ref ?? pending : rollback(s);
  return Object.freeze({mark, checkpoint, jump, adopt, rollback, reject, touch, record, sync: p => sync(p), discard, encode, decode, tableCellEdit,tableItemSnapshot,
    root: () => root?.ref ?? pending, changes,changeSummary, changed, recordedChanges, itemEdits, onlyRecordedItemUpdates, orderedItemChanges, documentItems, trackOverview, documentVersions, verifiedDocumentVersion, sheetEntry, duringEdit, hierarchyVersion, definitionVersion, familyVersion: () => familyVersion, unchanged, live, timeline, project, viewState, libraryAt, reviewMark, sinceReview, peerPatch, preserveLine, motion, find, fork: f => discard(f),
    action(id) { action = id ? {id: String(id), at: now()} : null; },
    current: () => liveAct, branches: () => branches.slice(),
    stats: () => ({bytes: bytes(), budget: budget(), records: log.length, branches: branches.length, shadow: shadowBytes, ...vs, warm}),
    hash: () => { sync(); return root ? nodeHash(root) : null; }, prime: () => prime(null),
    unrecorded: () => dirty || !!scope, outer: () => outer, libraryVersion: () => libraryVersion, reconcile,
    onAuthored(fn) { authoredListeners.add(fn); return () => authoredListeners.delete(fn); },
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    onLibraryChange(f) { libraryListeners.add(f); return () => libraryListeners.delete(f); },
    reset(verifiedProject = null) { root = null; log = []; base = 0; logBytes = shadowBytes = 0; dirty = settled = later = false; scope = only = null; warm = false; for (const k in vs) vs[k] = 0; pending = null; G.clearTimeout?.(timer); timer = 0; branches.length = 0; liveAct = null; liveFrom = -1; H = F = null; motionSince = null; liveState = null; cleanFolder = verifiedProject; gap(); emit(); },
    limits: Object.freeze({MAX_STEPS, MAX_BRANCHES})});
})();
