"use strict";

// Native records and page addressing require neither a cache nor the parser.
globalThis.AtriumDatasheetRecord = (() => {
  const hash = /^[0-9a-f]{64}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
  const number = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  const string = (s, max) => typeof s === "string" && !!s.trim() && [...s].length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s);
  const pageNumber = n => number(n, 1, 100000);
  const point = p => Array.isArray(p) && p.length === 2 && p.every(n => number(n, 0, 1000000));
  const region = r => Array.isArray(r) && r.length === 4 && r.every(n => number(n, 0, 1000000)) &&
    r[0] < r[2] && r[1] < r[3];
  function ipv4(host) {
    const parts = host.split(".");
    if (parts.length!==4 || parts.some(part=>!/^(0|[1-9][0-9]{0,2})$/.test(part) || +part>255)) return null;
    return parts.map(Number);
  }
  function ipv6(host) {
    // Normalize groups and compress the first longest zero run, as URL does.
    let body = host.slice(1,-1);
    if (body.includes(".")) {
      const at = body.lastIndexOf(":"), tail = ipv4(body.slice(at+1));
      if (at<0 || !tail) return null;
      body = body.slice(0,at+1) + [256*tail[0]+tail[1],256*tail[2]+tail[3]].map(n=>n.toString(16)).join(":");
    }
    const halves = body.split("::");
    if (halves.length>2) return null;
    const [left,right=[]] = halves.map(part=>part ? part.split(":") : []);
    const missing = 8-left.length-right.length;
    if (halves.length===1 ? missing!==0 : missing<1) return null;
    if (![...left,...right].every(part=>/^[a-f0-9]{1,4}$/i.test(part))) return null;
    const groups = [...left,...Array(missing).fill("0"),...right].map(part=>Number.parseInt(part,16).toString(16));
    let best=0, count=1;
    for (let at=0;at<groups.length;) {
      if (groups[at]!=="0") {at++;continue;}
      let end=at+1;
      while (groups[end]==="0") end++;
      if (end-at>count) {best=at;count=end-at;}
      at=end;
    }
    return count>1 ? "["+groups.slice(0,best).join(":")+"::"+groups.slice(best+count).join(":")+"]" : "["+groups.join(":")+"]";
  }
  function canonicalPath(path) {
    const parts = path.slice(1).split("/"), result = [];
    for (let i=0;i<parts.length;i++) {
      const dots = parts[i].replace(/%2e/gi,".");
      if (dots==="..") result.pop();
      if (dots!=="." && dots!=="..") result.push(parts[i]);
      else if (i===parts.length-1) result.push("");
    }
    return "/"+result.join("/");
  }
  function safeURL(value) {
    // The editor and standalone JavaScriptCore both use the same HTTPS subset.
    // DNS names use their ASCII form, and IP literals are canonicalized here.
    if (!string(value, 2048)) return null;
    const source = value.trim();
    if (/[#\\\u0000-\u0020\u007f]/u.test(source)) return null;
    const match = /^https:\/\/(\[[a-f0-9:.]+\]|[a-z0-9._~-]+)(?::([0-9]{1,5}))?(\/[^?]*)?(\?.*)?$/i.exec(source);
    if (!match) return null;
    let [,host,port,path="/",query=""] = match;
    host=host.toLowerCase();
    if (host.startsWith("[")) host=ipv6(host);
    else {
      const labels = host.replace(/\.$/,"").split(".");
      if (labels.some(label=>!label) || /^([0-9]+|0x[0-9a-f]*)$/.test(labels.at(-1)) && (!ipv4(host) || host.endsWith("."))) return null;
    }
    if (!host || +port>65535) return null;
    const encode = (part,pattern) => part.replace(pattern,char=>char.charCodeAt(0)<=127 ?
      "%"+char.charCodeAt(0).toString(16).toUpperCase() : encodeURIComponent(char));
    try {
      path=encode(canonicalPath(path),/["<>`{}^\u0080-\u{10ffff}]/gu);
      query=encode(query,/["'<>\u0080-\u{10ffff}]/gu);
    } catch {return null;}
    const url = "https://"+host+(port!==undefined && +port!==443 ? ":"+Number(port) : "")+path+query;
    return url.length<=2048 ? url : null;
  }
  function pdfHeader(bytes) {
    const at = bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf ? 3 : 0;
    return bytes[at]===37 && bytes[at+1]===80 && bytes[at+2]===68 && bytes[at+3]===70 && bytes[at+4]===45;
  }
  function validateReference(ref) {
    return keys(ref, ["sha256", "byteLength", "title", "version", "sourceURL", "pageCount", "asset"]) &&
      typeof ref.sha256 === "string" && hash.test(ref.sha256) && number(ref.byteLength, 1, 128 * 1024 ** 2) &&
      string(ref.title, 255) && (ref.version === undefined || string(ref.version, 96)) &&
      (ref.sourceURL === undefined || safeURL(ref.sourceURL) === ref.sourceURL) &&
      (ref.pageCount === undefined || pageNumber(ref.pageCount)) &&
      (ref.asset === undefined || keys(ref.asset, ["sha256", "byteLength", "mediaType"]) &&
        ref.asset.sha256 === ref.sha256 && ref.asset.byteLength === ref.byteLength && ref.asset.mediaType === "application/pdf");
  }
  function validateAnnotation(row) {
    if (!keys(row, ["datasheetId", "page", "region", "type", "text", "points"]) ||
        typeof row.datasheetId !== "string" || !uuid.test(row.datasheetId) ||
        !pageNumber(row.page) || !region(row.region)) return false;
    if (row.type === "note") return row.points === undefined && string(row.text, 8192);
    if (row.type === "ink") return row.text === undefined && Array.isArray(row.points) &&
      number(row.points.length, 2, 4096) && row.points.every(point);
    return row.type === "highlight" && row.points === undefined && row.text === undefined;
  }
  function resolveFragment(project, base, {page}) {
    const ref = project?.datasheets?.find(row => row.id === base.objectId);
    if (!ref || !pageNumber(page) || ref.pageCount !== undefined && page > ref.pageCount) return null;
    return {datasheetId:ref.id, page, pageCount:ref.pageCount ?? null, verification:ref.pageCount === undefined ? "unopened" : "known"};
  }
  return Object.freeze({validateReference, validateAnnotation, resolveFragment, safeURL, pageNumber, pdfHeader});
})();
