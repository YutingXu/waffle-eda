"use strict";

const assert = require("node:assert/strict");

// Field text alignment (docs/design-system.md). A same-row caption is centred on its field: the optical centre
// of the caption's text, halfway between its cap line and its baseline, lies on the centre of the field's border
// box. A wrapped caption is centred as one block, from its first line's cap line to its last line's baseline.
// Beside a multiline field (a textarea or a list box) the caption's first line is centred on the field's first
// text line instead. The field centres its own value text; a unit beside the value shares the value's alphabetic
// baseline. Each is measured from rendered text runs, within 0.5 CSS px.
const FIELD_TEXT_CONTROL = [
  "input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=hidden],[type=file],[type=range],[type=color],[type=image])",
  "select", "textarea", ':is([role=combobox],[role=spinbutton],[role=searchbox],[role=textbox]):not(:has(input,select,textarea))',
  "output[aria-labelledby]",
].join(",");

// A Range describes a text run, but its top/bottom are font bounds, not its alphabetic
// baseline. Calibrate that distance with Chromium's inline layout, using the actual text
// and its computed typography. This also works when a caption and value use different fonts.
function textMeasure(text, mirror, clip = null) {
  if (!text || text.nodeType !== 3) return null;
  const start = text.data.search(/\S/), stop = text.data.trimEnd().length;
  if (start < 0 || !text.parentElement) return null;
  const doc = text.ownerDocument, range = doc.createRange();
  range.setStart(text, start); range.setEnd(text, stop);
  const lines = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0 &&
    (!clip || box.top >= clip.top - .5 && box.bottom <= clip.bottom + .5));
  if (!lines.length) return null;
  const first = lines[0], style = doc.defaultView.getComputedStyle(text.parentElement);
  const properties = ["font-family","font-size","font-style","font-weight","font-stretch",
    "font-kerning","font-optical-sizing","font-variant","font-feature-settings",
    "font-variation-settings","font-size-adjust","letter-spacing","text-rendering","text-transform"];
  const css = properties.map(name => [name, style.getPropertyValue(name)]);
  const sample = text.data.slice(start, stop).replace(/\s+/g, " ");
  const key = JSON.stringify([css, sample]);
  const cache = mirror.cache;
  if (!cache.has(key)) {
    const line = doc.createElement("div"), run = doc.createElement("span"), anchor = doc.createElement("span");
    line.style.cssText = "display:block;white-space:pre;line-height:normal";
    for (const [name, value] of css) if (value) line.style.setProperty(name, value);
    run.textContent = sample;
    anchor.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline";
    // The font's cap height: a box trimmed to the cap line above and the alphabetic baseline below is exactly
    // that tall. Without text-box trimming, Canvas measures the ink of a capital H in the same font.
    const cap = doc.createElement("span");
    cap.style.cssText = "display:inline-block;padding:0;margin:0;border:0;line-height:normal;text-box:trim-both cap alphabetic";
    cap.textContent = "H";
    line.append(run, anchor, cap); mirror.shadowRoot.append(line);
    const calibration = doc.createRange(); calibration.selectNodeContents(run.firstChild);
    const offset = anchor.getBoundingClientRect().top - calibration.getBoundingClientRect().top;
    let capHeight = cap.getBoundingClientRect().height;
    if (!CSS.supports("text-box", "trim-both cap alphabetic") || !(capHeight > 0 && capHeight < offset)) {
      const canvas = doc.createElement("canvas").getContext("2d");
      canvas.font = doc.defaultView.getComputedStyle(cap).font;
      capHeight = canvas.measureText("H").actualBoundingBoxAscent;
    }
    cache.set(key, {offset, capHeight});
    line.remove();
  }
  const {offset, capHeight} = cache.get(key), baselines = lines.map(box => box.top + offset);
  return {baseline:baselines[0], lastBaseline:baselines.at(-1), capHeight, text:sample, x:first.left, right:first.right,
    top:first.top, bottom:first.bottom, lastBottom:Math.max(...lines.map(box => box.bottom)), lines:lines.length,
    fontFamily:style.fontFamily, fontSize:style.fontSize};
}

