"use strict";

const assert = require("node:assert/strict");
const {textBaselines, baselineResults, assertBaselinePerturbations, assertStackedCaptionPerturbation,
  BASELINE_CONTROL} = require("./field-text-baselines.cjs");
const FIELD = "input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=hidden],[type=file],[type=range],[type=color],[type=image]),select:not([multiple]),[role=combobox]:not(:has(input,select))";
const TOLERANCE = 0.5;

function near(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= TOLERANCE;
}

function closestText(node, matches) {
  if (node.nodeType === 3 && matches(node.nodeValue.trim())) return [node];
  return [...(node.shadowRoots || []), ...(node.children || [])].flatMap(child => closestText(child, matches));
}

async function nativeTextRect(session, {index, value, date}) {
  const expression = `document.querySelector('[data-geometry-field="${index}"]')`;
  const {result} = await session.send("Runtime.evaluate", {expression, objectGroup: "field-geometry"});
  if (!result.objectId) throw Error("The field changed while its text was being measured.");
  const {node} = await session.send("DOM.describeNode", {objectId: result.objectId, depth: -1, pierce: true});
  // For a native input or select, measure the browser's rendered selection/value text.
  // An authored <option> is not the displayed value, and padding alone misses UA insets.
  // Dates render localized segments even when empty. Measure the first rendered segment.
  const matches = date ? text => !!text : text => text === value.trim();
  for (const root of node.shadowRoots || []) {
    for (const textNode of closestText(root, matches)) {
      const {object} = await session.send("DOM.resolveNode", {backendNodeId: textNode.backendNodeId, objectGroup: "field-geometry"});
      const {result: rect} = await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function () {
          const range = this.ownerDocument.createRange();
          range.selectNodeContents(this);
          const b = range.getBoundingClientRect();
          return b.width > 0 && b.height > 0 ? {x:b.x,y:b.y,width:b.width,height:b.height} : null;
        }`,
      });
      if (rect.value) return rect.value;
    }
  }
  return null;
}

async function fields(page, session, scope) {
  const items = await scope.evaluate((root, selector) => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
    const textRect = node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) return {x:box.x, y:box.y, width:box.width, height:box.height};
      }
      return null;
    };
    const groups = new WeakMap();
    let nextGroup = 0;
    function group(element) {
      if (!groups.has(element)) groups.set(element, ++nextGroup);
      return groups.get(element);
    }
    const toggle = "input[type=checkbox],input[type=radio],[role=switch]";
    const hasControl = element => element.matches(selector) || element.matches(toggle) ||
      !!element.querySelector(`${selector},${toggle}`);
    function column(node) {
      if (node.closest(".prf-stepper")) return "preference numeric editors";
      if (node.closest(".prf-control")) return "preference controls";
      const named = node.closest("[data-ui-field-column]");
      if (named) return `declared ${named.dataset.uiFieldColumn}`;
      if (node.matches("input[type=search]") && !node.closest("label") &&
          node.parentElement.querySelector(":scope > .work-form")) return `standalone form search ${group(node.parentElement)}`;
      const landmark = node.closest("aside[aria-label],[role=toolbar][aria-label],[role=region][aria-label],.work-toolbar");
      const layout = landmark && root.contains(landmark) ? landmark : root;
      const cell = node.closest("td,th"), table = cell?.closest("table");
      if (table && layout.contains(table)) {
        const left = [...cell.parentElement.cells].slice(0, cell.cellIndex).reduce((n, previous) => n + previous.colSpan, 0);
        return `table ${group(table)} column ${left}`;
      }
      for (let child = node; child !== layout && child.parentElement; child = child.parentElement) {
        const parent = child.parentElement, style = getComputedStyle(parent);
        const items = () => [...parent.children].filter(item => visible(item) && hasControl(item));
        if (style.display.includes("grid")) {
          const widths = style.gridTemplateColumns.split(" ").map(parseFloat);
          if (widths.length < 2 || widths.some(width => !Number.isFinite(width)) || items().length < 2) continue;
          const explicit = parseInt(getComputedStyle(child).gridColumnStart, 10);
          if (explicit > 0) return `grid ${group(parent)} column ${explicit - 1}`;
          const inset = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
          const gap = parseFloat(style.columnGap) || 0, start = parent.getBoundingClientRect().left + inset;
          const left = child.getBoundingClientRect().left;
          const stops = widths.map((_, i) => start + widths.slice(0,i).reduce((sum,width) => sum + width + gap,0));
          const index = stops.reduce((best, value, i) => Math.abs(left - value) < Math.abs(left - stops[best]) ? i : best, 0);
          return `grid ${group(parent)} column ${index}`;
        }
        if (style.display.includes("flex") && style.flexDirection.startsWith("row")) {
          const siblings = items();
          if (siblings.length > 1) return `inline row ${group(parent)} column ${siblings.indexOf(child)}`;
        }
      }
      const section = node.closest("fieldset,section,[role=group],[role=region],form");
      if (section && layout.contains(section)) return `form group ${group(section)}`;
      return layout === root ? "dialog fields" : `dialog landmark ${group(layout)}`;
    }
    return [...root.querySelectorAll(selector)].filter(node => visible(node) &&
      (!node.closest("dialog,[role=dialog]") || node.closest("dialog,[role=dialog]") === root ||
        node.closest("dialog,[role=dialog]").contains(root))).map((node, index) => {
      node.dataset.geometryField = index;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      const stepper = node.closest(".prf-stepper");
      const visualField = stepper ? stepper.getBoundingClientRect() : box;
      const visualBorder = stepper ? parseFloat(getComputedStyle(stepper).borderLeftWidth) : parseFloat(style.borderLeftWidth);
      const valueEnd = stepper ? (style.direction === "rtl" ? box.left : box.right) : null;
      const native = node.matches("input,select"), number = node.matches("input[type=number]"), date = node.matches("input[type=date]");
      let value = node.matches("select") ? node.selectedOptions[0]?.label : node.value || node.placeholder;
      let probe = false;
      if (native && node.matches("input") && !value && !date) {
        node.value = number ? "7" : "Waffle";
        value = node.value;
        probe = true;
      }
      let search = null;
      if (node.matches(".ui-search > input.ui-field[type=search]")) {
        const magnifier = node.parentElement.querySelector(":scope > .icon");
        const icon = magnifier && visible(magnifier) ? magnifier.getBoundingClientRect() : null;
        search = {left:icon?.left, right:icon?.right, width:icon?.width, height:icon?.height,
          rightBorder:parseFloat(style.borderRightWidth)};
      }
      let palette = null;
      if (node.matches("#palette > .nav-palette-query > input[role=combobox][aria-controls=nav-palette-list]")) {
        const header = node.parentElement, icon = header.querySelector(":scope > .nav-palette-search-icon");
        const previous = [...header.children].slice(0, [...header.children].indexOf(node)).filter(visible).at(-1);
        const touch = matchMedia("(any-pointer:coarse)").matches || node.closest("#palette").dataset.palettePointer === "touch";
        const x = box.left + Math.min(32,box.width / 2);
        const edges = [box.top + 1, box.bottom - 1].map(y => Number(document.elementFromPoint(x, y) === node));
        palette = {fontSize:parseFloat(style.fontSize), systemFont:Number(/(?:system-ui|-apple-system|BlinkMacSystemFont|Segoe UI)/i.test(style.fontFamily)),
          transparent:Number(style.backgroundColor === "rgba(0, 0, 0, 0)"),
          border:Math.max(...["Top","Right","Bottom","Left"].map(side => parseFloat(style[`border${side}Width`]))),
          gap:previous ? box.left - previous.getBoundingClientRect().right : null,
          headerInset:visible(icon) ? icon.getBoundingClientRect().left - header.getBoundingClientRect().left : null,
          center:box.top + box.height / 2, iconCenter:visible(icon) ? icon.getBoundingClientRect().top + icon.getBoundingClientRect().height / 2 : null,
          hitEdges:Math.min(...edges), touch};
      }
      return {index, name:node.getAttribute("aria-label") || node.labels?.[0]?.textContent?.trim() || node.name || node.id || node.tagName,
        native, value, probe, date, column:column(node), text:native ? null : textRect(node), height:visualField.height, width:visualField.width, x:visualField.x,
        leftBorder:visualBorder, valueEnd, direction:style.direction, unitNumber:number && !stepper && !!node.parentElement.querySelector(".ui-field-unit,[data-field-unit]"),
        search, palette};
    });
  }, FIELD);
  try {
    await Promise.all(items.map(async field => {
      if (field.native && (field.value || field.date)) field.text = await nativeTextRect(session, field);
    }));
    return items;
  } finally {
    await session.send("Runtime.releaseObjectGroup", {objectGroup: "field-geometry"});
    await page.evaluate(probes => {
      for (const node of document.querySelectorAll("[data-geometry-field]")) {
        if (probes.includes(Number(node.dataset.geometryField))) node.value = "";
        delete node.dataset.geometryField;
      }
    }, items.filter(item => item.probe).map(item => item.index));
  }
}

function fieldResults(items) {
  const metrics = [], columns = new Map();
  for (const item of items.filter(item => !item.palette && item.valueEnd === null)) {
    const column = columns.get(item.column) || [];
    column.push(item);
    columns.set(item.column, column);
  }
  for (const item of items) {
    if (item.palette) {
      const {fontSize, systemFont, transparent, border, gap, headerInset, center, iconCenter, hitEdges, touch} = item.palette;
      const checks = [
        ["text size", fontSize, 20],
        ["system font", systemFont, 1],
        ["transparent editor", transparent, 1],
        ["borderless editor", border, 0],
        ["editor inset", item.text?.x - item.x, 0],
        ["search header inset", headerInset, 12],
        ["search element gap", gap, 8],
        ["optical icon center", iconCenter, center],
        ["rendered text line center", item.text?.y + item.text?.height / 2, center],
        ["editor hit area", item.height, touch ? 48 : 42],
      ];
      if (touch) checks.push(["touchable editor edges", hitEdges, 1]);
      metrics.push(...checks.map(([kind, actual, expected]) => ({kind:`palette ${kind}`, label:item.name, actual, expected})));
      continue;
    }
    metrics.push({kind:"field height", label:item.name, actual:item.height, expected:28});
    if (item.search) {
      const {search, text, x, width, leftBorder} = item, rtl = item.direction === "rtl";
      const border = rtl ? search.rightBorder : leftBorder;
      const inset = rtl ? x + width - (text?.x + text?.width) : text?.x - x;
      const iconInset = rtl ? x + width - search.right : search.left - x;
      const gap = rtl ? search.left - (text?.x + text?.width) : text?.x - search.right;
      const checks = [
        ["icon inset", iconInset, 8],
        ["icon width", search.width, 16],
        ["icon height", search.height, 16],
        ["icon-to-text gap", gap - border, 4],
        ["text inset", inset - border, 28],
      ];
      metrics.push(...checks.map(([kind, actual, expected]) => ({kind:`search field ${kind}`, label:item.name, actual, expected})));
    } else if (item.valueEnd === null) {
      metrics.push({kind:"field text inset", label:item.name, actual:item.text?.x - item.x - item.leftBorder, expected:8});
    } else {
      const end = item.direction === "rtl" ? item.text?.x : item.text?.x + item.text?.width;
      metrics.push({kind:"stepper text end", label:item.name, actual:end, expected:item.valueEnd});
    }
    const column = columns.get(item.column);
    if (column?.length > 1) metrics.push({kind:"field text column", label:item.name, actual:item.text?.x, expected:column[0].text?.x,
      column:item.column});
    if (item.unitNumber) metrics.push({kind:"number with external unit", label:item.name, actual:item.width, expected:80});
  }
  return metrics;
}

async function preferenceGeometry(page, {narrow = false} = {}) {
  return page.locator(".prf-page").evaluate((page, narrow) => {
    const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility === "visible";
    const box = node => node.getBoundingClientRect();
    const metric = (kind, label, actual, expected) => ({kind, label, actual, expected});
    const textRects = node => {
      const rectangles = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.data.trim() || !visible(text.parentElement)) continue;
        const start = text.data.search(/\S/), end = text.data.trimEnd().length;
        const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end);
        rectangles.push(...[...range.getClientRects()].filter(rect => rect.width && rect.height));
      }
      return rectangles;
    };
    const controlSelector = ".prf-control,.prf-check > label > input[role=switch]";
    const name = page.getAttribute("aria-label"), controls = [...page.querySelectorAll(controlSelector)].filter(visible);
    const right = controls.length ? box(controls[0]).right : null;
    const rows = [...page.querySelectorAll(".prf-row")].filter(visible);
    const result = [];
    function fits(text, boundary) {
      return text.every(rect => rect.left >= boundary.left - .5 && rect.right <= boundary.right + .5 &&
        rect.top >= boundary.top - .5 && rect.bottom <= boundary.bottom + .5);
    }
    for (const row of rows) {
      const control = row.querySelector(controlSelector), help = row.querySelector(".prf-help");
      const label = row.querySelector(".prf-label,label");
      const caption = label?.textContent.trim() || row.dataset.search || name;
      const controlBox = visible(control) ? box(control) : null;
      const labelBoxes = visible(label) ? textRects(label) : [];
      const helpBoxes = visible(help) ? textRects(help) : [];
      if (controlBox) {
        if (!narrow && control.matches(".prf-control")) result.push(metric("preference control column width", caption, controlBox.width, 240));
        result.push(metric("preference control trailing edge", caption, controlBox.right, right));
        if (labelBoxes.length && !narrow) result.push(metric("preference label left of control", caption,
          Number(labelBoxes.every(rect => rect.right <= controlBox.left - .5)), 1));
      }
      if (labelBoxes.length && helpBoxes.length) {
        const labelStart = Math.min(...labelBoxes.map(rect => rect.left));
        const helpStart = Math.min(...helpBoxes.map(rect => rect.left));
        result.push(metric("preference help starts at its left label", caption, helpStart, labelStart));
        result.push(metric("preference help follows the label", caption,
          Number(helpBoxes[0].top >= Math.max(...labelBoxes.map(rect => rect.bottom)) - .5), 1));
        if (!narrow) {
          const sharedLine = Math.min(...helpBoxes.map(rect => rect.bottom)) - Math.max(...helpBoxes.map(rect => rect.top));
          let fitsOnOneLine = true;
          if (sharedLine <= .5) {
            const width = box(help).width, current = help.style.getPropertyValue("white-space");
            const priority = help.style.getPropertyPriority("white-space");
            try {
              help.style.setProperty("white-space", "nowrap", "important");
              const unwrapped = textRects(help);
              fitsOnOneLine = Math.max(...unwrapped.map(rect => rect.right)) - Math.min(...unwrapped.map(rect => rect.left)) <= width + .5;
            } finally {
              if (current) help.style.setProperty("white-space", current, priority);
              else help.style.removeProperty("white-space");
            }
          }
          if (fitsOnOneLine) result.push(metric("preference one-line help", caption, Number(sharedLine > .5), 1));
        }
      }
      if (labelBoxes.length) result.push(metric("preference label unclipped", caption, Number(fits(labelBoxes, box(row))), 1));
      if (helpBoxes.length) {
        const slot = box(help), end = Math.max(...helpBoxes.map(rect => rect.right));
        const overflow = Math.max(0,end - slot.right);
        result.push({...metric("preference help overflow", caption, overflow, 0), available:slot.width});
        if (overflow <= .5) {
          const phrase = help.textContent.trim();
          const duplicates = [help.getAttribute("title"),help.getAttribute("data-tooltip")]
            .some(detail => detail?.trim() === phrase);
          result.push(metric("preference visible help does not duplicate a tooltip", caption, Number(!duplicates), 1));
        }
        if (controlBox && !narrow) result.push(metric("preference help left of control", caption,
          Number(Math.min(end,slot.right) <= controlBox.left - .5), 1));
      }
      const unit = row.querySelector(".prf-stepper .prf-unit"), stepper = unit?.closest(".prf-stepper");
      if (visible(unit) && visible(stepper)) {
        const marks = textRects(unit), outer = box(stepper);
        result.push(metric("preference unit inside numeric control", caption, Number(marks.length > 0 && fits(marks, outer)), 1));
        const buttons = [...stepper.querySelectorAll("button")].filter(visible);
        result.push(metric("preference numeric step buttons", caption, buttons.length, 2));
      }
    }
    if (page.dataset.shown === "keyboard") {
      const actions = [...page.querySelectorAll(".prf-link > .prf-button:only-of-type")].filter(visible);
      result.push(metric("preference keyboard actions", name, Number(actions.length >= 3), 1));
      for (const action of actions) {
        const caption = action.textContent.trim(), help = action.parentElement.querySelector(".prf-help");
        result.push(metric("preference keyboard action trailing edge", caption, box(action).right, right));
        if (visible(help)) result.push(metric("preference keyboard help left of action", caption,
          Number(box(help).right <= box(action).left - .5), 1));
      }
    }
    const groups = [...page.querySelectorAll(".prf-group,.thp-group")].filter(visible);
    for (const group of groups) {
      const heading = group.querySelector(":scope > .prf-heading,:scope > .thp-heading,:scope > legend");
      const bodyRows = rows.filter(row => row.closest(".prf-group") === group);
      const title = heading?.textContent.trim() || name;
      // No cards or rules between sections: the space above a heading separates it from the previous list.
      let previous = group.previousElementSibling;
      while (previous && !visible(previous)) previous = previous.previousElementSibling;
      if (visible(heading) && previous && !previous.matches(".prf-content-head")) {
        result.push(metric("preference section gap", title, box(heading).top - box(previous).bottom, 32));
      }
      // The first list under the heading; a toolbar on the heading's own line (Color theme) sits beside it, not below.
      const beside = node => visible(heading) && box(node).left >= box(heading).right - .5;
      const content = [...group.children].find(node => node !== heading && visible(node) && !node.matches("hr,.prf-divider") && !beside(node));
      if (visible(heading) && content) result.push(metric("preference heading to list", title, box(content).top - box(heading).bottom, 8));
      for (const node of [...group.children].filter(node => node !== heading && visible(node) && beside(node)))
        result.push(metric("preference heading toolbar shares its line", title,
          Number(Math.abs((box(node).top + box(node).bottom) / 2 - (box(heading).top + box(heading).bottom) / 2) <= 1), 1));
      // Section headings share the page title's start edge (no card inset).
      const pageTitle = page.querySelector(".prf-page-title");
      if (visible(heading) && visible(pageTitle)) result.push(metric("preference heading starts at the page title", title, box(heading).left, box(pageTitle).left));
      for (let i = 1; i < bodyRows.length; i++) {
        const row = bodyRows[i], previous = bodyRows[i - 1];
        // Rows share hairlines: no gap between neighbours in any list.
        const expected = 0;
        result.push(metric("preference row gap", title, box(row).top - box(previous).bottom, expected));
      }
    }
    return {name, rows:rows.length, groups:groups.length, result};
  }, narrow);
}

async function keyListGeometry(scope) {
  return scope.evaluate(root => {
    const listMetrics = [];
    const visible = node => node?.getClientRects().length && getComputedStyle(node).visibility === "visible";
    function textX(node) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect();
        if (rect.width) return rect.left;
      }
      return null;
    }
    for (const list of root.querySelectorAll("dl:has(.ui-shortcut)")) {
      const columns = [];
      const termsAreKeys = !!list.querySelector(":scope > dt > .ui-shortcut");
      if (!termsAreKeys && !list.querySelector(":scope > dd > .ui-shortcut")) continue;
      for (const term of list.querySelectorAll(":scope > dt")) {
        const description = term.nextElementSibling;
        if (!visible(term) || !visible(description) || description.tagName !== "DD") continue;
        const binding = termsAreKeys ? term : description, explanation = termsAreKeys ? description : term;
        const key = binding.querySelector(":scope > .ui-shortcut");
        if (!key) continue;
        columns.push({key:key.getBoundingClientRect().left, description:textX(explanation), label:explanation.textContent.trim()});
      }
      if (!columns.length) continue;
      const first = columns[0];
      for (const row of columns) for (const column of ["key", "description"]) {
        listMetrics.push({kind:`shortcut ${column} column`, label:row.label, actual:row[column], expected:first[column]});
      }
    }
    return listMetrics;
  });
}

async function dialogSections(scope) {
  return scope.evaluate(root => {
    const groups = [...root.querySelectorAll("section,fieldset,[role=group]")];
    const visible = node => node?.getClientRects().length && getComputedStyle(node).visibility === "visible";
    const result = [];
    for (const section of groups) {
      const heading = section.querySelector(":scope > h3,:scope > h4,:scope > legend,:scope > .ui-section-heading");
      const next = heading?.nextElementSibling, previous = section.previousElementSibling;
      if (!visible(heading) || !visible(next) || !visible(previous)) continue;
      if (!previous.matches("hr,.ui-divider") && !parseFloat(getComputedStyle(previous).borderBottomWidth)) continue;
      const box = heading.getBoundingClientRect(), before = previous.getBoundingClientRect(), current = section.getBoundingClientRect();
      if (Math.min(before.right,current.right) - Math.max(before.left,current.left) <= .5) continue;
      result.push({kind:"dialog divider spacing", label:heading.textContent.trim(),
        actual:box.top - before.bottom, expected:next.getBoundingClientRect().top - box.bottom,
        relation:"greater"});
    }
    return result;
  });
}

function failures(metrics) {
  return metrics.filter(({actual, expected, relation}) => relation === "greater" ? !(actual > expected + TOLERANCE) : !near(actual, expected));
}

async function assertPerturbation(locator, label, mutate, measure) {
  const baseline = await measure(), style = await locator.getAttribute("style");
  assert.ok(Number.isFinite(baseline), `A measured baseline is needed for ${label}`);
  try {
    await mutate();
    const perturbed = await measure();
    assert.ok(near(Math.abs(perturbed - baseline), 1) && !near(perturbed, baseline),
      `${label}: a one-pixel physical perturbation must fail (${baseline} to ${perturbed})`);
    return {label, baseline, perturbed};
  } finally {
    await locator.evaluate((node, previous) => previous === null ? node.removeAttribute("style") : node.setAttribute("style", previous), style);
  }
}

async function changesByPixel(locator, property, measure, label = property) {
  const original = await locator.evaluate((node, name) => parseFloat(getComputedStyle(node).getPropertyValue(name)), property);
  assert.ok(Number.isFinite(original), `A numeric computed value is needed to perturb ${property}`);
  return assertPerturbation(locator, label, () => locator.evaluate((node, [name, value]) => {
    node.style.setProperty(name, `${value}px`, "important");
  }, [property, original + 1]), measure);
}

async function shiftsByPixel(locator, axis, measure, label) {
  return assertPerturbation(locator, label, () => locator.evaluate((node, axis) => {
    const original = getComputedStyle(node).transform;
    node.style.setProperty("transform", `${original === "none" ? "" : original} translate${axis}(1px)`, "important");
  }, axis), measure);
}

module.exports = {FIELD, near, fields, fieldResults, textBaselines, baselineResults, assertBaselinePerturbations,
  assertStackedCaptionPerturbation, BASELINE_CONTROL,
  preferenceGeometry, keyListGeometry, dialogSections, failures, changesByPixel, shiftsByPixel};
