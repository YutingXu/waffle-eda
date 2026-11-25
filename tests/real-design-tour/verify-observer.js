"use strict";
// An isolated native-harness self-check. Never load this script during a design tour.
globalThis.__uiProbes = {async run() {
  const native = (op, fields = {}) => webkit.messageHandlers.harness.postMessage({op, ...fields});
  const source = 'console.warn("Worker observer warning"); console.error("Worker observer error"); ' +
    'postMessage({strict: (function () { return this === undefined; })()});';
  const replies = [];
  console.warn("Page observer warning"); console.error("Page observer error");
  for (const directive of ['', '/* header */\n"use strict";\n']) {
    const url = URL.createObjectURL(new Blob([directive + source], {type: "text/javascript"}));
    const worker = new Worker(url);
    try {
      replies.push(await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("worker probe timed out")), 5000);
        worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
        worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
      }));
    } finally { worker.terminate(); URL.revokeObjectURL(url); }
  }
  const trace = tourTrace.finish(false), webKit = await native("consoleEvents");
  const events = trace.events, count = (type, text) => events.filter(row => row.type === type && row.text === text).length;
  const passed = replies[0].strict === false && replies[1].strict === true &&
    trace.workers.listening === 2 && trace.workers.withoutConsole === 0 &&
    count("console.warn", "Page observer warning") === 1 && count("console.error", "Page observer error") === 1 &&
    count("worker-console.warn", "Worker observer warning") === 2 && count("worker-console.error", "Worker observer error") === 2 &&
    (!webKit.available || ['Page observer warning', 'Page observer error'].every(message => webKit.entries.some(row => row.text === message)));
  await native("log", {ok: passed, name: "Observer retains page and worker warnings/errors, original strictness and worker replies"});
  return {passed, nativePageConsole: webKit.available, workers: trace.workers.listening};
}};
