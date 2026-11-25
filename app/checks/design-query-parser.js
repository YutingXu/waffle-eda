"use strict";
// This parser only owns selection syntax. Original spans and engineering scalars come from task 36.
globalThis.AtriumDesignQueryParser = (() => {
  const kinds = new Set(("object part component resistor capacitor inductor led track arc via pad pin hole net layer wire bus busentry " +
    "netlabel port offsheet power powerport sheetsymbol junction polygon region fill text label graphic keepout room " +
    "signal tag rule document sheet library footprint drawing panel cell drawingview panelcell note calculation widget").split(" "));
  const families = {class:"netclass", net:"net", component:"component", componentclass:"componentclass", pair:"diffpair",
    pairclass:"diffpairclass", differentialpair:"diffpair", differentialpairclass:"diffpairclass", signal:"signal", tag:"tag",
    xsignal:"xsignal", xsignalclass:"xsignalclass", room:"room", polygon:"polygon", pad:"pad", sheet:"sheet"};
  const operators = new Set(["=", "!=", "<", "<=", ">", ">="]);
  const fail = (code, message, span) => { throw Object.assign(new Error(message), {diagnostic:{code, message, span}}); };
  function parse(source) {
    try {
      const R = globalThis.AtriumDesignQueryRecord;
      if (typeof source !== "string" || source.length > R.sourceLimit) fail("limit", "Query text exceeds its limit.", [0,source?.length || 0]);
      const tokens = globalThis.AtriumCalculationIntent.lex(source);
      if (tokens.length > 601) fail("limit", "Query exceeds 600 tokens.", [tokens[600].start,source.length]);
      let at = 0;
      const peek = (offset = 0) => tokens[Math.min(at + offset, tokens.length - 1)];
      const word = (index = at) => tokens[index]?.kind === "word" ? tokens[index].value.toLowerCase() : "";
      const is = value => word() === value;
      function expected(message, token = peek()) { fail("syntax", message, [token.start,token.end]); }
      function takeWord(value) { if (!is(value)) expected("Expected “" + value + "”."); return tokens[at++]; }
      const relationAhead = () => is("in") || is("on") || is("near");
      const comparison = index => operators.has(tokens[index]?.value) || word(index) === "like";
      function operand(start, end) {
        if (start >= end) expected("Enter a comparison value.", tokens[start]);
        const first = tokens[start], last = tokens[end - 1];
        const single = end === start + 1;
        const type = single && first.kind === "string" ? "text" : single && first.kind === "word" ? "word" : "scalar";
        return {type, source:source.slice(first.start,last.end), value:single ? first.value : source.slice(first.start,last.end), span:[first.start,last.end]};
      }
      function name() {
        const start = at, t = peek();
        if (!["word","string","number"].includes(t.kind) || is("and") || is("or")) expected("Choose a name or quote it.");
        at++;
        if (t.kind === "number" && peek().kind === "word" && t.end === peek().start) at++;
        const item = operand(start, at);
        return {name:item.value, span:item.span};
      }
      function scalarEnd(stopAtCompare,afterRelation=false) {
        let depth = 0;
        for (let i = at; i < tokens.length; i++) {
          const t = tokens[i];
          if (t.kind === "end") return i;
          if(afterRelation && !depth && i>at && (word(i)==="near" || word(i)==="on" && word(i+1)==="layer" ||
              word(i)==="in" && Object.hasOwn(families,word(i+1))))return i;
          if (!depth && (t.value === ")" || ["and","or"].includes(word(i)) || stopAtCompare && comparison(i))) return i;
          if (t.value === "(") { if (++depth > 40) expected("Query nesting exceeds 40 levels.",t); }
          else if (t.value === ")") depth--;
        }
        return tokens.length - 1;
      }
      function relation() {
        const first = peek();
        if (is("near")) {
          at++;
          let mode = "body";
          if (is("origin")) { at++; takeWord("of"); mode = "origin"; }
          const n = name();
          takeWord("within");
          const start = at;
          at = scalarEnd(false,true);
          const radius = operand(start, at);
          return {type:"near",name:n.name,nameSpan:n.span,mode,radius,span:[first.start,radius.span[1]]};
        }
        let family;
        if (is("on")) { at++; takeWord("layer"); family = "layer"; }
        else {
          takeWord("in");
          const t = peek();
          let key = word();
          if (key === "differential" && word(at+1) === "pair") { key = "differentialpair"; at++; }
          if (t.kind !== "word") expected("Choose a membership family.",t);
          at++;
          if (is("class") && ["component","pair","differentialpair","xsignal"].includes(key)) { key += "class"; at++; }
          family = Object.prototype.hasOwnProperty.call(families,key) && families[key];
          if (!family) expected("Unknown membership family “" + key + "”.",t);
        }
        const n = name();
        return {type:"relation",family,name:n.name,nameSpan:n.span,span:[first.start,n.span[1]]};
      }
      function groupedCondition() {
        if (peek().value !== "(") return false;
        let depth = 0;
        for (let i = at; i < tokens.length; i++) {
          if (tokens[i].value === "(") depth++;
          else if (tokens[i].value === ")" && --depth === 0) {
            const next = tokens[i+1];
            return !next || next.kind === "end" || next.value === ")" || ["and","or"].includes(word(i+1));
          }
        }
        return true;
      }
      function unary(depth) {
        if (depth > 40) expected("Query nesting exceeds 40 levels.");
        const first = peek();
        if (is("not")) { at++; const arg = unary(depth+1); return {type:"not",arg,span:[first.start,arg.span[1]]}; }
        if (groupedCondition()) {
          at++; const arg = disjunction(depth+1);
          if (peek().value !== ")") expected("Close the grouped condition.");
          at++; return arg;
        }
        if (relationAhead()) return relation();
        const start = at;
        at = scalarEnd(true);
        const left = operand(start, at);
        if (!comparison(at)) {
          if (left.type !== "word") expected("Compare the field with a value.",tokens[start]);
          return {type:"boolean",field:left.value,span:left.span};
        }
        let op = is("like") ? "like" : peek().value;
        at++;
        if (op === "like" && is("case")) { op = "like case"; at++; }
        const rightAt = at;
        at = scalarEnd(false);
        const right = operand(rightAt,at);
        return {type:"compare",field:left.type === "word" ? left.value : null,left,op,value:right.value,right,span:[left.span[0],right.span[1]]};
      }
      function conjunction(depth) {
        const args = [unary(depth)];
        while (is("and") || relationAhead() && ["relation","near"].includes(args.at(-1).type)) {
          if (is("and")) at++;
          args.push(unary(depth));
        }
        return args.length === 1 ? args[0] : {type:"and",args,span:[args[0].span[0],args.at(-1).span[1]]};
      }
      function disjunction(depth) {
        const args = [conjunction(depth)];
        while (is("or")) { at++; args.push(conjunction(depth)); }
        return args.length === 1 ? args[0] : {type:"or",args,span:[args[0].span[0],args.at(-1).span[1]]};
      }
      let kind = word();
      if (!kinds.has(kind)) expected("Choose an object kind, such as part, net or track.");
      if (kind === "component") kind = "part";
      at++;
      if (peek().kind === "end") return {ok:true,source,kind,ast:null};
      if (is("where")) at++;
      else if (!relationAhead()) expected("Expected “where”, “in”, “on” or “near”.");
      const ast = disjunction(0);
      if (peek().kind !== "end") expected("Unexpected token “" + peek().value + "”.");
      return {ok:true,source,kind,ast};
    } catch (e) {
      if (!e.diagnostic) throw e;
      return {ok:false,diagnostics:[e.diagnostic]};
    }
  }
  return Object.freeze({parse,fail,kinds});
})();
