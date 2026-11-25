"use strict";
globalThis.AtriumAI=(()=>{
  // Every proposal (version 1 component edits from mcp/server.py, version 2 guarded operations from the
  // headless MCP tools) is checked and applied by AtriumProposal: the same checked path AtriumAPI.settle uses.
  const P=()=>globalThis.AtriumProposal||(()=>{throw Error("Proposals are unavailable in this build.");})();
  const v2=proposal=>proposal?.format==="atrium-ai"&&proposal.version===2;
  const editorDrafts=new WeakMap();
  const stale=()=>Object.assign(Error("The project or AI permission changed. Generate a fresh proposal."),{code:"stale_source"});
  function editorDraft(proposal,project){
    const draft=editorDrafts.get(proposal);
    if(!draft||draft.project!==project||!draft.current())throw stale();
    return draft;
  }
  function freeze(value){
    if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
    return value;
  }
  function bindEditorProposal(proposal,{host,project,revision,documentId,folder,current,savedDigest}){
    if(!current?.()||host.revision()!==revision||proposal.ops.some(op=>op.document!==documentId))throw stale();
    P().inspect(proposal,project,0);
    proposal.editor_source={projectId:project.id,documentId,revision};
    proposal.source_sha256=savedDigest??null;
    freeze(proposal);
    editorDrafts.set(proposal,{host,project,folder,current,savedDigest,reviewed:false});
  }
  function inspect(proposal,p){
    if(!proposal?.editor_source)return v2(proposal)?P().inspect(proposal,p):P().inspectV1(proposal,p);
    const draft=editorDraft(proposal,p), rows=P().inspect(proposal,p);
    draft.reviewed=true;
    return rows;
  }
  async function prepareFolderProposal(ctx,proposal){
    const session=ctx.folderProject,base=proposal.format2_base;
    if(!session&&!base)return;
    if(!session||!base||base.project_id!==ctx.project.id)throw Error("Open the saved project folder used to draft this proposal.");
    const version=await session.verifySavedVersion({purpose:"proposal"});
    if(version!==proposal.source_sha256)throw Error("The saved project changed. Generate a fresh proposal.");
    await session.requireClosure({purpose:"proposal",assets:false});
    if(ctx.currentProject&&ctx.currentProject()!==ctx.project)throw Error("The open project changed. Review the proposal again.");
  }
  function requireWholeProposal(proposal,select){
    if(select===undefined)return;
    const selected=new Set(select);
    if(proposal.ops.some((_,index)=>!selected.has(index)))
      throw Error("Apply this proposal as one change to keep the connected wires intact.");
  }
  async function applyEditorProposal(proposal,project,select){
    const draft=editorDraft(proposal,project);
    if(!draft.reviewed)throw Error("Review the proposal before applying it.");
    requireWholeProposal(proposal,select);
    if(draft.savedDigest!==null){
      const digest=await draft.folder.verifySavedVersion({purpose:"proposal"}).catch(()=>null);
      if(digest!==draft.savedDigest)throw stale();
    }
    editorDraft(proposal,project);
    const prepared=P().prepare(project,proposal,Atrium.validate);
    const count=prepared.apply((change,touched,scope)=>draft.host.edit(change,"Apply AI Proposal",touched,scope));
    if(count)editorDrafts.delete(proposal);
    return count?proposal.ops.length:0;
  }
  function apply(ctx,proposal,select){
    if(proposal?.editor_source)return applyEditorProposal(proposal,ctx.project,select);
    if(v2(proposal)&&proposal.summary?.command==="butter.ai.draft"&&proposal.ops?.some(op=>op.path?.[0]==="points"))
      requireWholeProposal(proposal,select);
    // Validate on a copy first so a proposal can never leave an unopenable project.
    if(ctx.currentProject&&ctx.currentProject()!==ctx.project)throw Error("The open project changed. Review the proposal again.");
    return P().applyChecked(ctx.project,proposal,{select,validate:Atrium.validate,edit:(fn,label,touched,scope)=>ctx.edit(fn,label,touched,scope),
      transform:(d,i,props)=>Atrium.transformPart(d,i,ctx.defs.get(i.def),props,undefined,{defs:ctx.defs})});
  }
  // One-click MCP setup: the configuration each MCP client expects, where it lives, and how
  // to add it. Waffle never edits another app's files: it copies the text and says where it goes.
  const quote=a=>/^[\w@%+=:,./-]+$/.test(a)?a:"'"+String(a).replace(/'/g,"'\\''")+"'";
  function platform(){const p=(globalThis.navigator?.platform||"")+" "+(globalThis.navigator?.userAgent||"");return /Mac/i.test(p)?"mac":/Win/i.test(p)?"windows":"linux";}
  const serverArgs=(script,path,access)=>[script,"--project",path,...(access==="read"?["--read-only"]:access==="write"?["--allow-write"]:[])];
  function clients({serverPath,projectPath,os=platform(),access="proposal"}){
    const project=projectPath||"/absolute/path/to/Design.waffle",args=serverArgs(serverPath,project,access);
    const entry={command:"python3",args},json=o=>JSON.stringify(o,null,2),mcp={mcpServers:{"waffle-eda":entry}};
    const desktop={mac:"~/Library/Application Support/Claude/claude_desktop_config.json",windows:"%APPDATA%\\Claude\\claude_desktop_config.json",linux:"~/.config/Claude/claude_desktop_config.json"}[os];
    const folder=projectPath?projectPath.replace(/[\\/][^\\/]*$/,""):"<project folder>";
    return [
      {id:"claude-desktop",name:"Claude Desktop",file:desktop,text:json(mcp),
        steps:["In Claude Desktop open Settings › Developer › Edit Config (it opens "+desktop+").","Add the \"waffle-eda\" entry under \"mcpServers\", keeping any servers already there, and save.","Quit and reopen Claude Desktop."],
        note:os==="linux"?"Claude Desktop has no official Linux build; this path is used by community builds.":""},
      {id:"claude-code",name:"Claude Code",file:"Terminal (or .mcp.json in "+folder+")",text:"claude mcp add waffle-eda -- "+["python3",...args].map(quote).join(" "),
        steps:["Run this command in a terminal. It adds Waffle EDA for you in the current folder.","To share it with everyone working on the project, add --scope project: Claude Code then writes .mcp.json in that folder.","Check with: claude mcp list"],
        alternate:{label:".mcp.json",text:json(mcp)}},
      {id:"cursor",name:"Cursor",file:"~/.cursor/mcp.json (all projects) or .cursor/mcp.json in the project folder",text:json(mcp),
        steps:["Open Cursor Settings › MCP › Add new global MCP server (it opens ~/.cursor/mcp.json).","Add the \"waffle-eda\" entry under \"mcpServers\" and save. Cursor reloads it."]},
      {id:"vscode",name:"VS Code",file:".vscode/mcp.json in the workspace folder",text:json({servers:{"waffle-eda":{type:"stdio",...entry}}}),
        steps:["Create or open .vscode/mcp.json in the workspace (or run MCP: Add Server… from the Command Palette).","Add the \"waffle-eda\" entry under \"servers\" and save, then start it from the file's Start button.","Use it from Copilot Chat in Agent mode."]},
      {id:"codex",name:"OpenAI Codex",file:"~/.codex/config.toml",text:"[mcp_servers.waffle-eda]\ncommand = \"python3\"\nargs = ["+args.map(a=>JSON.stringify(a)).join(", ")+"]\n",
        steps:["Add this table to ~/.codex/config.toml (the Codex CLI and IDE extension share it), or run: codex mcp add waffle-eda -- "+["python3",...args].map(quote).join(" "),"Restart Codex."],
        note:"Check the Codex docs if your version reads MCP servers from somewhere else; the format has changed between releases."},
      {id:"chatgpt",name:"ChatGPT desktop",file:"Not a local file",text:["python3",...args].map(quote).join(" "),
        steps:["ChatGPT adds MCP servers as connectors in developer mode (Settings › Connectors), and those are remote servers reached over HTTPS.","Waffle's server runs locally over stdio, so ChatGPT cannot start it directly. Use Codex (above), or put the server behind an MCP stdio-to-HTTP bridge you trust."],
        note:"Uncertain: OpenAI's support for local MCP servers in the ChatGPT apps is changing; check the current ChatGPT help pages."}
    ];
  }
  function open(ctx){
    const mk=(tag,t,cl)=>AtriumNavCommon.el(tag, t, cl);
    const dlg=mk("dialog",null,"work-dialog"),title=mk("h2","AI integration"),content=mk("div"),body=mk("div",null,"work-list"),msg=mk("p"),footer=mk("div",null,"work-actions");
    const button=(text,run,variant="secondary")=>{const b=mk("button",text,"ui-button");b.type="button";b.dataset.variant=variant;b.onclick=run;return b;};
    const close=button("Close",()=>dlg.close());msg.setAttribute("role","alert");content.append(body,msg);dlg.append(title,content,footer);
    dlg.onclose=()=>dlg.remove();
    body.append(mk("p","Connect an MCP client to a saved project to inspect components and nets, check connectivity, or explain Altium rules. Review proposed edits here."));
    let pythonScript="/absolute/path/to/Waffle/mcp/server.py";
    if(globalThis.location?.protocol==="file:"){try{pythonScript=decodeURIComponent(new URL("../mcp/server.py",location.href).pathname);}catch{}}
    pythonScript=globalThis.AtriumHost?.mcpServerPath||pythonScript;
    const access=mk("select",null,"ui-field");access.setAttribute("aria-label","Saved project access");
    for(const [v,t] of [["read","Read only"],["proposal","Propose changes for review"],["write","Allow writes to this saved project"]])access.add(new Option(t,v));
    const configuration=path=>JSON.stringify({mcpServers:{"waffle-eda":{command:"python3",args:serverArgs(pythonScript,path||"/absolute/path/to/Design.waffle",access.value)}}},null,2);
    const card=mk("div"), details=mk("details",null,"connection-card"), label=mk("label","Saved project ","ui-field-row");
    const input=mk("input",null,"ui-field"), output=mk("pre"), copy=mk("button","Copy configuration","ui-button"), status=mk("span");
    input.type="text";input.value=globalThis.AtriumHost?.projectPath||"";input.placeholder="/path/to/Design.waffle";
    input.spellcheck=false;input.autocomplete="off";input.setAttribute("data-project-path","");
    output.setAttribute("data-config-preview","");copy.type="button";copy.setAttribute("data-copy-config","");
    status.setAttribute("data-copy-status","");status.setAttribute("role","status");
    label.append(input);details.append(mk("summary","Client configuration"),label,output,copy,status);card.append(details);
    const accessLabel=mk("label","Saved project access ","ui-field-row");accessLabel.append(access);body.append(accessLabel,card);
    function update(){
      const path=input.value.trim();output.textContent=configuration(path);copy.disabled=!/^(?:\/|[A-Za-z]:[\\/]|\\\\).+\.(?:waffle|atrium)$/i.test(path);
      status.textContent=path&&copy.disabled?"Enter the absolute path to a saved .waffle project.":"";
    }
    const setup=mk("details",null,"connection-card mcp-setup"),pick=mk("select",null,"ui-field"),where=mk("p",null,"side-note"),steps=mk("ol",null,"side-note"),pre=mk("pre"),note=mk("p",null,"side-note"),row=mk("div",null,"ui-dialog-actions"),said=mk("span");
    setup.open=true;setup.append(mk("summary","Set up an AI client"),pick,where,steps,pre,note,row);pick.setAttribute("aria-label","MCP client");
    let list=[],alt=false;
    const copyText=async text=>{try{if(!navigator.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(text);return true;}catch{const t=mk("textarea");t.value=text;document.body.append(t);t.select();let ok=false;try{ok=document.execCommand?.("copy")===true;}catch{}t.remove();return ok;}};
    const copyBtn=button("Copy",async()=>{said.textContent=await copyText(pre.textContent)?"Copied. Paste it where shown above.":"Select the text and copy it.";});
    const altBtn=button("",()=>{alt=!alt;show();});
    row.append(said,altBtn,copyBtn);
    function show(){
      const c=list.find(x=>x.id===pick.value)||list[0];if(!c)return;
      where.textContent="Goes in: "+(alt&&c.alternate?c.alternate.label+" in the project folder":c.file);
      steps.replaceChildren(...c.steps.map(t=>mk("li",t)));pre.textContent=alt&&c.alternate?c.alternate.text:c.text;
      note.textContent=c.note||"Waffle does not edit other apps' settings: copy this and add it yourself.";
      altBtn.hidden=!c.alternate;altBtn.textContent=alt?"Show command":"Show "+(c.alternate?.label||"");said.textContent="";
    }
    pick.onchange=()=>{alt=false;show();};
    function refreshClients(){const keep=pick.value;list=clients({serverPath:pythonScript,access:access.value,projectPath:/^(?:\/|[A-Za-z]:\\|\\\\).+\.(?:waffle|atrium)$/i.test(input.value.trim())?input.value.trim():""});
      if(!pick.options.length)for(const c of list)pick.add(new Option(c.name,c.id));pick.value=keep||list[0].id;show();}
    body.append(setup,mk("p","To chat with Claude, ChatGPT or a local model inside Waffle, open Tools › AI Assistant.","side-note"));
    input.addEventListener("input",refreshClients);
    access.onchange=()=>{update();refreshClients();};
    input.oninput=update;update();refreshClients();
    copy.onclick=async()=>{
      if(copy.disabled)return;
      try{if(!globalThis.navigator?.clipboard?.writeText)throw Error();await navigator.clipboard.writeText(output.textContent);status.textContent="Copied";}
      catch{
        const selection=window.getSelection?.();if(selection && document.createRange){const range=document.createRange();range.selectNodeContents(output);selection.removeAllRanges();selection.addRange(range);}
        let copied=false;try{copied=document.execCommand?.("copy")===true;}catch{}
        status.textContent=copied?"Copied":"Select the configuration and use Copy.";
      }
    };
    const review=button("Review proposal…",async()=>{try{
      const f=await ctx.pickFile([".waffle-ai"]);if(!f)return;const proposal=JSON.parse(await f.text());
      if(ctx.currentProject&&ctx.currentProject()!==ctx.project)throw Error("The open project changed. Open the proposal again.");
      await prepareFolderProposal(ctx,proposal);
      if(!dlg.open)return;
      const second=v2(proposal),size=100,first=second?P().inspect(proposal,ctx.project,size):inspect(proposal,ctx.project);
      const total=second?proposal.ops.length:first.length,excluded=new Set();let offset=0;
      body.replaceChildren();title.textContent="Review proposed edits";msg.textContent="";
      if(second&&proposal.summary)body.append(mk("p",typeof proposal.summary==="string"?proposal.summary:proposal.tool||"Proposed edits","side-note"));
      const list=mk("div"),status=mk("p",null,"side-note");status.setAttribute("role","status");
      const previous=button("Previous changes",()=>page(offset-size)),next=button("Next changes",()=>page(offset+size));
      body.append(list,status);
      if(total>size)body.append(previous,next);
      const applyButton=button("Apply selected",async()=>{try{
        const selected=second?proposal.ops.map((_,i)=>i).filter(i=>!excluded.has(i)):first.filter((_,i)=>!excluded.has(i)).map(x=>x.row);
        if(!selected.length)return;
        applyButton.disabled=true;
        if(ctx.folderProject||proposal.format2_base)await prepareFolderProposal(ctx,proposal);
        const count=await (second?apply(ctx,proposal,selected):apply(ctx,{...proposal,changes:selected}));
        if(!count){msg.textContent="The edit was blocked. Check the document's edit lock and revision, then try again.";return;}
        dlg.close();ctx.info(count+" proposed edits applied");
      }catch(e){msg.textContent=e.message;}finally{if(dlg.open)summary();}},"primary");
      applyButton.dataset.uiDefault="false";
      function page(start){
        try{
          const rows=!start?first:second?P().inspect(proposal,ctx.project,size,start):first.slice(start,start+size);
          offset=start;list.replaceChildren();previous.disabled=!offset;next.disabled=offset+size>=total;
          rows.forEach((r,n)=>{
            const index=start+n,l=mk("label",null,"work-row"),cb=mk("input",null,"ui-checkbox");cb.type="checkbox";cb.checked=!excluded.has(index);
            cb.onchange=()=>{if(cb.checked)excluded.delete(index);else excluded.add(index);summary();};
            const line=mk("span",second?r.label:r.i.ref+" · "+r.row.field);
            line.append(mk("small",second?r.detail:r.d.name+"   "+r.row.before+" → "+r.row.after));l.append(cb,line);list.append(l);
          });
          summary();
        }catch(e){msg.textContent=e.message;applyButton.disabled=true;}
      }
      function summary(){status.textContent=(offset+1)+"–"+Math.min(offset+size,total)+" of "+total+" changes · "+(total-excluded.size)+" selected";applyButton.disabled=excluded.size===total;}
      footer.replaceChildren(close,applyButton);page(0);
      AtriumShell.adoptDialog(dlg,{actions:footer});
      (list.querySelector("input")||close).focus({preventScroll:true});
    }catch(e){msg.textContent=e.message;}},"primary");
    review.dataset.uiDefault="false";
    footer.append(close,review);
    AtriumShell.adoptDialog(dlg,{title,body:content,actions:footer,initialFocus:access});
    document.body.append(dlg);dlg.showModal();
  }
  return {open,inspect,apply,clients,prepareFolderProposal,bindEditorProposal};
})();
