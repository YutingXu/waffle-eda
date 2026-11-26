"use strict";

// Help → About Waffle / Licenses and notices. The texts are embedded so the dialog
// works from file:// pages and native webviews without reading files.
globalThis.AtriumAbout = (() => {
  const VERSION = "0.8.1";
  const CODENAME = "Butter";
  const MIT = `MIT License

Copyright (c) 2026 Yuting Xu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  const THIRD_PARTY = [
    ["Mozilla PDF.js", "6.5.438", "Apache License 2.0", "app/vendor/pdfjs/LICENSE"],
    ["SheetJS js-cfb", "1.2.2", "Apache License 2.0", "app/vendor/CFB-LICENSE"],
    ["zip.js DEFLATE encoder", "2.7.73", "BSD 3-Clause", "app/vendor/ZIPJS-DEFLATE-LICENSE"],
    ["Newstroke (KiCad PCB lettering subset)", "", "CC0 1.0 Universal", "app/vendor/KICAD-NEWSTROKE-CC0.txt"],
    ["Karla (notebook sans)", "2.004", "SIL Open Font License 1.1", "app/vendor/notebook-fonts/karla-OFL.txt"],
    ["Neuton (notebook serif)", "1.560", "SIL Open Font License 1.1", "app/vendor/notebook-fonts/neuton-OFL.txt"],
    ["Cutive Mono (notebook monospace)", "1.110", "SIL Open Font License 1.1", "app/vendor/notebook-fonts/cutivemono-OFL.txt"],
    ["Kalam (notebook handwriting)", "2.001", "SIL Open Font License 1.1", "app/vendor/notebook-fonts/kalam-OFL.txt"],
    ["DejaVu Sans (subset, embedded in PDF output)", "2.35", "Bitstream Vera Fonts license; DejaVu changes public domain", "app/vendor/DEJAVU-LICENSE"]
  ];
  const DISCLAIMER = [
    "Waffle is an independent project. It is not affiliated with, endorsed by, sponsored by or approved by Altium LLC or any of its affiliates.",
    "ALTIUM®, ALTIUM DESIGNER® and other Altium marks are trademarks or registered trademarks of Altium LLC and/or its affiliates in the United States and other countries. KiCad, Gerber, Excellon, IPC and all other names are the property of their respective owners. They are used only to describe file compatibility and familiar workflows.",
    "Waffle contains no Altium software, documentation, component libraries or logos. Libraries you import from other tools remain subject to their own license terms.",
    "Waffle is provided “as is”, without warranty of any kind. Verify every design and manufacturing output (Gerber, drill, BOM, pick-and-place, DRC) before production."
  ];
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  // The informative dialogs focus their titles on open and use a secondary Close button.
  function dialog(title, build) {
    const d = el("dialog", null, "about-dialog"), close = el("button", "Close");
    close.type = "button"; close.onclick = () => d.close(); close.dataset.variant = "secondary";
    const heading = el("h2", title), body = el("div", null, "about-body"), actions = el("div", null, "ui-sticky-actions");
    heading.tabIndex = -1;
    build(body, heading, d, actions); actions.append(close); d.append(heading, body, actions);
    AtriumShell.openDialog(d, {title: heading, body, actions, sheet:true, initialFocus: heading});
    return d;
  }
  function about() {
    return dialog("About Waffle EDA", (body, heading, d, actions) => {
      heading.classList.add("about-wordmark");
      heading.replaceChildren(el("span", heading.textContent, "visually-hidden"));
      body.classList.add("about-summary");
      body.append(el("p", VERSION + " (“" + CODENAME + "”) · Offline schematic and PCB editor", "about-version"),
        el("p", "Copyright © 2026 Yuting Xu. Released under the MIT License."),
        el("p", DISCLAIMER[0], "about-notice"));
      // Which renderer draws the board views, and why (canvas-gpu-pref.js), for bug reports.
      const renderer = globalThis.AtriumCanvasGPUPref?.describe?.();
      if (renderer) body.append(el("p", "Board renderer: " + renderer, "about-renderer"));
      const more = el("button", "Licenses and notices…", "about-more"); more.type = "button"; more.dataset.variant = "secondary";
      more.onclick = () => { d.close(); licenses(); };
      actions.append(more);
    });
  }
  function licenses() {
    return dialog("Licenses and notices", d => {
      d.append(el("h3", "Trademarks and disclaimer"));
      for (const line of DISCLAIMER) d.append(el("p", line));
      d.append(el("h3", "Third-party software"));
      const list = el("ul");
      for (const [name, version, license, file] of THIRD_PARTY) list.append(el("li", name + " " + version + " — " + license + " (full text: " + file + ")"));
      d.append(list, el("h3", "Waffle license"));
      const pre = el("textarea"); pre.readOnly = true; pre.value = MIT; pre.rows = 12; pre.setAttribute("aria-label", "Waffle MIT License");
      d.append(pre);
    });
  }
  return { about, licenses, VERSION, CODENAME };
})();
