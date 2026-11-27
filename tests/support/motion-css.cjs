"use strict";

const fs = require("node:fs");
const path = require("node:path");

const syntax = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[(){};\[\]]/g;
const delimiter = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[(),\s]/g;
const numeric = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(ms|s|deg|rad|turn|px|em|rem|%)?$/i;
const movement = new Set(["transform", "translate", "scale", "rotate", "offset-distance", "offset-position"]);

function readStyles(app, explicitFiles) {
  function files(dir) {
    return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? files(file) : entry.isFile() && entry.name.endsWith(".css") ? [file] : [];
    });
  }
  return new Map((explicitFiles ?? files(app)).sort().map(file => [
    file.slice(app.length + 1).split(path.sep).join("/"), fs.readFileSync(file, "utf8"),
  ]));
}

function declarations(file, input) {
  const source = input.replace(syntax, lexeme => lexeme.startsWith("/*") ? lexeme.replace(/[^\n]/g, " ") : lexeme);
  const rules = [], stack = [];
  let start = 0, depth = 0, line = 1;
  for (const match of source.matchAll(syntax)) {
    const token = match[0], end = match.index;
    if (token === "(" || token === "[") depth++;
    if (token === ")" || token === "]") depth--;
    if (depth || !["{", "}", ";"].includes(token)) continue;
    const segment = source.slice(start, end);
    if (token === "{") stack.push(segment.trim().replace(/\s+/g, " "));
    else {
      const declaration = /^\s*((?:--)?[\w-]+)\s*:\s*(\S[\s\S]*)$/.exec(segment);
      if (declaration && stack.length) {
        const field = declaration[1];
        rules.push({file, line:line + (segment.slice(0, segment.indexOf(field)).match(/\n/g)?.length ?? 0),
          stack:[...stack], property:field.startsWith("--") ? field : field.toLowerCase().replace(/^-(?:webkit|moz|o)-/, ""),
          value:declaration[2].replace(/\s*!\s*important\s*$/i, "").trim()});
      }
      if (token === "}") stack.pop();
    }
    start = end + 1;
    line += segment.match(/\n/g)?.length ?? 0;
  }
  return rules;
}

// Both comma-separated CSS lists and whitespace-separated shorthands contain nested functions.
function split(value, separator) {
  const pieces = [];
  let start = 0, depth = 0;
  for (const match of value.matchAll(delimiter)) {
    const token = match[0];
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (depth || !(separator === "," ? token === "," : /^\s$/.test(token))) continue;
    const piece = value.slice(start, match.index).trim();
    if (piece) pieces.push(piece);
    start = match.index + 1;
  }
  const tail = value.slice(start).trim();
  if (tail) pieces.push(tail);
  return pieces;
}

