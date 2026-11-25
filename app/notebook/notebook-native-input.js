"use strict";
// The WebView2 drop lease belongs to one currently editable schematic. The
// bridge supplies only the three drop operations, never general host access.
globalThis.AtriumNotebookNativeInput = Object.freeze({create(protocol) {
    let dropWatch = null, dropEpoch = 0, activeDrop = null;
    function releaseDrop(grant, dropToken) {
      protocol.cancel({grant, dropToken}).catch(()=>{});
    }
    function watchDropTarget(grant) {
      dropWatch?.close();
      dropWatch = null;
      const host = globalThis.AtriumNavHost;
      if (!grant || !host?.on) return;
      const watch = dropWatch = {grant, host, epoch:0, ownerId:null};
      function changed(event) {
        activeDrop?.close();
        const doc = host.doc(), session = host.folderProject?.();
        watch.ownerId = globalThis.AtriumLabs?.notebookEnabled() !== false && event?.type !== "pagehide" && !document.hidden && session?.grant === grant && !session.readOnly &&
          doc?.kind === "schematic" && session.canEdit?.(doc.id) !== false ? doc.id : null;
        watch.epoch = ++dropEpoch;
        protocol.target({grant, ownerId:watch.ownerId, epoch:watch.epoch}).catch(()=>{});
      }
      const offDoc = host.on("document", changed), offProject = host.on("replace", changed);
      for (const name of ["blur","pagehide","pageshow"]) window.addEventListener(name, changed);
      document.addEventListener("visibilitychange", changed);
      watch.close = () => {
        activeDrop?.close(); offDoc(); offProject();
        protocol.target({grant, ownerId:null, epoch:++dropEpoch}).catch(()=>{});
        for (const name of ["blur","pagehide","pageshow"]) window.removeEventListener(name, changed);
        document.removeEventListener("visibilitychange", changed);
      };
      changed();
    }
    async function receiveDrop(message) {
      const {grant, ownerId, epoch, dropToken, x, y} = message, watch = dropWatch;
      if (globalThis.AtriumLabs?.notebookEnabled() === false || !watch || watch.grant !== grant || watch.ownerId !== ownerId || watch.epoch !== epoch ||
          !document.hasFocus() || !globalThis.AtriumNotebookImageDrop) {
        releaseDrop(grant, dropToken); return;
      }
      activeDrop?.close();
      const scope = globalThis.AtriumNotebookImageDrop.capture(watch.host), operation = new AbortController();
      const current = () => !operation.signal.aborted && scope.current() && scope.doc?.id === ownerId &&
        scope.session?.grant === grant && !scope.session.readOnly && scope.session.canEdit?.(ownerId) !== false;
      const drop = activeDrop = {dropToken, close() {
        if (operation.signal.aborted) return;
        operation.abort();
        scope.signal.removeEventListener("abort", drop.close); scope.close();
        if (activeDrop === drop) activeDrop = null;
        releaseDrop(grant, dropToken);
      }};
      scope.signal.addEventListener("abort", drop.close, {once:true});
      try {
        if (!current() || !await protocol.accept({grant, ownerId, epoch, dropToken}) || !current()) return;
        const ui = await globalThis.AtriumLazy.need("AtriumNotebookImageUI");
        if (current()) await ui.dropCaptured(grant, dropToken, x * innerWidth, y * innerHeight, {signal:operation.signal});
      } catch (error) { if (current()) watch.host.info(error.message); }
      finally { drop.close(); }
    }
    return Object.freeze({watch:watchDropTarget, offer:receiveDrop,
      cancelled(token) { if (activeDrop?.dropToken === token) activeDrop.close(); }});
}});
