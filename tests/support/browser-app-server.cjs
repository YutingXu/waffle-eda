"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const app = path.resolve(__dirname, "../../app");
const types = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json"};

// One loopback fixture handler. Callers pass mount, MIME, cache, and read options.
// beforeRead(pathname) can hold a real response; a rejected hold destroys it.
function createStaticServer({root, roots, base, mime, cacheControl, beforeRead, decode, requireFile, body, missing} = {}) {
  const custom = root != null || roots != null || base != null;
  const mount = custom ? path.resolve(base || root || app) : app;
  const allow = (roots || [root || app]).map(dir => path.resolve(dir));
  const readFile = body === "buffer";
  const absent = missing || "writeHead";
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const named = decode ? decodeURIComponent(pathname) : pathname;
    const file = path.resolve(mount, "." + named);
    if (custom) {
      if (!allow.some(dir => file.startsWith(dir + path.sep))) { res.writeHead(404).end(); return; }
    } else if (!file.startsWith(app + path.sep)) { res.writeHead(404).end(); return; }
    const send = () => {
      if (res.destroyed) return;
      if (requireFile && !fs.statSync(file, {throwIfNoEntry: false})?.isFile()) { res.writeHead(404).end(); return; }
      const type = typeof mime === "function" ? mime(file) : (mime || types)[path.extname(file)] || "application/octet-stream";
      const fail = () => {
        if (res.destroyed) return;
        if (absent === "end") res.end();
        else if (absent === "status") { res.statusCode = 404; res.end(); }
        else res.writeHead(404).end();
      };
      if (readFile) {
        fs.promises.readFile(file).then(data => {
          if (res.destroyed) return;
          const headers = {"Content-Type": type};
          if (cacheControl) headers["Cache-Control"] = cacheControl;
          res.writeHead(200, headers).end(data);
        }, fail);
        return;
      }
      res.setHeader("Content-Type", type);
      if (cacheControl) res.setHeader("Cache-Control", cacheControl);
      fs.createReadStream(file).on("error", () => {
        if (absent === "writeHead") res.writeHead(404).end();
        else fail();
      }).pipe(res);
    };
    const held = beforeRead?.(named);
    if (held) held.then(send, () => res.destroy());
    else send();
  });
}

async function serveApp(options = {}) {
  const server = createStaticServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const index = options.index === undefined ? "/index.html" : options.index;
  return {url: `http://127.0.0.1:${server.address().port}${index}`,
    close: () => new Promise(resolve => server.close(resolve))};
}

module.exports = serveApp;
module.exports.createStaticServer = createStaticServer;
