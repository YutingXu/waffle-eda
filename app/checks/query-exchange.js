"use strict";
// Format-specific spelling only. Evaluation, units, case comparison, bindings and three-valued
// logic belong to AtriumDesignQuery. The source map is transient and never enters a rule.
globalThis.AtriumQueryExchange = (() => {
  const MAX_LENGTH = 2000, MAX_TOKENS = 600, MAX_DEPTH = 40, MAX_STRING = 256, MAX_ARGS = 8;

  class QueryError extends Error {
    constructor(message, at = -1) {super(message); this.name = "QueryError"; this.at = at;}
  }

  // ------------------------------------------------------------------ tokens
  const UNITS = {mm:1, mil:.0254, mils:.0254, th:.0254, thou:.0254, in:25.4, inch:25.4, cm:10, um:.001, "µm":.001, deg:null};
  const KEYWORDS = new Set(["and", "or", "not", "like", "true", "false"]);
  const isIdStart = c => c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 95 || c === 181;
  const isId = c => isIdStart(c) || c >= 48 && c <= 57;
  const isDigit = c => c >= 48 && c <= 57;
  function tokenize(text) {
    if (typeof text !== "string") throw new QueryError("The query must be text.");
    if (text.length > MAX_LENGTH) throw new QueryError("The query is longer than " + MAX_LENGTH + " characters.", MAX_LENGTH);
    const out = [];
    let i = 0;
    const push = tok => {if (out.length >= MAX_TOKENS) throw new QueryError("The query has more than " + MAX_TOKENS + " parts.", tok.at); out.push(tok);};
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {i++; continue;}
      const at = i;
      if (isDigit(c) || c === 46 && isDigit(text.charCodeAt(i + 1))) {
        while (isDigit(text.charCodeAt(i))) i++;
        if (text.charCodeAt(i) === 46) {i++; while (isDigit(text.charCodeAt(i))) i++;}
        if ((text.charCodeAt(i) | 32) === 101 && (isDigit(text.charCodeAt(i + 1)) || (text[i + 1] === "-" || text[i + 1] === "+") && isDigit(text.charCodeAt(i + 2)))) {
          i += 2; while (isDigit(text.charCodeAt(i))) i++;
        }
        const raw = text.slice(at, i), num = Number(raw);
        if (!Number.isFinite(num)) throw new QueryError("Number out of range.", at);
        // An optional unit, attached or after spaces.
        let j = i; while (text.charCodeAt(j) === 32) j++;
        let k = j; while (k < text.length && isId(text.charCodeAt(k))) k++;
        const word = text.slice(j, k).toLowerCase();
        if (k > j && Object.hasOwn(UNITS, word)) {
          i = k; const f = UNITS[word];
          push({t:"num", v:f == null ? num : num * f, unit:word, raw, at, end:i});
        } else {
          if (k > j && j === i) throw new QueryError("Unknown unit " + text.slice(j, k) + ".", j);
          push({t:"num", v:num, unit:"", raw, at, end:i});
        }
        continue;
      }
      if (isIdStart(c)) {
        while (i < text.length && isId(text.charCodeAt(i))) i++;
        const v = text.slice(at, i), lower = v.toLowerCase();
        push(KEYWORDS.has(lower) ? {t:"kw", v:lower, at} : {t:"id", v, at});
        continue;
      }
      if (c === 39 || c === 34) {
        const q = text[i]; let s = ""; i++;
        for (;;) {
          if (i >= text.length) throw new QueryError("Text is missing its closing quote.", at);
          if (text[i] === q) {if (text[i + 1] === q) {s += q; i += 2; continue;} i++; break;}
          s += text[i++];
          if (s.length > MAX_STRING) throw new QueryError("Text longer than " + MAX_STRING + " characters.", at);
        }
        push({t:"str", v:s, at, end:i});
        continue;
      }
      const two = text.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "==" || two === "&&" || two === "||") {
        i += 2; push(two === "&&" ? {t:"kw", v:"and", at} : two === "||" ? {t:"kw", v:"or", at} : {t:"op", v:two === "==" ? "=" : two === "!=" ? "<>" : two, at});
        continue;
      }
      const one = text[i];
      if (one === "<" || one === ">" || one === "=") {i++; push({t:"op", v:one, at}); continue;}
      if (one === "!") {i++; push({t:"kw", v:"not", at}); continue;}
      if (one === "(" || one === ")" || one === ",") {i++; push({t:one, at}); continue;}
      throw new QueryError("Unexpected character " + JSON.stringify(one) + ".", at);
    }
    return out;
  }

  const PREDICATES = canon(["All", "IsTrack", "IsArc", "IsVia", "IsPad", "IsComponent", "IsPolygon", "IsRegion", "IsFill", "IsText", "IsKeepout",
    "IsWire", "IsBus", "IsNetLabel", "IsPort", "IsPowerPort", "IsSheetSymbol", "IsJunction", "IsPin", "IsLocked", "IsThruHole", "IsSMD", "OnTop", "OnBottom",
    "IsSOIC", "IsLCC", "IsBGA", "IsSMDPad", "IsTHPad", "IsTeardrop", "IsDiffPair", "InAnyNet", "InPolygon", "OnSignal", "OnMid", "OnOutside", "OnMultiLayer"],
    {ispart:"IsComponent", isstring:"IsText", ispower:"IsPowerPort", isthroughhole:"IsThruHole", issmt:"IsSMD", ispolygonpour:"IsPolygon", istoplayer:"OnTop", isbottomlayer:"OnBottom", ontoplayer:"OnTop", onbottomlayer:"OnBottom",
     isthpad:"IsTHPad", isthruholepad:"IsTHPad", isthroughholepad:"IsTHPad", issmtpad:"IsSMDPad", isdifferentialpair:"IsDiffPair", inanydifferentialpair:"IsDiffPair",
     inanypolygon:"InPolygon", onsignallayer:"OnSignal", onmidlayer:"OnMid", onoutsidelayer:"OnOutside", onmulti:"OnMultiLayer"});
  const FUNCTIONS = canon(["InNet", "InNetClass", "InComponent", "InComponentClass", "OnLayer", "InDifferentialPair", "InDifferentialPairClass", "HasFootprint", "OnSheet",
    "InNamedPolygon", "InRoom", "HasPad", "InxSignal", "InxSignalClass", "InSignal", "HasTag"],
    {insignalname:"InSignal", intag:"HasTag", indiffpair:"InDifferentialPair", indiffpairclass:"InDifferentialPairClass", inpart:"InComponent", ondocument:"OnSheet", inpolygonnamed:"InNamedPolygon", withinroom:"InRoom"});
  // Functions with more than one argument: [min, max]. Every other function takes one.
  const ARITY = {HasPad:[1, 2]};
  const PROPERTIES = canon(["CompPinCount", "Width", "HoleSize", "PadIsPlated", "Diameter", "Layer", "Net", "Designator", "Comment", "Footprint", "Name", "Text", "X", "Y", "Rotation", "Length", "Kind", "Locked", "Side", "PinNumber", "Signal", "Polarity"],
    {hole:"HoleSize", drill:"HoleSize", holediameter:"HoleSize", size:"Diameter", viadiameter:"Diameter", ref:"Designator", value:"Comment", objectkind:"Kind", angle:"Rotation", pin:"PinNumber", padnumber:"PinNumber", netname:"Net"});
  function canon(list, aliases) {const m = new Map(list.map(n => [n.toLowerCase(), n])); for (const [k, v] of Object.entries(aliases)) m.set(k, v); return m;}
  const NAMES = () => ({predicates:[...new Set(PREDICATES.values())], functions:[...new Set(FUNCTIONS.values())], properties:[...new Set(PROPERTIES.values())]});

  // ------------------------------------------------------------------ parser
  function parse(text) {
    const toks = tokenize(text);
    let p = 0, depth = 0;
    const peek = () => toks[p], end = () => text.length;
    const at = () => toks[p]?.at ?? end();
    const isKw = v => toks[p]?.t === "kw" && toks[p].v === v;
    const enter = () => {if (++depth > MAX_DEPTH) throw new QueryError("The query is nested more than " + MAX_DEPTH + " levels deep.", at());};
    function expect(t, what) {if (toks[p]?.t !== t) throw new QueryError("Expected " + what + (toks[p] ? " here." : " at the end."), at()); return toks[p++];}
    // Depth counts parentheses and Not, which are the only ways to recurse.
    function or() {
      const list = [and()];
      while (isKw("or")) {p++; list.push(and());}
      return list.length === 1 ? list[0] : {t:"or", a:list};
    }
    function and() {
      const list = [not()];
      while (isKw("and")) {p++; list.push(not());}
      return list.length === 1 ? list[0] : {t:"and", a:list};
    }
    function not() {
      if (!isKw("not")) return compare();
      const start = toks[p++].at; enter(); const node = {t:"not", a:not(), at:start}; depth--;
      return node;
    }
    function compare() {
      const left = operand();
      const tok = peek();
      let op = null;
      if (tok?.t === "op") op = tok.v; else if (tok?.t === "kw" && tok.v === "like") op = "like";
      if (!op) {
        if (left.t === "prop") throw new QueryError(left.name + " is a property: compare it, as in " + left.name + " = 'x'.", left.at);
        if (left.t === "lit") throw new QueryError("A value on its own is not a condition.", left.at);
        return left;
      }
      p++;
      const right = operand();
      if (left.t==="pos" && right.t==="lit" && op==="=" && right.v===1 && !right.unit) return {...left,t:"prefix",end:right.end};
      if (left.t === "prop" && right.t === "lit") return {t:"cmp", op, prop:left.name, sourceUnit:left.sourceUnit, value:right, at:left.at, fieldEnd:left.end, end:right.end};
      if (right.t === "prop" && left.t === "lit" && op !== "like") return {t:"cmp", op:{"<":">", ">":"<", "<=":">=", ">=":"<="}[op] || op, prop:right.name, sourceUnit:right.sourceUnit, value:left, at:right.at, fieldEnd:right.end, end:right.end};
      throw new QueryError("Compare a property with a value, as in Width < 0.2mm.", tok.at);
    }
    function value() {
      const tok = peek();
      if (!tok) throw new QueryError("Expected a value at the end.", end());
      if (tok.t === "num") {p++; return {t:"lit", v:tok.v, unit:tok.unit, raw:tok.raw, at:tok.at, end:tok.end};}
      if (tok.t === "str") {p++; return {t:"lit", v:tok.v, at:tok.at, end:tok.end ?? tok.at + String(tok.v).length};}
      if (tok.t === "kw" && (tok.v === "true" || tok.v === "false")) {p++; return {t:"lit", v:tok.v === "true", at:tok.at, end:tok.at + tok.v.length};}
      // A bare word as a function argument: OnLayer(TopLayer).
      if (tok.t === "id") {p++; return {t:"lit", v:tok.v, at:tok.at, end:tok.end ?? tok.at + String(tok.v).length};}
      throw new QueryError("Expected a value here.", tok.at);
    }
    function operand() {
      const tok = peek();
      if (!tok) throw new QueryError("The query ends too early.", end());
      if (tok.t === "(") {
        p++; enter(); const e = or(); depth--;
        expect(")", "a closing parenthesis");
        return e;
      }
      if (tok.t === "id") {
        p++;
        const lower = tok.v.toLowerCase();
        if (peek()?.t === "(") {
          p++;
          if (lower==="pos") {
            const first=peek();if(first?.t!=="str" && first?.t!=="id")throw new QueryError("Expected a text field or literal in Pos.",at());
            p++;expect(",","a comma");const second=peek();
            if(!second || !["id","str"].includes(second.t) || first.t===second.t)throw new QueryError("Pos needs one field and one text literal.",at());
            p++;const end=expect(")","a closing parenthesis").at+1;
            const field=first.t==="id" ? first : second,literal=first.t==="str" ? first : second,prop=PROPERTIES.get(field.v.toLowerCase());
            if(!["Name","Comment","Text"].includes(prop))throw new QueryError("No verified text field for this Pos predicate.",field.at);
            return {t:"pos",name:"Pos",prop,value:literal,direction:first.t==="str" ? "literal-first" : "field-first",field,at:tok.at,end};
          }
          if (lower === "asmm" || lower === "asmils") {
            const field = expect("id", "a length field"), name = PROPERTIES.get(field.v.toLowerCase());
            if (!["Width","HoleSize","Diameter","X","Y","Length"].includes(name)) throw new QueryError("A length field is required.", field.at);
            const end = expect(")", "a closing parenthesis").at + 1;
            return {t:"prop",name,sourceUnit:lower === "asmm" ? "mm" : "mil",at:tok.at,end};
          }
          const fn = FUNCTIONS.get(lower) || PREDICATES.get(lower);
          if (!fn) throw new QueryError("Unknown function " + tok.v + ".", tok.at);
          const args = [];
          if (peek()?.t !== ")") for (;;) {
            if (args.length >= MAX_ARGS) throw new QueryError("Too many arguments.", at());
            args.push(value());
            if (peek()?.t === ",") {p++; continue;}
            break;
          }
          expect(")", "a closing parenthesis");
          if (FUNCTIONS.has(lower)) {
            const [lo, hi] = ARITY[fn] || [1, 1];
            if (args.length < lo || args.length > hi) throw new QueryError(hi === 1 ? fn + " takes one argument, as in " + fn + "('x')." : fn + " takes " + lo + " to " + hi + " arguments, as in " + fn + "('U1', '1').", tok.at);
            return {t:"fn", name:fn, arg:String(args[0].v), args:args.map(a => String(a.v)), literals:args, at:tok.at, end:toks[p-1].at+1};
          }
          if (args.length) throw new QueryError(fn + " takes no arguments.", tok.at);
          return {t:"pred", name:fn, at:tok.at, end:toks[p-1].at+1};
        }
        if (PREDICATES.has(lower)) return {t:"pred", name:PREDICATES.get(lower), at:tok.at, end:tok.at + tok.v.length};
        if (PROPERTIES.has(lower)) return {t:"prop", name:PROPERTIES.get(lower), at:tok.at, end:tok.at+tok.v.length};
        if (FUNCTIONS.has(lower)) throw new QueryError(FUNCTIONS.get(lower) + " needs an argument, as in " + FUNCTIONS.get(lower) + "('x').", tok.at);
        throw new QueryError("Unknown name " + tok.v + ".", tok.at);
      }
      if (tok.t === "num" || tok.t === "str" || tok.t === "kw" && (tok.v === "true" || tok.v === "false")) return value();
      throw new QueryError(tok.t === ")" ? "Unexpected closing parenthesis." : "Expected a condition here.", tok.at);
    }
    if (!toks.length) throw new QueryError("The query is empty.", 0);
    const ast = or();
    if (p < toks.length) throw new QueryError(toks[p].t === ")" ? "Unexpected closing parenthesis." : "Expected And or Or here.", toks[p].at);
    return ast;
  }
  const quote = v => "'" + String(v).replace(/'/g, "''") + "'";
  // Canonical text of an AST (for history, rule scopes and the MCP result).
  function print(n, parent = "") {
    switch (n.t) {
      case "or": {const s = n.a.map(x => print(x, "or")).join(" Or "); return parent === "and" || parent === "not" ? "(" + s + ")" : s;}
      case "and": {const s = n.a.map(x => print(x, "and")).join(" And "); return parent === "not" ? "(" + s + ")" : s;}
      case "not": return "Not " + print(n.a, "not");
      case "pred": return n.name;
      case "fn": return n.name + "(" + (n.args || [n.arg]).map(quote).join(", ") + ")";
      case "prefix": return "Pos("+(n.direction==="literal-first" ? quote(n.value.v)+", "+n.prop : n.prop+", "+quote(n.value.v))+") = 1";
      case "cmp": {
        const v = n.value, lit = typeof v.v === "number" ? (v.unit && v.unit !== "deg" ? String(v.v) + "mm" : String(v.v)) : typeof v.v === "boolean" ? (v.v ? "True" : "False") : quote(v.v);
        const field=n.sourceUnit ? (n.sourceUnit==="mm" ? "AsMM(" : "AsMils(")+n.prop+")" : n.prop;
        return field + " " + (n.op === "like" ? "Like" : n.op) + " " + lit;
      }
    }
    return "";
  }
  const kinds = {
    IsTrack:["track"], IsArc:["arc"], IsVia:["via"], IsPad:["pad"], IsComponent:["part"],
    IsPolygon:["polygon"], IsRegion:["region"], IsFill:["fill"], IsText:["label","text","textframe"],
    IsKeepout:["keepout"], IsWire:["wire"], IsBus:["bus","busentry"], IsNetLabel:["netlabel"],
    IsPort:["port","offsheet"], IsPowerPort:["power"], IsSheetSymbol:["sheetsymbol"], IsJunction:["junction"], IsPin:["pin","pad"]
  };
  const fields = {
    Width:"width", HoleSize:"holeDiameter", Diameter:"diameter", PadIsPlated:"plated", CompPinCount:"pinCount",
    Layer:"layer.name", Net:"net.name", Designator:"component.designator", Comment:"comment", Footprint:"footprint",
    Name:"name", Text:"text", X:"x", Y:"y", Rotation:"rotation", Length:"length", Kind:"kind", Locked:"locked",
    Side:"side", PinNumber:"pin.number", Signal:"signal.name", Polarity:"polarity"
  };
  const bools = {IsLocked:"locked", IsThruHole:"throughHole", IsSMD:"smd", IsSMDPad:"smd", IsTeardrop:"teardrop",
    IsDiffPair:"paired", InAnyNet:"hasNet", InPolygon:"inPolygon", OnSignal:"signalLayer", OnMid:"innerLayer", OnOutside:"outerLayer", OnMultiLayer:"multilayer"};
  const relations = {
    InNetClass:["netclass","in class"], InComponentClass:["componentclass","in component class"],
    OnLayer:["layer","on layer"], InDifferentialPair:["diffpair","in pair"],
    InDifferentialPairClass:["diffpairclass","in pair class"], InxSignal:["xsignal","in xSignal"],
    InxSignalClass:["xsignalclass","in xSignal class"], InSignal:["signal","in signal"], HasTag:["tag","in tag"],
    InRoom:["room","in room"], OnSheet:["sheet","in sheet"], HasPad:["pad","in pad"]
  };
  const sourceKinds = new Set(["IsTrack","IsArc","IsVia","IsPad","IsComponent","IsPolygon","IsRegion","IsFill","IsText","IsKeepout"]);
  const sourceRelations = new Set(["InNetClass","InComponentClass","OnLayer","InDifferentialPair","InDifferentialPairClass","InxSignal","InxSignalClass","InRoom"]);
  const sourceBools = {IsTeardrop:"IsTeardrop", InPolygon:"InPolygon", IsLocked:"IsLocked", IsThruHole:"IsThruHole", IsSMD:"IsSMDPad", IsSMDPad:"IsSMDPad", OnSignal:"OnSignal", OnMid:"OnMid", OnOutside:"OnOutside", OnMultiLayer:"OnMultiLayer"};
  const sourceFields = {Width:"Width", HoleSize:"HoleDiameter", PadIsPlated:"PadIsPlated", CompPinCount:"CompPinCount",
    Diameter:"ViaDiameter", Designator:"Designator", Comment:"Comment", Name:"Name", Text:"Text", Rotation:"Rotation", Length:"Length"};
  const lengths = new Set(["Width","HoleSize","Diameter","X","Y","Length"]);
  const text = value => JSON.stringify(String(value));
  const altiumText = value => "'" + String(value).replace(/'/g,"''") + "'";
  const nativeUnit = {mm:"mm", mil:"mil", mils:"mil", th:"mil", thou:"mil", inch:"in", in:"in", um:"µm", "µm":"µm", cm:"cm", deg:"deg"};
  const byValue = (dict,value) => Object.keys(dict).find(key => dict[key] === value);
  function issue(code,message,span) {return {code,message,span};}
  function refused(code,message,span) {return {ok:false,diagnostics:[issue(code,message,span)],map:[]};}
  function nativeInput(s) {
    return /^(?:objects?|components?|parts?|pads?|tracks?|vias?|nets?|pins?|wires?|ports?|arcs?|polygons?|regions?|fills?|keepouts?|text|labels?|buses?|busentr(?:y|ies)|netlabels?|power|sheetsymbols?|junctions?|resistors?|capacitors?|signals?|sheets?)(?:\s+(?:where|in|on|near)\b|\s*$)/i.test(s.trim());
  }
  function lower(input, foreign, options = {}) {
    if (typeof input !== "string") return refused("query-source","A scope must contain text.",[0,0]);
    if (!foreign && nativeInput(input)) return {ok:true,scope:{languageVersion:1,source:input},map:[{native:[0,input.length],original:[0,input.length],identity:true}],diagnostics:[]};
    let ast;
    try {ast = parse(input);} catch (e) {
      const at = Math.max(0,e.at ?? 0), token = /^[\wµ]+/u.exec(input.slice(at));
      return refused(foreign ? "unsupported-altium-scope" : "filter-syntax",e.message,[at,Math.min(input.length,at + (token?.[0].length || 1))]);
    }
    let source = ""; const map = [];
    const add = (value,node) => {
      const at = source.length; source += value;
      if (node) map.push({native:[at,source.length],original:[node.at,node.end ?? node.at + (node.name || node.prop || "").length]});
    };
    function unsupported(n,message) {throw issue(foreign ? "unsupported-altium-scope" : "unsupported-filter-scope",message,[n.at,n.end ?? n.at+(n.name||n.prop).length]);}
    function value(n,f,sourceUnit) {
      if ((f === "PadIsPlated" || f === "Locked") && /^(true|false)$/i.test(String(n.v))) return String(n.v).toLowerCase();
      if (typeof n.v === "string") return text(n.v);
      if (typeof n.v === "boolean") return String(n.v);
      let unit = nativeUnit[n.unit] || sourceUnit || "";
      if (foreign && !unit && lengths.has(f)) {
        if (n.v === 0) unit = "mm";
        else if (options.unit === "mm" || options.unit === "mil") unit = options.unit;
        else unsupported({...n,name:f},"The bare Altium length has no declared source unit. Specify AsMM or AsMils.");
      }
      return (n.raw ?? String(n.v)) + (unit ? " " + unit : "");
    }
    function relation(n,prefix,v) {
      add(prefix+" "); add(text(v),n.literals?.at(-1) || n);
    }
    function write(n) {
      if (n.t === "and" || n.t === "or") {
        // Altium Pos is explicitly case-sensitive. The two reciprocal prefix tests on a
        // nonempty string prove equality regardless of Designer's text-comparison collation.
        if(n.t==="and" && n.a.length===2){
          const [a,b]=n.a;
          if(a.t==="prefix" && b.t==="prefix" && a.direction!==b.direction && a.prop===b.prop && a.value.v===b.value.v && a.value.v!==""){
            add(fields[a.prop],{at:a.field.at,end:a.field.at+a.field.v.length});add(" = ");add(text(a.value.v),a.value);return;
          }
        }
        const seen=new Set(), terms=n.a.filter(child=>{
          if (n.t!=="or" || child.t!=="pred") return true;
          if (seen.has(child.name)) return false;seen.add(child.name);return true;
        });
        if (terms.length===1) {write(terms[0]);return;}
        add("("); terms.forEach((child,i)=>{if (i) add(" "+n.t+" "); write(child);}); add(")"); return;
      }
      if (n.t === "not") {add("not "); add("("); write(n.a); add(")"); return;}
      if (n.t === "cmp") {
        const f = fields[n.prop];
        if (!f || foreign && !sourceFields[n.prop] && !["Net","Layer","Footprint"].includes(n.prop)) unsupported(n,"No verified Altium field mapping for "+n.prop+".");
        if (foreign && ["Name","Comment","Text"].includes(n.prop) && ["=","<>"].includes(n.op) && /\p{L}/u.test(String(n.value.v))) {
          unsupported(n,"The source text equality does not declare case semantics. Two documented case-sensitive Pos checks can express exact text.");
        }
        add(f,{at:n.at,end:n.fieldEnd}); add(" "+(n.op === "<>" ? "!=" : n.op)+" "); add(value(n.value,n.prop,n.sourceUnit),n.value); return;
      }
      if (n.t === "pred") {
        if (n.name === "All") {add('(1 = 1)',n); return;}
        if (kinds[n.name] && (!foreign || sourceKinds.has(n.name))) {
          const a = kinds[n.name].map(k=>"kind = "+text(k)); add(a.length === 1 ? a[0] : "("+a.join(" or ")+")",n); return;
        }
        if (bools[n.name] && (!foreign || sourceBools[n.name])) {add(bools[n.name],n); return;}
        if (n.name === "IsTHPad") {add('(kind = "pad" and throughHole)',n); return;}
        if (n.name === "OnTop" || n.name === "OnBottom") {add("on layer "+text(n.name === "OnTop" ? "Top" : "Bottom"),n); return;}
        if (!foreign && n.name === "InPolygon") {add('kind = "polygon"',n); return;}
        if (["IsSOIC","IsLCC","IsBGA"].includes(n.name)) unsupported(n,n.name+" classifies a component by its Altium pad arrangement. The verified package classifier is unavailable.");
        unsupported(n,"The source predicate "+n.name+" has no verified native equivalent.");
      }
      if (n.name === "InNet" || n.name === "InComponent") {
        const net=n.name==="InNet";
        relation(n,foreign ? (net ? "net.name =" : "component.designator =") : (net ? "in net" : "in component"),n.arg);return;
      }
      if (!foreign && n.name === "HasFootprint") {relation(n,"footprint like",n.arg); return;}
      if (!foreign && n.name === "InNamedPolygon") {add('(kind = "polygon" and '); relation(n,"in polygon",n.arg); add(")"); return;}
      if (relations[n.name] && (!foreign || sourceRelations.has(n.name))) {
        if (n.name === "HasPad" && n.args.length === 2) {
          add("(component.designator = "); add(text(n.args[0]),n.literals[0]); add(" and "); relation(n,"in pad",n.args[1]); add(")"); return;
        }
        let arg=n.arg;
        if (n.name === "OnLayer" && options.layer) {
          arg=options.layer(arg); if (!arg) unsupported(n,"The source layer "+n.arg+" could not be mapped to a physical layer.");
        }
        relation(n,relations[n.name][1],arg); return;
      }
      unsupported(n,"The source function "+n.name+" has no verified native equivalent.");
    }
    try {
      if (ast.t === "pred" && ast.name === "All") add("object",ast);
      else if (ast.t === "pred" && kinds[ast.name]?.length === 1 && (!foreign || sourceKinds.has(ast.name))) add(kinds[ast.name][0],ast);
      else {add(ast.t === "fn" && relations[ast.name] && ast.name !== "HasPad" ? "object " : "object where ");write(ast);}
    } catch (e) {if (!e.code) throw e; return {ok:false,diagnostics:[e],map:[]};}
    if(source.length>2000) return refused("query-expansion-limit","The expanded query is too costly for a native scope.",[0,input.length]);
    return {ok:true,scope:{languageVersion:1,source},map,diagnostics:[]};
  }
  function originalSpan(map,span) {
    if (!span || !map?.length) return span;
    const hits=map.filter(m=>m.native[0]<span[1] && m.native[1]>span[0]);
    if (!hits.length) {
      const nearest=map.find(m=>m.native[1]>span[0]) || map.at(-1);return nearest.original.slice();
    }
    if (hits.length===1 && hits[0].identity) return span.slice();
    return [Math.min(...hits.map(m=>m.original[0])),Math.max(...hits.map(m=>m.original[1]))];
  }
  function translateResult(result,map) {
    const locate = d=>({...d,span:originalSpan(map,d.span)});
    return {...result,diagnostics:(result.diagnostics||[]).map(locate),hints:(result.hints||[]).map(locate)};
  }
  // Take only the public, checked native AST. An unsupported child invalidates the entire
  // emitted expression so that a foreign checker cannot silently widen a safety rule.
  function toAltium(scope, context, options={}) {
    const design=globalThis.AtriumDesignQuery, quantities=globalThis.AtriumCalculationCore;
    if (!design) return refused("query-compiler-unavailable","The native query compiler is unavailable.",[0,scope?.source?.length||0]);
    const compiled=design.compile(scope,context);
    if (!compiled.ok || !compiled.plan) return {ok:false,diagnostics:compiled.diagnostics || [],map:[]};
    const {plan}=compiled;
    const unsupported=(node,message)=>{throw issue("unsupported-altium-export",message,node?.span || [0,scope.source.length]);};
    function kind(k,node) {
      if (k === "object") return "All";
      if (k === "component") k="part";
      const p=Object.keys(kinds).find(key=>sourceKinds.has(key) && kinds[key].length===1 && kinds[key][0]===k);
      return p || unsupported(node,"Altium has no verified single-object predicate for "+k+".");
    }
    function named(family,name,node) {
      if (family === "net" || family === "component") return (family === "net" ? "InNet(" : "InComponent(")+altiumText(name)+")";
      const expansion=options.expand?.(family,name);
      if (typeof expansion==="string" && expansion) return expansion;
      const fn=Object.keys(relations).find(k=>sourceRelations.has(k) && relations[k][0]===family);
      if (!fn) unsupported(node,"Altium has no verified membership for "+family+".");
      return fn+"("+altiumText(family === "layer" ? options.layer?.(name) || name : name)+")";
    }
    function quantity(n,f,unit) {
      const comparison=plan.comparisons.find(c=>c.span[0]===n.span[0] && c.span[1]===n.span[1]);
      const parsed=comparison?.quantity;
      if (!parsed || !quantities || Object.keys(parsed.sensitivity || {}).length) unsupported(n,"A constant scalar without uncertainty is required for the Altium "+f+" field.");
      const number=quantities.as(parsed,unit);
      if (!Number.isFinite(number)) unsupported(n,"The Altium value is outside the scalar range.");
      return String(number);
    }
    function write(n) {
      if (n.type === "and" || n.type === "or") return "("+n.args.map(write).join(n.type === "and" ? " And " : " Or ")+")";
      if (n.type === "not") return "Not ("+write(n.arg)+")";
      if (n.type === "near") unsupported(n,"The Altium writer cannot encode this native "+n.mode+" distance proof.");
      if (n.type === "relation") {
        const ref=plan.references.find(r=>r.family===n.family && r.span[0]===n.nameSpan?.[0] && r.span[1]===n.nameSpan?.[1]);
        return named(n.family,ref?.target?.name || n.name,n);
      }
      if (n.type === "boolean") {
        const k=byValue(bools,n.field);
        return sourceBools[k] || unsupported(n,"Altium has no verified Boolean field for "+n.field+".");
      }
      if (n.type==="compare" && !n.field && n.left.source==="1" && n.right.source==="1" && n.op==="=") return "All";
      if (n.type !== "compare" || !n.field) unsupported(n,"This native expression has no Altium rule field.");
      const f=Object.keys(fields).find(k=>fields[k].toLowerCase()===n.field.toLowerCase());
      const op=n.op === "!=" ? "<>" : n.op === "like" ? "Like" : n.op, val=n.value;
      if (n.op === "like case") unsupported(n,"Altium has no verified case-sensitive wildcard equivalent.");
      if (f === "Kind" && n.right.type!=="scalar" && ["=","<>"].includes(op)) {
        const predicate=kind(val,n);
        return op==="=" ? predicate : "Not ("+predicate+")";
      }
      if (["Net","Designator"].includes(f) && n.right.type !== "scalar" && ["=","<>"].includes(op)) {
        const s=named(f==="Net" ? "net" : "component",val,n);
        return op==="=" ? s : "Not ("+s+")";
      }
      const field=sourceFields[f]; if (!field) unsupported(n,"Altium has no verified field mapping for "+n.field+".");
      if (f === "PadIsPlated") {
        if (!/^(true|false)$/i.test(String(val)) || !["=","<>"].includes(op)) unsupported(n,"Unsupported Altium plating check.");
        return field+" "+op+" "+altiumText(String(val).toLowerCase()==="true" ? "True" : "False");
      }
      if (lengths.has(f)) return "AsMM("+field+") "+op+" "+quantity(n,f,"mm");
      if (f === "CompPinCount" || f === "Rotation") return field+" "+op+" "+quantity(n,f,f==="Rotation" ? "deg" : "ea");
      if (n.right.type==="scalar" || !["=","<>","Like"].includes(op)) unsupported(n,"No verified equivalent for the Altium text comparison.");
      if (["=","<>"].includes(op) && val!=="" && ["Comment","Name","Text"].includes(f)) {
        const q=altiumText(val),same="(Pos("+q+", "+field+") = 1 And Pos("+field+", "+q+") = 1)";
        return op==="=" ? same : "Not "+same;
      }
      return field+" "+op+" "+altiumText(val);
    }
    try {
      const head=kind(plan.kind);
      const pred=plan.ast ? write(plan.ast) : "";
      const source=head==="All" ? pred || head : pred ? "("+head+" And "+pred+")" : head;
      if (/[|\u0000-\u001f]/u.test(source)) unsupported(plan.ast,"An Altium rule column cannot preserve this delimiter or control character.");
      return {ok:true,source,diagnostics:[]};
    } catch (e) {if (!e.code) throw e; return {ok:false,diagnostics:[e],map:[]};}
  }
  const reader=Object.freeze({parse,tokenize,print,quote,names:NAMES,QueryError,limits:{length:MAX_LENGTH,tokens:MAX_TOKENS,depth:MAX_DEPTH}});
  return Object.freeze({reader,fromClassic:(text,opts)=>lower(text,false,opts),fromAltium:(text,opts)=>lower(text,true,opts),
    toAltium,originalSpan,translateResult,nativeInput,kinds,fields,bools,relations,sourceFields,sourceKinds,sourceRelations,
    altiumText,byValue});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumQueryExchange;
