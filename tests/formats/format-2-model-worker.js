"use strict";

// Browser and native WebView QA call this with the normal format worker. Fixtures are synthetic.
globalThis.verifyFormat2ModelWorker = async function verifyFormat2ModelWorker(worker) {
  const hex = bytes => Array.from(bytes, v => v.toString(16).padStart(2, "0")).join("");
  const hash = async bytes => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  let id = 0;
  const ask = (op, bytes, options) => new Promise((resolve, reject) => {
    const next = ++id;
    function reply({data}) {
      if (data?.id !== next) return;
      worker.removeEventListener("message", reply);
      if (data.ok) resolve(data.result.bytes);
      else reject(Error(data.error));
    }
    worker.addEventListener("message", reply);
    worker.postMessage({id: next, op, bytes, options});
  });
  const step = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
  const example = "1f8b08000000000002fff30cf6d73534303630d63532b4e6f2707574710db2e672f573097675b6e672710c7144f080b4ae278a7a00ff45e3cd3e000000";
  const mixed = new Uint8Array(65537);
  let seed = 0x27892ae3;
  for (let i = 0; i < mixed.length; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    if (i % 2048 < 512) mixed[i] = seed >>> 24;
  }
  for (const raw of [step, mixed]) {
    const gzip = await ask("encodeModel", raw), sha256 = await hash(raw), ref = {sha256, byteLength: raw.length};
    const matches = raw === step ? hex(gzip) === example : await hash(gzip) === "498db70c1fadfb4cdba050f36a55c793a26c6f6d5dfccea2a5e1cfefd47ebdcf";
    if (!matches) throw Error("The worker did not return the stock gzip bytes.");
    const result = await ask("decodeModel", gzip, ref);
    const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip"));
    const independentlyDecoded = await new Response(stream).arrayBuffer();
    if (result.length !== raw.length || await hash(result) !== sha256 || await hash(independentlyDecoded) !== sha256)
      throw Error("Model readback differs from the original bytes.");
    let rejected = false;
    try { await ask("decodeModel", gzip, {...ref, sha256: "0".repeat(64)}); }
    catch (error) { rejected = /SHA-256/.test(error.message); }
    if (!rejected) throw Error("The worker accepted a model under the wrong digest.");
  }
};
