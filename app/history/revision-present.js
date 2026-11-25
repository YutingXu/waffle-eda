"use strict";

globalThis.AtriumRevisionPresent = (() => {
  const join = parts => parts.filter(Boolean).join(" · ");
  const isPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const number = (n, decimals = 0, precision = 6) => {
    let value = Math.abs(n).toFixed(precision);
    if (n && Number(value) === 0) value = String(Number(Math.abs(n).toPrecision(4)));
    else while (value.includes(".") && value.endsWith("0") && value.length - value.indexOf(".") - 1 > decimals) value = value.slice(0,-1);
    return (n < 0 ? "−" : "") + value.replace(/\.$/, "");
  };
  function compact(value) {
    const s = String(value);
    return s.length > 52 ? s.slice(0,35) + "…" + s.slice(-14) : s;
  }
  function textChange(before, after) {
    const left=compact(before), right=compact(after);
    if (left !== right || before === after) return left + " → " + right;
    // Keep the distinguishing characters in view when both long values share a prefix and suffix.
    let at=0;
    while (at < before.length && before[at] === after[at]) at++;
    const start=Math.max(0,at-12);
    const window=s=>(start ? "…" : "") + s.slice(start,at+20) + (s.length>at+20 ? "…" : "");
    return window(before) + " → " + window(after);
  }
  const unit = label => label === "Rotation" ? "°" : " mm";
  function numericChange(left, right, suffix, decimals = 0) {
    let precision = 6;
    let x = number(left,decimals), y = number(right,decimals);
    while (x === y && left !== right && precision < 16) {
      x = number(left,decimals,++precision);
      y = number(right,decimals,precision);
    }
    if (x === y && left !== right) [x,y] = [String(left),String(right)];
    return x + " → " + y + suffix;
  }
  const mm = n => Number.isFinite(n) ? number(n,2) + " mm" : "";
  const signed = n => (n > 0 ? "+" : "") + number(n);
  const movement = (dx,dy) => "Δx " + signed(dx) + ", Δy " + signed(dy) + " mm";
  const pointText = p => "(" + number(p[0]) + ", " + number(p[1]) + ")";
  const count = (n,noun,plural = noun + "s") => globalThis.AtriumI18n?.plural?.(n, noun, plural) ?? n + " " + (n === 1 ? noun : plural);
  const scalar = (v,key) => v == null ? "Unset" : v === "" ? key === "net" ? "No net" : "Empty" : String(v);

  function title(data, entry, type) {
    if (type !== "item") return compact(entry.name);
    const net = data.net ? compact(data.net) + " " : "";
    switch (data.kind) {
      case "part": return data.ref ? compact(data.ref) : "Component";
      case "track": return join([net ? net + "track" : "Track", data.layer]);
      case "via": return join([net ? net + "via" : "Via", data.fromLayer && data.toLayer ? data.fromLayer + "–" + data.toLayer : ""]);
      case "pad": return join([data.number ? "Pad " + compact(data.number) : "Pad", data.net && compact(data.net), data.layer]);
      case "netlabel": return data.text ? "Net label " + compact(data.text) : "Net label";
      case "label": return data.text ? "Text “" + compact(data.text) + "”" : "Text";
      case "wire": return net ? net + "wire" : "Wire";
      default: return compact(entry.name);
    }
  }
  function description(data, defs, type) {
    if (type === "definition") return join([data.symbol?.pins && count(data.symbol.pins.length,"pin"),data.footprint?.name]);
    if (type === "block" || type === "document") return count(data.items.length,"object");
    if (type === "sourceRule") return join([data.RULEKIND, data.SCOPE1EXPRESSION && compact(data.SCOPE1EXPRESSION)]);
    if (type === "rules") return data.defaults && Number.isFinite(data.defaults.clearance) ? "Default clearance " + mm(data.defaults.clearance) : "";
    if (type !== "item") return "";
    const at = isPoint([data.x,data.y]) ? pointText([data.x,data.y]) + " mm" : "";
    switch (data.kind) {
      case "part": {
        const definition=defs.get(data.def);
        const name=typeof definition === "string" ? definition : definition?.name;
        return join([name && compact(name), data.value !== name && data.value && compact(data.value), data.layer]);
      }
      case "track": return join([mm(data.width) && mm(data.width) + " wide", count(Math.max(0,data.points.length-1),"segment")]);
      case "via": return join([mm(data.diameter) && "Ø " + mm(data.diameter), mm(data.drill) && "Drill " + mm(data.drill), at]);
      case "wire": return join([count(Math.max(0,data.points.length-1),"segment"), isPoint(data.points[0]) && "From " + pointText(data.points[0]) + " mm"]);
      case "pad": return join([Number.isFinite(data.w) && Number.isFinite(data.h) && number(data.w) + " × " + mm(data.h), at]);
      default: return join([at,data.layer]) || (data.points && count(data.points.length,"vertex","vertices")) || "";
    }
  }
  function routeChange(left,right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return "";
    if (left.length !== right.length) return "Vertices " + left.length + " → " + right.length;
    let changed = 0, first = 0, dx, dy, translated = true;
    for (let i=0; i<left.length; i++) {
      if (!isPoint(left[i]) || !isPoint(right[i])) return "";
      const x = right[i][0]-left[i][0], y = right[i][1]-left[i][1];
      if (x === 0 && y === 0) continue;
      if (!changed) { first=i; dx=x; dy=y; }
      const xEpsilon=4*Number.EPSILON*Math.max(Math.abs(left[i][0]),Math.abs(right[i][0]),Math.abs(left[first][0]),Math.abs(right[first][0]));
      const yEpsilon=4*Number.EPSILON*Math.max(Math.abs(left[i][1]),Math.abs(right[i][1]),Math.abs(left[first][1]),Math.abs(right[first][1]));
      if (Math.abs(x-dx)>xEpsilon || Math.abs(y-dy)>yEpsilon) translated=false;
      changed++;
    }
    if (!changed) return "";
    if (translated && changed === left.length) return movement(dx,dy);
    if (changed === 1) {
      const label = first === 0 ? "Start" : first === left.length-1 ? "End" : "Vertex " + (first+1);
      const oldPoint = pointText(left[first]), newPoint = pointText(right[first]);
      if (oldPoint === newPoint) return label + " " + movement(dx,dy);
      return label + " " + oldPoint + " → " + newPoint + " mm";
    }
    return changed + " vertices moved";
  }
  const rawNames = {MINLIMIT:"Minimum", MAXLIMIT:"Maximum", PREFERREDWIDTH:"Preferred width", MINHOLEWIDTH:"Minimum drill", MAXHOLEWIDTH:"Maximum drill", GAP:"Clearance", ENABLED:"Enabled", SCOPE1EXPRESSION:"Scope 1", SCOPE2EXPRESSION:"Scope 2", RULEKIND:"Rule kind", NAME:"Name"};
  function fieldText(field, data, type) {
    if (type === "sourceRule" && field.label === "Source record") return "Source rule text changed";
    const parts = field.label.split(" · ");
    let label = Object.hasOwn(rawNames,field.label) ? rawNames[field.label] : field.label.replace(/ · Pads · Pad /g," · Pad ").replace(/ · Pins · Pin /g," · Pin ");
    if (data.RULEKIND === "Width" && ["MINLIMIT","MAXLIMIT"].includes(field.label)) label += " width";
    if (parts[0] === "Board defaults") label = "Default " + parts.slice(1).join(" · ").toLowerCase();
    if (parts[0] === "Net overrides" && parts.length > 2) label = parts.slice(1).join(" · ");
    const measure = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|mil|in|inch|um|µm|°)$/i;
    const a = field.before.match(measure), b = field.after.match(measure);
    const quantity = /(?:width|drill|diameter|clearance|height|rotation|grid|thickness|radius|minimum|maximum)$/i.test(label);
    if (quantity && a && b && a[2] === b[2] && Number(a[1]) !== Number(b[1])) {
      const suffix = a[2] === "°" ? "°" : " " + a[2];
      return label + " " + numericChange(Number(a[1]),Number(b[1]),suffix,a[2] === "mm" ? 2 : 0);
    }
    return label + " " + textChange(field.before,field.after);
  }

  const itemFields = [
    ["ref","Designator"], ["value","Value"], ["net","Net"], ["layer","Layer"], ["width","Width"],
    ["diameter","Diameter"], ["drill","Drill"], ["angle","Rotation"], ["text","Text"],
    ["fromLayer","Start layer"], ["toLayer","End layer"]
  ];
  const measures = new Set(["width","diameter","drill","angle"]);
  function *changeSummary(result,row,type) {
    const left = row.previous.data, right = row.next.data;
    if (Array.isArray(row.order)) {
      yield count(row.order.length,"position") + " reordered";
      return;
    }
    if (Array.isArray(left.order) && Array.isArray(right.order)) {
      yield "Reordered list of " + count(right.order.length,"entry","entries");
      return;
    }
    const skipped = new Set(row.next.skip);
    const differentDoc = row.previous.doc !== row.next.doc;
    if (differentDoc) yield "Document " + row.previous.docName + " → " + row.next.docName;
    if (type === "item") {
      for (const [key,label] of itemFields) {
        skipped.add(key);
        if (left[key] === right[key]) continue;
        const before = left[key], after = right[key];
        if (measures.has(key)) {
          const suffix=unit(label), decimals=key==="angle"?0:2;
          const withUnit = v => Number.isFinite(v) ? number(v,decimals)+suffix : scalar(v,key);
          yield label + " " + (Number.isFinite(before) && Number.isFinite(after) ? numericChange(before,after,suffix,decimals) : withUnit(before)+" → "+withUnit(after));
        } else yield label + " " + textChange(scalar(before,key),scalar(after,key));
      }
      if (isPoint([left.x,left.y]) && isPoint([right.x,right.y])) {
        skipped.add("x");skipped.add("y");
        if (left.x !== right.x || left.y !== right.y) yield movement(right.x-left.x,right.y-left.y);
      }
      if (["track","wire"].includes(right.kind) && Array.isArray(left.points) && Array.isArray(right.points)) {
        skipped.add("points");
        const route=routeChange(left.points,right.points);
        if (route) yield route;
      }
    }
    // Reuse the canonical field iterator for unhandled properties, library pads, source rules and per-net rule overrides.
    // Only inspect enough differences to fill the summary. Expanded details remain exact and complete.
    for (const f of AtriumRevisionReview.fields(result,{...row,next:{...row.next,skip:skipped}})) {
      if (differentDoc && f.label === "Document" || skipped.has("x") && f.label === "Position") continue;
      yield fieldText(f,right,type);
    }
  }
  function row(result, change) {
    const entry = change.next || change.previous, type = JSON.parse(change.key)[0];
    const data = entry.data, context = change.documentName || change.area;
    let detail;
    if (change.previous && change.next) {
      const parts=[];
      for (const line of changeSummary(result,change,type)) {
        if (parts.length === 2) {parts.push("…");break;}
        parts.push(line);
      }
      detail=join(parts);
    } else detail=description(data,change.next ? result.newDefs : result.oldDefs,type);
    return {title:title(data,entry,type), detail, context};
  }
  return {row};
})();
