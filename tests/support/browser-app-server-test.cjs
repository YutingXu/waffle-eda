"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ownerPath = path.join(__dirname, "browser-app-server.cjs");
const source = fs.readFileSync(ownerPath, "utf8");
const marker = "if (!file.startsWith(app + path.sep))";
function load(text, fsStub) {
  let handler = null;
  let listenArgs = null;
  let closeCount = 0;
  const server = {
    listening: false,
    once() {},
    listen(port, host, callback) {
      listenArgs = [port, host];
      server.listening = true;
      callback();
    },
    address: () => ({port: 43210}),
    close(callback) {
      closeCount += 1;
      server.listening = false;
      if (callback) callback();
    },
  };
  const module = {};
  vm.runInNewContext(text, {
    module,
    require(name) {
      if (name === "node:fs") return fsStub;
      if (name === "node:http") return {createServer(fn) { handler = fn; return server; }};
      if (name === "node:path") return path;
      throw new Error("unexpected require " + name);
    },
    __dirname: "/synthetic/tests/support",
    URL,
  });
  return {
    module,
    server,
    request(url, response) {
      handler({url}, response);
      return response.row;
    },
    stats: () => ({listenArgs, closeCount, handler}),
  };
}

function response() {
  const row = {headers: {}, body: undefined, destroyed: false, status: undefined, statusCode: undefined};
  const res = {
    row,
    setHeader(name, value) { row.headers[name] = value; },
    writeHead(code, headers) {
      row.status = code;
      if (headers) Object.assign(row.headers, headers);
      return res;
    },
    end(value) { row.body = value; },
    destroy() { row.destroyed = true; },
    get destroyed() { return row.destroyed; },
  };
  Object.defineProperty(res, "statusCode", {
    get() { return row.statusCode; },
    set(code) { row.statusCode = code; row.status = code; },
  });
  return res;
}

function streamFs(streams) {
  return {
    createReadStream(name) {
      streams.push(name);
      return {
        on(event, callback) {
          assert.equal(event, "error");
          if (String(name).endsWith("missing.js")) callback();
          return this;
        },
        pipe(res) {
          if (!String(name).endsWith("missing.js")) res.end("synthetic app bytes");
        },
      };
    },
  };
}

