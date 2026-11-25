"use strict";
// Two ordinary native 2.0 sheet members. The production browser host implements
// the same lease, hash and commit protocol without touching an on-disk project.
for (const name of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values",
  "format-2-model", "format-2-closure", "import-sidecars", "project-archive", "browser-project",
  "folder-project-engine", "folder-project"]) require(require("./app-source-paths.cjs").appFile(name + ".js"));

const F = AtriumFormat2;
const files = (kind,id,rows,other = {}) => F.serialize(F.create({kind,formatVersion:"2.0",id,...other},rows));
async function open({name = "Sensor", draftStore, beforeCommit} = {}) {
  const manifest = name + ".waffle";
  const members = ["Power","Control"].map(id=>({id,kind:"document",docKind:"schematic",name:id,path:id+".wsch"}));
  const originals = new Map([[manifest,files("project","p",members,{name,entryDocument:"Power"})]]);
  for (const {id,path} of members)
    originals.set(path,files("schematic",id,[{kind:"netlabel",id:"n",at:[0,0],text:id}]));
  const folder = AtriumBrowserProject.create(manifest,originals);
  const commits = [];
  const host = {...folder.host,async folderCommit(request) {
    commits.push(request);
    await beforeCommit?.(request);
    return folder.host.folderCommit(request);
  }};
  const engine=AtriumFolderProjectEngine.create();
  const session=await AtriumFolderProject.open({...folder,draftScope:name},{
    host, draftStore, workerFactory:()=>({run:(op,m,read,readBatch)=>engine.run({op,...m,read,readBatch}),close(){}})
  });
  function edit(id,text) {
    const owner=session.project.documents.find(d=>d.id===id);
    const label=owner.items[0];
    label.text=text;
    session.record([{id,kind:"schematic",put:[JSON.stringify(label)]}]);
  }
  async function read(path) {
    const {lease}=await host.folderReadLease({grant:folder.grant});
    try { return (await host.folderRead({grant:folder.grant,lease,paths:[path]})).files[0].bytes; }
    finally { await host.folderRelease({grant:folder.grant,lease}); }
  }
  return {session,host,folder,originals,commits,edit,read};
}
module.exports = {open};
