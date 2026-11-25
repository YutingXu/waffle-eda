"use strict";

// Older Texts6 records have an absolute writing origin and no saved ink bounds.
// EmbeddedFonts6 provides the author's faces. Keep only the used glyph geometry
// in the board; the original font programs are never part of the Waffle model.
globalThis.AtriumAltiumTypefaces=(()=>{
  const tick=.00000254;
  function open(bytes,drawing,encode){
    if(!bytes || !globalThis.AtriumImportFormats?.inflate || !globalThis.AtriumPDFFonts)return null;
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),fonts=new Map(),cache=new Map();
    let pos=0,budget=32*1024*1024;
    const u32=()=>{const value=v.getUint32(pos,true);pos+=4;return value;};
    function name(){
      const n=u32();if(n%2 || n>4096 || pos+n>bytes.length)throw Error("Invalid embedded font name.");
      const s=new TextDecoder("utf-16le").decode(bytes.subarray(pos,pos+n)).replace(/\0+$/,"");pos+=n;return s;
    }
    while(pos<bytes.length){
      const display=name(),family=name(),style=name();
      pos+=3;const length=u32(),end=pos+length;
      if(length<6||end>bytes.length)throw Error("Invalid embedded font record.");
      const face={data:bytes.subarray(pos+2,end-4)},suffix="|"+Number(/bold/i.test(style))+"|"+Number(/italic|oblique/i.test(style));
      fonts.set(display.toLowerCase()+suffix,face);fonts.set(family.toLowerCase()+suffix,face);
      pos=end;
    }
    return (item,value)=>{
      const key=(item.family||"Arial").toLowerCase()+"|"+Number(!!item.bold)+"|"+Number(!!item.italic);
      const font=fonts.get(key);if(!font)return null;
      if(!Object.hasOwn(font,"face")){
        font.face=null;
        const limit=Math.min(budget,16*1024*1024);
        if(limit<=0)return null;
        const data=AtriumImportFormats.inflate(font.data,0,limit);
        budget-=data.length;
        font.face=AtriumPDFFonts.parse(data);
      }
      const face=font.face;
      if(!face || !(face.cellHeight>0) || !value || /[\r\n]/.test(value))return null;
      const groupKey=key+"|"+item.size;
      let bank=cache.get(groupKey);
      if(!bank){
        const sets=drawing.letterSets ||= [];
        bank={id:sets.length,glyphs:{},boxes:new Map(),scale:item.size/face.cellHeight};
        sets.push(bank.glyphs);cache.set(groupKey,bank);
      }
      let cursor=0,x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for(const ch of value){
        const cp=ch.codePointAt(0),g=face.gid(cp);
        if(!g)return null;
        if(!Object.hasOwn(bank.glyphs,cp)){
          const rings=face.contours(g),scale=bank.scale/tick;
          const size=4+rings.length*8+rings.reduce((n,r)=>n+16*r.length,0);
          if(size>budget)return null;
          const out=new Uint8Array(size),v=new DataView(out.buffer);v.setUint32(0,rings.length,true);
          const box=[Infinity,Infinity,-Infinity,-Infinity];
          let at=4+rings.length*4;
          rings.forEach((ring,i)=>{
            let twiceArea=0;v.setUint32(at,ring.length,true);at+=4;
            for(let j=0;j<ring.length;j++){
              const [x,y]=ring[j],next=ring[(j+1)%ring.length];
              twiceArea+=x*next[1]-next[0]*y;
              v.setFloat64(at,x*scale,true);v.setFloat64(at+8,y*scale,true);at+=16;
              box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
            }
            // TrueType outer contours run clockwise in the font's Y-up frame.
            v.setUint32(4+i*4,twiceArea>0?1:0,true);
          });
          bank.boxes.set(cp,box);bank.glyphs[cp]=[Math.round(face.advance(g)*scale),encode(out)];
          budget-=size;
        }
        const b=bank.boxes.get(cp);
        x0=Math.min(x0,cursor+b[0]);x1=Math.max(x1,cursor+b[2]);y0=Math.min(y0,b[1]);y1=Math.max(y1,b[3]);
        cursor+=face.advance(g);
      }
      if(!(x1>x0 && y1>y0))return null;
      return {text:value,size:item.size,width:(x1-x0)*bank.scale,height:(y1-y0)*bank.scale,
        family:item.family||"Arial",bold:!!item.bold,italic:!!item.italic,mode:"baseline",letterSet:bank.id};
    };
  }
  return {open};
})();
