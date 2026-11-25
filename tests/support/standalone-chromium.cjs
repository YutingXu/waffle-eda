"use strict";

// One launch, run, and close for a standalone injected-browser main.
// The caller keeps argv, env, and default launch precedence, browser flags,
// the suite call, and CLI reporting.
function standaloneChromium(launch, run, report) {
  const {chromium} = require("playwright-core");
  return (async () => {
    const browser = await chromium.launch(typeof launch === "function" ? launch() : launch);
    try {
      return await run(browser);
    } finally {
      await browser.close();
    }
  })().catch(report);
}

module.exports = standaloneChromium;
