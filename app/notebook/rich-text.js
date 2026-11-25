"use strict";
// Editing and canvas input are optional. Saved and printed notes use the same
// world-coordinate layout without installing this controller.
globalThis.AtriumRichText = (() => {
  const N=globalThis.AtriumNotebook, Fields=globalThis.AtriumNoteFields, view=globalThis.AtriumRichTextView;
  const hit=view.hit;
  async function insert(request,style="paragraph") {
    const ctx=request.context || request,host=ctx.host || globalThis.AtriumNavHost,doc=host?.doc?.(),pt=ctx.point || [0,0];
    if(!doc || doc.kind!=="schematic" || doc.id!==ctx.docId) return false;
    const body=N.textBody(request.argument || "",style);
    if(request.argument) for(const block of body.blocks) block.runs=N.parseInline(block.runs[0]?.text || "",host.project(),doc);
    const item={id:globalThis.Atrium.id(),kind:"textframe",x:pt[0],y:pt[1],w:58,h:22,size:2.7,border:false,text:N.bodyText(body,null,null,{},true).text,richText:body};
    host.edit(()=>doc.items.push(item),"Insert "+(style==="check"?"checklist":"note"),[item]);host.select([item.id]);
    if(!request.argument) await edit(item,host);
    return item;
  }
  async function edit(item,host=globalThis.AtriumNavHost) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false)return false;
    const editor=globalThis.AtriumRichTextEditor || await globalThis.AtriumLazy?.need("AtriumRichTextEditor");
    if(host?.doc?.()?.items.includes(item)) return editor?.open(host,item);
    return false;
  }
  function toggle(host,item,index) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false)return false;
    const block=item.richText.blocks[index];if(block?.style!=="check") return false;
    host.edit(()=>{block.checked=!block.checked;item.text=N.bodyText(item.richText,null,null,{},true).text;},"Toggle checklist item",[item]);
    return true;
  }
  function followLink(target) {
    const url=N.safeURL(target?.r?.href);if(!url) return false;
    if (url.startsWith("waffle://")) {
      if (globalThis.AtriumPrefs?.get("butter.links") !== true) return false;
      globalThis.AtriumLazy?.need("AtriumLinksDesktop").then(links => links.receive(url));
    } else if(globalThis.AtriumHost?.openURL) globalThis.AtriumHost.openURL(url);
    else globalThis.open?.(url,"_blank","noopener");
    return true;
  }
  function input(e) {
    const host=globalThis.AtriumNavHost;
    if(e.target!==host?.canvas?.() || e.button!==0 && e.type!=="contextmenu" || host.tool?.() && host.tool()!=="select")return;
    const r=e.target.getBoundingClientRect(),pt=host.view().screenToWorld([e.clientX-r.left,e.clientY-r.top]),item=host.hitAt(pt);
    if(!item?.richText || globalThis.AtriumLabs?.notebookEnabled()===false)return;
    const target=hit(host.project(),host.doc(),item,pt);
    if(target?.check!=null && e.type==="click") toggle(host,item,target.check);
    else if((e.ctrlKey || e.metaKey) && target?.field) Fields.follow(host,target.field);
    else if(!(e.ctrlKey || e.metaKey) || !followLink(target)) return;
    e.preventDefault();e.stopImmediatePropagation();
  }
  function tap(detail) {
    const h=globalThis.AtriumNavHost,i=detail?.item;
    if(globalThis.AtriumLabs?.notebookEnabled()===false || !i?.richText || detail.canvas!==h?.canvas?.() || detail.docId!==h.currentId() || detail.tool!=="select") return false;
    const t=hit(h.project(),h.doc(),i,detail.world || detail.point);
    if(t?.check!=null)return toggle(h,i,t.check);
    if(t?.field) return Fields.follow(h,t.field);
    return followLink(t);
  }
  globalThis.document?.addEventListener?.("waffle-canvas-tap",e=>{if(tap(e.detail))e.preventDefault();});
  globalThis.document?.addEventListener?.("click",input,true);
  globalThis.document?.addEventListener?.("contextmenu",e=>{if(e.ctrlKey || e.metaKey) input(e);},true);
  return Object.freeze({...view,insert,edit,toggle,describe:N.describe});
})();
