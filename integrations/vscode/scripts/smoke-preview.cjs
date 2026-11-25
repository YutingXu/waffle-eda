"use strict";
// Run a packaged webview with an isolated Chromium profile. The inputs are the
// extracted VSIX extension/ directory and a saved native project manifest.
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const Module = require("node:module");
const {chromium} = require("playwright-core");
const [extensionArg, manifestArg, serverPath] = process.argv.slice(2);
if (!extensionArg || !manifestArg || !process.env.CHROME) throw Error("Pass the extracted extension directory and native manifest, and set CHROME.");
const extension = fs.realpathSync(extensionArg), manifest = fs.realpathSync(manifestArg);
const media = path.join(extension,"media");
const uri = fsPath => ({fsPath,path:fsPath,scheme:"file",toString:()=>fsPath});
const noop = () => ({dispose() {}});
let provider, markdown = "";
const commands = new Map(), checked = new Map(), messages = [], errors = [];
const documentFor = file => ({uri:uri(file),getText:()=>fs.readFileSync(file,"utf8"),positionAt:n=>n,isDirty:false});
const doc = documentFor(manifest);
const vscode = {
  RelativePattern:class {},
  Uri:{file:uri,joinPath:(base,name)=>uri(path.join(base.fsPath,name))},
  DiagnosticSeverity:{Error:0,Warning:1,Information:2},ProgressLocation:{Notification:1},ViewColumn:{Beside:2},
  Range:class {constructor(start,end){Object.assign(this,{start,end});}},
  Diagnostic:class {constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
  window:{
    activeTextEditor:{document:doc},createOutputChannel:()=>({appendLine() {}}),
    registerCustomEditorProvider:(_name,p)=>{provider=p;return noop();},
    showErrorMessage:message=>errors.push(message),showInformationMessage:message=>{messages.push(message);},
    showTextDocument:noop,showQuickPick:async picks=>picks.find(p=>p.tool === "generate_bom"),
    withProgress:(_options,fn)=>fn({report(){}},{isCancellationRequested:false,onCancellationRequested:noop})
  },
  commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return noop();}},
  languages:{createDiagnosticCollection:()=>({set:(uri,values)=>checked.set(uri.fsPath,values),get:uri=>checked.get(uri.fsPath)})},
  workspace:{isTrusted:true,textDocuments:[],getConfiguration:()=>({get:(key,fallback)=>key==="serverPath" ? serverPath : fallback}),
    createFileSystemWatcher:()=>({onDidCreate:noop,onDidChange:noop,onDidDelete:noop,dispose(){}}),
    openTextDocument:async input=>{if(input.language==="markdown"){markdown=input.content;return input;}return documentFor(input.fsPath);},
    onDidChangeTextDocument:noop,onDidOpenTextDocument:noop,onDidCloseTextDocument:noop,onDidChangeConfiguration:noop}
};
const original = Module._load;
const child = require("node:child_process"), gitCommands = [];
Module._load = function(name,...args) {
  if (name === "vscode") return vscode;
  if (name === "child_process") return {...child, execFile(command, argv, ...rest) {
    if (command === "git") gitCommands.push(argv);
    return child.execFile(command,argv,...rest);
  }};
  return original.call(this,name,...args);
};
const ext = require(path.join(extension,"extension.js"));
Module._load = original;
ext.activate({extensionPath:extension,extensionUri:uri(extension),subscriptions:[]});

