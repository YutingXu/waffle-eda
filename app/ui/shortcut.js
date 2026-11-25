"use strict";

globalThis.AtriumShortcut = (() => {
  // Menu-style text uses "inline". Running prose can use "inline-keycap"
  // to keep each physical key separate on the same text baseline.
  function render(binding, {variant = "keycap", node = document.createElement("kbd")} = {}) {
    const K = globalThis.AtriumKeymap, D = node.ownerDocument;
    node.classList.add("ui-shortcut");
    node.dataset.variant = variant;
    if (!binding) { node.replaceChildren(); return node; }
    const names = K.displayKeys(binding, true);
    const words = names.map(keys => keys.join("+"));
    const inline = variant === "inline";
    const steps = inline ? K.displayParts(binding).map(text => [text]) : K.displayKeys(binding);
    const chords = steps.map((keys, index) => {
      const chord = D.createElement("span");
      chord.className = "ui-shortcut-step";
      chord.setAttribute("aria-hidden", "true");
      for (const [keyIndex, key] of keys.entries()) {
        const cap = D.createElement("span"), glyph = D.createElement("span"), visual = D.createElement("span");
        cap.className = "ui-shortcut-cap";
        glyph.className = "ui-shortcut-glyph";
        visual.className = "ui-shortcut-visual";
        visual.textContent = key;
        glyph.append(visual);
        cap.append(glyph);
        chord.append(cap);
        if (K.mac) globalThis.AtriumHost?.macShortcutBadge?.(cap, visual, (inline ? words[index] : names[index][keyIndex]));
      }
      return chord;
    });
    const spoken = D.createElement("span");
    spoken.className = "shortcut-spoken visually-hidden";
    spoken.textContent = words.join(", then ");
    node.replaceChildren(...chords, spoken);
    return node;
  }

  return {render};
})();
