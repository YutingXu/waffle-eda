"use strict";
// Waffle for VS Code: read-only preview of .waffle designs, DRC/ERC in the Problems panel,
// outputs through the Waffle MCP server's command line, schema validation and a semantic
// "compare with Git HEAD" summary.
//
// Plain CommonJS with no build step and no dependencies. Security posture:
//  - No network: nothing here opens a socket. The preview webview has a CSP with
//    default-src 'none' and loads only files bundled in media/.
//  - No telemetry, and no writes to VS Code settings or other applications' config files.
//    The only files written are the outputs the user asks for, by the Waffle CLI, which
//    confines them to <project>-outputs/.
//  - Commands that start processes (python3 + the Waffle server, git) need a trusted
//    workspace, and the server/python paths are restricted settings in untrusted ones.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const Folder = require("./lib/folder.js");
const positions = require("./lib/jsonpos.js");
const {execFile} = require("child_process");
const V = require("./lib/validate.js");
const P = require("./lib/problems.js");
const D = require("./lib/diff.js");

const MAX_VALIDATE = 64 * 1024 * 1024;
const isManifest = doc => doc?.uri && /\.waffle$/i.test(doc.uri.path);
const isNative = doc => !!Folder.kinds[path.extname(doc?.uri?.path || "").toLowerCase()];
let schema = null, output = null, validation = null, checks = null;

// --------------------------------------------------------------------------- helpers
const SEVERITY = () => ({error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information, info: vscode.DiagnosticSeverity.Information});
function diagnostics(doc, problems) {
  const sev = SEVERITY();
  return problems.map(p => {
    const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(Math.max(p.start, p.end))), p.message, sev[p.severity] ?? sev.error);
    d.source = p.source === "schema" || p.source === "json" || p.source === "waffle" ? "Waffle" : p.source;
    if (p.code) d.code = p.code;
    return d;
  });
}
function config() { return vscode.workspace.getConfiguration("waffle"); }
function log(line) { output.appendLine("[" + new Date().toLocaleTimeString() + "] " + line); }
function requireTrust() {
  if (vscode.workspace.isTrusted) return true;
  vscode.window.showWarningMessage("Waffle runs the design checks and outputs with Python and Git. Trust this workspace first (Manage Workspace Trust).");
  return false;
}

function openText(file) {
  return vscode.workspace.textDocuments.find(doc => doc.uri.scheme === "file" && doc.uri.fsPath === file && doc.isDirty)?.getText();
}
function currentProject(doc) {
  return Folder.fromDisk(doc.uri.fsPath, doc.getText(), openText).project;
}

// --------------------------------------------------------------------------- validation
const pending = new Map();
function scheduleValidation(doc, delay = 400) {
  if (!isNative(doc)) return;
  const key = doc.uri.toString();
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => { pending.delete(key); validateNow(doc); }, delay));
}
function problemRange(text, message) {
  const numbered = / at line (\d+)\./.exec(message);
  const ordered = message.includes("unique and sorted");
  if (!numbered && !ordered) return [0,1];
  let start = 0, previous;
  const seen = new Set();
  for (const [i,row] of text.split("\n").entries()) {
    if (numbered && i + 1 === Number(numbered[1])) return [start,start+Math.max(row.length,1)];
    if (ordered && row) {
      const id = JSON.parse(row).id;
      if (seen.has(id) || (i > 1 && Folder.core().codec.compare(previous,id) >= 0)) {
        const where = positions.at(positions.parse(row).root, ["id"]);
        return where ? [start+where.start,start+where.end] : [start,start+row.length];
      }
      seen.add(id); previous = id;
    }
    start += row.length + 1;
  }
  return [0,1];
}
function validateNow(doc) {
  if (doc.isClosed) return;
  if (!config().get("validation.enabled", true)) { validation.delete(doc.uri); return; }
  const text = doc.getText();
  if (text.length > MAX_VALIDATE) { validation.set(doc.uri, []); return; }
  const problems = [];
  try {
    const file = Folder.parse(text, doc.uri.path);
    if (file.header.kind === "project") Folder.core().model.manifest(file);
    if (schema && config().get("validation.schema", false)) {
      let at = 0;
      for (const row of text.split("\n")) {
        if (row) {
          const parsed = JSON.parse(row);
          const rowSchema = V.nativeRowSchema(schema, file, parsed, at === 0);
          for (const error of V.checkSchema(parsed, rowSchema)) {
            problems.push({start:at, end:at+row.length, severity:"error", source:"schema", message:error.message});
            if (problems.length >= 100) break;
          }
        }
        if (problems.length >= 100) break;
        at += row.length + 1;
      }
    }
  } catch (error) {
    const [start,end] = problemRange(text,error.message);
    problems.push({start,end,severity:"error",source:"waffle",message:error.message});
  }
  validation.set(doc.uri, diagnostics(doc, problems));
}

