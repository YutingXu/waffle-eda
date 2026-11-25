"use strict";
importScripts("../core/base64.js", "../core/sha256.js", "../project/source-file.js", "../core/uuid-v7.js", "../pcb/pour-marker.js", "../formats/format-2-codec.js", "../formats/format-2-upgrades.js", "../formats/format-2-units.js", "../formats/format-2-values.js", "../project/link-record.js", "../formats/format-2-model.js", "../project/folder-project-engine.js");
const session = globalThis.AtriumFolderProjectEngine.create();
const reads = new Map();
let nextRead = 0;
self.onmessage = async ({data: message}) => {
  const {requestId} = message;
  if (message.readId !== undefined) {
    const read = reads.get(message.readId);
    if (!read) return;
    reads.delete(message.readId);
    if (message.error) read.reject(Error(message.error)); else read.resolve(message.record);
    return;
  }
  try {
    const requestRead = fields => {
      const readId = ++nextRead;
      return new Promise((resolve,reject) => {
        reads.set(readId,{resolve,reject});
        self.postMessage({requestId,readId,...fields});
      });
    };
    const value = await session.run({...message,
      read:(path,ref) => requestRead({path,ref}),
      readBatch:message.batch ? (paths,refs) => requestRead({paths,...(message.proveModels && {refs})}) : undefined
    });
    if (["owner", "resolveExternal"].includes(message.op) && value.owner?.items?.length > 256) {
      const {items, ...header} = value.owner;
      for (let offset = 0; offset < items.length; offset += 256)
        self.postMessage({requestId,chunk:items.slice(offset,offset+256)});
      self.postMessage({requestId,ok:true,result:{...value,owner:header}});
    } else if (message.op === "draftConversionMembers") {
      const members = value.members.map(({path,bytes}) => ({path,bytes}));
      self.postMessage({requestId,ok:true,result:{members}}, [...new Set(members.map(row => row.bytes.buffer))]);
    } else if (value?.bytes instanceof Uint8Array) {
      self.postMessage({requestId,ok:true,result:value},[value.bytes.buffer]);
    } else self.postMessage({requestId,ok:true,result:value});
  } catch (e) {
    self.postMessage({requestId,ok:false,error:e?.message || String(e)});
  }
};