function expand(value, variables, includeFallback = true, seen = new Set()) {
  const call = /\bvar\(/i.exec(value);
  if (!call) return [value];
  const start = call.index, contents = start + call[0].length;
  let depth = 1, end = contents;
  while (depth && end < value.length) {
    if (value[end] === "(") depth++;
    if (value[end] === ")") depth--;
    end++;
  }
  if (depth) return [value];
  const [name, ...fallback] = split(value.slice(contents, end - 1), ",");
  const choices = seen.has(name) ? [] : [...(variables.get(name) ?? [])];
  if (fallback.length && (includeFallback || !choices.length)) choices.push(fallback.join(","));
  if (!choices.length) choices.push("__unresolved_css_token__");
  const tail = expand(value.slice(end), variables, includeFallback, seen), results = new Set();
  const next = new Set([...seen, name]);
  for (const choice of choices) {
    for (const replacement of expand(choice, variables, includeFallback, next)) {
      for (const rest of tail) results.add(value.slice(0, start) + replacement + rest);
    }
  }
  return [...results];
}

function math(value) {
  const tokens = value.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*|[a-z-]+(?=\()|[^\s]/gi) ?? [];
  let cursor = 0;
  function atom() {
    const token = tokens[cursor++];
    if (token === "+" || token === "-") return (token === "-" ? -1 : 1) * atom();
    if (token === "calc" || token === "(") {
      if (token === "calc" && tokens[cursor++] !== "(") return NaN;
      const result = expression();
      return tokens[cursor++] === ")" ? result : NaN;
    }
    if (["min", "max", "clamp"].includes(token) && tokens[cursor++] === "(") {
      const values = [expression()];
      while (tokens[cursor] === ",") { cursor++; values.push(expression()); }
      if (tokens[cursor++] !== ")") return NaN;
      if (token === "clamp") return values.length === 3 ? Math.max(values[0], Math.min(values[1], values[2])) : NaN;
      return token === "min" ? Math.min(...values) : Math.max(...values);
    }
    const number = numeric.exec(token ?? "");
    if (!number) return NaN;
    const unit = number[1]?.toLowerCase() ?? "";
    return Number(token.slice(0, token.length - unit.length)) * (unit === "s" ? 1000 : 1);
  }
  function term() {
    let amount = atom();
    while (["*", "/"].includes(tokens[cursor])) {
      const op = tokens[cursor++], next = atom();
      amount = op === "*" ? amount * next : amount / next;
    }
    return amount;
  }
  function expression() {
    let amount = term();
    while (["+", "-"].includes(tokens[cursor])) {
      const op = tokens[cursor++], next = term();
      amount = op === "+" ? amount + next : amount - next;
    }
    return amount;
  }
  const result = expression();
  return cursor === tokens.length && Number.isFinite(result) ? result : NaN;
}

const time = /(?:^|[^\w.-])(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:ms|s)\b/i;
const keyframe = /^@(?:-webkit-)?keyframes\s+(.+)$/i;
const typography = /^@font-face\b/i;
const mouse = [/\(\s*hover\s*:\s*hover\s*\)/i, /\(\s*pointer\s*:\s*fine\s*\)/i];
const reducedMedia = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i;
const fullMedia = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i;
const reducedRoot = /:root\[data-motion\s*=\s*["']?reduce["']?\]/i;
const controlMotion = /^(?:animation|transition)(?:-duration|-timing-function|-property|-name)?$/;
const cameraToken = "--motion-slow";
const designCurves = new Set(["--ease-standard", "--ease-decelerate", "--ease-accelerate", "--ease-spring", "--ease-drawer"]);
const frameProperties = new Set([...movement, "opacity", "clip-path", "transform-origin"]);
const transitionProperties = new Set([...frameProperties, "none", "color", "background-color", "border-color", "outline-color",
  "display", "overlay", "visibility"]);
// Decision 1 (2026-11-23): loading indicators may loop past 300 ms. Only these library selectors, and
// only when Reduced and the system setting both hold them still (Off stops every animation).
const loaders = new Set([":is(.ui-spinner)", ":is(.ui-progress)[data-indeterminate]::before"]);
const looping = value => split(value, ",").some(item => split(item, " ").some(word => /^infinite$/i.test(word) || /^(?:\d+\.?\d*|\.\d+)$/.test(word) && Number(word) > 1));
const timingKeywords = /^(?:ease(?:-in|-out|-in-out)?|linear|step-start|step-end|normal|allow-discrete|inherit|initial|unset|revert|revert-layer)$/i;

function mediaRequires(stack, feature) {
  return stack.filter(part => /^@media\b/i.test(part)).some(query => split(query, ",").every(part =>
    part.split(/\bor\b/i).every(branch => !/\bnot\b/i.test(branch) && feature.test(branch))));
}

function transformCalls(value) {
  const result = [];
  for (const match of value.matchAll(/\b([a-z][\w-]*)\(/gi)) {
    if (match[1].toLowerCase() === "calc" || match[1].toLowerCase() === "var") continue;
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    while (depth && end < value.length) {
      if (value[end] === "(") depth++;
      if (value[end] === ")") depth--;
      end++;
    }
    if (depth) continue;
    result.push({name:match[1].toLowerCase(), arguments:split(value.slice(start, end - 1), ",").flatMap(part => split(part, " "))});
  }
  return result;
}

function changesGeometry(property, value) {
  if (value === "none") return false;
  if (property === "transform") {
    return transformCalls(value).some(call => {
      if (call.name.startsWith("scale")) return call.arguments.some(value => math(value) !== (value.includes("%") ? 100 : 1));
      if (call.name.startsWith("rotate")) return math(call.arguments.at(-1)) !== 0;
      if (/^(?:translate|skew)/.test(call.name)) return call.arguments.some(value => math(value) !== 0);
      return true;
    });
  }
  const values = split(value, " ");
  if (property === "rotate") return math(values.at(-1)) !== 0;
  return values.some(value => math(value) !== (property === "scale" ? value.includes("%") ? 100 : 1 : 0));
}

function zeroScale(property, value, inKeyframe) {
  if (property === "scale") return split(value, " ").some(part => math(part) === 0);
  return property === "transform" && transformCalls(value).some(call =>
    (call.name === "scale" || call.name === "scale3d" || inKeyframe && call.name.startsWith("scale")) &&
    call.arguments.some(part => math(part) === 0));
}

function easeIn(word) {
  if (/^ease-(?:in|out)$/i.test(word)) return true;
  const bezier = /^cubic-bezier\(([^)]+)\)$/i.exec(word);
  if (!bezier) return false;
  return ["0.42,0,1,1", "0.3,0,0.8,0.15", "0,0,0.58,1"].includes(bezier[1].split(",").map(Number).join(","));
}

function selectors(rule) {
  return split(rule.stack.filter(part => !part.startsWith("@")).at(-1) ?? "", ",");
}

function inManualReduce(rule) {
  return selectors(rule).some(part => reducedRoot.test(part)) || rule.stack.some(part => /^:root:is\([^)]*\[data-motion\s*=\s*["']?reduce["']?\]/i.test(part));
}

function baseSelector(selector) {
  return selector.replace(reducedRoot, "").replace(/:root:not\(\[data-motion\s*=\s*["']?full["']?\]\)/gi, "").trim();
}

function renderingReduced(rule, uses, rules) {
  if (!uses.length) return false;
  return uses.every(use => selectors(use).every(selector => {
    const reduced = rules.filter(candidate => candidate.file === use.file &&
      ["animation", "animation-name", "animation-duration"].includes(candidate.property) &&
      /^(?:none|0(?:ms|s))$/.test(candidate.value) && selectors(candidate).some(part => baseSelector(part) === selector));
    const system = mediaRequires(rule.stack, fullMedia) || mediaRequires(use.stack, fullMedia) ||
      reduced.some(candidate => mediaRequires(candidate.stack, reducedMedia));
    const manual = reduced.some(inManualReduce);
    return system && manual;
  }));
}

function motionProblems(styles) {
  const rules = [...styles].flatMap(([file, source]) => declarations(file, source));
  const variables = new Map(), problems = new Set();
  const report = (rule, detail) => problems.add(`${rule.file}:${rule.line} ${detail}`);
  for (const {property, value} of rules) {
    if (!property.startsWith("--")) continue;
    if (!variables.has(property)) variables.set(property, new Set());
    variables.get(property).add(value);
  }
  const reducers = rules.filter(rule => rule.property === "--motion-move" && math(rule.value) === 0);
  const gatesMovement = reducers.some(inManualReduce) && reducers.some(rule => mediaRequires(rule.stack, reducedMedia));
  const reducedVariables = new Map(variables);
  reducedVariables.set("--motion-move", new Set(["0"]));
  const animationUses = rules.filter(rule => rule.property === "animation" || rule.property === "animation-name");
  for (const rule of rules) {
    const {stack, property, value} = rule;
    if (property.startsWith("--spring-") || property.startsWith("--ease-") &&
        (!designCurves.has(property) || rule.file !== "style.css" || stack.join(" ") !== ":root")) {
      report(rule, "use the shared easing curve definitions in app/style.css");
    }
    const frame = stack.map(part => keyframe.exec(part)).find(Boolean);
    if (frame && !frameProperties.has(property) && !property.startsWith("--")) {
      report(rule, `keyframe ${frame[1]} animates ${property}; animate opacity, transforms or a clip-path reveal`);
    }
    const moving = movement.has(property);
    if (!controlMotion.test(property) && !moving && property !== "animation-iteration-count") continue;
    if (stack.some(part => typography.test(part))) continue;
    const values = expand(value, variables);
    if (moving && values.some(value => zeroScale(property, value, frame))) report(rule, "scale(0) is forbidden");
    const explicitHover = stack.some(part => !part.startsWith("@") && /:hover(?![\w-])/i.test(part.replace(/"[^"]*"|'[^']*'/g, "")));
    const movesOnHover = moving || property === "transition" || property === "transition-property";
    if (explicitHover && movesOnHover && (moving || values.some(value => split(value, ",").some(part =>
      split(part, " ").some(word => movement.has(word.toLowerCase()))))) && !mouse.every(test => mediaRequires(stack, test))) {
      report(rule, "hover transforms need @media (hover: hover) and (pointer: fine)");
    }
    if (frame && moving) {
      const motion = values.some(value => changesGeometry(property, value));
      const gated = gatesMovement && expand(value, reducedVariables, false).every(value => !changesGeometry(property, value));
      const uses = animationUses.filter(use => expand(use.value, variables)
        .some(value => split(value, ",").some(item => split(item, " ").includes(frame[1]))));
      if (motion && !gated && !renderingReduced(rule, uses, rules)) report(rule, `moving keyframe ${frame[1]} needs a reduced-motion path`);
    }
    if (!controlMotion.test(property) && property !== "animation-iteration-count") continue;
    const loader = rule.file === "ui/components.css" && selectors(rule).every(part => loaders.has(part));
    if ((property === "animation" || property === "animation-iteration-count") && values.some(looping)) {
      if (!loader) report(rule, "only loading indicators (.ui-spinner, .ui-progress[data-indeterminate]) may loop an animation");
      else if (!renderingReduced(rule, [rule], rules)) report(rule, "a looping loader needs a still reduced-motion path");
    }
    if (property === "animation-iteration-count") continue;
    for (const expanded of values) {
      for (const item of split(expanded, ",")) {
        const words = split(item, " ");
        if (property === "transition" || property === "transition-property") {
          const target = words.find(word => /^[a-z-]+$/i.test(word) && !timingKeywords.test(word))?.toLowerCase();
          const disclosure = target === "grid-template-rows" && rule.file === "style.css" && selectors(rule).join(",") === ".ui-collapse";
          if (target === "all") report(rule, "transition: all is forbidden");
          else if (target && !transitionProperties.has(target) && !disclosure) report(rule, `transition property ${target} is forbidden`);
          else if (!target && property === "transition" && words.some(word => time.test(word))) {
            report(rule, "name the transition properties instead of defaulting to all");
          }
        }
        if (words.some(easeIn)) report(rule, "use the approved curve instead of ease-in/ease-out");
        if (!/^(?:animation|transition)(?:-duration)?$/.test(property)) continue;
        const duration = words.find(word => time.test(word));
        if (!duration) continue;
        const amount = math(duration);
        if (!Number.isFinite(amount)) report(rule, `cannot check motion duration ${duration}`);
        // Camera flights read the camera token in app/canvas/camera.js, never in user-interface CSS.
        if (amount >= 300 && !(loader && values.some(looping))) report(rule, `interface duration ${amount}ms must be below 300ms; ${cameraToken} is camera-only`);
      }
    }
  }
  // A transition that moves (transform, translate, scale, rotate) keeps only its fade under Reduced:
  // both Preferences › Motion › Reduce and the system setting must narrow it, or its duration must scale
  // with --motion-move. Off already stops every transition.
  const reducedBase = selector => selector.replace(/^:root:is\([^)]*\)\s*/i, "").replace(reducedRoot, "").replace(/^:root\s+/i, "").trim();
  const narrows = rule => (rule.property === "transition" || rule.property === "transition-property") &&
    !expand(rule.value, variables).some(value => split(value, ",").some(item => split(item, " ").some(word => movement.has(word.toLowerCase()))));
  for (const rule of rules) {
    if (rule.property !== "transition" && rule.property !== "transition-property") continue;
    if (inManualReduce(rule) || mediaRequires(rule.stack, reducedMedia) || rule.stack.some(part => /^@keyframes/i.test(part))) continue;
    if (selectors(rule).some(part => /data-motion|data-efficient/.test(part))) continue;
    const values = expand(rule.value, variables);
    if (!values.some(value => split(value, ",").some(item => split(item, " ").some(word => movement.has(word.toLowerCase()))))) continue;
    if (/--motion-move/.test(rule.value)) continue;
    for (const selector of selectors(rule)) {
      const overrides = rules.filter(candidate => narrows(candidate) && selectors(candidate).some(part => reducedBase(part) === selector));
      const manual = overrides.some(inManualReduce), system = overrides.some(candidate => mediaRequires(candidate.stack, reducedMedia));
      if (!manual || !system) report(rule, `${selector} moves in a transition without ${!manual ? "a [data-motion=reduce]" : "a prefers-reduced-motion"} path that keeps only its fade`);
    }
  }
  return [...problems];
}

module.exports = {declarations, readStyles, motionProblems};
