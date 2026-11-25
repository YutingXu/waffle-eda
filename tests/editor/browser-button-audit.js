"use strict";

// In-page audit: every visible text button in open dialogs and docked panels must read as a
// button. A button passes when it has a visible box (a border or fill that stands apart from
// the surface behind it) or a link style (underlined, or coloured unlike the surrounding text).
// Secondary buttons use the shared soft fill (9% ink, no outline; ui/controls.css), which reads as
// a box at a lower luminance contrast than an outline, so a fill passes from 1.15:1 (the soft fill measures about 1.2:1 on every surface).
// Menu rows, tabs, list rows and icon-only buttons are exempt: their containers frame them.
// Returns [{text, where, why}] for the failures. Used by browser-inspector-layout.js.
function audit(scope = "dialog[open], #properties, .dock-panel, .panel") {
  const parse = value => {
    const srgb = String(value).match(/color\(srgb ([^)]+)\)/);
    if (srgb) {
      const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).filter(Boolean).map(Number);
      return {r: r * 255, g: g * 255, b: b * 255, a};
    }
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return {r, g, b, a};
  };
  const lum = ({r, g, b}) => {
    const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
  };
  const contrast = (x, y) => { const a = lum(x), b = lum(y); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
  const over = (top, under) => top.a >= 1 ? top : {r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1};
  const surface = node => {
    const stack = [];
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let colour = {r: 255, g: 255, b: 255, a: 1};
    for (const c of stack.reverse()) colour = over(c, colour);
    return colour;
  };
  // Exempt: rows and tabs framed by their list, disclosure and column headings, icon-only buttons.
  const exempt = b => b.closest('[role="menu"], [role="menubar"], [role="tablist"], [role="listbox"], [role="tree"], [role="grid"], [role="toolbar"], nav, .nav-rows, .menu-items, summary, th, li, .se-tabs') ||
    b.hasAttribute("aria-expanded") || b.hasAttribute("aria-pressed") && b.parentElement.querySelectorAll(":scope > button").length > 1 ||
    /^(menuitem|tab|option|treeitem|row|gridcell|switch|radio)$/.test(b.getAttribute("role") || "") ||
    b.matches(".icon-button, .ui-icon-button, [class*=close], [class*=-row], [class*=row-], .lib-row, .library-row, .cat-row, .fe-tool, .lib-chip, .chip, [class*=swatch], [class*=-tab], [class*=card], .km-keys") || !b.textContent.trim() ||
    b.querySelector("svg, canvas, img") && b.textContent.trim().length <= 2;
  const out = [];
  for (const root of document.querySelectorAll(scope)) for (const b of root.querySelectorAll("button")) {
    if (exempt(b) || !b.getClientRects().length || b.closest("[hidden], dialog:not([open])")) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(b);
    if (s.visibility === "hidden" || +s.opacity === 0) continue;
    const behind = surface(b.parentElement), fill = over(parse(s.backgroundColor) || {r: 0, g: 0, b: 0, a: 0}, behind);
    const borderWidth = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
    const border = parse(s.borderTopColor);
    const borderSeen = borderWidth > 0 && s.borderTopStyle !== "none" && border && border.a > 0 && contrast(over(border, behind), behind) >= 2.4;
    const fillSeen = contrast(fill, behind) >= 1.15;
    const ink = parse(s.color), parentInk = parse(getComputedStyle(b.parentElement).color);
    const link = /underline/.test(s.textDecorationLine) || (ink && parentInk && contrast(ink, parentInk) >= 1.3 && !(Math.abs(ink.r - parentInk.r) < 8 && Math.abs(ink.g - parentInk.g) < 8));
    if (!borderSeen && !fillSeen && !link) {
      out.push({text: b.textContent.trim().slice(0, 40), where: (b.closest("[aria-label]")?.getAttribute("aria-label") || b.closest("dialog, section")?.className || "").slice(0, 40),
        cls: b.className, fill: contrast(fill, behind).toFixed(2), border: border ? contrast(over(border, behind), behind).toFixed(2) : "none"});
    }
  }
  return out;
}

module.exports = {audit};