(async()=>{
  if (serverPath) {
    await commands.get("waffle.runDrc")(doc.uri);
    await commands.get("waffle.runErc")(doc.uri);
    await commands.get("waffle.compareWithHead")(doc.uri);
    assert.deepEqual(errors,[]);
    assert.ok([...checked.keys()].some(f=>f.endsWith(".wpcb")) && [...checked.keys()].some(f=>f.endsWith(".wsch")));
    assert.ok(messages.some(v=>v.startsWith("Waffle DRC")) && messages.some(v=>v.startsWith("Waffle ERC")));
    assert.ok(markdown.includes("Waffle") || markdown.includes("HEAD"));
    const blobs = gitCommands.filter(args=>args[0] === "cat-file").map(args=>args[2]);
    assert.ok(blobs.length > 2 && blobs.every(id=>/^[a-f0-9]{40,64}:/.test(id)));
    assert.equal(new Set(blobs.map(id=>id.split(":")[0])).size,1);
    console.log("Saved-folder CLI checks mapped to native owners and Git HEAD comparison produced Markdown.");
    if (process.argv.includes("--outputs")) {
      await commands.get("waffle.generateOutputs")(doc.uri);
      assert.deepEqual(errors,[]);
      assert.ok(messages.some(value=>value.includes("Bill of materials written")));
      console.log("Generated a BOM from the saved native folder.");
    }
  }
  let html, ready, posted;
  const server = http.createServer((request,response)=>{
    if (request.url === "/") {response.setHeader("Content-Type","text/html");response.end(html);return;}
    const relative = decodeURIComponent(request.url.slice(1));
    const file = path.resolve(media,relative);
    if (!file.startsWith(media+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {response.writeHead(404).end();return;}
    response.setHeader("Content-Type",file.endsWith(".js") ? "text/javascript" : "text/css");
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin = "http://127.0.0.1:"+server.address().port;
  const webview = {cspSource:origin,asWebviewUri:resource=>origin+"/"+path.relative(media,resource.fsPath).split(path.sep).join("/"),
    onDidReceiveMessage(f){ready=f;return noop();},postMessage(value){posted=value;}};
  let browser;
  try {
    provider.resolveCustomTextEditor(doc,{webview,onDidChangeViewState:noop,onDidDispose:noop,active:true});
    html=webview.html;
    browser=await chromium.launch({executablePath:process.env.CHROME,headless:true});
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.exposeFunction("sendToExtension",m=>{if(m.type==="ready")ready(m);});
    await page.addInitScript(()=>{globalThis.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage:m=>globalThis.sendToExtension(m)});});
    await page.goto(origin);
    await page.waitForFunction(()=>globalThis.AtriumCanvas);
    assert.match(await page.evaluate(()=>Atrium.id()),/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(await page.evaluate(()=>globalThis.AtriumStrokeFont?.glyphs?.has("A")),"the packaged browser loads the PCB stroke font");
    assert.ok(await page.evaluate(()=>typeof globalThis.AtriumPCBNetLabels?.draw === "function"),"the packaged browser loads PCB net captions");
    assert.equal(posted?.type,"project",posted?.message);
    const documents = posted.project.documents.filter(d=>["schematic","pcb"].includes(d.kind));
    assert.ok(documents.length>=2);
    // The Query proof control board has just two tracks. Use the real webview
    // camera to reach its wider track, and observe text drawn on the canvas.
    const captionTrack = documents.find(doc=>doc.id==="control" && doc.kind==="pcb")?.items.find(item=>item.id==="other-wide" && item.net==="Rail");
    if (captionTrack) await page.evaluate(()=>{
      const create = AtriumCanvas.create;
      AtriumCanvas.create = canvas => {
        AtriumCanvas.create = create;
        globalThis.previewView = create(canvas);
        globalThis.captionText = [];
        const ctx = canvas.getContext("2d"), fillText = ctx.fillText;
        ctx.fillText = function(text,...args) {
          globalThis.captionText.push(text);
          return fillText.call(this,text,...args);
        };
        return globalThis.previewView;
      };
    });
    await page.evaluate(data=>window.dispatchEvent(new MessageEvent("message",{data})),posted);
    await page.waitForFunction(ids=>{
      const options = [...document.querySelector("#doc").options].map(row=>row.value);
      return ids.every(id=>options.includes(id));
    },documents.map(doc=>doc.id));
    for (const doc of documents) {
      await page.selectOption("#doc",doc.id);
      const result=await page.evaluate(async()=>{
        await new Promise(resolve=>requestAnimationFrame(resolve));
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const canvas=document.querySelector("canvas"),ctx=canvas.getContext("2d"),data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const colors=new Set();for(let i=0;i<data.length;i+=16)colors.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);
        return {status:document.querySelector("#status").textContent,colors:colors.size};
      });
      assert.ok(result.colors>5 && result.status.includes("objects"),JSON.stringify(result));
      console.log(doc.kind+" "+result.status+", "+result.colors+" sampled colors");
    }
    if (captionTrack) {
      await page.selectOption("#doc","control");
      const {x,y} = await page.evaluate(points=>{
        const [a,b] = points, midpoint = [(a[0]+b[0])/2,(a[1]+b[1])/2];
        const view = globalThis.previewView.internals();
        const [x,y] = view.worldToScreen(midpoint), rect = view.canvas.getBoundingClientRect();
        globalThis.captionText.length = 0;
        return {x:x+rect.left,y:y+rect.top};
      },captionTrack.points);
      await page.mouse.move(x,y);
      await page.mouse.wheel(0,-1200);
      await page.waitForFunction(net=>globalThis.captionText.includes(net),captionTrack.net);
      console.log("pcb track caption “"+captionTrack.net+"” painted after zooming in");
    }
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));ext.deactivate();}
})().catch(error=>{console.error(error);process.exitCode=1;});
