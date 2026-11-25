"use strict";

globalThis.AtriumTableExchange = (() => {
  const T=globalThis.AtriumTableData,limit=2*1024*1024;
  const escape=v=>String(v).replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
  const quote=(s,separator)=>{s=String(s);return s.includes(separator)||/["\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  const colour=value=>{
    if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)) return value;
    const m=/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*1)?\s*\)$/i.exec(value);
    return m&&m.slice(1).every(x=>+x<=255)?"#"+m.slice(1).map(x=>(+x).toString(16).padStart(2,"0")).join(""):null;
  };
  function tsv(source, separator = "\t", options = {}) {
    if(typeof source!=="string"||source.length>limit)throw Error("The pasted table exceeds 2 MiB.");
    const {strict=false,rows:maxRows=Infinity,columns:maxColumns=Infinity,text:maxText=Infinity,
      cells:maxCells=T.limits.range}=options;
    const rows=[];let row=[],field="",quoted=false,closed=false,total=0;
    function cell(){
      if(++total>maxCells)throw Error("Select a smaller paste region.");
      if(row.length>=maxColumns || field.length>maxText)throw Error("The imported table exceeds its cell or column limit.");
      row.push({text:field});field="";closed=false;
    }
    function end(){
      if(rows.length>=maxRows)throw Error("The imported table exceeds its row limit.");
      cell();rows.push(row);row=[];
    }
    for(let i=0;i<source.length;i++){
      const ch=source[i];
      if(quoted){if(ch!=='"')field+=ch;else if(source[i+1]==='"'){field+='"';i++;}else {quoted=false;closed=true;}continue;}
      if(ch==='"'&&!field&&!closed){quoted=true;continue;}
      if(ch===separator){cell();continue;}
      if(ch==="\r"||ch==="\n"){if(ch==="\r"&&source[i+1]==="\n")i++;end();continue;}
      if(closed)throw Error("An imported quoted cell must end at a column or row boundary.");
      if(strict&&ch==='"')throw Error("An imported quotation must start at a column boundary.");
      field+=ch;
    }
    if(quoted)throw Error("An imported quoted cell is unfinished.");
    if(field||closed||row.length||!rows.length)end();
    return {rows,merges:[],notice:"Pasted values."};
  }
  function html(source,doc=globalThis.document) {
    if(!doc||typeof source!=="string"||source.length>limit)return null;
    const template=doc.createElement("template");template.innerHTML=source;
    const table=template.content.querySelector("table");if(!table)return null;
    // Spreadsheet clipboards often put simple class declarations in an inert stylesheet.
    // Read only individual formatting values; none of the clipboard DOM is mounted.
    const rules=new Map(),format=/^(?:font-weight|font-style|color|background-color|text-align|vertical-align|white-space|border(?:-(?:left|right|top|bottom))?(?:-(?:style|width|color))?)$/;
    for(const sheet of template.content.querySelectorAll("style")) for(const match of sheet.textContent.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for(const selector of match[1].split(",")) {
        const m=/^(?:td|th)?\.([a-z_][\w-]{0,63})$/i.exec(selector.trim());
        if(!m || rules.size>1024)continue;
        const pairs=rules.get(m[1])||[];
        for(const declaration of match[2].split(";")) {
          const colon=declaration.indexOf(":"),key=declaration.slice(0,colon).trim().toLowerCase(),val=declaration.slice(colon+1).trim();
          if(colon>0&&format.test(key)&&val.length<128&&!/url|var\(|@|[<>\\]/i.test(val)&&pairs.length<64)pairs.push([key,val]);
        }
        rules.set(m[1],pairs);
      }
    }
    const rows=[],merges=[],occupied=new Set();let count=0;
    for(const tr of table.rows) {
      const r=rows.length,values=[];if(r>=T.limits.rows)throw Error("The pasted table has too many rows.");
      let c=0;
      for(const el of tr.cells) {
        while(occupied.has(r+","+c))c++;
        const rs=Number(el.getAttribute("rowspan")||1),cs=Number(el.getAttribute("colspan")||1);
        if(!Number.isInteger(rs)||!Number.isInteger(cs)||rs<1||cs<1||r+rs>T.limits.rows||c+cs>T.limits.columns||(count+=rs*cs)>T.limits.range)throw Error("Select a smaller rectangular paste region.");
        for(let y=r;y<r+rs;y++)for(let x=c;x<c+cs;x++){
          const k=y+","+x;if(occupied.has(k))throw Error("The clipboard contains overlapping cells.");occupied.add(k);
        }
        const style={},css=doc.createElement("span").style;
        for(const name of el.classList)for(const [key,v] of rules.get(name)||[])css.setProperty(key,v);
        for(const node of [el,el.querySelector("span[style]")].filter(Boolean))for(let i=0;i<node.style.length;i++){
          const key=node.style[i],v=node.style.getPropertyValue(key);if(format.test(key)&&!(/url|var\(/i.test(v)))css.setProperty(key,v);
        }
        if(!css.backgroundColor&&colour(el.getAttribute("bgcolor")))css.backgroundColor=colour(el.getAttribute("bgcolor"));
        if(!css.textAlign&&["left","center","right"].includes(el.getAttribute("align")))css.textAlign=el.getAttribute("align");
        if(["top","middle","bottom"].includes(css.verticalAlign))style.vertical=css.verticalAlign;
        if(css.whiteSpace==="normal"||css.whiteSpace==="pre-wrap")style.wrap=true;
        if(el.tagName==="TH"||el.querySelector("b,strong")||css.fontWeight==="bold"||Number(css.fontWeight)>=600)style.bold=true;
        if(el.querySelector("i,em")||css.fontStyle==="italic")style.italic=true;
        if(["left","center","right"].includes(css.textAlign))style.align=css.textAlign;
        if(colour(css.color))style.color=colour(css.color);
        if(colour(css.backgroundColor))style.fill=colour(css.backgroundColor);
        for(const edge of ["Top","Right","Bottom","Left"])if(css["border"+edge+"Style"]&&css["border"+edge+"Style"]!=="none"){
          (style.borders??={})[edge.toLowerCase()]=colour(css["border"+edge+"Color"])||"line";
        }
        for(const node of el.querySelectorAll("script,style,table"))node.remove();
        for(const br of el.querySelectorAll("br"))br.replaceWith("\n");
        values[c]={text:el.textContent,style,header:el.tagName==="TH",scope:el.getAttribute("scope")||"",heading:tr.parentElement?.tagName==="THEAD"};
        if(rs*cs>1)merges.push({r,c,rows:rs,columns:cs});
        c+=cs;
      }
      rows.push(values);
    }
    return {rows,merges,notice:"Pasted values. Spreadsheet formulas are imported as their displayed values."};
  }
  function paste(s,at,data,makeId) {
    const ix=T.index(s),r0=ix.rows.get(at.rowId),c0=ix.columns.get(at.columnId);
    if(r0==null||c0==null)throw Error("Select a cell before pasting.");
    let height=data.rows.length,width=Math.max(0,...data.rows.map(r=>r.length));
    for(const m of data.merges){height=Math.max(height,m.r+m.rows);width=Math.max(width,m.c+m.columns);}
    if(height*width>T.limits.range||r0+height>T.limits.rows||c0+width>T.limits.columns)throw Error("The paste exceeds the table limits.");
    if(s.query)for(const row of s.rows.slice(r0,r0+height)){
      if(row.removed || row.queryEmpty)T.assertEditable(s,row.id,at.columnId,true);
      for(const column of s.columns.slice(c0,c0+width))T.assertEditable(s,row.id,column.id,true);
    }
    if(r0+height>s.rows.length)s=T.axis(s,"rows",s.rows.length,r0+height-s.rows.length,true,makeId);
    if(c0+width>s.columns.length)s=T.axis(s,"columns",s.columns.length,c0+width-s.columns.length,true,makeId);
    const entries=[];
    for(let r=0;r<height;r++)for(let c=0;c<width;c++){
      const value=data.rows[r]?.[c];entries.push({rowId:s.rows[r0+r].id,columnId:s.columns[c0+c].id,
        content:value?.text?{kind:"literal",text:value.text}:null,...(value?.style?{style:value.style}:{})});
    }
    const rows=new Set(s.rows.slice(r0,r0+height).map(r=>r.id)),columns=new Set(s.columns.slice(c0,c0+width).map(c=>c.id));
    for(const m of s.merges) if(m.rows.some(r=>rows.has(r))&&m.columns.some(c=>columns.has(c))&&
      (!m.rows.every(r=>rows.has(r))||!m.columns.every(c=>columns.has(c))))throw Error("The paste would split a merged cell.");
    s=T.batch({...s,merges:s.merges.filter(m=>!m.rows.some(r=>rows.has(r))||!m.columns.some(c=>columns.has(c)))},entries);
    const merges=data.merges.map(m=>({id:makeId(),rows:s.rows.slice(r0+m.r,r0+m.r+m.rows).map(r=>r.id),columns:s.columns.slice(c0+m.c,c0+m.c+m.columns).map(c=>c.id)}));
    let headerRows=s.headerRows,headerColumns=s.headerColumns;
    if(r0===0){
      let n=0;
      for(const row of data.rows){const cells=row.filter(Boolean);if(!cells.length||!cells.every(c=>c.heading||c.header&&c.scope!=="row"))break;n++;}
      headerRows=Math.max(headerRows,n);
    }
    if(c0===0){
      const dataRows=data.rows.slice(r0===0?headerRows:0);
      let n=0;while(dataRows.length&&dataRows.every(row=>row[n]?.header&&row[n]?.scope==="row"))n++;
      headerColumns=Math.max(headerColumns,n);
    }
    return T.validate({...s,headerRows,headerColumns,merges:[...s.merges,...merges]});
  }
  function plain(content) {
    if(!content)return "";
    if(content.kind==="rich"){
      const body=content.richText;
      const source=globalThis.AtriumNotebook?.bodyText(body,undefined,undefined,{},true);
      if(source)return source.text;
      return body.blocks.map(block=>block.runs.map(run=>{
        if(run.type==="field")return "{"+run.expression+"}";
        if(run.type==="math")return "$"+run.tex+"$";
        return run.text||"";
      }).join("")).join("\n");
    }
    return content.text??content.label??content.alt??content.tex??content.source??content.expression??content.blockId??"";
  }
  function render(s,selection,value=(r,c)=>plain(T.get(s,r,c)?.content),options={}) {
    const {rows,columns}=selection||{rows:T.presentationRows(s,value).map(r=>r.id),columns:s.columns.map(c=>c.id)};
    const csvOnly=options.csvOnly===true;
    if(!csvOnly&&rows.length*columns.length>T.limits.range)throw Error("Select a smaller clipboard range.");
    const texts=[],table=[],seen=new Set(),ri=new Map(rows.map((k,i)=>[k,i])),ci=new Map(columns.map((k,i)=>[k,i]));
    for(const [y,r] of rows.entries()){
      const row=[],tags=[];
      for(const [x,c] of columns.entries()){
        const merged=T.merged(s,r,c),data=T.get(s,merged?.rows[0]??r,merged?.columns[0]??c),cell=data?.style||{};
        const visible=merged?{rs:merged.rows.filter(k=>ri.has(k)).length,cs:merged.columns.filter(k=>ci.has(k)).length}:null;
        const text=merged&&seen.has(merged.id)?"":value(merged?.rows[0]??r,merged?.columns[0]??c)??"";
        row.push(quote(text,csvOnly?",":"\t"));if(csvOnly){if(merged)seen.add(merged.id);continue;}
        if(merged&&seen.has(merged.id))continue;if(merged)seen.add(merged.id);
        const style=[cell.bold&&"font-weight:bold",cell.italic&&"font-style:italic",cell.align&&"text-align:"+cell.align,
          cell.vertical&&"vertical-align:"+cell.vertical,cell.wrap&&"white-space:pre-wrap",
          colour(cell.fill)&&"background-color:"+cell.fill,colour(cell.color)&&"color:"+cell.color];
        for(const [edge,v] of Object.entries(cell.borders||{}))style.push("border-"+edge+":1px solid "+(colour(v)||"currentColor"));
        const scope=T.index(s).rows.get(r)<s.headerRows?"col":T.index(s).columns.get(c)<s.headerColumns?"row":"";
        const tag=scope?"th":"td";
        tags.push("<"+tag+(scope?' scope="'+scope+'"':"")+(visible?.rs>1?' rowspan="'+visible.rs+'"':"")+(visible?.cs>1?' colspan="'+visible.cs+'"':"")+
          (style.some(Boolean)?' style="'+escape(style.filter(Boolean).join(";"))+'"':"")+">"+escape(text).replaceAll("\n","<br>")+"</"+tag+">");
      }
      texts.push(row.join(csvOnly?",":"\t"));if(!csvOnly)table.push("<tr>"+tags.join("")+"</tr>");
    }
    return csvOnly?texts.join("\r\n")+"\r\n":{text:texts.join("\r\n"),html:"<table>"+table.join("")+"</table>"};
  }
  return Object.freeze({tsv,html,paste,render,plain});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumTableExchange;