function collect(root, {selector, source}) {
  const doc = root.ownerDocument, id = "waffle-qa-field-text-probe";
  if (doc.getElementById(id)) throw Error("A field text measurement is already in progress.");
  const mirror = doc.createElement("div");
  mirror.id = id;
  mirror.style.cssText = "all:initial;display:block;position:fixed;inset:0 auto auto -100000px;visibility:hidden;pointer-events:none";
  mirror.inert = true;
  mirror.cache = new Map();
  mirror.pairs = [];
  mirror.attachShadow({mode:"open"});
  doc.body.append(mirror);
  const measure = new Function("return " + source)();
  // Hidden accessibility-only captions are still valid names, but supply no painted baseline.
  const excluded = "[hidden],.sr-only,.visually-hidden,.prf-help,.ui-field-unit,.prf-unit,option,optgroup,svg";
  const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility === "visible";
  const paintsChildren = node => node && (visible(node) || getComputedStyle(node).display === "contents");
  const inSurface = node => visible(node) &&
    (!node.closest("dialog,[role=dialog]") || node.closest("dialog,[role=dialog]").contains(root) ||
      node.closest("dialog,[role=dialog]") === root);
  function painted(node, control, exclude = excluded) {
    if (!paintsChildren(node)) return null;
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode, parent = text.parentElement;
      if (!paintsChildren(parent) || parent.closest(exclude) || (control && control.contains(parent))) continue;
      const result = measure(text, mirror);
      if (result) return {...result, node:parent, textNode:text};
    }
    return null;
  }
  function caption(node) {
    const explicit = [...(node.labels || [])].map(label => [label, "HTML label"]);
    const ids = node.getAttribute("aria-labelledby")?.trim().split(/\s+/) || [];
    explicit.push(...ids.map(id => [doc.getElementById(id), "ARIA label"]));
    const row = node.closest(".prf-row,.field-row,.ui-field-row,.ui-prop-row,.thp-field,.fw-row");
    if (row) explicit.push([row.querySelector(".prf-label,label,.field-label,.thp-label,.fw-label") || row.firstElementChild, "field row caption"]);
    const cell = node.closest("td,th");
    if (cell) {
      explicit.push(...(cell.getAttribute("headers")?.split(/\s+/) || []).map(id => [doc.getElementById(id), "table heading"]));
      explicit.push([cell.parentElement.querySelector("th[scope=row],th:not([scope])"), "table row heading"]);
      const column = [...cell.parentElement.cells].slice(0,cell.cellIndex).reduce((sum,cell) => sum + cell.colSpan,0);
      const table = cell.closest("table");
      for (const header of [...(table.tHead?.rows || [])].reverse()) {
        let start = 0;
        for (const headerCell of header.cells) {
          if (headerCell.tagName === "TH" && column >= start && column < start + headerCell.colSpan) {
            explicit.push([headerCell, "table heading"]);
            break;
          }
          start += headerCell.colSpan;
        }
      }
    }
    // Several grid forms use a visible sibling caption and give the control the same ARIA
    // name. Use the actual caption text, never the invisible ARIA string as a measurement.
    const tidy = text => text.trim().replace(/\s+/g," ").replace(/[:：]$/,"");
    const name = node.getAttribute("aria-label");
    if (name) {
      for (const field of [node, node.parentElement]) {
        const sibling = field?.previousElementSibling;
        if (sibling?.matches("label,span,dt,th") && tidy(sibling.textContent) === tidy(name)) {
          explicit.push([sibling, "matching visible sibling caption"]);
        }
      }
    }
    for (const [candidate, kind] of explicit) {
      if (!candidate || candidate === node || !root.contains(candidate)) continue;
      const text = painted(candidate, node, excluded + ",button");
      if (text) return {text, candidate, kind};
    }
    return null;
  }
  function flow(control, named) {
    if (named.kind === "table heading") return "stacked";
    if (named.kind === "table row heading") return "inline";
    // Inspect the authored flow, never the measured vertical difference under test.
    let common = named.text.node;
    while (common && !common.contains(control)) common = common.parentElement;
    while (common && getComputedStyle(common).display === "contents") common = common.parentElement;
    if (!common || common.matches("td,th,tr,tbody,table")) return "inline";
    const layout = getComputedStyle(common);
    if (layout.display.includes("flex")) return layout.flexDirection.startsWith("column") ? "stacked" : "inline";
    if (layout.display.includes("grid")) {
      // A control whose cell spans the caption and its help lines centres on the whole row instead.
      let fieldCell = control;
      while (fieldCell.parentElement && fieldCell.parentElement !== common) fieldCell = fieldCell.parentElement;
      if (fieldCell !== common && /^span (?:[2-9]|\d\d)/.test(getComputedStyle(fieldCell).gridRowEnd)) return "centred";
      let captionCell = named.text.node;
      for (let parent = captionCell.parentElement; parent && parent !== common; parent = parent.parentElement) {
        if (getComputedStyle(parent).display !== "contents") captionCell = parent;
      }
      const captionLayout = getComputedStyle(captionCell);
      const fullWidthCaption = captionCell !== common && captionLayout.gridColumnStart === "1" && captionLayout.gridColumnEnd === "-1";
      return fullWidthCaption || layout.gridTemplateColumns.trim().split(/\s+/).length === 1 ? "stacked" : "inline";
    }
    let prefix = named.text.node;
    while (prefix.parentElement && prefix.parentElement !== common && common.contains(prefix.parentElement)) prefix = prefix.parentElement;
    let field = control;
    while (field.parentElement && field.parentElement !== common) field = field.parentElement;
    if ([prefix, field].some(node => node !== common && getComputedStyle(node).display === "block")) return "stacked";
    return "inline";
  }
  const serializable = entry => {
    if (!entry) return null;
    const {node, textNode, ...metrics} = entry;
    return metrics;
  };
  return [...root.querySelectorAll(selector)].filter(inSurface).map((node, index) => {
    node.dataset.fieldTextControl = index;
    const native = node.matches("input,select,textarea"), box = node.getBoundingClientRect();
    const optionList = node.matches('select[multiple],select[size]:not([size="1"])');
    const segmented = node.matches('input[type=date],input[type=time],input[type=month],input[type=week],input[type=datetime-local]');
    let value = node.matches("select") ? node.selectedOptions[0]?.label : node.value || node.placeholder;
    let probed = false;
    if (node.matches("input,textarea") && !value && !segmented) {
      node.value = node.type === "number" ? "7" : "Waffle";
      value = node.value;
      if (value) { probed = true; node.dataset.fieldTextProbeValue = ""; }
    }
    const named = caption(node), structure = named ? flow(node, named) : null;
    let centreOffset = null;
    if (structure === "centred") {
      let row = named.text.node;
      while (row && !row.contains(node)) row = row.parentElement;
      const outer = row.getBoundingClientRect(), field = (node.closest(".prf-stepper") || node).getBoundingClientRect();
      centreOffset = field.top + field.height / 2 - (outer.top + outer.height / 2);
    }
    const unitScope = node.closest(".ui-field-measure,.prf-step-value");
    const unit = unitScope && painted(unitScope.querySelector(".ui-field-unit,.prf-unit"), node, "[hidden],.sr-only,.visually-hidden");
    const stepper = node.closest(".prf-stepper"), frame = stepper ? stepper.getBoundingClientRect() : box;
    mirror.pairs[index] = {control:node, frame:stepper || node, caption:named?.text.textNode, unit:unit?.textNode};
    const boxData = {top:frame.top,bottom:frame.bottom,left:frame.left,right:frame.right};
    const family = segmented ? "segmented" : node.matches("select") ? "native-select" :
      node.matches("textarea") ? "textarea" : node.matches('input[type=number],input[inputmode=decimal]') ? "numeric" :
      native ? "text-edit" : node.matches("output") ? "output" : node.matches('[role=combobox]') ? "custom-combo" :
        "custom-" + node.getAttribute("role");
    const options = optionList ? [...node.selectedOptions].map(option => measure(option.firstChild, mirror)).filter(Boolean) : [];
    const nativeOption = optionList && [...node.options].filter(option => {
      const bounds = option.getBoundingClientRect();
      return option.label.trim() && bounds.height && bounds.top >= box.top - .5 && bounds.bottom <= box.bottom + .5;
    }).sort((a,b) => Number(b.selected) - Number(a.selected))[0];
    const optionStyle = nativeOption && getComputedStyle(nativeOption);
    const optionRaster = nativeOption ? {index:nativeOption.index, text:nativeOption.label, box:nativeOption.getBoundingClientRect().toJSON(),
      font:`${optionStyle.fontStyle} ${optionStyle.fontWeight} ${optionStyle.fontSize} ${optionStyle.fontFamily}`,
      fontFamily:optionStyle.fontFamily, fontSize:optionStyle.fontSize} : null;
    const matrix = node.closest(".fw-row")?.querySelectorAll(selector).length > 1;
    return {index, native, value:value || "", segmented, probed, outer:boxData, wrappedEditor:!!stepper,
      multilineField:node.matches("textarea") || optionList,
      label:named?.text.text || node.getAttribute("aria-label") || node.name || node.id || node.placeholder || node.tagName,
      control:node.getAttribute("aria-label") || node.name || node.id || (node.type && node.tagName + "[" + node.type + "]") || node.tagName,
      centreOffset, mode:!named ? "standalone" : structure === "stacked" || structure === "centred" ? structure : unit || matrix ? "compound" :
        named.text.lines > 1 || node.matches("textarea,select[multiple]") ? "multiline" : "inline",
      family, captionSource:named?.kind || "no visible caption", caption:serializable(named?.text), unit:serializable(unit),
      optionRaster, valueText:optionList ? options.find(option => option.top >= box.top - .5 && option.bottom <= box.bottom + .5) || null :
        native ? null : serializable(painted(node,null,excluded + ',[role=listbox]'))};
  });
}

