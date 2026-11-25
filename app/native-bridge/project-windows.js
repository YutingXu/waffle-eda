"use strict";
// A browser file picker supplies File objects, including on file:// where each page can
// have an opaque origin. A private port lets two editor windows share only that selection.
globalThis.AtriumProjectWindows = (() => {
  function receive(token) {
    const channel = new MessageChannel(), parent = window.opener;
    channel.port1.onmessage = async e => {
      channel.port1.close();
      window.opener = null;
      try {
        const {files,handles} = Array.isArray(e.data) ? {files:e.data} : e.data || {};
        if (Array.isArray(files) && files.every(file => file instanceof File)) {
          if (location.protocol !== "file:" && Array.isArray(handles) && typeof FileSystemFileHandle === "function")
            for (const [index,file] of files.entries()) if (handles[index] instanceof FileSystemFileHandle)
              Object.defineProperty(file,"fileHandle",{value:handles[index]});
          await globalThis.AtriumNavHost.openFiles(files);
        }
      } finally { window.__atriumOpeningProject = false; }
    };
    parent.postMessage({openProject:token}, location.protocol === "file:" ? "*" : location.origin, [channel.port2]);
    try { history.replaceState(null, "", location.href.split("#")[0]); } catch {}
  }

  function choose(files, currentName, dirty) {
    const dialog = document.createElement("dialog");
    const actions = document.createElement("div"); actions.className = "ui-sticky-actions";
    const title = document.createElement("h2"), detail = document.createElement("p");
    title.textContent = "Open project";
    detail.textContent = "Open in a new window to keep " + (currentName || "the current project") + " open.";
    dialog.setAttribute("aria-label", title.textContent);
    dialog.append(title, detail, actions);
    function button(label, action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ui-button"; b.textContent = label;
      b.onclick = action; actions.append(b);
      return b;
    }
    return new Promise(resolve => {
      let stop = () => {};
      const open = button("Open in new window", () => {
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
        const url = new URL(location.href); url.hash = "open-project=" + token;
        const child = window.open(url.href, "_blank");
        if (!child) { detail.textContent = "Allow pop-ups to open a separate window, or choose Open here."; return; }
        open.disabled = here.disabled = true;
        detail.textContent = "Opening the new window…";
        function transfer(port) {
          const handles = location.protocol !== "file:" ? files.map(file => file.fileHandle || null) : [];
          if (handles.some(Boolean)) try {port.postMessage({files,handles});return;} catch { /* Fall back to the selected bytes. */ }
          port.postMessage(files);
        }
        function received(e) {
          const sameOrigin = e.origin === location.origin || (location.protocol === "file:" && e.origin === "null");
          if (e.source !== child || !sameOrigin || e.data?.openProject !== token || !e.ports[0]) return;
          try {
            transfer(e.ports[0]); e.ports[0].close();
            stop(); stop = () => {}; dialog.close("opened");
          } catch { failed(); }
        }
        function failed() {
          stop(); stop = () => {};
          open.disabled = here.disabled = false;
          detail.textContent = "The new window could not open the project. Try again or choose Open here.";
        }
        const timer = setTimeout(failed, 20000);
        window.addEventListener("message", received);
        stop = () => { clearTimeout(timer); window.removeEventListener("message", received); };
      });
      open.dataset.variant = "primary";
      const here = button("Open here", () => dialog.close("here"));
      if (dirty) here.title = "Review unsaved changes before replacing this project";
      button("Cancel", () => dialog.close());
      dialog.onclose = () => { stop(); dialog.remove(); resolve(dialog.returnValue || "cancel"); };
      AtriumShell.adoptDialog(dialog, {title, body:detail, actions, sheet:true, initialFocus:open});
      document.body.append(dialog); dialog.showModal();
    });
  }
  return Object.freeze({choose, receive});
})();