// --------------------------------------------------------------------------- the Waffle CLI
function serverPath() {
  const configured = config().get("serverPath", "");
  if (configured) return configured;
  const candidates = [];
  for (const f of vscode.workspace.workspaceFolders || []) candidates.push(path.join(f.uri.fsPath, "mcp", "server.py"));
  if (process.env.ATRIUM_HOME) candidates.push(path.join(process.env.ATRIUM_HOME, "mcp", "server.py"));
  candidates.push("/Applications/Waffle.app/Contents/Resources/mcp/server.py", path.join(require("os").homedir(), "Applications/Waffle.app/Contents/Resources/mcp/server.py"),
    "/usr/share/waffle/mcp/server.py");
  return candidates.find(c => fs.existsSync(c)) || null;
}
function runTool(file, tool, args, token) {
  const server = serverPath();
  if (!server) return Promise.reject(Error("The Waffle MCP server was not found. Install Waffle, or set waffle.serverPath to mcp/server.py."));
  const python = config().get("pythonPath", "python3") || "python3";
  const argv = [server, "--project", file, "--cli", tool, "--args", JSON.stringify(args || {})];
  log(python + " " + argv.map(a => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "));
  return new Promise((resolve, reject) => {
    const child = execFile(python, argv, {cwd: path.dirname(file), timeout: config().get("timeoutSeconds", 300) * 1000, maxBuffer: 256 * 1024 * 1024, windowsHide: true},
      (err, stdout, stderr) => {
        if (stderr) log(stderr.trim());
        if (err) return reject(Error((stderr || err.message).trim().split("\n").pop()));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error("The Waffle CLI returned something that is not JSON.")); }
      });
    token?.onCancellationRequested(() => child.kill());
  });
}
async function savedProject(uri) {
  let doc = vscode.window.activeTextEditor?.document || activePreview;
  try {
    if (uri?.scheme === "file") doc = await vscode.workspace.openTextDocument(vscode.Uri.file(Folder.selection(uri.fsPath)));
    if (/\.atrium$/i.test(doc?.uri?.path || "")) throw Error(Folder.core().obsolete.note);
    if (!isManifest(doc) || doc.uri.scheme !== "file") throw Error("Choose the .waffle manifest in the project folder.");
    Folder.manifest(doc.getText(), doc.uri.path);
    const dir = path.dirname(doc.uri.fsPath);
    const index = Folder.manifest(Folder.diskText(dir,path.basename(doc.uri.fsPath)), doc.uri.path);
    const names = new Set([doc.uri.fsPath,...index.members.map(r => path.join(dir,r.path))]);
    if (vscode.workspace.textDocuments.some(item => item.isDirty && names.has(item.uri.fsPath))) {
      const pick = await vscode.window.showWarningMessage("There are unsaved project records. This command reads the saved project.", "Run on saved project");
      if (!pick) return null;
    }
    return {doc,index};
  } catch (error) { vscode.window.showErrorMessage(error.message); return null; }
}

