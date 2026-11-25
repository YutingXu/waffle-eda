"use strict";

// Compare painted glyphs in live WebKit controls. A zero-size inline marker
// can supply the caption's baseline when the label and value have different
// characters. The reference ink sits outside layout and never styles the field.
globalThis.__uiProbes = (() => {
  const post = (op, data = {}) => webkit.messageHandlers.harness.postMessage({op, ...data});
  const log = (ok, name, detail) => post("log", {ok, name, detail});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const host = () => AtriumNavHost;
  const canvas = document.createElement("canvas").getContext("2d");
  const box = element => element.getBoundingClientRect();
  const bounds = element => JSON.stringify(box(element).toJSON());
  const value = field => field.tagName === "SELECT" ? field.selectedOptions[0]?.textContent : field.value;

  async function until(get, message) {
    const end = performance.now() + 5000;
    do { const result = get(); if (result) return result; await wait(30); } while (performance.now() < end);
    throw Error(message);
  }
  function live(selector, root = document) {
    return until(() => {
      const element = root.querySelector(selector);
      return element && box(element).height > 0 && element;
    }, "Visible control not found: " + selector);
  }
  async function click(element) {
    const r = box(element);
    return post("mouse", {x:r.x + r.width / 2, y:r.y + r.height / 2});
  }
  function range(element, offset = 0, length = element.firstChild.length) {
    const node = element.firstChild, text = document.createRange();
    text.setStart(node, offset); text.setEnd(node, offset + length);
    return text.getBoundingClientRect();
  }
  function color(element) {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = getComputedStyle(element).color;
    canvas.fillRect(0, 0, 1, 1);
    return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }
  function mask(element, left, top, right, bottom) {
    return {rect:[left, top, right - left, bottom - top], ink:color(element)};
  }
  function textWidth(css, text) {
    canvas.font = [css.fontStyle, css.fontWeight, css.fontSize, css.fontFamily].join(" ");
    if ("letterSpacing" in canvas) canvas.letterSpacing = css.letterSpacing === "normal" ? "0px" : css.letterSpacing;
    return canvas.measureText(text).width;
  }
  async function readMasks(regions, text) {
    const scale = devicePixelRatio;
    const receipt = await post("ink-raster", {regions, scale});
    if (receipt.error) throw Error(JSON.stringify({...receipt, scale, viewport:[innerWidth, innerHeight], regions}));
    const [left, right] = receipt.masks;
    if ([left, right].some(m => m.count < 8 * scale || m.contrast < 30))
      throw Error("Missing visible glyph ink: " + JSON.stringify({text, receipt}));
    return {baseline:(right.last - left.last) / scale, top:(right.first - left.first) / scale, left, right, text};
  }
  function fieldMask(field, text, sample = text) {
    const css = getComputedStyle(field), r = box(field), start = text.indexOf(sample);
    if (start < 0 || !sample) throw Error("Missing field text: " + sample);
    const left = r.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const right = r.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
    const align = css.textAlign, width = textWidth(css, text), rtl = css.direction === "rtl";
    const rightAligned = align === "right" || (rtl ? align === "start" : align === "end");
    const origin = rightAligned ? right - width : align === "center" ? (left + right - width) / 2 : left;
    const x1 = origin + textWidth(css, text.slice(0, start));
    const x2 = origin + textWidth(css, text.slice(0, start + sample.length));
    // Inset the vertical mask past borders and curves, and horizontally past
    // neighbouring glyphs of a sampled suffix or any select adornment.
    return mask(field, x1 - (sample === text ? 1 : 0), r.top + 3, Math.min(right + 1, x2 + 1), r.bottom - 3);
  }
  function baselineMarker() {
    const marker = document.createElement("span");
    marker.style.cssText = "all:initial;display:inline-block;width:0;height:0;vertical-align:baseline;overflow:hidden";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
  function reference(caption, field, text, help) {
    const marker = baselineMarker(), end = baselineMarker();
    const copy = document.createElement("span"), css = getComputedStyle(field);
    const surface = caption.closest("dialog[open]") || document.body;
    const title = range(caption), r = box(field), surfaceBox = box(surface);
    // Keep the reference on a separate line so a long sample cannot cover the
    // live value or caption. An integer shift preserves the backing-pixel grid.
    const offset = r.top - Math.max(0, surfaceBox.top) > 64 ? -36 : 36;
    const captionBefore = JSON.stringify(title.toJSON()), fieldBefore = bounds(field);
    copy.style.cssText = "all:initial;position:fixed;display:block;z-index:2147483647;white-space:pre;pointer-events:none;background:#fff;color:#000;padding:6px 16px";
    copy.style.font = css.font;
    copy.style.fontVariantNumeric = css.fontVariantNumeric;
    copy.style.letterSpacing = css.letterSpacing;
    copy.style.left = Math.max(6, surfaceBox.left + 6) + "px";
    copy.style.top = r.top + "px";
    copy.setAttribute("aria-hidden", "true");
    copy.append(text, end);
    caption.append(marker);
    surface.append(copy);
    try {
      let baseline = box(marker).top;
      if (help) {
        // Preferences centers the value beside the caption and its help as a group.
        // Get its intended baseline from the text column, independently of the field.
        const label = box(caption), detail = box(help);
        const groupTop = Math.min(label.top, detail.top), groupBottom = Math.max(label.bottom, detail.bottom);
        baseline += (groupTop + groupBottom - label.top - label.bottom) / 2;
      }
      copy.style.top = (r.top + baseline - box(end).top + offset) + "px";
      if (bounds(field) !== fieldBefore || JSON.stringify(range(caption).toJSON()) !== captionBefore)
        throw Error("Reference changed live caption or control geometry");
      const ink = range(copy);
      return {mask:mask(copy, ink.left - 2, ink.top - 1, ink.right + 2, ink.bottom + 1), offset,
        remove() { marker.remove(); copy.remove(); }};
    } catch (error) {
      marker.remove(); copy.remove();
      throw error;
    }
  }

  async function compare(field, caption, options = {}) {
    const text = value(field);
    if (!text) throw Error("Live field value was empty: " + field.getAttribute("aria-label"));
    let ref;
    try {
      if (options.suffix) {
        const offset = caption.textContent.indexOf(options.suffix);
        if (offset < 0) throw Error("Caption lost matching glyphs: " + options.suffix);
        const r = range(caption, offset, options.suffix.length);
        ref = {mask:mask(caption, r.left, r.top, r.right, r.bottom)};
      } else {
        ref = reference(caption, field, text, options.help);
      }
      await wait(36);
      const result = await readMasks([ref.mask, fieldMask(field, text, options.suffix)], text);
      const offset = ref.offset || 0;
      return {...result, baseline:result.baseline + offset, top:result.top + offset};
    } finally {
      ref?.remove?.();
    }
  }
  async function check(scene, label, measure, expected = 0) {
    let result;
    try {
      result = await measure();
      if (result.baseline !== expected) {
        const name = scene.toLowerCase().replace(/\W+/g, "-") + "-" + label.toLowerCase().replace(/\W+/g, "-");
        await post("shot", {name:"field-text-" + name});
      }
      await log(result.baseline === expected, scene + " " + label, {expected, ...result});
    } catch (error) {
      await log(false, scene + " " + label, {error:String(error)});
    }
  }
  async function shifted(field, measure, offset) {
    const saved = field.style.cssText, original = bounds(field);
    try {
      // With an explicit border-box height, asymmetric padding moves only the
      // native text. Two pixels of extra padding shift the center by one.
      field.style.paddingBlockStart = offset > 0 ? "2px" : "0";
      field.style.paddingBlockEnd = offset < 0 ? "2px" : "0";
      if (bounds(field) !== original) throw Error("Regression control displaced the field box: " + original + " → " + bounds(field));
      return await measure();
    } finally { field.style.cssText = saved; }
  }

  async function exercise(scene) {
    const select = await live('#inspector select[aria-label="Component class filter"]');
    const caption = select.closest("label").querySelector("span");
    const read = () => compare(select, caption, {suffix:"ass"});
    await check(scene, "Inspector Class select", read);
    for (const offset of [-1, 1]) await check(scene, "Inspector text-only " + offset, () => shifted(select, read, offset), offset);

    const preferences = AtriumPrefs.open("general");
    try {
      // Opening Settings may first paint an interim page while lazy providers
      // register. Let the requested page settle before measuring its rows.
      await wait(120);
      for (const [id, label] of [
        ["prf-general-language", "Preferences Language select"],
        ["prf-general-autosaveMinutes", "Preferences Autosave number"]
      ]) {
        const measure = async offset => {
          const field = await live("#" + id, preferences);
          const caption = await live("label[for=" + id + "]", preferences);
          const help = await live("#" + id + "-help", preferences);
          field.scrollIntoView({block:"nearest"});
          const read = () => compare(field, caption, {help});
          return offset ? shifted(field, read, offset) : read();
        };
        await check(scene, label, () => measure(0));
        for (const offset of [-1, 1]) await check(scene, label + " text-only " + offset, () => measure(offset), offset);
      }
    } finally { AtriumPrefs.close(); }

    host().act("find-replace");
    const find = await live(".fr-dialog[open]");
    try {
      await check(scene, "Find and Replace text field", async () => {
        const field = await live(".fr-find", find);
        field.blur();
        field.value = "Sensor";
        return compare(field, field.closest("label").querySelector("span"));
      });
      await check(scene, "Find and Replace Scope select", async () => {
        const field = await live('select[aria-label="Scope"]', find);
        return compare(field, field.closest("label").querySelector("span"));
      });
    } finally {
      const close = find.querySelector(".fr-close");
      if (close && box(close).height > 0) await click(close);
      else { find.close(); find.remove(); }
    }

    host().act("footprint-wizard");
    const wizard = await live(".fw-dialog[open]");
    try {
      await check(scene, "Footprint Wizard combobox and preset", async () => {
        const combo = await live('[role="combobox"]', wizard);
        const preset = await live('select[aria-label="Preset"]', wizard);
        combo.blur();
        // These are vertically paired, with separate captions above. Match the
        // displayed text in both real controls without applying any form edit.
        combo.value = value(preset);
        const text = value(preset);
        if (!text || box(combo).top !== box(preset).top) throw Error("Fixture control row is not aligned");
        return readMasks([fieldMask(preset, text), fieldMask(combo, text)], text);
      });
    } finally { wizard.close(); }
  }

  async function run() {
    const nativeScale = devicePixelRatio, settings = AtriumTheme.get();
    let tested = 0;
    try {
      await AtriumI18n.setLocale("en");
      await click(await live("dialog.sp-dialog[open] [data-start-action=demo]"));
      await until(() => host().project().name === "Sensor interface" && !document.querySelector("dialog.sp-dialog[open]"), "Try the Demo did not open");
      if (host().doc().kind !== "pcb") await click(await live('#document-tabs [data-kind="pcb"]'));
      await until(() => host().doc().kind === "pcb", "Sensor board did not open");
      for (const theme of ["light", "dark"]) {
        AtriumTheme.set({preset:theme, followSystem:false, motion:"off"}, {persist:false});
        for (const scale of [1, 2]) {
          const scene = theme + " " + scale + "×";
          if (devicePixelRatio !== scale && !await post("ink-raster-scale", {scale})) {
            await post("note", {text:scene + " WebKit backing scale unavailable (native scale " + nativeScale + ")"});
            continue;
          }
          await until(() => devicePixelRatio === scale, "WebKit devicePixelRatio did not reach " + scale);
          await exercise(scene);
          tested++;
        }
      }
      if (!tested) throw Error("No WebKit raster scale was tested");
    } catch (error) {
      await log(false, "WebKit field text raster ran", {error:String(error?.stack || error)});
    } finally {
      await post("ink-raster-scale", {scale:0});
      AtriumTheme.set(settings, {persist:false});
    }
  }
  return {run};
})();
