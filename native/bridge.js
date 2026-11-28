(() => {
  "use strict";
  // WKWebView (macOS) and WebKitGTK (Linux) expose a script message handler. WebView2
  // (Windows) exposes chrome.webview to the top-level document only; the host also checks
  // the sender's URL, so a subframe never reaches it.
  if (window.top !== window) return;
  const wk = window.webkit?.messageHandlers?.atriumHost;
  const webview = wk ? null : window.chrome?.webview;
  const channel = typeof __waffleTopFramePost === "function" ? {postMessage: __waffleTopFramePost} : wk ||
    (webview && window.top === window ? {postMessage: text => webview.postMessage(text)} : null);
  if (!channel) return;
  window.__waffleSystemAccent = color => {
    const accent = /^#[a-f0-9]{6}$/i.test(color || "") ? color : null;
    if (accent === window.__atriumHostAccent) return;
    window.__atriumHostAccent = accent;
    globalThis.AtriumTheme?.apply();
  };
  const send = channel.postMessage.bind(channel), stringify = JSON.stringify;
  let settleWorkspaceLaunch;
  if (window.__waffleLaunchSettle) {
    const d = window.document;
    let ready = false, posted = false;
    function post() {
      if (posted) return;
      posted = true;
      send('{"action":"launchReady"}');
    }
    function present(editor) {
      if (ready) return;
      ready = true;
      const paint = () => {
        // Let the settled frame paint. A transparent native window may not receive frame callbacks.
        requestAnimationFrame(() => requestAnimationFrame(post));
        setTimeout(post, 100);
      };
      try {
        const prepared = editor?.prepareLaunch?.();
        if (prepared?.then) prepared.then(paint, error => {editor.info?.(error.message); paint();});
        else paint();
      } catch (error) {editor?.info?.(error.message); paint();}
    }
    if (window.__waffleWorkspaceLaunch) {
      settleWorkspaceLaunch = () => {
        const host = globalThis.AtriumNavHost;
        if (host?.isStarter?.() === false) present(host);
        else send('{"action":"workspaceLaunchFailed"}');
      };
    } else {
      observeLaunch();
    }
    function observeLaunch() {
      let checks = 0, recovery, recovered = false;
      function check() {
        if (ready || d.readyState === "loading") return;
        const host = globalThis.AtriumNavHost;
        const projectOpen = host?.isStarter?.() === false;
        const dialog = d.querySelector("dialog[open]");
        if (!dialog && !projectOpen && !welcomeDisabled()) return;
        dialogs.disconnect();
        present(dialog?.matches?.(".sp-dialog.sp-launch") ? null : host);
      }
      function welcomeDisabled() {
        if (d.readyState !== "complete" || window.__atriumOpeningProject ||
            globalThis.AtriumPref?.get("general.startPage") !== "never") return false;
        // Recovery may still reopen a project when Welcome is disabled.
        recovery ??= Promise.resolve(globalThis.AtriumAutosave?.boot?.()).catch(() => {}).then(() => { recovered = true; check(); });
        return recovered;
      }
      const dialogs = new MutationObserver(check);
      dialogs.observe(d, {subtree:true, attributeFilter:["open"]});
      const tick = () => { check(); if (!ready && ++checks < 125) setTimeout(tick, 16); else dialogs.disconnect(); };
      tick();
    }
  }
  const pending = new Map();
  const verifiedReads = new WeakSet();
  const setPending = pending.set.bind(pending), getPending = pending.get.bind(pending), removePending = pending.delete.bind(pending);
  const markVerified = verifiedReads.add.bind(verifiedReads), isVerified = verifiedReads.has.bind(verifiedReads);
  const random = wk && channel === wk ? window.crypto?.getRandomValues?.bind(window.crypto) : undefined;
  const bytes = Uint8Array, hex = "0123456789abcdef";
  const untimedRequests = new Set(["supportDiagnostics", "inputDiagnostics", "crashHistory", "macShortcutGlyphs",
    "recentFiles", "folderStatus", "folderLocalState", "recalledImportExport", "notebookDropTarget", "notebookDropCancel"]);
  const dialogRequests = new Set(["open", "pick", "chooseProjectFolder", "chooseLibraryFolder", "externalToolChoose",
    "folderPickAsset", "folderResolve", "nativeMemberExportCopy", "installProjectArchive", "folderConvertSibling",
    "reselectImportSave", "importSaveChoice", "writeImportExport", "export", "exportBinaryCopy", "printPDF"]);
  let next = window.__atriumBridgeRequestBase || 0;
  function request(action, payload = {}, verificationNonce, measure = true) {
    const id = ++next;
    // Elapsed round-trip time includes the host, IPC and any system picker.
    const timing = measure && !untimedRequests.has(action) ? globalThis.AtriumDiagnostics?.performance?.begin("native", "request") : null;
    return new Promise((resolve, reject) => {
      setPending(id,{resolve,reject,verificationNonce,verificationLease:verificationNonce && payload.lease,
        timing,dialog:!!timing && dialogRequests.has(action)});
      try {
        // The request id and action always win: a payload never names them (tool ids travel as toolId).
        send(stringify({...payload,id,action}));
      } catch (error) {
        removePending(id);
        timing?.end("failed");
        reject(error);
      }
    });
  }
  function receive(id,result,error,verified) {
    const job = getPending(id);
    if (!job || Boolean(job.verificationNonce) !== verified) return;
    removePending(id);
    let failure;
    if (verified && result?.verificationNonce !== job.verificationNonce)
      failure = Error("The native model verification reply could not be authenticated.");
    else if (verified && result?.lease !== job.verificationLease)
      failure = Error("The verified read did not match its native lease.");
    else if (error) {
      failure = Error(error);
      if (error === (globalThis.AtriumObsoleteProject?.note ??
          "This file is from a pre-release Waffle build; re-import the design from its source EDA"))
        Object.assign(failure,{code:"pre-release-format"});
      if (/^The export destination (?:changed|grant expired)/.test(error))
        Object.assign(failure,{code:"stale_destination"});
    }
    if (failure) {
      job.timing?.end("failed");
      job.reject(failure);
    } else {
      job.timing?.end(result?.cancelled === true || job.dialog &&
        (result == null || result === false || result === "cancel" || Array.isArray(result) && !result.length) ? "cancelled" : "completed");
      job.resolve(result);
    }
  }
  function macShortcutGlyphs(labels) {return request("macShortcutGlyphs", {labels});}
  // Keep platform graphics out of startup and off hidden or disconnected controls.
  let macShortcuts;
  function macShortcutPresenter() {
    const observed = new Set(), visible = new Set(), hints = new WeakMap(), cache = new Map();
    let observer, frame = 0, fetching = false;
    function unobserve(node) {
      observer?.unobserve(node);
      observed.delete(node);
      visible.delete(node);
    }
    function validGlyph(value) {
      if (!value || typeof value.png !== "string" || value.png.length > 32768 || !/^[a-z0-9+/]+={0,2}$/i.test(value.png)) return null;
      const {width, height, descent} = value;
      return [width, height, descent].every(Number.isFinite) && width > 0 && width <= 22 && height > 0 && height <= 2 &&
        descent >= 0 && descent < height ? value : null;
    }
    function apply(node, hint, glyph) {
      if (!glyph) {
        if (hint.label.includes("⏎")) hint.visual.textContent = hint.spoken;
        return;
      }
      // This zero-sized inline element sits on the real text baseline. Its mask uses AppKit's descent.
      const baseline = document.createElement("span"), ink = document.createElement("span");
      baseline.className = "native-shortcut-baseline";
      baseline.setAttribute("aria-hidden", "true");
      ink.className = "native-shortcut-ink";
      ink.style.setProperty("--shortcut-width", glyph.width + "em");
      ink.style.setProperty("--shortcut-height", glyph.height + "em");
      ink.style.setProperty("--shortcut-descent", glyph.descent + "em");
      ink.style.setProperty("--shortcut-image", "url(data:image/png;base64," + glyph.png + ")");
      baseline.append(ink);
      hint.visual.after(baseline);
      node.setAttribute("data-native-rendered", "");
    }
    function schedule() {
      if (!visible.size || frame || fetching) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const labels = new Set();
        for (const node of visible) {
          if (!node.isConnected) {unobserve(node); continue;}
          const hint = hints.get(node);
          if (!hint?.visual.isConnected) {unobserve(node); continue;}
          if (cache.has(hint.label)) {apply(node, hint, cache.get(hint.label)); unobserve(node);}
          else if (labels.size < 32) labels.add(hint.label);
        }
        if (!labels.size) return;
        fetching = true;
        macShortcutGlyphs([...labels]).catch(() => null).then(reply => {
          for (const label of labels) {
            if (cache.size >= 256) cache.delete(cache.keys().next().value);
            cache.set(label, validGlyph(reply?.[label]));
          }
          fetching = false;
          schedule();
        });
      });
    }
    function intent(event) {
      if (observer || event && !event.isTrusted || typeof IntersectionObserver !== "function") return;
      window.removeEventListener("pointerdown", intent, true);
      window.removeEventListener("keydown", intent, true);
      observer = new IntersectionObserver(records => {
        for (const {target, isIntersecting} of records) {
          if (!observed.has(target)) continue;
          if (!target.isConnected) unobserve(target);
          else if (isIntersecting) visible.add(target);
          else visible.delete(target);
        }
        schedule();
      });
      for (const node of observed) {
        if (node.isConnected) observer.observe(node);
        else unobserve(node);
      }
    }
    window.addEventListener("pointerdown", intent, true);
    window.addEventListener("keydown", intent, true);
    function badge(node, visual, spoken) {
      const label = visual.textContent;
      if (!label || label.length > 64) return;
      node.toggleAttribute("data-native-rendered", false);
      node.dataset.nativeShortcut = label;
      hints.set(node, {label, visual, spoken});
      if (observed.size >= 512) {
        for (const item of observed) if (!item.isConnected) unobserve(item);
        if (observed.size >= 512) unobserve(observed.values().next().value);
      }
      observed.add(node);
      observer?.observe(node);
      schedule();
    }
    return {badge, intent};
  }
  const macPresenter = () => macShortcuts ??= macShortcutPresenter();
  window.__atriumReceive = (id,result,error)=>receive(id,result,error,false);
  if (random) Object.defineProperty(window,"__waffleReceiveVerifiedFolderRead",{
    value:(id,result,error)=>receive(id,result,error,true)
  });
  async function readVerifiedFolder(payload) {
    const nonce = random(new bytes(16));
    let challenge = "";
    for (let i = 0; i < nonce.length; i++) challenge += hex[nonce[i] >> 4] + hex[nonce[i] & 15];
    const result = await request("folderReadVerified",{...payload,verificationNonce:challenge},challenge);
    if (!Array.isArray(result?.files)) throw Error("The verified read returned an invalid file list.");
    const files = result.files.map(row => Object.freeze({...row,...(row?.model && {model:Object.freeze({...row.model})})}));
    const receipt = Object.freeze({lease:result.lease,files:Object.freeze(files)});
    markVerified(receipt);
    return receipt;
  }
  // Save on the native close prompt (closing or quitting with unsaved changes): the page's own Save,
  // in place or through the save panel. -> true only when it saved and nothing is left unsaved; a
  // cancelled panel or a failed save is false and the window stays open. With report, the outcome
  // also goes to the host as {action:"saveForClose", saved} (WebKitGTK and WebView2 cannot await a
  // script's promise); the page's "dirty" report always comes first.
  window.__atriumSaveForClose = async report => {
    let saved = false;
    try {
      const editor = globalThis.AtriumNavHost;
      saved = typeof editor?.saveProject === "function" && await (editor.saveAll?.() ?? editor.saveProject()) !== false && !editor.isDirty();
    } catch { saved = false; }
    if (report) channel.postMessage(JSON.stringify({action: "saveForClose", saved}));
    return saved;
  };
  window.__atriumReviewForeignClose = async (id, report, deferDiscard = false) => {
    const host=globalThis.AtriumNavHost;
    let approved=false;
    try {
      if (id && host?.importSession?.()?.id===id)
        approved=await globalThis.AtriumForeignDrafts.review(host,deferDiscard);
    } catch (e) { host?.info?.(e.message); }
    if (report) channel.postMessage(JSON.stringify({action:"foreignCloseReviewed",importId:id,approved:approved===true}));
    return approved===true;
  };
  window.__atriumFinishForeignClose = (id,commit) =>
    globalThis.AtriumForeignDrafts.finishReview(globalThis.AtriumNavHost,id,commit);
  let dropInput, dropIntent = 0, watchLabs;
  function watchDropTarget(grant) {
    if (!webview) return;
    const labs = globalThis.AtriumLabs, intent = ++dropIntent;
    if (grant && !watchLabs) watchLabs = labs?.onChange(() => watchDropTarget(folderGitGrant));
    if (!grant || labs?.notebookEnabled() === false) { dropInput?.watch(null); return; }
    if (dropInput) { dropInput.watch(grant); return; }
    globalThis.AtriumLazy?.need("AtriumNotebookNativeInput").then(module => {
      if (dropIntent !== intent || labs?.notebookEnabled() === false) return;
      dropInput = module.create({
        target: options => request("notebookDropTarget",options),
        accept: options => request("notebookDropAccept",options),
        cancel: options => request("notebookDropCancel",options)
      });
      dropInput.watch(grant);
    }, () => {});
  }
  window.__waffleOpenLink = async url => {
    const lazy = globalThis.AtriumLazy;
    if (!lazy || typeof url !== "string" || url.length > 114 || !url.startsWith("waffle://")) return false;
    try {
      const prefs = await lazy.need("AtriumPrefs");
      if (prefs.get("butter.links") !== true) return false;
      return (await lazy.need("AtriumLinksDesktop")).receive(url);
    } catch (error) {globalThis.AtriumNavHost?.info(error.message); return false;}
  };
  // WebView2 replies arrive as host messages: {id,result,error} or {command}.
  webview?.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "butterDropOffer") {
      void window.__waffleNativeDropOffer(message.token,message.x,message.y,message.file)
        .then(handled=>finishTypedDrop(message.token,handled));
      return;
    }
    if (message.type === "notebookDropOffer") {
      if (dropInput) dropInput.offer(message);
      else request("notebookDropCancel",{grant:message.grant,dropToken:message.dropToken}).catch(()=>{});
      return;
    }
    if (message.type === "notebookDropCancelled") { dropInput?.cancelled(message.dropToken); return; }
    if (message.type === "folderChanged") return window.__waffleFolderChanged(message);
    if (message.type === "waffleLink") return window.__waffleOpenLink(message.url);
    if (message.type === "workspaceWindow") return window.__waffleWorkspaceEvent(message.event);
    if (message.type === "copyNativeDocuments") {
      if (typeof message.error === "string") return globalThis.AtriumNavHost?.info(message.error);
      if (Array.isArray(message.files)) return window.__waffleCopyNativeDocuments?.(message.files);
      return;
    }
    if (typeof message.id === "number") window.__atriumReceive(message.id, message.result ?? null, message.error ?? null);
    else if (message.command === "pause-extensions") globalThis.AtriumExtensions?.pauseAll?.();
    else if (message.command === "review-foreign-close") window.__atriumReviewForeignClose(message.importId,true);
    else if (message.command === "save-for-close") window.__atriumSaveForClose(true);
    else if (typeof message.command === "string") window.dispatchEvent(new CustomEvent("atrium-command",{detail:message.command}));
  });
  window.__waffleFolderChanged = detail => window.dispatchEvent(new CustomEvent("folderChanged", {detail}));
  const GIT_QUERIES = new Set(["createBranch","refs","status","log","fileLog","projectLog","projectBlobs","folderRevisions","read","mergeBase","blameLog","patches","installMergeDriver","mergeDriverPlan","lfsStatus","lfsLocks","lfsLock","lfsUnlock","commitPlan","commitStaged"]);
  const sourceOps = new Set(["projectLog", "projectBlobs", "sourceRevision", "sourceLog"]);
  const historyFiles = new WeakMap();
  let historyBinding = null;
  const sources = new WeakMap(), retainedInputs = new WeakMap(), importKeys = new WeakMap();
  let importSession = null;
  function forgetImportSession() {
    importSession?.controller.abort();
    importSession = null;
  }
  function imported(file) {
    if (!file || !importSession?.token || importSession.file !== file) throw Error("The imported design changed. Open it again.");
    return importSession;
  }
  async function importRequest(action, payload, signal, session) {
    if (signal?.aborted || session?.controller.signal.aborted) throw new DOMException("Cancelled","AbortError");
    const operation = window.crypto.randomUUID();
    const abort = () => send(stringify({action:"cancelImportSave",operation}));
    signal?.addEventListener("abort",abort,{once:true});
    session?.controller.signal.addEventListener("abort",abort,{once:true});
    try {
      const result = await request(action,{...payload,operation,...(session ? {session:session.id,sourceToken:session.token} : {})});
      if (signal?.aborted || session?.controller.signal.aborted) throw new DOMException("Cancelled","AbortError");
      return result;
    } finally {
      signal?.removeEventListener("abort",abort);
      session?.controller.signal.removeEventListener("abort",abort);
    }
  }
  // A byte producer carries exactly the File object delivered during a trusted
  // gesture. An application command cannot turn an arbitrary Blob into a file grant.
  let mediaTransfers;
  const cancelTypedDrop = token => send(stringify({action:"butterDropCancel",token}));
  const finishTypedDrop = (token,handled) => send(stringify({action:"butterDropFinish",token,handled:handled===true}));
  window.__waffleNativeDropOffer = async (token, x, y, file) => {
    const host = globalThis.AtriumNavHost, prefs = globalThis.AtriumPrefs;
    const canvas = host?.canvas(), doc = host?.doc(), project = host?.project(), revision = host?.revision();
    const clientX = x * window.innerWidth, clientY = y * window.innerHeight;
    if (!file || prefs?.get("butter.drop") !== true || !canvas || document.elementFromPoint(clientX,clientY) !== canvas ||
        document.querySelector("dialog:modal")) return false;
    const operation = new AbortController(), signal = operation.signal;
    const abort = () => operation.abort(), escape = event=>{if (event.key==="Escape") abort();};
    const offProject=host.on("replace",abort), offDoc=host.on("document",abort);
    document.addEventListener("keydown",escape,true);
    window.addEventListener("pagehide",abort,{once:true});
    let cancelled=false;
    const cancel = ()=>{
      if (!cancelled) {
        cancelled=true;
        cancelTypedDrop(token);
      }
    };
    signal.addEventListener("abort",cancel,{once:true});
    async function load(selected,readSignal) {
      readSignal?.addEventListener("abort",cancel,{once:true});
      let transfer;
      try {transfer = await request("butterDropTake",{token});}
      finally {readSignal?.removeEventListener("abort",cancel);}
      if (signal.aborted || readSignal?.aborted || !transfer) throw new DOMException("Drop cancelled","AbortError");
      const {data,name,mime} = transfer, D = globalThis.AtriumDrop;
      const metadata = D.fileMetadata(selected,true);
      const actual = D.fileMetadata({name,mime,size:null},true);
      if (actual.kind !== metadata.kind || actual.mime !== metadata.mime || !selected.virtual && metadata.name !== name ||
          typeof data !== "string" || data.length > Math.ceil(D.limits[actual.kind]/3)*4)
        throw Error("The dropped file changed while opening.");
      const binary = typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(data) : null;
      let bytes = binary;
      if (!bytes) {
        const text = atob(data);
        bytes = new Uint8Array(text.length);
        for (let i=0;i<text.length;i++) bytes[i] = text.charCodeAt(i);
      }
      mediaTransfers?.set(selected,"drop");
      return bytes;
    }
    try {
      const Drop = await globalThis.AtriumLazy.need("AtriumDropEditor");
      if (signal.aborted || host.doc() !== doc || host.project() !== project || host.revision() !== revision) return true;
      return await Drop.handle({isTrusted:true,target:canvas,clientX,clientY,files:[file]},host,
        () => globalThis.AtriumLabs?.notebookEnabled() !== false,{load,signal});
    } catch (error) {
      if (!signal.aborted) host.info(error.message);
      return true;
    } finally {
      offProject?.();
      offDoc?.();
      document.removeEventListener("keydown",escape,true);
      window.removeEventListener("pagehide",abort);
      signal.removeEventListener("abort",cancel);
    }
  };
  function setupMediaTransfers() {
    const labs = globalThis.AtriumLabs;
    function capture(enabled) {
      mediaTransfers = enabled ? new WeakMap() : null;
      if (!enabled) return;
      const signal = labs?.notebookSignal();
      for (const event of ["paste","drop","change"]) window.addEventListener?.(event,e=>{
        if (!e.isTrusted) return;
        const camera=event==="change" && e.target?.matches?.("input[type=file][capture]");
        const files=camera?e.target.files:event==="paste"?e.clipboardData?.files:event==="drop"?e.dataTransfer?.files:null;
        for (const file of Array.from(files||[]).slice(0,16)) mediaTransfers.set(file,camera?"camera":event);
      },{capture:true,signal});
    }
    capture(labs?.notebookEnabled() !== false);
    labs?.onChange(capture);
  }
  if (globalThis.document?.readyState === "loading") document.addEventListener("DOMContentLoaded",setupMediaTransfers,{once:true});
  else if (globalThis.document) setupMediaTransfers();
  let folderGitGrant = null, pendingAdopt = null, projectGeneration = 0;
  function makeFile({name,data,mime,sourceToken,path,altiumPath,historyToken,retainedInputToken,importSaveKey,folderProject,memberPath,standaloneMember,nativeCopy}) {
    if (folderProject) return {name, folderProject, ...(typeof memberPath === "string" ? {memberPath} : {})};
    const binary=atob(data),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    const file = new File([bytes],name,{type:mime || ""});
    if (typeof memberPath === "string") Object.defineProperty(file,"memberPath",{value:memberPath});
    if (nativeCopy && typeof nativeCopy.grant === "string")
      Object.defineProperty(file,"nativeCopy",{value:nativeCopy});
    if (standaloneMember && typeof standaloneMember.grant === "string")
      Object.defineProperty(file,"standaloneMember",{value:standaloneMember});
    if (typeof altiumPath === "string") Object.defineProperty(file,"altiumPath",{value:altiumPath});
    if (historyToken) historyFiles.set(file, {token:historyToken, name});
    if (sourceToken) sources.set(file,sourceToken);
    if (retainedInputToken) retainedInputs.set(file,retainedInputToken);
    if (retainedInputToken && /^[a-f0-9]{64}$/.test(importSaveKey || "")) importKeys.set(file,importSaveKey);
    // Library files picked for reloading carry their canonical path (see readFile).
    if (typeof path === "string") Object.defineProperty(file,"path",{value:path,enumerable:true});
    return file;
  }
  function encodeBytes(bytes) {
    if(typeof bytes.toBase64==="function")return bytes.toBase64();
    // Full chunks are divisible by three so only the last chunk has padding.
    const chunks=[], size=24*1024;
    for(let i=0;i<bytes.length;i+=size)chunks.push(btoa(String.fromCharCode(...bytes.subarray(i,i+size))));
    return chunks.join("");
  }
  // Save As and clearing the binding also change which repository a history tab belongs to.
  function gitBindingChanged(fromSave = false) {
    if(typeof CustomEvent==="function")window.dispatchEvent?.(new CustomEvent("atrium-git-binding",{detail:{fromSave}}));
  }
  async function forFolder(action, grant, payload = {}) {
    const generation = projectGeneration;
    const current = () => grant && grant === folderGitGrant && generation === projectGeneration;
    if (!current()) throw new DOMException("The active Waffle project changed.", "AbortError");
    try { return await request(action, {...payload, grant}); }
    finally {
      if (!current()) throw new DOMException("The active Waffle project changed.", "AbortError");
    }
  }
  async function readGit(action, payload={}) {
    const token=folderGitGrant, generation=projectGeneration;
    if(!token)throw Error("Save or open a Waffle project to compare its Git revision.");
    const result=await request(action,{...payload,token});
    if(generation!==projectGeneration || token!==(folderGitGrant))throw Error("The active project changed. Open revision review again.");
    return result;
  }
  window.__waffleWorkspaceEvent = async event => {
    try {
      const client = await globalThis.AtriumLazy?.need("AtriumProjectWindowClient");
      return await client?.receive(event);
    } finally {
      if (event.type === "arrival") {
        window.__atriumOpeningProject = false;
        settleWorkspaceLaunch?.();
      }
    }
  };
  const host = Object.freeze({
    workspaceWindow(payload){return request("workspaceWindow", payload);},
    chooseProjectFolder(payload){return request("chooseProjectFolder", payload);},
    async folderAdopt({fromSave = false,...payload}){
      const generation = projectGeneration;
      const attempt = pendingAdopt = {grant:payload.grant};
      try {
        const result = await request("folderAdopt", payload);
        if (projectGeneration !== generation) throw Error("The active project changed.");
        if (pendingAdopt !== attempt) return false;
        if (result !== false) {
          forgetImportSession();
          projectGeneration++; historyBinding = null;
          folderGitGrant = attempt.grant; watchDropTarget(folderGitGrant); recentAsked = false; gitBindingChanged(fromSave);
        }
        return result;
      } finally {
        if (pendingAdopt === attempt) pendingAdopt = null;
      }
    },
    folderReadLease(payload){return request("folderReadLease", payload);},
    folderRead(payload){return request("folderRead", payload);},
    ...(random ? {folderReadVerified:readVerifiedFolder,isVerifiedFolderRead:isVerified} : {}),
    folderRelease(payload){return request("folderRelease", payload);},
    folderCommit(payload){return request("folderCommit", payload);},
    folderStatus(payload){return request("folderStatus", payload);},
    folderLocalState(payload){return request("folderLocalState", payload);},
    async folderClose(payload){
      if (pendingAdopt?.grant === payload.grant) pendingAdopt = null;
      if(folderGitGrant===payload.grant){watchDropTarget(null);folderGitGrant=null;projectGeneration++;gitBindingChanged();}
      return request("folderClose",payload);
    },
    folderPickAsset(payload){return request("folderPickAsset",payload);},
    folderStageAsset(payload){return request("folderStageAsset",payload);},
    folderDraftAssetProof(payload){return request("folderDraftAssetProof",payload);},
    folderRestoreDraftAsset(payload){return request("folderRestoreDraftAsset",payload);},
    folderReadAsset(payload){return request("folderReadAsset",payload);},
    folderDropAsset(payload){return request("folderDropAsset",payload);},
    folderConflict(payload){return request("folderConflict",payload);},
    folderConflictRead(payload){return request("folderConflictRead",payload);},
    folderResolve(payload){return request("folderResolve",payload);},
    async open(extensions, {into = false} = {}){
      return (await request("open", {...(extensions ? {extensions} : {}), ...(into ? {into:true} : {})})).map(makeFile);
    },
    nativeMemberCommit(options){return request("nativeMemberCommit",options);},
    nativeMemberExportCopy(options){return request("nativeMemberExportCopy",options);},
    nativeMemberClose(options){return request("nativeMemberClose",typeof options === "string" ? {grant:options} : options);},
    finishedOpening(success){window.__atriumOpeningProject=false;channel.postMessage(JSON.stringify({action:"finishedOpening",success:success===true}));},
    acceptHistorySource(files) {
      const selected = files.map(f => historyFiles.get(f)).filter(Boolean);
      this.clearProjectPath();
      if (selected.length === 1) {
        historyBinding = selected[0];
        channel.postMessage(JSON.stringify({action:"acceptHistorySource",token:historyBinding.token}));
        gitBindingChanged();
      }
    },
    get historyPath() { return historyBinding?.name || null; },
    async historyQuery(op,args={}) {
      const binding = historyBinding, generation = projectGeneration;
      if (!binding || !sourceOps.has(op)) throw Error("Open an Altium or KiCad design to see its history.");
      const value = await request("gitQuery",{token:binding.token,op,args});
      if (binding !== historyBinding || generation !== projectGeneration) throw Error("The active project changed.");
      return value;
    },
    get folderGitGrant() { return folderGitGrant; },
    // WebKitGTK serializes folder Git work on the same queue as other folder reads.
    get parallelGitReads() { return !!(webview || wk && channel === wk); },
    get canRevealProject() { return !!(wk && channel === wk && folderGitGrant); },
    revealProject(){return this.canRevealProject ? forFolder("revealProject", folderGitGrant) : Promise.resolve(false);},
    collabLocks(grant = folderGitGrant){return forFolder("collabLocks", grant);},
    collabLockWrite(grant, key, data, mode){return forFolder("collabLockWrite", grant, {key,data:stringify(data),mode});},
    collabLockRemove(grant, key){return forFolder("collabLockRemove", grant, {key});},
    get projectGeneration() { return projectGeneration; },
    clearProjectPath() {
      forgetImportSession();
      watchDropTarget(null);
      projectGeneration++; folderGitGrant = pendingAdopt = historyBinding = null;
      channel.postMessage(JSON.stringify({action:"clearGitProject"}));
      gitBindingChanged();
    },
    writeSelection(packet){return request("writeSelection",packet);},
    readSelection(){return request("readSelection");},
    gitHead(){return readGit("gitHead");},
    gitHistory(){return readGit("gitHistory");},
    async gitRevision(revision){
      if(typeof revision!=="string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))throw Error("Choose a full commit identifier from the project history.");
      return readGit("gitRevision",{revision});
    },
    // Git queries for the revision picker, file history, blame, merge and commit views
    // (native/git_head.py QUERY_OPS). The host checks the operation and arguments again;
    // nothing here names a Git command, and no query fetches, pushes or runs hooks.
    // Writes such as merge-driver setup and selected staged commits need explicit confirmation.
    async gitQuery(op,args={}, {advisory = false} = {}){
      if(!GIT_QUERIES.has(op))throw Error("Waffle does not run that Git query.");
      if(args==null||typeof args!=="object"||Array.isArray(args))throw Error("Git query arguments must be an object.");
      return readGit("gitQuery",{op,args:JSON.parse(JSON.stringify(args)),
        ...(op === "status" && advisory === true && wk && channel === wk ? {advisory:true} : {})});
    },
    // Branches and tags in the shape the visual diff's picker reads (diff-view.js).
    async gitRefs(){
      const r=await readGit("gitQuery",{op:"refs",args:{}});
      const list=Array.isArray(r?.refs)?r.refs:[];
      return {head:r?.head||null,
        branches:list.filter(x=>x.kind==="branch").map(x=>({name:x.short,revision:x.revision,current:x.name===r.ref})),
        tags:list.filter(x=>x.kind==="tag").map(x=>({name:x.short,revision:x.revision}))};
    },
    async pickFile(extensions){const files=await request("pick",{extensions});return files.length?makeFile(files[0]):null;},
    // Text exports travel as UTF-8 text; binary ones (zip, xlsx) as base64 data.
    exportFile(name,data,options){return request("export",data instanceof Uint8Array?{name,data:encodeBytes(data)}:{name,text:data},
      undefined,options?.diagnostics!==true);},
    // Print a finished PDF natively (macOS: PDFKit; Linux: the WebKit view, with the pages mounted by print.js).
    // Windows: WebView2 prints the mounted pages itself (window.print shows the system print preview).
    printPDF(name,bytes){
      if(webview)return new Promise(resolve=>{window.addEventListener("afterprint",()=>resolve(true),{once:true});window.print();});
      return request("printPDF",{name,data:encodeBytes(bytes)});
    },
    notebookMedia(options){return request("notebookMedia",options);},
    notebookClip(options){return request("notebookClip",options);},
    notebookDrop(options){return request("notebookDrop",options);},
    butterDropEnabled(value){send(stringify({action:"butterDropEnabled",enabled:value===true}));},
    cancelTypedDrop,finishTypedDrop,
    notebookPaste(options){return request("notebookPaste",options);},
    notebookDerivative(options){return request("notebookDerivative",options);},
    async notebookTransfer({grant,ownerId,file,mediaType,approved}){
      const lab=globalThis.AtriumLabs?.notebookSignal(), origin=mediaTransfers?.get(file);
      const size=approved?.size ?? file.size;
      if(!origin || size<1 || size>128*1048576)throw Error("Choose, paste or drop an image first.");
      mediaTransfers.delete(file);
      const bytes=approved ? globalThis.AtriumDrop.consumeMedia(approved,file) : new Uint8Array(await file.arrayBuffer());
      if(lab?.aborted)throw new DOMException("Cancelled","AbortError");
      return request("notebookTransfer",{grant,ownerId,origin,mediaType,name:file.name,data:encodeBytes(bytes)});
    },
    importSaveKey(file) {return importKeys.get(file) || null;},
    bindImportSave({file,files=[]}) {
      const key=importKeys.get(file), token=retainedInputs.get(file);
      if (importSession?.file===file && token) return key;
      forgetImportSession();
      if (!key || !token) return null;
      const id=window.crypto.randomUUID();
      importSession={id,file,token,controller:new AbortController()};
      send(stringify({action:"bindImportSave",session:id,sourceToken:token,
        tokens:[...new Set([file,...files].map(f=>retainedInputs.get(f)).filter(Boolean))]}));
      return key;
    },
    bindRestoredImportSave({id,sourceKey,format}) {
      if (typeof id!=="string" || !id || id.length>160 || !/^(?:[a-z0-9_-]+:)?[0-9a-f]{64}$/.test(sourceKey) ||
          !["altium","kicad","eagle","easyeda"].includes(format)) return false;
      if (importSession?.draftId===id && importSession.key===sourceKey && importSession.format===format) return true;
      forgetImportSession();
      const session=window.crypto.randomUUID();
      importSession={id:session,draftId:id,key:sourceKey,format,controller:new AbortController()};
      send(stringify({action:"bindRestoredImportSave",session,draftId:id,sourceKey,format}));
      return true;
    },
    async reselectImportSave({sourceKey,format,signal}) {
      if (!/^[a-f0-9]{64}$/.test(sourceKey)) return null;
      const rows=await importRequest("reselectImportSave",{sourceKey,format},signal,null);
      if (!Array.isArray(rows) || rows[0]?.importSaveKey!==sourceKey) return null;
      return rows.map(makeFile);
    },
    importSaveChoice({file,id,sourceKey,name,format,labels,canExport=true,signal}) {
      if (file) return importRequest("importSaveChoice",{name,format,labels,canExport},signal,imported(file));
      const session=importSession;
      if (!session?.draftId || session.draftId!==id || session.key!==sourceKey || session.format!==format)
        throw Error("The recovered design changed. Open its Save again.");
      return importRequest("importSaveChoice",{name,format,labels,canExport,draftId:id,sourceKey},signal,session);
    },
    writeImportExport({file,name,bytes,files,destination,signal}) {
      const session=imported(file), single=files===undefined;
      const rows=single?[{name,bytes}]:files;
      if (!Array.isArray(rows) || !rows.length || rows.length>4096) throw Error("Invalid export member set.");
      let total=0;
      const encoded=rows.map(row=>{
        if (!(row.bytes instanceof Uint8Array) || (total+=row.bytes.length)>256*1024*1024) throw Error("Invalid export size.");
        return {name:row.name,data:encodeBytes(row.bytes)};
      });
      return importRequest("writeImportExport",{name,files:encoded,single,destination},signal,session);
    },
    rememberImportExport({file,destination}) {
      return importRequest("rememberImportExport",{destination},null,imported(file));
    },
    recalledImportExport({file}) {return importRequest("recalledImportExport",{},null,imported(file));},
    forgetImportExport({file}) {return importRequest("forgetImportExport",{},null,imported(file));},
    canConvertSibling(file) {return retainedInputs.has(file);},
    // The host always asks where the project goes, starting outside the source project folder.
    folderConvertSibling({file,manifest,files,version,folderName,signal}) {
      const sourceToken=retainedInputs.get(file);
      if(!sourceToken)throw Error("Choose the original source in the system picker.");
      return importRequest("folderConvertSibling",{sourceToken,manifest,files,version,folderName},signal,imported(file));
    },
    folderReadImportSource({grant,lease,bindingPath,inputId}) {return request("folderReadImportSource",{grant,lease,bindingPath,inputId});},
    installProjectArchive({manifest,version,files}) {return request("installProjectArchive",{manifest,version,files});},
    async exportBinaryCopy(name,bytes,file) {
      const sourceToken=sources.get(file);
      if(!sourceToken)throw Error("Select the original Altium document again.");
      return request("exportBinaryCopy",{name,data:encodeBytes(bytes),sourceToken});
    },
    // Same-network sessions (native/macos/LanRelay.swift, native/linux/lan_relay.py): a listener and an
    // mDNS advertisement only while the host shares a session as "Visible on this network".
    // Not in the Windows app yet (WebView2): the editor shows a note instead.
    lanAvailable: !webview,
    lanStart(room,salt,name){return request("lanStart",{room:String(room),salt:String(salt),name:String(name||"")});},
    lanHost(host){return request("lanHost",{host:String(host)});},
    lanStop(){return request("lanStop");},
    lanBrowse(){return request("lanBrowse");},
    setDirty(dirty, projectName){const host=globalThis.AtriumNavHost;const id=globalThis.AtriumForeignDrafts?.needsReview(host) && host.importSession?.()?.id;channel.postMessage(JSON.stringify({action:"dirty",dirty:!!dirty,projectName:typeof projectName === "string" ? projectName : null,...(typeof id==="string" ? {importId:id} : {})}));},
    crashHistory(){return request("crashHistory");},
    async supportDiagnostics(){
      const info = await request("supportDiagnostics").catch(() => null);
      const platform = info?.platform;
      if (!["macos", "windows", "linux"].includes(platform)) return null;
      const architecture = info.architecture === "arm64" || info.architecture === "x64" ? info.architecture : "unknown";
      const facts = {platform, architecture};
      if (platform === "macos" && ["one", "two", "three-or-more", "unknown"].includes(info.displayCount)) facts.displayCount = info.displayCount;
      const keys = platform === "macos" ? ["terminated", "unresponsive"] : platform === "windows"
        ? ["exited", "unresponsive", "browserExited"] : ["exited", "unresponsive", "memoryLimit", "terminated"];
      const counts = {};
      for (const key of keys) {
        const n = Object.getOwnPropertyDescriptor(info.rendererTerminations ?? {}, key)?.value;
        if (Number.isSafeInteger(n) && n >= 0 && n <= 32) counts[key] = n;
      }
      return Object.keys(counts).length ? {...facts, rendererTerminations:counts} : facts;
    },
    startRecoverySession(session){channel.postMessage(JSON.stringify({action:"recoverySession",session}));},
    ...(globalThis.document?.documentElement?.dataset?.atriumNativeTitlebar === "macos" ? {
      macShortcutGlyphs,
      // Help › Troubleshooting › Input Diagnostics: collection belongs to the open inspector.
      inputDiagnostics(operation = "read"){
        if (!["start", "read", "stop"].includes(operation)) throw Error("Invalid input diagnostics operation.");
        return request("inputDiagnostics", {operation});
      },
      macShortcutIntent(){macPresenter().intent();},
      macShortcutBadge(node, visual, spoken){macPresenter().badge(node, visual, spoken);}
    } : {}),
    // Recent projects for the command palette: a cached list, fetched on first use.
    recentFiles(){if(!recentAsked){recentAsked=true;window.AtriumHost.refreshRecentFiles();}return recent;},
    refreshRecentFiles({metadataOnly=false}={}){
      if(metadataOnly)return request("recentFiles",{metadataOnly:true}).then(list=>Array.isArray(list)?list:[],()=>recent);
      return request("recentFiles").then(list=>{recent=Array.isArray(list)?list:[];return recent;},()=>recent);
    },
    linkRecentProjects(projectId){return request("linkRecentProjects",{projectId});},
    async openRecent(entry,options){return (await request("openRecent",{path:entry?.path||String(entry),activate:options?.activate===true})).map(makeFile);},
    // run:external (app/external-tools.js): programs the user chose in a native picker, or a detected path
    // they confirmed in a native dialog. The page names a tool id, never a program path to run; the host
    // keeps the paths, asks once per program and extension with the exact command, and runs it without a
    // shell in a temporary folder (native/external_tools.py, native/macos/ExternalTools.swift).
    externalToolList(){return request("externalToolList");},
    externalToolProbe(paths){return request("externalToolProbe",{paths:Array.isArray(paths)?paths.filter(p=>typeof p==="string").slice(0,16):[]});},
    externalToolChoose(o){return request("externalToolChoose",{toolId:String(o?.id||""),name:String(o?.name||"").slice(0,80),...(typeof o?.path==="string"?{path:o.path}:{})});},
    externalToolForget(id){return request("externalToolForget",{toolId:String(id)});},
    externalRun(run){return request("externalRun",{run:JSON.parse(JSON.stringify(run))});},
    externalCancel(runId){channel.postMessage(JSON.stringify({action:"externalCancel",runId:String(runId)}));return true;},
    aiCredential(operation, provider){return request("aiCredential",{operation,provider});},
    // macOS and Linux issue opaque grants from their folder pickers. Every path below is relative.
    ...(!webview ? {
      chooseLibraryFolder(purpose = "read"){return request("chooseLibraryFolder",{purpose});},
      libraryFolderList(grant){return request("libraryFolderList",{grant});},
      libraryFolderRead(grant, paths){return request("libraryFolderRead",{grant,paths});},
      libraryFolderWrite(grant, path, text){return request("libraryFolderWrite",{grant,path,text});},
      forgetLibraryFolder(grant){return request("forgetLibraryFolder",{grant});},
      openKiCadLicence(){return request("openKiCadLicence");},
      // An external http(s) link the user followed opens in the system browser (shell.js).
      openURL(url){
        let parsed; try { parsed = new URL(String(url)); } catch { return Promise.reject(Error("Enter an HTTP or HTTPS URL.")); }
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) return Promise.reject(Error("Enter an HTTP or HTTPS URL without credentials."));
        return request("openURL",{url:parsed.href});
      }
    } : {}),
    // Re-read a library file the user chose earlier with Open library file… (.atrlib/.json only).
    async readFile(path){
      // Absolute paths only: /… on macOS and Linux, C:\… or \\server\share\… on Windows.
      if(typeof path!=="string" || !/^(?:\/|[A-Za-z]:\\|\\\\[^\\?.])/.test(path) || path.length>4096)throw Error("Choose a library file path.");
      const result=await request("readFile",{path});
      const file=new File([result.text],result.name);
      Object.defineProperty(file,"path",{value:result.path,enumerable:true});
      return file;
    }
  });
  if (random) Object.defineProperty(window,"AtriumHost",{value:host});
  else window.AtriumHost = host;
  let recent=[],recentAsked=false;
})();
