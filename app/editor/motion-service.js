"use strict";

(() => {
  const G = globalThis, B = G.AtriumButter;
  const handlers = {
    policy: args => G.AtriumMotion.describePolicy(args),
    plan: args => G.AtriumMotion.plan(args),
    sample: args => G.AtriumMotion.sample(args),
    retarget: args => G.AtriumMotion.retarget(args),
  };
  B.register("motion", handlers);
  // Optional diagnostic packages use the same read handlers and schemas as Butter commands.
  function inspect(action, args) {
    if (action === "active") {
      B.validateArguments({type:"object", properties:{}, additionalProperties:false}, args);
      return {count:G.AtriumMotion.active()};
    }
    const spec = G.AtriumButterCatalog?.motion?.commands.find(c=>c.id===action && c.kind==="read");
    if (!spec || !Object.hasOwn(handlers,action)) throw Error("Unknown motion diagnostic.");
    B.check(spec, args, "extension", "read", false);
    return handlers[action](args);
  }
  G.AtriumMotionDiagnostics = Object.freeze({inspect});
})();