async function runDrc(uri) {
  if (!requireTrust()) return;
  const saved = await savedProject(uri);
  if (!saved) return;
  const {doc,index} = saved;
  const boards = index.members.filter(r => r.kind === "pcb");
  if (!boards.length) { vscode.window.showInformationMessage("This design has no board layout to check."); return; }
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Waffle: design rule check", cancellable: true}, async (progress, token) => {
    let total = 0;
    const byBoard = [];
    try {
      for (const ref of boards) {
        const board = ref.id, root = path.dirname(doc.uri.fsPath), savedText = Folder.diskText(root,ref.path);
        const owner = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,ref.path)));
        const text = owner.isDirty ? owner.getText() : savedText;
        let offset = 0, revision = null, found = [], count = 0;
        // At most 25 pages of 200 per board; the summary still reports the full total.
        for (let page = 0; page < 25 && offset != null; page++) {
          const r = await runTool(doc.uri.fsPath, "run_drc", {document_id: board, offset, limit: 200}, token);
          if (revision && r.file_revision !== revision) { offset = 0; found = []; revision = null; continue; } // the file changed between pages: start again
          if (!revision) count = r.total || 0;
          revision = r.file_revision;
          found.push(...P.fromDrc(r, text));
          offset = r.next_offset ?? null;
          progress.report({message: total + found.length + " of " + (total + count)});
        }
        byBoard.push([owner,found]); total += count;
      }
    } catch (e) { if (!token.isCancellationRequested) vscode.window.showErrorMessage("Waffle DRC: " + e.message); return; }
    for (const [owner, found] of byBoard) setChecks(owner, "Waffle DRC", found);
    vscode.window.showInformationMessage(total ? "Waffle DRC: " + total + " violation" + (total === 1 ? "" : "s") + " (see Problems)." : "Waffle DRC: no violations.");
  });
}
async function runErc(uri) {
  if (!requireTrust()) return;
  const saved = await savedProject(uri);
  if (!saved) return;
  const {doc,index} = saved;
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Waffle: electrical rule check", cancellable: true}, async (_progress, token) => {
    try {
      const result = await runTool(doc.uri.fsPath, "run_erc", {limit:500}, token);
      const dir = path.dirname(doc.uri.fsPath), byId = new Map(index.members.filter(r=>r.kind === "schematic").map(r=>[r.id,r]));
      const owners = new Set([...byId.keys(), null]);
      for (const id of owners) {
        const ref = byId.get(id);
        const savedText = Folder.diskText(dir,ref ? ref.path : path.basename(doc.uri.fsPath));
        const owner = ref ? await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir,ref.path))) : doc;
        const text = owner.isDirty ? owner.getText() : savedText;
        const classes = Object.fromEntries(Object.entries(result.classes || {}).map(([key,group])=>[key,
          {...group,items:(group.items || []).filter(item=> (byId.has(item.document_id) ? item.document_id : null) === id)}]));
        setChecks(owner, "Waffle ERC", P.fromErc({classes}, text));
      }
      vscode.window.showInformationMessage("Waffle ERC: " + (result.summary || (result.passed ? "passed" : "see Problems")) + ".");
    } catch (error) { if (!token.isCancellationRequested) vscode.window.showErrorMessage("Waffle ERC: " + error.message); }
  });
}

// DRC and ERC results share one collection; a new run replaces only its own source's entries.
function setChecks(doc, source, problems) {
  const kept = (checks.get(doc.uri) || []).filter(d => d.source !== source);
  checks.set(doc.uri, kept.concat(diagnostics(doc, problems)));
}

async function generateOutputs(uri) {
  if (!requireTrust()) return;
  const saved = await savedProject(uri);
  if (!saved) return;
  const file = saved.doc.uri.fsPath;
  const picks = [
    {label: "Fabrication outputs", description: "Gerber X2, Excellon drill, pick and place, assembly drawings, as one ZIP", tool: "generate_fabrication", args: {zip: true}},
    {label: "Bill of materials", description: "CSV, XLSX and HTML", tool: "generate_bom", args: {formats: ["csv", "xlsx", "html"]}},
    {label: "PDF", description: "Schematics and board layer sets", tool: "export_pdf", args: {}},
    {label: "Output job…", description: "A saved output job set or preset", tool: "run_output_job"}
  ];
  const pick = await vscode.window.showQuickPick(picks, {placeHolder: "Outputs are written to " + path.parse(file).name + "-outputs/ beside the design"});
  if (!pick) return;
  let args = pick.args;
  if (pick.tool === "run_output_job") {
    let jobs;
    try { jobs = await runTool(file, "run_output_job", {list: true}); } catch (e) { vscode.window.showErrorMessage("Waffle: " + e.message); return; }
    const names = [...(jobs.job_sets || []), ...(jobs.presets || [])].map(j => (typeof j === "string" ? j : j.name)).filter(Boolean);
    const job = await vscode.window.showQuickPick(names, {placeHolder: "Output job"});
    if (!job) return;
    args = {job};
  }
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Waffle: " + pick.label, cancellable: true}, async (progress, token) => {
    let r;
    try { r = await runTool(file, pick.tool, args, token); }
    catch (e) { if (!token.isCancellationRequested) vscode.window.showErrorMessage("Waffle: " + e.message); return; }
    // generate_fabrication with zip: {zip: {path}}; export_pdf: {path}; the rest: {files: [{path}]}.
    const files = (r.zip?.path ? [r.zip] : r.files || (r.path ? [r] : [])).map(f => f.path || f.name).filter(Boolean);
    for (const f of files) log("  wrote " + f);
    for (const w of r.warnings || []) log("  warning: " + (typeof w === "string" ? w : JSON.stringify(w)));
    const first = files[0] && path.resolve(path.dirname(file), files[0]);
    const action = await vscode.window.showInformationMessage("Waffle: " + pick.label + " written (" + files.length + " file" + (files.length === 1 ? "" : "s") + ").", ...(first ? ["Reveal"] : []), "Show log");
    if (action === "Reveal") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(first));
    if (action === "Show log") output.show(true);
  });
}

