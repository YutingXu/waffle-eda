// Pure notebook expression engine. Shared by the worker, headless tools and tests.
(function (root) {
  "use strict";
  const {lex, error, limits} = root.AtriumCalculationIntent;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const fail = (code, message, span) => { throw error(code, message, span); };
  const zero = [0,0,0,0,0,0,0];
  const dims = (l=0,m=0,t=0,i=0,k=0,n=0,j=0) => [l,m,t,i,k,n,j];
  const equalDims = (a,b) => a && b && a.length === 7 && a.every((v,i) => Math.abs(v-b[i]) < 1e-12);
  const dimKey = d => d.join(",");
  const names = Object.create(null), standard = Object.create(null);
  const prefixes = {q:1e-30,r:1e-27,y:1e-24,z:1e-21,a:1e-18,f:1e-15,p:1e-12,n:1e-9,u:1e-6,"µ":1e-6,"μ":1e-6,m:1e-3,c:1e-2,d:1e-1,da:10,h:100,k:1e3,M:1e6,meg:1e6,G:1e9,T:1e12,P:1e15,E:1e18,Z:1e21,Y:1e24,R:1e27,Q:1e30};
  const scales = ["q","r","y","z","a","f","p","n","µ","m","","k","M","G","T","P","E","Z","Y","R","Q"];
  function define(symbol, dimensions, aliases=[], options={}) {
    const u = {symbol,dimensions,factor:1,offset:0,tag:"",prefix:true,...options};
    for (const a of [symbol,...aliases]) names[a] = u;
    if (u.factor === 1 && !u.tag && !standard[dimKey(dimensions)]) standard[dimKey(dimensions)] = u;
  }
  define("",zero,["1","dimensionless","scalar","number"]);
  define("metre",dims(1),["meter","metres","meters","length"]);
  define("kg",dims(0,1),["mass"],{prefix:false});
  // International foot and avoirdupois ounce (NIST Handbook 44, Appendix C).
  define("ft",dims(1),["foot","feet"],{factor:.3048,prefix:false});
  define("oz",dims(0,1),["ounce"],{factor:.028349523125,prefix:false});
  define("g",dims(0,1),["gram"],{factor:.001});
  define("s",dims(0,0,1),["second","seconds","time"]);
  define("A",dims(0,0,0,1),["amp","ampere","current"]);
  define("K",dims(0,0,0,0,1),["kelvin","temperature"]);
  define("mol",dims(0,0,0,0,0,1),["amount"]);
  define("cd",dims(0,0,0,0,0,0,1),["luminousIntensity"]);
  define("Hz",dims(0,0,-1),["hertz","frequency"]);
  define("Ω",dims(2,1,-3,-2),["ohm","Ohm","ohms","resistance","impedance"]);
  define("V",dims(2,1,-3,-1),["volt","volts","voltage"]);
  define("F",dims(-2,-1,4,2),["farad","capacitance"]);
  define("H",dims(2,1,-2,-2),["henry","inductance"]);
  define("W",dims(2,1,-3),["watt","power"]);
  define("J",dims(2,1,-2),["joule","energy"]);
  define("N",dims(1,1,-2),["newton","force"]);
  define("Pa",dims(-1,1,-2),["pascal","pressure"]);
  define("C",dims(0,0,1,1),["coulomb","charge"]);
  define("S",dims(-2,-1,3,2),["siemens","conductance"]);
  define("T",dims(0,1,-2,-1),["tesla"]);
  define("Wb",dims(2,1,-2,-1),["weber"]);
  define("metre/s",dims(1,0,-1),["m/s","speed","velocity"]);
  define("metre²",dims(2),["m²","area"]);
  define("rad",zero,["radian","angle"],{tag:"angle"});
  define("°",zero,["deg","degree","degrees"],{factor:Math.PI/180,tag:"angle",prefix:false});
  define("%",zero,["percent"],{factor:.01,prefix:false});
  define("ea",zero,["pcs","count"],{tag:"count",prefix:false});
  define("ppm",zero,[],{factor:1e-6,prefix:false});
  define("ppm/K",dims(0,0,0,0,-1),[],{factor:1e-6,prefix:false});
  define("°C",dims(0,0,0,0,1),["degC","celsius"],{tag:"celsius",offset:273.15,prefix:false});
  define("Δ°C",dims(0,0,0,0,1),["deltaC"],{tag:"delta",prefix:false});
  for (const symbol of ["dB","dBm","dBV"]) define(symbol,zero,[],{tag:symbol,prefix:false});
  define("mil",dims(1),[],{factor:.0000254,prefix:false});
  define("in",dims(1),["inch","inches"],{factor:.0254,prefix:false});

  function unitInfo(text) {
    if (typeof text!=="string") return null;
    if (has(names,text)) return names[text];
    if (text.length > 120) return null;
    // Products and quotients associate left to right. An exponent binds only to its unit.
    const split=text.match(/^(.*)([*/])([^*/]+)$/);
    if (split) {
      const a=unitInfo(split[1]==="m" ? "metre" : split[1]), b=unitInfo(split[3]==="m" ? "metre" : split[3]);
      if (!a || !b || a.tag || b.tag) return null;
      const sign=split[2]==="*" ? 1 : -1;
      return {symbol:text,dimensions:a.dimensions.map((x,i)=>x+sign*b.dimensions[i]),factor:a.factor*b.factor**sign,offset:0,tag:""};
    }
    // Length uses "metre" in bare notation. Inside a compound or prefix, m is unambiguous.
    const exponentMark = text.match(/^(.+?)(²|³|\^(-?\d+))$/u);
    if (exponentMark) {
      const u = unitInfo(exponentMark[1] === "m" ? "metre" : exponentMark[1]);
      const p = exponentMark[2] === "²" ? 2 : exponentMark[2] === "³" ? 3 : Number(exponentMark[3]);
      if (!u || u.tag || Math.abs(p)>12) return null;
      return {symbol:text,dimensions:u.dimensions.map(x=>x*p),factor:u.factor**p,offset:0,tag:""};
    }
    for (const p of ["meg","da",text[0]]) {
      if (!has(prefixes,p) || !text.startsWith(p) || text.length === p.length) continue;
      const base = text.slice(p.length), u = base === "m" ? names.metre : names[base];
      if (u && u.prefix && u.symbol && !u.tag) return {...u,symbol:text,factor:prefixes[p]*u.factor};
    }
    return null;
  }
  function unit(text) { return (text==="m" ? names.metre : unitInfo(text)) || fail("unit", "Unknown unit " + text + "."); }
  const fbits = new DataView(new ArrayBuffer(8));
  function adjacent(value, up) {
    if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    if (!Number.isFinite(value)) return value;
    fbits.setFloat64(0,value);
    let hi = fbits.getUint32(0), lo = fbits.getUint32(4);
    if ((value > 0) === up) { if (lo === 0xffffffff) hi++; lo = (lo+1) >>> 0; }
    else { if (lo === 0) hi--; lo = (lo-1) >>> 0; }
    fbits.setUint32(0,hi); fbits.setUint32(4,lo);
    return fbits.getFloat64(0);
  }
  function checkFinite(x) { return Number.isFinite(x) ? x : fail("numeric", "Result is outside the finite real-number range."); }
  function exact(value, dimensions=zero, tag="") {
    checkFinite(value);
    return {kind:"quantity",value,dimensions:dimensions.slice(),tag,worst:{min:value,max:value},rss:0,contributions:Object.create(null),unknown:[],defaults:[],warnings:[]};
  }
  function quantity(value, text="") {
    const u = unit(text);
    const q = exact(value*u.factor+u.offset,u.dimensions,u.tag);
    if (u.tag || u.symbol === "%" || u.symbol === "ppm/K") q.preferred = u.symbol;
    return q;
  }
  function compatible(q,u) {
    if (!equalDims(q.dimensions,u.dimensions)) return false;
    if (q.tag === u.tag) return true;
    // Kelvin is the explicit coherent representation of absolute temperatures and intervals.
    return [q.tag,u.tag].every(t => ["","celsius","delta"].includes(t)) && equalDims(q.dimensions,names.K.dimensions);
  }
  function as(q,text) {
    const u=unit(text);
    if (!q || !compatible(q,u)) fail("dimension","Expected a value in " + (text || "dimensionless units") + ".");
    return (q.value-u.offset)/u.factor;
  }
  function withUnit(q,text) {
    as(q,text);
    const u=unit(text);
    return {...q,tag:u.tag,preferred:text,inputUnit:text};
  }
  function bareLiteral(n) {
    while (n.type==="group" || n.type==="unary") n=n.child || n.arg;
    return n.type==="number" && !n.unit;
  }
  function fieldOperand(q,fieldUnit,n,bare) {
    const u=unit(fieldUnit);
    if (q.kind!=="quantity") fail("dimension","This field requires a numeric quantity.",n.span);
    if (bare) {
      const convert=x=>x*u.factor+u.offset;
      const result=lift([q],{value:convert(q.value),unit:fieldUnit,partials:[u.factor],
        bounds:{min:convert(q.worst.min),max:convert(q.worst.max)}});
      if (u.symbol==="%" || u.symbol==="ppm/K") result.preferred=u.symbol;
      return {...result,inputUnit:fieldUnit};
    }
    if (!compatible(q,u)) fail("dimension","This field requires "+(u.symbol || "a dimensionless value")+".",n.span);
    return q;
  }
  const distinct = values => Array.from(new Set(values));
  const uncertain = q => q.worst.min !== q.worst.max;
  function bounds(min,max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min>max) fail("interval","A finite worst-case interval is unavailable.");
    return {min:checkFinite(adjacent(min,false)),max:checkFinite(adjacent(max,true))};
  }
  function scalar(q) {
    if (!q || q.kind !== "quantity") fail("type","Expected a numeric quantity.");
    return q;
  }
  function lift(args, spec) {
    args.forEach(scalar);
    const u=spec.unit !== undefined ? unit(spec.unit) : null;
    const q=exact(spec.value,spec.dimensions || u?.dimensions || spec.like?.dimensions || zero,spec.tag || u?.tag || spec.like?.tag || "");
    if (spec.like?.preferred) q.preferred=spec.like.preferred;
    if (u?.tag) q.preferred=u.symbol;
    q.unknown=distinct(args.flatMap(x=>x.unknown || []));
    q.defaults=distinct(args.flatMap(x=>x.defaults || []));
    q.warnings=distinct(args.flatMap(x=>x.warnings || []));
    const changing=args.some(uncertain);
    if (changing) {
      if (!spec.bounds) fail("interval","This operation requires finite worst-case bounds.");
      const b=spec.bounds;
      q.worst=b.min === b.max && spec.exactBounds ? {min:b.min,max:b.max} : bounds(b.min,b.max);
    }
    for (let i=0;i<args.length;i++) {
      const derivative=spec.partials?.[i];
      for (const [key,w] of Object.entries(args[i].contributions || {})) {
        if (w && Number.isFinite(derivative)) q.contributions[key]=(q.contributions[key] || 0)+derivative*w;
        else if (w) q.rssReason="A local derivative is unavailable.";
      }
      if (args[i].rss === null) q.rssReason=args[i].rssReason || "Input RSS is unavailable.";
    }
    if (spec.rssReason && changing) q.rssReason=spec.rssReason;
    q.rss=q.rssReason ? null : checkFinite(Math.hypot(...Object.values(q.contributions)));
    return q;
  }
  function record(display,fields) {
    if (typeof display !== "string" || !fields || typeof fields !== "object") fail("type","A typed record needs a display and fields.");
    return {kind:"record",display,copyText:display,fields};
  }
  // Only addition and subtraction combine an absolute temperature with an interval.
  function sameScale(tags) {
    if (tags.includes("celsius") && tags.includes("delta")) fail("unit","An absolute temperature and a temperature interval are not comparable.");
  }
  function sameDimension(a,b,affine) {
    scalar(a); scalar(b);
    if (!equalDims(a.dimensions,b.dimensions) || (a.tag !== b.tag && ![a.tag,b.tag].every(t=>["","celsius","delta"].includes(t))))
      fail("dimension","These quantities have incompatible units.");
    if (!affine) sameScale([a.tag,b.tag]);
  }
  // A result shown in the unit all of its operands were written in, such as % or Δ°C.
  function sharedPreferred(args) {
    const p=args[0].preferred;
    return p && args.every(x=>x.preferred===p && x.tag===args[0].tag) ? p : undefined;
  }
  function requireLinear(q) {
    scalar(q);
    if (q.tag && !["delta","angle"].includes(q.tag)) fail("unit","Convert this tagged quantity to a linear unit before arithmetic.");
  }
  function formatted(n) { return String(Number((Object.is(n,-0) ? 0 : n).toPrecision(4))); }
  function compoundLabel(d) {
    const symbols=["metre","kg","s","A","K","mol","cd"];
    return d.map((power,i)=>power === 0 ? "" : symbols[i]+(power===1 ? "" : "^"+power)).filter(Boolean).join("·");
  }
  function presentation(q,requested) {
    if (q.kind === "record") return {display:q.display,unit:""};
    if (q.kind === "assertion") return {display:q.display,unit:presentation({...q,kind:"quantity"},requested).unit};
    const explicit=requested != null && requested !== "";
    // A celsius value is stored in kelvin, so only its offset unit can label it.
    const fixed=explicit ? requested : q.preferred || (q.tag==="count" ? "ea" : q.tag==="celsius" ? "°C" : "");
    if (explicit || fixed) {
      const magnitude=as(q,fixed);
      const exactCount=q.tag==="count" && Number.isSafeInteger(magnitude) && (!q.worst || !uncertain(q)) && !q.unknown?.length;
      const number=exactCount ? String(magnitude) : formatted(magnitude);
      // The parser reads a bare m after a number as milli, so copied length spells metre.
      return {display:number+" "+fixed,unit:fixed,copyText:number+" "+(fixed==="m" ? "metre" : fixed)};
    }
    const std=q.tag ? names[q.tag] || (q.tag==="angle" ? names.rad : null) : standard[dimKey(q.dimensions)];
    let base=std?.symbol || compoundLabel(q.dimensions), divisor=1;
    if (base==="metre") base="m";
    // A unit prefix on area represents the square of the linear scale.
    let power=1;
    if (base==="metre²") { base="m²"; power=2; }
    if (base==="kg") { base="g"; divisor=.001; }
    const v=q.value/divisor, magnitude=Math.abs(v);
    let exponent=magnitude ? Math.floor(Math.log10(magnitude)/(3*power)) : 0;
    exponent=Math.max(-10,Math.min(10,exponent));
    if (base.includes("·") || base.includes("^") || base.includes("/") || q.tag) exponent=0;
    if (exponent<10 && Number((magnitude/10**(3*exponent*power)).toPrecision(4))>=1000**power) exponent++;
    const suffix=scales[exponent+10]+base, number=formatted(v/10**(3*exponent*power));
    // Copied text must parse to the same quantity: a dimensionless prefix touches its
    // number (1T, not tesla) and unprefixed length spells metre (not milli).
    const copySuffix=!base ? suffix : suffix==="m" ? " metre" : " "+suffix;
    return {display:number+(suffix ? " "+suffix : ""),unit:suffix,copyText:number+copySuffix};
  }
  const precedence={"&&":1,"=":2,"!=":2,">":2,">=":2,"<":2,"<=":2,"±":3,"+":4,"-":4,"||":5,"*":6,"/":6,"^":8};
  const constants={pi:Math.PI,"π":Math.PI,e:Math.E,c:299792458};
  const diagnostic=e=>({ok:false,diagnostic:e.diagnostic || {code:"calculation",message:"Calculation could not be evaluated.",span:[0,0]}});
  function parse(source,options={}) {
    try {
      const ts=lex(source), refs=[], queries=[];
      let at=0, name, asserted=false;
      const peek=(i=0)=>ts[Math.min(at+i,ts.length-1)];
      const take=()=>ts[at++];
      function expected(msg,t=peek()) { fail("syntax",msg,[t.start,t.end]); }
      function consume(value) { if (peek().value!==value) expected("Expected “"+value+"”."); return take(); }
      function wordUnit(t) { return t.kind==="word" || t.value==="%"; }
      function targetUnit() {
        const start=peek();
        function unitFactor() {
          const t=take();
          if (!wordUnit(t)) expected("Choose a conversion unit.",t);
          let text=t.value;
          // In s^2 the power belongs to seconds. In "(2 s) ^ 2" it applies to the quantity.
          if (peek().value==="^" && peek().start===t.end) {
            const sign=peek(1).value==="-", power=peek(sign ? 2 : 1);
            if (power.kind==="number" && /^[0-9]+$/.test(power.value)) {
              take(); if (sign) take(); take();
              text+="^"+(sign ? "-" : "")+power.value;
            }
          }
          return text;
        }
        let text=unitFactor();
        while (["/","*"].includes(peek().value) && wordUnit(peek(1)) && (unitInfo(peek(1).value) || peek(1).value==="m")) {
          const op=take().value; text+=op+unitFactor();
        }
        if (!unitInfo(text)) fail("unit","Unknown conversion unit "+text+".",[start.start,ts[at-1].end]);
        return text;
      }
      function literal(t) {
        let value=Number(t.value), suffix="", end=t.end;
        if (!Number.isFinite(value)) fail("numeric","Decimal literal exceeds binary64 range.",[t.start,end]);
        let u=peek();
        const metreCompound=u.value==="m" && ((["/","*"].includes(peek(1).value) && wordUnit(peek(2)) && unitInfo(peek(2).value)) ||
          (peek(1).value==="^" && peek(1).start===u.end));
        if (!metreCompound && u.kind==="word" && has(prefixes,u.value) && (t.end===u.start || !unitInfo(u.value))) {
          value*=prefixes[take().value]; end=u.end; u=peek();
        }
        const inches=u.value==="in" && (peek(1).kind!=="word" || peek(1).value==="in");
        if (wordUnit(u) && (unitInfo(u.value) || metreCompound) && (u.value!=="in" || inches)) {
          suffix=targetUnit(); end=ts[at-1].end;
        }
        return {type:"number",value,unit:suffix,span:[t.start,end]};
      }
      function call(id,start,depth) {
        consume("("); const args=[];
        if (peek().value!==")") {
          while (true) {
            args.push(expression(0,depth+1));
            if (peek().value!==",") break;
            take();
          }
        }
        return {type:"call",id,args,span:[start,consume(")").end]};
      }
      function primary(depth) {
        if (depth>limits.depth) expected("Expression nesting exceeds the limit.");
        const t=take();
        if (t.kind==="number") return literal(t);
        if (t.kind==="string") return {type:"string",value:t.value,span:[t.start,t.end]};
        if (t.kind==="count-query") {
          const query={source:t.value,span:t.querySpan};
          queries.push(query);
          return {type:"count",query,span:[t.start,t.end]};
        }
        if (t.value==="+" || t.value==="-") {
          const arg=expression(7,depth+1);
          return {type:"unary",op:t.value,arg,span:[t.start,arg.span[1]]};
        }
        if (t.value==="(") {
          const child=expression(0,depth+1); const end=consume(")").end;
          return {type:"group",child,span:[t.start,end]};
        }
        if (t.kind==="net-field") {
          const ref={name:t.value,span:[t.start,t.end]};
          refs.push(ref); return {type:"ref",...ref};
        }
        if (t.kind!=="word") expected("Enter a value, reference or function.",t);
        if (t.value==="nearest" && /^E(?:3|6|12|24|48|96|192)$/.test(peek().value)) {
          const series=take(), arg=expression(7,depth+1);
          return {type:"call",id:"nearest",args:[arg,{type:"string",value:series.value,span:[series.start,series.end]}],span:[t.start,arg.span[1]]};
        }
        if (peek().value==="(") {
          if (t.value.toLowerCase()==="nearest") expected("Use nearest E24 value or value in E24.",t);
          return call(t.value,t.start,depth);
        }
        let id=t.value, end=t.end;
        if (id==="net" && peek().kind==="word") { const net=take(); id+=" "+net.value; end=net.end; }
        const ref={name:id,span:[t.start,end]};
        if (!has(constants,id)) refs.push(ref);
        return {type:"ref",...ref};
      }
      function expression(min,depth) {
        let a=primary(depth);
        while (true) {
          const t=peek();
          if (t.value==="." && peek(1).kind==="word") {
            take(); const key=take();
            a={type:"field",object:a,key:key.value,span:[a.span[0],key.end]}; continue;
          }
          if (t.value==="in" && min<=3) {
            take(); const next=peek();
            if (/^E(?:3|6|12|24|48|96|192)$/.test(next.value)) {
              take(); a={type:"call",id:"nearest",args:[a,{type:"string",value:next.value,span:[next.start,next.end]}],span:[a.span[0],next.end]};
            } else {
              const target=targetUnit();
              a={type:"convert",child:a,unit:target,span:[a.span[0],ts[at-1].end]};
            }
            continue;
          }
          const implicit=(t.value==="π" || t.value==="pi") && a.type==="number";
          const op=implicit ? "*" : t.value, rank=precedence[op];
          if (!has(precedence,op) || rank<min) break;
          if (!implicit) take();
          const b=expression(op==="^" ? rank : rank+1,depth+1);
          a={type:"binary",op,left:a,right:b,span:[a.span[0],b.span[1]],opSpan:[t.start,t.end]};
        }
        return a;
      }
      if (peek().value==="assert") { asserted=true; take(); }
      else if (!options.predicate && peek().kind==="word" && peek(1).value==="=") { name=take().value; take(); }
      const ast=expression(0,0);
      if (peek().kind!=="end") expected("Unexpected “"+peek().value+"”.");
      return {ok:true,source,name,asserted,ast,references:refs,queries};
    } catch(e) { return diagnostic(e); }
  }

  function addTolerance(q,width,id) {
    if (width<0 || !Number.isFinite(width)) fail("tolerance","Tolerance must be finite and nonnegative.");
    if (width===0) return {...q};
    const contributions={...q.contributions,[id]:(q.contributions[id] || 0)+width};
    return {...q,worst:bounds(q.worst.min-width,q.worst.max+width),contributions,rss:q.rss===null ? null : Math.hypot(...Object.values(contributions))};
  }
  function widthOf(q,t) {
    scalar(t);
    if (uncertain(t)) fail("tolerance","A tolerance width must be exact.");
    if (t.preferred==="%") return Math.abs(q.value)*t.value;
    if (!equalDims(q.dimensions,t.dimensions) || (q.tag==="count") !== (t.tag==="count")) fail("dimension","Absolute tolerance must have the same dimensions as the value.");
    return t.value;
  }
  function close(a,b) { return a===b || Math.abs(a-b)<=1e-12*Math.max(Math.abs(a),Math.abs(b)); }
  const compare=(a,b)=>close(a,b) ? 0 : a<b ? -1 : 1;
  function compareNominal(a,b) {
    sameDimension(a,b);
    return compare(a.value,b.value);
  }
  function comparison(a,b,op,domain) {
    if (domain && a.kind==="quantity" && b.kind==="quantity" && !equalDims(a.dimensions,b.dimensions)) {
      if (b.value===0 && equalDims(b.dimensions,zero)) b=exact(0,a.dimensions,a.tag);
      else if (a.value===0 && equalDims(a.dimensions,zero)) a=exact(0,b.dimensions,b.tag);
    }
    sameDimension(a,b);
    const al=a.worst.min, ah=a.worst.max, bl=b.worst.min, bh=b.worst.max;
    let pass,failAll;
    switch (op) {
      case "=": pass=compare(al,bl)>=0 && compare(ah,bh)<=0; failAll=compare(ah,bl)<0 || compare(al,bh)>0; break;
      case "!=": failAll=compare(al,bl)>=0 && compare(ah,bh)<=0; pass=compare(ah,bl)<0 || compare(al,bh)>0; break;
      case ">": pass=compare(al,bh)>0; failAll=compare(ah,bl)<=0; break;
      case ">=": pass=compare(al,bh)>=0; failAll=compare(ah,bl)<0; break;
      case "<": pass=compare(ah,bl)<0; failAll=compare(al,bh)>=0; break;
      case "<=": pass=compare(ah,bl)<=0; failAll=compare(al,bh)>0; break;
    }
    const status=pass ? "pass" : failAll ? "fail" : "may-violate";
    return {...a,kind:"assertion",display:pass ? "Pass" : failAll ? "Fail" : "May violate",assertion:{status,operator:op,actual:{...a.worst},required:{...b.worst},dimensions:a.dimensions},unknown:distinct([...a.unknown,...b.unknown]),defaults:distinct([...a.defaults,...b.defaults]),warnings:distinct([...a.warnings,...b.warnings])};
  }
  const fourCorners=(a,b,fn)=>[fn(a.min,b.min),fn(a.min,b.max),fn(a.max,b.min),fn(a.max,b.max)];
  function extremes(values) { return {min:Math.min(...values),max:Math.max(...values)}; }
  const crossesZero=b=>b.min<=0 && b.max>=0;
  function correlatedExact(a,b,v,d,tag="") {
    return lift([a,b],{value:v,dimensions:d,tag,partials:[0,0],bounds:{min:v,max:v},exactBounds:true});
  }
  function rational(x) {
    for (let den=1;den<=64;den++) {
      const num=Math.round(x*den);
      if (Number.isSafeInteger(num) && num/den===x) return {num,den};
    }
    return null;
  }
  function realPower(x,y) {
    if (x>=0 || Number.isInteger(y)) return x**y;
    const r=rational(y);
    return r && r.den%2 ? (Math.abs(r.num)%2 ? -1 : 1)*(-x)**y : NaN;
  }
  function power(a,b) {
    requireLinear(a); requireLinear(b);
    if (!equalDims(b.dimensions,zero)) fail("dimension","The exponent must be dimensionless.");
    if (!equalDims(a.dimensions,zero) && (uncertain(b) || b.bound || b.depends)) fail("dimension","A dimensioned base requires a constant exponent.");
    const z=b.value, exponent=a.dimensions.map(v=>v*z);
    const ratio=rational(z);
    if (!equalDims(a.dimensions,zero) && !ratio) fail("dimension","A dimensioned power requires a representable constant rational exponent.");
    if (exponent.some(v=>!Number.isFinite(v) || Math.abs(v)>128)) fail("dimension","Dimension exponent is outside the supported range.");
    if (a.worst.min<0 && (uncertain(b) || !ratio || !(ratio.den%2))) fail("domain","A fractional or varying power needs a nonnegative base.");
    if (crossesZero(a.worst) && b.worst.min<=0) fail("domain","A nonpositive exponent is undefined across zero.");
    const v=realPower(a.value,z), vals=fourCorners(a.worst,b.worst,realPower);
    if (crossesZero(a.worst) && b.worst.min>0) vals.push(0);
    return lift([a,b],{value:v,dimensions:exponent,partials:[z===0 ? 0 : z*(a.value===0 ? 0**(z-1) : v/a.value),a.value>0 ? v*Math.log(a.value) : NaN],bounds:extremes(vals)});
  }
  function arithmetic(op,a,b,n,ctx) {
    scalar(a); scalar(b);
    if (op==="±") return addTolerance(a,widthOf(a,b),ctx.sourceKey+":"+n.span.join("-"));
    if (op==="^") return power(a,b);
    if (op==="+" || op==="-") {
      if ((a.tag==="count") !== (b.tag==="count")) fail("dimension","Add or subtract counts in ea or pcs.",(a.tag==="count" ? n?.right : n?.left)?.span);
      sameDimension(a,b,true);
      if (a.bound && a.bound===b.bound && op==="-") return correlatedExact(a,b,0,a.dimensions,a.tag==="count" ? "count" : "");
      const sign=op==="+" ? 1 : -1;
      if (op==="+" && a.tag==="celsius" && b.tag==="celsius") fail("unit","Add a temperature interval to an absolute temperature.");
      if (op==="-" && b.tag==="celsius" && a.tag!=="celsius") fail("unit","Subtract an interval from an absolute temperature.");
      // An absolute temperature keeps its scale whichever operand carries it.
      const tag=a.tag==="celsius" && b.tag==="celsius" ? "delta" : a.tag==="celsius" || b.tag==="celsius" ? "celsius" : a.tag || b.tag;
      const x=lift([a,b],{value:a.value+sign*b.value,dimensions:a.dimensions,tag,partials:[1,sign],bounds:extremes(fourCorners(a.worst,b.worst,(u,v)=>u+sign*v))});
      const shown=a.tag===tag && sharedPreferred([a,b]);
      if (tag==="celsius") x.preferred="°C";
      else if (shown) x.preferred=shown;
      return x;
    }
    const scaling=(op==="*" || op==="/") && (a.tag==="count" || b.tag==="count");
    if (!scaling || a.tag!=="count") requireLinear(a);
    if (!scaling || b.tag!=="count") requireLinear(b);
    if (op==="||") {
      sameDimension(a,b);
      if (crossesZero({min:a.worst.min+b.worst.min,max:a.worst.max+b.worst.max})) fail("domain","The sum of the parallel operands reaches zero.");
      const sum=a.value+b.value;
      const par=(x,y)=>Math.abs(x)>Math.abs(y) ? y/(1+y/x) : x/(1+x/y);
      const q=lift([a,b],{value:par(a.value,b.value),dimensions:a.dimensions,partials:[(b.value/sum)**2,(a.value/sum)**2],bounds:extremes(fourCorners(a.worst,b.worst,par))});
      return q;
    }
    if (op==="/" && crossesZero(b.worst)) fail("domain","Division by a value whose range includes zero.");
    if (op==="/" && a.bound && a.bound===b.bound) return correlatedExact(a,b,1,zero);
    const divide=op==="/", v=divide ? a.value/b.value : a.value*b.value;
    let tag="";
    if (scaling) {
      const other=a.tag==="count" ? b : a;
      if (a.tag==="count" && b.tag==="count") tag=divide ? "" : "count";
      else if (!other.tag && equalDims(other.dimensions,zero)) tag=divide && b.tag==="count" ? "" : "count";
      else if (!divide || b.tag==="count") tag=other.tag;
    }
    const result=lift([a,b],{value:v,dimensions:a.dimensions.map((p,i)=>p+(divide ? -1 : 1)*b.dimensions[i]),tag,partials:divide ? [1/b.value,-v/b.value] : [b.value,a.value],bounds:extremes(fourCorners(a.worst,b.worst,(x,y)=>divide ? x/y : x*y))});
    // A conventional amplitude/power log ratio carries its level label at presentation.
    if (!divide && ((a.logRatio && [10,20].includes(b.value) && !b.depends && equalDims(b.dimensions,zero)) || (b.logRatio && [10,20].includes(a.value) && !a.depends && equalDims(a.dimensions,zero)))) {
      result.tag="dB"; result.preferred="dB";
    }
    return result;
  }
  const unaryFunctions=["abs","sqrt","exp","ln","log","log10","sin","cos","tan","asin","acos","atan","nominal"];
  function builtin(name,args) {
    if (name === "sum" || name === "average") {
      if (!args.length) { if (name === "sum") return exact(0); fail("arity","Average needs at least one quantity."); }
      if (name === "average" && args.some(x => x?.tag === "celsius")) {
        // A mean of absolute temperatures is an absolute temperature, although their sum is not.
        const a=scalar(args[0]); args.forEach(b=>sameDimension(a,b)); sameScale(args.map(x=>x.tag));
        const mean=values=>values.reduce((s,v)=>s+v,0)/args.length;
        return lift(args,{value:mean(args.map(x=>x.value)),unit:"°C",partials:args.map(()=>1/args.length),
          bounds:{min:mean(args.map(x=>x.worst.min)),max:mean(args.map(x=>x.worst.max))}});
      }
      const total = args.slice(1).reduce((a,b) => arithmetic("+",a,b),scalar(args[0]));
      if (name === "sum") return total;
      const mean=arithmetic("/",total,exact(args.length));
      if (total.preferred) mean.preferred=total.preferred;
      return mean;
    }
    if (name==="min" || name==="max") {
      if (!args.length) fail("arity",name+" needs at least one argument.");
      const a=scalar(args[0]), tags=args.map(x=>x.tag); args.forEach(b=>sameDimension(a,b,true)); sameScale(tags);
      const f=name==="min" ? Math.min : Math.max, value=f(...args.map(x=>x.value));
      const tied=args.filter(x=>x.value===value).length>1;
      // The extremum keeps an absolute temperature scale and a unit every argument shares.
      const tag=tags.includes("celsius") ? "celsius" : tags.find(Boolean) || "";
      return lift(args,{value,dimensions:a.dimensions,tag,like:{preferred:sharedPreferred(args)},partials:args.map(x=>x.value===value ? 1 : 0),bounds:{min:f(...args.map(x=>x.worst.min)),max:f(...args.map(x=>x.worst.max))},rssReason:tied ? "The active extremum has a tie." : null});
    }
    if (!unaryFunctions.includes(name)) return null;
    if (args.length!==1) fail("arity",name+" needs one argument.");
    const a=scalar(args[0]), x=a.value, lo=a.worst.min, hi=a.worst.max;
    if (name==="nominal") return {...exact(x,a.dimensions,a.tag),unknown:a.unknown,defaults:a.defaults,warnings:a.warnings,preferred:a.preferred};
    if (name==="sqrt") return power(a,exact(.5));
    if (name==="abs") {
      if (a.tag!=="count") requireLinear(a);
      return lift([a],{value:Math.abs(x),like:a,partials:[Math.sign(x)],bounds:{min:crossesZero(a.worst) ? 0 : Math.min(Math.abs(lo),Math.abs(hi)),max:Math.max(Math.abs(lo),Math.abs(hi))},rssReason:crossesZero(a.worst) ? "Absolute value is not differentiable throughout the input range." : null});
    }
    if (!equalDims(a.dimensions,zero) || (a.tag && !(["sin","cos","tan"].includes(name) && a.tag==="angle"))) fail("dimension",name+" needs a compatible dimensionless value or angle.");
    let f,df,range,tag="";
    if (["log","ln","log10"].includes(name)) {
      if (lo<=0) fail("domain","Logarithms require a positive input over the whole range.");
      f=name==="log10" ? Math.log10 : Math.log; df=1/(x*(name==="log10" ? Math.LN10 : 1));
    } else if (name==="exp") { f=Math.exp; df=f(x); }
    else if (["asin","acos","atan"].includes(name)) {
      if (name!=="atan" && (lo< -1 || hi>1)) fail("domain",name+" requires values from −1 to 1.");
      f=Math[name]; df=name==="atan" ? 1/(1+x*x) : (name==="acos" ? -1 : 1)/Math.sqrt(1-x*x); tag="angle";
    } else {
      f=Math[name];
      const containsPhase=(phase,period)=>Math.ceil((lo-phase)/period)<=Math.floor((hi-phase)/period);
      if (name==="tan" && containsPhase(Math.PI/2,Math.PI)) fail("domain","Tangent is undefined at a pole in the input range.");
      df=name==="sin" ? Math.cos(x) : name==="cos" ? -Math.sin(x) : 1/Math.cos(x)**2;
      if (name!=="tan") {
        const phase=name==="sin" ? Math.PI/2 : 0;
        range=extremes([f(lo),f(hi)]);
        if (containsPhase(phase,2*Math.PI)) range.max=1;
        if (containsPhase(phase+Math.PI,2*Math.PI)) range.min=-1;
      }
    }
    const q=lift([a],{value:f(x),tag,partials:[df],bounds:range || extremes([f(lo),f(hi)])});
    if (name==="log10") q.logRatio=true;
    if (tag==="angle") q.preferred="rad";
    return q;
  }
  function preferredLiteral(a,text) {
    if (text) a.inputUnit=text;
    return a;
  }
  function evaluatedRaw(raw,meta) {
    if (typeof raw!=="string" && typeof raw!=="number") fail("binding","A bound field needs a numeric value or component marking.");
    const original=String(raw);
    let text=original;
    if (!text.trim()) fail("binding","The bound field is empty.");
    // IEC-style decimal markers apply only to typed component fields.
    const marking=(meta.unit || meta.fieldUnit) && /^(\s*)([+-]?)(\d*)([RrKkMmGnpµμu])(\d+)(?=\s|$|[ΩFHVA±])/u.exec(text);
    let originalSpan=span=>span;
    if (marking) {
      const [matched,space,sign,before,mark,after]=marking;
      const replacement=space+sign+(before || "0")+"."+after+({R:"",r:"",K:"k"}[mark] ?? mark);
      text=replacement+text.slice(matched.length);
      const offset=i=>i>=replacement.length ? i+matched.length-replacement.length : Math.min(i,matched.length);
      originalSpan=span=>span?.map(offset);
    }
    const parsed=parse(text);
    if (!parsed.ok) throw error(parsed.diagnostic.code,parsed.diagnostic.message,originalSpan(parsed.diagnostic.span));
    // Bound component values cannot call a user function or resolve another field.
    const permitted=n=>n.type==="number" || (n.type==="unary" && permitted(n.arg)) ||
      (n.type==="binary" && n.op==="±" && permitted(n.left) && permitted(n.right));
    if (parsed.name || parsed.asserted || !permitted(parsed.ast)) fail("binding","Expected a component marking with an optional tolerance.");
    const ctx={options:{},sourceKey:meta.sourceId || "bound",budget:{steps:0},stack:[]};
    const inline=parsed.ast.type==="binary" && parsed.ast.op==="±";
    let q=visit(inline ? parsed.ast.left : parsed.ast,ctx);
    if (meta.fieldUnit!==undefined || meta.unit) {
      const valueNode=inline ? parsed.ast.left : parsed.ast;
      const declared=meta.fieldUnit ?? meta.unit;
      // Older library metadata supplies a default for otherwise untyped markings.
      // A schema declaration also checks the dimension of an explicit marking.
      if (meta.fieldUnit!==undefined || bareLiteral(valueNode) || compatible(q,unit(declared))) {
        q=fieldOperand(q,declared,{span:originalSpan(valueNode.span)},bareLiteral(valueNode));
        if (meta.fieldUnit!==undefined) q.fieldUnit=declared;
      }
    }
    if (inline) q=addTolerance(q,widthOf(q,visit(parsed.ast.right,ctx)),ctx.sourceKey);
    return {q,inline};
  }
  function coherent(data) {
    const q=exact(data.value,data.dimensions,data.tag || "");
    if (!Array.isArray(data.dimensions) || data.dimensions.length!==7 || !data.dimensions.every(Number.isFinite)) fail("binding","Invalid SI dimension vector.");
    if (data.worst) {
      if (!Number.isFinite(data.worst.min) || !Number.isFinite(data.worst.max) || data.worst.min>q.value || data.worst.max<q.value) fail("binding","Invalid input tolerance bounds.");
      q.worst={...data.worst};
    }
    q.contributions=Object.assign(Object.create(null),data.contributions || {});
    if (!Object.values(q.contributions).every(Number.isFinite)) fail("binding","Invalid input sensitivities.");
    q.rss=data.rss===null ? null : Math.hypot(...Object.values(q.contributions));
    for (const key of ["unknown","defaults","warnings"]) if (Array.isArray(data[key])) q[key]=data[key].slice();
    for (const key of ["preferred","inputUnit","fieldUnit","rssReason","depends","bound"]) if (data[key]!==undefined) q[key]=data[key];
    return q;
  }
  function bound(data,name) {
    if (data==null || data.ok===false) {
      const issue=data?.diagnostic;
      fail(issue?.code || "reference",issue?.message || "No unambiguous value for "+name+".");
    }
    if (typeof data==="number") return exact(data);
    if (Array.isArray(data.dimensions)) {
      const q=coherent(data);
      if (data.fieldUnit!==undefined) fieldOperand(q,data.fieldUnit,{},false);
      return {...q,bound:data.sourceId || data.bound || name,depends:true};
    }
    const label=data.label || name, id=String(data.sourceId || name);
    const source={...data,sourceId:id};
    let {q,inline}=evaluatedRaw(data.raw ?? data.value, source);
    if (!inline && data.tolerance!=null) {
      const t=data.tolerance, input=unit(q.inputUnit || data.unit || "");
      if (has(t,"relative")) q=addTolerance(q,Math.abs(q.value)*t.relative,id);
      else if (has(t,"absolute")) q=addTolerance(q,t.absolute*input.factor,id);
      else fail("tolerance","Expected an absolute or relative tolerance.");
      if (data.toleranceSource==="default") {
        const amount=has(t,"relative") ? formatted(t.relative*100)+"%" : formatted(t.absolute)+" "+(q.inputUnit || data.unit || "");
        q.defaults=[label+" (±"+amount+")"];
      }
    } else if (!inline && (data.sourceId || data.toleranceSource==="unknown")) q.unknown=[label];
    if (inline) {
      // Give every occurrence of this placed component's tolerance the same identity.
      const w=Object.values(q.contributions).reduce((a,b)=>a+b,0);
      q.contributions=Object.create(null); if (w) q.contributions[id]=w;
    }
    q.bound=id; q.depends=true;
    return q;
  }
  function completed(q,parsed,options={}) {
    const warnings=(q.warnings || []).filter(w=>!w.startsWith("tolerance unknown: ") && !w.startsWith("default tolerance: "));
    if (q.unknown?.length) warnings.push("tolerance unknown: "+q.unknown.join(", "));
    if (q.defaults?.length) warnings.push("default tolerance: "+q.defaults.join(", "));
    if (q.rssReason && !warnings.includes(q.rssReason)) warnings.push(q.rssReason);
    const p=presentation(q,options.displayUnit);
    return {...q,ok:true,copyText:p.display,...p,warnings,references:parsed?.references || [],...(parsed?.name ? {name:parsed.name} : {})};
  }
  function parseBoundValue(raw,meta={}) {
    try { return completed(bound({...meta,raw},meta.label || "field")); }
    catch(e) { const result=diagnostic(e); if (!result.diagnostic.span) result.diagnostic.span=[0,String(raw).length]; return result; }
  }
  function functionDeclaration(registry,id) {
    if (registry instanceof Map) return registry.get(id);
    if (Array.isArray(registry)) return registry.find(x=>x.id===id);
    return has(registry,id) ? registry[id] : null;
  }
  const api=Object.freeze({quantity,as,withUnit,lift,record,error,format:(q,u)=>presentation(q,u).display});
  function invoke(name,args,ctx) {
    if(ctx.options.tableRanges && args.some(a=>a?.kind==="tableRange")) {
      if(!["sum","min","max","average"].includes(name.toLowerCase()))fail("type","Use a table range with SUM, AVERAGE, MIN or MAX.");
      args=args.flatMap(a=>a?.kind==="tableRange"?a.values:[a]);
    }
    const built=builtin(name.toLowerCase(),args);
    if (built) return built;
    const helper=root.AtriumCalculationHelpers?.invoke(name,args,api);
    if (helper!=null) return helper;
    const declaration=functionDeclaration(ctx.options.functions,name);
    if (!declaration) fail("function","Unknown or unavailable function "+name+".");
    if (ctx.allowedFunctions && !ctx.allowedFunctions.some(d=>d.id===name && d.version===declaration.version)) fail("function","The function dependency or its version is undeclared.");
    return runDeclaration(declaration,args,ctx);
  }
  function countOf(n,ctx) {
    if (ctx.locals) fail("function","Design queries are unavailable inside a pure extension function.",n.span);
    const result=ctx.options.countQuery?.(n.query), issue=result?.diagnostic || (result?.code ? result : null);
    if (ctx.options.signal?.aborted) fail("aborted","Calculation cancelled.",n.span);
    if (issue?.code==="denied" || result?.status==="denied") fail("denied","The requested design query is unavailable.",n.query.span);
    if (issue) {
      const [from,to]=n.query.span, span=issue.span;
      const located=Array.isArray(span) && span.length===2 && span.every(Number.isInteger) && span[0]>=0 && span[1]>=span[0] && span[1]<=to-from;
      fail(issue.code || "query",issue.message || "The design query is incomplete.",located ? span.map(i=>from+i) : n.query.span);
    }
    const value=typeof result==="number" ? result : result?.complete===true && (!result.status || result.status==="complete") ? result.count : null;
    if (!Number.isSafeInteger(value) || value<0) fail("query-incomplete","A complete design query count is required.",n.query.span);
    return quantity(value,"ea");
  }
  function hintFor(n) {
    while (n.type==="group") n=n.child;
    if (n.type==="count") return ()=>"ea";
    if (n.type==="ref") return q=>q.fieldUnit;
    return ()=>undefined;
  }
  function binaryOperation(n) {
    if (n.op==="&&") return (a,b)=>{
      if (a.kind!=="assertion" || b.kind!=="assertion") fail("type","Both sides of && must be predicates.");
      const states=[a.assertion.status,b.assertion.status];
      const status=states.includes("fail") ? "fail" : states.includes("may-violate") ? "may-violate" : "pass";
      return {...a,display:status==="pass" ? "Pass" : status==="fail" ? "Fail" : "May violate",assertion:{...a.assertion,status},
        unknown:distinct([...a.unknown,...b.unknown]),defaults:distinct([...a.defaults,...b.defaults]),warnings:distinct([...a.warnings,...b.warnings])};
    };
    if (precedence[n.op]===2) {
      const left=hintFor(n.left), right=hintFor(n.right), bareLeft=bareLiteral(n.left), bareRight=bareLiteral(n.right);
      return (a,b,ctx)=>{
        const field=left(a), rightField=right(b);
        if (field) b=fieldOperand(b,field,n.right,bareRight);
        else if (rightField) a=fieldOperand(a,rightField,n.left,bareLeft);
        return comparison(a,b,n.op,ctx.domain);
      };
    }
    return (a,b,ctx)=>{
      const q=arithmetic(n.op,a,b,n,ctx);
      q.depends=!!(a.depends || b.depends);
      if (uncertain(q) && n.op!=="±" && Object.keys(a.contributions).some(k=>has(b.contributions,k)))
        q.warnings=distinct([...q.warnings,"Worst-case bounds may be conservative for shared inputs."]);
      return q;
    };
  }

  // Choose node readers once. A query plan can run this graph for many subjects;
  // the same readers handle a sheet, a pure package function or a palette result.
  const programs=new WeakMap();
  function operation(n) {
    switch (n.type) {
      case "number": return ()=>preferredLiteral(quantity(n.value,n.unit),n.unit);
      case "count": return ctx=>countOf(n,ctx);
      case "string": return ()=>n.value;
      case "group": return program(n.child);
      case "ref": {
        const ref={name:n.name,span:n.span};
        return ctx=>{
          if (has(ctx.locals,n.name)) return ctx.locals[n.name];
          if (has(constants,n.name)) return n.name==="c" ? {...quantity(constants.c,"metre/s"),metadata:{medium:"vacuum"}} : quantity(constants[n.name]);
          if (ctx.locals) fail("reference","Unknown function argument "+n.name+".");
          const data=ctx.options.resolve ? ctx.options.resolve(ref) : has(ctx.options.bindings,n.name) ? ctx.options.bindings[n.name] : undefined;
          if(ctx.options.tableRanges && data?.kind==="tableRange")return data;
          return bound(data,n.name);
        };
      }
      case "field": {
        const read=program(n.object), keys=n.key.split(".");
        return ctx=>{
          let r=read(ctx);
          for (const key of keys) {
            if (r?.kind!=="record" || !has(r.fields,key)) fail("field","Unknown result field "+key+".");
            r=r.fields[key];
          }
          return r;
        };
      }
      case "convert": {
        const read=program(n.child);
        return ctx=>{
          const q=scalar(read(ctx));
          return root.AtriumCalculationHelpers?.convert?.(q,n.unit,api) || withUnit(q,n.unit);
        };
      }
      case "unary": {
        const read=program(n.arg), literal=n.arg.type==="number";
        if (n.op==="+") return ctx=>scalar(read(ctx));
        return ctx=>{
          const q=scalar(read(ctx));
          if (literal && q.tag && q.tag!=="angle" && q.tag!=="delta")
            return preferredLiteral(quantity(-n.arg.value,n.arg.unit),n.arg.unit);
          if (q.tag!=="count") requireLinear(q);
          return {...lift([q],{value:-q.value,dimensions:q.dimensions,tag:q.tag,partials:[-1],bounds:{min:-q.worst.max,max:-q.worst.min}}),
            inputUnit:q.inputUnit,preferred:q.preferred,depends:q.depends};
        };
      }
      case "binary": {
        const left=program(n.left), right=program(n.right), combine=binaryOperation(n);
        return ctx=>combine(left(ctx),right(ctx),ctx);
      }
      case "call": {
        const args=n.args.map(program);
        if (n.id.toLowerCase()==="if") return ctx=>{
          if(args.length!==3)fail("arity","IF needs a condition and two results.");
          const condition=args[0](ctx);
          let yes;
          if(condition.kind==="assertion"){
            if(condition.assertion.status==="may-violate")fail("uncertain","The IF condition may be true or false within tolerance.",n.args[0].span);
            yes=condition.assertion.status==="pass";
          }else{
            const number=scalar(condition);
            if(!equalDims(number.dimensions,zero))fail("dimension","The IF condition must be a comparison or dimensionless quantity.",n.args[0].span);
            yes=number.value!==0;
          }
          return args[yes?1:2](ctx);
        };
        return ctx=>invoke(n.id,args.map(read=>read(ctx)),ctx);
      }
      default: return ()=>fail("syntax","Unknown calculation syntax.");
    }
  }
  function program(n) {
    let read=programs.get(n);
    if (read) return read;
    const evaluate=operation(n);
    read=ctx=>{
      try {
        if (++ctx.budget.steps>limits.steps) fail("limit","Calculation exceeded its operation budget.");
        if (ctx.options.signal?.aborted) fail("aborted","Calculation cancelled.");
        return evaluate(ctx);
      } catch (e) {
        if (e.diagnostic && !e.diagnostic.span) e.diagnostic.span=n.opSpan || n.span;
        throw e;
      }
    };
    programs.set(n,read);
    return read;
  }
  function visit(node,ctx) { return program(node)(ctx); }
  function runDeclaration(d,args,ctx) {
    if (!d || typeof d.id!=="string" || !Array.isArray(d.arguments) || args.length!==d.arguments.length) fail("arity","Wrong number of extension function arguments.");
    if (ctx.stack.includes(d.id)) fail("cycle","Recursive calculation functions are unavailable.");
    if (ctx.stack.length>=16) fail("limit","Function call depth exceeded.");
    const locals=Object.create(null);
    d.arguments.forEach((spec,i)=>{
      const input=args[i]; let q;
      if (input?.kind==="quantity") q=input;
      else if (Array.isArray(input?.dimensions)) q=coherent(input);
      else if (input && typeof input.value==="number") q=quantity(input.value,input.unit || input.dimension || "");
      else fail("type","A function argument must be a typed quantity.");
      as(q,spec.dimension || ""); locals[spec.name]=q;
    });
    const child={...ctx,locals,allowedFunctions:d.dependencies || [],stack:[...ctx.stack,d.id],sourceKey:d.id+"@"+d.version};
    const source=(s,predicate)=>{
      const p=parse(s,{predicate});
      if (!p.ok) throw error(p.diagnostic.code,p.diagnostic.message,p.diagnostic.span);
      if (p.name || p.asserted) fail("function","A function body must be a pure expression.");
      return visit(p.ast,{...child,domain:predicate});
    };
    for (const condition of domainConditions(d.domain)) {
      const check=source(condition,true);
      if (check.kind!=="assertion" || check.assertion.status!=="pass") fail("domain","The arguments are outside the declared domain of "+d.id+".");
    }
    const out=scalar(source(d.expression,false)); as(out,d.returns || ""); return out;
  }
  function domainConditions(domain) {
    if (!domain || domain==="true") return [];
    const entries=Array.isArray(domain) ? domain : [domain];
    if (entries.length>32 || entries.some(s=>typeof s!=="string" || !s.trim())) fail("function","Invalid function domain.");
    return entries;
  }
  function validateFunctions(declarations,options={}) {
    try {
      if (!Array.isArray(declarations) || declarations.length>64) fail("limit","Provide up to 64 function declarations.");
      const local=new Map(), visiting=new Set(), checked=new Set();
      let steps=0;
      function spend() {
        if (++steps>limits.steps) fail("limit","Function validation exceeded its operation budget.");
        if (options.signal?.aborted) fail("aborted","Function validation cancelled.");
      }
      const idPattern=/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
      for (const d of declarations) {
        if (!d || typeof d.id!=="string" || !idPattern.test(d.id) || (d.id.includes("-") && !d.id.includes(".")) || local.has(d.id)) fail("function","Each declaration needs a unique callable identifier.");
        local.set(d.id,d);
      }
      const lookup=id=>local.get(id) || functionDeclaration(options.functions,id);
      function check(d) {
        spend();
        if (checked.has(d.id)) return;
        if (visiting.has(d.id)) fail("cycle","Recursive calculation functions are unavailable.");
        if (visiting.size>=16 || checked.size>=64) fail("limit","Function dependency limit exceeded.");
        visiting.add(d.id);
        if (typeof d.version!=="string" || !d.version || !unitInfo(d.returns) || !Array.isArray(d.arguments) || d.arguments.length>32)
          fail("function","A declaration needs a version, typed arguments and a return dimension.");
        const args=new Set();
        for (const a of d.arguments) {
          if (!a || typeof a.name!=="string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.name) || args.has(a.name) || !unitInfo(a.dimension))
            fail("function","Invalid argument name or dimension.");
          args.add(a.name);
        }
        const pins=new Map();
        if (d.dependencies!=null && !Array.isArray(d.dependencies)) fail("function","Provide a list of function dependencies.");
        for (const pin of d.dependencies || []) {
          const target=pin && lookup(pin.id);
          if (!target || target.version!==pin.version || pins.has(pin.id)) fail("function","A pinned function dependency is missing, duplicated or incompatible.");
          pins.set(pin.id,target); check(target);
        }
        function inspect(n) {
          spend();
          switch (n.type) {
            case "number": case "string": return;
            case "count": fail("function","Design queries are unavailable inside a pure extension function.",n.span); return;
            case "ref": if (!args.has(n.name) && !has(constants,n.name)) fail("reference","Unknown function argument "+n.name+".",n.span); return;
            case "group": case "convert": inspect(n.child); return;
            case "unary": inspect(n.arg); return;
            case "binary": inspect(n.left); inspect(n.right); return;
            case "field": inspect(n.object); return;
            case "call": {
              const id=n.id.toLowerCase();
              const standard=unaryFunctions.includes(id) || ["min","max","sum","average","if"].includes(id);
              const helper=root.AtriumCalculationHelpers?.names?.some(x=>x.toLowerCase()===id);
              if (!standard && !helper && !pins.has(n.id)) fail("function","Undeclared or unknown function "+n.id+".",n.span);
              if ((unaryFunctions.includes(id) && n.args.length!==1) || (["min","max","average"].includes(id) && !n.args.length) || (id==="if" && n.args.length!==3) ||
                  (pins.has(n.id) && n.args.length!==pins.get(n.id).arguments.length)) fail("arity","Wrong number of arguments for "+n.id+".",n.span);
              n.args.forEach(inspect); return;
            }
            default: fail("syntax","Unrecognised function expression.",n.span);
          }
        }
        for (const [text,predicate] of [[d.expression,false],...domainConditions(d.domain).map(cond=>[cond,true])]) {
          const p=parse(text,{predicate});
          if (!p.ok) throw error(p.diagnostic.code,p.diagnostic.message,p.diagnostic.span);
          if (p.name || p.asserted) fail("function","A function body must be a pure expression.",p.ast.span);
          let rootNode=p.ast; while (rootNode.type==="group") rootNode=rootNode.child;
          if (predicate && !(rootNode.type==="binary" && (rootNode.op==="&&" || precedence[rootNode.op]===2))) fail("domain","A declared domain must be a predicate.",p.ast.span);
          inspect(p.ast);
        }
        visiting.delete(d.id); checked.add(d.id);
      }
      declarations.forEach(check);
      return {ok:true};
    } catch(e) { const r=diagnostic(e); if (!r.diagnostic.span) r.diagnostic.span=[0,0]; return r; }
  }
  function evaluateFunction(declaration,args,options={}) {
    try {
      const q=runDeclaration(declaration,args,{options,budget:{steps:0},stack:[]});
      return {...completed(q,null,options),dimension:declaration.returns};
    } catch(e) {
      const r=diagnostic(e); if (!r.diagnostic.span) r.diagnostic.span=[0,0]; return r;
    }
  }
  function parsedSource(source) {
    return (typeof source==="string" ? parse(source) : source) || {ok:false,diagnostic:{code:"source",message:"Enter an expression.",span:[0,0]}};
  }
  function evaluateParsed(p,options,format,read=program(p.ast),bare=bareLiteral(p.ast)) {
    try {
      const ctx={options,sourceKey:options.sourceId || p.source,budget:{steps:0},stack:[]};
      let q=read(ctx);
      if (typeof q==="string" || q?.kind==="tableRange") fail("type","Select a numeric or typed function result.",p.ast.span);
      if (p.asserted && q.kind!=="assertion") fail("assertion","An assertion needs a comparison.",p.ast.span);
      if (options.fieldUnit!==undefined) q=fieldOperand(q,options.fieldUnit,p.ast,bare);
      return format ? completed(q,p,options) : {...q,ok:true};
    } catch(e) { const r=diagnostic(e); if (!r.diagnostic.span) r.diagnostic.span=p.ast.span; return r; }
  }
  function evaluate(source,options={}) {
    const p=parsedSource(source);
    return p.ok ? evaluateParsed(p,options,true) : p;
  }
  function evaluateField(source,field,options={}) {
    return evaluate(source,{...options,fieldUnit:field?.unit});
  }
  // Query plans bind the field once, then read nominal quantities without formatting
  // each subject. References, uncertainty and declared-unit checks use the same tree.
  function compileScalar(source,field=null) {
    const p=parsedSource(source);
    if (!p.ok) return p;
    const fieldUnit=field?.unit;
    if (fieldUnit!==undefined && !unitInfo(fieldUnit==="m" ? "metre" : fieldUnit))
      return {ok:false,diagnostic:{code:"unit",message:"Unknown unit "+fieldUnit+".",span:p.ast.span}};
    const read=program(p.ast), bare=bareLiteral(p.ast);
    return {ok:true,references:p.references,queries:p.queries,bareLiteral:bare,
      read:(options={})=>evaluateParsed(p,fieldUnit===undefined ? options : {...options,fieldUnit},false,read,bare)};
  }
  globalThis.AtriumCalculationCore=Object.freeze({parse,evaluate,evaluateField,compileScalar,compareNominal,evaluateFunction,validateFunctions,parseBoundValue,format:(q,u)=>presentation(q,u).display,quantity,as,withUnit,units:unitInfo});
})(globalThis);
