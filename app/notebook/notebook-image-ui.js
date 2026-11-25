"use strict";
// All edits use the active schematic's ordinary undo and folder transaction. Files,
// decoded previews and cancelled clip selections never become project properties.
globalThis.AtriumNotebookImageUI = (() => {
  const G=globalThis, Images=G.AtriumNotebookImages, Media=G.AtriumNotebookMedia;
  const types=["image/heic","image/jpeg","image/png","image/webp","image/svg+xml","application/pdf"];
  const fromName=name=>({heic:"image/heic",heif:"image/heic",jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",svg:"image/svg+xml",pdf:"application/pdf"})[name?.split(".").pop().toLowerCase()];
  const element=(tag,text,cls)=>AtriumNavCommon.el(tag, text, cls);
  const button=(name,fn)=>{const b=element("button",name,"ui-button");b.type="button";b.onclick=fn;return b;};
  const nameOf=s=>String(s||"Image").split(/[\\/]/).pop().replace(/[\x00-\x1f]/g,"").slice(0,255)||"Image";
  function current(host,doc,session) {
    if(G.AtriumLabs?.notebookEnabled()===false)throw Error("Enable notebook features in Preferences › Experimental features to edit attachments.");
    if(!session || session.readOnly || session.canEdit?.(doc.id)===false || host.folderProject()!==session || host.doc()!==doc || doc.kind!=="schematic")
      throw Error("Choose an editable schematic in a folder project.");
  }
  function field(parent,title,typ,value) {
    const l=element("label"), input=element("input",null,"ui-field");
    input.type=typ;input.value=String(value??"");l.append(element("span",title),input);parent.append(l);return input;
  }
  function form(title,accept) {
    const d=element("dialog",null,"notebook-image-dialog"),f=element("form"),head=element("h2",title),
      body=element("div",null,"notebook-image-body"), msg=element("p",null,"notebook-image-status"), actions=element("div",null,"notebook-image-actions");
    const cancel=button("Cancel",()=>d.close()),submit=element("button",accept,"is-primary");
    submit.type="submit";msg.setAttribute("role","status");actions.append(cancel,submit);f.append(head,body,msg,actions);d.append(f);document.body.append(d);
    let resolve;
    const result=new Promise(r=>{resolve=r;});
    globalThis.AtriumShell?.adoptDialog?.(d, {title:head, body:[body,msg], actions});
    d.addEventListener("close",()=>{resolve(null);d.remove();},{once:true});
    f.onsubmit=e=>{e.preventDefault();};
    return {d,body,msg,submit,result,open:()=>d.showModal(),finish:v=>{resolve(v);d.close();},onSubmit(fn){
      f.onsubmit=async e=>{e.preventDefault();if(submit.disabled)return;submit.disabled=true;
        try {await fn();} catch(err){msg.textContent=err.message||String(err);}
        finally {submit.disabled=false;}
      };
    }};
  }
  const bounded=n=>Math.max(0,Math.min(1000000,Math.round(n)));
  function regionBetween(a,b) {return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];}
  // Pointer, tap-tap and numeric inputs all use the displayed oriented page. The
  // full image is shown while editing, independent of the sheet's current crop.
  function regionEditor(parent,initial,marks,tool,text) {
    const view=element("div",null,"notebook-image-preview"),canvas=element("canvas"), overlay=element("canvas"), fields=element("div",null,"notebook-image-grid");
    overlay.className="notebook-image-overlay";overlay.setAttribute("aria-label","Drag a region or tap two corners");
    view.append(canvas,overlay);parent.append(view,fields);
    const inputs=["Left %","Top %","Right %","Bottom %"].map((k,n)=>{
      const v=field(fields,k,"number",initial[n]/10000);v.min="0";v.max="100";v.step=".0001";
      v.oninput=()=>{if(cropping())crop=values();paint();};return v;
    });
    let crop=initial.slice(),start=null,last=null,dragId=null,firstTap=null,context=null;
    const cropping=()=>!tool||tool.value==="crop";
    const values=()=>inputs.map(n=>bounded(Number(n.value)*10000));
    function showValues(r){r.forEach((v,n)=>{inputs[n].value=String(v/10000);});paint();}
    function set(r){crop=r.slice();if(cropping())showValues(crop);else paint();}
    const add=tool&&button("Add mark",()=>{const [x,y,u,v]=values();save([x,y],[u,v]);});
    if(add){add.hidden=true;fields.append(add);}
    function modeChanged(){
      start=last=firstTap=null;dragId=null;
      if(add)add.hidden=cropping();
      showValues(crop);
    }
    const uv=e=>{const b=overlay.getBoundingClientRect();return [bounded((e.clientX-b.left)/b.width*1000000),bounded((e.clientY-b.top)/b.height*1000000)];};
    function paint(){
      const ctx=overlay.getContext("2d");
      if(!ctx)return;
      const w=overlay.width,h=overlay.height, r=values();
      ctx.setTransform(w/1000000,0,0,h/1000000,0,0);ctx.clearRect(0,0,1000000,1000000);
      for(const mark of marks||[])Images.drawMark(ctx,mark);
      const a=start&&last?regionBetween(start,last):r;
      ctx.strokeStyle="#0879d4";ctx.lineWidth=2500;ctx.setLineDash([9500,4500]);ctx.strokeRect(a[0],a[1],a[2]-a[0],a[3]-a[1]);ctx.setLineDash([]);
    }
    function save(a,b){
      const r=regionBetween(a,b);
      if(tool?.value==="arrow"){if(a[0]===b[0] && a[1]===b[1])return;}
      else if(!Images.regionOK(r))return;
      if(!tool || tool.value==="crop"){set(r);return;}
      const richText=text.value.trim();
      if(tool.value==="text"&&!richText)return;
      marks.push({id:Atrium.id(),kind:"imageMarkup",imageId:context,shape:tool.value,at:a,to:b,width:7000,
        colour:tool.value==="highlight"?"#f2c53a":"#b13738",...(tool.value==="text"?{richText}:{})});
      paint();
    }
    overlay.onpointerdown=e=>{
      if(dragId!==null){start=last=firstTap=null;dragId=null;paint();return;}
      dragId=e.pointerId;start=uv(e);last=start;overlay.setPointerCapture(e.pointerId);e.preventDefault();
    };
    overlay.onpointermove=e=>{if(e.pointerId===dragId){last=uv(e);paint();}};
    overlay.onpointerup=e=>{
      if(e.pointerId!==dragId || !start)return;
      const a=start,b=uv(e);start=last=null;dragId=null;
      if(Math.hypot(b[0]-a[0],b[1]-a[1])<6000){if(firstTap){save(firstTap,b);firstTap=null;}else firstTap=a;}
      else {firstTap=null;save(a,b);}paint();
    };
    overlay.onpointercancel=()=>{dragId=null;start=last=firstTap=null;paint();};
    return {canvas,region:()=>crop.slice(),set,paint,modeChanged,setOwner:id=>{context=id;},fit(w,h){
      const k=Math.min(1,850/w,460/h);canvas.width=overlay.width=Math.max(1,Math.round(w*k));
      canvas.height=overlay.height=Math.max(1,Math.round(h*k));view.style.aspectRatio=w+"/"+h;paint();
    }};
  }
  async function renderPNG(canvas,png) {
    const url=URL.createObjectURL(new Blob([png],{type:"image/png"}));
    try {const img=new Image();img.src=url;await img.decode();canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);}
    finally {URL.revokeObjectURL(url);}
  }
  async function pickerPDF(bytes,name,signal,initial,readOnly=false) {
    const pdf=await Media.pdf(bytes,{signal}), f=form(name,readOnly?"Done":"Use region");
    const pages=element("div",null,"notebook-image-pages");f.body.append(pages);
    const page=field(pages,"Page","number",initial?.page||1);page.min="1";page.max=pdf.pages;page.step="1";
    pages.append(element("span","of "+pdf.pages));
    const tool=regionEditor(f.body,initial?.region||Images.FULL);
    let generation=0,ready=0;
    const cancel=()=>{if(f.d.isConnected)f.d.close();};signal?.addEventListener("abort",cancel,{once:true});
    async function show(){
      const stamp=++generation,index=Number(page.value);ready=0;f.submit.disabled=true;
      if(!Number.isInteger(index)||index<1||index>pdf.pages){f.msg.textContent="Choose a page in this datasheet.";return;}
      try {
        const image=await pdf.render(index,Images.FULL,900);
        if(stamp!==generation||!f.d.isConnected)return;
        tool.fit(image.width,image.height);await renderPNG(tool.canvas,image.png);tool.paint();
        if(stamp!==generation||!f.d.isConnected)return;
        ready=index;f.submit.disabled=false;f.msg.textContent=readOnly?"":"Drag a region, tap two corners, or enter percentages.";
      } catch(e){if(stamp===generation)f.msg.textContent=e.message||String(e);}
    }
    page.onchange=show;
    for(const [label,delta] of [["Previous page",-1],["Next page",1]])pages.append(button(label,()=>{page.value=String(Math.max(1,Math.min(pdf.pages,Number(page.value)+delta)));show();}));
    f.onSubmit(()=>{const region=tool.region();if(!ready||!Images.regionOK(region))throw Error("Choose a nonempty region.");f.finish({page:ready,region});});
    try {f.open();show();return await f.result;}finally {++generation;pdf.close();signal?.removeEventListener("abort",cancel);}
  }
  function cameraFile(){
    return new Promise(resolve=>{
      const input=element("input");input.type="file";input.accept="image/*";input.setAttribute("capture","environment");
      input.hidden=true;document.body.append(input);
      const done=v=>{input.remove();resolve(v);};
      input.onchange=()=>done(input.files[0]||null);input.oncancel=()=>done(null);input.click();
    });
  }
  function canCamera(){
    return (navigator.maxTouchPoints||0)>0 && "capture" in HTMLInputElement.prototype;
  }
  async function chooseAsset(doc,session,file,source,dropToken,check,approved) {
    const native=G.AtriumHost, ownerId=doc.id, grant=session.grant;
    let result;
    if(source==="camera"){if(!canCamera())throw Error("A touch camera is unavailable on this device.");file=await cameraFile();if(!file)return null;check();}
    if(dropToken){
      result=await native.notebookDrop({grant,ownerId,dropToken});
    }else if(source==="clipboard"){
      if(!native?.notebookPaste)throw Error("Use the system Paste command to insert an image from the clipboard.");
      result=await native.notebookPaste({grant,ownerId});
      if(!result)return null;
    } else
    if(file) {
      if(file.size>128*1048576)throw Error("The selected attachment exceeds 128 MiB.");
      if(!native?.notebookTransfer)throw Error("This host cannot receive pasted or dropped images.");
      result=await native.notebookTransfer({grant,ownerId,file,mediaType:approved?.mime||file.type||fromName(file.name),approved});
      if(result)result={...result,name:nameOf(file.name)};
    } else {
      if(!native?.folderPickAsset)throw Error("This host cannot choose project attachments.");
      const mediaTypes=source==="pdf"?["application/pdf"]:source==="image"?types.filter(t=>t!=="application/pdf"):types;
      const picked=await native.folderPickAsset({grant,ownerId,mediaTypes});
      if(!picked)return null;
      try {
        check();
        const staged=await native.folderStageAsset({grant,ownerId,sourceToken:picked.sourceToken,mediaType:picked.mediaType||fromName(picked.name)});
        if(staged)result={...staged,name:nameOf(picked.name)};
      } catch(error) {
        try {await native.folderDropAsset?.({grant,ownerId,sourceToken:picked.sourceToken});} catch {}
        throw error;
      }
    }
    if(!result?.assetToken||result.ownerId!==ownerId||!result.assetRef)throw Error("The attachment could not be verified.");
    return result;
  }
  async function pickCellImage(host,signal,place) {
    const doc=host.doc(),session=host.folderProject?.();
    let staged,placed=false;
    const check=()=>{if(signal?.aborted)throw new DOMException("Cancelled","AbortError");current(host,doc,session);};
    try {
      check();staged=await chooseAsset(doc,session,null,"image",null,check);
      if(!staged)return false;
      check();
      const read=await session.readAsset({...staged,ownerId:doc.id,purpose:"preview",signal});
      const meta=await Media.info(read.bytes,staged.assetRef.mediaType,signal);check();
      if(!Images.MEDIA.has(meta.mediaType))throw Error("Choose a supported image.");
      place(staged,session);placed=true;return true;
    } finally {if(staged&&!placed)await session.releaseAsset?.({assetToken:staged.assetToken});}
  }
  async function insertIntoSheet({host=G.AtriumNavHost,point,file,camera=false,source,dropToken,signal,approved,beforeCommit}={}) {
    const doc=host.doc(),session=host.folderProject?.(),temps=[],operation=new AbortController();
    const cancel=()=>operation.abort(),originalSignal=signal,labs=G.AtriumLabs?.notebookSignal();
    const watch=()=>{if(host.doc()!==doc||host.folderProject?.()!==session)cancel();};
    const stopDoc=host.on?.("document",watch),stopProject=host.on?.("replace",cancel);
    originalSignal?.addEventListener("abort",cancel,{once:true});
    labs?.addEventListener("abort",cancel,{once:true});
    if(originalSignal?.aborted||labs?.aborted)cancel();
    signal=operation.signal;
    function check(){if(signal.aborted)throw new DOMException("Cancelled","AbortError");current(host,doc,session);}
    try {
      check();const picked=await chooseAsset(doc,session,file,source||(camera?"camera":"all"),dropToken,check,approved);
      if(!picked)return false;
      temps.push(picked);check();
      const read=approved || await session.readAsset({...picked,ownerId:doc.id,purpose:"preview",signal});
      const meta=await Media.info(read.bytes,picked.assetRef.mediaType,signal);
      let asset=picked,extent=meta.extent,clip;
      if(meta.mediaType==="application/pdf"){
        const region=await pickerPDF(read.bytes,picked.name,signal);
        if(!region)return false;
        check();
        asset=await G.AtriumHost.notebookClip({grant:session.grant,ownerId:doc.id,assetRef:picked.assetRef,assetToken:picked.assetToken,...region,side:1600});
        if(asset?.assetToken)temps.push(asset);
        if(asset?.ownerId!==doc.id||asset?.assetRef?.mediaType!=="image/png")throw Error("The selected datasheet region could not be retained.");
        extent=[asset.width,asset.height];clip={source:{...picked.assetRef},name:picked.name,...region};
      }
      if(!Images.extentOK(extent))throw Error("Image dimensions unavailable.");
      check();
      const at=point||await host.pickPoint("Place image on the schematic.",{signal});
      if(!at)return false;
      check();
      const w=Math.min(60,Math.max(18,extent[0]*25.4/300)),h=w*extent[1]/extent[0];
      const row={id:Atrium.id(),kind:"image",x:at[0],y:at[1],w,h,asset:{...asset.assetRef},name:picked.name,extent,...(clip?{clip}:{})};
      if(!Images.valid(row))throw Error("The image could not be placed.");
      beforeCommit?.();
      host.edit(()=>{
        for(const t of temps)session.stageAttachment(t);
        doc.items.push(row);
      },"Place image",[row]);
      if(!doc.items.includes(row))return false;
      temps.length=0;host.select?.([row.id],row.id);
      if(G.AtriumLabs?.butterEnabled("visualHistory") && (source==="clipboard" || source==="paste")){
        const provided=new Map([[picked.assetRef.sha256,read.bytes]]);
        G.AtriumLazy?.need("AtriumClipHistory").then(history=>history.recordImage(row,doc,provided),()=>{});
      }
      if(meta.omitted)host.info?.("Placed the supported SVG graphics. Unsupported elements were omitted.");
      return row;
    } finally {stopDoc?.();stopProject?.();originalSignal?.removeEventListener("abort",cancel);labs?.removeEventListener("abort",cancel);for(const t of temps)await Promise.resolve(session.releaseAsset?.({assetToken:t.assetToken})).catch(()=>{});}
  }
  async function editOnSheet(row,host=G.AtriumNavHost) {
    const doc=host.doc(),session=host.folderProject?.();current(host,doc,session);
    const original=Images.marksFor(doc,row.id),marks=JSON.parse(JSON.stringify(original));
    const f=form("Edit image","Apply"),fields=element("div",null,"notebook-image-grid");f.body.append(fields);
    const caption=field(fields,"Caption","text",row.caption),alt=field(fields,"Alt text","text",row.alt),angle=field(fields,"Rotation °","number",row.angle||0);
    angle.step="any";caption.maxLength=alt.maxLength=4096;
    const label=element("label"),mode=element("select",null,"ui-field");label.append(element("span","Tool"),mode);fields.append(label);
    for(const [value,title] of [["crop","Crop"],["arrow","Arrow"],["ellipse","Circle / ellipse"],["box","Box"],["highlight","Highlight"],["text","Text"]])mode.add(new Option(title,value));
    const text=field(fields,"Markup text","text","");text.maxLength=4096;text.parentElement.hidden=true;
    const region=regionEditor(f.body,row.crop||Images.FULL,marks,mode,text);region.setOwner(row.id);
    mode.onchange=()=>{text.parentElement.hidden=mode.value!=="text";region.modeChanged();};
    const controls=element("div",null,"notebook-image-actions");f.body.append(controls);
    controls.append(button("Reset crop",()=>region.set(Images.FULL)),button("Remove last mark",()=>{marks.pop();region.paint();}));
    if(row.clip)controls.append(button("Open source page "+row.clip.page,async()=>{
      try {const src=await session.readAsset({ownerId:doc.id,assetRef:row.clip.source,purpose:"source-page"});await pickerPDF(src.bytes,row.clip.name,null,row.clip,true);}
      catch(e){f.msg.textContent="Source datasheet unavailable. "+e.message;}
    }));
    let preview;
    const abort=new AbortController();
    f.onSubmit(()=>{
      current(host,doc,session);
      if(!doc.items.includes(row))throw Error("This image has changed.");
      const crop=region.region(),rotation=Number(angle.value);if(!Images.regionOK(crop)||!Number.isFinite(rotation))throw Error("Enter a rotation and a nonempty crop.");
      host.edit(()=>{
        if(crop.every((v,n)=>v===Images.FULL[n]))delete row.crop;else row.crop=crop;
        row.angle=((rotation%360)+360)%360;row.caption=caption.value;row.alt=alt.value;
        if(!row.angle)delete row.angle;if(!row.caption)delete row.caption;if(!row.alt)delete row.alt;
        const ids=new Set(marks.map(m=>m.id));
        for(let n=doc.items.length-1;n>=0;n--)if(original.some(m=>m.id===doc.items[n].id)&&!ids.has(doc.items[n].id))doc.items.splice(n,1);
        const kept=new Set(original.map(m=>m.id));doc.items.push(...marks.filter(m=>!kept.has(m.id)));
      },"Edit image and markup",()=>[row,...original,...marks]);
      f.finish(true);
    });
    try {
      f.open();if(row.extent)region.fit(...row.extent);
      const task=(async()=>{
        const read=await session.readAsset({ownerId:doc.id,assetRef:row.asset,purpose:"preview",signal:abort.signal});
        preview=await Media.decode(read.bytes,row.asset,{pixels:900,signal:abort.signal});
        if(!f.d.isConnected)return;
        if(!row.extent)region.fit(preview.width,preview.height);
        region.canvas.getContext("2d").drawImage(preview.bitmap,0,0,region.canvas.width,region.canvas.height);region.paint();
      })().catch(e=>{if(!abort.signal.aborted)f.msg.textContent="Image preview unavailable. "+e.message;});
      const result=await f.result;abort.abort();await task;return result;
    } finally {abort.abort();preview?.close();}
  }
  let pending=0;
  async function withImageDraft(run) {
    if(G.AtriumLabs?.notebookEnabled()===false)return false;
    pending++;
    try {return await run();} finally {pending--;}
  }
  const insert=options=>withImageDraft(()=>insertIntoSheet(options));
  const edit=(...args)=>withImageDraft(()=>editOnSheet(...args));
  function dropCaptured(grant,dropToken,x,y,{signal}={}) {
    if(G.AtriumLabs?.notebookEnabled()===false)return false;
    const host=G.AtriumNavHost, canvas=host.canvas();
    const session=host.folderProject?.(), doc=host.doc();
    if(signal?.aborted||!session||session.grant!==grant||session.readOnly||session.canEdit?.(doc.id)===false||doc.kind!=="schematic")return false;
    const box=canvas.getBoundingClientRect();
    const point=x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom?host.view().screenToWorld([x-box.left,y-box.top]):null;
    return insert({host,dropToken,point,signal});
  }
  return {insert,edit,pickCellImage,dropCaptured,pickerPDF,regionBetween,fromName,canCamera,hasPending:()=>pending>0};
})();