function descendants(node, matches) {
  if (node.nodeType === 3 && matches(node.nodeValue.trim())) return [node];
  return [...(node.shadowRoots || []), ...(node.children || [])].flatMap(child => descendants(child, matches));
}

async function nativeValue(session, item, nativeDeclaration, group) {
  const expression = `document.querySelector('[data-field-text-control="${item.index}"]')`;
  const {result} = await session.send("Runtime.evaluate", {expression, objectGroup:group});
  if (!result.objectId) return null;
  const {node} = await session.send("DOM.describeNode", {objectId:result.objectId, depth:-1, pierce:true});
  const expected = item.value.trim();
  const matches = item.segmented ? text => !!text : text => text === expected ||
    (item.family === "textarea" && !!text && expected.includes(text));
  for (const shadow of node.shadowRoots || []) {
    for (const text of descendants(shadow, matches)) {
      const {object} = await session.send("DOM.resolveNode", {backendNodeId:text.backendNodeId, objectGroup:group});
      const {result:measurement} = await session.send("Runtime.callFunctionOn", {
        objectId:object.objectId, functionDeclaration:nativeDeclaration,
        arguments:[{value:item.index},{value:item.family === "textarea"}], returnByValue:true});
      if (measurement.value) return measurement.value;
    }
  }
  return null;
}

