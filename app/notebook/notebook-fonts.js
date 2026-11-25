"use strict";
globalThis.AtriumNotebookFonts = (() => {
  const data=globalThis.AtriumNotebookFontData;
  const names={sans:"Waffle Note Sans",serif:"Waffle Note Serif",mono:"Waffle Note Mono",hand:"Waffle Note Hand"};
  const bytesCache=new Map(),metrics=new Map(),installed=new Map();
  const ids=Object.keys(data);
  function bytes(key) {
    if (bytesCache.has(key)) return bytesCache.get(key);
    const s=data[key].bytes, decode=globalThis.AtriumPDFFonts?.decode;
    let result;
    if (typeof atob==="function") result=Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    else if (decode) result=decode(s);
    else {
      const abc="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",out=[];
      let bits=0,n=0;
      for(const ch of s) {if(ch==="=") break;n=(n<<6)|abc.indexOf(ch);bits+=6;if(bits>=8) {bits-=8;out.push(n>>bits&255);}}
      result=Uint8Array.from(out);
    }
    bytesCache.set(key,result);return result;
  }
  const assetFamilies=new Map(),permissions=new WeakMap(),readers=new WeakMap(),requests=new WeakMap();let measureCanvas=null;
  function familyName(font) {
    if(font?.source==="system") return font.family;
    if(font?.source==="asset") return assetFamilies.get(font.assetRef?.sha256)?.family || names.sans;
    return names[font] || names.sans;
  }
  function face(family,run={}) {
    if(!run.code && family?.source==="system") return {key:"sans",family:family.family,system:true,bold:!!run.bold,italic:!!run.italic};
    if(!run.code && family?.source==="asset" && assetFamilies.has(family.assetRef?.sha256)) return {...assetFamilies.get(family.assetRef.sha256),bold:!!run.bold,italic:!!run.italic};
    const key=run.code ? "mono" : Object.hasOwn(names,family) ? family : "sans";
    const bits=(run.bold?"bold":"")+(run.italic?"italic":""), requested=bits?key+"-"+bits:key;
    const chosen=data[requested]?requested:run.bold&&data[key+"-bold"]?key+"-bold":run.italic&&data[key+"-italic"]?key+"-italic":key;
    return {key:chosen,family:names[key],bold:!!run.bold,italic:!!run.italic};
  }
  function measure(f,text) {
    if(f.parsed) {let w=0;for(const ch of text)w+=f.parsed.advance(f.parsed.gid(ch.codePointAt(0)));return w/f.parsed.unitsPerEm;}
    if(f.system && globalThis.document?.createElement) {
      measureCanvas ||= document.createElement("canvas").getContext("2d");measureCanvas.font=css(f,100);measureCanvas.fontKerning="none";return measureCanvas.measureText(text).width/100;
    }
    let m=metrics.get(f.key);
    if (!m) {m=new Map(data[f.key].widths);metrics.set(f.key,m);}
    const units=data[f.key].units;
    let width=0;
    for(const ch of text) width+=m.get(ch.codePointAt(0)) ?? m.get(0xfffd) ?? m.get(63) ?? units*.6;
    return width/units;
  }
  function css(f,size) {return (f.italic?"italic ":"")+(f.bold?"700 ":"400 ")+size+'px "'+f.family+'"';}
  function ready() {
    if (!globalThis.document?.fonts || typeof FontFace!=="function") return Promise.resolve();
    for(const k of ids) if(!installed.has(k)) {
      const [family,style=""]=k.split("-"), f=new FontFace(names[family],bytes(k),{weight:style.includes("bold")?"700":"400",style:style.includes("italic")?"italic":"normal"});
      document.fonts.add(f);installed.set(k,f.load());
    }
    return Promise.all(installed.values());
  }
  function registerPDF(pdf) {
    if (!pdf?.registerTypeface) return;
    for(const f of assetFamilies.values()) pdf.registerTypeface(f.family,()=>f.bytes);
    for(const k of ids) {
      const [family,style=""]=k.split("-");
      pdf.registerTypeface(names[family],()=>bytes(k),{weight:style.includes("bold")?700:400,style:style.includes("italic")?"italic":"normal"});
    }
  }
  async function loadAsset(ownerId,font,readAsset) {
    if(font?.source!=="asset" || font.license!=="OFL-1.1" || !ownerId || typeof readAsset!=="function") return false;
    const ref=font.assetRef;
    if(!ref || ref.mediaType!=="font/ttf" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength<=0 || ref.byteLength>8e6) return false;
    let owners=permissions.get(readAsset);if(!owners){owners=new Map();permissions.set(readAsset,owners);}
    const token=ref.sha256+":"+ref.byteLength;
    if(owners.get(ownerId)?.has(token))return true;
    const response=await readAsset({ownerId,assetRef:ref,purpose:"font"});
    if(response?.assetRef && ["sha256","byteLength","mediaType"].some(key=>response.assetRef[key]!==ref[key]))return false;
    const raw=response?.bytes ?? response;
    if(!(raw instanceof ArrayBuffer) && !(raw instanceof Uint8Array))return false;
    const bytes=new Uint8Array(raw);
    if(bytes.byteLength!==ref.byteLength || !globalThis.crypto?.subtle)return false;
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
    if(digest!==ref.sha256)return false;
    function remember() {if(!owners.has(ownerId))owners.set(ownerId,new Set());owners.get(ownerId).add(token);return true;}
    if(assetFamilies.has(ref.sha256))return remember();
    const parser=globalThis.AtriumPDFFonts || await globalThis.AtriumLazy?.need("AtriumPDFFonts");if(!parser)return false;
    const parsed=parser.parse(bytes),family="Waffle asset "+digest;
    if(globalThis.document?.fonts && typeof FontFace==="function"){const face=new FontFace(family,bytes);await face.load();document.fonts.add(face);}
    assetFamilies.set(digest,{family,parsed,key:"sans",bytes});
    globalThis.AtriumPDF?.registerTypeface?.(family,()=>bytes);return remember();
  }
  function reader(explicit) {
    if(explicit)return explicit;
    const session=globalThis.AtriumNavHost?.folderProject?.();
    if(!session?.readAsset)return null;
    if(!readers.has(session))readers.set(session,args=>session.readAsset(args));
    return readers.get(session);
  }
  function prepareItem(item,resolveAsset,repaint=true) {
    const font=item.richText?.font;if(font?.source!=="asset")return null;
    const read=reader(resolveAsset);if(!read)return null;
    const id=font.assetRef?.sha256,former=requests.get(item);
    if(former && former.read===read && former.font===font && former.id===id)return former.promise;
    const entry={read,font,id,ready:false,promise:null};
    entry.promise=loadAsset(item.id,font,read).then(ok=>{
      entry.ready=ok;
      if(ok && repaint && requests.get(item)===entry)globalThis.AtriumNavHost?.redraw?.();
      return ok;
    },()=>false);
    requests.set(item,entry);return entry.promise;
  }
  function fontFor(item) {
    const font=item.richText?.font,entry=requests.get(item);
    return font?.source!=="asset" || entry?.ready && entry.font===font?font:"sans";
  }
  function prepareAssets(project,documentIds,resolveAsset) {
    const selected=documentIds?new Set(documentIds):null,pending=[];
    for(const doc of project.documents || []) if(!selected || selected.has(doc.id)) for(const item of doc.items || []) {
      if(item.richText?.font?.source==="asset"){const task=prepareItem(item,resolveAsset,false);if(task)pending.push(task);}
    }
    return pending.length?Promise.all(pending):null;
  }
  const api=Object.freeze({names,face,measure,css,ready,registerPDF,familyName,loadAsset,prepareItem,prepareAssets,fontFor});
  registerPDF(globalThis.AtriumPDF);return api;
})();