// --------------------------------------------------------------------------- Git HEAD summary
function git(cwd, args, maxBuffer = Folder.oneFile) {
  return new Promise((resolve, reject) => execFile("git", args, {cwd, maxBuffer, encoding:"buffer", timeout:60000, windowsHide:true},
    (err, stdout, stderr) => {
      if (err) return reject(Error((stderr?.toString() || err.message).trim()));
      try { resolve(new TextDecoder("utf-8", {fatal:true}).decode(stdout)); }
      catch (error) { reject(error); }
    }));
}
async function compareWithHead(uri) {
  if (!requireTrust()) return;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document || activePreview;
  if (!doc || doc.uri.scheme !== "file") { vscode.window.showInformationMessage("Choose the .waffle manifest in a Git workspace."); return; }
  const dir = path.dirname(doc.uri.fsPath);
  let before, after;
  try {
    after = currentProject(doc);
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    const rel = path.relative(top, doc.uri.fsPath).split(path.sep).join("/");
    const commit = (await git(top, ["rev-parse","--verify","HEAD^{commit}"])).trim();
    const index = Folder.manifest(await git(top, ["cat-file","blob",commit+":"+rel]), rel);
    const members = new Map();
    let remaining = Folder.totalSize - index.byteLength;
    for (const ref of index.members) if (Folder.kinds[path.extname(ref.path)]) {
      const name = path.posix.join(path.posix.dirname(rel),ref.path);
      const bytes = await git(top, ["cat-file","blob",commit+":"+name], Math.min(Folder.oneFile, remaining));
      remaining -= Buffer.byteLength(bytes);
      members.set(ref.path,bytes);
    }
    before = Folder.snapshot(index, relative=>members.get(relative));
  } catch (error) { vscode.window.showErrorMessage(error.message); return; }
  const text = D.report(before, after, {title: path.basename(doc.uri.fsPath) + ": HEAD → working copy" + (doc.isDirty ? " (unsaved)" : "")});
  const md = await vscode.workspace.openTextDocument({language: "markdown", content: text});
  await vscode.window.showTextDocument(md, {preview: true, viewColumn: vscode.ViewColumn.Beside});
}