async function nativeOptionInk(page, {text,box,font,fontFamily,fontSize}) {
  // Blink paints a native list box's option text directly. Its <option> has a real
  // visible rectangle but no text Range or shadow text node. Read the painted pixels
  // and calibrate their distance from the baseline with the same text/font in Canvas.
  const clip = {x:Math.ceil(box.left) + 1, y:Math.ceil(box.top),
    width:Math.floor(box.right) - Math.ceil(box.left) - 3, height:Math.floor(box.bottom) - Math.ceil(box.top)};
  if (clip.width <= 4 || clip.height <= 2) return null;
  const image = await page.screenshot({clip, scale:"css"});
  return page.evaluate(async ({image,clip,text,font,fontFamily,fontSize}) => {
    const source = new Image();
    source.src = "data:image/png;base64," + image;
    await source.decode();
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d",{willReadFrequently:true});
    canvas.width = source.width; canvas.height = source.height;
    ctx.drawImage(source,0,0);
    const actual = ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const backgrounds = new Map();
    for (let i = 0; i < actual.length; i += 4) {
      const color = actual[i] * 65536 + actual[i + 1] * 256 + actual[i + 2];
      backgrounds.set(color,(backgrounds.get(color) || 0) + 1);
    }
    const background = [...backgrounds].reduce((a,b) => a[1] > b[1] ? a : b)[0];
    const rgb = [background >> 16, background >> 8 & 255, background & 255];
    function ink(data, width, painted) {
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
      for (let i = 0; i < data.length; i += 4) {
        if (!painted(data,i)) continue;
        const x = i / 4 % width, y = Math.floor(i / 4 / width);
        top = Math.min(top,y); bottom = Math.max(bottom,y); left = Math.min(left,x); right = Math.max(right,x);
      }
      return top < Infinity ? {top,bottom,left,right} : null;
    }
    const a = ink(actual,canvas.width,(data,i) => rgb.some((v,c) => Math.abs(v - data[i + c]) >= 56));
    if (!a) return null;
    canvas.height = 64;
    ctx.font = font; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "black";
    ctx.fillText(text,0,32);
    const reference = ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const b = ink(reference,canvas.width,(data,i) => data[i + 3] >= 80);
    if (!b || Math.abs((a.bottom - b.bottom) - (a.top - b.top)) > 1) return null;
    const baseline = clip.y + a.bottom - b.bottom + 32;
    return {baseline, lastBaseline:baseline, capHeight:ctx.measureText("H").actualBoundingBoxAscent,
      text, x:clip.x+a.left,right:clip.x+a.right+1,
      top:clip.y+a.top,bottom:clip.y+a.bottom+1,lastBottom:clip.y+a.bottom+1,lines:1,fontFamily,fontSize,
      source:"painted native option"};
  },{image:image.toString("base64"),clip,text,font,fontFamily,fontSize});
}