async function main() {
  assert.equal(source.split(marker).length - 1, 1);
  const streams = [];
  let unhold;
  const opened = load(source, streamFs(streams));
  const served = await opened.module.exports({
    cacheControl: "no-cache",
    beforeRead(name) {
      if (name === "/held.js") return new Promise(resolve => { unhold = resolve; });
    },
  });
  assert.deepEqual(opened.stats().listenArgs, [0, "127.0.0.1"]);
  assert.equal(served.url, "http://127.0.0.1:43210/index.html");
  const appRoot = path.resolve("/synthetic", "app");
  const outside = ["./", "./../sibling.js", "./../app-extra/file.js"].map(rel => path.resolve(appRoot, rel));
  for (const file of outside) assert.equal(file.startsWith(appRoot + path.sep), false, file);
  const beforeRoot = streams.length;
  assert.equal(opened.request("/", response()).status, 404, "Root boundary must reject before app-directory access");
  assert.equal(streams.length, beforeRoot);
  assert.deepEqual(opened.request("/bundle.js", response()), {
    headers: {"Cache-Control": "no-cache", "Content-Type": "text/javascript"},
    body: "synthetic app bytes",
    destroyed: false,
    status: undefined,
    statusCode: undefined,
  });
  assert.equal(opened.request("/theme.css", response()).headers["Content-Type"], "text/css");
  assert.equal(opened.request("/note.json", response()).headers["Content-Type"], "application/json");
  assert.equal(opened.request("/page.html", response()).headers["Content-Type"], "text/html");
  assert.equal(opened.request("/picture.bin", response()).headers["Content-Type"], "application/octet-stream");
  assert.equal(opened.request("/missing.js", response()).status, 404);
  const heldResponse = response();
  const held = opened.request("/held.js", heldResponse);
  assert.equal(held.body, undefined);
  assert.equal(streams.includes(path.join(appRoot, "held.js")), false);
  unhold();
  await Promise.resolve();
  assert.equal(held.body, "synthetic app bytes");
  assert.deepEqual(streams.filter(name => ["bundle.js", "missing.js", "held.js"].some(file => name.endsWith(path.sep + file))),
    ["bundle.js", "missing.js", "held.js"].map(file => path.join(appRoot, file)));
  await served.close();
  assert.equal(opened.stats().closeCount, 1);
  assert.equal(opened.server.listening, false);

  const quietStreams = [];
  const quiet = load(source, streamFs(quietStreams));
  const plain = await quiet.module.exports();
  const plainRow = quiet.request("/bundle.js", response());
  assert.equal(plainRow.headers["Cache-Control"], undefined);
  assert.equal(plainRow.headers["Content-Type"], "text/javascript");
  await plain.close();

  const rejectedStreams = [];
  const rejected = load(source, streamFs(rejectedStreams));
  await rejected.module.exports({beforeRead: () => Promise.reject(new Error("stop"))});
  const destroyed = rejected.request("/held.js", response());
  await Promise.resolve();
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.body, undefined);
  assert.equal(rejectedStreams.length, 0);

  const idle = load(source, streamFs([]));
  const raw = idle.module.exports.createStaticServer();
  assert.equal(idle.stats().listenArgs, null);
  assert.equal(typeof raw.close, "function");

  const elsewhere = [];
  const mounted = load(source, streamFs(elsewhere));
  mounted.module.exports.createStaticServer({root: "/synthetic/elsewhere"});
  assert.equal(mounted.request("/bundle.js", response()).body, "synthetic app bytes");
  assert.equal(elsewhere[0], path.resolve("/synthetic/elsewhere", "bundle.js"));
  const beforeElsewhere = elsewhere.length;
  assert.equal(mounted.request("/", response()).status, 404);
  assert.equal(elsewhere.length, beforeElsewhere);

  const checkoutStreams = [];
  const checkout = load(source, streamFs(checkoutStreams));
  checkout.module.exports.createStaticServer({
    base: "/synthetic/checkout",
    roots: ["/synthetic/checkout/app", "/synthetic/checkout/extensions"],
  });
  assert.equal(checkout.request("/app/bundle.js", response()).body, "synthetic app bytes");
  assert.equal(checkout.request("/extensions/plug.js", response()).body, "synthetic app bytes");
  for (const url of ["/", "/sibling.js", "/app-extra/file.js", "/secret.js"]) {
    const before = checkoutStreams.length;
    assert.equal(checkout.request(url, response()).status, 404, url);
    assert.equal(checkoutStreams.length, before, url);
  }
  assert.deepEqual(checkoutStreams, [
    path.resolve("/synthetic/checkout/app", "bundle.js"),
    path.resolve("/synthetic/checkout/extensions", "plug.js"),
  ]);

  const decodedStreams = [];
  const decoded = load(source, streamFs(decodedStreams));
  decoded.module.exports.createStaticServer({root: "/synthetic/app", decode: true});
  assert.equal(decoded.request("/%2e%2e%2fsibling.js", response()).status, 404);
  assert.equal(decodedStreams.length, 0);
  assert.equal(decoded.request("/ok.js", response()).body, "synthetic app bytes");

  const statCalls = [];
  const filed = load(source, {
    statSync(name) {
      statCalls.push(name);
      if (String(name).endsWith("dir")) return {isFile: () => false};
      if (String(name).endsWith("missing.js")) return undefined;
      return {isFile: () => true};
    },
    createReadStream(name) {
      return {on() { return this; }, pipe(res) { res.end("file bytes"); }};
    },
  });
  filed.module.exports.createStaticServer({root: "/synthetic/app", requireFile: true});
  assert.equal(filed.request("/dir", response()).status, 404);
  assert.equal(filed.request("/missing.js", response()).status, 404);
  assert.equal(filed.request("/yes.js", response()).body, "file bytes");
  assert.equal(statCalls.length, 3);

  const reads = [];
  const buffered = load(source, {
    promises: {
      readFile(name) {
        reads.push(name);
        if (String(name).endsWith("missing.js")) return Promise.reject(new Error("ENOENT"));
        return Promise.resolve(Buffer.from("buffered bytes"));
      },
    },
  });
  buffered.module.exports.createStaticServer({
    root: "/synthetic/app",
    body: "buffer",
    missing: "end",
    mime: {".js": "application/javascript"},
  });
  const hit = buffered.request("/view.js", response());
  const miss = buffered.request("/missing.js", response());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(hit.status, 200);
  assert.equal(hit.headers["Content-Type"], "application/javascript");
  assert.equal(Buffer.from(hit.body).toString(), "buffered bytes");
  assert.equal(miss.status, undefined);
  assert.equal(reads.length, 2);

  const ended = load(source, streamFs([]));
  ended.module.exports.createStaticServer({
    root: "/synthetic/app",
    missing: "status",
    mime: file => file.endsWith(".js") ? "text/javascript" : "application/octet-stream",
  });
  const previewMiss = ended.request("/missing.js", response());
  assert.equal(previewMiss.status, 404);
  assert.equal(previewMiss.statusCode, 404);

  const mutated = source.replace(marker, "if (false)");
  assert.notEqual(mutated, source);
  const mutantStreams = [];
  const mutant = load(mutated, streamFs(mutantStreams));
  await mutant.module.exports({cacheControl: "no-cache"});
  let boundaryError = null;
  try {
    assert.equal(mutant.request("/", response()).status, 404, "Root boundary must reject before app-directory access");
  } catch (error) {
    boundaryError = error;
  }
  assert.ok(boundaryError);
  assert.match(String(boundaryError), /Root boundary must reject before app-directory access/);
  assert.equal(boundaryError.actual, undefined);
  assert.equal(boundaryError.expected, 404);
  assert.deepEqual(mutantStreams, [outside[0]]);
  for (const file of outside.slice(1)) assert.equal(file.startsWith(appRoot + path.sep), false, file);
  assert.equal(mutant.request("/bundle.js", response()).body, "synthetic app bytes");
  assert.equal(fs.readFileSync(ownerPath, "utf8"), source);

  const server = require("../history/browser-project-history.js").appServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const page = await fetch("http://127.0.0.1:" + server.address().port + "/app/index.html");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html");
    assert.equal(await page.text(), fs.readFileSync(path.join(__dirname, "../../app/index.html"), "utf8"));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("Actual fixture handler checked through in-memory loopback, stream and close adapters");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
