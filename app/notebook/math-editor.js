"use strict";

globalThis.AtriumMathEditor = (() => {
  const M = globalThis.AtriumMath,
    G = globalThis;
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(document, tag, cls, text);
  const button = (label, fn) => {
    const b = el("button", "", label);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const templates = {
    frac: ["\\frac{}{}", 6],
    sqrt: ["\\sqrt{}", 6],
    sum: ["\\sum_{}^{}", 6],
    int: ["\\int_{}^{}", 6],
    prod: ["\\prod_{}^{}", 7],
    left: ["\\left( \\right)", 6],
    text: ["\\text{}", 6],
    mathrm: ["\\mathrm{}", 8],
    begin: ["\\begin{matrix} & \\\\ & \\end{matrix}", 14]
  };
  const symbols = [
    ["a/b", "Fraction", "frac"],
    ["√", "Square root", "sqrt"],
    ["x²", "Superscript", ["^{}", 2]],
    ["xₙ", "Subscript", ["_{}", 2]],
    ["π", "Pi", ["\\pi ", 4]],
    ["Ω", "Ohms", ["\\Omega ", 7]],
    ["Σ", "Sum", "sum"],
    ["∫", "Integral", "int"]
  ];
  let active = null,
    nextId = 0;
  function preview(container, { tex, signal, display = true, size = 31 } = {}) {
    if (signal?.aborted || !container.isConnected) return;
    if (typeof tex !== "string" || !tex.trim()) {
      container.replaceChildren();
      return;
    }
    const l = M.layout(tex, { display }),
      issue = l.errors[0];
    if (issue) {
      const n = el("p", "math-preview-error", issue.message + " (" + (issue.start + 1) + ")");
      container.replaceChildren(n);
      return;
    }
    const parsed = new DOMParser().parseFromString(M.svg(l, { size }), "image/svg+xml").documentElement;
    // SVG is generated entirely from trusted font outlines. TeX contributes only escaped title text.
    parsed.setAttribute("aria-label", l.plain);
    container.replaceChildren(document.importNode(parsed, true));
  }
  function open(request) {
    const labsSignal = globalThis.AtriumLabs?.notebookSignal();
    if (labsSignal?.aborted) return;
    const context = request?.context || {},
      host = context.host,
      original = host?.doc?.(),
      project = host?.project?.();
    if (
      !original ||
      context.docId !== original.id ||
      original.kind !== "schematic" ||
      !project?.documents?.includes(original)
    )
      return;
    const existing =
      request.itemId != null
        ? original.items.find(i => i.id === request.itemId && i.kind === "textframe" && i.math === true)
        : null;
    if (request.itemId != null && !existing) return;
    const at = existing ? [existing.x, existing.y] : context.point;
    if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) return;
    const frozen = at.slice(),
      initial = existing?.text,
      initialSize = existing?.size,
      size = existing?.size ?? M.DEFAULT_SIZE;
    const stale = () =>
      labsSignal?.aborted || host.project() !== project ||
      host.doc() !== original ||
      !project.documents.includes(original) ||
      (!!existing &&
        (!original.items.includes(existing) || existing.text !== initial || existing.size !== initialSize));
    active?.close();
    return new Promise(resolve => {
      const id = "math-source-" + ++nextId,
        dialog = el("dialog", "math-editor"),
        form = el("form"),
        title = el("h2", "", existing ? "Edit equation" : "Insert equation");
      dialog.setAttribute("aria-labelledby", id + "-title");
      title.id = id + "-title";
      dialog.setAttribute("data-math-editor", "");
      const header = el("header");
      header.append(title);
      form.append(header);
      const content = el("div", "math-editor-columns"),
        sourceSide = el("section", "math-edit-source"),
        sourceLabel = el("label", "", "TeX source");
      sourceLabel.htmlFor = id;
      const area = el("div", "math-source-area"),
        back = el("pre", "math-source-mark"),
        source = el("textarea");
      back.setAttribute("aria-hidden", "true");
      source.id = id;
      source.spellcheck = false;
      const rememberTex=()=>{if(!G.AtriumLabs?.butterEnabled("visualHistory"))return;const tex=source.value.slice(source.selectionStart,source.selectionEnd);if(tex)G.AtriumLazy?.need("AtriumClipHistory").then(h=>h.recordText(tex,{math:true,source:original.name}),()=>{});};
      source.addEventListener("copy",rememberTex);source.addEventListener("cut",rememberTex);
      source.autocapitalize = "off";
      source.setAttribute("autocorrect", "off");
      source.setAttribute("autocomplete", "off");
      source.setAttribute("aria-autocomplete", "list");
      source.setAttribute("aria-controls", id + "-completions");
      source.setAttribute("aria-describedby", id + "-problem");
      source.maxLength = G.AtriumMathTex.MAX_LENGTH;
      source.value = existing?.text ?? String(request.argument || "").slice(0, source.maxLength);
      area.append(back, source);
      const options = el("div", "ui-select-list math-completions"); // a library completion list
      options.dataset.completion = "";
      options.id = id + "-completions";
      options.setAttribute("role", "listbox");
      options.setAttribute("aria-label", "TeX commands");
      options.hidden = true;
      const problem = el("div", "math-source-problem");
      problem.id = id + "-problem";
      problem.setAttribute("role", "status");
      sourceSide.append(sourceLabel, area, options, problem);
      const targetSide = el("section", "math-edit-target"),
        caption = el("span", "", "Preview"),
        paper = el("div", "math-live-preview");
      targetSide.append(caption, paper);
      content.append(sourceSide, targetSide);
      form.append(content);
      const keyboard = el("div", "math-symbols");
      keyboard.setAttribute("role", "group");
      keyboard.setAttribute("aria-label", "Math symbols");
      const sizeLabel = el("label", "math-size"),
        sizeCaption = el("span", "", "Size"),
        sizeField = el("span", "ui-field-measure"),
        sizeInput = el("input", "ui-field"),
        sizeUnit = el("span", "ui-field-unit", "mm");
      sizeInput.type = "number";
      sizeInput.min = "0";
      sizeInput.step = "any";
      sizeInput.value = String(size);
      sizeInput.setAttribute("aria-label", "Size (mm)");
      sizeUnit.setAttribute("aria-hidden", "true");
      sizeField.append(sizeInput, sizeUnit);
      sizeLabel.append(sizeCaption, sizeField);
      const foot = el("footer"),
        cancel = button("Cancel", () => finish(null)),
        save = el("button", "math-apply is-primary", existing ? "Save equation" : "Insert equation");
      save.type = "submit";
      foot.append(sizeLabel, cancel, save);
      form.append(keyboard, foot);
      dialog.append(form);
      document.body.append(dialog);
      let result = null,
        closed = false,
        chosen = 0,
        choices = [],
        completionRange = null,
        composing = false,
        dirtyCompletion = true,
        paintId = 0;
      function completeToken(choice) {
        const [insert, cursor] = templates[choice] || ["\\" + choice + " ", choice.length + 2];
        replace(insert, cursor, completionRange.start, completionRange.end);
        hideOptions();
      }
      function replace(text, cursor, start = source.selectionStart, end = source.selectionEnd) {
        source.setRangeText(text, start, end, "end");
        source.setSelectionRange(start + cursor, start + cursor);
        source.focus({ preventScroll: true });
        dirtyCompletion = false;
        paint();
      }
      for (const [label, name, token] of symbols) {
        const b = button(label, () => {
          const [v, p] = typeof token === "string" ? templates[token] : token;
          replace(v, p);
        });
        b.classList.add("ui-button"); b.dataset.size = "sm";
        b.setAttribute("aria-label", name);
        b.title = name;
        b.onpointerdown = e => e.preventDefault();
        keyboard.append(b);
      }
      function hideOptions() {
        choices = [];
        options.hidden = true;
        source.removeAttribute("aria-activedescendant");
        source.setAttribute("aria-expanded", "false");
      }
      function paintOptions() {
        hideOptions();
        if (!dirtyCompletion || composing || source.selectionStart !== source.selectionEnd) return;
        const end = source.selectionStart,
          m = /\\([A-Za-z]{1,24})$/.exec(source.value.slice(0, end));
        if (!m) return;
        choices = M.commands.filter(n => n.startsWith(m[1]) && n !== m[1]).slice(0, 7);
        if (!choices.length) return;
        completionRange = { start: end - m[0].length, end };
        chosen = Math.min(chosen, choices.length - 1);
        options.replaceChildren();
        options.hidden = false;
        source.setAttribute("aria-expanded", "true");
        choices.forEach((word, i) => {
          const opt = button("\\" + word, () => completeToken(word));
          opt.className = "ui-select-option"; opt.setAttribute("role", "option");
          opt.tabIndex = -1;
          opt.id = id + "-option-" + i;
          opt.setAttribute("aria-selected", String(i === chosen));
          opt.onpointerdown = e => e.preventDefault();
          options.append(opt);
        });
        source.setAttribute("aria-activedescendant", id + "-option-" + chosen);
      }
      function paint() {
        cancelAnimationFrame(paintId);
        paintId = 0;
        if (closed) return;
        const tex = source.value,
          l = M.layout(tex, { display: true }),
          e = l.errors[0];
        source.setAttribute("aria-invalid", String(!!e));
        problem.replaceChildren();
        back.replaceChildren();
        if (e) {
          const a = Math.min(e.start, tex.length),
            z = Math.min(e.end, tex.length);
          back.append(
            document.createTextNode(tex.slice(0, a)),
            el("mark", a === z ? "math-eof" : "", tex.slice(a, z) || "​"),
            document.createTextNode(tex.slice(z) + "\n")
          );
          const jump = button(e.message + " · " + (a + 1), () => {
            source.focus();
            source.setSelectionRange(a, z);
          });
          jump.title = "Select the error in the source";
          problem.append(jump);
        } else back.textContent = tex + "\n";
        back.scrollTop = source.scrollTop;
        back.scrollLeft = source.scrollLeft;
        preview(paper, { tex });
        paintOptions();
        save.disabled =
          !!e ||
          !tex.trim() ||
          !sizeInput.validity.valid ||
          !(Number(sizeInput.value) > 0 && Number.isFinite(Number(sizeInput.value)));
      }
      function queuePaint() {
        if (!paintId) paintId = requestAnimationFrame(paint);
      }
      function finish(value) {
        if (closed) return;
        closed = true;
        result = value;
        cancelAnimationFrame(paintId);
        dialog.close();
        clean();
      }
      function clean() {
        if (!dialog.isConnected) return;
        closed = true;
        active = null;
        vv?.removeEventListener("resize", sized);
        vv?.removeEventListener("scroll", sized);
        dialog.remove();
        if (!document.querySelector("dialog[open]")) {
          const c = typeof host.canvas === "function" ? host.canvas() : host.canvas;
          c?.focus?.({ preventScroll: true });
        }
        resolve(result);
      }
      source.addEventListener("input", () => {
        dirtyCompletion = true;
        chosen = 0;
        queuePaint();
      });
      source.addEventListener("scroll", () => {
        back.scrollTop = source.scrollTop;
        back.scrollLeft = source.scrollLeft;
      });
      source.addEventListener("click", () => {
        dirtyCompletion = true;
        chosen = 0;
        paintOptions();
      });
      source.addEventListener("compositionstart", () => {
        composing = true;
        hideOptions();
      });
      source.addEventListener("compositionend", () => {
        composing = false;
        queuePaint();
      });
      source.addEventListener("keydown", e => {
        if (e.isComposing || composing) return;
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          form.requestSubmit();
          return;
        }
        if (!choices.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          chosen = (chosen + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
          paintOptions();
        } else if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          completeToken(choices[chosen]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          dirtyCompletion = false;
          hideOptions();
        }
      });
      sizeInput.addEventListener("input", queuePaint);
      dialog.addEventListener("cancel", e => {
        e.preventDefault();
        finish(null);
      });
      dialog.addEventListener("close", clean);
      form.onsubmit = e => {
        e.preventDefault();
        paint();
        if (save.disabled) return;
        if (stale()) {
          host.info?.("The sheet or equation changed. Reopen the equation on its sheet.");
          finish(null);
          return;
        }
        const tex = source.value,
          em = Number(sizeInput.value),
          l = M.layout(tex, { display: true });
        const dims = M.noteDimensions(l, em);
        let item;
        host.edit(
          () => {
            if (stale()) return;
            item = existing || { id: G.Atrium.id(), kind: "textframe", math: true, x: frozen[0], y: frozen[1] };
            Object.assign(item, { text: tex, w: dims.w, h: dims.h, size: em });
            if (!existing) original.items.push(item);
          },
          existing ? "Edit equation" : "Insert equation",
          () => (item ? [item] : [])
        );
        if (item) {
          host.setTool?.("select");
          if (typeof host.select === "function") host.select([item.id]);
          else host.choose?.(item.id, false);
        }
        finish(item || null);
      };
      const vv = G.visualViewport;
      function sized() {
        if (vv) {
          dialog.style.setProperty("--math-height", vv.height + "px");
          dialog.style.setProperty("--math-top", vv.offsetTop + "px");
        }
      }
      sized();
      vv?.addEventListener("resize", sized);
      vv?.addEventListener("scroll", sized);
      active = { close: () => finish(null) };
      globalThis.AtriumShell?.adoptDialog?.(dialog, {title, body:[content,keyboard], actions:foot, initialFocus:source});
      dialog.showModal();
      source.focus({ preventScroll: true });
      source.setSelectionRange(source.value.length, source.value.length);
      paint();
    });
  }
  return Object.freeze({ open, preview });
})();
