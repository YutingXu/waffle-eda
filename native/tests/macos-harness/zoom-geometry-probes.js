"use strict";

globalThis.__uiProbes = {run: async (_only, input) => {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  try {
    await post("window", {act: "unhide"});
    await post("window", {act: "restore"});
    globalThis.AtriumPower?.host?.({occluded: false});
    if (devicePixelRatio !== 2 && !await post("ink-raster-scale", {scale: 2})) throw new Error("The web view could not render at 2×.");
    const result = await atriumZoomGeometry({
      ...input,
      async screen({x, y, width, height}) {
        const result = await post("snapshot-png", {x, y, w: width, h: height});
        if (!result.png) throw new Error("WebKit did not return a canvas snapshot.");
        return result;
      },
      async evidence(name, actual, reference) {
        for (const [kind, data] of [["actual", actual], ["reference", reference]])
          await post("save", {name: name + "-" + kind + ".png.b64", text: data.split(",", 2)[1]});
      }
    });
    await post("save", {name: "webkit.json", text: JSON.stringify(result, null, 2)});
    return "ZOOMGEOMETRY " + JSON.stringify({dpr: result.dpr, device: result.device, failures: result.failures.slice(0, 20), count: result.failures.length});
  } catch (e) { return "JSERROR " + e.message + " " + e.stack; }
}};