async function measureNativeOption(page, item) {
  const option = item.optionRaster;
  const control = page.locator(`[data-field-text-control="${item.index}"]`);
  const original = await control.evaluateHandle((select, index) => {
    const row = select.options[index];
    const bounds = row.getBoundingClientRect();
    const x = bounds.left + 2;
    const exposed = [bounds.top + 1, bounds.bottom - 1].every(y => document.elementFromPoint(x, y) === row);
    if (exposed) return null;
    const scroll = [];
    for (let ancestor = select.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.scrollHeight > ancestor.clientHeight || ancestor.scrollWidth > ancestor.clientWidth) {
        scroll.push({ancestor, left:ancestor.scrollLeft, top:ancestor.scrollTop});
      }
    }
    select.scrollIntoView({block:"center", inline:"nearest", behavior:"instant"});
    return scroll;
  }, option.index);
  try {
    const box = await control.evaluate((select, index) => {
      const row = select.options[index], bounds = row.getBoundingClientRect();
      const x = bounds.left + 2;
      if (![bounds.top + 1, bounds.bottom - 1].every(y => document.elementFromPoint(x, y) === row)) return null;
      return {left:bounds.left + scrollX, right:bounds.right + scrollX, top:bounds.top + scrollY, bottom:bounds.bottom + scrollY};
    }, option.index);
    if (!box) return null;
    const measured = await nativeOptionInk(page,{...option,box});
    if (!measured) return null;
    // Relate the actual painted text back to the field and caption's original layout.
    const x = option.box.left - box.left, y = option.box.top - box.top;
    return {...measured, x:measured.x + x, right:measured.right + x, top:measured.top + y,
      bottom:measured.bottom + y, lastBottom:measured.lastBottom + y, baseline:measured.baseline + y,
      lastBaseline:measured.lastBaseline + y};
  } finally {
    await original.evaluate(scroll => {
      for (const {ancestor,left,top} of scroll || []) ancestor.scrollTo({left,top,behavior:"instant"});
    });
    await original.dispose();
  }
}

async function measureFieldText(page, session, scope) {
  const objectGroup = "field-text-alignment";
  const nativeDeclaration = `function (index, multiline) {
    const mirror = this.ownerDocument.getElementById("waffle-qa-field-text-probe");
    const pair = mirror.pairs[index], measure = (${textMeasure});
    const valueText = measure(this, mirror, multiline ? pair.control.getBoundingClientRect() : null);
    if (!valueText) return null;
    // Native text is resolved by CDP. Read both text runs in the same layout snapshot
    // because dialog auto-focus and overscroll can move the entire surface between calls.
    const {top,bottom,left,right} = pair.frame.getBoundingClientRect();
    return {valueText, caption:measure(pair.caption,mirror), unit:measure(pair.unit,mirror), outer:{top,bottom,left,right}};
  }`;
  try {
    const items = await scope.evaluate(collect, {selector:FIELD_TEXT_CONTROL, source:textMeasure.toString()});
    await Promise.all(items.map(async item => {
      if (!item.valueText && item.native && (item.value || item.segmented)) {
        const current = await nativeValue(session, item, nativeDeclaration, objectGroup);
        if (current) Object.assign(item,current);
      }
    }));
    // The option raster may temporarily scroll its dialog. Keep those captures
    // sequential and finish measuring DOM-backed text before moving any surfaces.
    for (const item of items) {
      if (!item.valueText && item.optionRaster) item.valueText = await measureNativeOption(page,item);
      item.valueBaseline = item.valueText?.baseline ?? null;
      Object.assign(item, centres(item));
      item.disposition = item.valueText ? "measured" : item.value || item.segmented || !item.native ? "missing painted text" : "empty value";
    }
    return items;
  } finally {
    await session.send("Runtime.releaseObjectGroup", {objectGroup});
    await page.evaluate(() => {
      for (const control of document.querySelectorAll("[data-field-text-control]")) {
        if (control.hasAttribute("data-field-text-probe-value")) {
          control.value = "";
          delete control.dataset.fieldTextProbeValue;
        }
        delete control.dataset.fieldTextControl;
      }
      document.getElementById("waffle-qa-field-text-probe")?.remove();
    });
  }
}

