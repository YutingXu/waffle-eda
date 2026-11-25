"use strict";
const assert = require("node:assert/strict");
const {shelf} = require("../project/folder-drafts.cjs");
for (const name of ["source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "format-2-closure","import-sidecars","project-archive","browser-project","folder-project-engine","folder-project"]) {
  require(require("./app-source-paths.cjs").appFile(name + ".js"));
}

module.exports = async function folderAutosave(AS, fakeHost, design, fakeStorage, now) {
  const stored = AtriumFormat2Model.fromEditor(design, {manifestPath:"Board.waffle"});
  const files = new Map(stored.files.map(row => [row.path,AtriumFormat2.serialize(row.file)]));
  const store = shelf(), sessions = [];
  const scopes = process.argv.includes("--macos-folders") ?
    require("./macos-draft-scopes.cjs")(stored.manifestPath,files) : ["directory-A","directory-B"];
  const temporary = () => AtriumBrowserProject.create(stored.manifestPath, files);
  async function open(scope) {
    const folder = temporary();
    if (scope !== undefined) Object.assign(folder,{name:"Board",draftScope:scope,temporary:false});
    const restored = [];
    const session = await AtriumFolderProject.open(folder,{
      host:folder.host, draftStore:store,
      workerFactory() {
        const engine = AtriumFolderProjectEngine.create();
        return {run:(op,fields,read,readBatch) => engine.run({op,...fields,read,readBatch}),close() {}};
      },
      restoreDraft(value) { restored.push(value); return value.separate ? null : true; }
    });
    sessions.push(session);
    return {session, restored};
  }
  function edit(session,text) {
    const doc = session.project.documents[0], item = doc.items[0];
    item.text = text;
    session.record([{id:doc.id,kind:doc.kind,put:[item]}]);
  }
  const options = {indexedDB:null,localStorage:fakeStorage(),now,serializer:null,schedule() {}};
  try {
    const one = (await open(scopes[0])).session, two = (await open(scopes[1])).session;
    assert.equal(one.project.id,two.project.id);
    assert.deepEqual(one.project.documents.map(d=>d.id),two.project.documents.map(d=>d.id));
    const host = fakeHost(one.project), AS1 = AS.create(options);
    let current = one;
    host.folderProject = () => current;
    AS1.attach(host);
    edit(one,"First draft");
    edit(two,"Second draft");
    let release, entered;
    const writing = new Promise(resolve=>{entered=resolve;}), gate = new Promise(resolve=>{release=resolve;});
    const write = store.write.bind(store);
    store.write = async (...args) => {
      if (JSON.parse(args[0])[0] === scopes[0]) { entered(); await gate; }
      return write(...args);
    };
    const earlier = AS1.flush();
    await writing;
    current = two; host.p = two.project;
    await AS1.flush();
    release(); await earlier;
    store.write = write;
    assert.equal(store.data.size,2);
    assert.deepEqual(await AS1.list(), [], "folder projections stay out of whole-project recovery");

    const againA = await open(scopes[0]), againB = await open(scopes[1]), browser = await open();
    assert.deepEqual(await browser.session.listDrafts(), [], "a temporary ZIP cannot claim a disk folder's draft");
    const [a] = await againA.session.listDrafts(), [b] = await againB.session.listDrafts();
    assert.ok(a && b);
    assert.notEqual(a.head.scope,b.head.scope);
    assert.equal(a.state,"matches"); assert.equal(b.state,"matches");
    await assert.rejects(againB.session.resolveDraft(a,"discard"), /belongs to another project/);
    await againA.session.resolveDraft(a,"keep");
    assert.equal(store.data.size,2);
    await againA.session.resolveDraft(a,"separate");
    const recovered = againA.restored[0];
    assert.ok(recovered.separate && recovered.copy.project !== againA.session.project);
    assert.equal(recovered.bundle.rows[0].owner.items[0].text, "First draft");
    assert.equal(againA.session.project.documents[0].items[0].text, "A");
    await againB.session.resolveDraft(b,"restore");
    assert.equal(againB.restored[0].bundle.rows[0].owner.items[0].text, "Second draft");
    await againA.session.resolveDraft(a,"discard");
    assert.deepEqual(await againA.session.listDrafts(),[]);
    assert.equal((await againB.session.listDrafts())[0].head.stamp,b.head.stamp);

    // Save As can adopt a native session while the whole-project serializer is loading.
    // A native session initially holds only the active owner, even if more are on disk.
    let ready;
    const loading = new Promise(resolve=>{ready=resolve;});
    const trans = AS.create({...options,serializer:loading});
    const unsaved = fakeHost(design);
    let adopted;
    unsaved.folderProject = () => adopted;
    trans.attach(unsaved);
    const pending = trans.flush();
    edit(browser.session,"Temporary draft");
    adopted = browser.session; unsaved.p = adopted.project;
    ready(null); await pending;
    assert.deepEqual(await trans.list(), [], "a folder adopted during serialization must never become a partial whole-project snapshot");
    const reopenedTemporary = await open();
    const [temporaryOffer] = await reopenedTemporary.session.listDrafts();
    assert.ok(temporaryOffer, "the in-flight flush reached the adopted session's private draft");
    assert.notEqual(temporaryOffer.head.scope,b.head.scope);
    assert.equal((await againB.session.listDrafts())[0].head.stamp,b.head.stamp);

    // The folder shelf is independent of the unsaved-project fallback.
    const noFallback = AS.create({...options,indexedDB:null,localStorage:null});
    noFallback.attach(host);
    edit(two,"Second update");
    await noFallback.flush();
    const [latest] = await againB.session.listDrafts();
    await againB.session.resolveDraft(latest,"separate");
    assert.equal(againB.restored.at(-1).bundle.rows[0].owner.items[0].text,"Second update");
    assert.deepEqual(await noFallback.list(),[]);
  } finally {
    for (const session of sessions) await session.close();
  }
};
