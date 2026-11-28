import {openDocument, pageAspect, pageTable, pageText, renderPage, search} from "../notebook/datasheet-document.mjs";

const documents = new Map(), requests = new Map();

function keyOf(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw Error("Invalid datasheet identity.");
  return value;
}


async function run(message,signal) {
  const {op,bytes} = message, key = keyOf(message.key);
  if (op === "open") {
    if (documents.has(key)) throw Error("This datasheet is already open.");
    if (documents.size>=4) throw Error("Close a datasheet before opening another.");
    const pdf = await openDocument(bytes,{signal});
    documents.set(key,pdf);
    return {pages:pdf.numPages,aspect:await pageAspect(pdf,1,signal)};
  }
  const pdf = documents.get(key);
  if (!pdf) throw Error("The datasheet reader has closed.");
  if (op === "close") {
    documents.delete(key);
    await pdf.destroy();
    return {};
  }
  if (op === "visible") {
    const {pages,side} = message;
    if (!Array.isArray(pages) || pages.length>6 || new Set(pages).size!==pages.length)
      throw Error("Choose up to six distinct visible pages.");
    const rendered = [];
    for (const page of pages) rendered.push(await renderPage(pdf,page,{side,signal}));
    return {pages:rendered};
  }
  if (op === "snip") return renderPage(pdf,message.page,{region:message.region,side:message.side,signal});
  if (op === "search") return search(pdf,message,signal);
  const options = {region:message.region,limit:message.limit,signal};
  if (op === "text") return pageText(pdf,message.page,options);
  if (op === "table") return pageTable(pdf,message.page,options);
  throw Error("Unknown datasheet worker operation.");
}

// Shared readers may request the same page. Keep PDF.js page cleanup and raster
// allocations serialized within each document while allowing immediate cancellation.
let work = Promise.resolve();
self.onmessage = ({data}) => {
  const {op,id} = data || {};
  if (!Number.isSafeInteger(id)) return;
  if (op === "cancel") {requests.get(id)?.abort();return;}
  if (requests.has(id)) return;
  const controller = new AbortController();
  requests.set(id,controller);
  work = work.then(async ()=>{
    try {
      if (controller.signal.aborted) return;
      const result = await run(data,controller.signal);
      const transfer = result.png ? [result.png.buffer] :
        Array.isArray(result.pages) ? result.pages.map(page=>page.png.buffer) : [];
      if (!controller.signal.aborted) self.postMessage({id,result},transfer);
    } catch (error) {
      if (!controller.signal.aborted) self.postMessage({id,error:String(error.message||error)});
    } finally {requests.delete(id);}
  });
};
