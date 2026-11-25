"use strict";
// Net name intent (docs/design/net-intent.md): what a net name says. Pure, memoised, deterministic; name evidence
// only, so readings are at most "likely". read(name) → frozen {name, core, scope, role, level, explain[], …};
// pairs(nets, existing?, {min?}) as AtriumRules.detectDiffPairs; orient, polarity, voltage, isGround, isRail,
// isSupply, isClock, isHighSpeed, explain. Roles: docs/design/net-intent.md §3.3, §15.
globalThis.AtriumNetIntent=(()=>{
  const W=s=>new Set(s.split(" "));
  // "v:K1,K2 v2:K3" → Map(K → v), first wins
  const M=s=>{const m=new Map();for(const g of s.split(" ")){const [v,ks]=g.split(":");for(const k of ks.split(","))if(!m.has(k))m.set(k,v);}return m;};
  const GROUND=W("GND AGND DGND PGND SGND CGND EGND GNDA GNDD GNDPWR VSS VSSA VSSD VSSIO EARTH CHASSIS SHIELD GROUND");
  const GDOM=M("A:AGND,GNDA,VSSA D:DGND,GNDD,VSSD P:PGND,GNDPWR S:SGND C:CGND,CHASSIS,SHIELD PE:EARTH,EGND");
  const RAIL=W("VCC VDD VEE VBAT VBATT BATT VBUS VUSB VIO VIN VSYS VMAIN VCORE VDDQ VDDIO VCCIO VCCQ VTT VPP VREF AVDD DVDD PVDD IOVDD AVCC DVCC VCCA VCCD VDDA VDDD VCCINT VCCAUX VDDCORE VLED VMOT PWR V");
  const KIND=M("reference:VREF termination:VTT battery:VBAT bus:VBUS");
  const FUNC=W("EN ENABLE PG PGOOD POK PWRGD PWROK FB SENSE SNS ISENSE VSENSE ISNS DET DETECT OK FAULT FLT ALERT SHDN ON OFF MON ADC SEL CTRL CTL GATE DRV DIV");
  const CONTROL=M("reset:RST,RESET,MCLR,POR irq:INT,IRQ,DRDY,ALERT,ALRT,INTR cs:CS,SS,CE enable:EN,ENABLE,OE,SHDN,PWRDN,STBY,STANDBY,SLEEP,WAKE "+
    "control:WE,WR,RD,WP,HOLD,BUSY,RDY,READY,FAULT,FLT,PG,PGOOD,ACK,REQ,LDAC,CLR,BOOT,PROG,DE,RE,LOAD");
  const CLOCK=W("CLK CLOCK SCLK SCK MCLK BCLK LRCLK REFCLK SYSCLK CK WCK XTAL XI XO XIN XOUT OSC OSCIN OSCOUT OSC32 SCL SWCLK TCK PCLK HCLK DCLK MDC WCLK");
  const CRYSTAL=W("XTAL XI XO XIN XOUT OSC OSCIN OSCOUT OSC32"),SLOW=W("SCL MDC SWCLK TCK");
  const DIR=M("tx:TX,TXD,TD rx:RX,RXD,RD mosi:MOSI,COPI,SDI miso:MISO,CIPO,SDO in:DIN out:DOUT data:SDA");
  const FAST=W("USB USB2 USB3 PCIE SATA HDMI TMDS DP MIPI CSI DSI LVDS ETH RGMII SGMII MDI QSPI SDIO EMMC DDR DDR2 DDR3 DDR4 DDR5 LPDDR4 LPDDR4X LPDDR5 LPDDR5X");
  const PROTO=W([...FAST].join(" ")+" PCI RMII CAN RS485 RS422 RS232 PROFIBUS UART USART I2C IIC I3C SPI JTAG SWD I2S SAI");
  const SERIAL=W("TX RX TD RD TRD CLK REFCLK CK D DQS DATA LANE ML MDI LVDS AIN IN VIN VREF");// may take a bare P/N: RXP, not CAP
  const DECOR=W("R C CONN CON EXT ESD FILT FLTR RAW BUF AC");
  // polarity token → [sign, …partner tokens]
  const POL={"+":[1,"-"],"-":[-1,"+"]};
  for(const g of "P+N N-P DP+DM,DN DM-DP DN-DP H+L L-H T+C C-T POS+NEG NEG-POS PLUS+MINUS MINUS-PLUS M-P A+B B-A".split(" ")){const [,k,s,p]=/^(\w+)([+-])(.+)$/.exec(g);POL[k]=[s==="+"?1:-1,...p.split(",")];}
  const AUTO=/^(?:Net[A-Z]+\d+[A-Z]*_\w+|Net-\(.*\)|unconnected-\(.*\)|Net-[A-Z]+\d+[A-Z]*-\w+|Net-\d+|N\d{4,}|N\$\d+|\$\$\$\d+)$/i;
  const PROTO_RE=/^(?:I2C|I2S|I3C|RS485|RS422|RS232|LPDDR[45]X?|DDR[2-5]|USB[23]|PCIE[1-6]?)(?![A-Z])/;
  const RAIL_PRE=/^(?:VCC|VDD|VEE|AVDD|DVDD|PVDD)[A-Z]+$/,GND_PRE=/^(?:VSS|[ADPSC]?GND)[A-Z]+$/,IN=/^(?:A|V)?IN$/,ANALOG=/^(?:A|V)?IN$|^VREF$/;
  const up=s=>s.replace(/[a-z]/g,c=>c.toUpperCase()),sign=n=>n>0?"positive":"negative";
  const known=w=>GROUND.has(w)||RAIL.has(w)||FUNC.has(w)||CONTROL.has(w)||CLOCK.has(w)||PROTO.has(w)||DIR.has(w)||w in POL;

  // ------------------------------------------------------------------ tokens
  // {t upper, raw, k: w word, n number, v volts, f Hz, s sign, m active-low mark; at, end, v}
  function tokens(s){
    const u=up(s),hz=/CLK|CLOCK|OSC|XTAL|XI|XO|CK/.test(u),out=[],push=(k,at,end,v)=>out.push({t:u.slice(at,end),raw:s.slice(at,end),k,at,end,v});
    for(let i=0,m;i<u.length;){
      const r=u.slice(i),c=u[i],at=i;
      if(c==="+"||c==="-"){if(!i)push("s",0,1,"lead");else if(c==="+"||i===u.length-1||/[_.\s]/.test(u[i+1]))push("s",i,i+1);i++;}
      else if(c==="#")push("m",i,++i,"#");
      else if((m=/^(\d+)V(\d+)/.exec(r)))push("v",i,i+=m[0].length,+(m[1]+"."+m[2]));
      else if((m=/^(\d+(?:[.,]\d+)?)V(?:(?![A-Z])|(?=(?:AC|DC|SB)(?![A-Z])))/.exec(r)))push("v",i,i+=m[0].length,+m[1].replace(",","."));
      else if(hz&&(m=/^(\d+)K(\d+)(?![A-Z\d])/.exec(r)))push("f",i,i+=m[0].length,+(m[1]+"."+m[2])*1e3);
      else if((m=/^(\d+(?:\.\d+)?)(G|M|K)?(HZ)?(?![A-Z])/.exec(r))&&(m[3]||hz&&m[2]&&+m[1]))push("f",i,i+=m[0].length,+m[1]*({G:1e9,M:1e6,K:1e3}[m[2]]||1));
      else if((m=/^\d+[.,]\d+/.exec(r)||/^\d+/.exec(r)))push("n",i,i+=m[0].length,+m[0].replace(",","."));
      else if((m=PROTO_RE.exec(r)))push("w",i,i+=m[0].length);
      else if((m=/^[A-Z]+/.exec(r)))word(s,u,at,i+=m[0].length,push);
      else i++;
    }
    return out;
  }
  // Letters, split where a dictionary claims them: RXP, CANH, nRST, RSTn, XRST.
  function word(s,u,a,b,push){
    const w=u.slice(a,b),head=w.slice(0,-1),last=w.slice(-1),two=(x,k,v)=>{push(k[0],a,x,v);push(k[1],x,b,v);};
    if(known(w)||w.length<3)return push("w",a,b);
    if(w[0]==="N"&&CONTROL.has(w.slice(1)))return two(a+1,"mw","n");
    if(s[b-1]==="n"&&CONTROL.has(head))return two(b-1,"wm","n");
    if(w[0]==="X"&&CONTROL.has(w.slice(1)))return two(a+1,"mw","x");
    if((last==="P"||last==="N")&&SERIAL.has(head)||last==="M"&&IN.test(head)||(last==="H"||last==="L")&&head==="CAN")return two(b-1,"ww");
    push("w",a,b);
  }

  // ------------------------------------------------------------------ reading
  const cut=(s,t)=>(s.slice(0,t.at)+s.slice(t.end)).replace(/([_\-.\s])[_\-.\s]+/g,"$1").replace(/^[_\-.\s]+|[_\-.\s]+$/g,"");
  // The polarity token near the end: …_P, …+, TXP0 (lane after), PCIE_TX0_P_C (decoration after).
  function polarityAt(T,protocol){
    const ok=(j,end)=>{
      const t=T[j],x=t?.t;
      if(!t||!j&&(t.k!=="w"||x.length===1))return false;
      if(t.k==="s")return t.v!=="lead";
      if(t.k!=="w"||!(x in POL))return false;
      if(x==="T"||x==="C")return t.raw!==x;
      if(x==="H"||x==="L")return protocol==="CAN";
      if(x==="A"||x==="B")return /^(?:RS485|RS422|PROFIBUS)$/.test(protocol);
      if(x==="M")return T.slice(0,j).some(y=>IN.test(y.t));
      return x.length===1||end; // DP, POS, PLUS …: last token only
    };
    const j=T.length-1;
    return ok(j,true)?j:j>0&&(T[j].k==="n"&&/^[PN]$/.test(T[j-1].t)&&ok(j-1)||T[j].k==="w"&&DECOR.has(T[j].t)&&ok(j-1,true))?j-1:-1;
  }
  function pairOf(s,scope,T,j,protocol,ex){
    const t=T[j],x=t.t,[pol,...flip]=POL[x],ab=x==="A"||x==="B",analog=T.slice(0,j).some(y=>ANALOG.test(y.t)),flips=x==="P"&&analog?["N","M"]:flip;
    ex.push("polarity "+t.raw+" → "+sign(pol)+(ab?" (A/B: vendor-defined)":""));
    return {role:"pairMember",level:"weak",polarity:pol,known:!ab,stem:scope+cut(s,t),analog,highSpeed:!analog&&!ab&&protocol!=="CAN",
      pattern:t.k==="s"?"+/-":ab?"A/B":x==="T"||x==="C"?"t/c":pol>0?x+"/"+flips[0]:flips[0]+"/"+x,
      partners:flips.map(p=>scope+s.slice(0,t.at)+(t.raw!==x?p.toLowerCase():p)+s.slice(t.end))};
  }
  function analyse(name){
    const ex=[],r={name,core:"",scope:"",role:"unknown",level:"weak",explain:ex},set=(o,why)=>(ex.push(why),Object.assign(r,o));
    let s=String(name??"").normalize("NFKC").trim(),low="",m;
    if(!s)return r;
    if(AUTO.test(s))return set({core:s,role:"auto",level:"strong"},"auto-generated name");
    if(/^(?:NC|N\/C|DNC|NIC)$/i.test(s))return set({core:s,role:"nc",level:"likely"},"no-connect name");
    if((m=/^\/(.*\/)([^/]+)$/.exec(s))){r.scope="/"+m[1];s=m[2];ex.push("sheet path "+r.scope);}
    if((m=/^~\{([^}]+)\}(.*)$/.exec(s))){s=m[1]+m[2];low="~{} overbar";}
    else if(/^(?:[^\\]\\)+$/.test(s)){s=s.replace(/\\/g,"");low="Altium overline";}
    // Single "\" negation (\RESET, Preferences › Schematic › General): active low, as a _N suffix is.
    else if(s.length>1&&s[0]==="\\"&&s[1]!=="\\"&&!r.scope){low="its \\ prefix";s=s.slice(1).replace(/([^\\])\\/g,"$1");}
    else if(s.includes("̅")){s=s.replace(/̅/g,"");low="overline";}
    else if(s.length>1&&/^[!~/]/.test(s)&&!r.scope){low=s[0]+" prefix";s=s.slice(1);}
    const T=tokens(s),U=T.map(t=>t.t),words=T.filter(t=>t.k==="w"),has=w=>U.includes(w),lead=T[0]?.v==="lead"?T[0].t:"";
    const at=(f,i=-1)=>T.findIndex((t,k)=>k>i&&t.k==="w"&&f(t.t)),part=f=>r.scope+cut(s,{at:T[f].at,end:s.length});
    r.core=s;r.tokens=U;
    let protocol=words.find(t=>PROTO.has(t.t)&&(t.t!=="DP"||t===T[0]&&T.length>1))?.t||"";
    if(!protocol&&(m=T.find(t=>t.k==="n"&&(t.v===485||t.v===422))))protocol="RS"+m.v;
    if(protocol){r.protocol=protocol=protocol==="IIC"?"I2C":protocol;ex.push("protocol "+protocol);}
    // Mains, then the bare grounds
    const vac=T.findIndex((t,i)=>t.k==="v"&&T[i+1]?.t==="AC");
    if(has("MAINS")||has("NEUTRAL")||has("VAC")||vac>=0||/^(?:AC[_\-. ]?(?:L|N|LINE)\d*|(?:L|N)\d*[_\-. ]?AC|LINE)$/i.test(s))
      return set({role:"mains",level:"likely",part:has("N")||has("NEUTRAL")?"neutral":"line",voltage:vac>=0?T[vac].v:null},"mains name");
    if(/^(?:PE|COM|0V)$/i.test(s))return set({role:"ground",level:/COM/i.test(s)?"weak":"likely",domain:/PE/i.test(s)?"PE":"",isolated:false},s+" → ground");
    const gi=at(w=>GROUND.has(w)||GND_PRE.test(w));
    // V_BAT, V_USB, V_IO: a bare V before a supply word is that rail (VBAT, VUSB, VIO).
    const vword=(t,k)=>t.t==="V"&&T[k+1]?.k==="w"&&RAIL.has("V"+T[k+1].t)&&T[k+1].t!=="";
    const ri=T.findIndex((t,k)=>t.k==="w"&&(RAIL.has(t.t)&&(t.t!=="V"||T.length===2&&T[1].k==="s"||vword(t,k))||RAIL_PRE.test(t.t))||t.k==="v"&&t.v!==0);
    if(gi>=0&&(ri<0||gi<ri)){
      const f=at(w=>FUNC.has(w),gi);
      if(f>=0)return set({role:"railSignal",level:"likely",rail:part(f),function:T[f].t.toLowerCase()},T[f].t+" after "+T[gi].t+" → ground signal");
      const domain=[GDOM.get(T[gi].t)||"",T.filter((t,i)=>i!==gi&&/[wnv]/.test(t.k)).map(t=>t.t).join("_").replace(/_(\d)/g,"$1")].filter(Boolean).join("_");
      return set({role:"ground",level:"likely",domain,isolated:/ISO/.test(domain)},T[gi].t+" → ground"+(domain?", domain "+domain:""));
    }
    if(ri>=0){
      const t=T[ri],next=T[ri+1],rtn=at(w=>w==="RTN"||w==="RETURN",ri),pair=/^(?:VIN|VREF)$/.test(t.t)&&/^[PNM]$/.test(next?.k==="w"&&next.t);
      if(rtn>=0)return set({role:"ground",level:"likely",domain:cut(s,T[rtn]),returnOf:r.scope+cut(s,T[rtn]),isolated:false},"return of a rail → ground");
      // After a voltage token a signal word wins (3V3_SDA is an SDA line); after a rail stem it does not (VDD_CLK is a supply).
      const f=at(w=>FUNC.has(w),ri),sig=t.k!=="v"?-1:at(w=>(CONTROL.has(w)||CLOCK.has(w)||DIR.has(w))&&!FUNC.has(w),ri);
      if(!pair&&f>=0&&(sig<0||f<sig))return set({role:"railSignal",level:"likely",rail:part(f),function:T[f].t.toLowerCase(),activeLow:!!low||has("#")},T[f].t+" after "+part(f)+" → rail signal");
      if(!pair&&sig<0){
        const vt=T.find(x=>x.k==="v"&&x.v!==0),num=t.k==="w"&&next?.k==="n"&&/[.,]/.test(next.raw)?next:null,pre=vt&&T[T.indexOf(vt)-1];
        let v=vt?vt.v:num?num.v:null;
        if(v!=null&&(lead==="-"||pre?.k==="w"&&/^[NM]$/.test(pre.t)))v=-v;
        const stem=words.find(x=>RAIL.has(x.t)||RAIL_PRE.test(x.t))?.t||"",o={role:"rail",level:"likely",voltage:v,kind:KIND.get(stem)||"supply"};
        if(stem==="VBUS"&&v==null)Object.assign(o,{nominal:5,max:20});
        if(stem==="V"&&T[1]?.k==="s")o.sign=T[1].t==="+"?1:-1;
        const variant=T.filter(x=>x!==vt&&x!==num&&x.k==="w"&&x.t!==stem&&!/^(?:P|PP|N|M)$/.test(x.t)).map(x=>x.t).join("_");
        if(variant)o.variant=variant;
        return set(o,(stem||vt.raw)+" → rail"+(v!=null?", "+v+" V from "+(vt||num).raw:"")+(o.nominal?", VBUS 5 V (≤ 20 V with PD)":""));
      }
      if(t.k==="v")r.domainVoltage=t.v;
    }
    // Pair member, clock, control, data
    const j=polarityAt(T,protocol),ci=at(w=>CONTROL.has(w)),clk=at(w=>CLOCK.has(w)||/CLK$/.test(w)),mk=T.filter(t=>t.k==="m").map(t=>t.v);
    const suf=ci>=0&&T.slice(ci+1).find(t=>t.k==="w"&&/^(?:N|B|L|BAR)$/.test(t.t)),fn=ci>=0&&CONTROL.get(T[ci].t);
    const lowHow=low||(mk.includes("#")?"#":mk.includes("n")?"n":mk.includes("x")?"X prefix":suf?"_"+suf.t:"");
    if(clk>=0){r.clock=true;if((m=T.find(t=>t.k==="f")))r.freq=m.v;if(CRYSTAL.has(T[clk].t))r.crystal=true;if(SLOW.has(T[clk].t))r.speed="slow";}
    if((m=words.find(t=>DIR.has(t.t))))r.direction=DIR.get(m.t);
    const last=T[T.length-1];
    if(last?.k==="n"&&T.length>1&&j<0){r.index=last.v;r.stem=r.scope+cut(s,last);}
    if(j>=0){
      const p=pairOf(s,r.scope,T,j,protocol,ex);
      if(p.polarity<0&&T[j].t==="N"&&ci>=0&&ci===j-1)
        return set({role:"control",level:"likely",function:fn,activeLow:true,alt:Object.freeze({...p,partners:Object.freeze(p.partners)})},T[ci].t+"_N → active low (a pair if "+p.partners[0]+" exists)");
      if(r.clock)p.highSpeed=r.speed!=="slow";
      if(FAST.has(protocol))p.highSpeed=true;
      return Object.assign(r,p,lowHow?{activeLow:true}:{});
    }
    if(r.clock)return set({role:"clock",level:"likely",highSpeed:r.speed!=="slow"},T[clk].t+" → clock"+(r.freq?", "+r.freq+" Hz":"")+(r.crystal?", crystal":""));
    if(fn)return set({role:"control",level:"likely",function:fn,activeLow:!!lowHow},T[ci].t+" → "+fn+(lowHow?", active low by "+lowHow:""));
    if(low){r.activeLow=true;if(low[0]==="i")ex.push("active low by "+low);}
    if(protocol||r.direction)return set({role:"data",level:"likely",highSpeed:FAST.has(protocol)},"data signal");
    if(words.length)set({role:"signal"},"no known role");
    return r;
  }

  // ------------------------------------------------------------------ API
  const cache=new Map(),cmp=(a,b)=>a<b?-1:a>b?1:0;
  function read(name){
    const k=String(name??"");
    let r=cache.get(k);
    if(!r){
      if(cache.size>=50000)cache.clear();
      r=analyse(k);
      for(const f of ["explain","partners","tokens"])if(r[f])Object.freeze(r[f]);
      cache.set(k,r=Object.freeze(r));
    }
    return r;
  }
  const member=n=>{const r=read(n);return r.role==="pairMember"?r:r.alt||null;};
  // Pairs among net names, by positive net. Two candidate partners, or one claimed twice: no pair.
  function pairs(nets,existing=[],o={}){
    const all=new Set(nets),used=new Set(),names=new Set(),found=[],claims=new Map(),out=[];
    for(const p of existing||[]){used.add(p.positive);used.add(p.negative);names.add(p.name);}
    for(const n of [...all].sort(cmp)){
      const a=member(n);
      if(used.has(n)||!a||a.polarity!==1||!a.known&&o.min!=="weak")continue;
      const hits=a.partners.filter(x=>x!==n&&all.has(x)&&!used.has(x)&&member(x)?.polarity===-1&&member(x).stem===a.stem);
      if(hits.length===1){found.push([a,n,hits[0]]);claims.set(hits[0],(claims.get(hits[0])||0)+1);}
    }
    for(const [a,n,neg] of found){
      if(claims.get(neg)!==1)continue;
      const base=a.stem.replace(/^.*\//,"")||n,pr=read(n).protocol;
      let name=base,k=1;
      while(names.has(name))name=base+"_"+k++;
      names.add(name);used.add(n);used.add(neg);
      out.push({name,positive:n,negative:neg,pattern:a.pattern,level:a.known?"likely":"weak",known:a.known,
        explain:Object.freeze([a.pattern+" polarity","partner "+neg+" present",...(pr?["protocol "+pr]:[]),...(a.known?[]:["A/B: confirm which is positive"])])});
    }
    return out;
  }
  // Orientation of an explicit pair (a directive naming two nets).
  function orient(list){
    if(!Array.isArray(list)||list.length!==2||list[0]===list[1])return null;
    const [a,b]=list.map(member);
    if(a&&b&&a.polarity===-b.polarity){const p=a.polarity>0;return {positive:list[p?0:1],negative:list[p?1:0],pattern:(p?a:b).pattern,known:a.known&&b.known};}
    // Names differing only in a final P/N or +/- (SIGP/SIGN): the user grouped them, so trust it.
    const [x,y]=list.map(String),i=x.length-1,e=up(x[i]+y[i]),p=e==="PN"||e==="+-";
    if(x.length!==y.length||x.slice(0,i)!==y.slice(0,i)||!/^(?:PN|NP|\+-|-\+)$/.test(e))return null;
    return {positive:p?x:y,negative:p?y:x,pattern:/[PN]/.test(e)?"P/N":"+/-",known:true};
  }
  const role=n=>read(n).role;
  return Object.freeze({read,pairs,orient,tokens:s=>tokens(String(s??"")).map(t=>t.t),
    polarity:n=>{const p=member(n);return p&&{polarity:p.polarity,pattern:p.pattern,stem:p.stem,known:p.known};},
    explain:n=>{const r=read(n);return r.name+": "+r.role+" ("+r.level+")"+(r.explain.length?" — "+r.explain.join("; "):"");},
    voltage:n=>{const v=read(n).voltage;return Number.isFinite(v)?v:null;},
    isGround:n=>role(n)==="ground",isRail:n=>role(n)==="rail",isSupply:n=>/^(?:rail|ground)$/.test(role(n)),
    isClock:n=>!!read(n).clock,isHighSpeed:n=>!!read(n).highSpeed});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumNetIntent;