// The optical centre of a run of text is halfway between its cap line and its baseline; a wrapped caption's runs
// from its first line's cap line to its last line's baseline. It is measured from the painted baseline and the
// font's cap height, so it does not depend on the line height or on where the font's rounding puts the leading.
function centres(item) {
  const {caption, valueText, outer} = item;
  if (!caption) return {captionCentre:null, fieldCentre:null, captionOffset:null};
  // An output is read-only text with no field box: the caption reads with it as one line, on its baseline.
  if (item.family === "output") {
    return {captionCentre:caption.baseline, fieldCentre:valueText?.baseline ?? null,
      captionOffset:valueText ? caption.baseline - valueText.baseline : null};
  }
  const capCentre = text => (text.baseline - text.capHeight + (item.multilineField ? text.baseline : text.lastBaseline)) / 2;
  const captionCentre = capCentre(caption);
  // Beside a multiline field the caption's first line is centred on the field's first text line.
  const fieldCentre = item.multilineField ? (valueText ? capCentre(valueText) : null) : (outer.top + outer.bottom) / 2;
  return {captionCentre, fieldCentre, captionOffset:fieldCentre === null ? null : captionCentre - fieldCentre};
}

function fieldTextResults(items) {
  return items.flatMap(item => {
    const {label,control,mode,captionOffset,valueBaseline,captionSource} = item;
    const metric = (kind, actual, expected) => ({kind, label, control, mode, actual, expected,
      captionOffset, valueBaseline, captionSource});
    if (item.disposition === "missing painted text") return [metric("field displayed text measurable", 0, 1)];
    if (item.disposition === "empty value") return [];
    if (mode === "standalone") {
      const {top,bottom} = item.valueText, box = item.outer;
      return [metric("standalone field text contained", Math.max(0, box.top - top, bottom - box.bottom), 0)];
    }
    const results = mode === "centred" ? [metric("field centred on its row", item.centreOffset, 0)] : mode === "stacked" ? [
      metric("stacked field caption precedes value", Number(item.caption.lastBottom <= item.valueText.top + .5), 1),
    ] : [metric(item.family === "output" ? "caption shares the value's baseline" :
      item.multilineField ? "caption centred on first field line" : "caption centred on field", captionOffset, 0)];
    if (item.unit) results.push(metric("field unit text baseline", valueBaseline - item.unit.baseline, 0));
    return results;
  });
}

