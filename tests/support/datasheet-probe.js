"use strict";
// Shared Chromium and WKWebView proof with the real bundled worker.
globalThis.runDatasheetProbe = async (pdf,{present}={}) => {
  const service = AtriumDatasheets, bytes = Uint8Array.from(atob(pdf),ch=>ch.charCodeAt(0));
  const stage = async (name, operation) => {
    try {return await operation;}
    catch (error) {throw Error(name + ": " + error.name + ": " + error.message);}
  };
  const reference = await stage("Cache PDF",service.openBytes({bytes,name:"Benchmark.pdf"}));
  const unopened = Array.from({length:10},()=>service.createReader(reference));
  const none = await Promise.all(unopened.map(reader=>reader.visible([])));
  const untouched = service.metrics();
  for (const reader of unopened) reader.close();
  const cold = service.createReader(reference);
  await stage("Cold page",cold.visible([1],{side:320}));
  cold.close();
  const surface = document.createElement("canvas");
  document.body.append(surface);
  const context=surface.getContext("2d"), warmMs=[], presentedMs=[];
  let colored=false;
  async function warmPage(reader) {
    const before = performance.now();
    const reply = await stage("Warm page",reader.visible([1],{side:320}));
    warmMs.push(performance.now()-before);
    const png = reply.pages[0]?.png;
    if (!png?.length) throw Error("No first page was rasterized.");
    const rendered = await stage("Decode first page",createImageBitmap(new Blob([png],{type:"image/png"})));
    surface.width=rendered.width;
    surface.height=rendered.height;
    context.drawImage(rendered,0,0);
    rendered.close();
    if (present) await present();
    else await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    presentedMs.push(performance.now()-before);
    colored ||= context.getImageData(0,0,surface.width,surface.height).data.some((value,i,array)=>
      i%4===0 && value<100 && array[i+2]>100 && array[i+3]===255);
  }
  const warm = service.createReader(reference);
  const siblings = Array.from({length:9},()=>service.createReader(reference));
  await Promise.all([warm,...siblings].map(reader=>reader.info()));
  await warmPage(warm);
  for (const next of siblings) {
    try {await warmPage(next);}
    finally {next.close();}
  }
  const {pages} = await warm.info(), table = await warm.table({page:1});
  const earlier = warm.visible([2,3,4,5,6,7],{side:1024}).then(()=>null,error=>error.name);
  const recent = await warm.visible([4],{side:320});
  const cancelled = await earlier;
  const snip = await warm.snip({page:1,region:[0,100000,500000,600000],side:240});
  const search = await warm.search({query:"Ground",start:1,maxPages:1});
  warm.close();
  return {reference,untouched,unopened: none.every(n=>n.pages.length===0),pages,rows:table.rows,
    current:recent.pages.map(p=>p.page),cancelled,warmMs,presentedMs,colored,snip:[snip.width,snip.height],
    occurrences:search.matches.map(r=>r.page),ended:service.metrics()};
};
