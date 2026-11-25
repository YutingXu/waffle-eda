"use strict";
// Bounded format sniffing before codec allocation. No renderer receives original SVG markup.
globalThis.AtriumNotebookImageFormat = (() => {
  const MAX_PIXELS=120000000, MAX_SIDE=100000, MAX_BYTES=256*1048576, SVG_NS="http://www.w3.org/2000/svg";
  const bytes = raw=>raw instanceof Uint8Array?raw:new Uint8Array(raw);
  const tag=(b,p,n)=>String.fromCharCode(...b.subarray(p,p+n));
  function checkedExtent(w,h) {
    if (![w,h].every(n=>Number.isSafeInteger(n)&&n>0&&n<=MAX_SIDE) || w*h>MAX_PIXELS)throw Error("Image dimensions exceed the supported limit.");
    return [w,h];
  }
  function sniff(raw) {
    const b=bytes(raw);
    if(!b.length||b.length>MAX_BYTES)throw Error("The selected media exceeds the supported size.");
    const head=tag(b,0,Math.min(1024,b.length));
    if(b[0]===137&&tag(b,1,7)==="PNG\r\n\x1a\n")return "image/png";
    if(b[0]===255&&b[1]===216&&b[2]===255)return "image/jpeg";
    if(head.startsWith("RIFF")&&tag(b,8,4)==="WEBP")return "image/webp";
    if(/^GIF8[79]a/.test(head))return "image/gif";
    if(tag(b,4,4)==="ftyp") {
      const brands=[tag(b,8,4)];
      const end=Math.min(b.length,((b[0]*256+b[1])*256+b[2])*256+b[3],256);
      for(let p=16;p+4<=end;p+=4)brands.push(tag(b,p,4));
      if(brands.some(s=>["heic","heix","hevc","hevx","heim","heis","hevm","hevs"].includes(s)))return "image/heic";
      if(brands.some(s=>["mif1","msf1"].includes(s)))return "image/heif";
    }
    if(head.startsWith("%PDF-")||head.startsWith("\xef\xbb\xbf%PDF-"))return "application/pdf";
    const start=head.replace(/^\xef\xbb\xbf/,"").trimStart();
    if(/^<svg(?:\s|>)/.test(start)||/^<\?xml\b/.test(start)||/^<!--/.test(start))return "image/svg+xml";
    throw Error("Unsupported image or datasheet format.");
  }
  function jpeg(b,v) {
    let orientation=1, extent=null;
    for(let p=2;p+4<=b.length;) {
      if(b[p]!==255)break;
      while(b[p]===255)p++;
      const marker=b[p++];
      if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(p+2>b.length)break;
      const length=v.getUint16(p), end=p+length;
      if(length<2||end>b.length)break;
      if(marker===225&&tag(b,p+2,6)==="Exif\0\0"&&p+16<=end) {
        const base=p+8, le=tag(b,base,2)==="II", order=v.getUint16(base+2,le);
        const ifd=base+v.getUint32(base+4,le);
        if(order===42&&ifd>=base&&ifd+2<=end){
          const count=Math.min(v.getUint16(ifd,le),300);
          for(let n=0;n<count;n++){const q=ifd+2+12*n;if(q+12>end)break;
            if(v.getUint16(q,le)===274&&v.getUint16(q+2,le)===3&&v.getUint32(q+4,le)===1)orientation=v.getUint16(q+8,le);}
        }
      } else if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)extent=[v.getUint16(p+5),v.getUint16(p+3)];
      p=end;
    }
    if(!extent)throw Error("Incomplete JPEG dimensions.");
    return orientation>=5&&orientation<=8?extent.reverse():extent;
  }
  function heif(b,v) {
    // Tiles, thumbnails and the primary photograph have independent properties.
    // Resolve the primary ID through the item-property associations before sizing a decode.
    const invalid=()=>{throw Error("Unsupported HEIF item properties.");};
    function boxes(start,end) {
      const out=[];
      for(let p=start;p<end;){
        if(out.length>=32767 || end-p<8)invalid();
        let size=v.getUint32(p),header=8;
        if(size===1){
          if(end-p<16 || v.getUint32(p+8)!==0)invalid();
          size=v.getUint32(p+12);header=16;
        }else if(size===0)size=end-p;
        if(size<header || size>end-p)invalid();
        out.push({type:tag(b,p+4,4),data:p+header,end:p+size});
        p+=size;
      }
      return out;
    }
    const meta=boxes(0,b.length).find(box=>box.type==="meta");
    if(!meta||meta.end-meta.data<4)invalid();
    const children=boxes(meta.data+4,meta.end);
    const primary=children.find(box=>box.type==="pitm"), group=children.find(box=>box.type==="iprp");
    if(!primary || !group || primary.end-primary.data<6 || b[primary.data]>1)invalid();
    const longId=b[primary.data]===1;
    if(longId && primary.end-primary.data<8)invalid();
    const id=longId?v.getUint32(primary.data+4):v.getUint16(primary.data+4);
    const tables=boxes(group.data,group.end),container=tables.find(box=>box.type==="ipco");
    if(!container)invalid();
    const properties=boxes(container.data,container.end),selected=[];
    for(const table of tables.filter(box=>box.type==="ipma")){
      let p=table.data;
      if(table.end-p<8 || b[p]>1)invalid();
      const idBytes=b[p]===1?4:2,wide=(b[p+3]&1)!==0,entries=v.getUint32(p+4);
      if(entries>65536)invalid();
      p+=8;
      for(let i=0;i<entries;i++){
        if(table.end-p<idBytes+1)invalid();
        const item=idBytes===4?v.getUint32(p):v.getUint16(p);
        p+=idBytes;
        const count=b[p++],end=p+count*(wide?2:1);
        if(end>table.end)invalid();
        if(item===id)while(p<end){
          const index=wide?v.getUint16(p)&32767:b[p]&127;
          if(index>properties.length || selected.length>=32767)invalid();
          if(index)selected.push(properties[index-1]);
          p+=wide?2:1;
        }
        p=end;
      }
    }
    const extent=selected.find(box=>box.type==="ispe");
    if(!extent||extent.end-extent.data<12)invalid();
    let [w,h]=checkedExtent(v.getUint32(extent.data+4),v.getUint32(extent.data+8));
    for(const box of selected){
      if(box.type==="irot"){
        if(box.end-box.data<1)invalid();
        if(b[box.data]&1)[w,h]=[h,w];
      }else if(box.type==="clap"){
        if(box.end-box.data<32)invalid();
        const width=Math.round(v.getUint32(box.data)/v.getUint32(box.data+4));
        const height=Math.round(v.getUint32(box.data+8)/v.getUint32(box.data+12));
        if(!width||!height||width>w||height>h)invalid();
        [w,h]=[width,height];
      }
    }
    return [w,h];
  }
  function info(raw) {
    const b=bytes(raw), type=sniff(b), v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    let e=null,svg=null;
    if(type==="image/png"&&b.length>=24&&tag(b,12,4)==="IHDR")e=[v.getUint32(16),v.getUint32(20)];
    if(type==="image/jpeg")e=jpeg(b,v);
    if(type==="image/gif"&&b.length>=10)e=[v.getUint16(6,true),v.getUint16(8,true)];
    if(type==="image/webp"&&b.length>=25){
      const t=tag(b,12,4), le24=p=>b[p]+256*b[p+1]+65536*b[p+2];
      if(t==="VP8X"&&b.length>=30)e=[1+le24(24),1+le24(27)];
      if(t==="VP8 "&&b.length>=30)e=[v.getUint16(26,true)&16383,v.getUint16(28,true)&16383];
      if(t==="VP8L"&&b[20]===47){const sizes=v.getUint32(21,true);e=[1+(sizes&16383),1+((sizes>>>14)&16383)];}
    }
    if(type==="image/heic"||type==="image/heif")e=heif(b,v);
    if(type==="image/svg+xml"){svg=safeSVG(b);e=svg.extent;}
    if(type==="application/pdf")return {mediaType:type};
    if(!e)throw Error("The image header does not contain a usable size.");
    return {mediaType:type,extent:checkedExtent(...e),svg};
  }
  const num=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  const drawing=new Set(["g","rect","circle","ellipse","line","polygon","polyline","path"]);
  const props=new Set(["fill","stroke","stroke-width","fill-rule","opacity","fill-opacity","stroke-opacity","stroke-linecap","stroke-linejoin","transform",
    "x","y","width","height","rx","ry","cx","cy","r","x1","y1","x2","y2","points","d"]);
  const paint=value=>value==="none"||/^#[0-9a-f]{3,8}$/i.test(value)||/^(black|white|red|blue|green|grey|gray|yellow|orange|purple|transparent)$/i.test(value)||/^rgba?\([\d\s.,%]+\)$/.test(value);
  const number=(s,def=0)=>s==null?def:num.test(s)&&Math.abs(+s)<=10000000?+s:NaN;
  const numbers=s=>String(s||"").trim().split(/[\s,]+/).map(v=>number(v));
  function dimensions(s) {
    const m=/^([\d.]+)(px|mm|cm|pt|in)?$/.exec(s||"");
    return m?number(m[1])*({mm:96/25.4,cm:96/2.54,pt:96/72,in:96}[m[2]]||1):NaN;
  }
  function safeSVG(raw) {
    if(raw.length>2*1048576)throw Error("SVG exceeds the safe drawing limit.");
    const root=globalThis.AtriumXML.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw),{limits:{bytes:2*1048576,depth:24,elements:4000,attributes:32,text:120000}});
    if(root.local!=="svg"||root.ns!==SVG_NS)throw Error("Invalid SVG root.");
    const vb=root.attrs.viewBox?numbers(root.attrs.viewBox):null;
    let w=dimensions(root.attrs.width),h=dimensions(root.attrs.height);
    if(vb&&(vb.length!==4||!vb.every(Number.isFinite)||vb[2]<=0||vb[3]<=0))throw Error("Invalid SVG viewBox.");
    if(!(w>0&&h>0)&&vb){w=vb[2];h=vb[3];}
    const extent=checkedExtent(Math.ceil(w),Math.ceil(h)), commands=[];
    let omitted=0;
    function visit(node,depth) {
      if(node.ns!==SVG_NS||!drawing.has(node.local)){omitted++;return;}
      const a={};
      for(const [k,v] of Object.entries(node.attrs)) {
        if(!props.has(k)){if(k!=="id")omitted++;continue;}
        if(k==="fill"||k==="stroke"){if(!paint(v))throw Error("Unsupported SVG paint.");}
        else if(k==="d"){if(v.length>120000||!/^[MmZzLlHhVvCcSsQqTtAaEe\d.,+\s-]*$/.test(v))throw Error("Unsupported SVG path.");}
        else if(k==="points"){const p=numbers(v);if(p.length%2||p.length>16384||!p.every(Number.isFinite))throw Error("Invalid SVG points.");}
        else if(k==="transform"){if(v.length>512||!/^(\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([eE\d.,+\s-]+\)\s*,?)*$/.test(v))throw Error("Unsupported SVG transform.");}
        else if(["fill-rule","stroke-linecap","stroke-linejoin"].includes(k)){if(!/^(nonzero|evenodd|butt|round|square|bevel|miter)$/.test(v))throw Error("Unsupported SVG stroke.");}
        else if(!Number.isFinite(number(v)))throw Error("Invalid SVG drawing length.");
        a[k]=v;
      }
      commands.push({type:node.local,a,depth});
      for(const child of node.children)visit(child,depth+1);
    }
    const rootStyle=Object.fromEntries(Object.entries(root.attrs).filter(([key])=>props.has(key)&&!["x","y","width","height"].includes(key)));
    visit({ns:SVG_NS,local:"g",attrs:rootStyle,children:root.children},0);
    if(!commands.some(c=>c.type!=="g"))throw Error("SVG has no supported static artwork.");
    return {extent,viewBox:vb||[0,0,w,h],commands,omitted};
  }
  function renderSVG(ctx,svg,w,h) {
    const [x,y,vw,vh]=svg.viewBox,k=Math.min(w/vw,h/vh);
    ctx.save();ctx.translate((w-k*vw)/2,(h-k*vh)/2);ctx.scale(k,k);ctx.translate(-x,-y);
    let stack=[];
    for(const cmd of svg.commands) {
      while(stack.length>cmd.depth){ctx.restore();stack.pop();}
      const style={...(stack.at(-1)||{fill:"black",stroke:"none"}),...cmd.a},a=cmd.a;
      ctx.save();stack.push(style);
      for(const m of (a.transform||"").matchAll(/(\w+)\(([^)]*)\)/g)){
        const v=numbers(m[2]);if(!v.every(Number.isFinite))continue;
        if(m[1]==="matrix"&&v.length===6)ctx.transform(...v);
        if(m[1]==="translate")ctx.translate(v[0],v[1]||0);
        if(m[1]==="scale")ctx.scale(v[0],v[1]??v[0]);
        if(m[1]==="rotate"){ctx.translate(v[1]||0,v[2]||0);ctx.rotate(v[0]*Math.PI/180);ctx.translate(-(v[1]||0),-(v[2]||0));}
        if(m[1]==="skewX")ctx.transform(1,0,Math.tan(v[0]*Math.PI/180),1,0,0);
        if(m[1]==="skewY")ctx.transform(1,Math.tan(v[0]*Math.PI/180),0,1,0,0);
      }
      if(a.opacity!=null)ctx.globalAlpha*=Math.max(0,Math.min(1,+a.opacity));
      if(cmd.type==="g")continue;
      let p=new Path2D();
      const n=k=>number(a[k]);
      if(cmd.type==="rect")p.rect(n("x"),n("y"),Math.max(0,n("width")),Math.max(0,n("height")));
      if(cmd.type==="circle"||cmd.type==="ellipse"){const r=cmd.type==="circle";p.ellipse(n("cx"),n("cy"),Math.max(0,n(r?"r":"rx")),Math.max(0,n(r?"r":"ry")),0,0,Math.PI*2);}
      if(cmd.type==="line"){p.moveTo(n("x1"),n("y1"));p.lineTo(n("x2"),n("y2"));}
      if(cmd.type==="path")p=new Path2D(a.d||"");
      if(cmd.type==="polygon"||cmd.type==="polyline"){const v=numbers(a.points);if(v.length>=2){p.moveTo(v[0],v[1]);for(let i=2;i<v.length;i+=2)p.lineTo(v[i],v[i+1]);if(cmd.type==="polygon")p.closePath();}}
      const opacity=ctx.globalAlpha;
      if(style.fill!=="none"&&cmd.type!=="line"){ctx.fillStyle=style.fill;ctx.globalAlpha=opacity*number(style["fill-opacity"],1);ctx.fill(p,style["fill-rule"]||"nonzero");}
      if(style.stroke!=="none"){ctx.strokeStyle=style.stroke;ctx.lineWidth=number(style["stroke-width"],1);ctx.lineCap=style["stroke-linecap"]||"butt";ctx.lineJoin=style["stroke-linejoin"]||"miter";ctx.globalAlpha=opacity*number(style["stroke-opacity"],1);ctx.stroke(p);}
      ctx.globalAlpha=opacity;
    }
    while(stack.length){ctx.restore();stack.pop();}ctx.restore();
  }
  return {sniff,info,safeSVG,renderSVG,checkedExtent,MAX_BYTES};
})();