const CAPTION_METRIC = /^caption (?:centred on field|centred on first field line|shares the value's baseline)$/;

// Proves the checker rejects a one-pixel drift, both ways, on a live pair. "caption" moves the caption's painted
// text, "field" moves the field's box with its text, "unit" moves the unit beside the value, and "value" moves
// the value text inside a stationary box, which only a unit's shared baseline (or a multiline field's first
// line) can catch. Translations move paint without moving the row's layout.
async function assertFieldTextPerturbations(target, measure, {move = "field"} = {}) {
  const original = await measure(), style = await target.getAttribute("style");
  assert.ok(["caption","field","unit","value"].includes(move), "Move the caption, the field, the unit or the value text");
  assert.ok(original?.caption && original.valueText && original.mode !== "stacked", "The live control has both same-row text runs");
  assert.ok(!["unit","value"].includes(move) || original.unit || move === "value" && original.multilineField,
    "Only a unit or a multiline field shares the value text's position");
  const probes = [];
  for (const offset of [1,-1]) {
    try {
      await target.evaluate((node, {offset, native, wrappedEditor, move}) => {
        if (move !== "value" || wrappedEditor) {
          // In a stepper the inner editor moves inside the stationary outer field.
          node.style.translate = `0 ${offset}px`;
          return;
        }
        if (native) {
          const property = "padding-block-" + (offset > 0 ? "start" : "end");
          const before = parseFloat(getComputedStyle(node).getPropertyValue(property));
          node.style.setProperty(property, `${before + 2}px`, "important");
          return;
        }
        const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.data.trim() || !text.parentElement.getClientRects().length) continue;
          const span = node.ownerDocument.createElement("span");
          span.dataset.fieldTextOffsetProbe = "";
          span.style.cssText = `all:unset;position:relative;inset-block-start:${offset}px`;
          text.replaceWith(span); span.append(text);
          return;
        }
      }, {offset,native:original.native,wrappedEditor:original.wrappedEditor,move});
      const shifted = await measure();
      const parts = {caption:"captionCentre", box:null, value:"valueBaseline", ...(original.unit ? {unit:null} : {})};
      const position = (item, part) => part === "box" ? item.outer.top : part === "unit" ? item.unit?.baseline : item[parts[part]];
      const moves = {caption:["caption"], field:["box","value","unit"], unit:["unit"], value:["value"]}[move];
      for (const part of Object.keys(parts)) {
        const moved = position(shifted, part) - position(original, part), expected = moves.includes(part) ? offset : 0;
        assert.ok(Math.abs(moved - expected) <= .125, `Moving the ${move} by ${offset}px should move the ${part} ${expected}px; it moved ${moved}px`);
      }
      const violations = fieldTextResults([shifted]).filter(metric => Math.abs(metric.actual - metric.expected) > .5);
      const catches = ["unit","value"].includes(move) ? metric => metric.kind === "field unit text baseline" || CAPTION_METRIC.test(metric.kind) :
        metric => CAPTION_METRIC.test(metric.kind);
      assert.ok(violations.some(catches), `The caption/field invariant should reject the ${offset}px ${move} shift ` +
        `(${original.label}: ${original.mode}, caption offset ${original.captionOffset} to ${shifted.captionOffset})`);
      const reading = {caption:"captionCentre", field:"fieldCentre", unit:"valueBaseline", value:"valueBaseline"}[move];
      probes.push({label:`${original.label} ${move} ${offset > 0 ? "+" : ""}${offset}px`,
        original:original[reading], perturbed:shifted[reading], captionOffset:shifted.captionOffset, outer:original.outer});
    } finally {
      await target.evaluate((node, value) => {
        if (value === null) node.removeAttribute("style"); else node.setAttribute("style", value);
        for (const probe of node.querySelectorAll("[data-field-text-offset-probe]")) probe.replaceWith(...probe.childNodes);
      }, style);
    }
  }
  return probes;
}

async function assertStackedCaptionPerturbation(caption, measure) {
  const initial = await measure(), style = await caption.getAttribute("style");
  assert.equal(initial.mode,"stacked");
  const gap = initial.valueText.top - initial.caption.lastBottom;
  assert.ok(gap >= -.5, "The declared stack starts with a visible gap");
  const rejected = metrics => metrics.some(metric => metric.kind === "stacked field caption precedes value" && metric.actual !== metric.expected);
  const move = shift => caption.evaluate((node, position) => {
    const transform = getComputedStyle(node).transform;
    node.style.translate = `0 ${position}px`;
    if (transform !== "none") throw Error("The stacked test needs an untransformed production caption.");
  }, shift);
  try {
    await move(gap);
    const touching = await measure();
    assert.ok(!rejected(fieldTextResults([touching])), "Touching painted lines do not overlap");
    await move(gap + 1);
    const overlap = await measure();
    assert.deepEqual(overlap.outer,initial.outer);
    assert.equal(overlap.valueBaseline,initial.valueBaseline);
    assert.ok(rejected(fieldTextResults([overlap])), "One pixel of caption/value overlap must fail");
    return {label:`${initial.label} stacked caption overlap`,baseline:touching.caption.lastBottom,perturbed:overlap.caption.lastBottom};
  } finally {
    await caption.evaluate((node, value) => value === null ? node.removeAttribute("style") : node.setAttribute("style", value), style);
  }
}

module.exports = {measureFieldText, fieldTextResults, assertFieldTextPerturbations, assertStackedCaptionPerturbation, FIELD_TEXT_CONTROL};
