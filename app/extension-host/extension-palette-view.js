"use strict";
// Bound extension responses and present them in the palette only after the user opens it.
globalThis.AtriumExtensionPaletteView = Object.freeze({
  create({records,host,palette,evaluateMath,id,plain,bounded}) {
    const starts = new Map();
    const generations = new WeakMap();
    let activeCommand = null;
    function invalidate(owner) {
      if (owner) generations.set(owner, (generations.get(owner) ?? 0) + 1);
      if (!owner || activeCommand?.owner === owner) activeCommand = null;
    }
    const text = (value, limit = 160) => typeof value === "string" ? value.slice(0, limit) : "";
    const icon = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value) ? value : "chip";
    const action = a => id(a?.id) && bounded(a.label, 100) ? {id: a.id, label: a.label} : null;
    const list = (v, n, map) => Array.isArray(v) ? v.slice(0, n).map(map).filter(Boolean) : [];
    function image(value) {
      if (value?.kind !== "png" || typeof value.data !== "string" || value.data.length > 88000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return null;
      // Inspect the actual PNG IHDR dimensions before giving its data to a browser decoder.
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const b64 = value.data.slice(22), bytes = [];
      for (let i = 0; i < 32; i += 4) {
        const bits = (alphabet.indexOf(b64[i]) << 18) | (alphabet.indexOf(b64[i + 1]) << 12) | (alphabet.indexOf(b64[i + 2]) << 6) | alphabet.indexOf(b64[i + 3]);
        bytes.push(bits >>> 16 & 255, bits >>> 8 & 255, bits & 255);
      }
      const data = new DataView(Uint8Array.from(bytes).buffer), w = data.getUint32(16), h = data.getUint32(20);
      if (data.getUint32(8) !== 13 || data.getUint32(12) !== 0x49484452 || !w || !h || w > 512 || h > 512) return null;
      return {kind: "png", data: value.data, alt: text(value.alt)};
    }
    function itemModel(v) {
      if (!id(v?.id) || !bounded(v.label, 160)) return null;
      const out = {id: v.id, label: v.label, detail: text(v.detail, 400), icon: icon(v.icon), accessory: text(v.accessory, 80), disabled: v.disabled === true,
        actions: list(v.actions, 12, action)};
      const art = image(v.thumbnail); if (art) out.thumbnail = art;
      return out;
    }
    function fieldModel(f) {
      if (!id(f?.id) || !bounded(f.label, 100) || !["number", "text", "select"].includes(f.type)) return null;
      const out = {id: f.id, label: f.label, type: f.type, required: f.required === true,
        value: typeof f.value === "number" && Number.isFinite(f.value) ? f.value : text(f.value, 400)};
      if (f.type === "select") out.choices = list(f.choices, 64, c => id(c?.id) && bounded(c.label, 100) ? {id: c.id, value: c.id, label: c.label} : null);
      if (f.type === "number" && bounded(f.unit,48)) out.unit=f.unit;
      if (f.type === "number") for (const key of ["min", "max"]) if (Number.isFinite(f[key])) out[key] = f[key];
      if (f.type === "text") out.maxLength = Number.isInteger(f.maxLength) ? Math.max(1, Math.min(400, f.maxLength)) : 400;
      return out;
    }
    function richBody(body) {
      if (!plain(body) || !Array.isArray(body.blocks)) return null;
      const blocks = []; let remaining = 8192;
      for (const block of body.blocks.slice(0, 16)) {
        if (!remaining || !["paragraph", "h1", "h2", "h3", "bullet", "number", "check"].includes(block?.style) || !Array.isArray(block.runs)) continue;
        const runs = [];
        for (const run of block.runs.slice(0, 32)) {
          if (!remaining || (run?.type !== "text" && run?.type !== "math")) continue;
          const field = run.type === "math" ? "tex" : "text", value = text(run[field], Math.min(remaining, 2000));
          if (!value) continue;
          remaining -= value.length;
          const out = {type: run.type, [field]: value};
          for (const mark of ["bold", "italic", "underline", "strike", "code"]) if (run[mark] === true) out[mark] = true;
          runs.push(out);
        }
        if (runs.length) blocks.push({style: block.style, runs, ...(block.style === "check" ? {checked: block.checked === true} : {})});
      }
      return blocks.length ? {blocks} : null;
    }
    function viewModel(v) {
      if (!plain(v) || !["list", "grid", "detail", "form"].includes(v.kind)) return null;
      const out = {kind: v.kind, title: text(v.title), text: text(v.text, 2400), actions: list(v.actions, 12, action)};
      if (action(v.primary)) out.primary = action(v.primary);
      if (v.kind === "list" || v.kind === "grid") out.items = list(v.items, 80, itemModel);
      if (v.kind === "form") out.fields = list(v.fields, 16, fieldModel);
      if (v.kind === "detail") out.blocks = list(v.blocks, 32, block => {
        if (block?.kind === "text" || block?.kind === "math") return {kind: block.kind, text: text(block.text, 2000)};
        if (block?.kind === "richText") { const body = richBody(block.body); return body ? {kind: "richText", body} : null; }
        const art = block?.kind === "image" && image(block.image); return art ? {kind: "image", image: art} : null;
      });
      return out;
    }
    function valuesFor(fields, raw) {
      const values = {};
      for (const f of fields || []) {
        const s = raw?.[f.id] ?? "";
        if (typeof s !== "string" && typeof s !== "number") throw Error("Check " + f.label + ".");
        const v = String(s).trim();
        if (!v && !f.required) { values[f.id] = ""; continue; }
        if (!v || v.length > (f.maxLength || 400) || (f.type === "select" && !f.choices.some(c => c.id === v))) throw Error("Check " + f.label + ".");
        if (f.type === "number") {
          const n = Number(v);
          if (!Number.isFinite(n) || n < f.min || n > f.max) throw Error("Check " + f.label + ".");
          values[f.id] = n;
        } else values[f.id] = v;
      }
      return values;
    }
    function preview(v) {
      if (typeof v === "string") return {kind: "text", text: text(v, 1600)};
      const art = image(v); return art ? {kind: "image", url: art.data, title: art.alt} : null;
    }
    const visible = (e, ctx, def) => host().available(e, true) && (!def.contexts || def.contexts.includes(ctx?.kind));
    const safeContext = request => ({query: text(request?.query, 256), editorKind: text(request?.context?.kind, 40)});
    function entry(e, def, kind, request, item) {
      const source = text(e.manifest.name, 120), itemId = item?.id, generation = generations.get(e);
      const isCurrent = ctx => generation === generations.get(e) && visible(e, ctx, def);
      const run = async (r, actionId) => {
        if (!isCurrent(r?.context || request?.context)) return;
        const command = activeCommand = {owner: e}, signal = r?.signal || request?.signal;
        const current = () => activeCommand === command && !signal?.aborted && host().available(e, true);
        let screenRevision = 0;
        const send = async (event, back) => {
          if (!current()) return;
          const revision = ++screenRevision, active = () => current() && screenRevision === revision;
          try {
            const ctx = (r || request)?.context, anchor = {};
            if (e.perms["read:project"] === true && typeof ctx?.docId === "string") {
              anchor.documentId = text(ctx.docId, 160);
              if (Array.isArray(ctx.point) && ctx.point.length === 2 && ctx.point.every(Number.isFinite)) anchor.point = [...ctx.point];
            }
            const result = await host().invoke(e, def.command, {...safeContext(r || request), ...anchor, ...event}, signal);
            if (!active()) return;
            let model;
            if (result?.kind === "calculation" && typeof result.functionId === "string" && result.functionId.startsWith(e.id + ".")) {
              model = viewModel({kind: "detail", title: result.title, blocks: result.blocks});
              try {
                const q = await evaluateMath(result.functionId, result.version, result.arguments, {signal});
                if (!q.display) throw Error("The calculation worker did not return a formatted value.");
                model.text = q.display; model.outputType = "quantity";
              } catch (error) { model.text = error.message; }
              if (!active()) return;
            } else model = viewModel(result);
            if (!model) return;
            const present = () => palette?.present?.(model, {
              run(actionId, rowId) {
                const row = model.items?.find(x => x.id === (rowId || actionId) && !x.disabled);
                if (rowId ? !row?.actions.some(a => a.id === actionId) : !row && model.primary?.id !== actionId && !model.actions.some(a => a.id === actionId)) return;
                return send({type: "action", actionId, ...(row ? {itemId: row.id} : event.itemId ? {itemId: event.itemId} : {})}, present);
              },
              readDesign:()=>current() && e.perms["read:project"]===true,
              submit(values, primaryId) {
                if (model.kind !== "form" || primaryId !== model.primary?.id) return;
                try { return send({type: "submit", actionId: primaryId, values: valuesFor(model.fields, values)}, present); }
                catch (error) { host().info(error.message); }
              }, back() { screenRevision++; back?.(); }
            });
            present();
          } catch (error) { if (current()) host().info(error.message); }
        };
        return send({type: actionId ? "action" : "open", ...(actionId ? {actionId} : {}), ...(itemId ? {itemId} : {})});
      };
      const artwork = preview(item?.thumbnail || def.preview);
      return {key: (item ? "search" : kind) + ":ext:" + e.id + ":" + def.id + (itemId ? ":" + itemId : ""), kind, source,
        label: item?.label || def.name, detail: item ? [item.detail, item.accessory].filter(Boolean).join(" · ") : text(def.description, 400),
        icon: icon(item ? e.manifest.icon || def.icon : def.icon || e.manifest.icon), keywords: (def.keywords || []).join(" "), keepOpen: true, run,
        ...(item ? {isCurrent: () => isCurrent(request?.context)} : {}),
        ...(artwork ? {preview: () => artwork} : {}), actions: (item?.actions || def.actions || []).map(a => ({id: a.id, label: a.label, keepOpen: true, run: r => run(r, a.id)}))};
    }
    function entries(ctx) {
      const rows = [];
      for (const e of records.values()) for (const [key, kind] of [["insertItems", "insert"], ["paletteCommands", "command"]])
        for (const def of e.manifest.contributes[key] || []) if (visible(e, ctx, def)) rows.push(entry(e, def, kind));
      return rows;
    }
    // A burst keeps only the newest waiting query for each provider. When typing stops,
    // that final query still runs as soon as the rolling four-start window admits it.
    async function admit(key, signal) {
      let rate = starts.get(key);
      if (!rate) starts.set(key, rate = {times: [], cancel: null});
      rate.cancel?.();
      const now = Date.now();
      rate.times = rate.times.filter(t => t > now - 1000);
      if (rate.times.length >= 4) {
        const allowed = await new Promise(resolve => {
          const finish = allowed => { clearTimeout(timer); signal?.removeEventListener?.("abort", cancel); if (rate.cancel === cancel) rate.cancel = null; resolve(allowed); };
          const cancel = () => finish(false), timer = setTimeout(() => finish(true), Math.max(1, rate.times[0] + 1000 - now));
          rate.cancel = cancel; signal?.addEventListener?.("abort", cancel, {once: true});
        });
        if (!allowed || signal?.aborted || starts.get(key) !== rate) return false;
      }
      if (signal?.aborted) return false;
      rate.times = rate.times.filter(t => t > Date.now() - 1000); rate.times.push(Date.now());
      return true;
    }
    async function stream(request, emit) {
      if (!request?.query?.trim() || request.signal?.aborted || request.scope && request.scope !== "provider") return;
      const todo = [];
      for (const e of records.values()) for (const def of e.manifest.contributes.searchProviders || []) {
        if (visible(e, request.context, def) && (!request.providerId || ["extensions", e.id, e.id + ":" + def.id].includes(request.providerId))) todo.push([e, def]);
      }
      let index = 0;
      async function next() {
        while (index < todo.length && !request.signal?.aborted) {
          const [e, def] = todo[index++], key = e.id + ":" + def.id;
          if (!await admit(key, request.signal) || !visible(e, request.context, def)) continue;
          const seen = new Set(); let packets = 0;
          try {
            await host().search(e, def, safeContext(request), request.signal, batch => {
              if (request.signal?.aborted || !visible(e, request.context, def) || ++packets > 8 || seen.size >= 24 || !Array.isArray(batch)) return;
              const rows = [];
              for (const item of list(batch, 24, itemModel)) {
                if (seen.has(item.id) || seen.size >= 24) continue;
                seen.add(item.id); rows.push(entry(e, def, "command", request, item));
              }
              if (rows.length) emit(rows);
            });
          } catch { /* One provider can finish empty while the others keep streaming. */ }
        }
      }
      await Promise.all(Array.from({length: Math.min(4, todo.length)}, () => next()));
    }
    return Object.freeze({
      entries, stream,
      invalidate,
      remove(e) {
        invalidate(e);
        for (const provider of e.manifest.contributes.searchProviders || []) {
          const key = e.id + ":" + provider.id;
          starts.get(key)?.cancel?.();
          starts.delete(key);
        }
      }
    });
  }
});