// --------------------------------------------------------------------------- preview
let activePreview = null;
class PreviewProvider {
  constructor(context) { this.context = context; }
  resolveCustomTextEditor(document, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    // Scripts only from media/; no command URIs, no forms, no remote anything.
    panel.webview.options = {enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [media]};
    panel.webview.html = this.html(panel.webview, media);
    const root = path.dirname(document.uri.fsPath);
    let timer, members = new Set();
    const send = () => {
      try {
        const index = Folder.manifest(document.getText(),document.uri.fsPath);
        members = new Set(index.members.map(ref=>path.join(root,ref.path)));
        panel.webview.postMessage({type:"project", project:currentProject(document), name:path.basename(document.uri.path)});
      } catch (error) { panel.webview.postMessage({type:"error",message:error.message}); }
    };
    const refresh = resource => {
      if (resource.fsPath === document.uri.fsPath || members.has(resource.fsPath)) {
        clearTimeout(timer); timer = setTimeout(send,300);
      }
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root),"**/*.{waffle,wsch,wpcb,wdraw,wpanel,wlib,wblock}"));
    watcher.onDidCreate(refresh); watcher.onDidChange(refresh); watcher.onDidDelete(refresh);
    const changed = vscode.workspace.onDidChangeTextDocument(e=>refresh(e.document.uri));
    // The webview may only say it is ready or report an error; it can never edit the document.
    const received = panel.webview.onDidReceiveMessage(m => {
      if (m && m.type === "ready") send();
      else if (m && m.type === "error" && typeof m.message === "string") log("preview: " + m.message.slice(0, 300));
    });
    const view = panel.onDidChangeViewState(() => { if (panel.active) activePreview = document; });
    activePreview = document;
    panel.onDidDispose(() => { clearTimeout(timer); watcher.dispose(); changed.dispose(); received.dispose(); view.dispose(); if (activePreview === document) activePreview = null; });
  }
  html(webview, media) {
    const src = f => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const csp = webview.cspSource;
    const folder = path.join(this.context.extensionPath,"media","app");
    let scripts = [];
    try {
      const bundled = JSON.parse(fs.readFileSync(path.join(folder,"viewer-scripts.json"),"utf8"));
      if (Array.isArray(bundled) && bundled.includes("canvas.js") && bundled.every(file =>
        typeof file === "string" && /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.js$/.test(file) && fs.existsSync(path.join(folder,file)))) scripts = bundled;
    } catch { /* A checkout can open before the viewer assets are built. */ }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; style-src ${csp}; script-src ${csp}; font-src ${csp}; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${src("viewer.css")}">
<title>Waffle preview</title>
</head>
<body>
<header class="bar">
  <label class="pick">Document <select id="doc" aria-label="Document"></select></label>
  <button id="fit" type="button" title="Fit (F)">Fit</button>
  <span id="status" class="status" role="status"></span>
  <span class="badge">Read-only</span>
</header>
<main class="stage"><canvas id="view" aria-label="Design preview" tabindex="0"></canvas><p id="error" class="error" hidden></p></main>
${scripts.length ? scripts.map(f => `<script src="${src("app/" + f)}"></script>`).join("\n") : `<p class="error">The viewer files are missing. Run python3 integrations/vscode/scripts/bundle-viewer.py, then reload.</p>`}
<script src="${src("viewer.js")}"></script>
</body>
</html>`;
  }
}

// --------------------------------------------------------------------------- activation
function activate(context) {
  output = vscode.window.createOutputChannel("Waffle");
  validation = vscode.languages.createDiagnosticCollection("waffle");
  checks = vscode.languages.createDiagnosticCollection("waffle-checks");
  try { schema = JSON.parse(fs.readFileSync(path.join(context.extensionPath, "schema", "waffle-folder-record.schema.json"), "utf8")); } catch { schema = null; }
  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd("waffle.openPreview", async uri => {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file") return vscode.window.showInformationMessage("Choose the .waffle manifest in the project folder.");
    try {
      const file = Folder.selection(target.fsPath);
      if (/\.atrium$/i.test(file)) throw Error(Folder.core().obsolete.note);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      Folder.manifest(doc.getText(), file);
      return vscode.commands.executeCommand("vscode.openWith", doc.uri, "waffle.preview", vscode.ViewColumn.Beside);
    } catch (error) { return vscode.window.showErrorMessage(error.message); }
  });
  cmd("waffle.runDrc", runDrc);
  cmd("waffle.runErc", runErc);
  cmd("waffle.generateOutputs", generateOutputs);
  cmd("waffle.compareWithHead", compareWithHead);
  cmd("waffle.clearProblems", () => checks.clear());
  context.subscriptions.push(output, validation, checks,
    vscode.window.registerCustomEditorProvider("waffle.preview", new PreviewProvider(context), {webviewOptions: {retainContextWhenHidden: false}, supportsMultipleEditorsPerDocument: true}),
    vscode.workspace.onDidOpenTextDocument(d => scheduleValidation(d, 0)),
    vscode.workspace.onDidChangeTextDocument(e => scheduleValidation(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { validation.delete(d.uri); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("waffle.validation")) vscode.workspace.textDocuments.forEach(d => scheduleValidation(d, 0)); }));
  vscode.workspace.textDocuments.forEach(d => scheduleValidation(d, 0));
}
function deactivate() { for (const t of pending.values()) clearTimeout(t); pending.clear(); }

module.exports = {activate, deactivate};
