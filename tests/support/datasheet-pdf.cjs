"use strict";

function fixture(pages = 2, {pins = false, annotated = false} = {}) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count " + pages + " /Kids [" +
      Array.from({length:pages},(_,i)=>(i*2+4)+" 0 R").join(" ") + "] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  for (let i=0;i<pages;i++) {
    const page = i*2+4, labels = i===0 && pins ? [
      [30,170,"Pin"],[49,170,"Number"],[130,170,"Name"],[230,170,"Type"],
      [30,145,"1"],[230,145,"Input"],
      [30,120,"2"],[130,120,"VCC"],[156,126,"1",7],[230,120,"Power"],
    ] : i===0 ? [
      [30,170,"Pin"],[130,170,"Name"],[230,170,"Function"],
      [30,145,"1"],[130,145,"VCC"],[230,145,"Power"],
      [30,120,"2"],[130,120,"GND"],[230,120,"Ground"]
    ] : [[30,170,"Datasheet page " + (i+1)]];
    const body = "0 .25 .6 rg 26 40 258 12 re f\n" +
      labels.map(([x,y,s,size=12])=>"BT /F1 "+size+" Tf "+x+" "+y+" Td ("+s+") Tj ET").join("\n");
    const annotation = annotated && i===0 ? " /Rotate 90 /CropBox [20 10 300 210] /Annots ["+(pages*2+4)+" 0 R]" : "";
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220] /Resources << /Font << /F1 3 0 R >> >> /Contents "+(page+1)+" 0 R"+annotation+" >>",
      "<< /Length " + body.length + " >>\nstream\n" + body + "\nendstream");
  }
  if (annotated) {
    const appearance = "1 0 0 rg 0 0 85 85 re f";
    objects.push("<< /Type /Annot /Subtype /Square /F 4 /Rect [65 65 150 150] /C [1 0 0] /AP << /N "+(pages*2+5)+" 0 R >> >>",
      "<< /Type /XObject /Subtype /Form /BBox [0 0 85 85] /Length "+appearance.length+" >>\nstream\n"+appearance+"\nendstream");
  }
  let text = "%PDF-1.7\n";
  const positions = [0];
  objects.forEach((object,i)=>{positions.push(text.length);text+=(i+1)+" 0 obj\n"+object+"\nendobj\n";});
  const index = text.length;
  text += "xref\n0 " + positions.length + "\n0000000000 65535 f \n";
  for (const offset of positions.slice(1)) text += String(offset).padStart(10,"0") + " 00000 n \n";
  return Buffer.from(text+"trailer\n<< /Size "+positions.length+" /Root 1 0 R >>\nstartxref\n"+index+"\n%%EOF\n");
}
module.exports = {fixture};
