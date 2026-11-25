"use strict";
// The editing surface sits at the item's world rectangle. Native ranges preserve IME,
// composition, clipboard selection, touch handles and screen-reader text navigation.
globalThis.AtriumRichTextEditor = (() => {
  const N=globalThis.AtriumNotebook,F=globalThis.AtriumNotebookFonts,Fields=globalThis.AtriumNoteFields;
  const options={paragraph:"Text",h1:"Heading 1",h2:"Heading 2",h3:"Heading 3",bullet:"Bulleted list",number:"Numbered list",check:"Checklist"};
  const {el, elWithAttributes, button} = AtriumNavCommon;
  const textMarks=["bold","italic","underline","strike","code"];
  let session=null;
  function paint(node,r) {
    if(r.bold) node.style.fontWeight="700";if(r.italic)node.style.fontStyle="italic";
    if(r.underline || r.strike)node.style.textDecoration=[r.underline&&"underline",r.strike&&"line-through"].filter(Boolean).join(" ");
    if(r.code) node.style.fontFamily='"Waffle Note Mono"';
    if(r.color) node.style.color=r.color;if(r.highlight) node.style.setProperty("--swatch", r.highlight);
    if(r.href) {node.classList.add("rn-link");node.dataset.href=r.href;}
    for(const k of textMarks) if(r[k]) node.dataset[k]="1";
  }
  function atom(r) {
    const s=session,node=el("span");paint(node,r);
    if(r.type==="field") {
      const v=Fields.resolve(s.project,s.doc,r.expression,r.binding);
      node.classList.add("rn-field");node.classList.toggle("broken",v.broken);node.contentEditable="false";
      node.dataset.expression=r.expression;if(r.binding)node.dataset.binding=JSON.stringify(r.binding);
      node.textContent=v.text;node.title=v.broken?"Broken reference · "+r.expression:v.label;
      node.onclick=e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();Fields.follow(s.host,v);}};
    } else if(r.type==="math") {
      node.classList.add("rn-equation");node.contentEditable="false";node.dataset.tex=r.tex;node.setAttribute("aria-label",r.tex);
      function render(m) {
        if(session!==s)return;
        const layout=m.layout(r.tex,{display:false}),canvas=el("canvas"),em=64;
        canvas.width=Math.max(1,Math.ceil(layout.advance*em));canvas.height=Math.max(1,Math.ceil((layout.ascent+layout.descent)*em));
        canvas.style.width=layout.advance+"em";canvas.style.height=(layout.ascent+layout.descent)+"em";canvas.style.verticalAlign=(-layout.descent)+"em";
        m.draw(canvas.getContext("2d"),layout,{x:0,y:layout.ascent*em,size:em,ink:getComputedStyle(s.root).color});node.replaceChildren(canvas);
      }
      if(globalThis.AtriumMath) render(globalThis.AtriumMath);
      else {
        node.textContent=r.tex;
        const lazy=globalThis.AtriumLazy;
        if(lazy?.modules().includes("AtriumMath")) lazy.need("AtriumMath").then(render,e=>s.host.info(e.message));
      }
    } else node.textContent=r.text || "";
    return node;
  }
  function marker(block) {
    if(!["bullet","number","check"].includes(block.dataset.style))return;
    const m=el("span",null,"rn-marker");m.contentEditable="false";
    if(block.dataset.style==="check"){
      const show=()=>{const on=block.dataset.checked==="true";m.textContent=on?"☑":"☐";m.setAttribute("aria-checked",String(on));};
      const toggle=()=>{block.dataset.checked=String(block.dataset.checked!=="true");show();};
      m.tabIndex=0;m.setAttribute("role","checkbox");m.setAttribute("aria-label","Checklist item");show();
      m.onclick=toggle;m.onkeydown=e=>{if(e.key===" " || e.key==="Enter"){e.preventDefault();e.stopPropagation();toggle();}};
    } else m.setAttribute("aria-hidden","true");
    block.prepend(m);
  }
  function blockNode(b) {
    const node=el("div");node.dataset.block="";node.dataset.style=b.style;node.style.textAlign=b.align || "left";
    if(b.style==="check")node.dataset.checked=String(!!b.checked);
    for(const r of b.runs || [])node.append(atom(r));
    if(!node.hasChildNodes())node.append(el("br"));marker(node);return node;
  }
  function rgb(value) {
    if(N.color(value)) return value;
    const m=/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/.exec(value || "");
    return m?"#"+m.slice(1,4).map(v=>(+v).toString(16).padStart(2,"0")).join(""):"";
  }
  function readNodes(nodes,marks,runs) {
    for(const n of nodes) {
      if(n.nodeType===3) {
        if(n.data)runs.push({type:"text",text:n.data.replace(/\u00a0/g," "),...marks});
        continue;
      }
      if(n.nodeType!==1 || n.classList.contains("rn-marker")) continue;
      const tag=n.tagName, next={...marks},st=n.style;
      if(tag==="B"||tag==="STRONG"||+st.fontWeight>=600||n.dataset.bold)next.bold=true;
      if(tag==="I"||tag==="EM"||st.fontStyle==="italic"||n.dataset.italic)next.italic=true;
      if(tag==="U"||st.textDecoration.includes("underline")||n.dataset.underline)next.underline=true;
      if(tag==="S"||tag==="STRIKE"||st.textDecoration.includes("line-through")||n.dataset.strike)next.strike=true;
      if(tag==="CODE"||n.dataset.code)next.code=true;
      const color=rgb(st.color || n.getAttribute("color")),highlight=rgb(st.backgroundColor);
      if(color)next.color=color;if(highlight)next.highlight=highlight;
      const href=N.safeURL(n.dataset.href || n.getAttribute("href"));if(href)next.href=href;
      if(n.dataset.expression!=null) {
        let binding;try {binding=JSON.parse(n.dataset.binding || "null");}catch {}
        runs.push({type:"field",expression:n.dataset.expression,...(binding?{binding}:{}),...next});
      } else if(n.dataset.tex!=null) runs.push({type:"math",tex:n.dataset.tex,...next});
      else if(tag==="BR") {if(n.nextSibling)runs.push({type:"text",text:"\n",...next});}
      else readNodes(n.childNodes,next,runs);
    }
    return runs;
  }
  function readBody(s) {
    const blocks=[],loose=[];
    const push=(node,nodes)=>{
      const runs=readNodes(nodes,{},[]),merged=[];
      for(const r of runs) {
        const prev=merged.at(-1),{text:_,...marks}=r,pm=prev&&{...prev};if(pm)delete pm.text;
        if(r.type==="text" && prev?.type==="text" && JSON.stringify(pm)===JSON.stringify(marks))prev.text+=r.text;else merged.push(r);
      }
      const style=node?.dataset.style || "paragraph",align=node?.style.textAlign;
      blocks.push({style,...(align&&align!=="left"?{align}:{}),...(style==="check"?{checked:node?.dataset.checked==="true"}:{}),runs:merged});
    };
    function flush(){if(loose.length)push(null,loose.splice(0));}
    for(const n of s.root.childNodes) {
      if(n.nodeType===1 && ["DIV","P"].includes(n.tagName)){flush();push(n,n.childNodes);}else loose.push(n);
    }
    flush();return {font:s.font,blocks:blocks.length?blocks:[{style:"paragraph",runs:[]}]};
  }
  function selection(s) {
    const sel=globalThis.getSelection?.();if(!sel?.rangeCount)return null;
    const r=sel.getRangeAt(0);return s.root.contains(r.commonAncestorContainer)?r:null;
  }
  function resume(s) {
    s.root.focus({preventScroll:true});if(s.range && s.root.contains(s.range.commonAncestorContainer)) {const sel=globalThis.getSelection?.();sel.removeAllRanges();sel.addRange(s.range);}
  }
  function endAt(n) {
    const r=document.createRange();r.selectNodeContents(n);r.collapse(false);
    const sel=globalThis.getSelection?.();sel.removeAllRanges();sel.addRange(r);if(session)session.range=r.cloneRange();
  }
  function insertNode(s,node,range) {
    const r=range || selection(s);if(!r)return;
    r.deleteContents();r.insertNode(node);const spacer=document.createTextNode("");node.after(spacer);
    r.setStart(spacer,0);r.collapse(true);const sel=globalThis.getSelection?.();sel.removeAllRanges();sel.addRange(r);s.range=r.cloneRange();
  }
  function blockOf(node,s) {
    const e=node?.nodeType===1?node:node?.parentElement;return e?.closest("[data-block]") || (e===s.root?s.root.firstElementChild:null);
  }
  function setStyle(s,style) {
    resume(s);const range=selection(s);if(!range)return;
    for(const b of s.root.children)if(range.intersectsNode(b)) {b.querySelector(":scope > .rn-marker")?.remove();b.dataset.style=style;if(style==="check") b.dataset.checked||="false";marker(b);}
  }
  function currentTextRange(s) {
    const range=selection(s);if(!range?.collapsed || range.endContainer.nodeType!==3)return null;
    const n=range.endContainer;return {n,pos:range.endOffset,before:n.textContent.slice(0,range.endOffset),range};
  }
  function replaceSuffix(t,length,node,s) {const r=t.range.cloneRange();r.setStart(t.n,t.pos-length);insertNode(s,node,r);}
  function insideMath(text) {
    let open=false;
    for(let i=0;i<text.length;i++) {
      if(text[i]==="\\")i++;
      else if(text[i]==="$")open=!open;
    }
    return open;
  }
  function shortcuts(s) {
    const t=currentTextRange(s);if(!t)return;
    const b=blockOf(t.n,s),start=b?.textContent.replace(/^[☐☑•]/,"");
    const prefix=/^(#{1,3}|- \[([ xX])\]|[-*]|\d+\.) $/.exec(start || "");
    if(prefix && b) {
      const style=prefix[1][0]==="#"?"h"+prefix[1].length:prefix[1].includes("[")?"check":/^\d/.test(prefix[1])?"number":"bullet";
      b.replaceChildren(document.createTextNode(""));b.dataset.style=style;b.dataset.checked=String(!!prefix[2]?.trim());marker(b);endAt(b.lastChild);return;
    }
    if(insideMath(t.before))return;
    const m=/(\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|~~[^~\n]+~~|\x60[^\x60\n]+\x60|\$[^$\n]+\$|\{[^{}\n]+\})$/.exec(t.before);
    if(m) {const r=N.parseInline(m[0],s.project,s.doc)[0];if(r) replaceSuffix(t,m[0].length,atom(r),s);}
  }
  function hideSuggestions(s) {
    s.list.hidden=true;s.root.removeAttribute("aria-activedescendant");
  }
  function suggestions(s) {
    const t=currentTextRange(s),m=t && /\{([^{}\n]*)$/.exec(t.before);
    s.list.replaceChildren();s.rows=[];s.choice=0;hideSuggestions(s);
    if(!m || insideMath(t.before))return;
    const rows=Fields.complete(s.project,s.doc,m[1],8);
    function pick(i){const row=rows[i];if(!row)return;s.root.focus({preventScroll:true});const source=currentTextRange(s) || t;
      replaceSuffix(source,m[0].length,atom({type:"field",expression:row.expression,binding:row.binding}),s);hideSuggestions(s);}
    for(const [i,row] of rows.entries()) {
      const b=button(row.expression,()=>pick(i),"ui-select-option",row.expression,row.expression);b.id="rn-field-"+i;b.setAttribute("role","option");b.tabIndex=-1;
      if(row.detail)b.append(el("small",row.detail));b.onpointerdown=e=>e.preventDefault();s.list.append(b);
    }
    s.rows=rows;s.pick=pick;s.list.hidden=!rows.length;if(rows.length){s.list.firstElementChild.setAttribute("aria-selected","true");s.root.setAttribute("aria-activedescendant","rn-field-0");}
  }
  function selectFormat(s) {
    if(session!==s)return;const range=selection(s);
    if(range){s.range=range.cloneRange();const block=blockOf(range.startContainer,s);s.styles.value=block?.dataset.style || "paragraph";s.align.value=block?.style.textAlign || "left";
      for(const button of s.bar.querySelectorAll("[data-command]"))button.setAttribute("aria-pressed",String(!!document.queryCommandState?.(button.dataset.command)));
      if(!range.collapsed && s.bar.hidden){s.bar.hidden=false;position(s,false);}}
  }
  function position(s,keep=true) {
    if(session!==s)return;
    if(s.host.doc()!==s.doc || !s.doc.items.includes(s.item)){close(false);return;}
    const canvas=s.host.canvas(),r=canvas.getBoundingClientRect(),view=s.host.view(),scale=view.camera().scale;
    const i=s.item,[x,y]=view.worldToScreen([Math.min(i.x,i.x+i.w),Math.min(i.y,i.y+i.h)]),vv=globalThis.visualViewport;
    const left=vv?.offsetLeft||0,top=vv?.offsetTop||0,right=left+(vv?.width||innerWidth),bottom=top+(vv?.height||innerHeight);
    let sx=r.left+x,sy=r.top+y;
    if(keep && (sy<top+55 || sy>bottom-105 || sx>right-90 || sx<left)) {
      const dx=sx>right-90?right-120-sx:sx<left?left+18-sx:0,dy=sy<top+55?top+58-sy:sy>bottom-105?bottom-150-sy:0;
      view.pan(dx,dy);s.host.redraw();sx+=dx;sy+=dy;
    }
    const c=globalThis.AtriumRichText.colours();s.root.style.color=c.ink;s.root.style.setProperty("--swatch", i.fill || c.paper);
    s.root.style.setProperty("--rn-field",c.field);s.root.style.setProperty("--rn-broken",c.broken);
    const w=Math.max(55,Math.abs(i.w)*scale),h=Math.max(40,Math.abs(i.h)*scale);
    Object.assign(s.root.style,{left:sx+"px",top:sy+"px",width:w+"px",height:h+"px",maxHeight:Math.max(44,bottom-sy-7)+"px",padding:1.25*scale+"px",
      fontSize:(i.size||2.7)*scale+"px",fontFamily:'"'+F.familyName(s.font===i.richText.font?F.fontFor(i):s.font)+'"'});
    s.root.style.height=Math.max(h,s.root.scrollHeight)+"px";
    const strip=s.tools.offsetHeight || 44,panels=s.bar.hidden?0:s.bar.offsetHeight;
    const roomAbove=sy-top, roomBelow=bottom-s.root.getBoundingClientRect().bottom,above=roomAbove>=strip+panels+12 || roomAbove>=roomBelow;
    const toolTop=above?Math.max(top+6+panels,sy-strip-5):Math.min(bottom-6-strip-panels,s.root.getBoundingClientRect().bottom+5);
    Object.assign(s.bar.style,{top:above?"auto":"100%",bottom:above?"100%":"auto"});
    Object.assign(s.tools.style,{left:Math.max(left+6,Math.min(sx,right-Math.min(530,right-left-12)))+"px",top:Math.max(top+6,toolTop)+"px",maxWidth:Math.max(200,right-left-12)+"px"});
    const rect=selection(s)?.getBoundingClientRect();
    Object.assign(s.list.style,{left:Math.max(left+5,Math.min(rect?.left||sx,right-248))+"px",top:Math.max(top+5,Math.min((rect?.bottom||sy)+4,bottom-216))+"px"});
  }
  function action(s,cmd,value=null){resume(s);document.execCommand(cmd,false,value);selectFormat(s);}
  function mark(s,k) {
    resume(s);const range=selection(s);
    if(!range || range.collapsed)return;
    const node=el("span");node.dataset[k]="1";paint(node,{[k]:true});node.append(range.extractContents());range.insertNode(node);range.selectNodeContents(node);s.range=range.cloneRange();
  }
  function toolset(s, {select}) {
    const styles = select(Object.entries(options), {label:"Paragraph style", native:true, onChange:value=>setStyle(s,value)}); s.styles = styles;
    const more=button("Aa",()=>{s.bar.hidden=!s.bar.hidden;if(!s.bar.hidden)resume(s);position(s,false);},null,"Formatting","Formatting");
    const save=button("Done",()=>close(true),null,"Finish editing","Finish editing");s.tools.append(styles,more,save,s.bar);
    for(const [label,glyph,cmd] of [["Bold","B","bold"],["Italic","I","italic"],["Underline","U","underline"],["Strikethrough","S","strikeThrough"]]) {
      const b=button(glyph,()=>action(s,cmd),null,label,label);b.dataset.command=cmd;b.setAttribute("aria-pressed","false");b.onpointerdown=e=>e.preventDefault();s.bar.append(b);
    }
    const code=button("‹›",()=>mark(s,"code"),null,"Inline code","Inline code");code.onpointerdown=e=>e.preventDefault();s.bar.append(code);
    for(const [label,cmd] of [["Text colour","foreColor"],["Text highlight","hiliteColor"]]) {
      const l=el("label",label),input=el("input");input.type="color";input.setAttribute("aria-label",label);input.value=cmd==="foreColor"?"#22508c":"#f9df86";
      input.oninput=()=>action(s,cmd,input.value);l.append(input);s.bar.append(l);
    }
    const link=button("Link",()=>{s.url.hidden=false;s.url.focus();},null,"Add link","Add link");link.onpointerdown=e=>e.preventDefault();s.bar.append(link,s.url);
    s.url.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();const u=N.safeURL(s.url.value);if(!u){s.host.info("Enter an HTTP, HTTPS or mailto link.");return;}action(s,"createLink",u);s.url.hidden=true;s.url.value="";}};
    const align = select(["left","center","right"].map(value=>[value,"Align "+value]), {label:"Text alignment", native:true}); s.align = align;
    align.onchange=()=>{resume(s);const r=selection(s);if(r)for(const b of s.root.children)if(r.intersectsNode(b))b.style.textAlign=align.value;};
    const assetFont=s.font?.source==="asset"?s.font:null;
    const choices = Object.entries(F.names).map(([value,name])=>[value,name.replace("Waffle Note ","")]);
    if (assetFont) choices.push(["asset","Embedded project font"]);
    choices.push(["system","System font…"]);
    const fonts = select(choices, {label:"Notebook font", native:true, value:typeof s.font==="string"?s.font:assetFont?"asset":"system"});
    const family=el("input");family.type="text";family.placeholder="System font family";family.setAttribute("aria-label","System font family");family.hidden=fonts.value!=="system";family.value=s.font.family || "";
    function system() {const name=family.value.trim();if(/^[\p{L}\p{N} ._-]{1,80}$/u.test(name)) {s.font={source:"system",family:name};position(s);s.host.info("Other computers and PDFs may substitute this system font.");}}
    family.onchange=system;fonts.onchange=()=>{family.hidden=fonts.value!=="system";if(!family.hidden){family.focus();s.host.info("Other computers and PDFs may substitute this system font.");return;}s.font=fonts.value==="asset"?assetFont:fonts.value;position(s);resume(s);};
    s.bar.append(align,fonts,family);
  }
  function close(save) {
    const s=session;if(!s)return true;
    if(save && s.host.project()===s.project && s.host.doc()===s.doc && s.doc.items.includes(s.item)) {
      const body=readBody(s);
      if(!N.validate(body))return false;
      if(JSON.stringify(body)!==s.initial && s.host.edit(()=>{s.item.richText=body;s.item.text=N.bodyText(body,null,null,{},true).text;const l=globalThis.AtriumRichText.layout(s.project,s.doc,s.item);s.item.h=Math.max(Math.abs(s.item.h),l.height);},"Edit engineering note",[s.item])===false)return false;
    }
    session=null;s.abort.abort();s.unsub?.();s.root.remove();s.tools.remove();s.list.remove();s.host.redraw();s.host.canvas()?.focus?.({preventScroll:true});
  }
  async function open(host,item) {
    if(globalThis.AtriumLabs?.notebookEnabled()===false)return false;
    if(session?.item===item){session.root.focus();return true;}
    if(session && close(true)===false)return false;
    const doc=host.doc(),project=host.project();
    if(!doc.items.includes(item) || !N.validate(item.richText))return false;
    const [kit] = await Promise.all([globalThis.AtriumUIKit || AtriumLazy.need("AtriumUIKit"),F.ready(),F.prepareItem(item)]);
    if(globalThis.AtriumLabs?.notebookEnabled()===false || host.doc()!==doc || !doc.items.includes(item))return false;
    const s={host,doc,project,item,font:item.richText.font||"sans",abort:new AbortController(),root:el("div",null,"rn-editor"),
      tools:kit.toolbar([],{label:"Note formatting",floating:"editing"}),list:elWithAttributes("div",null,"ui-select-list rn-field-list",{id:"rn-field-options",role:"listbox","aria-label":"Design fields","data-completion":"",hidden:""}),
      bar:el("div",null,"rn-more"),url:kit.field({type:"url",label:"Link URL",placeholder:"https://"}),rows:[],choice:0,range:null};
    session=s;const {signal}=s.abort;
    s.root.contentEditable="true";s.root.setAttribute("role","textbox");s.root.setAttribute("aria-multiline","true");s.root.setAttribute("aria-label","Engineering note");
    s.root.spellcheck=true;s.root.setAttribute("aria-autocomplete","list");s.root.setAttribute("aria-controls",s.list.id);
    s.url.dataset.fieldFace="paper";s.url.hidden=s.bar.hidden=true;s.tools.classList.add("rn-tools");toolset(s,kit);
    document.body.append(s.root,s.tools,s.list);for(const b of item.richText.blocks)s.root.append(blockNode(b));s.initial=JSON.stringify(readBody(s));
    function input(e){if(e.isComposing)return;shortcuts(s);suggestions(s);position(s,false);}
    s.root.addEventListener("beforeinput",e=>{
      if(e.inputType!=="insertParagraph" || e.isComposing)return;
      const r=selection(s),b=r && blockOf(r.startContainer,s);if(!b)return;
      e.preventDefault();r.deleteContents();
      const tail=r.cloneRange();tail.setEnd(b,b.childNodes.length);
      const next=blockNode({style:["bullet","number","check"].includes(b.dataset.style)?b.dataset.style:"paragraph",runs:[]});
      const content=tail.extractContents();if(content.textContent || content.querySelector("[data-expression],[data-tex]")) {next.querySelector("br")?.remove();next.append(content);}
      if(!b.textContent && !b.querySelector("br"))b.append(el("br"));
      b.after(next);const anchor=next.querySelector(":scope > .rn-marker");
      r.selectNodeContents(next);r.collapse(true);if(anchor){r.setStartAfter(anchor);r.collapse(true);}
      const sel=globalThis.getSelection?.();sel.removeAllRanges();sel.addRange(r);s.range=r.cloneRange();position(s,false);
    },{signal});
    s.root.addEventListener("input",input,{signal});s.root.addEventListener("compositionend",input,{signal});
    const rememberText=()=>{if(!globalThis.AtriumLabs?.butterEnabled("visualHistory"))return;const text=globalThis.getSelection?.()?.toString();if(text)globalThis.AtriumLazy?.need("AtriumClipHistory").then(h=>h.recordText(text,{source:s.doc?.name}),()=>{});};
    s.root.addEventListener("copy",rememberText,{signal});s.root.addEventListener("cut",rememberText,{signal});
    s.root.addEventListener("paste",e=>{e.preventDefault();document.execCommand("insertText",false,e.clipboardData?.getData("text/plain") || "");},{signal});
    s.root.addEventListener("keydown",e=>{
      if(!s.list.hidden && s.rows.length && ["ArrowUp","ArrowDown","Enter","Tab","Escape"].includes(e.key)) {
        e.preventDefault();e.stopPropagation();
        if(e.key==="Escape"){hideSuggestions(s);return;}
        if(e.key==="Enter"||e.key==="Tab"){s.pick(s.choice);return;}
        s.choice=(s.choice+(e.key==="ArrowDown"?1:-1)+s.rows.length)%s.rows.length;
        s.root.setAttribute("aria-activedescendant","rn-field-"+s.choice);
        Array.from(s.list.children).forEach((b,i)=>b.setAttribute("aria-selected",i===s.choice?"true":"false"));return;
      }
      if(e.key==="Escape" || (e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();e.stopPropagation();close(e.key!=="Escape");}
    },{signal});
    document.addEventListener("selectionchange",()=>selectFormat(s),{signal});
    document.addEventListener("pointerdown",e=>{if(!s.root.contains(e.target)&&!s.list.contains(e.target)&&!s.tools.contains(e.target))close(true);},{capture:true,signal});
    globalThis.visualViewport?.addEventListener("resize",()=>position(s),{signal});
    globalThis.visualViewport?.addEventListener("scroll",()=>position(s),{signal});
    globalThis.addEventListener("resize",()=>position(s),{signal});const release=["change","document","replace","panes"].map(t=>host.on?.(t,()=>position(s,false)));s.unsub=()=>release.forEach(fn=>fn?.());
    position(s);s.root.focus({preventScroll:true});endAt(s.root.lastElementChild);return true;
  }
  return Object.freeze({open,close,current:()=>session?.item || null});
})();
