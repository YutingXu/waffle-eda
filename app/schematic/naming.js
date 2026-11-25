"use strict";
// Naming (docs/design/net-intent.md §6, P1): how Waffle reads this project's net names, and the inline name
// completion that follows them. DOM; the data and every edit are net-intent-index.js.
//
//   AtriumNaming.render(root, host)   the Naming view (Signals panel › Naming): what Waffle has learned from
//     the names (each with examples, Keep / Forget), the two choices (lone _N, RS-485 A), the project's
//     words (also rails / grounds / clocks, not rails), what is never suggested and the declined
//     suggestions, and "Try a name" (how one name reads, and why). Each change is one undo step.
//   AtriumNaming.attach(input, {kind, project})   inline completion on a net name field: the best name
//     shows as faint text after the caret while typing (no pop-up), Tab takes it, ↑/↓ choose another, a
//     line under the field says why; Enter, Escape and leaving the field keep what was typed.
//   AtriumNaming.describe(name, conventions?) -> {role, text, basis}   one name in words
//   Share (in the view): Export… writes the project's conventions (net-intent-index.js exportConventions) as
//     <project>.waffle-naming.json; Import… reads one, lists what it would add or replace, and applies the
//     merge as one undo step.
// Lazy (app/lazy.js "AtriumNaming").
globalThis.AtriumNaming = (() => {
  const G = globalThis, X = () => G.AtriumNetIntentIndex, NI = () => G.AtriumNetIntent;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "naming.intro": "How Waffle reads this project's net names for suggestions, completion and hints.",
    "naming.group.title": "Group conventions",
    "naming.group.use": "Use group conventions",
    "naming.group.library": "Group library",
    "naming.group.open": "Open Group Library…",
    "naming.group.ready": "{group} · revision {rev}",
    "naming.group.update": "Use revision {rev}",
    "naming.group.empty": "Approve naming conventions in a group library to use them here.",
    "naming.group.precedence": "This project's choices and kept styles take precedence.",
    "naming.try": "Try a name",
    "naming.try_placeholder": "USB_DP, 3V3, nRST …",
    "naming.learned": "Learned from your names",
    "naming.learned_help": "A style is used once five names agree (nine in ten). Keep one to use it regardless; Forget one to stop using it.",
    "naming.card.rail": "Rail names",
    "naming.card.activeLow": "Active-low names",
    "naming.card.pair": "Differential pairs",
    "naming.card.bus": "Bus members",
    "naming.card.case": "Capitals",
    "naming.use.rail": "Used to complete rail names: typing 2.5 gives {example}.",
    "naming.use.activeLow": "Used to complete control names: typing rst gives {example}.",
    "naming.use.pair": "Used to suggest pairs and to spot a pair member without its partner.",
    "naming.use.bus": "Used to suggest buses and the next member while you name a label.",
    "naming.use.case": "Used to complete names in your capitals.",
    "naming.status.learned": "Learned from {n} names",
    "naming.status.seen": "Seen in {n} of {total} names",
    "naming.status.kept": "Kept by you",
    "naming.status.group": "From group",
    "naming.status.forgotten": "Forgotten: not used",
    "naming.status.none": "Not seen yet",
    "naming.also": "Also seen:",
    "naming.keep": "Keep",
    "naming.keep_title": "Use this style even if the names change",
    "naming.forget": "Forget",
    "naming.forget_title": "Stop using this style in this project",
    "naming.use_again": "Use again",
    "naming.use_instead": "Use {value}",
    "naming.choices": "Choices",
    "naming.lone": "A lone name ending in _N (RST_N) is",
    "naming.lone.low": "active low",
    "naming.lone.pair": "the negative line of a pair",
    "naming.lone.learned": "This project: {n} of {total} such names agree.",
    "naming.rs485": "On RS-485 and RS-422, the A line is",
    "naming.rs485.a": "non-inverting (+), as most transceiver datasheets",
    "naming.rs485.b": "inverting (−), as TIA-485",
    "naming.words": "Your words",
    "naming.words_help": "Stems Waffle does not know. A stem covers its variants: VPROG makes VPROG and VPROG_A rails and VPROG_EN its enable.",
    "naming.words.rail": "Also rails",
    "naming.words.ground": "Also grounds",
    "naming.words.clock": "Also clocks",
    "naming.words.notRail": "Not rails",
    "naming.add": "Add",
    "naming.add_placeholder": "Add a word",
    "naming.remove": "Remove {word}",
    "naming.never": "Not suggested",
    "naming.never.pair": "Pairs named",
    "naming.never.bus": "Buses",
    "naming.never.kinds": "Kinds",
    "naming.never_none": "Everything is suggested.",
    "naming.offer": "You declined {count} {what} suggestions and accepted none.",
    "naming.offer.stop": "Stop suggesting them",
    "naming.offer.keep": "Keep suggesting",
    "naming.declined": "{count} declined suggestions",
    "naming.declined_none": "No declined suggestions.",
    "naming.declined.show": "Show",
    "naming.declined.hide": "Hide",
    "naming.declined.again": "Suggest again",
    "naming.declined.all": "Suggest all again",
    "naming.kind.diff": "pair",
    "naming.kind.bus": "bus",
    "naming.kind.rail": "rail",
    "naming.kind.ground": "ground",
    "naming.read.pair": "{side} line of the differential pair {stem} ({pattern}); its partner is {partner}",
    "naming.read.positive": "The positive",
    "naming.read.negative": "The negative",
    "naming.read.ab": "A line of the pair {stem}; which one is + is set under Choices",
    "naming.read.rail": "A {volts} V rail",
    "naming.read.rail_nov": "A rail (no voltage in the name)",
    "naming.read.railSignal": "The {what} signal of the rail {rail}",
    "naming.read.ground": "A ground",
    "naming.read.ground_domain": "A ground, domain {domain}",
    "naming.read.ground_iso": "An isolated ground ({domain})",
    "naming.read.control": "A {what} control, active {level}",
    "naming.read.clock": "A clock",
    "naming.read.clock_f": "A clock, {freq}",
    "naming.read.data": "A data line",
    "naming.read.data_p": "A {protocol} data line",
    "naming.read.bus": "Member {index} of the bus {stem}",
    "naming.read.mains": "Mains ({part})",
    "naming.read.auto": "An automatic name: it says nothing about the net",
    "naming.read.nc": "Not connected",
    "naming.read.none": "No known meaning: Waffle will not guess",
    "naming.basis.name": "by its name",
    "naming.basis.dictionary": "by your words",
    "naming.basis.convention": "by your choice for lone _N names",
    "naming.share": "Share with another project",
    "naming.share_help": "Your words, choices and kept styles as a small file, to import into another project. Learned counts and declined suggestions stay here.",
    "naming.export": "Export…",
    "naming.bad_file": "This is not a Waffle naming conventions file.",
    "naming.import": "Import…",
    "naming.exported": "Naming conventions exported to {file}",
    "naming.preview": "Importing {file}",
    "naming.preview_from": "Importing {file} (from {project})",
    "naming.preview_none": "Nothing to import: this project already has every word and choice in the file.",
    "naming.prefer": "Where the file and this project differ",
    "naming.prefer.file": "use the file's",
    "naming.prefer.project": "keep this project's",
    "naming.apply": "Import {count} changes",
    "naming.cancel": "Cancel",
    "naming.change.add": "Add",
    "naming.change.replace": "Replace",
    "naming.change.keep": "Keep",
    "naming.group.stems": "{kind} word {word}",
    "naming.group.never": "not suggested ({kind}): {word}",
    "naming.group.keep": "kept style ({kind}): {word}",
    "naming.group.forget": "forgotten style: {word}",
    "naming.group.choice": "choice {kind}: {word}",
    "naming.complete.more": "↑↓ {count} more",
    "naming.complete.take": "Use {name}"
  });
  const upper = s => String(s).replace(/[a-z]/g, c => c.toUpperCase());
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, fn, title, cls = "nm-btn") => { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b; };

  // ------------------------------------------------------------------ one name in words
  const FUNCTION = {en: "enable", enable: "enable", pg: "power-good", pgood: "power-good", pok: "power-good", fb: "feedback", sense: "sense", sns: "sense", det: "detect", ok: "power-good",
    fault: "fault", flt: "fault", alert: "alert", shdn: "shutdown", mon: "monitor", adc: "measurement"};
  function describe(name, conv) {
    const x = X(), r = x ? x.classify(name, conv || undefined) : NI().read(name);
    const basis = t(r.by === "dictionary" ? "naming.basis.dictionary" : r.by === "convention" ? "naming.basis.convention" : "naming.basis.name");
    const v = Number.isFinite(r.voltage) ? r.voltage : Number.isFinite(r.nominal) ? r.nominal : null;
    let text;
    switch (r.role) {
      case "pairMember": text = r.known === false ? t("naming.read.ab", {stem: r.stem}) : t("naming.read.pair", {side: t(r.polarity > 0 ? "naming.read.positive" : "naming.read.negative"), stem: r.stem, pattern: r.pattern, partner: r.partners?.[0] || ""}); break;
      case "rail": text = v != null ? t("naming.read.rail", {volts: String(v)}) : t("naming.read.rail_nov"); break;
      case "railSignal": text = t("naming.read.railSignal", {what: FUNCTION[r.function] || r.function || "", rail: r.rail}); break;
      case "ground": text = r.isolated ? t("naming.read.ground_iso", {domain: r.domain || "ISO"}) : r.domain ? t("naming.read.ground_domain", {domain: r.domain}) : t("naming.read.ground"); break;
      case "control": text = t("naming.read.control", {what: r.function || "", level: r.activeLow ? "low" : "high"}); break;
      case "clock": text = r.freq ? t("naming.read.clock_f", {freq: r.freq >= 1e6 ? r.freq / 1e6 + " MHz" : r.freq >= 1e3 ? r.freq / 1e3 + " kHz" : r.freq + " Hz"}) : t("naming.read.clock"); break;
      case "data": text = r.protocol ? t("naming.read.data_p", {protocol: r.protocol}) : t("naming.read.data"); break;
      case "mains": text = t("naming.read.mains", {part: r.part || "line"}); break;
      case "auto": text = t("naming.read.auto"); break;
      case "nc": text = t("naming.read.nc"); break;
      default: text = Number.isFinite(r.index) && r.stem ? t("naming.read.bus", {index: r.index, stem: r.stem}) : t("naming.read.none");
    }
    return {role: r.role, text, basis: /^(?:auto|nc|unknown)$/.test(r.role) || text === t("naming.read.none") ? "" : basis};
  }

  // ------------------------------------------------------------------ inline completion
  // The suggestion is drawn as faint text over the field, after what was typed: the field's value is only
  // ever what the user typed or took with Tab, so its change and Enter handlers see nothing unexpected.
  function attach(input, o = {}) {
    if (!input || input.dataset.nmComplete) return () => {};
    input.dataset.nmComplete = "1";
    const doc = input.ownerDocument, ghost = el("span", null, "nm-ghost"), typed = el("span", null, "nm-ghost-typed"), rest = el("span", null, "nm-ghost-rest");
    const key = G.AtriumShortcut.render("Tab"); key.classList.add("nm-ghost-key");
    ghost.setAttribute("aria-hidden", "true"); ghost.append(typed, rest, key);
    const line = el("div", null, "nm-complete-line"); line.setAttribute("aria-live", "polite"); line.hidden = true;
    const row = input.closest?.("label") || input;
    let list = [], pick = 0, typedText = null, taking = false;
    const project = () => typeof o.project === "function" ? o.project() : o.project;
    const matches = () => list.filter(c => upper(c.name).startsWith(upper(typedText || "")) && c.name.length > (typedText || "").length);
    function hide() { ghost.remove(); line.hidden = true; list = []; typedText = null; }
    function show() {
      const m = matches(), c = m[pick % Math.max(1, m.length)];
      const end = input.value.length, atEnd = (input.selectionStart ?? end) === end && (input.selectionEnd ?? end) === end;
      if (!c || !atEnd) { ghost.remove(); line.hidden = !list.length; }
      else {
        const cs = G.getComputedStyle?.(input), box = input.getBoundingClientRect?.();
        if (cs && box) {
          Object.assign(ghost.style, {left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px", font: cs.font, letterSpacing: cs.letterSpacing,
            paddingLeft: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + "px", lineHeight: box.height + "px", textIndent: -(input.scrollLeft || 0) + "px"});
        }
        typed.textContent = input.value; rest.textContent = c.name.slice(input.value.length);
        if (!ghost.isConnected) doc.body.append(ghost);
      }
      // The line under the field: why the first name, the others to take with a click.
      line.replaceChildren();
      if (list.length) {
        const shown = m.length ? m : list;
        const first = shown[pick % shown.length];
        line.append(el("span", first.name, "nm-complete-name"), el("span", first.why, "nm-complete-why"));
        for (const x of shown.filter(y => y !== first).slice(0, 3)) line.append(button(x.name, e => { e.preventDefault(); take(x.name); input.focus(); }, t("naming.complete.take", {name: x.name}) + " · " + x.why, "nm-complete-alt"));
        if (m.length > 4) line.append(el("span", t("naming.complete.more", {count: m.length - 4}), "nm-complete-why"));
        line.hidden = false;
        if (!line.isConnected) row.after(line);
      } else line.hidden = true;
    }
    function update() {
      const p = project(), v = input.value;
      if (!p || !X() || !v.trim()) { hide(); return; }
      try { list = X().complete(p, v, {kind: o.kind, limit: 8}); } catch { list = []; }
      typedText = v; pick = 0;
      show();
    }
    function take(name) {
      input.value = name; input.setSelectionRange?.(name.length, name.length);
      hide();
      taking = true;
      try { input.dispatchEvent(new Event("input", {bubbles: true})); } finally { taking = false; }
    }
    const onInput = e => { if (taking) return; if (e.inputType && /^delete/.test(e.inputType)) { hide(); return; } update(); };
    const onKey = e => {
      const m = typedText != null ? matches() : [];
      if (!m.length || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Tab" && !e.shiftKey && ghost.isConnected) { e.preventDefault(); e.stopPropagation(); take(m[pick % m.length].name); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); pick = (pick + (e.key === "ArrowDown" ? 1 : m.length - 1)) % m.length; show(); }
      else if (e.key === "Escape" && ghost.isConnected) { e.preventDefault(); e.stopPropagation(); hide(); }
      else if (e.key === "Enter") hide();
    };
    const onBlur = () => setTimeout(() => { if (doc.activeElement !== input) hide(); }, 120);
    const onMove = () => { if (ghost.isConnected) show(); };
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKey, true);
    input.addEventListener("blur", onBlur);
    input.addEventListener("scroll", onMove);
    input.addEventListener("click", onMove);
    G.addEventListener?.("resize", onMove);
    return () => { hide(); line.remove(); delete input.dataset.nmComplete; input.removeEventListener("input", onInput); input.removeEventListener("keydown", onKey, true); input.removeEventListener("blur", onBlur); G.removeEventListener?.("resize", onMove); };
  }

  // ------------------------------------------------------------------ the Naming view
  const CARD = {rail: () => t("naming.card.rail"), activeLow: () => t("naming.card.activeLow"), pair: () => t("naming.card.pair"), bus: () => t("naming.card.bus"), case: () => t("naming.card.case")};
  const USE = {rail: example => t("naming.use.rail", {example}), activeLow: example => t("naming.use.activeLow", {example}), pair: () => t("naming.use.pair"), bus: () => t("naming.use.bus"), case: () => t("naming.use.case")};
  const STATUS = {learned: c => t("naming.status.learned", {n: c.n}), seen: c => t("naming.status.seen", {n: c.n, total: c.total}), kept: () => t("naming.status.kept"),
    group: () => t("naming.status.group"), forgotten: () => t("naming.status.forgotten"), none: () => t("naming.status.none")};
  const KIND = {diff: () => t("naming.kind.diff"), bus: () => t("naming.kind.bus"), rail: () => t("naming.kind.rail"), ground: () => t("naming.kind.ground")};
  const view = new WeakMap(); // root -> {declinedOpen, tryText}
  function render(root, host) {
    const x = X();
    if (!root || !x) return;
    const st = view.get(root) || {declinedOpen: false, tryText: ""};
    view.set(root, st);
    const project = host.project();
    if (!project) { root.replaceChildren(el("p", t("naming.intro"), "nm-intro")); return; }
    const C = x.conventions(project), E = C.effective, S = C.stored;
    const act = (fn, focus) => {
      let msg = "";
      const go = () => { try { host.edit(() => { msg = fn(host.project()); }); } catch (e) { host.info?.(e.message); return; } if (msg) host.info?.(msg); render(root, host); if (focus) root.querySelector(focus)?.focus(); };
      if (G.AtriumSignals || !G.AtriumLazy) go(); else G.AtriumLazy.need("AtriumSignals").then(go, e => host.info?.(e.message));
    };
    const edits = x.conventionEdits;
    const section = (title, help) => { const s = el("section", null, "nm-section"); s.append(el("h3", title, "nm-h")); if (help) s.append(el("p", help, "nm-help")); return s; };
    const chip = (name, onRemove) => {
      // A library chip token: the name highlights the net, the remove button forgets the word.
      const c = el("span", null, "ui-chip nm-chip");
      const b = button(name, () => host.setHighlight?.(name), null, "ui-chip-label nm-chip-name");
      c.append(b);
      if (onRemove) { const r = button("×", onRemove, t("naming.remove", {word: name}), "ui-chip-remove nm-chip-x"); r.setAttribute("aria-label", t("naming.remove", {word: name})); c.append(r); }
      return c;
    };
    const out = [];
    out.push(el("p", t("naming.intro"), "nm-intro"));

    const groupUI = async () => G.AtriumGroupLibraryUI || await G.AtriumLazy.need("AtriumGroupLibraryUI");
    if (!st.groupLoaded) {
      st.groupLoaded = true;
      let used = !!G.AtriumGroupLocal;
      try { used ||= !!G.localStorage?.getItem("atrium.group-library.v1"); } catch { /* storage unavailable */ }
      if (used) groupUI().then(u => u.restore()).then(() => { if (root.isConnected && !root.hidden) render(root, host); }).catch(() => {});
    }

    // Try a name: the first thing to reach for when a suggestion or hint surprises you.
    {
      const s = el("div", null, "nm-try"), lab = el("label", null, "nm-try-row"), field = el("input", null, "nm-try-input"), res = el("p", null, "nm-try-out");
      field.type = "text"; field.autocomplete = "off"; field.spellcheck = false; field.placeholder = t("naming.try_placeholder"); field.value = st.tryText; field.setAttribute("aria-label", t("naming.try"));
      res.setAttribute("aria-live", "polite");
      const say = () => {
        st.tryText = field.value;
        const n = field.value.trim();
        res.replaceChildren();
        if (!n) return;
        const d = describe(n, E);
        res.append(el("span", d.role, "nm-role nm-role-" + d.role), el("span", d.text + (d.basis ? " (" + d.basis + ")." : "."), "nm-try-text"));
      };
      field.oninput = say;
      lab.append(el("span", t("naming.try"), "nm-label"), field);
      s.append(lab, res);
      out.push(s);
      say();
    }

    {
      const active = C.group, approved = (G.AtriumGroupLocal?.libraries() || []).filter(lib => lib.naming);
      const s = section(t("naming.group.title")), row = el("div", null, "nm-actions");
      const label = el("label", null, "nm-radio"), toggle = el("input", null, "nm-group-use");
      const open = button(t("naming.group.open"), async () => {
        try {
          const u = await groupUI(), IO = G.AtriumIO;
          await u.dialog({currentProject: host.project, pickFile: extensions => IO.pickFile(extensions), exportFile: (name, data) => IO.exportFile(name, data)},
            active?.id || st.groupId, {
              onClose: chosen => { st.groupId = chosen; render(root, host); root.querySelector(".nm-group-open")?.focus(); }
            });
        } catch (e) { host.info?.(e.message); }
      });
      open.classList.add("nm-group-open", "ui-button");
      const choices = approved.map(lib => [lib.id, lib.name]);
      if (active && !approved.some(lib => lib.id === active.id)) choices.unshift([active.id, active.name]);
      toggle.classList.add("ui-checkbox"); toggle.type = "checkbox"; toggle.checked = !!active; toggle.disabled = !choices.length;
      const use = (id, focus) => act(p => x.useGroupConventions(p, id), focus);
      label.append(toggle, el("span", t("naming.group.use"))); row.append(label);
      if (choices.length) {
        const select = el("select", null, "nm-group-library ui-field");
        const selected = active?.id || (choices.some(([id]) => id === st.groupId) ? st.groupId : choices[0][0]);
        select.setAttribute("aria-label", t("naming.group.library"));
        for (const [id, name] of choices) {
          const option = el("option", name);
          option.value = id;
          if (id === selected) option.setAttribute("selected", "");
          select.append(option);
        }
        toggle.onchange = () => { st.groupId = select.value; use(toggle.checked ? st.groupId : null, ".nm-group-use"); };
        select.onchange = () => { st.groupId = select.value; if (active) use(st.groupId, ".nm-group-library"); };
        row.append(select);
      }
      row.append(open); s.append(row);
      if (active) {
        const status = el("p", t("naming.group.ready", {group: active.name, rev: active.rev}), "nm-help");
        status.setAttribute("role", "status"); s.append(status, el("p", t("naming.group.precedence"), "nm-help"));
        const newer = approved.find(lib => lib.id === active.id && lib.naming.key !== active.key);
        if (newer) s.append(button(t("naming.group.update", {rev: newer.naming.rev}), () => use(active.id, ".nm-group-use")));
      } else if (!choices.length) s.append(el("p", t("naming.group.empty"), "nm-help"));
      out.push(s);
    }

    // What Waffle has learned.
    {
      const s = section(t("naming.learned"), t("naming.learned_help"));
      for (const c of C.learned) {
        const card = el("div", null, "nm-card nm-" + c.status), head = el("div", null, "nm-card-head");
        head.append(el("span", CARD[c.id]?.() ?? c.id, "nm-card-title"), el("span", STATUS[c.status](c), "ui-badge nm-badge"));
        if (c.status === "learned" || c.status === "kept" || c.status === "group") head.lastChild.dataset.tone = "success";
        card.append(head);
        if (c.value != null) card.append(el("div", c.describe ?? c.value, "nm-value"));
        if (c.examples.length) { const ex = el("div", null, "nm-examples"); for (const n of c.examples) ex.append(chip(n)); card.append(ex); }
        const example = c.id === "rail" ? (E.rail ? x.renderRail(2.5, E.rail) : "+2V5") : c.id === "activeLow" ? x.renderLow("RST", E.activeLow || c.value || "n") : "";
        if (USE[c.id]) card.append(el("p", USE[c.id](example), "nm-use"));
        if (c.others.length) {
          const o = el("div", null, "nm-others");
          o.append(el("span", t("naming.also"), "nm-label"));
          for (const v of c.others.slice(0, 3)) {
            o.append(el("span", v.value + " (" + v.n + ")", "nm-other"));
            o.append(button(t("naming.use_instead", {value: v.value}), () => act(p => edits.keep(p, c.id, keepValue(C, c.id, v.value))), t("naming.keep_title")));
          }
          card.append(o);
        }
        const bar = el("div", null, "nm-actions");
        if (c.value != null && c.status !== "kept" && c.status !== "forgotten") bar.append(button(t("naming.keep"), () => act(p => edits.keep(p, c.id, keepValue(C, c.id, c.value))), t("naming.keep_title")));
        if (["learned", "kept", "group"].includes(c.status)) bar.append(button(t("naming.forget"), () => act(p => edits.forget(p, c.id)), t("naming.forget_title")));
        if (c.status === "forgotten" || c.status === "kept") bar.append(button(t("naming.use_again"), () => act(p => edits.reset(p, c.id))));
        if (bar.childNodes.length) card.append(bar);
        s.append(card);
      }
      out.push(s);
    }

    // The two settled choices.
    {
      const s = section(t("naming.choices"));
      const radios = (legend, name, value, options, note, set) => {
        const f = el("fieldset", null, "nm-choice");
        f.append(el("legend", legend));
        for (const [v, label] of options) {
          const l = el("label", null, "nm-radio"), r = el("input");
          r.type = "radio"; r.name = name; r.value = v; r.checked = v === value;
          r.onchange = () => r.checked && act(p => set(p, v));
          l.append(r, el("span", label));
          f.append(l);
        }
        if (note) f.append(el("p", note, "nm-help"));
        return f;
      };
      const L = C.loneN;
      s.append(radios(t("naming.lone"), "nm-lone", E.loneN, [["activeLow", t("naming.lone.low")], ["pair", t("naming.lone.pair")]],
        L.total ? t("naming.lone.learned", {n: L.n, total: L.total}) : null, (p, v) => edits.set(p, "loneN", v)));
      s.append(radios(t("naming.rs485"), "nm-rs485", E.rs485, [["A", t("naming.rs485.a")], ["B", t("naming.rs485.b")]], null, (p, v) => edits.set(p, "rs485", v)));
      out.push(s);
    }

    // The project's own words.
    {
      const s = section(t("naming.words"), t("naming.words_help"));
      for (const [group, kind, label] of [["stems", "rail", "naming.words.rail"], ["stems", "ground", "naming.words.ground"], ["stems", "clock", "naming.words.clock"], ["never", "rail", "naming.words.notRail"]]) {
        const row = el("div", null, "nm-words"), words = (group === "stems" ? S.stems[kind] : S.never.rail) || [];
        row.append(el("span", t(label), "nm-label"));
        const chips = el("span", null, "nm-chips");
        for (const w of words) chips.append(chip(w, () => act(p => edits.removeWord(p, group, kind, w))));
        const add = el("input", null, "nm-add"); add.type = "text"; add.autocomplete = "off"; add.spellcheck = false; add.placeholder = t("naming.add_placeholder"); add.setAttribute("aria-label", t(label) + ": " + t("naming.add"));
        const commit = () => { const v = add.value.trim(); if (v) act(p => edits.addWord(p, group, kind, v)); };
        add.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { add.value = ""; } };
        chips.append(add, button(t("naming.add"), commit));
        row.append(chips);
        s.append(row);
      }
      out.push(s);
    }

    // What is not suggested, and why.
    {
      const s = section(t("naming.never"));
      const kindWord = k => KIND[k]?.() ?? k;
      for (const o of x.offers(project)) {
        const r = el("div", null, "nm-offer");
        r.append(el("span", t("naming.offer", {count: o.declined, what: o.value ? o.value + " " + kindWord(o.kind) : kindWord(o.kind)})),
          button(t("naming.offer.stop"), () => act(p => edits.stopSuggesting(p, o))), button(t("naming.offer.keep"), () => act(p => edits.clearTally(p, o.key))));
        s.append(r);
      }
      let any = false;
      for (const [kind, label] of [["pair", "naming.never.pair"], ["bus", "naming.never.bus"], ["kinds", "naming.never.kinds"]]) {
        const words = S.never[kind] || [];
        if (!words.length) continue;
        any = true;
        const row = el("div", null, "nm-words"), chips = el("span", null, "nm-chips");
        row.append(el("span", t(label), "nm-label"));
        for (const w of words) chips.append(chip(kind === "kinds" ? kindWord(w) : w, () => act(p => edits.removeWord(p, "never", kind, w))));
        row.append(chips); s.append(row);
      }
      if (!any) s.append(el("p", t("naming.never_none"), "nm-help"));
      const declined = Object.entries(project.signals?.declined || {});
      const row = el("div", null, "nm-declined");
      row.append(el("span", declined.length ? t("naming.declined", {count: declined.length}) : t("naming.declined_none")));
      if (declined.length) {
        row.append(button(t(st.declinedOpen ? "naming.declined.hide" : "naming.declined.show"), () => { st.declinedOpen = !st.declinedOpen; render(root, host); }),
          button(t("naming.declined.all"), () => act(p => x.restore(p))));
      }
      s.append(row);
      if (st.declinedOpen) {
        const ul = el("ul", null, "nm-declined-list");
        for (const [k, d] of declined.slice(0, 200)) {
          const li = el("li");
          li.append(el("span", (d?.name || k) + (d?.kind ? " · " + kindWord(d.kind) : "") + (d?.date ? " · " + d.date : "")), button(t("naming.declined.again"), () => act(p => x.restore(p, k))));
          ul.append(li);
        }
        s.append(ul);
      }
      out.push(s);
    }
    // Share: export this project's conventions, import another's with a preview (one undo step).
    {
      const s = section(t("naming.share"), t("naming.share_help")), bar = el("div", null, "nm-actions"), IO = G.AtriumIO;
      const fileName = () => String(project.name || "project").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() + ".waffle-naming.json";
      bar.append(button(t("naming.export"), async () => {
        const name = fileName(), text = JSON.stringify(x.exportConventions(project), null, 2) + "\n";
        try { if (IO?.exportFile) { await IO.exportFile(name, text); host.info?.(t("naming.exported", {file: name})); } } catch (e) { host.info?.(e.message); }
      }), button(t("naming.import"), async () => {
        try {
          const f = await IO?.pickFile?.([".json"]);
          if (!f) return;
          const text = await f.text(), data = JSON.parse(text);
          x.planImport(host.project(), data); // validates; throws with a readable message
          st.importing = {data, file: f.name || "", prefer: "file"};
          render(root, host);
        } catch (e) { host.info?.(e instanceof SyntaxError ? t("naming.bad_file") : e.message); }
      }));
      s.append(bar);
      if (st.importing) {
        const imp = st.importing, plan = x.planImport(project, imp.data, {prefer: imp.prefer}), box = el("div", null, "nm-import");
        box.append(el("p", plan.from ? t("naming.preview_from", {file: imp.file, project: plan.from}) : t("naming.preview", {file: imp.file}), "nm-import-head"));
        if (plan.changes.some(c => c.kind !== "add")) {
          const f = el("fieldset", null, "nm-choice");
          f.append(el("legend", t("naming.prefer")));
          for (const [v, label] of [["file", t("naming.prefer.file")], ["project", t("naming.prefer.project")]]) {
            const l = el("label", null, "nm-radio"), r = el("input");
            r.type = "radio"; r.name = "nm-prefer"; r.value = v; r.checked = imp.prefer === v;
            r.onchange = () => { if (r.checked) { imp.prefer = v; render(root, host); } };
            l.append(r, el("span", label)); f.append(l);
          }
          box.append(f);
        }
        if (!plan.changes.length) box.append(el("p", t("naming.preview_none"), "nm-help"));
        else {
          const ul = el("ul", null, "nm-import-list");
          const val = v => typeof v === "string" ? v : v?.id || JSON.stringify(v);
          for (const c of plan.changes) {
            const li = el("li", null, "nm-import-" + c.kind), what = (GROUP[c.group] || GROUP.choice)({kind: c.key, word: val(c.to)});
            li.append(el("span", (CHANGE[c.kind] || CHANGE.add)(), "nm-import-kind"), el("span", what + (c.from != null ? " (" + val(c.from) + ")" : ""), "nm-import-what"));
            ul.append(li);
          }
          box.append(ul);
        }
        const row = el("div", null, "nm-actions");
        if (plan.applies) row.append(button(t("naming.apply", {count: plan.applies}), () => { const data = imp.data, prefer = imp.prefer; st.importing = null; act(p => x.importConventions(p, data, {prefer})); }));
        row.append(button(t("naming.cancel"), () => { st.importing = null; render(root, host); }));
        box.append(row);
        s.append(box);
      }
      out.push(s);
    }
    const focused = root.ownerDocument?.activeElement;
    const preserve = root.contains(focused) && [".nm-try-input", ".nm-group-open", ".nm-group-use", ".nm-group-library"].find(sel => focused.matches(sel));
    root.replaceChildren(...out);
    if (preserve) {
      const target = root.querySelector(preserve);
      target?.focus();
      if (preserve === ".nm-try-input") target?.setSelectionRange?.(target.value.length, target.value.length);
    }
  }
  const CHANGE = {add: () => t("naming.change.add"), replace: () => t("naming.change.replace"), keep: () => t("naming.change.keep")};
  const GROUP = {stems: a => t("naming.group.stems", a), never: a => t("naming.group.never", a), keep: a => t("naming.group.keep", a), forget: a => t("naming.group.forget", a), choice: a => t("naming.group.choice", a)};
  // What Keep stores: the rail style itself (sign, mark, trailing 0, stem), else the value.
  function keepValue(C, id, value) {
    if (id !== "rail") return value;
    const s = C.railStyles?.get(value);
    return s ? {...s, id: value} : value;
  }

  return Object.freeze({render, attach, describe});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumNaming;
