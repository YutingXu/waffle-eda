"use strict";

// One equal-distance frame sweep for both live history views.
// Playwright serializes sampleHistoryScroll into the page, so it uses page globals only.
// Callers supply the selector and step count. clearPaint removes historyPerf.render
// when that older paint probe is still installed.
async function sampleHistoryScroll({selector, steps, clearPaint}) {
  if (clearPaint && Array.isArray(globalThis.historyPerf?.render)) globalThis.historyPerf.render.length = 0;
  const scroll = document.querySelector(selector), samples = [];
  let last;
  for (let i = 0; i <= steps; i++) {
    const stamp = await new Promise(requestAnimationFrame);
    if (last) samples.push(stamp - last);
    last = stamp;
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * i / steps;
  }
  return samples;
}

// Copy, then sort. The percentile matches an in-place sort, and the caller's sample order stays put.
function historyScrollP95(samples) {
  return +samples.slice().sort((a, b) => a - b)[Math.floor(samples.length * .95)].toFixed(2);
}

module.exports = {sampleHistoryScroll, historyScrollP95};
